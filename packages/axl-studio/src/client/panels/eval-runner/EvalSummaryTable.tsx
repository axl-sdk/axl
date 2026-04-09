import { cn, formatCost, formatDuration } from '../../lib/utils';
import { scoreBarColor, scoreTextColor } from './types';
import type { EvalItem, EvalResultData } from './types';

type Props = {
  summary: EvalResultData['summary'];
  items: EvalItem[];
  totalCost: number;
  scorerTypes?: Record<string, string>;
};

export function EvalSummaryTable({ summary, items, totalCost, scorerTypes }: Props) {
  const scorerEntries = summary.scorers ? Object.entries(summary.scorers) : [];

  if (scorerEntries.length === 0 && !summary.timing && totalCost <= 0) {
    return null;
  }

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
      <div className="px-4 py-2.5 bg-[hsl(var(--muted))] border-b border-[hsl(var(--border))]">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          Scorer Summary
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[hsl(var(--border))]">
              <th className="text-left px-4 py-2 font-medium w-48">Metric</th>
              <th className="px-4 py-2 w-28" />
              <th className="text-right px-3 py-2 font-medium">Mean</th>
              <th className="text-right px-3 py-2 font-medium">P50</th>
              <th className="text-right px-3 py-2 font-medium">P95</th>
              <th className="text-right px-3 py-2 font-medium">Min</th>
              <th className="text-right px-3 py-2 font-medium">Max</th>
            </tr>
          </thead>
          <tbody>
            {scorerEntries.map(([scorer, stats]) => {
              const hasValidScores = items.some((i) => !i.error && i.scores[scorer] != null);
              return (
                <tr key={scorer} className="border-b border-[hsl(var(--border))] last:border-b-0">
                  <td className="px-4 py-2.5 font-mono text-[hsl(var(--foreground))]">
                    {scorer}
                    {scorerTypes?.[scorer] === 'llm' && (
                      <span
                        className="ml-1.5 px-1 py-0.5 text-[9px] font-medium rounded bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400 align-middle"
                        title="LLM scorer — scores may vary between runs"
                      >
                        LLM
                      </span>
                    )}
                  </td>
                  {hasValidScores ? (
                    <>
                      <td className="px-4 py-2.5">
                        <div className="h-2 bg-[hsl(var(--secondary))] rounded-full overflow-hidden">
                          <div
                            className={cn(
                              'h-full rounded-full transition-all',
                              scoreBarColor(stats.mean),
                            )}
                            style={{ width: `${stats.mean * 100}%` }}
                          />
                        </div>
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2.5 text-right font-mono font-medium',
                          scoreTextColor(stats.mean),
                        )}
                      >
                        {stats.mean.toFixed(3)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                        {stats.p50.toFixed(3)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                        {stats.p95.toFixed(3)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                        {stats.min.toFixed(3)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                        {stats.max.toFixed(3)}
                      </td>
                    </>
                  ) : (
                    <td
                      colSpan={6}
                      className="px-3 py-2.5 text-center text-[hsl(var(--muted-foreground))]"
                    >
                      No valid scores
                    </td>
                  )}
                </tr>
              );
            })}

            {summary.timing && (
              <tr className="border-t border-[hsl(var(--border))]">
                <td className="px-4 py-2.5 font-mono text-[hsl(var(--muted-foreground))]">
                  Timing
                </td>
                <td className="px-4 py-2.5" />
                <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                  {formatDuration(summary.timing.mean)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                  {formatDuration(summary.timing.p50)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                  {formatDuration(summary.timing.p95)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                  {formatDuration(summary.timing.min)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                  {formatDuration(summary.timing.max)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalCost > 0 && (
        <div className="px-4 py-2 border-t border-[hsl(var(--border))] bg-[hsl(var(--muted))]/50">
          <span className="text-xs text-[hsl(var(--muted-foreground))]">
            Total cost: <span className="font-mono font-medium">{formatCost(totalCost)}</span>
          </span>
        </div>
      )}
    </div>
  );
}
