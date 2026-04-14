import type { AxlRuntime } from '@axlsdk/axl';
import type { EvalConfig, EvalResult, EvalItem, EvalSummary } from './types.js';
import type { ScorerContext } from './scorer.js';
import { normalizeScorerResult } from './scorer.js';
import { computeStats, round } from './utils.js';
import { randomUUID } from 'node:crypto';

function parseCost(cost: string): number {
  const match = cost.match(/^\$?([\d.]+)$/);
  if (!match) throw new Error(`Invalid cost format: "${cost}"`);
  return parseFloat(match[1]);
}

export async function runEval(
  config: EvalConfig,
  executeWorkflow: (
    input: unknown,
    runtime: AxlRuntime,
  ) => Promise<{ output: unknown; cost?: number; metadata?: Record<string, unknown> }>,
  runtime: AxlRuntime,
): Promise<EvalResult> {
  const startTime = Date.now();
  const id = randomUUID();
  const items = await config.dataset.getItems();
  const concurrency = config.concurrency ?? 5;
  const budgetLimit = config.budget ? parseCost(config.budget) : undefined;

  // Create a scorer context that LLM scorers use to resolve providers.
  const scorerContext: ScorerContext = {
    resolveProvider: (uri: string) => {
      if (typeof runtime.resolveProvider !== 'function') {
        throw new Error(
          `LLM scorers require a runtime with resolveProvider(). ` +
            `Ensure you are using a real AxlRuntime instance, not a mock.`,
        );
      }
      return runtime.resolveProvider(uri);
    },
  };

  const evalItems: EvalItem[] = new Array(items.length);
  let totalCost = 0;
  let budgetExceeded = false;

  async function processItem(item: (typeof items)[0], itemIndex: number): Promise<void> {
    if (budgetExceeded) {
      evalItems[itemIndex] = {
        input: item.input,
        annotations: item.annotations,
        output: null,
        error: 'Budget exceeded',
        scores: {},
      };
      return;
    }

    const evalItem: EvalItem = {
      input: item.input,
      annotations: item.annotations,
      output: null,
      scores: {},
    };
    const itemStart = Date.now();
    try {
      const result = await executeWorkflow(item.input, runtime);
      evalItem.duration = Date.now() - itemStart;
      evalItem.output = result.output;
      evalItem.cost = result.cost;
      if (result.metadata) evalItem.metadata = result.metadata;
      if (result.cost != null) {
        totalCost += result.cost;
      }
    } catch (err) {
      evalItem.duration = Date.now() - itemStart;
      evalItem.error = err instanceof Error ? err.message : String(err);
      evalItems[itemIndex] = evalItem;
      return;
    }

    if (budgetLimit != null && totalCost > budgetLimit) {
      budgetExceeded = true;
    }

    evalItem.scoreDetails = {};
    let itemScorerCost = 0;

    for (const scorer of config.scorers) {
      const scorerStart = Date.now();
      try {
        const raw = await scorer.score(
          evalItem.output,
          item.input,
          item.annotations,
          scorerContext,
        );
        const scorerResult = normalizeScorerResult(raw);

        if (scorerResult.cost != null) {
          itemScorerCost += scorerResult.cost;
          totalCost += scorerResult.cost;
        }

        const scorerDuration = Date.now() - scorerStart;

        if (
          !Number.isFinite(scorerResult.score) ||
          scorerResult.score < 0 ||
          scorerResult.score > 1
        ) {
          if (!evalItem.scorerErrors) evalItem.scorerErrors = [];
          evalItem.scorerErrors.push(
            `Scorer "${scorer.name}" returned out-of-range score ${scorerResult.score} for input ${JSON.stringify(item.input)}`,
          );
          evalItem.scores[scorer.name] = null;
          evalItem.scoreDetails[scorer.name] = {
            score: null,
            metadata: scorerResult.metadata,
            duration: scorerDuration,
            cost: scorerResult.cost,
          };
        } else {
          evalItem.scores[scorer.name] = round(scorerResult.score);
          evalItem.scoreDetails[scorer.name] = {
            score: round(scorerResult.score),
            metadata: scorerResult.metadata,
            duration: scorerDuration,
            cost: scorerResult.cost,
          };
        }
      } catch (err) {
        // Capture cost from error (LLM scorer attaches it)
        const errCost = typeof (err as any)?.cost === 'number' ? (err as any).cost : undefined;
        if (errCost != null) {
          itemScorerCost += errCost;
          totalCost += errCost;
        }
        if (!evalItem.scorerErrors) evalItem.scorerErrors = [];
        evalItem.scorerErrors.push(
          `Scorer "${scorer.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        evalItem.scores[scorer.name] = null;
        evalItem.scoreDetails[scorer.name] = {
          score: null,
          duration: Date.now() - scorerStart,
          cost: errCost,
        };
      }
    }
    evalItem.scorerCost = itemScorerCost > 0 ? itemScorerCost : undefined;
    evalItems[itemIndex] = evalItem;
  }

  let index = 0;
  async function runNext(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index++;
      await processItem(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runNext());
  await Promise.all(workers);

  const failures = evalItems.filter((i) => i.error).length;
  const scorerNames = config.scorers.map((s) => s.name);
  const scorerStats: EvalSummary['scorers'] = {};
  for (const name of scorerNames) {
    const scores = evalItems
      .filter((i) => !i.error && i.scores[name] != null)
      .map((i) => i.scores[name] as number);
    scorerStats[name] = computeStats(scores);
  }

  const durations = evalItems.filter((i) => !i.error && i.duration != null).map((i) => i.duration!);
  const timing = durations.length > 0 ? computeStats(durations) : undefined;

  const scorerTypes: Record<string, string> = {};
  for (const s of config.scorers) {
    scorerTypes[s.name] = s.isLlm ? 'llm' : 'deterministic';
  }

  // Aggregate per-model LLM call counts across all items
  const totalModelCalls = new Map<string, number>();
  for (const item of evalItems) {
    const itemCounts = item.metadata?.modelCallCounts;
    if (itemCounts && typeof itemCounts === 'object') {
      for (const [m, count] of Object.entries(itemCounts as Record<string, unknown>)) {
        if (typeof count === 'number')
          totalModelCalls.set(m, (totalModelCalls.get(m) ?? 0) + count);
      }
    } else {
      // Fallback: count unique models per item (for executeWorkflow that doesn't provide call counts)
      const itemModels = item.metadata?.models;
      if (Array.isArray(itemModels)) {
        for (const m of itemModels) {
          if (typeof m === 'string') totalModelCalls.set(m, (totalModelCalls.get(m) ?? 0) + 1);
        }
      }
    }
  }

  // models: unique list sorted by total calls (most-called first)
  // modelCounts: total LLM calls per model (e.g., { "openai:gpt-4o": 12, "openai:gpt-4o-mini": 12 })
  const modelsMeta: Record<string, unknown> = {};
  if (totalModelCalls.size > 0) {
    const sorted = [...totalModelCalls.entries()].sort((a, b) => b[1] - a[1]);
    modelsMeta.models = sorted.map(([m]) => m);
    modelsMeta.modelCounts = Object.fromEntries(sorted);
  }

  // Aggregate per-workflow call counts across all items (parallel to models).
  // Workflows come from trackExecution's trace-event collection — callers
  // don't specify workflow names anywhere, they just appear because the
  // runtime emits workflow_start events for every execute() call.
  const totalWorkflowCalls = new Map<string, number>();
  for (const item of evalItems) {
    const itemCounts = item.metadata?.workflowCallCounts;
    if (itemCounts && typeof itemCounts === 'object') {
      for (const [w, count] of Object.entries(itemCounts as Record<string, unknown>)) {
        if (typeof count === 'number')
          totalWorkflowCalls.set(w, (totalWorkflowCalls.get(w) ?? 0) + count);
      }
    } else {
      // Fallback: count unique workflows per item
      const itemWorkflows = item.metadata?.workflows;
      if (Array.isArray(itemWorkflows)) {
        for (const w of itemWorkflows) {
          if (typeof w === 'string')
            totalWorkflowCalls.set(w, (totalWorkflowCalls.get(w) ?? 0) + 1);
        }
      }
    }
  }

  // Fall back to config.workflow when the callback bypassed the runtime's
  // execute() path entirely (e.g. AxlTestRuntime-based tests). This keeps the
  // metadata.workflows array non-empty for the common test-harness case.
  const workflowsMeta: Record<string, unknown> = {};
  if (totalWorkflowCalls.size > 0) {
    const sorted = [...totalWorkflowCalls.entries()].sort((a, b) => b[1] - a[1]);
    workflowsMeta.workflows = sorted.map(([w]) => w);
    workflowsMeta.workflowCounts = Object.fromEntries(sorted);
  } else if (config.workflow) {
    workflowsMeta.workflows = [config.workflow];
    workflowsMeta.workflowCounts = { [config.workflow]: items.length };
  }

  return {
    id,
    dataset: config.dataset.name,
    metadata: {
      ...config.metadata,
      scorerTypes,
      ...modelsMeta,
      ...workflowsMeta,
    },
    timestamp: new Date().toISOString(),
    totalCost,
    duration: Date.now() - startTime,
    items: evalItems,
    summary: { count: items.length, failures, scorers: scorerStats, timing },
  };
}
