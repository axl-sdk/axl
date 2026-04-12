import { useState, useCallback, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Play, ArrowLeft } from 'lucide-react';
import { EmptyState } from '../../components/shared/EmptyState';
import {
  fetchEvals,
  fetchEvalHistory,
  runRegisteredEval,
  compareEvals,
  rescoreEval,
} from '../../lib/api';
import { cn, formatCost, formatDuration, formatTokens, extractLabel } from '../../lib/utils';
import type { RegisteredEval } from '../../lib/types';
import type { EvalResultData, ComparisonResult } from './types';
import {
  scoreTextColor,
  scoreBgTint,
  scoreColorClass,
  getResultModels,
  getResultModelCounts,
  formatModelName,
  getResultTokens,
} from './types';
import { EvalSummaryTable } from './EvalSummaryTable';
import { EvalItemList } from './EvalItemList';
import { EvalItemDetail } from './EvalItemDetail';
import { EvalItemSidebar } from './EvalItemSidebar';
import { ScoreDistribution } from './ScoreDistribution';
import { EvalCompareView } from './EvalCompareView';
import { EvalCompareRunPicker } from './EvalCompareRunPicker';
import type { RunSelection } from './EvalCompareRunPicker';
import { EvalMultiRunSwitcher } from './EvalMultiRunSwitcher';
import { EvalHistoryTable } from './EvalHistoryTable';
import { StatCard } from '../../components/shared/StatCard';
import { JsonViewer } from '../../components/shared/JsonViewer';

export function EvalRunnerPanel() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'run' | 'history' | 'compare'>('run');
  const [selectedEval, setSelectedEval] = useState('');
  const [running, setRunning] = useState(false);
  const [currentResult, setCurrentResult] = useState<EvalResultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<number | null>(null);
  const [runCount, setRunCount] = useState(1);
  const [multiRunIndex, setMultiRunIndex] = useState(-1);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedWorstItem, setExpandedWorstItem] = useState<number | null>(null);
  const [worstItemRunIdx, setWorstItemRunIdx] = useState(0);
  const [previousTab, setPreviousTab] = useState<string | null>(null);

  // EvalItemList filter/sort state (lifted so it survives navigate-back from detail view)
  const [errorFilter, setErrorFilter] = useState<'all' | 'errors' | 'no-errors'>('all');
  const [scorerFilter, setScorerFilter] = useState('');
  const [threshold, setThreshold] = useState('');
  const [sortField, setSortField] = useState<string>('index');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Aggregate table sort state
  const [aggSortField, setAggSortField] = useState<'scorer' | 'mean' | 'std' | 'min' | 'max'>(
    'mean',
  );
  const [aggSortDir, setAggSortDir] = useState<'asc' | 'desc'>('asc');

  // History filter
  const [historyEvalFilter, setHistoryEvalFilter] = useState('');

  // Compare state
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<ComparisonResult | null>(null);
  const [compareBaseline, setCompareBaseline] = useState<EvalResultData | null>(null);
  const [compareCandidate, setCompareCandidate] = useState<EvalResultData | null>(null);
  const [baselineSelection, setBaselineSelection] = useState<RunSelection | null>(null);
  const [candidateSelection, setCandidateSelection] = useState<RunSelection | null>(null);
  const [compareBaselineRuns, setCompareBaselineRuns] = useState<EvalResultData[] | null>(null);
  const [compareCandidateRuns, setCompareCandidateRuns] = useState<EvalResultData[] | null>(null);

  const { data: evals = [] } = useQuery({
    queryKey: ['evals'],
    queryFn: fetchEvals,
  });

  const { data: history = [] } = useQuery({
    queryKey: ['evalHistory'],
    queryFn: fetchEvalHistory,
  });

  // Auto-default: select the two most recent groups/entries of the same eval
  useEffect(() => {
    if (baselineSelection || candidateSelection || history.length < 2) return;
    const firstEval = history[0].eval;
    const sameEval = history.filter((h) => h.eval === firstEval);
    if (sameEval.length < 2) return;

    // Find distinct groups/singles in order
    const seen = new Set<string>();
    const distinct: RunSelection[] = [];
    for (const entry of sameEval) {
      const gid = (entry.data as EvalResultData).metadata?.runGroupId as string | undefined;
      const key = gid ?? entry.id;
      if (seen.has(key)) continue;
      seen.add(key);
      if (gid) {
        const groupIds = sameEval
          .filter((h) => (h.data as EvalResultData).metadata?.runGroupId === gid)
          .map((h) => h.id);
        distinct.push({ id: groupIds[0], groupIds });
      } else {
        distinct.push({ id: entry.id });
      }
      if (distinct.length >= 2) break;
    }
    if (distinct.length >= 2) {
      setCandidateSelection(distinct[0]);
      setBaselineSelection(distinct[1]);
    }
  }, [history, baselineSelection, candidateSelection]);

  const selectedMeta = evals.find((e: RegisteredEval) => e.name === selectedEval);

  // Multi-run derived state
  const multiRun = currentResult?._multiRun;
  const isAggregateView = multiRun != null && multiRunIndex === -1;
  const displayResult =
    multiRun && multiRunIndex >= 0 ? multiRun.allRuns[multiRunIndex] : currentResult;

  // Reset selected item when switching between runs
  useEffect(() => {
    setSelectedItem(null);
  }, [multiRunIndex]);

  const handleRun = useCallback(async () => {
    if (!selectedEval) return;
    setRunning(true);
    setError(null);
    setCurrentResult(null);
    setSelectedItem(null);
    setMultiRunIndex(-1);

    try {
      const result = (await runRegisteredEval(
        selectedEval,
        runCount > 1 ? { runs: runCount } : undefined,
      )) as EvalResultData;
      setCurrentResult(result);
      queryClient.invalidateQueries({ queryKey: ['evalHistory'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [selectedEval, runCount, queryClient]);

  const handleCompare = useCallback(async () => {
    if (!baselineSelection || !candidateSelection) return;
    setComparing(true);
    setCompareResult(null);
    try {
      // Resolve data arrays from selections
      const resolveData = (sel: RunSelection) => {
        if (sel.groupIds && sel.groupIds.length > 1) {
          const entries = sel.groupIds.map((id) => history.find((h) => h.id === id));
          if (entries.some((e) => !e)) throw new Error('Selected run no longer exists in history');
          return entries.map((e) => e!.data);
        }
        const entry = history.find((h) => h.id === sel.id);
        if (!entry) throw new Error('Selected run no longer exists in history');
        return entry.data;
      };

      const baselineData = resolveData(baselineSelection);
      const candidateData = resolveData(candidateSelection);

      // For item-level views: average per-item scores across runs when pooled
      const buildRepresentative = (sel: RunSelection): EvalResultData | null => {
        const entry = history.find((h) => h.id === sel.id);
        if (!entry) return null;
        const first = entry.data as EvalResultData;
        if (!sel.groupIds || sel.groupIds.length <= 1) return first;

        // Average items across all runs in the group
        const allRuns = sel.groupIds
          .map((id) => history.find((h) => h.id === id)?.data as EvalResultData | undefined)
          .filter((d): d is EvalResultData => d != null);
        const itemCount = Math.min(...allRuns.map((r) => r.items.length));
        const scorerNames = Object.keys(first.summary?.scorers ?? {});

        const avgItems = Array.from({ length: itemCount }, (_, i) => {
          const avgScores: Record<string, number | null> = {};
          const avgDetails: Record<
            string,
            { score: number | null; metadata?: Record<string, unknown> }
          > = {};
          for (const name of scorerNames) {
            const vals = allRuns
              .map((r) => r.items[i]?.scores[name])
              .filter((s): s is number => s != null);
            const avg =
              vals.length > 0
                ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000
                : null;
            avgScores[name] = avg;
            avgDetails[name] = { score: avg };
          }
          return { ...first.items[i], scores: avgScores, scoreDetails: avgDetails };
        });

        return { ...first, items: avgItems };
      };

      setCompareBaseline(buildRepresentative(baselineSelection));
      setCompareCandidate(buildRepresentative(candidateSelection));

      // Store full run arrays for per-run item views in pooled mode
      const resolveRuns = (sel: RunSelection): EvalResultData[] | null => {
        if (!sel.groupIds || sel.groupIds.length <= 1) return null;
        return sel.groupIds
          .map((id) => history.find((h) => h.id === id)?.data as EvalResultData | undefined)
          .filter((d): d is EvalResultData => d != null);
      };
      setCompareBaselineRuns(resolveRuns(baselineSelection));
      setCompareCandidateRuns(resolveRuns(candidateSelection));

      const res = (await compareEvals(baselineData, candidateData)) as ComparisonResult;
      setCompareResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setComparing(false);
    }
  }, [history, baselineSelection, candidateSelection]);

  const handleRescore = useCallback(
    async (evalName: string, resultId: string) => {
      setError(null);
      try {
        const result = (await rescoreEval(evalName, resultId)) as EvalResultData;
        setCurrentResult(result);
        setSelectedItem(null);
        setMultiRunIndex(-1);
        setTab('run');
        queryClient.invalidateQueries({ queryKey: ['evalHistory'] });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [queryClient],
  );

  const handleToggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const scorerTypes = currentResult?.metadata?.scorerTypes as Record<string, string> | undefined;

  const scorerNames = displayResult?.summary?.scorers
    ? Object.keys(displayResult.summary.scorers)
    : [];

  // Compute overall mean score across all scorers
  const scorerEntries = displayResult?.summary?.scorers
    ? Object.entries(displayResult.summary.scorers)
    : [];
  const overallMean =
    scorerEntries.length > 0
      ? scorerEntries.reduce((sum, [, s]) => sum + s.mean, 0) / scorerEntries.length
      : 0;

  // Aggregate stats for multi-run
  // Compute overall mean as average of per-scorer means.
  // Compute overall std as std of per-run overall means (not average of per-scorer stds).
  const aggScorerEntries = multiRun ? Object.entries(multiRun.aggregate.scorers) : [];
  const aggMean =
    aggScorerEntries.length > 0
      ? aggScorerEntries.reduce((sum, [, s]) => sum + s.mean, 0) / aggScorerEntries.length
      : 0;
  const aggStd = useMemo(() => {
    if (!multiRun) return 0;
    const allRuns = multiRun.allRuns;
    const scorerNames = Object.keys(multiRun.aggregate.scorers);
    if (scorerNames.length === 0 || allRuns.length <= 1) return 0;
    // Per-run overall mean (average of all scorer means in that run)
    const perRunMeans = allRuns.map((run) => {
      const means = scorerNames
        .map((name) => run.summary?.scorers?.[name]?.mean)
        .filter((m): m is number => m != null);
      return means.length > 0 ? means.reduce((a, b) => a + b, 0) / means.length : 0;
    });
    const mean = perRunMeans.reduce((a, b) => a + b, 0) / perRunMeans.length;
    return Math.sqrt(
      perRunMeans.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (perRunMeans.length - 1),
    );
  }, [multiRun]);
  const aggTotalDuration = multiRun ? multiRun.allRuns.reduce((sum, r) => sum + r.duration, 0) : 0;
  const aggTotalCost = multiRun ? multiRun.allRuns.reduce((sum, r) => sum + r.totalCost, 0) : 0;

  // Sorted aggregate scorer entries — derive from multiRun directly for stable deps
  const sortedAggScorerEntries = useMemo(() => {
    if (!multiRun) return [];
    const entries = Object.entries(multiRun.aggregate.scorers);
    entries.sort((a, b) => {
      let aVal: number, bVal: number;
      switch (aggSortField) {
        case 'scorer':
          return aggSortDir === 'asc' ? a[0].localeCompare(b[0]) : b[0].localeCompare(a[0]);
        case 'mean':
          aVal = a[1].mean;
          bVal = b[1].mean;
          break;
        case 'std':
          aVal = a[1].std;
          bVal = b[1].std;
          break;
        case 'min':
          aVal = a[1].min;
          bVal = b[1].min;
          break;
        case 'max':
        default:
          aVal = a[1].max;
          bVal = b[1].max;
          break;
      }
      return aggSortDir === 'desc' ? bVal - aVal : aVal - bVal;
    });
    return entries;
  }, [multiRun, aggSortField, aggSortDir]);

  const toggleAggSort = (field: typeof aggSortField) => {
    if (aggSortField === field) {
      setAggSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setAggSortField(field);
      setAggSortDir(field === 'scorer' ? 'asc' : 'asc');
    }
  };

  const aggSortIndicator = (field: typeof aggSortField) =>
    aggSortField === field ? (aggSortDir === 'desc' ? ' \u25BC' : ' \u25B2') : '';

  // CV-based color for Std column (lower is better)
  const stdTextColor = (std: number, mean: number): string => {
    if (mean === 0) return 'text-[hsl(var(--muted-foreground))]';
    const cv = std / mean;
    if (cv < 0.02) return 'text-[hsl(var(--muted-foreground))]';
    if (cv <= 0.05) return 'text-amber-600 dark:text-amber-400';
    return 'text-red-600 dark:text-red-400';
  };

  const WORST_ITEMS_LIMIT = 5;

  // Worst items by average score across all scorers (from the representative currentResult)
  const worstItems = useMemo(() => {
    if (!isAggregateView || !currentResult) return [];
    const items = currentResult.items;
    const allScorerNames = Object.keys(currentResult.summary?.scorers ?? {});
    if (allScorerNames.length === 0 || items.length === 0) return [];

    const scored = items.map((item, idx) => {
      const validScores = allScorerNames
        .map((name) => item.scores[name])
        .filter((s): s is number => s != null);
      const avgScore =
        validScores.length > 0 ? validScores.reduce((a, b) => a + b, 0) / validScores.length : 1;
      return { item, index: idx, avgScore, scores: item.scores };
    });

    scored.sort((a, b) => a.avgScore - b.avgScore);
    return scored.slice(0, WORST_ITEMS_LIMIT);
  }, [isAggregateView, currentResult]);

  const tabs = ['run', 'history', 'compare'] as const;

  return (
    <div className="flex flex-col h-screen">
      {/* ── Header ─────────────────────────────────────── */}
      <header className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-[hsl(var(--border))]">
        <h2 className="text-xl font-semibold">Evals</h2>
        {evals.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={selectedEval}
              onChange={(e) => setSelectedEval(e.target.value)}
              className="px-3 py-1.5 text-sm rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] min-w-[180px]"
            >
              <option value="">Select eval…</option>
              {evals.map((e: RegisteredEval) => (
                <option key={e.name} value={e.name}>
                  {e.name}
                </option>
              ))}
            </select>
            <button
              onClick={handleRun}
              disabled={!selectedEval || running}
              className={cn(
                'inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-lg transition-all cursor-pointer',
                'bg-[hsl(var(--foreground))] text-[hsl(var(--background))]',
                'hover:opacity-90 disabled:opacity-40',
              )}
            >
              <Play size={12} className={running ? 'animate-spin' : ''} />
              {running ? 'Running\u2026' : 'Run'}
            </button>
            <input
              type="number"
              min={1}
              max={25}
              value={runCount}
              onChange={(e) =>
                setRunCount(Math.max(1, Math.min(25, parseInt(e.target.value) || 1)))
              }
              className="w-14 px-2 py-1.5 text-sm text-center rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
              title="Number of runs"
            />
          </div>
        )}
      </header>

      {/* ── Tabs ───────────────────────────────────────── */}
      <div
        role="tablist"
        className="shrink-0 flex items-center gap-1 px-6 border-b border-[hsl(var(--border))]"
      >
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'px-3 py-2.5 text-sm -mb-px border-b-2 transition-colors cursor-pointer',
              tab === t
                ? 'border-[hsl(var(--foreground))] text-[hsl(var(--foreground))] font-medium'
                : 'border-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]',
            )}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}

        {/* Eval metadata chips — visible when an eval is selected */}
        {selectedMeta && tab === 'run' && (
          <div className="ml-auto flex items-center gap-2 py-2">
            <span className="text-[10px] text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
              {selectedMeta.workflow}
            </span>
            <span className="text-[hsl(var(--border))]">/</span>
            <span className="text-[10px] text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
              {selectedMeta.dataset}
            </span>
            <span className="text-[hsl(var(--border))]">/</span>
            <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
              {selectedMeta.scorers.length} scorer{selectedMeta.scorers.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>

      {/* ── Run Tab ─────────────────────────────────────── */}
      {tab === 'run' && (
        <div className="flex-1 min-h-0 flex flex-col">
          {evals.length === 0 ? (
            <div className="flex-1 flex items-center justify-center p-6">
              <EmptyState
                icon={<FlaskConical size={32} />}
                title="No evals registered"
                description="Define evals with defineEval() and load them via the evals middleware option or runtime.registerEval()."
              />
            </div>
          ) : error ? (
            <div className="p-6">
              <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
                {error}
              </div>
            </div>
          ) : currentResult ? (
            <>
              {/* Back to History link */}
              {previousTab === 'history' && (
                <div className="shrink-0 px-6 pt-4">
                  <button
                    onClick={() => {
                      setTab('history');
                      setPreviousTab(null);
                    }}
                    className="inline-flex items-center gap-1.5 text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors cursor-pointer"
                  >
                    <ArrowLeft size={14} />
                    Back to History
                  </button>
                </div>
              )}

              {/* Multi-run switcher */}
              {multiRun && (
                <div className="shrink-0 pt-4">
                  <EvalMultiRunSwitcher
                    currentIndex={multiRunIndex}
                    totalRuns={multiRun.allRuns.length}
                    aggregate={multiRun.aggregate}
                    onIndexChange={setMultiRunIndex}
                  />
                </div>
              )}

              {isAggregateView ? (
                <>
                  {/* Aggregate stat cards + compare button */}
                  <div className="shrink-0 px-6 py-4">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        {(() => {
                          const models = currentResult ? getResultModels(currentResult) : [];
                          if (models.length === 0) return null;
                          const counts = currentResult ? getResultModelCounts(currentResult) : null;
                          return (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                                {models.length > 1 ? 'Models' : 'Model'}
                              </span>
                              {models.map((m) => (
                                <span
                                  key={m}
                                  className="px-1.5 py-0.5 rounded bg-[hsl(var(--secondary))] text-[hsl(var(--foreground))] text-[10px] font-mono font-medium"
                                  title={counts ? `${m} — ${counts[m]} calls` : m}
                                >
                                  {formatModelName(m)}
                                  {counts && counts[m] != null && (
                                    <span className="ml-1 text-[hsl(var(--muted-foreground))] font-normal">
                                      ({counts[m]})
                                    </span>
                                  )}
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                      <button
                        onClick={() => {
                          const runGroupId = currentResult?.metadata?.runGroupId as
                            | string
                            | undefined;
                          if (runGroupId) {
                            const groupIds = history
                              .filter(
                                (h) =>
                                  (h.data as EvalResultData).metadata?.runGroupId === runGroupId,
                              )
                              .map((h) => h.id);
                            if (groupIds.length > 0) {
                              setCandidateSelection({ id: groupIds[0], groupIds });
                            }
                          } else if (currentResult) {
                            const entry = history.find((h) => h.id === currentResult.id);
                            if (entry) {
                              setCandidateSelection({ id: entry.id });
                            }
                          }
                          setTab('compare');
                        }}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg border border-[hsl(var(--input))] hover:bg-[hsl(var(--accent))] transition-colors cursor-pointer"
                      >
                        Compare with previous...
                      </button>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                      <StatCard
                        label="Runs"
                        value={String(multiRun!.aggregate.runCount)}
                        subtitle="individual runs"
                      />
                      <StatCard
                        label="Mean Score"
                        value={aggScorerEntries.length > 0 ? aggMean.toFixed(3) : '\u2014'}
                        accent={aggScorerEntries.length > 0 ? scoreTextColor(aggMean) : undefined}
                        tint={aggScorerEntries.length > 0 ? scoreBgTint(aggMean) : undefined}
                        subtitle={
                          aggScorerEntries.length > 0
                            ? `\u00b1 ${aggStd.toFixed(3)} across runs`
                            : 'across all scorers'
                        }
                      />
                      <StatCard
                        label="Total Duration"
                        value={aggTotalDuration > 0 ? formatDuration(aggTotalDuration) : '\u2014'}
                        subtitle="all runs combined"
                      />
                      <StatCard
                        label="Total Cost"
                        value={aggTotalCost > 0 ? formatCost(aggTotalCost) : '\u2014'}
                        subtitle="all runs combined"
                      />
                      {(() => {
                        const allRuns = multiRun!.allRuns;
                        const totals = { input: 0, output: 0, reasoning: 0 };
                        for (const run of allRuns) {
                          const t = getResultTokens(run);
                          totals.input += t.input;
                          totals.output += t.output;
                          totals.reasoning += t.reasoning;
                        }
                        const totalTokens = totals.input + totals.output + totals.reasoning;
                        return totalTokens > 0 ? (
                          <StatCard
                            label="Total Tokens"
                            value={formatTokens(totalTokens)}
                            subtitle={`${formatTokens(totals.input)} in / ${formatTokens(totals.output)} out`}
                          />
                        ) : null;
                      })()}
                    </div>
                  </div>

                  {/* Per-scorer aggregate table */}
                  <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">
                    <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
                      <div className="px-4 py-2.5 bg-[hsl(var(--muted))] border-b border-[hsl(var(--border))]">
                        <h3 className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                          Per-Scorer Aggregate
                        </h3>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-[hsl(var(--border))]">
                              <th
                                className="text-left px-4 py-2 font-medium w-48 cursor-pointer select-none hover:text-[hsl(var(--foreground))]"
                                onClick={() => toggleAggSort('scorer')}
                              >
                                Scorer{aggSortIndicator('scorer')}
                              </th>
                              <th
                                className="text-right px-3 py-2 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))]"
                                onClick={() => toggleAggSort('mean')}
                              >
                                Mean{aggSortIndicator('mean')}
                              </th>
                              <th
                                className="text-right px-3 py-2 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))]"
                                onClick={() => toggleAggSort('std')}
                              >
                                Std{aggSortIndicator('std')}
                              </th>
                              <th
                                className="text-right px-3 py-2 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))]"
                                onClick={() => toggleAggSort('min')}
                              >
                                Min{aggSortIndicator('min')}
                              </th>
                              <th
                                className="text-right px-3 py-2 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))]"
                                onClick={() => toggleAggSort('max')}
                              >
                                Max{aggSortIndicator('max')}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedAggScorerEntries.map(([name, s]) => (
                              <tr
                                key={name}
                                className="border-b border-[hsl(var(--border))] last:border-b-0"
                              >
                                <td className="px-4 py-2.5 font-mono">
                                  {name}
                                  {scorerTypes?.[name] === 'llm' && (
                                    <span
                                      className="ml-1.5 px-1 py-0.5 text-[9px] font-medium rounded bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400 align-middle"
                                      title="LLM scorer — scores may vary between runs"
                                    >
                                      LLM
                                    </span>
                                  )}
                                </td>
                                <td
                                  className={cn(
                                    'px-3 py-2.5 text-right font-mono font-medium',
                                    scoreTextColor(s.mean),
                                  )}
                                >
                                  {s.mean.toFixed(3)}
                                </td>
                                <td
                                  className={cn(
                                    'px-3 py-2.5 text-right font-mono',
                                    stdTextColor(s.std, s.mean),
                                  )}
                                >
                                  {s.std.toFixed(3)}
                                </td>
                                <td
                                  className={cn(
                                    'px-3 py-2.5 text-right font-mono',
                                    scoreTextColor(s.min),
                                  )}
                                >
                                  {s.min.toFixed(3)}
                                </td>
                                <td
                                  className={cn(
                                    'px-3 py-2.5 text-right font-mono',
                                    scoreTextColor(s.max),
                                  )}
                                >
                                  {s.max.toFixed(3)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Worst items summary */}
                    {worstItems.length > 0 && (
                      <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
                        <div className="px-4 py-2.5 bg-[hsl(var(--muted))] border-b border-[hsl(var(--border))]">
                          <h3 className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                            Lowest Scoring Items
                          </h3>
                        </div>
                        <div className="divide-y divide-[hsl(var(--border))]">
                          {worstItems.map(({ item, index, avgScore, scores }) => {
                            const isExpanded = expandedWorstItem === index;
                            const allRuns = multiRun?.allRuns;
                            const totalRunCount = allRuns?.length ?? 0;
                            const runItem =
                              isExpanded && allRuns ? allRuns[worstItemRunIdx]?.items[index] : null;

                            return (
                              <div key={index}>
                                <button
                                  onClick={() => {
                                    setExpandedWorstItem(isExpanded ? null : index);
                                    setWorstItemRunIdx(0);
                                  }}
                                  className={cn(
                                    'w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-[hsl(var(--accent))] transition-colors cursor-pointer',
                                    isExpanded && 'bg-[hsl(var(--accent))]',
                                  )}
                                >
                                  <span className="shrink-0 text-[10px] font-mono text-[hsl(var(--muted-foreground))] w-6 text-right">
                                    #{index + 1}
                                  </span>
                                  <div className="flex-1 min-w-0">
                                    <div className="text-xs truncate">
                                      {extractLabel(item.input, 60)}
                                    </div>
                                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                                      {Object.entries(scores).map(([name, score]) =>
                                        score != null ? (
                                          <span
                                            key={name}
                                            className={cn(
                                              'inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono',
                                              scoreColorClass(score),
                                            )}
                                            title={name}
                                          >
                                            {name}: {score.toFixed(2)}
                                          </span>
                                        ) : null,
                                      )}
                                    </div>
                                  </div>
                                  <span
                                    className={cn(
                                      'shrink-0 text-xs font-mono font-medium',
                                      scoreTextColor(avgScore),
                                    )}
                                  >
                                    {avgScore.toFixed(3)}
                                  </span>
                                </button>

                                {/* Expanded: per-run detail */}
                                {isExpanded && (
                                  <div className="border-t border-[hsl(var(--border))] bg-[hsl(var(--card))] text-xs">
                                    {/* Run switcher */}
                                    {totalRunCount > 1 && (
                                      <div className="flex items-center gap-2 px-4 py-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))]">
                                        <span className="text-[10px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                                          Run
                                        </span>
                                        <div className="flex items-center gap-0.5">
                                          {Array.from({ length: totalRunCount }, (_, ri) => (
                                            <button
                                              key={ri}
                                              onClick={() => setWorstItemRunIdx(ri)}
                                              className={cn(
                                                'px-2 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer',
                                                ri === worstItemRunIdx
                                                  ? 'bg-[hsl(var(--foreground))] text-[hsl(var(--background))]'
                                                  : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]',
                                              )}
                                            >
                                              {ri + 1}
                                            </button>
                                          ))}
                                        </div>
                                      </div>
                                    )}

                                    {/* Item content */}
                                    <div className="p-4 space-y-3">
                                      {/* Per-scorer scores for this run */}
                                      {runItem && (
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                          {Object.entries(runItem.scores).map(([name, score]) =>
                                            score != null ? (
                                              <span
                                                key={name}
                                                className={cn(
                                                  'inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono',
                                                  scoreColorClass(score),
                                                )}
                                              >
                                                {name}: {score.toFixed(3)}
                                              </span>
                                            ) : null,
                                          )}
                                        </div>
                                      )}

                                      {/* Output */}
                                      <div>
                                        <span className="font-medium text-[hsl(var(--muted-foreground))] text-[10px] uppercase tracking-wider block mb-1">
                                          Output
                                        </span>
                                        <JsonViewer
                                          data={runItem?.output ?? item.output}
                                          collapsed
                                        />
                                      </div>

                                      {/* Reasoning from each scorer */}
                                      {runItem?.scoreDetails &&
                                        Object.entries(runItem.scoreDetails).map(
                                          ([name, detail]) => {
                                            const reasoning =
                                              typeof detail?.metadata?.reasoning === 'string'
                                                ? detail.metadata.reasoning
                                                : null;
                                            if (!reasoning) return null;
                                            return (
                                              <div key={name}>
                                                <span className="font-medium text-[hsl(var(--muted-foreground))] text-[10px] uppercase tracking-wider block mb-1">
                                                  {name} reasoning
                                                </span>
                                                <pre className="text-xs font-mono p-2 rounded-md bg-[hsl(var(--secondary))] overflow-auto max-h-32 whitespace-pre-wrap leading-relaxed">
                                                  {reasoning}
                                                </pre>
                                              </div>
                                            );
                                          },
                                        )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              ) : displayResult ? (
                <>
                  {/* Stat cards */}
                  <div className="shrink-0 px-6 py-4">
                    {/* Model badges */}
                    {(() => {
                      const models = getResultModels(displayResult);
                      if (models.length === 0) return null;
                      const counts = getResultModelCounts(displayResult);
                      return (
                        <div className="flex items-center gap-2 mb-3">
                          <span className="text-[10px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                            {models.length > 1 ? 'Models' : 'Model'}
                          </span>
                          {models.map((m) => (
                            <span
                              key={m}
                              className="px-1.5 py-0.5 rounded bg-[hsl(var(--secondary))] text-[hsl(var(--foreground))] text-[10px] font-mono font-medium"
                              title={counts ? `${m} — ${counts[m]} calls` : m}
                            >
                              {formatModelName(m)}
                              {counts && counts[m] != null && (
                                <span className="ml-1 text-[hsl(var(--muted-foreground))] font-normal">
                                  ({counts[m]})
                                </span>
                              )}
                            </span>
                          ))}
                        </div>
                      );
                    })()}
                    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                      <StatCard
                        label="Items"
                        value={String(displayResult.summary.count)}
                        subtitle={
                          displayResult.summary.failures > 0
                            ? `${displayResult.summary.failures} failed`
                            : 'all passed'
                        }
                        subtitleColor={
                          displayResult.summary.failures > 0
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-emerald-600 dark:text-emerald-400'
                        }
                      />
                      <StatCard
                        label="Mean Score"
                        value={scorerEntries.length > 0 ? overallMean.toFixed(3) : '\u2014'}
                        accent={scorerEntries.length > 0 ? scoreTextColor(overallMean) : undefined}
                        tint={scorerEntries.length > 0 ? scoreBgTint(overallMean) : undefined}
                        subtitle="across all scorers"
                      />
                      <StatCard
                        label="Duration"
                        value={
                          displayResult.summary.timing
                            ? formatDuration(displayResult.summary.timing.mean)
                            : formatDuration(displayResult.duration)
                        }
                        subtitle={
                          displayResult.summary.timing
                            ? `p95 ${formatDuration(displayResult.summary.timing.p95)}`
                            : 'total'
                        }
                      />
                      <StatCard
                        label="Cost"
                        value={
                          displayResult.totalCost > 0
                            ? formatCost(displayResult.totalCost)
                            : '\u2014'
                        }
                        subtitle="total"
                      />
                      {(() => {
                        const tokens = getResultTokens(displayResult);
                        const totalTokens = tokens.input + tokens.output + tokens.reasoning;
                        return totalTokens > 0 ? (
                          <StatCard
                            label="Tokens"
                            value={formatTokens(totalTokens)}
                            subtitle={`${formatTokens(tokens.input)} in / ${formatTokens(tokens.output)} out`}
                          />
                        ) : null;
                      })()}
                    </div>
                  </div>

                  {/* Master-detail split */}
                  <div className="flex flex-1 min-h-0 border-t border-[hsl(var(--border))]">
                    {/* Left panel: compact item list */}
                    <div className="w-[340px] xl:w-[380px] shrink-0 border-r border-[hsl(var(--border))] bg-[hsl(var(--card))]">
                      <EvalItemSidebar
                        items={displayResult.items}
                        scorerNames={scorerNames}
                        selectedIndex={selectedItem}
                        onSelectItem={setSelectedItem}
                        onDeselectItem={() => setSelectedItem(null)}
                      />
                    </div>

                    {/* Right panel: overview or detail */}
                    <div className="flex-1 overflow-y-auto">
                      {selectedItem != null ? (
                        <div className="p-6">
                          <EvalItemDetail
                            item={displayResult.items[selectedItem]}
                            itemIndex={selectedItem}
                            scorerNames={scorerNames}
                            onBack={() => setSelectedItem(null)}
                          />
                        </div>
                      ) : (
                        <div className="p-6 space-y-6">
                          <EvalSummaryTable
                            summary={displayResult.summary}
                            items={displayResult.items}
                            totalCost={displayResult.totalCost}
                            scorerTypes={scorerTypes}
                          />

                          <ScoreDistribution
                            items={displayResult.items}
                            scorerNames={scorerNames}
                          />

                          {displayResult.items.length > 0 && (
                            <EvalItemList
                              items={displayResult.items}
                              scorerNames={scorerNames}
                              onSelectItem={setSelectedItem}
                              errorFilter={errorFilter}
                              onErrorFilterChange={setErrorFilter}
                              scorerFilter={scorerFilter}
                              onScorerFilterChange={setScorerFilter}
                              threshold={threshold}
                              onThresholdChange={setThreshold}
                              sortField={sortField}
                              onSortFieldChange={setSortField}
                              sortDir={sortDir}
                              onSortDirChange={setSortDir}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              ) : null}
            </>
          ) : running ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4">
              <div className="relative">
                <FlaskConical size={28} className="text-[hsl(var(--muted-foreground))]" />
                <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping" />
                <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium">Running evaluation…</p>
                <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
                  {selectedMeta
                    ? `${selectedMeta.dataset} \u00b7 ${selectedMeta.scorers.length} scorers`
                    : selectedEval}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <EmptyState
                icon={<FlaskConical size={32} />}
                title="No results"
                description="Select an eval and run it to see results."
              />
            </div>
          )}
        </div>
      )}

      {/* ── History Tab ──────────────────────────────────── */}
      {tab === 'history' && (
        <div className="flex-1 overflow-auto p-6">
          {history.length === 0 ? (
            <EmptyState title="No eval history" description="Run evaluations to build history." />
          ) : (
            <EvalHistoryTable
              history={history}
              evalFilter={historyEvalFilter}
              onEvalFilterChange={setHistoryEvalFilter}
              onSelect={(data) => {
                setCurrentResult(data);
                setSelectedItem(null);
                setMultiRunIndex(-1);
                setPreviousTab('history');
                setTab('run');
              }}
              onSelectGroup={(entries) => {
                const allRuns = entries.map((e) => e.data as EvalResultData);
                const first = allRuns[0];
                const scorerNames = Object.keys(first.summary?.scorers ?? {});
                // Compute aggregate: mean/std/min/max of per-scorer means across runs
                const aggScorers: Record<
                  string,
                  { mean: number; std: number; min: number; max: number }
                > = {};
                for (const name of scorerNames) {
                  const means = allRuns.map((r) => r.summary?.scorers?.[name]?.mean ?? 0);
                  const mean = means.reduce((a, b) => a + b, 0) / means.length;
                  const std =
                    means.length > 1
                      ? Math.sqrt(
                          means.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (means.length - 1),
                        )
                      : 0;
                  aggScorers[name] = {
                    mean: Math.round(mean * 1000) / 1000,
                    std: Math.round(std * 1000) / 1000,
                    min: Math.round(Math.min(...means) * 1000) / 1000,
                    max: Math.round(Math.max(...means) * 1000) / 1000,
                  };
                }
                const aggregate = {
                  runGroupId: (first.metadata?.runGroupId as string) ?? '',
                  runCount: allRuns.length,
                  scorers: aggScorers,
                };
                const enriched = { ...first, _multiRun: { aggregate, allRuns } } as EvalResultData;
                setCurrentResult(enriched);
                setSelectedItem(null);
                setMultiRunIndex(-1);
                setPreviousTab('history');
                setTab('run');
              }}
              onRescore={handleRescore}
              expandedGroups={expandedGroups}
              onToggleGroup={handleToggleGroup}
            />
          )}
        </div>
      )}

      {/* ── Compare Tab ──────────────────────────────────── */}
      {tab === 'compare' && (
        <div className="flex-1 overflow-auto p-6">
          <div className="space-y-4">
            {history.length < 2 ? (
              <EmptyState
                title="Need at least 2 eval runs"
                description="Run evaluations to compare results."
              />
            ) : (
              <>
                <EvalCompareRunPicker
                  history={history}
                  baselineSelection={baselineSelection}
                  candidateSelection={candidateSelection}
                  onBaselineChange={setBaselineSelection}
                  onCandidateChange={setCandidateSelection}
                  onCompare={handleCompare}
                  comparing={comparing}
                />
                {compareResult && (
                  <EvalCompareView
                    compareResult={compareResult}
                    baseline={compareBaseline}
                    candidate={compareCandidate}
                    isGroupComparison={
                      (baselineSelection?.groupIds?.length ?? 0) > 1 ||
                      (candidateSelection?.groupIds?.length ?? 0) > 1
                    }
                    baselineRuns={compareBaselineRuns}
                    candidateRuns={compareCandidateRuns}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
