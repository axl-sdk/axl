import type { CostData } from './types.js';
import type { ConnectionManager } from './ws/connection-manager.js';

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
  }): void {
    if (!event.cost && !event.tokens) return;

    const cost = event.cost ?? 0;
    const tokens = event.tokens ?? {};

    this.data.totalCost += cost;
    this.data.totalTokens.input += tokens.input ?? 0;
    this.data.totalTokens.output += tokens.output ?? 0;
    this.data.totalTokens.reasoning += tokens.reasoning ?? 0;

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
      const entry = this.data.byWorkflow[event.workflow] ?? { cost: 0, executions: 0 };
      entry.cost += cost;
      if (event.type === 'workflow_start') entry.executions += 1;
      this.data.byWorkflow[event.workflow] = entry;
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
    };
  }
}
