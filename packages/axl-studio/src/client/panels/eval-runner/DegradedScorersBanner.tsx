import { getResultDegraded, type DegradedScorer, type EvalResultData } from './types';

/** Cap lines so an eval with a large scorer suite that degraded en masse can't
 *  push the stat cards off-screen. The headline still carries the full count. */
const MAX_VISIBLE_LINES = 5;

/** Render one scorer's degradation as a single human-readable line, e.g.
 *  `"accuracy" failed 50.0% (5/10) — over the 10.0% limit (llm)` for an LLM
 *  scorer, or `"exact" failed 25.0% (1/4) — deterministic scorers tolerate no
 *  failures` for a deterministic one (where the limit is implicitly zero). */
function degradedLine(d: DegradedScorer): string {
  const total = d.scored + d.failed;
  const pct = (d.rate * 100).toFixed(1);
  const head = `"${d.scorer}" failed ${pct}% (${d.failed}/${total})`;
  // In a multi-run aggregate, `runsAffected` records how many runs flagged
  // this scorer (set by `buildMultiRunResult`'s union). Append it so a
  // degradation that only tripped on later runs reads honestly — single-run
  // results have no `runsAffected` and so render no suffix.
  const runsSuffix =
    d.runsAffected != null && d.runsAffected > 0
      ? ` (in ${d.runsAffected} run${d.runsAffected === 1 ? '' : 's'})`
      : '';
  if (d.type === 'deterministic') {
    return `${head} — deterministic scorers tolerate no failures${runsSuffix}`;
  }
  return `${head} — over the ${(d.limit * 100).toFixed(1)}% limit (llm)${runsSuffix}`;
}

/**
 * Amber banner shown above a run's stat cards when one or more scorers tripped
 * the configured failure-rate tolerance (`EvalConfig.failOnScorerErrorRate`;
 * deterministic scorers tolerate zero failures). Such a run's mean rests on a
 * thinned, unrepresentative sample and shouldn't be trusted. Rendered in BOTH
 * the single-run and multi-run-aggregate views: degradation is run-level, so
 * it's identical across the representative run in a group, and the aggregate
 * view is the default landing view for a multi-run group. Returns nothing when
 * no scorer degraded.
 *
 * Display-only (no `readOnly` gate) — the warning is equally relevant to a
 * read-only viewer. Mirrors the dropped-annotation-keys and scorer-filtered
 * banners' amber palette and `role="status"` so stacked banners read as one
 * family.
 */
export function DegradedScorersBanner({ result }: { result: EvalResultData }) {
  const degraded = getResultDegraded(result);
  if (degraded.length === 0) return null;

  const visible = degraded.slice(0, MAX_VISIBLE_LINES);
  const overflow = degraded.length - visible.length;
  const isOne = degraded.length === 1;

  return (
    <div
      className="mb-3 rounded-md border border-amber-300/60 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
      role="status"
    >
      <div className="font-medium">
        {degraded.length} {isOne ? 'scorer' : 'scorers'} exceeded the failure-rate tolerance
      </div>
      <div className="mt-1 text-amber-800/90 dark:text-amber-300/90">
        {isOne ? 'This scorer' : 'These scorers'} ran and failed on too many items, so the reported
        mean rests on a thinned, unrepresentative sample &mdash; don&rsquo;t trust it.
      </div>
      <ul className="mt-2 space-y-0.5">
        {visible.map((d) => (
          <li
            key={d.scorer}
            className="text-[11px] font-mono text-amber-800/90 dark:text-amber-300/90"
          >
            {degradedLine(d)}
          </li>
        ))}
        {overflow > 0 && (
          <li className="text-[11px] text-amber-800/80 dark:text-amber-300/80 font-medium">
            +{overflow} more
          </li>
        )}
      </ul>
    </div>
  );
}
