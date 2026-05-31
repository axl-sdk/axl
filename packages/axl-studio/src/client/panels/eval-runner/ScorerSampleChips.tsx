/**
 * Inline sample-count chips rendered next to a scorer name: an amber "N failed"
 * chip when a scorer ran and failed on some items, and a neutral muted "N/A: N"
 * chip when a scorer's `applies` predicate skipped some items. Skips are NOT
 * failures — they're excluded from both the mean and the failure rate — so the
 * two chips use distinct tones (amber = failed, muted = not applicable),
 * matching EvalSummaryTable / ScoreDistribution exactly.
 *
 * Extracted so the multi-run Per-Scorer Aggregate table (deep inside
 * EvalRunnerPanel) can render the same chips as the single-run summary and be
 * unit-tested without a full-panel harness.
 */
export function ScorerSampleChips({ failed, skipped }: { failed?: number; skipped?: number }) {
  return (
    <>
      {(failed ?? 0) > 0 && (
        <span
          className="ml-1.5 px-1 py-0.5 text-[9px] font-medium rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 align-middle"
          title={`${failed} scorer run(s) failed — the mean is computed over the runs/items that succeeded.`}
        >
          {failed} failed
        </span>
      )}
      {(skipped ?? 0) > 0 && (
        <span
          className="ml-1.5 px-1 py-0.5 text-[9px] font-medium rounded bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] align-middle"
          title={`${skipped} item(s) not applicable to this scorer (applies predicate returned false) — excluded from the mean and the failure rate`}
        >
          N/A: {skipped}
        </span>
      )}
    </>
  );
}
