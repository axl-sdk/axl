import type { AxlRuntime } from '@axlsdk/axl';
import type { EvalResult, EvalItem, EvalSummary } from './types.js';
import type { Scorer, ScorerContext } from './scorer.js';
import { normalizeScorerResult } from './scorer.js';
import { computeStats, round } from './utils.js';
import { randomUUID } from 'node:crypto';

export type RescoreOptions = {
  concurrency?: number;
};

/**
 * Re-run scorers on the saved outputs of an existing eval result.
 * Preserves original input/output/annotations. Only re-runs scoring.
 */
export async function rescore(
  result: EvalResult,
  scorers: Scorer[],
  runtime: AxlRuntime,
  options?: RescoreOptions,
): Promise<EvalResult> {
  const startTime = Date.now();
  const concurrency = options?.concurrency ?? 5;

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

  const rescored: EvalItem[] = new Array(result.items.length);
  let totalCost = 0;

  async function rescoreItem(original: EvalItem, itemIndex: number): Promise<void> {
    // Pass through error items without scoring
    if (original.error) {
      rescored[itemIndex] = {
        input: original.input,
        annotations: original.annotations,
        output: original.output,
        error: original.error,
        scores: {},
      };
      return;
    }

    const item: EvalItem = {
      input: original.input,
      annotations: original.annotations,
      output: original.output,
      scores: {},
      scoreDetails: {},
    };

    let itemScorerCost = 0;

    for (const scorer of scorers) {
      const scorerStart = Date.now();
      try {
        const raw = await scorer.score(item.output, item.input, item.annotations, scorerContext);
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
          if (!item.scorerErrors) item.scorerErrors = [];
          item.scorerErrors.push(
            `Scorer "${scorer.name}" returned out-of-range score ${scorerResult.score} for input ${JSON.stringify(item.input)}`,
          );
          item.scores[scorer.name] = null;
          item.scoreDetails![scorer.name] = {
            score: null,
            metadata: scorerResult.metadata,
            duration: scorerDuration,
            cost: scorerResult.cost,
          };
        } else {
          item.scores[scorer.name] = round(scorerResult.score);
          item.scoreDetails![scorer.name] = {
            score: round(scorerResult.score),
            metadata: scorerResult.metadata,
            duration: scorerDuration,
            cost: scorerResult.cost,
          };
        }
      } catch (err) {
        const errCost = typeof (err as any)?.cost === 'number' ? (err as any).cost : undefined;
        if (errCost != null) {
          itemScorerCost += errCost;
          totalCost += errCost;
        }
        if (!item.scorerErrors) item.scorerErrors = [];
        item.scorerErrors.push(
          `Scorer "${scorer.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        item.scores[scorer.name] = null;
        item.scoreDetails![scorer.name] = {
          score: null,
          duration: Date.now() - scorerStart,
          cost: errCost,
        };
      }
    }
    item.scorerCost = itemScorerCost > 0 ? itemScorerCost : undefined;
    rescored[itemIndex] = item;
  }

  let index = 0;
  async function runNext(): Promise<void> {
    while (index < result.items.length) {
      const currentIndex = index++;
      await rescoreItem(result.items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, result.items.length) }, () =>
    runNext(),
  );
  await Promise.all(workers);

  const failures = rescored.filter((i) => i.error).length;
  const scorerNames = scorers.map((s) => s.name);
  const scorerStats: EvalSummary['scorers'] = {};
  for (const name of scorerNames) {
    const scores = rescored
      .filter((i) => !i.error && i.scores[name] != null)
      .map((i) => i.scores[name] as number);
    scorerStats[name] = computeStats(scores);
  }

  const scorerTypes: Record<string, string> = {};
  for (const s of scorers) {
    scorerTypes[s.name] = s.isLlm ? 'llm' : 'deterministic';
  }

  return {
    id: randomUUID(),
    workflow: result.workflow,
    dataset: result.dataset,
    metadata: {
      ...result.metadata,
      rescored: true,
      originalId: result.id,
      scorerTypes,
    },
    timestamp: new Date().toISOString(),
    totalCost,
    duration: Date.now() - startTime,
    items: rescored,
    summary: { count: result.items.length, failures, scorers: scorerStats },
  };
}
