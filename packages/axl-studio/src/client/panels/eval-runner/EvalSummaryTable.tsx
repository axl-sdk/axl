import { formatCost, formatDuration } from '../../lib/utils';
import type { EvalItem, EvalResultData } from './types';

type Props = {
  summary: EvalResultData['summary'];
  items: EvalItem[];
  totalCost: number;
};

export function EvalSummaryTable({ summary, items, totalCost }: Props) {
  const scorerEntries = summary.scorers ? Object.entries(summary.scorers) : [];

  if (scorerEntries.length === 0 && !summary.timing && totalCost <= 0) {
    return null;
  }

  return (
    <div>
      <h3 className="text-sm font-medium mb-2">Summary</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[hsl(var(--border))]">
            <th className="text-left py-2 font-medium">Metric</th>
            <th className="text-right py-2 font-medium">Mean</th>
            <th className="text-right py-2 font-medium">P50</th>
            <th className="text-right py-2 font-medium">P95</th>
            <th className="text-right py-2 font-medium">Min</th>
            <th className="text-right py-2 font-medium">Max</th>
          </tr>
        </thead>
        <tbody>
          {scorerEntries.map(([scorer, stats]) => {
            const hasValidScores = items.some((i) => !i.error && i.scores[scorer] != null);
            return (
              <tr key={scorer} className="border-b border-[hsl(var(--border))]">
                <td className="py-2 font-mono">{scorer}</td>
                {hasValidScores ? (
                  <>
                    <td className="py-2 text-right font-mono">{stats.mean.toFixed(3)}</td>
                    <td className="py-2 text-right font-mono">{stats.p50.toFixed(3)}</td>
                    <td className="py-2 text-right font-mono">{stats.p95.toFixed(3)}</td>
                    <td className="py-2 text-right font-mono">{stats.min.toFixed(3)}</td>
                    <td className="py-2 text-right font-mono">{stats.max.toFixed(3)}</td>
                  </>
                ) : (
                  <td colSpan={5} className="py-2 text-center text-[hsl(var(--muted-foreground))]">
                    No valid scores
                  </td>
                )}
              </tr>
            );
          })}

          {summary.timing && (
            <tr className="border-b border-[hsl(var(--border))]">
              <td className="py-2 font-mono text-[hsl(var(--muted-foreground))]">Timing</td>
              <td className="py-2 text-right font-mono">{formatDuration(summary.timing.mean)}</td>
              <td className="py-2 text-right font-mono">{formatDuration(summary.timing.p50)}</td>
              <td className="py-2 text-right font-mono">{formatDuration(summary.timing.p95)}</td>
              <td className="py-2 text-right font-mono">{formatDuration(summary.timing.min)}</td>
              <td className="py-2 text-right font-mono">{formatDuration(summary.timing.max)}</td>
            </tr>
          )}
        </tbody>
      </table>

      {totalCost > 0 && (
        <div className="mt-2 text-xs text-[hsl(var(--muted-foreground))]">
          Total cost: <span className="font-mono">{formatCost(totalCost)}</span>
        </div>
      )}
    </div>
  );
}
