import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { PanelShell } from '../../components/layout/PanelShell';
import { EmptyState } from '../../components/shared/EmptyState';
import { JsonEditor } from '../../components/shared/JsonEditor';
import { JsonViewer } from '../../components/shared/JsonViewer';
import { fetchWorkflows, runEval, compareEvals } from '../../lib/api';
import type { WorkflowSummary } from '../../lib/types';

type EvalScoreResult = {
  input: unknown;
  output: unknown;
  scores: Record<string, number>;
};

type EvalSummary = {
  items?: EvalScoreResult[];
  summary?: Record<string, { mean: number; min: number; max: number; count: number }>;
  [key: string]: unknown;
};

type EvalResult = {
  id: string;
  timestamp: number;
  workflow: string;
  data: EvalSummary;
};

type ComparisonResult = {
  regressions?: Array<{ scorer: string; delta: number; baseline: number; candidate: number }>;
  improvements?: Array<{ scorer: string; delta: number; baseline: number; candidate: number }>;
  [key: string]: unknown;
};

export function EvalRunnerPanel() {
  const [tab, setTab] = useState<'run' | 'history' | 'compare'>('run');
  const [selectedWorkflow, setSelectedWorkflow] = useState('');
  const [datasetJson, setDatasetJson] = useState('[]');
  const [scorersJson, setScorersJson] = useState('[]');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<EvalResult[]>([]);
  const [currentResult, setCurrentResult] = useState<EvalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compareResult, setCompareResult] = useState<ComparisonResult | null>(null);

  const { data: workflows = [] } = useQuery({
    queryKey: ['workflows'],
    queryFn: fetchWorkflows,
  });

  const handleRun = useCallback(async () => {
    if (!selectedWorkflow) return;
    setRunning(true);
    setError(null);
    setCurrentResult(null);

    try {
      const dataset = JSON.parse(datasetJson);
      const scorers = JSON.parse(scorersJson);
      const result = (await runEval({
        workflow: selectedWorkflow,
        dataset,
        scorers,
      })) as EvalSummary;
      setCurrentResult(result);
      setResults((prev) => [
        {
          id: `eval-${Date.now()}`,
          timestamp: Date.now(),
          workflow: selectedWorkflow,
          data: result,
        },
        ...prev,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [selectedWorkflow, datasetJson, scorersJson]);

  const handleCompare = useCallback(async () => {
    if (results.length < 2) return;
    try {
      const res = (await compareEvals(results[1].data, results[0].data)) as ComparisonResult;
      setCompareResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [results]);

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
              <label className="block text-sm font-medium mb-1">Workflow</label>
              <select
                value={selectedWorkflow}
                onChange={(e) => setSelectedWorkflow(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
              >
                <option value="">Select a workflow...</option>
                {workflows.map((w: WorkflowSummary) => (
                  <option key={w.name} value={w.name}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Dataset (JSON array)</label>
              <JsonEditor
                value={datasetJson}
                onChange={setDatasetJson}
                placeholder="[{ ... }, { ... }]"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Scorers (JSON array)</label>
              <JsonEditor value={scorersJson} onChange={setScorersJson} placeholder="[]" />
            </div>

            <button
              onClick={handleRun}
              disabled={!selectedWorkflow || running}
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
                {/* Summary stats table */}
                {currentResult.summary && Object.keys(currentResult.summary).length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium mb-2">Summary</h3>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-[hsl(var(--border))]">
                          <th className="text-left py-2 font-medium">Scorer</th>
                          <th className="text-right py-2 font-medium">Mean</th>
                          <th className="text-right py-2 font-medium">Min</th>
                          <th className="text-right py-2 font-medium">Max</th>
                          <th className="text-right py-2 font-medium">Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(currentResult.summary).map(([scorer, stats]) => (
                          <tr key={scorer} className="border-b border-[hsl(var(--border))]">
                            <td className="py-2 font-mono">{scorer}</td>
                            <td className="py-2 text-right font-mono">{stats.mean.toFixed(3)}</td>
                            <td className="py-2 text-right font-mono">{stats.min.toFixed(3)}</td>
                            <td className="py-2 text-right font-mono">{stats.max.toFixed(3)}</td>
                            <td className="py-2 text-right">{stats.count}</td>
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
                            <span className="font-mono">Item #{i + 1}</span>
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
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                )}

                {/* Fallback: raw JSON for non-standard shapes */}
                {!currentResult.summary && !currentResult.items && (
                  <div>
                    <h3 className="text-sm font-medium mb-2">Results</h3>
                    <JsonViewer data={currentResult} />
                  </div>
                )}
              </div>
            ) : (
              <EmptyState
                icon={<FlaskConical size={32} />}
                title="No results"
                description="Configure and run an eval to see results."
              />
            )}
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div>
          {results.length === 0 ? (
            <EmptyState title="No eval history" description="Run evaluations to build history." />
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[hsl(var(--border))]">
                  <th className="text-left py-2 font-medium">Workflow</th>
                  <th className="text-left py-2 font-medium">Timestamp</th>
                  <th className="text-right py-2 font-medium">Items</th>
                  <th className="text-right py-2 font-medium">Scorers</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-[hsl(var(--border))] cursor-pointer hover:bg-[hsl(var(--accent))]"
                    onClick={() => {
                      setCurrentResult(r.data);
                      setTab('run');
                    }}
                  >
                    <td className="py-2 font-mono">{r.workflow}</td>
                    <td className="py-2">{new Date(r.timestamp).toLocaleString()}</td>
                    <td className="py-2 text-right">{r.data.items?.length ?? '?'}</td>
                    <td className="py-2 text-right">
                      {r.data.summary ? Object.keys(r.data.summary).length : '?'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'compare' && (
        <div className="space-y-4">
          {results.length < 2 ? (
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
                  {compareResult.regressions && compareResult.regressions.length > 0 && (
                    <div>
                      <h3 className="text-sm font-medium mb-2 text-red-600 dark:text-red-400">
                        Regressions
                      </h3>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-[hsl(var(--border))]">
                            <th className="text-left py-2 font-medium">Scorer</th>
                            <th className="text-right py-2 font-medium">Baseline</th>
                            <th className="text-right py-2 font-medium">Candidate</th>
                            <th className="text-right py-2 font-medium">Delta</th>
                          </tr>
                        </thead>
                        <tbody>
                          {compareResult.regressions.map((r) => (
                            <tr key={r.scorer} className="border-b border-[hsl(var(--border))]">
                              <td className="py-2 font-mono">{r.scorer}</td>
                              <td className="py-2 text-right font-mono">{r.baseline.toFixed(3)}</td>
                              <td className="py-2 text-right font-mono">
                                {r.candidate.toFixed(3)}
                              </td>
                              <td className="py-2 text-right font-mono text-red-600 dark:text-red-400">
                                {r.delta.toFixed(3)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {compareResult.improvements && compareResult.improvements.length > 0 && (
                    <div>
                      <h3 className="text-sm font-medium mb-2 text-green-600 dark:text-green-400">
                        Improvements
                      </h3>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-[hsl(var(--border))]">
                            <th className="text-left py-2 font-medium">Scorer</th>
                            <th className="text-right py-2 font-medium">Baseline</th>
                            <th className="text-right py-2 font-medium">Candidate</th>
                            <th className="text-right py-2 font-medium">Delta</th>
                          </tr>
                        </thead>
                        <tbody>
                          {compareResult.improvements.map((r) => (
                            <tr key={r.scorer} className="border-b border-[hsl(var(--border))]">
                              <td className="py-2 font-mono">{r.scorer}</td>
                              <td className="py-2 text-right font-mono">{r.baseline.toFixed(3)}</td>
                              <td className="py-2 text-right font-mono">
                                {r.candidate.toFixed(3)}
                              </td>
                              <td className="py-2 text-right font-mono text-green-600 dark:text-green-400">
                                +{r.delta.toFixed(3)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {/* Fallback for non-standard shape */}
                  {!compareResult.regressions && !compareResult.improvements && (
                    <JsonViewer data={compareResult} />
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
