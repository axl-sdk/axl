import { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn, formatCost, formatDuration, extractLabel } from '../../lib/utils';
import type { EvalItem } from './types';
import { scoreTextColor } from './types';

type ErrorFilter = 'all' | 'errors' | 'no-errors';
type SortDir = 'asc' | 'desc';

type Props = {
  items: EvalItem[];
  scorerNames: string[];
  onSelectItem: (index: number) => void;
  errorFilter: ErrorFilter;
  onErrorFilterChange: (value: ErrorFilter) => void;
  scorerFilter: string;
  onScorerFilterChange: (value: string) => void;
  threshold: string;
  onThresholdChange: (value: string) => void;
  sortField: string;
  onSortFieldChange: (value: string) => void;
  sortDir: SortDir;
  onSortDirChange: (value: SortDir) => void;
};

export function EvalItemList({
  items,
  scorerNames,
  onSelectItem,
  errorFilter,
  onErrorFilterChange,
  scorerFilter,
  onScorerFilterChange,
  threshold,
  onThresholdChange,
  sortField,
  onSortFieldChange,
  sortDir,
  onSortDirChange,
}: Props) {
  const thresholdNum = threshold !== '' ? parseFloat(threshold) : null;
  const hasActiveFilter =
    errorFilter !== 'all' || (scorerFilter !== '' && thresholdNum != null && !isNaN(thresholdNum));

  // Indexed items for stable identity
  const indexedItems = useMemo(() => items.map((item, i) => ({ item, index: i })), [items]);

  // Filter
  const filtered = useMemo(() => {
    let result = indexedItems;

    if (errorFilter === 'errors') {
      result = result.filter(({ item }) => !!item.error);
    } else if (errorFilter === 'no-errors') {
      result = result.filter(({ item }) => !item.error);
    }

    if (scorerFilter && thresholdNum != null && !isNaN(thresholdNum)) {
      result = result.filter(({ item }) => {
        const score = item.scores[scorerFilter];
        return score != null && score < thresholdNum;
      });
    }

    return result;
  }, [indexedItems, errorFilter, scorerFilter, thresholdNum]);

  // Sort
  const sorted = useMemo(() => {
    const copy = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;

    copy.sort((a, b) => {
      let av: number;
      let bv: number;

      if (sortField === 'index') {
        av = a.index;
        bv = b.index;
      } else if (sortField === 'duration') {
        av = a.item.duration ?? Infinity;
        bv = b.item.duration ?? Infinity;
      } else if (sortField === 'cost') {
        av = a.item.cost ?? Infinity;
        bv = b.item.cost ?? Infinity;
      } else {
        // scorer name
        av = a.item.scores[sortField] ?? -Infinity;
        bv = b.item.scores[sortField] ?? -Infinity;
      }

      return (av - bv) * dir;
    });

    return copy;
  }, [filtered, sortField, sortDir]);

  const sortOptions = [
    { value: 'index', label: 'Item #' },
    { value: 'duration', label: 'Duration' },
    { value: 'cost', label: 'Cost' },
    ...scorerNames.map((name) => ({ value: name, label: name })),
  ];

  return (
    <div>
      {/* ── Toolbar ──────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            All Items
          </h3>
          <span className="text-xs text-[hsl(var(--muted-foreground))] font-mono tabular-nums">
            {hasActiveFilter ? `${filtered.length} of ${items.length}` : String(items.length)}
          </span>
          {hasActiveFilter && (
            <button
              onClick={() => {
                onErrorFilterChange('all');
                onScorerFilterChange('');
                onThresholdChange('');
              }}
              className="text-xs text-[hsl(var(--primary))] hover:underline cursor-pointer"
            >
              Reset
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={errorFilter}
            onChange={(e) => onErrorFilterChange(e.target.value as ErrorFilter)}
            className="px-2 py-1 text-xs rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
          >
            <option value="all">All</option>
            <option value="errors">Errors</option>
            <option value="no-errors">Passed</option>
          </select>

          {scorerNames.length > 0 && (
            <>
              <select
                value={scorerFilter}
                onChange={(e) => onScorerFilterChange(e.target.value)}
                className="px-2 py-1 text-xs rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
              >
                <option value="">Score filter…</option>
                {scorerNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              {scorerFilter && (
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="1"
                  placeholder="< threshold"
                  value={threshold}
                  onChange={(e) => onThresholdChange(e.target.value)}
                  className="w-20 px-2 py-1 text-xs rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
                />
              )}
            </>
          )}

          <div className="w-px h-4 bg-[hsl(var(--border))]" />

          <select
            value={sortField}
            onChange={(e) => onSortFieldChange(e.target.value)}
            className="px-2 py-1 text-xs rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
          >
            {sortOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => onSortDirChange(sortDir === 'asc' ? 'desc' : 'asc')}
            className="px-2 py-1 text-xs rounded-lg border border-[hsl(var(--input))] hover:bg-[hsl(var(--accent))] transition-colors cursor-pointer"
            title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
          >
            {sortDir === 'asc' ? '\u2191' : '\u2193'}
          </button>
        </div>
      </div>

      {/* ── Empty filter state ───────────────────────────── */}
      {sorted.length === 0 && hasActiveFilter && (
        <p className="text-xs text-[hsl(var(--muted-foreground))] py-6 text-center">
          No items match the current filters.
        </p>
      )}

      {/* ── Data table ───────────────────────────────────── */}
      {sorted.length > 0 && (
        <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[hsl(var(--muted))]">
                  <th className="text-left px-3 py-2.5 font-medium w-10">#</th>
                  <th className="text-left px-3 py-2.5 font-medium min-w-[180px]">Input</th>
                  {scorerNames.map((name) => (
                    <th
                      key={name}
                      className="text-right px-2 py-2.5 font-medium font-mono max-w-24 truncate"
                      title={name}
                    >
                      {name}
                    </th>
                  ))}
                  <th className="text-right px-3 py-2.5 font-medium w-16">Duration</th>
                  <th className="text-right px-3 py-2.5 font-medium w-16">Cost</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {sorted.map(({ item, index }) => (
                  <tr
                    key={index}
                    onClick={() => onSelectItem(index)}
                    className="border-t border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))] cursor-pointer transition-colors group"
                  >
                    <td className="px-3 py-2 font-mono text-[hsl(var(--muted-foreground))]">
                      {index + 1}
                      {item.error && (
                        <span className="ml-1 text-red-500" title="Workflow error">
                          !
                        </span>
                      )}
                      {!item.error && item.scorerErrors && item.scorerErrors.length > 0 && (
                        <span className="ml-1 text-amber-500" title="Scorer errors">
                          !
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 max-w-xs">
                      <span className="text-[11px] leading-tight text-[hsl(var(--muted-foreground))] truncate block group-hover:text-[hsl(var(--foreground))] transition-colors">
                        {extractLabel(item.input)}
                      </span>
                    </td>
                    {scorerNames.map((name) => {
                      const score = item.scores[name];
                      return (
                        <td key={name} className="text-right px-2 py-2 font-mono">
                          {score != null ? (
                            <span className={cn('font-medium tabular-nums', scoreTextColor(score))}>
                              {score.toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-[hsl(var(--muted-foreground))]">—</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="text-right px-3 py-2 font-mono text-[hsl(var(--muted-foreground))]">
                      {item.duration != null ? formatDuration(item.duration) : '\u2014'}
                    </td>
                    <td className="text-right px-3 py-2 font-mono text-[hsl(var(--muted-foreground))]">
                      {item.cost != null && item.cost > 0 ? formatCost(item.cost) : '\u2014'}
                    </td>
                    <td className="px-2 py-2">
                      <ChevronRight
                        size={12}
                        className="text-[hsl(var(--muted-foreground))] opacity-0 group-hover:opacity-60 transition-opacity"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
