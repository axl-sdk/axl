import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { PanelShell } from '../../components/layout/PanelShell';
import { EmptyState } from '../../components/shared/EmptyState';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { fetchEvals, fetchEvalHistory, runRegisteredEval, compareEvals } from '../../lib/api';
import type { RegisteredEval, EvalHistoryEntry } from '../../lib/types';

// ── Types matching @axlsdk/eval's EvalResult shape ───────────────

type EvalItem = {
  input: unknown;
  annotations?: unknown;
  output: unknown;
  error?: string;
  scores: Record<string, number>;
};

type ScorerStats = {
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
};

type EvalResultData = {
  id: string;
  workflow: string;
  dataset: string;
  timestamp: string;
  totalCost: number;
  duration: number;
  items: EvalItem[];
  summary: {
    count: number;
    failures: number;
    scorers: Record<string, ScorerStats>;
  };
};

type ComparisonResult = {
  regressions?: Array<{ scorer: string; delta: number; baseline: number; candidate: number }>;
  improvements?: Array<{ scorer: string; delta: number; baseline: number; candidate: number }>;
  scorers?: Record<
    string,
    { baselineMean: number; candidateMean: number; delta: number; deltaPercent: number }
  >;
  summary?: string;
  [key: string]: unknown;
};

export function EvalRunnerPanel() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'run' | 'history' | 'compare'>('run');
  const [selectedEval, setSelectedEval] = useState('');
  const [running, setRunning] = useState(false);
  const [currentResult, setCurrentResult] = useState<EvalResultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compareResult, setCompareResult] = useState<ComparisonResult | null>(null);

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

    try {
      const result = (await runRegisteredEval(selectedEval)) as EvalResultData;
      setCurrentResult(result);
      // Refresh server-side history
      queryClient.invalidateQueries({ queryKey: ['evalHistory'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [selectedEval, queryClient]);

  const handleCompare = useCallback(async () => {
    if (history.length < 2) return;
    try {
      const baseline = history[1].data as EvalResultData;
      const candidate = history[0].data as EvalResultData;
      const res = (await compareEvals(baseline, candidate)) as ComparisonResult;
      setCompareResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [history]);

  const scorerEntries = currentResult?.summary?.scorers
    ? Object.entries(currentResult.summary.scorers)
    : [];

  return (
    <PanelShell title="Eval Runner" description="Run evaluations, view results, and compare runs">
      {/* Tabs */}
      <div className="flex items-center gap-1 mb-6">
        {(['run', 'history', 'compare'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-sm rounded-md ${
              tab === t
                ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                : 'border border-[hsl(var(--input))] hover:bg-[hsl(var(--accent))]'
            }`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'run' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Eval</label>
              {evals.length === 0 ? (
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  No evals registered. Define evals with{' '}
                  <code className="text-xs bg-[hsl(var(--muted))] px-1 py-0.5 rounded">
                    defineEval()
                  </code>{' '}
                  and load them via the{' '}
                  <code className="text-xs bg-[hsl(var(--muted))] px-1 py-0.5 rounded">evals</code>{' '}
                  middleware option or{' '}
                  <code className="text-xs bg-[hsl(var(--muted))] px-1 py-0.5 rounded">
                    runtime.registerEval()
                  </code>
                  .
                </p>
              ) : (
                <select
                  value={selectedEval}
                  onChange={(e) => setSelectedEval(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
                >
                  <option value="">Select an eval...</option>
                  {evals.map((e: RegisteredEval) => (
                    <option key={e.name} value={e.name}>
                      {e.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Eval metadata */}
            {selectedMeta && (
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[hsl(var(--muted-foreground))]">Workflow:</span>
                  <span className="font-mono">{selectedMeta.workflow}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[hsl(var(--muted-foreground))]">Dataset:</span>
                  <span className="font-mono">{selectedMeta.dataset}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[hsl(var(--muted-foreground))]">Scorers:</span>
                  <div className="flex flex-wrap gap-1">
                    {selectedMeta.scorers.map((s) => (
                      <span
                        key={s}
                        className="px-1.5 py-0.5 rounded bg-[hsl(var(--muted))] font-mono"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <button
              onClick={handleRun}
              disabled={!selectedEval || running}
              className="px-4 py-2 text-sm font-medium rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
            >
              {running ? 'Running...' : 'Run Eval'}
            </button>
          </div>

          <div>
            {error && (
              <div className="p-3 rounded-md bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm mb-4">
                {error}
              </div>
            )}
            {currentResult ? (
              <div className="space-y-4">
                {/* Run metadata */}
                <div className="flex items-center gap-4 text-xs text-[hsl(var(--muted-foreground))]">
                  <span>
                    {currentResult.summary.count} items, {currentResult.summary.failures} failures
                  </span>
                  {currentResult.duration > 0 && (
                    <span>{(currentResult.duration / 1000).toFixed(1)}s</span>
                  )}
                  {currentResult.totalCost > 0 && (
                    <span>${currentResult.totalCost.toFixed(4)}</span>
                  )}
                </div>

                {/* Summary stats table */}
                {scorerEntries.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium mb-2">Summary</h3>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-[hsl(var(--border))]">
                          <th className="text-left py-2 font-medium">Scorer</th>
                          <th className="text-right py-2 font-medium">Mean</th>
                          <th className="text-right py-2 font-medium">P50</th>
                          <th className="text-right py-2 font-medium">P95</th>
                          <th className="text-right py-2 font-medium">Min</th>
                          <th className="text-right py-2 font-medium">Max</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scorerEntries.map(([scorer, stats]) => (
                          <tr key={scorer} className="border-b border-[hsl(var(--border))]">
                            <td className="py-2 font-mono">{scorer}</td>
                            <td className="py-2 text-right font-mono">{stats.mean.toFixed(3)}</td>
                            <td className="py-2 text-right font-mono">{stats.p50.toFixed(3)}</td>
                            <td className="py-2 text-right font-mono">{stats.p95.toFixed(3)}</td>
                            <td className="py-2 text-right font-mono">{stats.min.toFixed(3)}</td>
                            <td className="py-2 text-right font-mono">{stats.max.toFixed(3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Per-item results */}
                {currentResult.items && currentResult.items.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium mb-2">
                      Items ({currentResult.items.length})
                    </h3>
                    <div className="space-y-2">
                      {currentResult.items.map((item, i) => (
                        <details key={i} className="border border-[hsl(var(--border))] rounded-md">
                          <summary className="flex items-center justify-between px-3 py-2 text-xs cursor-pointer hover:bg-[hsl(var(--accent))]">
                            <span className="font-mono">
                              Item #{i + 1}
                              {item.error && (
                                <span className="ml-2 text-red-600 dark:text-red-400">(error)</span>
                              )}
                            </span>
                            <div className="flex items-center gap-2">
                              {Object.entries(item.scores).map(([scorer, score]) => (
                                <span
                                  key={scorer}
                                  className={`px-1.5 py-0.5 rounded font-mono ${
                                    score >= 0.8
                                      ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
                                      : score >= 0.5
                                        ? 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300'
                                        : 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300'
                                  }`}
                                >
                                  {scorer}: {score.toFixed(2)}
                                </span>
                              ))}
                            </div>
                          </summary>
                          <div className="px-3 py-2 border-t border-[hsl(var(--border))] space-y-2 text-xs">
                            <div>
                              <span className="font-medium">Input:</span>
                              <JsonViewer data={item.input} collapsed />
                            </div>
                            <div>
                              <span className="font-medium">Output:</span>
                              <JsonViewer data={item.output} collapsed />
                            </div>
                            {item.error && (
                              <div>
                                <span className="font-medium text-red-600 dark:text-red-400">
                                  Error:
                                </span>
                                <span className="ml-1">{item.error}</span>
                              </div>
                            )}
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <EmptyState
                icon={<FlaskConical size={32} />}
                title="No results"
                description="Select an eval and run it to see results."
              />
            )}
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div>
          {history.length === 0 ? (
            <EmptyState title="No eval history" description="Run evaluations to build history." />
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[hsl(var(--border))]">
                  <th className="text-left py-2 font-medium">Eval</th>
                  <th className="text-left py-2 font-medium">Timestamp</th>
                  <th className="text-right py-2 font-medium">Items</th>
                  <th className="text-right py-2 font-medium">Failures</th>
                  <th className="text-right py-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r: EvalHistoryEntry) => {
                  const data = r.data as EvalResultData;
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-[hsl(var(--border))] cursor-pointer hover:bg-[hsl(var(--accent))]"
                      onClick={() => {
                        setCurrentResult(data);
                        setTab('run');
                      }}
                    >
                      <td className="py-2 font-mono">{r.eval}</td>
                      <td className="py-2">{new Date(r.timestamp).toLocaleString()}</td>
                      <td className="py-2 text-right">{data.summary.count}</td>
                      <td className="py-2 text-right">
                        {data.summary.failures > 0 ? (
                          <span className="text-red-600 dark:text-red-400">
                            {data.summary.failures}
                          </span>
                        ) : (
                          0
                        )}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {data.totalCost > 0 ? `$${data.totalCost.toFixed(4)}` : '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'compare' && (
        <div className="space-y-4">
          {history.length < 2 ? (
            <EmptyState
              title="Need at least 2 eval runs"
              description="Run evaluations to compare results."
            />
          ) : (
            <>
              <p className="text-sm text-[hsl(var(--muted-foreground))]">
                Comparing most recent run against previous run.
              </p>
              <button
                onClick={handleCompare}
                className="px-4 py-2 text-sm font-medium rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90"
              >
                Compare
              </button>
              {compareResult && (
                <div className="space-y-4">
                  {compareResult.summary && <p className="text-sm">{compareResult.summary}</p>}
                  {compareResult.scorers && Object.keys(compareResult.scorers).length > 0 && (
                    <div>
                      <h3 className="text-sm font-medium mb-2">Scorer Comparison</h3>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-[hsl(var(--border))]">
                            <th className="text-left py-2 font-medium">Scorer</th>
                            <th className="text-right py-2 font-medium">Baseline</th>
                            <th className="text-right py-2 font-medium">Candidate</th>
                            <th className="text-right py-2 font-medium">Delta</th>
                            <th className="text-right py-2 font-medium">%</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(compareResult.scorers).map(([scorer, stats]) => (
                            <tr key={scorer} className="border-b border-[hsl(var(--border))]">
                              <td className="py-2 font-mono">{scorer}</td>
                              <td className="py-2 text-right font-mono">
                                {stats.baselineMean.toFixed(3)}
                              </td>
                              <td className="py-2 text-right font-mono">
                                {stats.candidateMean.toFixed(3)}
                              </td>
                              <td
                                className={`py-2 text-right font-mono ${
                                  stats.delta > 0
                                    ? 'text-green-600 dark:text-green-400'
                                    : stats.delta < 0
                                      ? 'text-red-600 dark:text-red-400'
                                      : ''
                                }`}
                              >
                                {stats.delta > 0 ? '+' : ''}
                                {stats.delta.toFixed(3)}
                              </td>
                              <td
                                className={`py-2 text-right font-mono ${
                                  stats.deltaPercent > 0
                                    ? 'text-green-600 dark:text-green-400'
                                    : stats.deltaPercent < 0
                                      ? 'text-red-600 dark:text-red-400'
                                      : ''
                                }`}
                              >
                                {stats.deltaPercent > 0 ? '+' : ''}
                                {stats.deltaPercent.toFixed(1)}%
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {compareResult.regressions && compareResult.regressions.length > 0 && (
                    <div>
                      <h3 className="text-sm font-medium mb-2 text-red-600 dark:text-red-400">
                        Regressions ({compareResult.regressions.length})
                      </h3>
                      <div className="space-y-1">
                        {compareResult.regressions.map((r, i) => (
                          <div
                            key={i}
                            className="flex items-center justify-between px-3 py-1.5 text-xs border border-[hsl(var(--border))] rounded"
                          >
                            <span className="font-mono">{r.scorer}</span>
                            <span className="font-mono text-red-600 dark:text-red-400">
                              {r.baseline.toFixed(2)} → {r.candidate.toFixed(2)} (
                              {r.delta.toFixed(2)})
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {compareResult.improvements && compareResult.improvements.length > 0 && (
                    <div>
                      <h3 className="text-sm font-medium mb-2 text-green-600 dark:text-green-400">
                        Improvements ({compareResult.improvements.length})
                      </h3>
                      <div className="space-y-1">
                        {compareResult.improvements.map((r, i) => (
                          <div
                            key={i}
                            className="flex items-center justify-between px-3 py-1.5 text-xs border border-[hsl(var(--border))] rounded"
                          >
                            <span className="font-mono">{r.scorer}</span>
                            <span className="font-mono text-green-600 dark:text-green-400">
                              {r.baseline.toFixed(2)} → {r.candidate.toFixed(2)} (+
                              {r.delta.toFixed(2)})
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </PanelShell>
  );
}
