import type { AxlRuntime } from '@axlsdk/axl';
import type { EvalConfig, EvalResult, EvalItem, EvalSummary } from './types.js';
import type { ScorerContext } from './scorer.js';
import { normalizeScorerResult } from './scorer.js';
import { randomUUID } from 'node:crypto';

function computeStats(scores: number[]): {
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
} {
  if (scores.length === 0) return { mean: 0, min: 0, max: 0, p50: 0, p95: 0 };
  const sorted = [...scores].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  return { mean: round(mean), min: round(min), max: round(max), p50: round(p50), p95: round(p95) };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

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
  ) => Promise<{ output: unknown; cost?: number }>,
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

  return {
    id,
    workflow: config.workflow,
    dataset: config.dataset.name,
    metadata: config.metadata ?? {},
    timestamp: new Date().toISOString(),
    totalCost,
    duration: Date.now() - startTime,
    items: evalItems,
    summary: { count: items.length, failures, scorers: scorerStats, timing },
  };
}
