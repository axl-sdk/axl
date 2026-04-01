import { useMemo } from 'react';
import { formatCost, formatDuration } from '../../lib/utils';
import type { EvalItem } from './types';
import { scoreColorClass } from './types';

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
    { value: 'index', label: 'Item index' },
    { value: 'duration', label: 'Duration' },
    { value: 'cost', label: 'Cost' },
    ...scorerNames.map((name) => ({ value: name, label: `Score: ${name}` })),
  ];

  return (
    <div>
      <h3 className="text-sm font-medium mb-2">Items ({items.length})</h3>

      {/* Filter controls */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <select
          value={errorFilter}
          onChange={(e) => onErrorFilterChange(e.target.value as ErrorFilter)}
          className="px-2 py-1 text-xs rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
        >
          <option value="all">All items</option>
          <option value="errors">Errors only</option>
          <option value="no-errors">No errors</option>
        </select>

        {scorerNames.length > 0 && (
          <>
            <select
              value={scorerFilter}
              onChange={(e) => onScorerFilterChange(e.target.value)}
              className="px-2 py-1 text-xs rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
            >
              <option value="">Score filter...</option>
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
                className="w-24 px-2 py-1 text-xs rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
              />
            )}
          </>
        )}

        {/* Sort controls */}
        <div className="flex items-center gap-1 ml-auto">
          <select
            value={sortField}
            onChange={(e) => onSortFieldChange(e.target.value)}
            className="px-2 py-1 text-xs rounded border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
          >
            {sortOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => onSortDirChange(sortDir === 'asc' ? 'desc' : 'asc')}
            className="px-2 py-1 text-xs rounded border border-[hsl(var(--input))] hover:bg-[hsl(var(--accent))]"
            title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
          >
            {sortDir === 'asc' ? '\u2191' : '\u2193'}
          </button>
        </div>
      </div>

      {/* Match count and reset */}
      {hasActiveFilter && (
        <div className="flex items-center gap-2 mb-2 text-xs text-[hsl(var(--muted-foreground))]">
          <span>
            {filtered.length} of {items.length} items
          </span>
          <button
            onClick={() => {
              onErrorFilterChange('all');
              onScorerFilterChange('');
              onThresholdChange('');
            }}
            className="text-[hsl(var(--primary))] hover:underline"
          >
            Reset filters
          </button>
        </div>
      )}

      {/* Empty state when filters match nothing */}
      {sorted.length === 0 && hasActiveFilter && (
        <p className="text-xs text-[hsl(var(--muted-foreground))] py-4 text-center">
          No items match the current filters.
        </p>
      )}

      {/* Item rows */}
      <div className="space-y-1">
        {sorted.map(({ item, index }) => (
          <button
            key={index}
            onClick={() => onSelectItem(index)}
            className="w-full text-left flex items-center justify-between px-3 py-2 text-xs rounded-md border border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))] cursor-pointer"
          >
            <span className="font-mono">
              Item #{index + 1}
              {item.error && <span className="ml-2 text-red-600 dark:text-red-400">(error)</span>}
              {item.scorerErrors && item.scorerErrors.length > 0 && !item.error && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">(scorer errors)</span>
              )}
            </span>
            <div className="flex items-center gap-2">
              {Object.entries(item.scores)
                .filter(([, score]) => score != null)
                .map(([scorer, score]) => (
                  <span
                    key={scorer}
                    className={`px-1.5 py-0.5 rounded font-mono ${scoreColorClass(score!)}`}
                  >
                    {scorer}: {score!.toFixed(2)}
                  </span>
                ))}
              {item.duration != null && (
                <span className="px-1.5 py-0.5 rounded font-mono bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]">
                  {formatDuration(item.duration)}
                </span>
              )}
              {item.cost != null && item.cost > 0 && (
                <span className="px-1.5 py-0.5 rounded font-mono bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))]">
                  {formatCost(item.cost)}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
