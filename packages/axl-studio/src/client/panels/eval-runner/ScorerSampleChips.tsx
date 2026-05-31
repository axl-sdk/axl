/**
 * Inline sample-count chips rendered next to a scorer name: an amber "failed"
 * chip when a scorer ran and failed on some items, and a neutral muted "N/A: N"
 * chip when a scorer's `applies` predicate skipped some items. Skips are NOT
 * failures — they're excluded from both the mean and the failure rate — so the
 * two chips use distinct tones (amber = failed, muted = not applicable).
 *
 * This is the single source of truth for both chips. EvalSummaryTable,
 * ScoreDistribution, and the multi-run Per-Scorer Aggregate table (deep inside
 * EvalRunnerPanel) all render through it so the markup can't drift and is
 * unit-testable without a full-panel harness.
 *
 * The failed chip has two label forms:
 *   - Rich (`scored` provided): `{scored}/{scored+failed} scored, {failed} failed`
 *     — used where the scored count is meaningful at the same surface
 *     (EvalSummaryTable's per-scorer row).
 *   - Simple (`scored` omitted): `{failed} failed` — used where only the failure
 *     count matters (ScoreDistribution strip, multi-run aggregate row).
 */
export function ScorerSampleChips({
  failed,
  skipped,
  scored,
}: {
  failed?: number;
  skipped?: number;
  scored?: number;
}) {
  const failedCount = failed ?? 0;
  return (
    <>
      {failedCount > 0 && (
        <span
          className="ml-1.5 px-1 py-0.5 text-[9px] font-medium rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 align-middle"
          title={`${failed} scorer run(s) failed — the mean is computed over the runs/items that succeeded.`}
        >
          {scored != null
            ? `${scored}/${scored + failedCount} scored, ${failedCount} failed`
            : `${failedCount} failed`}
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
