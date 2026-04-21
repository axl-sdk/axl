import type { CostData } from './types.js';
import type { ConnectionManager } from './ws/connection-manager.js';

/** Empty retry bucket snapshot. */
function emptyRetry(): CostData['retry'] {
  return {
    primary: 0,
    primaryCalls: 0,
    schema: 0,
    schemaCalls: 0,
    validate: 0,
    validateCalls: 0,
    guardrail: 0,
    guardrailCalls: 0,
    retryCalls: 0,
  };
}

/**
 * Accumulates cost data from trace events.
 * Broadcasts updates to the 'costs' WS channel.
 */
export class CostAggregator {
  private data: CostData = {
    totalCost: 0,
    totalTokens: { input: 0, output: 0, reasoning: 0 },
    byAgent: {},
    byModel: {},
    byWorkflow: {},
    retry: emptyRetry(),
    byEmbedder: {},
  };

  constructor(private connMgr: ConnectionManager) {}

  /** Process a trace event and update cost data. */
  onTrace(event: {
    type?: string;
    agent?: string;
    model?: string;
    workflow?: string;
    cost?: number;
    tokens?: { input?: number; output?: number; reasoning?: number };
    data?: unknown;
  }): void {
    // Workflow execution bookkeeping: `workflow_start` events carry no
    // cost and no tokens, but they're what increments the per-workflow
    // `executions` counter. The early-return below would otherwise drop
    // them on the floor, which was why the Cost Dashboard's "Cost by
    // Workflow" section displayed executions: 0 for every workflow in
    // production. Handle it first, then continue to the cost-bearing path.
    if (event.type === 'workflow_start' && event.workflow) {
      const entry = this.data.byWorkflow[event.workflow] ?? { cost: 0, executions: 0 };
      entry.executions += 1;
      this.data.byWorkflow[event.workflow] = entry;
      this.connMgr.broadcast('costs', this.data);
      return;
    }

    if (event.cost == null && !event.tokens) return;

    const cost = Number.isFinite(event.cost) ? event.cost! : 0;
    const tokens = event.tokens ?? {};

    this.data.totalCost += cost;
    // totalTokens represents agent prompt/completion/reasoning tokens —
    // NOT embedder tokens. Memory log events mirror `usage.tokens` to
    // `tokens.input` so they pass the early-return gate above, but we
    // don't want them conflated with agent tokens in the UI summary.
    // Embedder tokens are bucketed separately into `byEmbedder.tokens`
    // further below.
    if (event.type === 'agent_call_end') {
      this.data.totalTokens.input += tokens.input ?? 0;
      this.data.totalTokens.output += tokens.output ?? 0;
      this.data.totalTokens.reasoning += tokens.reasoning ?? 0;
    }

    if (event.agent) {
      const entry = this.data.byAgent[event.agent] ?? { cost: 0, calls: 0 };
      entry.cost += cost;
      entry.calls += 1;
      this.data.byAgent[event.agent] = entry;
    }

    if (event.model) {
      const entry = this.data.byModel[event.model] ?? {
        cost: 0,
        calls: 0,
        tokens: { input: 0, output: 0 },
      };
      entry.cost += cost;
      entry.calls += 1;
      entry.tokens.input += tokens.input ?? 0;
      entry.tokens.output += tokens.output ?? 0;
      this.data.byModel[event.model] = entry;
    }

    if (event.workflow) {
      // `executions` is incremented in the early workflow_start branch
      // above; here we only accumulate cost from agent_call / memory /
      // tool events that were emitted inside the workflow (all of which
      // now carry `event.workflow` via `emitTrace`'s auto-stamp).
      const entry = this.data.byWorkflow[event.workflow] ?? { cost: 0, executions: 0 };
      entry.cost += cost;
      this.data.byWorkflow[event.workflow] = entry;
    }

    // Retry-cost decomposition: split agent_call cost by whether it's a
    // primary (first-attempt) call or a retry triggered by a gate failure.
    // `retryReason` lives on `data.retryReason` and is set by context.ts
    // when the call was triggered by a failed gate on the previous turn.
    if (event.type === 'agent_call_end') {
      const d = (event.data ?? {}) as { retryReason?: 'schema' | 'validate' | 'guardrail' };
      const reason = d.retryReason;
      if (reason === 'schema') {
        this.data.retry.schema += cost;
        this.data.retry.schemaCalls += 1;
        this.data.retry.retryCalls += 1;
      } else if (reason === 'validate') {
        this.data.retry.validate += cost;
        this.data.retry.validateCalls += 1;
        this.data.retry.retryCalls += 1;
      } else if (reason === 'guardrail') {
        this.data.retry.guardrail += cost;
        this.data.retry.guardrailCalls += 1;
        this.data.retry.retryCalls += 1;
      } else {
        this.data.retry.primary += cost;
        this.data.retry.primaryCalls += 1;
      }
    }

    // Embedder cost decomposition: `ctx.remember({embed:true})` and
    // semantic `ctx.recall({query})` emit `memory_remember` /
    // `memory_recall` variants with top-level `cost` and `data.usage`.
    // Bucket them by embedder model so the UI can render a breakdown
    // that mirrors byModel for agent calls.
    if (event.type === 'memory_remember' || event.type === 'memory_recall') {
      const d = (event.data ?? {}) as { usage?: { model?: string; tokens?: number } };
      const modelKey = d.usage?.model ?? 'unknown';
      const embedTokens = typeof d.usage?.tokens === 'number' ? d.usage.tokens : 0;
      const entry = this.data.byEmbedder[modelKey] ?? { cost: 0, calls: 0, tokens: 0 };
      entry.cost += cost;
      entry.calls += 1;
      entry.tokens += embedTokens;
      this.data.byEmbedder[modelKey] = entry;
    }

    // Broadcast to WS subscribers
    this.connMgr.broadcast('costs', this.data);
  }

  /** Get current aggregated cost data. */
  getData(): CostData {
    return this.data;
  }

  /** Reset all accumulated data. */
  reset(): void {
    this.data = {
      totalCost: 0,
      totalTokens: { input: 0, output: 0, reasoning: 0 },
      byAgent: {},
      byModel: {},
      byWorkflow: {},
      retry: emptyRetry(),
      byEmbedder: {},
    };
  }
}
