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

/**
 * Count, for one scorer across a set of items, how many produced a valid score
 * (`scored`) vs ran-and-failed (`failed`). The single source of truth for the
 * failure-rate trust signal, shared by `runEval`, `rescore`, and `evalCompare`.
 *
 * The discriminator is `scoreDetails[name].duration`: `scoreItem` sets it
 * whenever a scorer actually executes (success, throw, or out-of-range), but a
 * scorer skipped by cancellation keeps its pre-seeded `{ score: null }` with NO
 * duration. So a `null` score WITH a duration is a genuine failure, while a
 * `null` score WITHOUT one was never attempted (cancellation) and belongs in
 * neither bucket — making `scored + failed` the honest "attempted" denominator
 * for a failure rate (it can be `<` the eligible item count).
 *
 * Items whose WORKFLOW errored (`i.error`) are excluded entirely — the scorers
 * never ran for them, so they're not part of the scorer's sample either way.
 */
export function scorerCounts(
  items: readonly {
    error?: string;
    scores: Record<string, number | null>;
    scoreDetails?: Record<string, { duration?: number }>;
  }[],
  name: string,
): { scored: number; failed: number } {
  let scored = 0;
  let failed = 0;
  for (const i of items) {
    if (i.error) continue;
    if (i.scores[name] != null) scored++;
    else if (i.scoreDetails?.[name]?.duration != null) failed++;
  }
  return { scored, failed };
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
