import type { Scorer, ScorerContext } from './scorer.js';
import { normalizeScorerResult, extractScorerErrorCost } from './scorer.js';
import type { EvalItem } from './types.js';
import { round, mapWithConcurrency } from './utils.js';

/** The subset of an `EvalItem` that `scoreItem` reads and mutates. */
type ScorableItem = Pick<
  EvalItem,
  'input' | 'output' | 'annotations' | 'scores' | 'scoreDetails' | 'scorerErrors' | 'scorerCost'
>;

/**
 * Score one item's `output` with every scorer in `scorers`, running up to
 * `scorerConcurrency` of them at once. Mutates `item.scores`,
 * `item.scoreDetails`, `item.scorerErrors`, and `item.scorerCost` in place, and
 * returns the per-item scorer cost so the caller can fold it into its own
 * running total (`totalCost += await scoreItem(...)`).
 *
 * This is the single source of truth for the scoring inner loop, shared by
 * `runEval` and `rescore` — both previously carried a byte-identical copy, so a
 * determinism or cancellation fix had to be made twice.
 *
 * Determinism (independent of scorer completion order):
 *  - `scores`/`scoreDetails` keys are pre-seeded in `scorers` order, so JSON key
 *    order is stable and a scorer skipped by cancellation is deterministically
 *    `null` rather than absent.
 *  - `scorerErrors` are collected name-keyed and flattened in `scorers` order.
 *
 * Cancellation: a scorer not yet started when `signal` aborts is skipped; an
 * in-flight scorer whose call rejects with an `AbortError` is treated as
 * cancellation (leaves its pre-seeded `null`, records no error) — narrowed to
 * the error identity so a genuine bug in another scorer that happens to throw
 * while a sibling triggered the abort is still reported, not swallowed.
 */
export async function scoreItem(
  item: ScorableItem,
  scorers: readonly Scorer<unknown, unknown, unknown>[],
  scorerConcurrency: number,
  scorerContext: ScorerContext,
  signal?: AbortSignal,
): Promise<number> {
  const scoreDetails = (item.scoreDetails ??= {});
  for (const s of scorers) {
    item.scores[s.name] = null;
    scoreDetails[s.name] = { score: null };
  }

  let itemScorerCost = 0;
  const scorerErrorsByName: Record<string, string> = {};

  await mapWithConcurrency(scorers, scorerConcurrency, async (scorer) => {
    if (signal?.aborted) return;
    const scorerStart = Date.now();
    try {
      const raw = await scorer.score(item.output, item.input, item.annotations, scorerContext);
      const scorerResult = normalizeScorerResult(raw);

      if (scorerResult.cost != null) {
        itemScorerCost += scorerResult.cost;
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
        scoreDetails[scorer.name] = {
          score: null,
          metadata: scorerResult.metadata,
          duration: scorerDuration,
          cost: scorerResult.cost,
        };
      } else {
        item.scores[scorer.name] = round(scorerResult.score);
        scoreDetails[scorer.name] = {
          score: round(scorerResult.score),
          metadata: scorerResult.metadata,
          duration: scorerDuration,
          cost: scorerResult.cost,
        };
      }
    } catch (err) {
      // A cancelled call (AbortError) is not a scoring failure — leave the
      // pre-seeded null and record nothing.
      if ((err as { name?: string })?.name === 'AbortError') return;
      const errCost = extractScorerErrorCost(err);
      if (errCost != null) itemScorerCost += errCost;
      scorerErrorsByName[scorer.name] =
        `Scorer "${scorer.name}" threw: ${err instanceof Error ? err.message : String(err)}`;
      item.scores[scorer.name] = null;
      scoreDetails[scorer.name] = {
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
  return itemScorerCost;
}
