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
 * Every printed figure is an **exact call-weighted mean** (`meanWireMs` and
 * friends), never the per-item-sampled `wireMs`/`queuedMs` distributions. That
 * distinction matters: with two items where one makes 1 call at 100ms and the
 * other makes 99 at 1000ms, the per-item mean is 550ms while the true per-call
 * mean is 991ms. Printing the per-item figure beside a call count would invite
 * the reader to divide one by the other and pick the wrong model. The
 * distributions stay available on the JSON artifact for anyone who wants spread.
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
    const parts = [`wire ${formatMs(t.meanWireMs)}`];
    if (t.meanFirstTokenMs != null) parts.push(`first token ${formatMs(t.meanFirstTokenMs)}`);
    parts.push(`queued ${formatMs(t.meanQueuedMs)}`);
    parts.push(`retries ${formatMs(t.meanRetryMs)}`);
    const calls = `${t.calls} call${t.calls === 1 ? '' : 's'}`;
    return `    ${model.padEnd(Math.max(nameWidth - 2, 0))}  ${parts.join(' · ')}  (${calls}, mean per call)`;
  });
}

/** Whole milliseconds with an explicit unit. Latencies here are per call, so a
 *  seconds-with-one-decimal rendering would collapse most of them to `0.0s`. */
function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}
