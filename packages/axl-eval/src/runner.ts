import type { AxlRuntime } from '@axlsdk/axl';
import type { EvalConfig, EvalResult, EvalItem, EvalSummary } from './types.js';
import type { ScorerContext } from './scorer.js';
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

  const evalItems: EvalItem[] = [];
  let totalCost = 0;
  let budgetExceeded = false;

  async function processItem(item: (typeof items)[0]): Promise<void> {
    if (budgetExceeded) {
      evalItems.push({
        input: item.input,
        annotations: item.annotations,
        output: null,
        error: 'Budget exceeded',
        scores: {},
      });
      return;
    }

    const evalItem: EvalItem = {
      input: item.input,
      annotations: item.annotations,
      output: null,
      scores: {},
    };
    try {
      const result = await executeWorkflow(item.input, runtime);
      evalItem.output = result.output;
      if (result.cost != null) {
        totalCost += result.cost;
      }
    } catch (err) {
      evalItem.error = err instanceof Error ? err.message : String(err);
      evalItems.push(evalItem);
      return;
    }

    if (budgetLimit != null && totalCost > budgetLimit) {
      budgetExceeded = true;
    }

    for (const scorer of config.scorers) {
      try {
        const score = await scorer.score(
          evalItem.output,
          item.input,
          item.annotations,
          scorerContext,
        );
        // Accumulate LLM scorer cost if available
        if (scorer.isLlm) {
          const lastCost = (scorer as unknown as { _lastCost?: number })._lastCost;
          if (lastCost != null) {
            totalCost += lastCost;
          }
        }
        if (!Number.isFinite(score) || score < 0 || score > 1) {
          if (!evalItem.scorerErrors) evalItem.scorerErrors = [];
          evalItem.scorerErrors.push(
            `Scorer "${scorer.name}" returned out-of-range score ${score} for input ${JSON.stringify(item.input)}`,
          );
          evalItem.scores[scorer.name] = null;
        } else {
          evalItem.scores[scorer.name] = round(score);
        }
      } catch (err) {
        // Accumulate cost even on failure — the LLM call may have succeeded
        // before a downstream error (e.g., invalid JSON, schema validation)
        if (scorer.isLlm) {
          const lastCost = (scorer as unknown as { _lastCost?: number })._lastCost;
          if (lastCost != null) {
            totalCost += lastCost;
          }
        }
        if (!evalItem.scorerErrors) evalItem.scorerErrors = [];
        evalItem.scorerErrors.push(
          `Scorer "${scorer.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        evalItem.scores[scorer.name] = null;
      }
    }
    evalItems.push(evalItem);
  }

  let index = 0;
  async function runNext(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index++;
      await processItem(items[currentIndex]);
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

  return {
    id,
    workflow: config.workflow,
    dataset: config.dataset.name,
    metadata: config.metadata ?? {},
    timestamp: new Date().toISOString(),
    totalCost,
    duration: Date.now() - startTime,
    items: evalItems,
    summary: { count: items.length, failures, scorers: scorerStats },
  };
}
