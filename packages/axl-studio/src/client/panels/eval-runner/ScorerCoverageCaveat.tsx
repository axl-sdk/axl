import type { EvalCoverage } from './types';

/**
 * Says so when a scorer's mean was computed over fewer items than the run has,
 * because the budget refused the rest of that judge's work.
 *
 * A budget-stopped judge deliberately lands in NO outcome bucket: it produced
 * no score, and counting it would bias the mean toward whatever the scored
 * items happened to be. The consequence is that the DENOMINATOR shrinks
 * silently — a scorer that scored 1 of 5 items because the budget refused 4
 * shows a bare mean with nothing to say the other four never ran.
 *
 * The single-run view has the coverage counters on the same card, so the fact
 * is recoverable there. The multi-run aggregate view renders no coverage block
 * at all, which is why this exists.
 *
 * `null` when nothing was refused, or when the artifact recorded no coverage
 * (a pre-0.24 run cannot be used to claim anything about coverage).
 */
export function ScorerCoverageCaveat({ coverage }: { coverage: EvalCoverage | undefined }) {
  if (!coverage) return null;
  const thinned = Object.entries(coverage.scorers)
    .map(([name, c]) => ({
      name,
      notRun: c.budget_skipped + c.budget_interrupted,
      scored: c.scored,
    }))
    .filter((s) => s.notRun > 0);
  if (thinned.length === 0) return null;

  return (
    <div
      role="status"
      className="px-4 py-2 border-b border-amber-300/60 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/40 text-[11px] text-amber-900 dark:text-amber-200"
    >
      Budget stops thinned these means — each is over the items the judge actually scored:{' '}
      {thinned.map((s) => `${s.name} (${s.notRun} of ${s.scored + s.notRun} not run)`).join(', ')}.
    </div>
  );
}
