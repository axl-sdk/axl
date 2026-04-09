import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Layers, ArrowRight } from 'lucide-react';
import { cn, formatCost, formatDuration } from '../../lib/utils';
import { scoreTextColor } from './types';
import type { EvalResultData } from './types';
import type { EvalHistoryEntry } from '../../lib/types';

type Props = {
  history: EvalHistoryEntry[];
  evalFilter: string;
  onEvalFilterChange: (value: string) => void;
  onSelect: (data: EvalResultData) => void;
  onSelectGroup?: (entries: EvalHistoryEntry[]) => void;
  onRescore?: (evalName: string, resultId: string) => void;
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

export function EvalHistoryTable({
  history,
  evalFilter,
  onEvalFilterChange,
  onSelect,
  onSelectGroup,
  onRescore,
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

  const totalCols = 7 + scorerCols.length + (onRescore ? 1 : 0);

  const renderEntryRow = (entry: EvalHistoryEntry, isChild: boolean, isFirst: boolean) => {
    const data = entry.data as EvalResultData;
    const isExpanded = expandedEntryId === entry.id;
    return (
      <Fragment key={entry.id}>
        <tr
          className={cn(
            'border-t border-[hsl(var(--border))] cursor-pointer hover:bg-[hsl(var(--accent))] transition-colors',
            isFirst && !isChild && 'bg-[hsl(var(--accent))]/30',
            isExpanded && 'bg-[hsl(var(--accent))]/40',
          )}
          onClick={() => setExpandedEntryId(isExpanded ? null : entry.id)}
        >
          <td className={cn('px-3 py-2.5 font-mono', isChild && 'pl-9')}>
            <span className="inline-flex items-center gap-1.5">
              {isChild && (
                <span className="inline-block w-1 h-3 mr-0.5 rounded-sm bg-[hsl(var(--border))]" />
              )}
              {entry.eval}
            </span>
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
                      <span>
                        Workflow:{' '}
                        <span className="font-medium text-[hsl(var(--foreground))]">
                          {data.workflow}
                        </span>
                      </span>
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
                      {onRescore && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onRescore(entry.eval, entry.id);
                          }}
                          className="px-2.5 py-1 text-[10px] font-medium rounded border border-[hsl(var(--input))] hover:bg-[hsl(var(--accent))] transition-colors cursor-pointer"
                          title="Re-run scorers on saved outputs without re-executing the workflow"
                        >
                          Rescore
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
                          <span className="inline-flex items-center gap-1.5">
                            <span className="shrink-0 p-0.5 -m-0.5">
                              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </span>
                            {row.evalName}
                          </span>
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
