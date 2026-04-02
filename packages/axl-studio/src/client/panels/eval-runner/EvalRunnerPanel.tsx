import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Play } from 'lucide-react';
import { EmptyState } from '../../components/shared/EmptyState';
import { fetchEvals, fetchEvalHistory, runRegisteredEval, compareEvals } from '../../lib/api';
import { cn, formatCost, formatDuration } from '../../lib/utils';
import type { RegisteredEval, EvalHistoryEntry } from '../../lib/types';
import type { EvalResultData, ComparisonResult } from './types';
import { scoreTextColor, scoreBgTint } from './types';
import { EvalSummaryTable } from './EvalSummaryTable';
import { EvalItemList } from './EvalItemList';
import { EvalItemDetail } from './EvalItemDetail';
import { EvalItemSidebar } from './EvalItemSidebar';
import { ScoreDistribution } from './ScoreDistribution';
import { EvalCompareView } from './EvalCompareView';
import { StatCard } from '../../components/shared/StatCard';

export function EvalRunnerPanel() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'run' | 'history' | 'compare'>('run');
  const [selectedEval, setSelectedEval] = useState('');
  const [running, setRunning] = useState(false);
  const [currentResult, setCurrentResult] = useState<EvalResultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<number | null>(null);

  // EvalItemList filter/sort state (lifted so it survives navigate-back from detail view)
  const [errorFilter, setErrorFilter] = useState<'all' | 'errors' | 'no-errors'>('all');
  const [scorerFilter, setScorerFilter] = useState('');
  const [threshold, setThreshold] = useState('');
  const [sortField, setSortField] = useState<string>('index');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // History filter
  const [historyEvalFilter, setHistoryEvalFilter] = useState('');

  // Compare state
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<ComparisonResult | null>(null);
  const [compareBaseline, setCompareBaseline] = useState<EvalResultData | null>(null);
  const [compareCandidate, setCompareCandidate] = useState<EvalResultData | null>(null);

  const { data: evals = [] } = useQuery({
    queryKey: ['evals'],
    queryFn: fetchEvals,
  });

  const { data: history = [] } = useQuery({
    queryKey: ['evalHistory'],
    queryFn: fetchEvalHistory,
  });

  const selectedMeta = evals.find((e: RegisteredEval) => e.name === selectedEval);

  const handleRun = useCallback(async () => {
    if (!selectedEval) return;
    setRunning(true);
    setError(null);
    setCurrentResult(null);
    setSelectedItem(null);

    try {
      const result = (await runRegisteredEval(selectedEval)) as EvalResultData;
      setCurrentResult(result);
      queryClient.invalidateQueries({ queryKey: ['evalHistory'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [selectedEval, queryClient]);

  const handleCompare = useCallback(async () => {
    if (history.length < 2) return;
    const firstEval = history[0].eval;
    const sameEval = history.filter((h) => h.eval === firstEval);
    if (sameEval.length < 2) return;
    setComparing(true);
    try {
      const candidateData = sameEval[0].data as EvalResultData;
      const baselineData = sameEval[1].data as EvalResultData;
      setCompareBaseline(baselineData);
      setCompareCandidate(candidateData);
      const res = (await compareEvals(baselineData, candidateData)) as ComparisonResult;
      setCompareResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setComparing(false);
    }
  }, [history]);

  const scorerNames = currentResult?.summary?.scorers
    ? Object.keys(currentResult.summary.scorers)
    : [];

  // Compute overall mean score across all scorers
  const scorerEntries = currentResult?.summary?.scorers
    ? Object.entries(currentResult.summary.scorers)
    : [];
  const overallMean =
    scorerEntries.length > 0
      ? scorerEntries.reduce((sum, [, s]) => sum + s.mean, 0) / scorerEntries.length
      : 0;

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
                'inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-lg transition-all',
                'bg-[hsl(var(--foreground))] text-[hsl(var(--background))]',
                'hover:opacity-90 disabled:opacity-40',
              )}
            >
              <Play size={12} className={running ? 'animate-spin' : ''} />
              {running ? 'Running\u2026' : 'Run'}
            </button>
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
              'px-3 py-2.5 text-sm -mb-px border-b-2 transition-colors',
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
              {/* Stat cards */}
              <div className="shrink-0 px-6 py-4">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <StatCard
                    label="Items"
                    value={String(currentResult.summary.count)}
                    subtitle={
                      currentResult.summary.failures > 0
                        ? `${currentResult.summary.failures} failed`
                        : 'all passed'
                    }
                    subtitleColor={
                      currentResult.summary.failures > 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-emerald-600 dark:text-emerald-400'
                    }
                  />
                  <StatCard
                    label="Mean Score"
                    value={scorerEntries.length > 0 ? overallMean.toFixed(3) : '—'}
                    accent={scorerEntries.length > 0 ? scoreTextColor(overallMean) : undefined}
                    tint={scorerEntries.length > 0 ? scoreBgTint(overallMean) : undefined}
                    subtitle="across all scorers"
                  />
                  <StatCard
                    label="Duration"
                    value={
                      currentResult.summary.timing
                        ? formatDuration(currentResult.summary.timing.mean)
                        : formatDuration(currentResult.duration)
                    }
                    subtitle={
                      currentResult.summary.timing
                        ? `p95 ${formatDuration(currentResult.summary.timing.p95)}`
                        : 'total'
                    }
                  />
                  <StatCard
                    label="Cost"
                    value={
                      currentResult.totalCost > 0 ? formatCost(currentResult.totalCost) : '\u2014'
                    }
                    subtitle="total"
                  />
                </div>
              </div>

              {/* Master-detail split */}
              <div className="flex flex-1 min-h-0 border-t border-[hsl(var(--border))]">
                {/* Left panel: compact item list */}
                <div className="w-[340px] xl:w-[380px] shrink-0 border-r border-[hsl(var(--border))] bg-[hsl(var(--card))]">
                  <EvalItemSidebar
                    items={currentResult.items}
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
                        item={currentResult.items[selectedItem]}
                        itemIndex={selectedItem}
                        scorerNames={scorerNames}
                        onBack={() => setSelectedItem(null)}
                      />
                    </div>
                  ) : (
                    <div className="p-6 space-y-6">
                      <EvalSummaryTable
                        summary={currentResult.summary}
                        items={currentResult.items}
                        totalCost={currentResult.totalCost}
                      />

                      <ScoreDistribution items={currentResult.items} scorerNames={scorerNames} />

                      {currentResult.items.length > 0 && (
                        <EvalItemList
                          items={currentResult.items}
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
            <HistoryTable
              history={history}
              evalFilter={historyEvalFilter}
              onEvalFilterChange={setHistoryEvalFilter}
              onSelect={(data) => {
                setCurrentResult(data);
                setSelectedItem(null);
                setTab('run');
              }}
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
                <div className="flex items-center gap-3">
                  <p className="text-sm text-[hsl(var(--muted-foreground))]">
                    Comparing most recent run against previous run.
                  </p>
                  <button
                    onClick={handleCompare}
                    disabled={comparing}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-[hsl(var(--foreground))] text-[hsl(var(--background))] hover:opacity-90 disabled:opacity-50"
                  >
                    {comparing ? 'Comparing\u2026' : 'Compare'}
                  </button>
                </div>
                {compareResult && (
                  <EvalCompareView
                    compareResult={compareResult}
                    baseline={compareBaseline}
                    candidate={compareCandidate}
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

// ── History table ──────────────────────────────────────────────

function HistoryTable({
  history,
  evalFilter,
  onEvalFilterChange,
  onSelect,
}: {
  history: EvalHistoryEntry[];
  evalFilter: string;
  onEvalFilterChange: (value: string) => void;
  onSelect: (data: EvalResultData) => void;
}) {
  const evalNames = [...new Set(history.map((h) => h.eval))].sort();
  const filtered = evalFilter ? history.filter((h) => h.eval === evalFilter) : history;

  const allScorerNames = new Set<string>();
  for (const entry of filtered) {
    const data = entry.data as EvalResultData;
    if (data.summary?.scorers) {
      for (const name of Object.keys(data.summary.scorers)) {
        allScorerNames.add(name);
      }
    }
  }
  const scorerCols = [...allScorerNames].sort();

  return (
    <div>
      {evalNames.length > 1 && (
        <div className="flex items-center gap-2 mb-4">
          <select
            value={evalFilter}
            onChange={(e) => onEvalFilterChange(e.target.value)}
            className="px-2 py-1 text-xs rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
          >
            <option value="">All evals</option>
            {evalNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {evalFilter && (
            <span className="text-xs text-[hsl(var(--muted-foreground))]">
              {filtered.length} run{filtered.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}

      <div className="border border-[hsl(var(--border))] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[hsl(var(--muted))]">
                <th className="text-left px-3 py-2.5 font-medium">Eval</th>
                <th className="text-left px-3 py-2.5 font-medium">Timestamp</th>
                <th className="text-right px-3 py-2.5 font-medium">Items</th>
                <th className="text-right px-3 py-2.5 font-medium">Failures</th>
                <th className="text-right px-3 py-2.5 font-medium">Duration</th>
                <th className="text-right px-3 py-2.5 font-medium">Cost</th>
                {scorerCols.map((name) => (
                  <th
                    key={name}
                    className="text-right px-3 py-2.5 font-medium font-mono max-w-20 truncate"
                    title={name}
                  >
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r: EvalHistoryEntry, idx: number) => {
                const data = r.data as EvalResultData;
                return (
                  <tr
                    key={r.id}
                    className={cn(
                      'border-t border-[hsl(var(--border))] cursor-pointer hover:bg-[hsl(var(--accent))] transition-colors',
                      idx === 0 && 'bg-[hsl(var(--accent))]/30',
                    )}
                    onClick={() => onSelect(data)}
                  >
                    <td className="px-3 py-2.5 font-mono">{r.eval}</td>
                    <td className="px-3 py-2.5 text-[hsl(var(--muted-foreground))]">
                      {new Date(r.timestamp).toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">{data.summary.count}</td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {data.summary.failures > 0 ? (
                        <span className="text-red-600 dark:text-red-400">
                          {data.summary.failures}
                        </span>
                      ) : (
                        <span className="text-[hsl(var(--muted-foreground))]">0</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                      {data.duration > 0 ? formatDuration(data.duration) : '-'}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                      {data.totalCost > 0 ? formatCost(data.totalCost) : '-'}
                    </td>
                    {scorerCols.map((name) => {
                      const stats = data.summary?.scorers?.[name];
                      return (
                        <td key={name} className="px-3 py-2.5 text-right font-mono">
                          {stats ? (
                            <span className={scoreTextColor(stats.mean)}>
                              {stats.mean.toFixed(3)}
                            </span>
                          ) : (
                            <span className="text-[hsl(var(--muted-foreground))]">-</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
