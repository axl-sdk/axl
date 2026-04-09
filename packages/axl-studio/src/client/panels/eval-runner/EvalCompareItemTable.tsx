import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn, extractLabel } from '../../lib/utils';
import { ItemComparison } from './EvalCompareView';
import type { EvalResultData } from './types';
import { scoreTextColor } from './types';

type Props = {
  baseline: EvalResultData;
  candidate: EvalResultData;
  scorerNames: string[];
  baselineRuns?: EvalResultData[];
  candidateRuns?: EvalResultData[];
  scorerTypes?: Record<string, string>;
};

type SortedItem = {
  index: number;
  input: unknown;
  baselineScore: number | null;
  candidateScore: number | null;
  delta: number;
  /** Per-run deltas when pooled (one per run). */
  runDeltas?: number[];
};

type SortField = 'index' | 'baseline' | 'candidate' | 'delta';

function SortTh({
  field,
  current,
  dir,
  onSort,
  align,
  className,
  children,
}: {
  field: SortField;
  current: SortField;
  dir: 'asc' | 'desc';
  onSort: (f: SortField) => void;
  align: 'left' | 'right';
  className?: string;
  children: React.ReactNode;
}) {
  const isActive = current === field;
  return (
    <th
      className={cn(
        `text-${align} px-3 py-2 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))]`,
        className,
        align === 'left' && 'px-4',
      )}
      onClick={() => onSort(field)}
    >
      {children}
      {isActive && <span className="ml-0.5">{dir === 'desc' ? '\u25BC' : '\u25B2'}</span>}
    </th>
  );
}

export function EvalCompareItemTable({
  baseline,
  candidate,
  scorerNames,
  baselineRuns,
  candidateRuns,
  scorerTypes,
}: Props) {
  const [sortScorer, setSortScorer] = useState(scorerNames[0] ?? '');
  const [sortField, setSortField] = useState<SortField>('delta');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [collapsed, setCollapsed] = useState(false);
  const isPooled =
    (baselineRuns && baselineRuns.length > 1) || (candidateRuns && candidateRuns.length > 1);
  const bRunCount = baselineRuns?.length ?? 1;
  const cRunCount = candidateRuns?.length ?? 1;
  const [expandedItem, setExpandedItem] = useState<number | null>(null);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortField(field);
      setSortDir(field === 'index' ? 'asc' : 'desc');
    }
  };

  const itemCount = Math.min(baseline.items.length, candidate.items.length);

  const sortedItems = useMemo(() => {
    const items: SortedItem[] = [];
    const runCount = Math.min(baselineRuns?.length ?? 0, candidateRuns?.length ?? 0);
    for (let i = 0; i < itemCount; i++) {
      const bScore = baseline.items[i].scores[sortScorer] ?? null;
      const cScore = candidate.items[i].scores[sortScorer] ?? null;
      const delta = bScore != null && cScore != null ? cScore - bScore : 0;

      // Compute per-run deltas when pooled
      let runDeltas: number[] | undefined;
      if (runCount > 1) {
        runDeltas = [];
        for (let r = 0; r < runCount; r++) {
          const bs = baselineRuns![r]?.items[i]?.scores[sortScorer];
          const cs = candidateRuns![r]?.items[i]?.scores[sortScorer];
          if (bs != null && cs != null) runDeltas.push(cs - bs);
        }
      }

      items.push({
        index: i,
        input: baseline.items[i].input,
        baselineScore: bScore,
        candidateScore: cScore,
        delta,
        runDeltas,
      });
    }
    items.sort((a, b) => {
      let aVal: number, bVal: number;
      switch (sortField) {
        case 'index':
          aVal = a.index;
          bVal = b.index;
          break;
        case 'baseline':
          aVal = a.baselineScore ?? -1;
          bVal = b.baselineScore ?? -1;
          break;
        case 'candidate':
          aVal = a.candidateScore ?? -1;
          bVal = b.candidateScore ?? -1;
          break;
        case 'delta':
        default:
          aVal = Math.abs(a.delta);
          bVal = Math.abs(b.delta);
          break;
      }
      return sortDir === 'desc' ? bVal - aVal : aVal - bVal;
    });
    return items;
  }, [baseline, candidate, sortScorer, sortField, sortDir, itemCount, baselineRuns, candidateRuns]);

  if (scorerNames.length === 0 || itemCount === 0) return null;

  return (
    <div className="border border-[hsl(var(--border))] rounded-xl overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-[hsl(var(--muted))] border-b border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))] transition-colors cursor-pointer"
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 text-[hsl(var(--muted-foreground))]" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-[hsl(var(--muted-foreground))]" />
        )}
        <h3 className="text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          All Items ({itemCount})
          {isPooled && (
            <span className="normal-case tracking-normal font-normal ml-1.5 opacity-70">
              {'\u2014'} scores averaged across{' '}
              {bRunCount === cRunCount ? `${bRunCount} runs` : `${bRunCount} / ${cRunCount} runs`}
            </span>
          )}
        </h3>
      </button>

      {!collapsed && (
        <div>
          {/* Toolbar */}
          <div className="flex items-center gap-1.5 px-4 py-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--card))] flex-wrap">
            {scorerNames.map((name) => (
              <button
                key={name}
                onClick={() => setSortScorer(name)}
                className={cn(
                  'px-2 py-1 text-[11px] font-mono rounded-md transition-colors cursor-pointer',
                  sortScorer === name
                    ? 'bg-[hsl(var(--foreground))] text-[hsl(var(--background))] font-medium'
                    : 'bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]',
                )}
              >
                {name}
                {scorerTypes?.[name] === 'llm' && (
                  <span className="ml-1 text-[8px] opacity-70">LLM</span>
                )}
              </button>
            ))}
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[hsl(var(--border))]">
                  <SortTh
                    field="index"
                    current={sortField}
                    dir={sortDir}
                    onSort={toggleSort}
                    align="left"
                    className="w-10"
                  >
                    #
                  </SortTh>
                  <th className="text-left px-3 py-2 font-medium">Input</th>
                  <SortTh
                    field="baseline"
                    current={sortField}
                    dir={sortDir}
                    onSort={toggleSort}
                    align="right"
                  >
                    Baseline
                    {isPooled && bRunCount > 1 && (
                      <span className="font-normal opacity-60 ml-0.5">({bRunCount})</span>
                    )}
                  </SortTh>
                  <SortTh
                    field="candidate"
                    current={sortField}
                    dir={sortDir}
                    onSort={toggleSort}
                    align="right"
                  >
                    Candidate
                    {isPooled && cRunCount > 1 && (
                      <span className="font-normal opacity-60 ml-0.5">({cRunCount})</span>
                    )}
                  </SortTh>
                  <SortTh
                    field="delta"
                    current={sortField}
                    dir={sortDir}
                    onSort={toggleSort}
                    align="right"
                  >
                    Delta
                  </SortTh>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((item) => {
                  const isExpanded = expandedItem === item.index;
                  const deltaColor =
                    item.delta > 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : item.delta < 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-[hsl(var(--muted-foreground))]';

                  return (
                    <tr
                      key={item.index}
                      className={cn(
                        'border-b border-[hsl(var(--border))] last:border-b-0 cursor-pointer hover:bg-[hsl(var(--accent))] transition-colors',
                        isExpanded && 'bg-[hsl(var(--accent))]',
                      )}
                    >
                      <td
                        className="px-4 py-2.5 font-mono text-[hsl(var(--muted-foreground))]"
                        onClick={() => setExpandedItem(isExpanded ? null : item.index)}
                      >
                        {item.index + 1}
                      </td>
                      <td
                        className="px-3 py-2.5 max-w-xs truncate"
                        onClick={() => setExpandedItem(isExpanded ? null : item.index)}
                      >
                        {extractLabel(item.input)}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2.5 text-right font-mono',
                          item.baselineScore != null
                            ? scoreTextColor(item.baselineScore)
                            : 'text-[hsl(var(--muted-foreground))]',
                        )}
                        onClick={() => setExpandedItem(isExpanded ? null : item.index)}
                      >
                        {item.baselineScore != null ? item.baselineScore.toFixed(3) : '\u2014'}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2.5 text-right font-mono',
                          item.candidateScore != null
                            ? scoreTextColor(item.candidateScore)
                            : 'text-[hsl(var(--muted-foreground))]',
                        )}
                        onClick={() => setExpandedItem(isExpanded ? null : item.index)}
                      >
                        {item.candidateScore != null ? item.candidateScore.toFixed(3) : '\u2014'}
                      </td>
                      <td
                        className={cn('px-3 py-2.5 text-right', deltaColor)}
                        onClick={() => setExpandedItem(isExpanded ? null : item.index)}
                      >
                        <div className="font-mono">
                          {item.delta !== 0
                            ? `${item.delta > 0 ? '+' : ''}${item.delta.toFixed(3)}`
                            : '\u2014'}
                        </div>
                        {item.runDeltas && item.runDeltas.length > 1 && (
                          <div
                            className="flex items-center justify-end gap-0.5 mt-1"
                            title={item.runDeltas
                              .map((d, i) => `Run ${i + 1}: ${d >= 0 ? '+' : ''}${d.toFixed(3)}`)
                              .join(', ')}
                          >
                            {item.runDeltas.map((d, ri) => (
                              <div
                                key={ri}
                                className={cn(
                                  'w-1.5 h-1.5 rounded-full',
                                  d < 0
                                    ? 'bg-red-500 dark:bg-red-400'
                                    : d > 0
                                      ? 'bg-emerald-500 dark:bg-emerald-400'
                                      : 'bg-[hsl(var(--muted-foreground))]',
                                )}
                              />
                            ))}
                            <span className="text-[9px] text-[hsl(var(--muted-foreground))] ml-0.5">
                              {
                                item.runDeltas.filter((d) => (item.delta < 0 ? d < 0 : d > 0))
                                  .length
                              }
                              /{item.runDeltas.length}
                            </span>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Expanded item comparison */}
          {expandedItem != null &&
            expandedItem < baseline.items.length &&
            expandedItem < candidate.items.length && (
              <ItemComparison
                baselineItem={baseline.items[expandedItem]}
                candidateItem={candidate.items[expandedItem]}
                scorer={sortScorer}
                baselineRunItems={baselineRuns?.map((r) => r.items[expandedItem]).filter(Boolean)}
                candidateRunItems={candidateRuns?.map((r) => r.items[expandedItem]).filter(Boolean)}
              />
            )}
        </div>
      )}
    </div>
  );
}
