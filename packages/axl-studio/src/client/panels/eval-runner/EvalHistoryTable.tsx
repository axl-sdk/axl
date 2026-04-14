import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Layers, ArrowRight, Download, Trash2 } from 'lucide-react';
import { cn, formatCost, formatDuration } from '../../lib/utils';
import {
  scoreTextColor,
  getResultModels,
  getResultModelCounts,
  getResultWorkflows,
  getResultWorkflowCounts,
  formatModelName,
  aggregateGroupModelCounts,
} from './types';
import type { EvalResultData } from './types';
import type { EvalHistoryEntry } from '../../lib/types';

type Props = {
  history: EvalHistoryEntry[];
  evalFilter: string;
  onEvalFilterChange: (value: string) => void;
  onSelect: (data: EvalResultData) => void;
  onSelectGroup?: (entries: EvalHistoryEntry[]) => void;
  onRescore?: (evalName: string, resultId: string) => void;
  onDelete?: (entry: EvalHistoryEntry) => void;
  /**
   * Set of eval names registered with the runtime. Entries whose `eval` field
   * isn't in this set (imported CLI artifacts with unknown eval names) have
   * their Rescore button disabled — rescore requires a matching registered
   * eval config server-side.
   */
  registeredEvalNames?: Set<string>;
  /**
   * Disable all mutating actions (Rescore, Delete) with an explanatory tooltip.
   * Server-side the endpoints are also blocked, but hiding/disabling in the UI
   * avoids the user clicking and getting a confusing 405 error.
   */
  readOnly?: boolean;
  expandedGroups: Set<string>;
  onToggleGroup: (groupId: string) => void;
};

type GroupRow = {
  type: 'group';
  groupId: string;
  entries: EvalHistoryEntry[];
  evalName: string;
  newestTimestamp: number;
};

type EntryRow = {
  type: 'entry';
  entry: EvalHistoryEntry;
};

type Row = GroupRow | EntryRow;

type GroupStats = {
  scorers: Record<string, { mean: number; std: number }>;
  overall: { mean: number; std: number } | null;
};

function computeGroupStats(entries: EvalHistoryEntry[]): GroupStats {
  const scorerMeans: Record<string, number[]> = {};
  const perRunOveralls: number[] = [];

  for (const entry of entries) {
    const data = entry.data as EvalResultData;
    if (!data.summary?.scorers) continue;
    const runMeans: number[] = [];
    for (const [name, stats] of Object.entries(data.summary.scorers)) {
      if (!scorerMeans[name]) scorerMeans[name] = [];
      scorerMeans[name].push(stats.mean);
      runMeans.push(stats.mean);
    }
    if (runMeans.length > 0) {
      perRunOveralls.push(runMeans.reduce((a, b) => a + b, 0) / runMeans.length);
    }
  }

  const scorers: Record<string, { mean: number; std: number }> = {};
  for (const [name, means] of Object.entries(scorerMeans)) {
    const mean = means.reduce((a, b) => a + b, 0) / means.length;
    const std =
      means.length > 1
        ? Math.sqrt(means.reduce((s, v) => s + (v - mean) ** 2, 0) / (means.length - 1))
        : 0;
    scorers[name] = { mean, std };
  }

  let overall: { mean: number; std: number } | null = null;
  if (perRunOveralls.length > 0) {
    const mean = perRunOveralls.reduce((a, b) => a + b, 0) / perRunOveralls.length;
    const std =
      perRunOveralls.length > 1
        ? Math.sqrt(
            perRunOveralls.reduce((s, v) => s + (v - mean) ** 2, 0) / (perRunOveralls.length - 1),
          )
        : 0;
    overall = { mean, std };
  }

  return { scorers, overall };
}

function exportEntry(entry: EvalHistoryEntry) {
  // Build a stable, useful filename: <eval-name>-<short-id>-<YYYYMMDDTHHMMSS>.json.
  // The eval name and short id make the artifact identifiable; the timestamp
  // includes hours/minutes/seconds so two same-day exports of the same eval
  // don't collide on disk and so files sort chronologically in a Downloads
  // folder. We strip the ISO punctuation (`-`, `:`, `.`, milliseconds) for a
  // filesystem-friendly form.
  const safeEval = entry.eval.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'eval';
  const shortId = entry.id.slice(0, 8);
  const stamp = new Date(entry.timestamp)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const filename = `${safeEval}-${shortId}-${stamp}.json`;

  const json = JSON.stringify(entry.data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke until after the click handler completes so the browser
  // has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function EvalHistoryTable({
  history,
  evalFilter,
  onEvalFilterChange,
  onSelect,
  onSelectGroup,
  onRescore,
  onDelete,
  registeredEvalNames,
  readOnly,
  expandedGroups,
  onToggleGroup,
}: Props) {
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);

  const evalNames = [...new Set(history.map((h) => h.eval))].sort();
  const filtered = useMemo(
    () => (evalFilter ? history.filter((h) => h.eval === evalFilter) : history),
    [history, evalFilter],
  );

  const { rows, scorerCols } = useMemo(() => {
    const groupMap = new Map<string, EvalHistoryEntry[]>();
    const standalone: EvalHistoryEntry[] = [];

    for (const entry of filtered) {
      const data = entry.data as EvalResultData;
      const groupId = data.metadata?.runGroupId as string | undefined;
      if (groupId) {
        if (!groupMap.has(groupId)) groupMap.set(groupId, []);
        groupMap.get(groupId)!.push(entry);
      } else {
        standalone.push(entry);
      }
    }

    const result: Row[] = [];
    for (const [groupId, entries] of groupMap) {
      entries.sort((a, b) => b.timestamp - a.timestamp);
      if (entries.length === 1) {
        result.push({ type: 'entry', entry: entries[0] });
      } else {
        result.push({
          type: 'group',
          groupId,
          entries,
          evalName: entries[0].eval,
          newestTimestamp: entries[0].timestamp,
        });
      }
    }
    for (const entry of standalone) {
      result.push({ type: 'entry', entry });
    }
    result.sort((a, b) => {
      const aTime = a.type === 'group' ? a.newestTimestamp : a.entry.timestamp;
      const bTime = b.type === 'group' ? b.newestTimestamp : b.entry.timestamp;
      return bTime - aTime;
    });

    const allScorerNames = new Set<string>();
    for (const entry of filtered) {
      const data = entry.data as EvalResultData;
      if (data.summary?.scorers) {
        for (const name of Object.keys(data.summary.scorers)) {
          allScorerNames.add(name);
        }
      }
    }

    return { rows: result, scorerCols: [...allScorerNames].sort() };
  }, [filtered]);

  const allScorerTypes = useMemo(() => {
    const types: Record<string, string> = {};
    for (const entry of filtered) {
      const data = entry.data as EvalResultData;
      const st = data.metadata?.scorerTypes as Record<string, string> | undefined;
      if (st) Object.assign(types, st);
    }
    return types;
  }, [filtered]);

  const totalCols = 8 + scorerCols.length + (onRescore ? 1 : 0);

  const renderEntryRow = (entry: EvalHistoryEntry, isChild: boolean, isFirst: boolean) => {
    const data = entry.data as EvalResultData;
    const isExpanded = expandedEntryId === entry.id;
    return (
      <Fragment key={entry.id}>
        <tr
          data-entry-id={entry.id}
          className={cn(
            'border-t border-[hsl(var(--border))] cursor-pointer hover:bg-[hsl(var(--accent))] transition-colors',
            isFirst && !isChild && 'bg-[hsl(var(--accent))]/30',
            isExpanded && 'bg-[hsl(var(--accent))]/40',
          )}
          onClick={() => setExpandedEntryId(isExpanded ? null : entry.id)}
        >
          <td className={cn('px-3 py-2.5 font-mono', isChild && 'pl-9')}>
            <div className="flex flex-col gap-0.5">
              <span className="inline-flex items-center gap-1.5">
                {isChild && (
                  <span className="inline-block w-1 h-3 mr-0.5 rounded-sm bg-[hsl(var(--border))]" />
                )}
                {entry.eval}
              </span>
              {/* Workflow subtitle. Shows every workflow observed during the run
                  (trace-derived from metadata.workflows), joined with " · ".
                  Hidden if the only workflow matches the eval name — that's
                  the imported-CLI case where we derived the eval name from the
                  workflow and rendering it twice would be noise. */}
              {(() => {
                const workflows = getResultWorkflows(data);
                if (workflows.length === 0) return null;
                if (workflows.length === 1 && workflows[0] === entry.eval) return null;
                const counts = getResultWorkflowCounts(data);
                const title = counts
                  ? `Workflows: ${workflows.map((w) => `${w} (${counts[w] ?? '?'} calls)`).join(', ')}`
                  : `Workflows: ${workflows.join(', ')}`;
                return (
                  <span
                    className="text-[10px] font-normal text-[hsl(var(--muted-foreground))] truncate max-w-[240px]"
                    title={title}
                  >
                    {workflows.join(' \u00b7 ')}
                  </span>
                );
              })()}
            </div>
          </td>
          <td className="px-3 py-2.5">
            {(() => {
              const models = getResultModels(data);
              if (models.length === 0)
                return <span className="text-[hsl(var(--muted-foreground))]">-</span>;
              const counts = getResultModelCounts(data);
              return (
                <span className="inline-flex items-center gap-1 flex-wrap">
                  {models.map((m) => (
                    <span
                      key={m}
                      className="px-1.5 py-0.5 rounded bg-[hsl(var(--secondary))] text-[hsl(var(--foreground))] font-mono text-[10px]"
                      title={counts ? `${m} — ${counts[m]} calls` : m}
                    >
                      {formatModelName(m)}
                      {counts && counts[m] != null && (
                        <span className="ml-0.5 text-[hsl(var(--muted-foreground))]">
                          ({counts[m]})
                        </span>
                      )}
                    </span>
                  ))}
                </span>
              );
            })()}
          </td>
          <td className="px-3 py-2.5 text-[hsl(var(--muted-foreground))]">
            {new Date(entry.timestamp).toLocaleString()}
          </td>
          <td className="px-3 py-2.5 text-right font-mono">{data.summary.count}</td>
          <td className="px-3 py-2.5 text-right font-mono">
            {data.summary.failures > 0 ? (
              <span className="text-red-600 dark:text-red-400">{data.summary.failures}</span>
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
          {(() => {
            const allMeans = Object.values(data.summary?.scorers ?? {}).map((s) => s.mean);
            const overall =
              allMeans.length > 0 ? allMeans.reduce((a, b) => a + b, 0) / allMeans.length : null;
            return (
              <td className="px-3 py-2.5 text-right font-mono font-medium border-l border-[hsl(var(--border))]">
                {overall != null ? (
                  <span className={scoreTextColor(overall)}>{overall.toFixed(3)}</span>
                ) : (
                  <span className="text-[hsl(var(--muted-foreground))]">-</span>
                )}
              </td>
            );
          })()}
          {scorerCols.map((name) => {
            const stats = data.summary?.scorers?.[name];
            return (
              <td key={name} className="px-3 py-2.5 text-right font-mono">
                {stats ? (
                  <div>
                    <span className={scoreTextColor(stats.mean)}>{stats.mean.toFixed(3)}</span>
                    {stats.min !== stats.max && (
                      <div className="text-[9px] text-[hsl(var(--muted-foreground))]">
                        {stats.min.toFixed(2)}
                        {'\u2013'}
                        {stats.max.toFixed(2)}
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-[hsl(var(--muted-foreground))]">-</span>
                )}
              </td>
            );
          })}
          {onRescore && <td className="px-3 py-2.5" />}
        </tr>
        {isExpanded &&
          (() => {
            const scorerTypes = data.metadata?.scorerTypes as Record<string, string> | undefined;
            const originalId = data.metadata?.originalId as string | undefined;
            return (
              <tr className="border-t border-[hsl(var(--border))] bg-[hsl(var(--muted))]/50">
                <td colSpan={totalCols} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4 text-[10px] text-[hsl(var(--muted-foreground))] flex-wrap">
                      <span>
                        ID: <span className="font-mono">{data.id.slice(0, 8)}</span>
                      </span>
                      <span>
                        Dataset:{' '}
                        <span className="font-medium text-[hsl(var(--foreground))]">
                          {data.dataset}
                        </span>
                      </span>
                      {(() => {
                        const workflows = getResultWorkflows(data);
                        if (workflows.length === 0) return null;
                        return (
                          <span>
                            {workflows.length > 1 ? 'Workflows' : 'Workflow'}:{' '}
                            <span className="font-medium text-[hsl(var(--foreground))]">
                              {workflows.join(', ')}
                            </span>
                          </span>
                        );
                      })()}
                      {(() => {
                        const models = getResultModels(data);
                        if (models.length === 0) return null;
                        const counts = getResultModelCounts(data);
                        return (
                          <span className="inline-flex items-center gap-1">
                            {models.map((m) => (
                              <span
                                key={m}
                                className="px-1.5 py-0.5 rounded bg-[hsl(var(--secondary))] text-[hsl(var(--foreground))] font-mono"
                                title={counts ? `${m} — ${counts[m]} calls` : m}
                              >
                                {formatModelName(m)}
                                {counts && counts[m] != null && (
                                  <span className="ml-0.5 text-[hsl(var(--muted-foreground))]">
                                    ({counts[m]})
                                  </span>
                                )}
                              </span>
                            ))}
                          </span>
                        );
                      })()}
                      {!!data.metadata?.rescored && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                          Rescored
                        </span>
                      )}
                      {originalId && (
                        <span>
                          from{' '}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedEntryId(originalId);
                              // Scroll to the target row after expansion
                              requestAnimationFrame(() => {
                                document
                                  .querySelector(`[data-entry-id="${CSS.escape(originalId)}"]`)
                                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                              });
                            }}
                            className="font-mono underline hover:text-[hsl(var(--foreground))] transition-colors cursor-pointer"
                          >
                            {originalId.slice(0, 8)}
                          </button>
                        </span>
                      )}
                      {scorerTypes && Object.keys(scorerTypes).length > 0 && (
                        <span className="inline-flex items-center gap-1.5">
                          Scorers:
                          {Object.entries(scorerTypes)
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([name, type]) => (
                              <span
                                key={name}
                                className={cn(
                                  'px-1.5 py-0.5 rounded font-mono cursor-default',
                                  type === 'llm'
                                    ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                                    : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
                                )}
                                title={
                                  type === 'llm'
                                    ? `${name} — LLM scorer (scores may vary between runs)`
                                    : `${name} — deterministic scorer`
                                }
                              >
                                {name}
                              </span>
                            ))}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {onRescore &&
                        (() => {
                          const evalRegistered =
                            !registeredEvalNames || registeredEvalNames.has(entry.eval);
                          const canRescore = evalRegistered && !readOnly;
                          const reason = readOnly
                            ? 'Rescore unavailable — Studio is mounted in read-only mode.'
                            : !evalRegistered
                              ? `Rescore unavailable — no registered eval named "${entry.eval}". ` +
                                'Imported CLI artifacts can only be rescored when the runtime has a matching registered eval config.'
                              : 'Re-run scorers on saved outputs without re-executing the workflow';
                          return (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (canRescore) onRescore(entry.eval, entry.id);
                              }}
                              disabled={!canRescore}
                              className={cn(
                                'px-2.5 py-1 text-[10px] font-medium rounded border border-[hsl(var(--input))] transition-colors',
                                canRescore
                                  ? 'hover:bg-[hsl(var(--accent))] cursor-pointer'
                                  : 'opacity-40 cursor-not-allowed',
                              )}
                              title={reason}
                            >
                              Rescore
                            </button>
                          );
                        })()}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          exportEntry(entry);
                        }}
                        className="p-1 rounded border border-[hsl(var(--input))] hover:bg-[hsl(var(--accent))] cursor-pointer transition-colors"
                        title={`Export this result as JSON (${entry.eval}-${entry.id.slice(0, 8)}-...json)`}
                        aria-label="Export result as JSON"
                      >
                        <Download size={12} />
                      </button>
                      {onDelete && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (readOnly) return;
                            onDelete(entry);
                          }}
                          disabled={readOnly}
                          className={cn(
                            'p-1 rounded border border-[hsl(var(--input))] transition-colors',
                            readOnly
                              ? 'opacity-40 cursor-not-allowed'
                              : 'hover:bg-red-50 hover:border-red-200 hover:text-red-600 dark:hover:bg-red-950/30 dark:hover:border-red-900 dark:hover:text-red-400 cursor-pointer',
                          )}
                          title={
                            readOnly
                              ? 'Delete unavailable — Studio is mounted in read-only mode.'
                              : 'Delete this history entry'
                          }
                          aria-label="Delete history entry"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(data);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded border border-[hsl(var(--input))] hover:bg-[hsl(var(--accent))] transition-colors cursor-pointer"
                        title="Open full run details in the Run tab"
                      >
                        View Details
                        <ArrowRight size={10} />
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
            );
          })()}
      </Fragment>
    );
  };

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
                <th className="text-left px-3 py-2.5 font-medium">Model</th>
                <th className="text-left px-3 py-2.5 font-medium">Timestamp</th>
                <th className="text-right px-3 py-2.5 font-medium">Items</th>
                <th className="text-right px-3 py-2.5 font-medium">Failures</th>
                <th className="text-right px-3 py-2.5 font-medium">Duration</th>
                <th className="text-right px-3 py-2.5 font-medium">Cost</th>
                <th className="text-right px-3 py-2.5 font-medium border-l border-[hsl(var(--border))]">
                  Overall
                </th>
                {scorerCols.map((name) => (
                  <th
                    key={name}
                    className="text-right px-3 py-2.5 font-medium font-mono whitespace-nowrap"
                    title={name}
                  >
                    {name}
                    {allScorerTypes[name] === 'llm' && (
                      <span
                        className="ml-1 px-1 py-0.5 text-[9px] font-medium rounded bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400 align-middle"
                        title="LLM scorer — scores may vary between runs"
                      >
                        LLM
                      </span>
                    )}
                  </th>
                ))}
                {onRescore && <th className="px-3 py-2.5 font-medium w-8" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => {
                if (row.type === 'group') {
                  const expanded = expandedGroups.has(row.groupId);
                  const groupStats = computeGroupStats(row.entries);
                  const groupScorers = groupStats.scorers;
                  const totalItems = row.entries.reduce(
                    (sum, e) => sum + (e.data as EvalResultData).summary.count,
                    0,
                  );
                  const totalDuration = row.entries.reduce(
                    (sum, e) => sum + (e.data as EvalResultData).duration,
                    0,
                  );
                  const totalCost = row.entries.reduce(
                    (sum, e) => sum + (e.data as EvalResultData).totalCost,
                    0,
                  );

                  return (
                    <Fragment key={row.groupId}>
                      <tr
                        className={cn(
                          'border-t border-[hsl(var(--border))] cursor-pointer hover:bg-[hsl(var(--accent))] transition-colors',
                          rowIdx === 0 && 'bg-[hsl(var(--accent))]/30',
                        )}
                        onClick={() => onToggleGroup(row.groupId)}
                      >
                        <td className="px-3 py-2.5 font-mono">
                          <div className="flex flex-col gap-0.5">
                            <span className="inline-flex items-center gap-1.5">
                              <span className="shrink-0 p-0.5 -m-0.5">
                                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </span>
                              {row.evalName}
                            </span>
                            {/* Aggregate workflows across every run in the group.
                                Normally all runs in a --runs N group share a workflow,
                                but custom callbacks could produce heterogeneous groups
                                so we union them. */}
                            {(() => {
                              const seen = new Set<string>();
                              const ordered: string[] = [];
                              for (const e of row.entries) {
                                for (const w of getResultWorkflows(e.data as EvalResultData)) {
                                  if (!seen.has(w)) {
                                    seen.add(w);
                                    ordered.push(w);
                                  }
                                }
                              }
                              if (ordered.length === 0) return null;
                              if (ordered.length === 1 && ordered[0] === row.evalName) return null;
                              return (
                                <span
                                  className="text-[10px] font-normal text-[hsl(var(--muted-foreground))] truncate max-w-[240px] pl-[22px]"
                                  title={`Workflows: ${ordered.join(', ')}`}
                                >
                                  {ordered.join(' \u00b7 ')}
                                </span>
                              );
                            })()}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          {(() => {
                            const sorted = aggregateGroupModelCounts(row.entries);
                            if (sorted.length === 0)
                              return <span className="text-[hsl(var(--muted-foreground))]">-</span>;
                            return (
                              <span className="inline-flex items-center gap-1 flex-wrap">
                                {sorted.map(([m, n]) => (
                                  <span
                                    key={m}
                                    className="px-1.5 py-0.5 rounded bg-[hsl(var(--secondary))] text-[hsl(var(--foreground))] font-mono text-[10px]"
                                    title={`${m} — ${n} calls`}
                                  >
                                    {formatModelName(m)}
                                    <span className="ml-0.5 text-[hsl(var(--muted-foreground))]">
                                      ({n})
                                    </span>
                                  </span>
                                ))}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-2.5 text-[hsl(var(--muted-foreground))]">
                          {new Date(row.newestTimestamp).toLocaleString()}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono">{totalItems}</td>
                        <td className="px-3 py-2.5 text-right">
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]">
                            <Layers size={10} />
                            {row.entries.length} runs
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                          {totalDuration > 0 ? formatDuration(totalDuration) : '-'}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                          {totalCost > 0 ? formatCost(totalCost) : '-'}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono font-medium border-l border-[hsl(var(--border))]">
                          {groupStats.overall ? (
                            <span className={scoreTextColor(groupStats.overall.mean)}>
                              {groupStats.overall.mean.toFixed(3)}
                              {groupStats.overall.std > 0 && (
                                <span className="text-[hsl(var(--muted-foreground))] font-normal">
                                  {' \u00b1 '}
                                  {groupStats.overall.std.toFixed(3)}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-[hsl(var(--muted-foreground))]">-</span>
                          )}
                        </td>
                        {scorerCols.map((name) => {
                          const gs = groupScorers[name];
                          return (
                            <td key={name} className="px-3 py-2.5 text-right font-mono">
                              {gs ? (
                                <span className={scoreTextColor(gs.mean)}>
                                  {gs.mean.toFixed(3)}
                                  <span className="text-[hsl(var(--muted-foreground))]">
                                    {' '}
                                    {' \u00b1 '}
                                    {gs.std.toFixed(3)}
                                  </span>
                                </span>
                              ) : (
                                <span className="text-[hsl(var(--muted-foreground))]">-</span>
                              )}
                            </td>
                          );
                        })}
                        {onRescore && <td className="px-3 py-2.5" />}
                      </tr>
                      {expanded && (
                        <>
                          {onSelectGroup && (
                            <tr className="border-t border-[hsl(var(--border))] bg-[hsl(var(--muted))]/50">
                              <td colSpan={totalCols} className="px-4 py-2.5">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                                    {row.entries.length} runs in this group
                                  </span>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onSelectGroup(row.entries);
                                    }}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded border border-[hsl(var(--input))] hover:bg-[hsl(var(--accent))] transition-colors cursor-pointer"
                                    title="View combined statistics across all runs in this group"
                                  >
                                    View Aggregate
                                    <ArrowRight size={10} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )}
                          {row.entries.map((entry) => renderEntryRow(entry, true, false))}
                        </>
                      )}
                    </Fragment>
                  );
                }

                return renderEntryRow(row.entry, false, rowIdx === 0);
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
