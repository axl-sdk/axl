import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, ArrowLeft, Upload, X } from 'lucide-react';
import { useEvalExecution, startEvalRun, cancelEvalRun, clearEvalRun } from './eval-store';
import { PanelHeader } from '../../components/layout/PanelHeader';
import { EmptyState } from '../../components/shared/EmptyState';
import { EvalTrendsView } from './EvalTrendsView';
import {
  fetchEvals,
  fetchEvalHistory,
  fetchHealth,
  compareEvals,
  importEvalResult,
  rescoreEval,
  deleteEvalHistoryEntry,
} from '../../lib/api';
import type { EvalHistoryEntry } from '../../lib/types';
import { cn, formatCost, formatDuration, formatTokens, extractLabel } from '../../lib/utils';
import type { RegisteredEval } from '../../lib/types';
import type { EvalResultData, ComparisonResult } from './types';
import {
  scoreTextColor,
  scoreBgTint,
  scoreColorClass,
  getResultModels,
  getResultModelCounts,
  getResultWorkflows,
  getResultWorkflowCounts,
  formatModelName,
  getResultTokens,
  buildMultiRunResult,
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
import { EvalCommandBar } from './EvalCommandBar';
import { StatCard } from '../../components/shared/StatCard';
import { JsonViewer } from '../../components/shared/JsonViewer';

export function EvalRunnerPanel() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'run' | 'history' | 'compare' | 'trends'>('run');
  const [selectedEval, setSelectedEval] = useState('');
  const evalExec = useEvalExecution();
  const running = evalExec.status === 'running';
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

  // readOnly is a boot-time flag on the runtime — safe to cache forever;
  // the client never needs to refetch it after the initial health call.
  const {
    data: health,
    isLoading: healthLoading,
    isError: healthError,
  } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    staleTime: Infinity,
  });
  const readOnly = !!health?.readOnly;
  // While the health query is in flight, we can't safely show mutating
  // affordances — defaulting to "writable" would briefly leak the Run/Import
  // buttons in a true readOnly runtime, and defaulting to "hidden" forever
  // would lock users out if the health endpoint ever fails. Instead, hide
  // mutating controls only during the loading window; on health failure,
  // assume writable (the route handlers will return 405 if we're wrong).
  const writeUiReady = !healthLoading || healthError;
  const canShowWriteUi = writeUiReady && !readOnly;

  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  // Auto-clear the import status after a few seconds so stale success messages
  // don't linger across unrelated user actions.
  useEffect(() => {
    if (!importStatus) return;
    const timer = setTimeout(() => setImportStatus(null), 6000);
    return () => clearTimeout(timer);
  }, [importStatus]);

  // Auto-dismiss the "Cancelled" banner after a few seconds — it's a
  // user-initiated action, not a real error. Server errors persist until
  // manually dismissed so the user doesn't miss them.
  useEffect(() => {
    if (error !== 'Cancelled') return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  const handleImportFile = useCallback(
    async (file: File) => {
      setError(null);
      setImportStatus(null);
      setImporting(true);
      try {
        const text = await file.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error(`${file.name} is not valid JSON`);
        }
        const { id } = await importEvalResult(parsed);
        // Refetch history so the imported entry appears before we auto-select it.
        await queryClient.invalidateQueries({ queryKey: ['evalHistory'] });

        // Auto-select the imported run into whichever slot is open. When both
        // slots are full we don't stomp on an existing selection — instead we
        // show a status message so the user knows the import succeeded.
        //
        // baselineSelection/candidateSelection come from the callback closure,
        // which is refreshed by the deps array on every state change, so they
        // reflect the latest values at click time.
        if (!baselineSelection) {
          setBaselineSelection({ id });
          setImportStatus(`Imported ${file.name} — selected as baseline`);
        } else if (!candidateSelection) {
          setCandidateSelection({ id });
          setImportStatus(`Imported ${file.name} — selected as candidate`);
        } else {
          setImportStatus(`Imported ${file.name} — added to history (both compare slots full)`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setImporting(false);
      }
    },
    [queryClient, baselineSelection, candidateSelection],
  );

  // Auto-default: select the two most recent groups/entries of the same eval
  useEffect(() => {
    if (baselineSelection || candidateSelection || history.length < 2) return;
    const firstEval = history[0].eval;
    const sameEval = history.filter((h) => h.eval === firstEval);
    if (sameEval.length < 2) return;

    // Find distinct groups/singles in order. A "group" with only one
    // surviving member (e.g., after the user deleted other runs) is treated
    // as a single — mirrors the picker's display logic so auto-select and
    // the picker stay consistent.
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
        if (groupIds.length > 1) {
          distinct.push({ id: groupIds[0], groupIds });
        } else {
          distinct.push({ id: groupIds[0] });
        }
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

  // Set of registered eval names — history entries whose `eval` field isn't
  // in this set (imported CLI artifacts with unknown eval names) can't be
  // rescored because the server needs a matching registered eval config.
  const registeredEvalNames = useMemo(
    () => new Set(evals.map((e: RegisteredEval) => e.name)),
    [evals],
  );

  // Multi-run derived state
  const multiRun = currentResult?._multiRun;
  const isAggregateView = multiRun != null && multiRunIndex === -1;
  const displayResult =
    multiRun && multiRunIndex >= 0 ? multiRun.allRuns[multiRunIndex] : currentResult;

  // Reset selected item when switching between runs
  useEffect(() => {
    setSelectedItem(null);
  }, [multiRunIndex]);

  // Adopt result/error from the global eval execution store into local state.
  // The store survives route changes; local state drives the result display.
  //
  // On done, the server broadcasts only a pointer (`evalResultId` + optional
  // `runGroupId`) rather than the full result, because the full payload
  // easily exceeds the 64KB WS frame budget and used to be silently
  // truncated — which left the client rendering an empty scaffold (the
  // "blank screen" bug). We refetch history and resolve the pointer here.
  const prevExecStatus = useRef(evalExec.status);
  useEffect(() => {
    if (prevExecStatus.current === evalExec.status) return;
    prevExecStatus.current = evalExec.status;

    if (evalExec.status === 'done' && evalExec.done) {
      const { evalResultId, runGroupId } = evalExec.done;
      // Refetch history, then look up the completed entry (and sibling
      // entries if this was a multi-run group) and adopt into local state.
      (async () => {
        try {
          await queryClient.refetchQueries({ queryKey: ['evalHistory'] });
          const fresh = queryClient.getQueryData<EvalHistoryEntry[]>(['evalHistory']) ?? [];
          const entry = fresh.find((e) => e.id === evalResultId);
          if (!entry) {
            setError(`Eval completed but result ${evalResultId} was not found in history.`);
            return;
          }
          if (runGroupId) {
            const groupEntries = fresh.filter(
              (e) => (e.data as EvalResultData).metadata?.runGroupId === runGroupId,
            );
            const allRuns = groupEntries.map((g) => g.data as EvalResultData);
            const multiRun = buildMultiRunResult(allRuns);
            setCurrentResult(multiRun ?? (entry.data as EvalResultData));
          } else {
            setCurrentResult(entry.data as EvalResultData);
          }
          setSelectedItem(null);
          setMultiRunIndex(-1);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          clearEvalRun();
        }
      })();
    } else if (evalExec.status === 'error' && evalExec.error) {
      // If the previous state was 'done', an adoption is already in flight.
      // A late cancel response (race) should not overwrite with "Cancelled".
      if (prevExecStatus.current !== 'done') {
        setError(evalExec.error);
      }
      // Invalidate history cache — partial runs from a cancelled multi-run
      // or completed runs from a failed eval may have been persisted by the
      // server before the error arrived. Without this, the History tab shows
      // stale data until the 5s staleTime expires.
      queryClient.invalidateQueries({ queryKey: ['evalHistory'] });
      clearEvalRun();
    }
  }, [evalExec.status, evalExec.done, evalExec.error, queryClient]);

  const handleRun = useCallback(async () => {
    if (!selectedEval) return;
    setError(null);
    setCurrentResult(null);
    setSelectedItem(null);
    setMultiRunIndex(-1);

    try {
      await startEvalRun(selectedEval, runCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedEval, runCount]);

  const handleCompare = useCallback(async () => {
    if (!baselineSelection || !candidateSelection) return;
    setComparing(true);
    setCompareResult(null);
    try {
      // Send only IDs to the server — it resolves them from runtime history.
      // This keeps the wire payload tiny and avoids host body-parser limits
      // (Express/NestJS default 100KB) when Studio is mounted as middleware.
      const toIdParam = (sel: RunSelection): string | string[] => {
        if (sel.groupIds && sel.groupIds.length > 1) return sel.groupIds;
        return sel.id;
      };

      const baselineIdParam = toIdParam(baselineSelection);
      const candidateIdParam = toIdParam(candidateSelection);

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

      const res = (await compareEvals(baselineIdParam, candidateIdParam)) as ComparisonResult;
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

  const handleDeleteEntry = useCallback(
    async (entry: EvalHistoryEntry) => {
      setError(null);
      // Native confirm — keeps the v1 surface area small. We surface the eval
      // name + short id so the user knows exactly what they're deleting.
      const shortId = entry.id.slice(0, 8);
      const ok = window.confirm(
        `Delete this eval history entry?\n\n${entry.eval} (${shortId})\n\nThis cannot be undone.`,
      );
      if (!ok) return;

      try {
        await deleteEvalHistoryEntry(entry.id);

        // Clear any compare selections that referenced the deleted entry, so
        // a stale ID doesn't 404 the next compare. Handles both single and
        // grouped selections.
        const referencedBy = (sel: RunSelection | null): boolean => {
          if (!sel) return false;
          if (sel.id === entry.id) return true;
          return !!sel.groupIds?.includes(entry.id);
        };
        if (referencedBy(baselineSelection)) setBaselineSelection(null);
        if (referencedBy(candidateSelection)) setCandidateSelection(null);

        // Clear the currentResult drilldown if it referenced the deleted entry.
        // Two cases: the user is viewing the deleted entry directly, OR the user
        // is viewing a multi-run aggregate whose allRuns contains the deleted id.
        // In the second case we can't safely re-render an aggregate that's missing
        // a run (the cached stats and run picker would be wrong), so clear it.
        if (currentResult) {
          const directHit = (currentResult as { id?: string }).id === entry.id;
          const groupHit = !!currentResult._multiRun?.allRuns.some(
            (r) => (r as { id?: string }).id === entry.id,
          );
          if (directHit || groupHit) {
            setCurrentResult(null);
            setSelectedItem(null);
            setMultiRunIndex(-1);
            setExpandedWorstItem(null);
          }
        }

        queryClient.invalidateQueries({ queryKey: ['evalHistory'] });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [queryClient, baselineSelection, candidateSelection, currentResult],
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

  const tabs = ['run', 'history', 'compare', 'trends'] as const;

  return (
    <div className="flex flex-col h-screen">
      <PanelHeader
        title="Eval Runner"
        description={
          selectedMeta ? (
            <>
              <span>{selectedMeta.workflow}</span>
              <span className="opacity-40 mx-1.5">·</span>
              <span>{selectedMeta.dataset}</span>
              <span className="opacity-40 mx-1.5">·</span>
              <span>
                {selectedMeta.scorers.length} scorer
                {selectedMeta.scorers.length !== 1 ? 's' : ''}
              </span>
            </>
          ) : evals.length > 0 ? (
            `${evals.length} registered eval${evals.length !== 1 ? 's' : ''} · select one to run`
          ) : (
            'No evals registered'
          )
        }
        actions={
          <>
            {canShowWriteUi && (
              <>
                <input
                  ref={importFileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleImportFile(file);
                    // Reset so the same filename can be re-imported.
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => importFileInputRef.current?.click()}
                  disabled={importing}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full cursor-pointer',
                    'ring-1 ring-[hsl(var(--input))] bg-[hsl(var(--background))] shadow-sm',
                    'hover:bg-[hsl(var(--muted))] hover:ring-[hsl(var(--ring))]',
                    'focus:outline-none focus-visible:ring-[hsl(var(--ring))] transition-all',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                  )}
                  title="Import an eval result JSON file (e.g. from `axl-eval --output`). Imported entries persist as long as the runtime's state store does."
                >
                  <Upload size={12} />
                  {importing ? 'Importing\u2026' : 'Import result'}
                </button>
              </>
            )}
            {/* Run controls are hidden in readOnly — the POST /api/evals/:name/run
                endpoint is blocked, so showing a button that always errors is
                worse than hiding it. Users can still browse history and compare.
                `canShowWriteUi` also waits for the health query so we don't
                briefly flash the button on initial load in a readOnly runtime. */}
            {evals.length > 0 && canShowWriteUi && (
              <EvalCommandBar
                evals={evals}
                selectedEval={selectedEval}
                onSelectEval={setSelectedEval}
                runCount={runCount}
                onRunCountChange={setRunCount}
                running={running}
                onRun={handleRun}
              />
            )}
          </>
        }
      />

      {/* ── Tabs ─────────────────────────────────────────
          Eval metadata moved out of this row and into the header subhead so
          it lives next to the picker that owns it, instead of being orphaned
          on the right side of the tab strip. */}
      <div
        role="tablist"
        aria-label="Eval views"
        className="shrink-0 flex items-center gap-1 px-6 border-b border-[hsl(var(--border))]"
      >
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
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
      </div>

      {/* ── Global error banner ─────────────────────────────
          Errors from any action (run, compare, import, rescore) surface here
          regardless of which tab is active, so users never lose feedback
          by switching tabs. Dismissible. */}
      {error && (
        <div className="shrink-0 px-6 py-3 border-b border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30">
          <div className="flex items-start justify-between gap-4">
            <div className="text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap break-words">
              {error}
            </div>
            <button
              onClick={() => setError(null)}
              className="shrink-0 text-xs text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-200 cursor-pointer"
              aria-label="Dismiss error"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* ── Import status banner ────────────────────────────
          Shows a transient success message after an import. Full-width so
          long messages don't truncate. Auto-clears after 6s via useEffect;
          also dismissible. Lives in a separate slot from the error banner
          so both can be shown simultaneously if needed. */}
      {importStatus && (
        <div className="shrink-0 px-6 py-2 border-b border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30">
          <div className="flex items-start justify-between gap-4">
            <div className="text-xs text-emerald-700 dark:text-emerald-300 whitespace-pre-wrap break-words">
              {importStatus}
            </div>
            <button
              onClick={() => setImportStatus(null)}
              className="shrink-0 text-xs text-emerald-600 dark:text-emerald-400 hover:text-emerald-900 dark:hover:text-emerald-200 cursor-pointer"
              aria-label="Dismiss import status"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

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
          ) : currentResult ? (
            <>
              {/* Back link — returns to wherever you came from (history or trends) */}
              {(previousTab === 'history' || previousTab === 'trends') && (
                <div className="shrink-0 px-6 pt-4">
                  <button
                    onClick={() => {
                      setTab(previousTab as 'history' | 'trends');
                      setPreviousTab(null);
                    }}
                    className="inline-flex items-center gap-1.5 text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors cursor-pointer"
                  >
                    <ArrowLeft size={14} />
                    Back to {previousTab === 'history' ? 'History' : 'Trends'}
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
                      <div className="flex-1 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                        {(() => {
                          const workflows = currentResult ? getResultWorkflows(currentResult) : [];
                          if (workflows.length === 0) return null;
                          const counts = currentResult
                            ? getResultWorkflowCounts(currentResult)
                            : null;
                          return (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                                {workflows.length > 1 ? 'Workflows' : 'Workflow'}
                              </span>
                              {workflows.map((w) => (
                                <span
                                  key={w}
                                  className="px-1.5 py-0.5 rounded bg-[hsl(var(--secondary))] text-[hsl(var(--foreground))] text-[10px] font-mono font-medium"
                                  title={counts ? `${w} — ${counts[w]} calls` : w}
                                >
                                  {w}
                                  {counts && counts[w] != null && (
                                    <span className="ml-1 text-[hsl(var(--muted-foreground))] font-normal">
                                      ({counts[w]})
                                    </span>
                                  )}
                                </span>
                              ))}
                            </div>
                          );
                        })()}
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
                    {/* Workflow + Model badges */}
                    {(() => {
                      const workflows = getResultWorkflows(displayResult);
                      const workflowCounts = getResultWorkflowCounts(displayResult);
                      const models = getResultModels(displayResult);
                      const modelCounts = getResultModelCounts(displayResult);
                      if (workflows.length === 0 && models.length === 0) return null;
                      return (
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3">
                          {workflows.length > 0 && (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                                {workflows.length > 1 ? 'Workflows' : 'Workflow'}
                              </span>
                              {workflows.map((w) => (
                                <span
                                  key={w}
                                  className="px-1.5 py-0.5 rounded bg-[hsl(var(--secondary))] text-[hsl(var(--foreground))] text-[10px] font-mono font-medium"
                                  title={workflowCounts ? `${w} — ${workflowCounts[w]} calls` : w}
                                >
                                  {w}
                                  {workflowCounts && workflowCounts[w] != null && (
                                    <span className="ml-1 text-[hsl(var(--muted-foreground))] font-normal">
                                      ({workflowCounts[w]})
                                    </span>
                                  )}
                                </span>
                              ))}
                            </div>
                          )}
                          {models.length > 0 && (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                                {models.length > 1 ? 'Models' : 'Model'}
                              </span>
                              {models.map((m) => (
                                <span
                                  key={m}
                                  className="px-1.5 py-0.5 rounded bg-[hsl(var(--secondary))] text-[hsl(var(--foreground))] text-[10px] font-mono font-medium"
                                  title={modelCounts ? `${m} — ${modelCounts[m]} calls` : m}
                                >
                                  {formatModelName(m)}
                                  {modelCounts && modelCounts[m] != null && (
                                    <span className="ml-1 text-[hsl(var(--muted-foreground))] font-normal">
                                      ({modelCounts[m]})
                                    </span>
                                  )}
                                </span>
                              ))}
                            </div>
                          )}
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
            <EvalRunningView exec={evalExec} onCancel={cancelEvalRun} />
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
                const enriched = buildMultiRunResult(allRuns);
                if (!enriched) return;
                setCurrentResult(enriched);
                setSelectedItem(null);
                setMultiRunIndex(-1);
                setPreviousTab('history');
                setTab('run');
              }}
              onRescore={handleRescore}
              onDelete={handleDeleteEntry}
              registeredEvalNames={registeredEvalNames}
              readOnly={readOnly}
              expandedGroups={expandedGroups}
              onToggleGroup={handleToggleGroup}
            />
          )}
        </div>
      )}

      {/* ── Trends Tab ──────────────────────────────────── */}
      {tab === 'trends' && (
        <EvalTrendsView
          onViewRun={(runId) => {
            const entry = history.find((e) => e.id === runId);
            if (entry) {
              setCurrentResult(entry.data as EvalResultData);
              setSelectedItem(null);
              setMultiRunIndex(-1);
              setPreviousTab('trends');
              setTab('run');
            }
          }}
        />
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

// ── Running progress view ────────────────────────────────────────

function EvalRunningView({
  exec,
  onCancel,
}: {
  exec: import('./eval-store').EvalExecState;
  onCancel: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!exec.startedAt) return;
    setElapsed(Math.floor((Date.now() - exec.startedAt) / 1000));
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - exec.startedAt!) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [exec.startedAt]);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const elapsedStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

  const p = exec.progress;
  const isMultiRun = (exec.runCount ?? 1) > 1;
  const totalItems = p?.totalItems ?? 0;
  const completedItems = p?.completedItems ?? 0;
  const completedRuns = p?.completedRuns ?? 0;
  const totalRuns = p?.totalRuns ?? exec.runCount ?? 1;
  const pct = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5">
      {/* Icon + pulse */}
      <div className="relative">
        <FlaskConical size={28} className="text-[hsl(var(--muted-foreground))]" />
        <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping" />
        <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500" />
      </div>

      {/* Status text */}
      <div className="text-center space-y-1">
        <p className="text-sm font-medium">
          {isMultiRun ? `Run ${completedRuns + 1} of ${totalRuns}` : 'Running evaluation\u2026'}
        </p>
        {exec.evalName && (
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            {exec.evalName}
            {isMultiRun ? ` \u00b7 ${totalRuns} runs` : ''}
          </p>
        )}
      </div>

      {/* Progress bar */}
      {totalItems > 0 && (
        <div className="w-56 space-y-1.5">
          <div className="h-1.5 rounded-full bg-[hsl(var(--muted))] overflow-hidden">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-[11px] text-[hsl(var(--muted-foreground))] text-center tabular-nums">
            {completedItems} / {totalItems} items
          </p>
        </div>
      )}

      {/* Elapsed time */}
      <p className="text-[11px] text-[hsl(var(--muted-foreground))] tabular-nums">{elapsedStr}</p>

      {/* Cancel */}
      <button
        onClick={onCancel}
        className="inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded-md
          border border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]
          hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]
          transition-colors cursor-pointer"
      >
        <X size={12} />
        Cancel
      </button>
    </div>
  );
}
