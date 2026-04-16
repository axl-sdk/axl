import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TrendingUp } from 'lucide-react';
import { StatCard } from '../../components/shared/StatCard';
import { EmptyState } from '../../components/shared/EmptyState';
import {
  WindowSelector,
  getStoredWindow,
  setStoredWindow,
} from '../../components/shared/WindowSelector';
import { CostBadge } from '../../components/shared/CostBadge';
import { fetchEvalTrends } from '../../lib/api';
import { useWs } from '../../hooks/use-ws';
import { cn, formatCost } from '../../lib/utils';
import type { WindowId, EvalTrendData, AggregateBroadcast } from '../../lib/types';

/** 3-tier score color: >=0.8 green, >=0.5 amber, <0.5 red */
function scoreColor(score: number): string {
  if (score >= 0.8) return 'text-green-600 dark:text-green-400';
  if (score >= 0.5) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function formatScore(score: number): string {
  return score.toFixed(3);
}

export function EvalTrendsView() {
  const [window, setWindow] = useState<WindowId>(getStoredWindow);
  const [liveSnapshots, setLiveSnapshots] = useState<Record<WindowId, EvalTrendData> | null>(null);

  const { data: fetchedData } = useQuery({
    queryKey: ['eval-trends', window],
    queryFn: () => fetchEvalTrends(window),
  });

  useWs(
    'eval-trends',
    useCallback((data: unknown) => {
      const broadcast = data as AggregateBroadcast<EvalTrendData>;
      if (broadcast.snapshots) setLiveSnapshots(broadcast.snapshots);
    }, []),
  );

  const handleWindowChange = (w: WindowId) => {
    setWindow(w);
    setStoredWindow(w);
  };

  const trends = liveSnapshots?.[window] ?? fetchedData;

  if (!trends || trends.totalRuns === 0) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-sm font-medium">Eval Trends</h3>
          <WindowSelector value={window} onChange={handleWindowChange} />
        </div>
        <EmptyState
          icon={<TrendingUp size={32} />}
          title="No eval trends yet"
          description="Run evaluations to see score trends over time."
        />
      </div>
    );
  }

  const evalNames = Object.keys(trends.byEval).sort();

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Eval Trends</h3>
        <WindowSelector value={window} onChange={handleWindowChange} />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Total Runs" value={String(trends.totalRuns)} subtitle={window} />
        <StatCard
          label="Evals Tracked"
          value={String(evalNames.length)}
          subtitle={evalNames.length === 1 ? 'eval' : 'evals'}
        />
        <StatCard label="Total Cost" value={formatCost(trends.totalCost)} subtitle="all evals" />
      </div>

      {/* Per-eval breakdowns */}
      {evalNames.map((evalName) => {
        const entry = trends.byEval[evalName];
        const scorerNames = Object.keys(entry.scoreMean).sort();

        return (
          <div
            key={evalName}
            className="rounded-xl border border-[hsl(var(--border))] overflow-hidden"
          >
            <div className="px-4 py-3 bg-[hsl(var(--card))] border-b border-[hsl(var(--border))] flex items-center justify-between">
              <div>
                <span className="font-mono text-sm font-medium">{evalName}</span>
                <span className="text-xs text-[hsl(var(--muted-foreground))] ml-2">
                  {entry.runCount} run{entry.runCount !== 1 ? 's' : ''}
                </span>
              </div>
              <CostBadge cost={entry.costTotal} />
            </div>

            {/* Scorer summary table */}
            {scorerNames.length > 0 && (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
                    <th className="py-2 px-4 text-left font-medium">Scorer</th>
                    <th className="py-2 px-4 text-right font-medium">Latest</th>
                    <th className="py-2 px-4 text-right font-medium">Mean</th>
                    <th className="py-2 px-4 text-right font-medium">Std</th>
                  </tr>
                </thead>
                <tbody>
                  {scorerNames.map((scorer) => (
                    <tr
                      key={scorer}
                      className="border-b last:border-b-0 border-[hsl(var(--border))]"
                    >
                      <td className="py-2 px-4 font-mono">{scorer}</td>
                      <td
                        className={cn(
                          'py-2 px-4 text-right font-mono',
                          scoreColor(entry.latestScores[scorer] ?? 0),
                        )}
                      >
                        {entry.latestScores[scorer] != null
                          ? formatScore(entry.latestScores[scorer])
                          : '—'}
                      </td>
                      <td
                        className={cn(
                          'py-2 px-4 text-right font-mono',
                          scoreColor(entry.scoreMean[scorer] ?? 0),
                        )}
                      >
                        {formatScore(entry.scoreMean[scorer] ?? 0)}
                      </td>
                      <td className="py-2 px-4 text-right font-mono text-[hsl(var(--muted-foreground))]">
                        {formatScore(entry.scoreStd[scorer] ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Recent runs timeline */}
            <div className="px-4 py-3 space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-2">
                Recent Runs
              </p>
              {entry.runs
                .slice()
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 10)
                .map((run) => (
                  <div key={run.id} className="flex items-center justify-between text-xs py-1">
                    <span className="text-[hsl(var(--muted-foreground))]">
                      {new Date(run.timestamp).toLocaleDateString()}{' '}
                      {new Date(run.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <div className="flex items-center gap-3">
                      {Object.entries(run.scores).map(([scorer, score]) => (
                        <span key={scorer} className={cn('font-mono', scoreColor(score))}>
                          {scorer}: {formatScore(score)}
                        </span>
                      ))}
                      {run.cost > 0 && <CostBadge cost={run.cost} />}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
