import { getResultDroppedAnnotationKeys, type EvalResultData } from './types';

/** Cap chips so a dataset with an undeclared key inside a large annotation
 *  array (which yields per-index paths like `tags[0].x`, `tags[1].x`, …) can't
 *  push the stat cards off-screen. The headline still carries the full count. */
const MAX_VISIBLE_KEYS = 20;

/**
 * Amber banner shown above a run's stat cards when the dataset's `annotations`
 * schema stripped keys that never reached scorers — a common cause of scorers
 * that silently no-op on `undefined`. Rendered in BOTH the single-run and
 * multi-run-aggregate views: the dropped keys are dataset-level, so they're
 * identical across a run group, and the aggregate view is the default landing
 * view for a multi-run group. Returns nothing when there are no dropped keys.
 *
 * Display-only (no `readOnly` gate) — the warning is equally relevant to a
 * read-only viewer. Mirrors the partial-batch banner's amber palette and
 * `role="status"` so stacked banners read as one family.
 */
export function DroppedAnnotationKeysBanner({ result }: { result: EvalResultData }) {
  const keys = getResultDroppedAnnotationKeys(result);
  if (keys.length === 0) return null;

  const visible = keys.slice(0, MAX_VISIBLE_KEYS);
  const overflow = keys.length - visible.length;
  const isOne = keys.length === 1;

  return (
    <div
      className="mb-3 rounded-md border border-amber-300/60 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
      role="status"
    >
      <div className="font-medium">
        {keys.length} annotation {isOne ? 'key' : 'keys'} dropped by the dataset schema
      </div>
      <div className="mt-1 text-amber-800/90 dark:text-amber-300/90">
        Stripped before reaching scorers, so any scorer reading {isOne ? 'it' : 'them'} silently
        sees <code className="font-mono">undefined</code>. Declare {isOne ? 'it' : 'them'} in the
        dataset&rsquo;s <code className="font-mono">annotations</code> schema.
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {visible.map((k) => (
          <span
            key={k}
            className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200 text-[10px] font-mono font-medium"
          >
            {k}
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
