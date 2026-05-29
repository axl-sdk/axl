import { getResultScorerFiltered, type EvalResultData } from './types';

/** Cap chips so an eval with a large scorer suite filtered down can't push the
 *  stat cards off-screen. The headline still carries the full count. */
const MAX_VISIBLE_SCORERS = 20;

/**
 * Amber banner shown above a run's stat cards when the eval was run with a
 * filtered scorer subset (`metadata.scorerFiltered === true`, set by the eval
 * CLI's `--scorers` flag). Such a run is NOT full-coverage and shouldn't be
 * trusted as a baseline. Rendered in BOTH the single-run and
 * multi-run-aggregate views: the scorer filter is run-level, so it's identical
 * across a run group, and the aggregate view is the default landing view for a
 * multi-run group. Returns nothing for full-coverage runs.
 *
 * Display-only (no `readOnly` gate) — the warning is equally relevant to a
 * read-only viewer. Mirrors the dropped-annotation-keys banner's amber palette
 * and `role="status"` so stacked banners read as one family.
 */
export function ScorerFilteredBanner({ result }: { result: EvalResultData }) {
  const scorers = getResultScorerFiltered(result);
  if (scorers.length === 0) return null;

  const visible = scorers.slice(0, MAX_VISIBLE_SCORERS);
  const overflow = scorers.length - visible.length;
  const isOne = scorers.length === 1;

  return (
    <div
      className="mb-3 rounded-md border border-amber-300/60 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
      role="status"
    >
      <div className="font-medium">
        Filtered scorer subset &mdash; ran {scorers.length} {isOne ? 'scorer' : 'scorers'}
      </div>
      <div className="mt-1 text-amber-800/90 dark:text-amber-300/90">
        Only {isOne ? 'this scorer was' : 'these scorers were'} run, not the eval&rsquo;s full set.
        This is not a full-coverage run &mdash; don&rsquo;t use it as a baseline.
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {visible.map((s) => (
          <span
            key={s}
            className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200 text-[10px] font-mono font-medium"
          >
            {s}
          </span>
        ))}
        {overflow > 0 && (
          <span className="px-1.5 py-0.5 text-[10px] text-amber-800/80 dark:text-amber-300/80 font-medium">
            +{overflow} more
          </span>
        )}
      </div>
    </div>
  );
}
