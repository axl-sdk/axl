import type { AxlRuntime } from '@axlsdk/axl';
import type { EvalResult, EvalItem, EvalSummary } from './types.js';
import type { Scorer, ScorerContext } from './scorer.js';
import { normalizeScorerResult } from './scorer.js';
import { computeStats, round, mapWithConcurrency } from './utils.js';
import { randomUUID } from 'node:crypto';

export type RescoreOptions = {
  /** Item-level worker-pool size (how many saved items rescore in parallel). Default 5. */
  concurrency?: number;
  /** Per-item scorer fan-out (how many scorers run concurrently within one item).
   *  Default 5 — matches `EvalConfig.scorerConcurrency`. Worst-case concurrent
   *  judge calls is `concurrency × scorerConcurrency`. */
  scorerConcurrency?: number;
  /** Abort signal forwarded into ScorerContext so in-flight LLM scorer calls can
   *  be cancelled mid-flight. Also checked between items to short-circuit
   *  remaining work. Mirrors `RunEvalOptions.signal`. */
  signal?: AbortSignal;
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
  const scorerConcurrency = options?.scorerConcurrency ?? 5;

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
    signal: options?.signal,
  };

  const rescored: EvalItem[] = new Array(result.items.length);
  let totalCost = 0;

  async function rescoreItem(original: EvalItem, itemIndex: number): Promise<void> {
    // Short-circuit if the rescore has been cancelled — matches runEval's
    // between-items signal check (runner.ts) so cancellation behaves the same
    // in both paths. In-flight LLM scorer calls additionally abort via
    // scorerContext.signal → provider.chat({ signal }).
    if (options?.signal?.aborted) {
      rescored[itemIndex] = {
        input: original.input,
        annotations: original.annotations,
        output: original.output,
        error: 'cancelled',
        scores: {},
      };
      return;
    }

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

    // Preserve per-item traces from the original run: rescore re-runs scorers
    // but leaves the workflow untouched, so the original execution traces
    // remain accurate and useful for diagnosing score changes.
    const item: EvalItem = {
      input: original.input,
      annotations: original.annotations,
      output: original.output,
      metadata: original.metadata,
      traces: original.traces,
      scores: {},
      scoreDetails: {},
    };

    // Pre-seed keys in scorer-array order (deterministic JSON order + a
    // deterministic `null` for any scorer skipped on abort). Same as runEval.
    for (const s of scorers) {
      item.scores[s.name] = null;
      item.scoreDetails![s.name] = { score: null };
    }
    let itemScorerCost = 0;
    const scorerErrorsByName: Record<string, string> = {};

    await mapWithConcurrency(scorers, scorerConcurrency, async (scorer) => {
      // rescore's serial loop had no in-loop abort check; add the same per-task
      // guard runEval uses so cancellation short-circuits not-yet-started scorers.
      if (options?.signal?.aborted) return;
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
          scorerErrorsByName[scorer.name] =
            `Scorer "${scorer.name}" returned out-of-range score ${scorerResult.score} for input ${JSON.stringify(item.input)}`;
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
        // Aborted mid-flight → cancellation, not a scoring failure (see runEval).
        if (options?.signal?.aborted || (err as { name?: string })?.name === 'AbortError') {
          return;
        }
        const errCost = typeof (err as any)?.cost === 'number' ? (err as any).cost : undefined;
        if (errCost != null) {
          itemScorerCost += errCost;
          totalCost += errCost;
        }
        scorerErrorsByName[scorer.name] =
          `Scorer "${scorer.name}" threw: ${err instanceof Error ? err.message : String(err)}`;
        item.scores[scorer.name] = null;
        item.scoreDetails![scorer.name] = {
          score: null,
          duration: Date.now() - scorerStart,
          cost: errCost,
        };
      }
    });

    const orderedErrors = scorers
      .map((s) => scorerErrorsByName[s.name])
      .filter((e): e is string => e != null);
    if (orderedErrors.length > 0) item.scorerErrors = orderedErrors;
    item.scorerCost = itemScorerCost > 0 ? itemScorerCost : undefined;
    rescored[itemIndex] = item;
  }

  // rescoreItem writes into the pre-allocated `rescored` closure array (the
  // source of truth) and returns void — the pool's returned array is ignored.
  await mapWithConcurrency(result.items, concurrency, (item, i) => rescoreItem(item, i));

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
    dataset: result.dataset,
    metadata: (() => {
      // Strip run group membership — rescored results are independent evaluations.
      // metadata.workflows is preserved via ...rest so the rescored result keeps
      // the same workflow attribution as the original.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { runGroupId: _, runIndex: __, ...rest } = result.metadata;
      const merged: Record<string, unknown> = {
        ...rest,
        rescored: true,
        originalId: result.id,
        scorerTypes,
      };
      // Backward compatibility: pre-0.14 EvalResult artifacts had `workflow`
      // as a top-level string field with no `metadata.workflows`. Migrate it
      // forward so rescored results from old artifacts retain their workflow
      // attribution under the modern shape.
      if (!Array.isArray(merged.workflows)) {
        const legacyWorkflow = (result as { workflow?: unknown }).workflow;
        if (typeof legacyWorkflow === 'string' && legacyWorkflow) {
          merged.workflows = [legacyWorkflow];
          merged.workflowCounts = { [legacyWorkflow]: result.items.length };
        }
      }
      return merged;
    })(),
    timestamp: new Date().toISOString(),
    totalCost,
    duration: Date.now() - startTime,
    items: rescored,
    summary: { count: result.items.length, failures, scorers: scorerStats },
  };
}
