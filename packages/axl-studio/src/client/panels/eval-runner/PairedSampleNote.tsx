import type { ComparisonScorerEntry } from './types';

/**
 * Per-scorer caption for the compare view that surfaces the per-side-vs-paired
 * sample mismatch. The headline `delta` is the difference of two INDEPENDENT
 * per-side means (each over that side's own scored items); the CI / significance
 * are PAIRED over the `n` items scored on both sides. When a side dropped items
 * (skipped as N/A, or failed) or the paired sample is smaller than either side's
 * scored count, those two numbers rest on different samples — so a delta can be
 * a sample mismatch rather than a real change.
 *
 * Renders nothing for clean, symmetric runs (paired === per-side, no drops) so
 * the common case stays uncluttered — it appears only when it actually matters.
 * Uses a `title` tooltip (matching `ScorerSampleChips`) so it's testable without
 * the full compare-panel harness.
 */
export function PairedSampleNote({ stats }: { stats: ComparisonScorerEntry }) {
  const pairedN = stats.n;
  const bScored = stats.baselineScored;
  const cScored = stats.candidateScored;
  const bSkipped = stats.baselineSkipped ?? 0;
  const cSkipped = stats.candidateSkipped ?? 0;
  const bFailed = stats.baselineFailed ?? 0;
  const cFailed = stats.candidateFailed ?? 0;

  const diverges =
    pairedN != null &&
    bScored != null &&
    cScored != null &&
    (bSkipped + cSkipped + bFailed + cFailed > 0 || pairedN < Math.min(bScored, cScored));

  if (!diverges) return null;

  const sideDetail = (scored: number, skipped: number, failed: number) =>
    `${scored} scored${skipped > 0 ? `, ${skipped} N/A` : ''}${failed > 0 ? `, ${failed} failed` : ''}`;

  return (
    <div
      className="font-mono text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5 underline decoration-dotted underline-offset-2 cursor-help"
      title={
        `Delta compares per-side means — baseline over ${sideDetail(bScored!, bSkipped, bFailed)}; ` +
        `candidate over ${sideDetail(cScored!, cSkipped, cFailed)}. ` +
        `The CI / significance use the ${pairedN} item(s) scored on BOTH sides, ` +
        `so the delta and CI rest on different samples here.`
      }
    >
      paired n={pairedN} · per-side {bScored}/{cScored}
    </div>
  );
}
