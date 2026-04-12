import { useState, useRef, useEffect, useMemo } from 'react';
import { ArrowLeftRight, ChevronDown, ChevronRight, Layers, Clock } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { EvalHistoryEntry } from '../../lib/types';
import type { EvalResultData } from './types';
import {
  scoreBarColor,
  getResultModels,
  getResultModelCounts,
  formatModelName,
  aggregateGroupModelCounts,
} from './types';

/** Selection is either a group (all runs pooled) or a single run. */
export type RunSelection = {
  /** The entry ID used as the representative (first in group, or the single run). */
  id: string;
  /** If this is a group selection, all entry IDs in the group. */
  groupIds?: string[];
};

type Props = {
  history: EvalHistoryEntry[];
  baselineSelection: RunSelection | null;
  candidateSelection: RunSelection | null;
  onBaselineChange: (sel: RunSelection) => void;
  onCandidateChange: (sel: RunSelection) => void;
  onCompare: () => void;
  comparing: boolean;
};

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function getDataset(entry: EvalHistoryEntry): string {
  return (entry.data as EvalResultData).dataset ?? '';
}

function getRunGroupId(entry: EvalHistoryEntry): string | undefined {
  return (entry.data as EvalResultData).metadata?.runGroupId as string | undefined;
}

// ── Grouping logic ───────────────────────────────────────────────

type PickerGroup = {
  type: 'group';
  groupId: string;
  entries: EvalHistoryEntry[];
  evalName: string;
  timestamp: number;
  dataset: string;
  runCount: number;
  aggregateScorers: Record<string, { mean: number }>;
};

type PickerSingle = {
  type: 'single';
  entry: EvalHistoryEntry;
};

type PickerItem = PickerGroup | PickerSingle;

function buildPickerItems(entries: EvalHistoryEntry[]): PickerItem[] {
  const groupMap = new Map<string, EvalHistoryEntry[]>();
  const singles: EvalHistoryEntry[] = [];

  for (const entry of entries) {
    const gid = getRunGroupId(entry);
    if (gid) {
      if (!groupMap.has(gid)) groupMap.set(gid, []);
      groupMap.get(gid)!.push(entry);
    } else {
      singles.push(entry);
    }
  }

  const items: PickerItem[] = [];

  for (const [groupId, groupEntries] of groupMap) {
    // Compute aggregate scorer means
    const firstData = groupEntries[0].data as EvalResultData;
    const scorerNames = Object.keys(firstData.summary?.scorers ?? {});
    const aggregateScorers: Record<string, { mean: number }> = {};
    for (const name of scorerNames) {
      const means = groupEntries.map(
        (e) => (e.data as EvalResultData).summary?.scorers?.[name]?.mean ?? 0,
      );
      aggregateScorers[name] = { mean: means.reduce((a, b) => a + b, 0) / means.length };
    }

    items.push({
      type: 'group',
      groupId,
      entries: groupEntries.sort((a, b) => b.timestamp - a.timestamp),
      evalName: groupEntries[0].eval,
      timestamp: Math.max(...groupEntries.map((e) => e.timestamp)),
      dataset: getDataset(groupEntries[0]),
      runCount: groupEntries.length,
      aggregateScorers,
    });
  }

  for (const entry of singles) {
    items.push({ type: 'single', entry });
  }

  // Sort by timestamp descending
  items.sort((a, b) => {
    const tsA = a.type === 'group' ? a.timestamp : a.entry.timestamp;
    const tsB = b.type === 'group' ? b.timestamp : b.entry.timestamp;
    return tsB - tsA;
  });

  return items;
}

// ── Mini score bars ──────────────────────────────────────────────

function MiniScoreBars({ scorers }: { scorers: Record<string, { mean: number }> }) {
  const entries = Object.entries(scorers);
  if (entries.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5 shrink-0">
      {entries.map(([name, s]) => (
        <div
          key={name}
          className="relative h-3.5 w-4 rounded-sm bg-[hsl(var(--muted))] overflow-hidden"
          title={`${name}: ${s.mean.toFixed(3)}`}
        >
          <div
            className={cn('absolute bottom-0 left-0 right-0 rounded-sm', scoreBarColor(s.mean))}
            style={{ height: `${Math.max(0, Math.min(100, s.mean * 100))}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function MiniScoreBarsFromData({ data }: { data: EvalResultData }) {
  const scorers = data.summary?.scorers;
  if (!scorers) return null;
  const mapped: Record<string, { mean: number }> = {};
  for (const [k, v] of Object.entries(scorers)) mapped[k] = { mean: v.mean };
  return <MiniScoreBars scorers={mapped} />;
}

// ── Selected value display ───────────────────────────────────────

function SelectedDisplay({
  selection,
  history,
  pickerItems,
  placeholder,
}: {
  selection: RunSelection | null;
  history: EvalHistoryEntry[];
  pickerItems: PickerItem[];
  placeholder: string;
}) {
  if (!selection) {
    return <span className="text-sm text-[hsl(var(--muted-foreground))]">{placeholder}</span>;
  }

  // Check if it's a group selection
  if (selection.groupIds && selection.groupIds.length > 1) {
    const group = pickerItems.find(
      (item) => item.type === 'group' && item.entries.some((e) => e.id === selection.id),
    );
    if (group && group.type === 'group') {
      const sortedGroupCounts = aggregateGroupModelCounts(group.entries);
      return (
        <div className="flex items-center gap-2.5 min-w-0">
          <MiniScoreBars scorers={group.aggregateScorers} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium truncate">{group.evalName}</span>
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">
                <Layers className="h-2.5 w-2.5" />
                {group.runCount} runs
              </span>
              {sortedGroupCounts.map(([m, n]) => (
                <span
                  key={m}
                  className="px-1 py-0.5 rounded bg-[hsl(var(--secondary))] font-mono text-[9px]"
                  title={`${m} — ${n} calls`}
                >
                  {formatModelName(m)}{' '}
                  <span className="text-[hsl(var(--muted-foreground))]">({n})</span>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">
              <Clock className="h-2.5 w-2.5" />
              {formatRelativeTime(group.timestamp)}
            </div>
          </div>
        </div>
      );
    }
  }

  // Single run
  const entry = history.find((h) => h.id === selection.id);
  if (!entry)
    return <span className="text-sm text-[hsl(var(--muted-foreground))]">{placeholder}</span>;
  const data = entry.data as EvalResultData;
  const models = getResultModels(data);
  const counts = getResultModelCounts(data);
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <MiniScoreBarsFromData data={data} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium truncate">{entry.eval}</span>
          {models.map((m) => (
            <span
              key={m}
              className="px-1 py-0.5 rounded bg-[hsl(var(--secondary))] font-mono text-[9px]"
              title={counts ? `${m} — ${counts[m]} calls` : m}
            >
              {formatModelName(m)}
              {counts && (
                <span className="text-[hsl(var(--muted-foreground))]"> ({counts[m]})</span>
              )}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">
          <Clock className="h-2.5 w-2.5" />
          {formatRelativeTime(entry.timestamp)}
          <span className="opacity-50">{'\u00b7'}</span>
          <span className="font-mono">{entry.id.slice(0, 8)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Dropdown ─────────────────────────────────────────────────────

function RunPicker({
  label,
  selection,
  pickerItems,
  disabledSelection,
  history,
  onChange,
  filterDataset,
}: {
  label: string;
  selection: RunSelection | null;
  pickerItems: PickerItem[];
  disabledSelection: RunSelection | null;
  history: EvalHistoryEntry[];
  onChange: (sel: RunSelection) => void;
  filterDataset: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setExpandedGroupId(null);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // Filter by dataset if needed
  const filtered = filterDataset
    ? pickerItems.filter((item) => {
        if (item.type === 'group') return item.dataset === filterDataset;
        return getDataset(item.entry) === filterDataset;
      })
    : pickerItems;

  const disabledIds = new Set(
    disabledSelection?.groupIds ?? (disabledSelection ? [disabledSelection.id] : []),
  );

  return (
    <div ref={ref} className="flex-1 min-w-0 relative">
      <label className="block text-[10px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-1.5">
        {label}
      </label>
      <button
        onClick={() => {
          setOpen(!open);
          setExpandedGroupId(null);
        }}
        className={cn(
          'w-full px-3 py-2 rounded-lg border text-left flex items-center justify-between gap-2 transition-colors min-h-[44px] cursor-pointer',
          open
            ? 'border-[hsl(var(--foreground))] ring-1 ring-[hsl(var(--foreground))]'
            : 'border-[hsl(var(--input))] hover:border-[hsl(var(--foreground))/30]',
          'bg-[hsl(var(--background))]',
        )}
      >
        <SelectedDisplay
          selection={selection}
          history={history}
          pickerItems={pickerItems}
          placeholder={`Select ${label.toLowerCase()}...`}
        />
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-[hsl(var(--muted-foreground))] transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-72 overflow-y-auto rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-lg">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-xs text-center text-[hsl(var(--muted-foreground))]">
              No matching runs
            </div>
          ) : (
            filtered.map((item) => {
              if (item.type === 'group') {
                const isExpanded = expandedGroupId === item.groupId;
                const isGroupSelected = selection?.groupIds?.some((id) =>
                  item.entries.some((e) => e.id === id),
                );
                return (
                  <div
                    key={item.groupId}
                    className="border-b border-[hsl(var(--border))] last:border-b-0"
                  >
                    {/* Group header — selects the whole group */}
                    <div className="flex items-stretch">
                      <button
                        onClick={() => {
                          onChange({
                            id: item.entries[0].id,
                            groupIds: item.entries.map((e) => e.id),
                          });
                          setOpen(false);
                          setExpandedGroupId(null);
                        }}
                        className={cn(
                          'flex-1 text-left px-3 py-2.5 flex items-center gap-2.5 transition-colors cursor-pointer',
                          isGroupSelected
                            ? 'bg-[hsl(var(--accent))]'
                            : 'hover:bg-[hsl(var(--accent))]',
                        )}
                      >
                        <MiniScoreBars scorers={item.aggregateScorers} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium truncate">{item.evalName}</span>
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">
                              <Layers className="h-2 w-2" />
                              {item.runCount} runs
                            </span>
                            {aggregateGroupModelCounts(item.entries).map(([m, n]) => (
                              <span
                                key={m}
                                className="px-1 py-0.5 rounded bg-[hsl(var(--secondary))] font-mono text-[9px]"
                                title={`${m} — ${n} calls`}
                              >
                                {formatModelName(m)}{' '}
                                <span className="text-[hsl(var(--muted-foreground))]">({n})</span>
                              </span>
                            ))}
                          </div>
                          <div className="text-[10px] text-[hsl(var(--muted-foreground))]">
                            {formatRelativeTime(item.timestamp)}
                            <span className="opacity-50"> {'\u00b7'} </span>
                            pooled comparison
                          </div>
                        </div>
                        {isGroupSelected && (
                          <div className="shrink-0 h-1.5 w-1.5 rounded-full bg-[hsl(var(--foreground))]" />
                        )}
                      </button>
                      {/* Expand chevron to show individual runs */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedGroupId(isExpanded ? null : item.groupId);
                        }}
                        className="shrink-0 w-8 flex items-center justify-center border-l border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))] transition-colors cursor-pointer"
                        title={isExpanded ? 'Hide individual runs' : 'Show individual runs'}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3 text-[hsl(var(--muted-foreground))]" />
                        ) : (
                          <ChevronRight className="h-3 w-3 text-[hsl(var(--muted-foreground))]" />
                        )}
                      </button>
                    </div>
                    {/* Individual runs within the group */}
                    {isExpanded &&
                      item.entries.map((entry) => {
                        const data = entry.data as EvalResultData;
                        const isSingleSelected = selection?.id === entry.id && !selection?.groupIds;
                        const isDisabled = disabledIds.has(entry.id);
                        return (
                          <button
                            key={entry.id}
                            onClick={() => {
                              onChange({ id: entry.id });
                              setOpen(false);
                              setExpandedGroupId(null);
                            }}
                            disabled={isDisabled}
                            className={cn(
                              'w-full text-left pl-8 pr-3 py-2 flex items-center gap-2.5 transition-colors border-t border-[hsl(var(--border))] cursor-pointer',
                              'bg-[hsl(var(--muted))]/30',
                              isSingleSelected
                                ? 'bg-[hsl(var(--accent))]'
                                : 'hover:bg-[hsl(var(--accent))]',
                              isDisabled && 'opacity-30 cursor-not-allowed',
                            )}
                          >
                            <MiniScoreBarsFromData data={data} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1 text-[10px] text-[hsl(var(--muted-foreground))]">
                                <span>Run {((data.metadata?.runIndex as number) ?? 0) + 1}</span>
                                <span className="opacity-50">{'\u00b7'}</span>
                                <span className="font-mono">{entry.id.slice(0, 8)}</span>
                                {(() => {
                                  const counts = getResultModelCounts(data);
                                  return getResultModels(data).map((m) => (
                                    <span
                                      key={m}
                                      className="px-1 py-0.5 rounded bg-[hsl(var(--secondary))] text-[hsl(var(--foreground))] font-mono text-[9px]"
                                      title={counts ? `${m} — ${counts[m]} calls` : m}
                                    >
                                      {formatModelName(m)}
                                      {counts && (
                                        <span className="text-[hsl(var(--muted-foreground))]">
                                          {' '}
                                          ({counts[m]})
                                        </span>
                                      )}
                                    </span>
                                  ));
                                })()}
                              </div>
                            </div>
                            {isSingleSelected && (
                              <div className="shrink-0 h-1.5 w-1.5 rounded-full bg-[hsl(var(--foreground))]" />
                            )}
                          </button>
                        );
                      })}
                  </div>
                );
              }

              // Single run
              const { entry } = item;
              const data = entry.data as EvalResultData;
              const isSelected = selection?.id === entry.id;
              const isDisabled = disabledIds.has(entry.id);
              return (
                <button
                  key={entry.id}
                  onClick={() => {
                    onChange({ id: entry.id });
                    setOpen(false);
                    setExpandedGroupId(null);
                  }}
                  disabled={isDisabled}
                  className={cn(
                    'w-full text-left px-3 py-2.5 flex items-center gap-2.5 transition-colors border-b border-[hsl(var(--border))] last:border-b-0 cursor-pointer',
                    isSelected ? 'bg-[hsl(var(--accent))]' : 'hover:bg-[hsl(var(--accent))]',
                    isDisabled && 'opacity-30 cursor-not-allowed',
                  )}
                >
                  <MiniScoreBarsFromData data={data} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium truncate">{entry.eval}</span>
                      {(() => {
                        const counts = getResultModelCounts(data);
                        return getResultModels(data).map((m) => (
                          <span
                            key={m}
                            className="px-1 py-0.5 rounded bg-[hsl(var(--secondary))] font-mono text-[9px]"
                            title={counts ? `${m} — ${counts[m]} calls` : m}
                          >
                            {formatModelName(m)}
                            {counts && (
                              <span className="text-[hsl(var(--muted-foreground))]">
                                {' '}
                                ({counts[m]})
                              </span>
                            )}
                          </span>
                        ));
                      })()}
                    </div>
                    <div className="text-[10px] text-[hsl(var(--muted-foreground))]">
                      {formatRelativeTime(entry.timestamp)}
                      <span className="opacity-50"> {'\u00b7'} </span>
                      <span className="font-mono">{entry.id.slice(0, 8)}</span>
                      <span className="opacity-50"> {'\u00b7'} </span>
                      {data.summary.count} items
                    </div>
                  </div>
                  {isSelected && (
                    <div className="shrink-0 h-1.5 w-1.5 rounded-full bg-[hsl(var(--foreground))]" />
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ── Main picker ──────────────────────────────────────────────────

export function EvalCompareRunPicker({
  history,
  baselineSelection,
  candidateSelection,
  onBaselineChange,
  onCandidateChange,
  onCompare,
  comparing,
}: Props) {
  const pickerItems = useMemo(() => buildPickerItems(history), [history]);

  const baselineEntry = baselineSelection
    ? history.find((h) => h.id === baselineSelection.id)
    : null;
  const baselineDataset = baselineEntry ? getDataset(baselineEntry) : null;

  const canCompare =
    baselineSelection != null &&
    candidateSelection != null &&
    baselineSelection.id !== candidateSelection.id &&
    !comparing;

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <RunPicker
          label="Baseline"
          selection={baselineSelection}
          pickerItems={pickerItems}
          disabledSelection={candidateSelection}
          history={history}
          onChange={onBaselineChange}
          filterDataset={null}
        />

        <button
          onClick={() => {
            if (baselineSelection && candidateSelection) {
              const tmp = baselineSelection;
              onBaselineChange(candidateSelection);
              onCandidateChange(tmp);
            }
          }}
          disabled={!baselineSelection || !candidateSelection}
          className="shrink-0 p-2 rounded-lg border border-[hsl(var(--input))] hover:bg-[hsl(var(--accent))] disabled:opacity-30 transition-colors mb-[1px] cursor-pointer"
          title="Swap baseline and candidate"
        >
          <ArrowLeftRight className="h-3.5 w-3.5 text-[hsl(var(--muted-foreground))]" />
        </button>

        <RunPicker
          label="Candidate"
          selection={candidateSelection}
          pickerItems={pickerItems}
          disabledSelection={baselineSelection}
          history={history}
          onChange={onCandidateChange}
          filterDataset={baselineDataset}
        />

        <button
          onClick={onCompare}
          disabled={!canCompare}
          className={cn(
            'shrink-0 px-5 py-2 text-sm font-medium rounded-lg transition-all cursor-pointer',
            'bg-[hsl(var(--foreground))] text-[hsl(var(--background))]',
            'hover:opacity-90 disabled:opacity-40',
          )}
        >
          {comparing ? 'Comparing\u2026' : 'Compare'}
        </button>
      </div>
    </div>
  );
}
