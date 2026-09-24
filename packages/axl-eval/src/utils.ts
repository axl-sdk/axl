import type { EvalItemOutcome, ItemErrorRate } from './types.js';

export function computeStats(scores: number[]): {
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

export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** `0.737 → '73.7%'`, `0.05 → '5%'` — one decimal, no trailing zero. */
export function formatPercent(rate: number): string {
  return `${Number((rate * 100).toFixed(1))}%`;
}

/** Default `failOnItemErrorRate`, shared by `runEval` and the compare floor. */
export const DEFAULT_ITEM_ERROR_RATE_LIMIT = 0.05;

/** `true` for a usable error-rate limit: a finite number in `[0, 1]`. */
export function isErrorRateLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * The single item-error-rate rule, shared by `runEval` (produce time) and
 * `evaluateItemErrorRateGate` (compare time), so the two can never disagree.
 *
 * Cancelled and budget-stopped items leave the denominator: those runs are
 * reported by their own gates, and counting them here would fail a run twice
 * for one cause. Fires on strictly `>`, so a limit of `1` never fires, and a
 * run with nothing attempted never fires (and reports a rate of `0`, not NaN).
 */
export function evaluateItemErrorRate(
  items: Readonly<Record<EvalItemOutcome, number>>,
  count: number,
  limit: number,
): ItemErrorRate {
  const failed = items.failed;
  const attempted = count - items.cancelled - items.budget_skipped - items.budget_interrupted;
  const rate = attempted > 0 ? failed / attempted : 0;
  return { failed, attempted, rate, limit, exceeded: attempted > 0 && rate > limit };
}

/**
 * Count, for one scorer across a set of items, how many produced a valid score
 * (`scored`), ran-and-failed (`failed`), or were deliberately skipped by the
 * scorer's `applies` predicate (`skipped`). The single source of truth for the
 * failure-rate trust signal, shared by `runEval`, `rescore`, and `evalCompare`.
 *
 * Three discriminators on the per-scorer `scoreDetails` entry, checked in
 * precedence order so a positive `skipped` marker always wins over the
 * duration heuristic:
 *  - a non-null `scores[name]` ⇒ `scored`;
 *  - else `skipped === true` (the `applies` predicate returned `false`) ⇒
 *    `skipped` — deliberately NOT run, so it belongs in neither the mean nor
 *    the failure-rate denominator;
 *  - else a `duration` ⇒ `failed` (`scoreItem` stamps it whenever a scorer
 *    actually executes: success, throw, or out-of-range);
 *  - else (no score, no marker, no duration) the scorer was skipped by
 *    cancellation (signal aborted before it started) and belongs in no bucket.
 *
 * So `scored + failed` is the honest "attempted" denominator for a failure rate
 * — it excludes both `applies`-skips and cancellations and can be `<` the
 * eligible item count.
 *
 * Items whose WORKFLOW errored (`i.error`) are excluded entirely — the scorers
 * never ran for them, so they're not part of the scorer's sample either way.
 */
export function scorerCounts(
  items: readonly {
    error?: string;
    scores: Record<string, number | null>;
    scoreDetails?: Record<string, { duration?: number; skipped?: boolean; outcome?: string }>;
  }[],
  name: string,
): { scored: number; failed: number; skipped: number } {
  let scored = 0;
  let failed = 0;
  let skipped = 0;
  for (const i of items) {
    if (i.error) continue;
    const detail = i.scoreDetails?.[name];
    // `outcome` is the authoritative classification, so prefer it wherever it
    // exists. The duration heuristic below reconstructs the same taxonomy from
    // the shape of a pre-0.24 artifact, and it is only ever a reconstruction:
    // it reads "no score and no duration" as "never ran", which is right for a
    // cancellation and wrong for a judge the budget stopped mid-flight. Keeping
    // two independent classifiers in the codebase means a later change to
    // either — say, recording the duration a stopped judge actually spent —
    // silently starts counting budget stops as scorer failures and trips the
    // degradation gate on a run with no scorer defect.
    if (detail?.outcome !== undefined) {
      if (detail.outcome === 'scored') scored++;
      else if (detail.outcome === 'failed') failed++;
      else if (detail.outcome === 'skipped') skipped++;
      // 'cancelled' / 'budget_skipped' / 'budget_interrupted' are in no bucket:
      // they are not a sample of the scorer's reliability.
      continue;
    }
    if (i.scores[name] != null) scored++;
    else if (detail?.skipped === true) skipped++;
    else if (detail?.duration != null) failed++;
  }
  return { scored, failed, skipped };
}

/** A scorer's failure-rate verdict against a tolerance — see {@link evaluateScorerTolerance}. */
export type ScorerToleranceVerdict = {
  /** `scored + failed` — the attempted denominator (excludes cancelled/never-run). */
  attempted: number;
  /** `failed / attempted`, or `0` when nothing was attempted. */
  rate: number;
  /** Over tolerance AND something was actually attempted. */
  exceeds: boolean;
  /** Nothing was attempted (`attempted === 0`) — no basis to certify a rate. */
  zeroSample: boolean;
};

/**
 * Single source of truth for the type-aware failure-rate decision, shared by the
 * source-side gate (`runEval` → `summary.degraded`) and the gate-side compare
 * gate (`evalCompare` consumers). Deterministic scorers tolerate ZERO failures
 * (a deterministic throw is a bug, not noise); LLM scorers tolerate up to `limit`
 * (`failed / attempted`). `exceeds` is never true when nothing was attempted —
 * callers decide their own policy for `zeroSample` (the runner skips it; the
 * compare gate refuses to certify a zero-sample scorer).
 */
export function evaluateScorerTolerance(
  scored: number,
  failed: number,
  type: 'llm' | 'deterministic',
  limit: number,
): ScorerToleranceVerdict {
  const attempted = scored + failed;
  const rate = attempted === 0 ? 0 : failed / attempted;
  const exceeds = attempted > 0 && (type === 'deterministic' ? failed > 0 : rate > limit);
  return { attempted, rate, exceeds, zeroSample: attempted === 0 };
}

/**
 * Run `task` over `items` with a bounded worker pool, preserving input order.
 *
 * Results are written to a pre-allocated array at the item's original index, so
 * `results[i]` always corresponds to `items[i]` regardless of completion order.
 *
 * The helper does NOT catch — each `task` must own its try/catch. This is how
 * callers get `Promise.allSettled` semantics (one failing task never rejects
 * the whole batch) while still using a simple worker-pool: a task that resolves
 * (even after internally handling an error) lets the pool continue draining.
 *
 * Concurrency is clamped to `[1, items.length]` in exactly one place here, and
 * non-finite / fractional values are coerced (NaN/Infinity/`2.5` → a sane
 * integer). Callers must NOT pre-clamp with `Math.min(concurrency, items.length)`
 * and pass the result in — a user/env-supplied `0` (or `NaN` from a config like
 * `Number(process.env.X)`) would otherwise yield zero workers while items
 * remain, so `Promise.all` resolves immediately leaving the results array full
 * of holes (and the caller crashes on the `undefined` entries).
 */
export async function mapWithConcurrency<T, R = void>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  // Coerce non-finite (NaN/Infinity) to the floor of 1, and floor fractional
  // values, BEFORE clamping — `Math.max(1, NaN)` is `NaN`, which would make
  // `Array.from({ length: NaN })` empty and silently run zero workers.
  const requested = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const workerCount = items.length === 0 ? 0 : Math.min(Math.max(1, requested), items.length);

  let next = 0;
  async function runNext(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
  return results;
}
