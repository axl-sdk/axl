import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { PanelShell } from '../../components/layout/PanelShell';
import { EmptyState } from '../../components/shared/EmptyState';
import { fetchEvals, fetchEvalHistory, runRegisteredEval, compareEvals } from '../../lib/api';
import { formatCost, formatDuration } from '../../lib/utils';
import type { RegisteredEval, EvalHistoryEntry } from '../../lib/types';
import type { EvalResultData, ComparisonResult } from './types';
import { EvalSummaryTable } from './EvalSummaryTable';
import { EvalItemList } from './EvalItemList';
import { EvalItemDetail } from './EvalItemDetail';
import { ScoreDistribution } from './ScoreDistribution';
import { EvalCompareView } from './EvalCompareView';

export function EvalRunnerPanel() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'run' | 'history' | 'compare'>('run');
  const [selectedEval, setSelectedEval] = useState('');
  const [running, setRunning] = useState(false);
  const [currentResult, setCurrentResult] = useState<EvalResultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<number | null>(null);

  // Compare state
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
    try {
      const baselineData = history[1].data as EvalResultData;
      const candidateData = history[0].data as EvalResultData;
      setCompareBaseline(baselineData);
      setCompareCandidate(candidateData);
      const res = (await compareEvals(baselineData, candidateData)) as ComparisonResult;
      setCompareResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [history]);

  const scorerNames = currentResult?.summary?.scorers
    ? Object.keys(currentResult.summary.scorers)
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
              <div className="space-y-6">
                {/* Run metadata */}
                <div className="flex items-center gap-4 text-xs text-[hsl(var(--muted-foreground))]">
                  <span>
                    {currentResult.summary.count} items, {currentResult.summary.failures} failures
                  </span>
                  {currentResult.duration > 0 && (
                    <span>{formatDuration(currentResult.duration)}</span>
                  )}
                  {currentResult.totalCost > 0 && (
                    <span>{formatCost(currentResult.totalCost)}</span>
                  )}
                </div>

                {selectedItem != null ? (
                  <EvalItemDetail
                    item={currentResult.items[selectedItem]}
                    itemIndex={selectedItem}
                    scorerNames={scorerNames}
                    onBack={() => setSelectedItem(null)}
                  />
                ) : (
                  <>
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
                      />
                    )}
                  </>
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
            <HistoryTable
              history={history}
              onSelect={(data) => {
                setCurrentResult(data);
                setSelectedItem(null);
                setTab('run');
              }}
            />
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
                <EvalCompareView
                  compareResult={compareResult}
                  baseline={compareBaseline}
                  candidate={compareCandidate}
                />
              )}
            </>
          )}
        </div>
      )}
    </PanelShell>
  );
}

// ── History table with duration and scorer columns ───────────────

function HistoryTable({
  history,
  onSelect,
}: {
  history: EvalHistoryEntry[];
  onSelect: (data: EvalResultData) => void;
}) {
  // Collect all scorer names across history entries for column headers
  const allScorerNames = new Set<string>();
  for (const entry of history) {
    const data = entry.data as EvalResultData;
    if (data.summary?.scorers) {
      for (const name of Object.keys(data.summary.scorers)) {
        allScorerNames.add(name);
      }
    }
  }
  const scorerCols = [...allScorerNames].sort();

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-[hsl(var(--border))]">
          <th className="text-left py-2 font-medium">Eval</th>
          <th className="text-left py-2 font-medium">Timestamp</th>
          <th className="text-right py-2 font-medium">Items</th>
          <th className="text-right py-2 font-medium">Failures</th>
          <th className="text-right py-2 font-medium">Duration</th>
          <th className="text-right py-2 font-medium">Cost</th>
          {scorerCols.map((name) => (
            <th key={name} className="text-right py-2 font-medium font-mono">
              {name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {history.map((r: EvalHistoryEntry) => {
          const data = r.data as EvalResultData;
          return (
            <tr
              key={r.id}
              className="border-b border-[hsl(var(--border))] cursor-pointer hover:bg-[hsl(var(--accent))]"
              onClick={() => onSelect(data)}
            >
              <td className="py-2 font-mono">{r.eval}</td>
              <td className="py-2">{new Date(r.timestamp).toLocaleString()}</td>
              <td className="py-2 text-right">{data.summary.count}</td>
              <td className="py-2 text-right">
                {data.summary.failures > 0 ? (
                  <span className="text-red-600 dark:text-red-400">{data.summary.failures}</span>
                ) : (
                  0
                )}
              </td>
              <td className="py-2 text-right font-mono">
                {data.duration > 0 ? formatDuration(data.duration) : '-'}
              </td>
              <td className="py-2 text-right font-mono">
                {data.totalCost > 0 ? formatCost(data.totalCost) : '-'}
              </td>
              {scorerCols.map((name) => {
                const stats = data.summary?.scorers?.[name];
                return (
                  <td key={name} className="py-2 text-right font-mono">
                    {stats ? stats.mean.toFixed(3) : '-'}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
