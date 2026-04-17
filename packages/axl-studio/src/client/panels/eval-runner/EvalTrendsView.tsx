import { useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { StatCard } from '../../components/shared/StatCard';
import { EmptyState } from '../../components/shared/EmptyState';
import { WindowSelector } from '../../components/shared/WindowSelector';
import { CostBadge } from '../../components/shared/CostBadge';
import { LineChart, type LineSeries } from '../../components/shared/charts/LineChart';
import { SparkLine } from '../../components/shared/charts/SparkLine';
import { fetchEvalTrends } from '../../lib/api';
import { useAggregate } from '../../hooks/use-aggregate';
import { cn, formatCost, formatDuration } from '../../lib/utils';

/** 3-tier score color: >=0.8 green, >=0.5 amber, <0.5 red */
function scoreColor(score: number): string {
  if (score >= 0.8) return 'text-green-600 dark:text-green-400';
  if (score >= 0.5) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function formatScore(score: number): string {
  return score.toFixed(3);
}

/** Deterministic color-per-scorer so the line colors are stable across renders. */
const PALETTE = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
];
function scorerColor(_name: string, index: number): string {
  return PALETTE[index % PALETTE.length] ?? '#64748b';
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diffMs = now - ts;
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffMs < 7 * day) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString();
}

type ViewMode = 'scorer' | 'model' | 'duration';

export function EvalTrendsView({
  onViewRun,
}: {
  /** Fires when the user clicks a point on a trend chart. Receives the run id. */
  onViewRun?: (runId: string) => void;
} = {}) {
  const { window, handleWindowChange, data: trends } = useAggregate('eval-trends', fetchEvalTrends);
  const [viewMode, setViewMode] = useState<ViewMode>('scorer');

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

      {/* View toggle: Scorer | Model | Duration */}
      <div
        className="flex items-center gap-1 text-xs"
        role="group"
        aria-label="Trend chart view mode"
      >
        <span className="text-[hsl(var(--muted-foreground))] mr-1">View:</span>
        {(['scorer', 'model', 'duration'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            aria-pressed={viewMode === mode}
            className={cn(
              'px-2.5 py-1 rounded-md transition-colors',
              viewMode === mode
                ? 'bg-[hsl(var(--foreground))] text-[hsl(var(--background))]'
                : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]',
            )}
          >
            {mode === 'scorer' ? 'By Scorer' : mode === 'model' ? 'By Model' : 'Duration'}
          </button>
        ))}
      </div>

      {/* Per-eval breakdowns */}
      {evalNames.map((evalName) => {
        const entry = trends.byEval[evalName];
        const scorerNames = Object.keys(entry.scoreMean).sort();
        const sortedRuns = [...entry.runs].sort((a, b) => a.timestamp - b.timestamp);

        // ── Series per view mode ──────────────────────────────────
        let series: LineSeries[] = [];
        let legendEntries: Array<{ name: string; color: string }> = [];
        let chartTitle = '';
        let yClamp: { min?: number; max?: number } | undefined;
        let formatYValue: (v: number) => string = (v) => v.toFixed(2);

        if (viewMode === 'scorer') {
          chartTitle = 'Score Trend by Scorer';
          yClamp = { min: 0, max: 1 };
          series = scorerNames.map((scorer, idx) => ({
            name: scorer,
            color: scorerColor(scorer, idx),
            points: sortedRuns
              .filter((r) => r.scores[scorer] != null)
              .map((r) => ({
                x: r.timestamp,
                y: r.scores[scorer],
                label: r.model ? `${r.id.slice(0, 8)}… · ${r.model}` : r.id,
                meta: r,
              })),
          }));
          legendEntries = scorerNames.map((s, idx) => ({
            name: s,
            color: scorerColor(s, idx),
          }));
        } else if (viewMode === 'model') {
          chartTitle = 'Score Trend by Model (mean of all scorers)';
          yClamp = { min: 0, max: 1 };
          // Group runs by model; y = mean of all finite scorer values in that run
          const byModel = new Map<string, typeof sortedRuns>();
          for (const r of sortedRuns) {
            const key = r.model ?? 'unknown';
            const list = byModel.get(key) ?? [];
            list.push(r);
            byModel.set(key, list);
          }
          const modelNames = [...byModel.keys()].sort();
          series = modelNames.map((model, idx) => {
            const runs = byModel.get(model) ?? [];
            return {
              name: model,
              color: scorerColor(model, idx),
              points: runs
                .map((r) => {
                  const vals = Object.values(r.scores).filter((v): v is number =>
                    Number.isFinite(v),
                  );
                  if (vals.length === 0) return null;
                  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
                  return {
                    x: r.timestamp,
                    y: avg,
                    label: `${r.id.slice(0, 8)}… · ${model}`,
                    meta: r,
                  };
                })
                .filter((p): p is NonNullable<typeof p> => p !== null),
            };
          });
          legendEntries = modelNames.map((m, idx) => ({
            name: m,
            color: scorerColor(m, idx),
          }));
        } else {
          // duration view — one line per model, y = run duration in ms.
          // This answers both "is my eval getting slower?" and
          // "which model is fastest?" in a single chart.
          chartTitle = 'Duration Trend by Model';
          formatYValue = (v) => formatDuration(v);
          const byModelDur = new Map<string, typeof sortedRuns>();
          for (const r of sortedRuns) {
            if (r.duration == null) continue;
            const key = r.model ?? 'unknown';
            const list = byModelDur.get(key) ?? [];
            list.push(r);
            byModelDur.set(key, list);
          }
          const modelNames = [...byModelDur.keys()].sort();
          series = modelNames.map((model, idx) => {
            const runs = byModelDur.get(model) ?? [];
            return {
              name: model,
              color: scorerColor(model, idx),
              points: runs.map((r) => ({
                x: r.timestamp,
                y: r.duration!,
                label: `${r.id.slice(0, 8)}… · ${model}`,
                meta: r,
              })),
            };
          });
          legendEntries = modelNames.map((m, idx) => ({
            name: m,
            color: scorerColor(m, idx),
          }));
        }

        const xMin = sortedRuns.length > 0 ? sortedRuns[0].timestamp : 0;
        const xMax = sortedRuns.length > 0 ? sortedRuns[sortedRuns.length - 1].timestamp : 1;

        // Cost series for sparkline (always in header)
        const costValues = sortedRuns.map((r) => r.cost);

        // Data availability for the active view. A chart needs at least one
        // series with >=2 points. A single point isn't a "trend."
        const hasChartData = series.some((s) => s.points.length >= 2);
        const missingReason =
          viewMode === 'duration' && sortedRuns.every((r) => r.duration == null)
            ? 'No duration metadata recorded on these runs.'
            : (viewMode === 'model' || viewMode === 'duration') &&
                sortedRuns.every((r) => r.model == null)
              ? 'No model metadata recorded on these runs — each run will show as "unknown".'
              : null;

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
              <div className="flex items-center gap-3">
                {costValues.length > 1 && (
                  <div
                    className="flex items-center gap-2 text-[10px] text-[hsl(var(--muted-foreground))]"
                    title="Cost over time"
                  >
                    <span>cost</span>
                    <SparkLine values={costValues} color="hsl(var(--primary))" width={80} height={22} />
                  </div>
                )}
                <CostBadge cost={entry.costTotal} />
              </div>
            </div>

            {/* Trend chart (scorer | model | duration) */}
            {sortedRuns.length > 1 && (
              <div className="px-4 py-3 border-b border-[hsl(var(--border))]">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                    {chartTitle}
                  </p>
                  <div className="flex flex-wrap gap-2 text-[10px]">
                    {legendEntries.map((le) => (
                      <div key={le.name} className="flex items-center gap-1">
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: le.color }}
                        />
                        <span className="font-mono text-[hsl(var(--muted-foreground))]">
                          {le.name}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                {missingReason ? (
                  <p className="py-4 text-xs text-[hsl(var(--muted-foreground))] italic">
                    {missingReason}
                  </p>
                ) : !hasChartData ? (
                  <p className="py-4 text-xs text-[hsl(var(--muted-foreground))] italic">
                    {viewMode === 'scorer'
                      ? 'Need at least 2 runs to draw a trend.'
                      : viewMode === 'model'
                        ? `Not enough runs per model yet — need at least 2 runs from the same model to draw a trend.`
                        : 'Not enough runs per model with duration to draw a trend.'}
                  </p>
                ) : (
                  <LineChart
                    series={series}
                    xMin={xMin}
                    xMax={xMax}
                    yClamp={yClamp}
                    yDomain={{ strategy: 'data', minSpan: viewMode === 'duration' ? 100 : 0.1, padPct: 0.1 }}
                    height={180}
                    formatX={formatTimestamp}
                    formatY={formatYValue}
                    ariaLabel={`${evalName}: ${chartTitle}, ${series.length} series across ${sortedRuns.length} runs. Click a point to view that run.`}
                    onPointClick={
                      onViewRun
                        ? (_s, p) => {
                            const run = p.meta as { id?: string } | undefined;
                            if (run?.id) onViewRun(run.id);
                          }
                        : undefined
                    }
                  />
                )}
              </div>
            )}

            {/* Single-run note */}
            {sortedRuns.length === 1 && scorerNames.length > 0 && (
              <p className="px-4 py-2 text-[11px] text-[hsl(var(--muted-foreground))] border-b border-[hsl(var(--border))]">
                Only one run in window — run again to see trend line.
              </p>
            )}

            {/* Scorer summary table */}
            {scorerNames.length > 0 && (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
                    <th className="py-2 px-4 text-left font-medium">Scorer</th>
                    <th className="py-2 px-4 text-right font-medium">Latest</th>
                    <th
                      className="py-2 px-4 text-right font-medium"
                      title={
                        entry.runCount > 50 ? 'Computed over the 50 most recent runs' : undefined
                      }
                    >
                      Mean{entry.runCount > 50 ? '*' : ''}
                    </th>
                    <th
                      className="py-2 px-4 text-right font-medium"
                      title={
                        entry.runCount > 50 ? 'Computed over the 50 most recent runs' : undefined
                      }
                    >
                      Std{entry.runCount > 50 ? '*' : ''}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {scorerNames.map((scorer, idx) => (
                    <tr
                      key={scorer}
                      className="border-b last:border-b-0 border-[hsl(var(--border))]"
                    >
                      <td className="py-2 px-4 font-mono">
                        <span className="inline-flex items-center gap-1.5">
                          {/* Color dot only when the chart is actually
                              coloring lines per-scorer. In By Model / Duration
                              views the chart's colors are keyed on model, so
                              scorer dots here would visually "claim" the same
                              colors are chart lines — drop to muted. */}
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{
                              backgroundColor:
                                viewMode === 'scorer'
                                  ? scorerColor(scorer, idx)
                                  : 'hsl(var(--muted-foreground) / 0.4)',
                            }}
                          />
                          {scorer}
                        </span>
                      </td>
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

            {entry.runCount > 50 && (
              <p className="px-4 pt-2 text-[10px] text-[hsl(var(--muted-foreground))]">
                * Mean and Std computed over the 50 most recent runs
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
