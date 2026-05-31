import { cn } from '../../lib/utils';
import { scoreTextColor } from './types';
import { ScorerSampleChips } from './ScorerSampleChips';

/** One scorer's aggregate stats across a multi-run group. */
export type AggregateScorerStats = {
  mean: number;
  std: number;
  min: number;
  max: number;
  scored?: number;
  failed?: number;
  skipped?: number;
};

/**
 * Coefficient-of-variation coloring for the multi-run Std column: muted when
 * stable, amber for moderate spread, red for high run-to-run variance. Pure —
 * extracted alongside the row so the multi-run Per-Scorer Aggregate table can
 * be unit-tested without the full EvalRunnerPanel harness (same rationale as
 * ScorerSampleChips).
 */
export function stdTextColor(std: number, mean: number): string {
  if (mean === 0) return 'text-[hsl(var(--muted-foreground))]';
  const cv = std / mean;
  if (cv < 0.02) return 'text-[hsl(var(--muted-foreground))]';
  if (cv <= 0.05) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

/**
 * A single row of the multi-run Per-Scorer Aggregate table.
 *
 * Parity with the single-run EvalSummaryTable: a scorer that scored zero items
 * across every run (e.g. skipped on all of them) aggregates to mean/min/max = 0.
 * Rendering a red 0.000 there reads as "scored zero" when the scorer never ran,
 * so we render a muted "No valid scores" spanning the four stat columns instead.
 */
export function AggregateScorerRow({
  name,
  stats,
  isLlm,
}: {
  name: string;
  stats: AggregateScorerStats;
  isLlm?: boolean;
}) {
  const hasValidScores = (stats.scored ?? 0) > 0;
  return (
    <tr className="border-b border-[hsl(var(--border))] last:border-b-0">
      <td className="px-4 py-2.5 font-mono">
        {name}
        {isLlm && (
          <span
            className="ml-1.5 px-1 py-0.5 text-[9px] font-medium rounded bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400 align-middle"
            title="LLM scorer — scores may vary between runs"
          >
            LLM
          </span>
        )}
        <ScorerSampleChips failed={stats.failed} skipped={stats.skipped} />
      </td>
      {hasValidScores ? (
        <>
          <td
            className={cn(
              'px-3 py-2.5 text-right font-mono font-medium',
              scoreTextColor(stats.mean),
            )}
          >
            {stats.mean.toFixed(3)}
          </td>
          <td
            className={cn('px-3 py-2.5 text-right font-mono', stdTextColor(stats.std, stats.mean))}
          >
            {stats.std.toFixed(3)}
          </td>
          <td className={cn('px-3 py-2.5 text-right font-mono', scoreTextColor(stats.min))}>
            {stats.min.toFixed(3)}
          </td>
          <td className={cn('px-3 py-2.5 text-right font-mono', scoreTextColor(stats.max))}>
            {stats.max.toFixed(3)}
          </td>
        </>
      ) : (
        <td colSpan={4} className="px-3 py-2.5 text-center text-[hsl(var(--muted-foreground))]">
          No valid scores
        </td>
      )}
    </tr>
  );
}
