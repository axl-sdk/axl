/**
 * Terminal rendering helpers for the `axl-eval` CLI, factored out of `cli.ts` so
 * they can be unit-tested without importing `cli.ts` (whose module body runs
 * `main()` on import) — same reason as `cli-args.ts`.
 */

import type { ModelTimingStats } from './types.js';

/**
 * Render the per-model provider-latency rows that sit under the wall-clock
 * `Timing` row.
 *
 * Every figure is per PROVIDER CALL — the whole `modelTiming` surface is now
 * one kind of average, so there is nothing here a reader can accidentally
 * divide by the call count and get wrong.
 *
 * `wire` and `first token` carry a `mean/p95` pair because those are the two
 * model-comparison figures and a tail matters for both. `queued` and `retries`
 * print a mean only: they describe Axl's own limiter and the provider's
 * throttling on the day of the run, so a p95 would lengthen every row without
 * changing a model choice. The full distributions stay on the JSON artifact.
 *
 * Units are milliseconds and every number is suffixed, because these are
 * routinely sub-second and the `Timing` row above renders seconds — an
 * unlabelled column would silently mix the two.
 *
 * `first token` appears only when at least one call actually streamed one, so a
 * non-streaming run shows no misleading `0ms`.
 *
 * @param modelTiming `EvalSummary.modelTiming`, or undefined for no rows.
 * @param nameWidth   The scorer-name column width, so model names line up under it.
 */
export function formatModelTimingLines(
  modelTiming: Record<string, ModelTimingStats> | undefined,
  nameWidth: number,
): string[] {
  if (!modelTiming) return [];
  return Object.entries(modelTiming).map(([model, t]) => {
    const parts = [`wire ${formatMs(t.wireMs.mean)}/${formatMs(t.wireMs.p95)}`];
    if (t.firstTokenMs) {
      parts.push(`first token ${formatMs(t.firstTokenMs.mean)}/${formatMs(t.firstTokenMs.p95)}`);
    }
    parts.push(`queued ${formatMs(t.queuedMs.mean)}`);
    parts.push(`retries ${formatMs(t.retryMs.mean)}`);
    const calls = `${t.calls} call${t.calls === 1 ? '' : 's'}`;
    return `    ${model.padEnd(Math.max(nameWidth - 2, 0))}  ${parts.join(' · ')}  (${calls}, mean/p95 per call)`;
  });
}

/** Whole milliseconds with an explicit unit. Latencies here are per call, so a
 *  seconds-with-one-decimal rendering would collapse most of them to `0.0s`. */
function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}
