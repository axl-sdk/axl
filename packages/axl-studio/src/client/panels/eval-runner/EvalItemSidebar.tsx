import { useMemo } from 'react';
import { ChevronRight, XCircle, AlertTriangle } from 'lucide-react';
import { cn, extractLabel } from '../../lib/utils';
import type { EvalItem } from './types';
import { scoreTextColor } from './types';
import { itemOutcome } from './accounting';
import { ItemOutcomeBadge } from './OutcomeBadge';

type Props = {
  items: EvalItem[];
  scorerNames: string[];
  selectedIndex: number | null;
  onSelectItem: (index: number) => void;
  onDeselectItem: () => void;
};

/** Compute average score across all scorers for an item. */
function avgScore(item: EvalItem, scorerNames: string[]): number | null {
  const scores = scorerNames.map((n) => item.scores[n]).filter((s): s is number => s != null);
  if (scores.length === 0) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

export function EvalItemSidebar({
  items,
  scorerNames,
  selectedIndex,
  onSelectItem,
  onDeselectItem,
}: Props) {
  const itemsWithAvg = useMemo(
    () =>
      items.map((item, i) => ({
        item,
        index: i,
        avg: avgScore(item, scorerNames),
        label: extractLabel(item.input, 60),
      })),
    [items, scorerNames],
  );

  // Count real workflow failures separately from budget stops. `item.error` is
  // set for cancelled and budget-stopped items too, so counting it alone would
  // report a truncated run as a broken one.
  const failureCount = items.filter((i) =>
    itemOutcome(i) != null ? itemOutcome(i) === 'failed' : !!i.error,
  ).length;
  const budgetStoppedCount = items.filter((i) => {
    const outcome = itemOutcome(i);
    return outcome === 'budget_skipped' || outcome === 'budget_interrupted';
  }).length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-[hsl(var(--border))]">
        <div className="flex items-center justify-between">
          <button
            onClick={onDeselectItem}
            className={cn(
              'text-xs font-medium transition-colors cursor-pointer',
              selectedIndex == null
                ? 'text-[hsl(var(--foreground))]'
                : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]',
            )}
          >
            {items.length} items
          </button>
          <span className="flex items-center gap-1.5">
            {failureCount > 0 && (
              <span className="text-[10px] font-medium text-red-600 dark:text-red-400">
                {failureCount} failed
              </span>
            )}
            {budgetStoppedCount > 0 && (
              <span
                className="text-[10px] font-medium text-amber-600 dark:text-amber-400"
                title="Items the run budget skipped or interrupted — not model failures"
              >
                {budgetStoppedCount} stopped on budget
              </span>
            )}
            {failureCount === 0 && budgetStoppedCount === 0 && (
              <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                all passed
              </span>
            )}
          </span>
        </div>
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto">
        {itemsWithAvg.map(({ item, index, avg, label }) => {
          const isSelected = selectedIndex === index;
          return (
            <button
              key={index}
              onClick={() => onSelectItem(index)}
              className={cn(
                'w-full text-left px-4 py-2.5 flex items-center gap-3 border-b border-[hsl(var(--border))]/50 transition-colors group cursor-pointer',
                isSelected
                  ? 'bg-[hsl(var(--accent))] border-l-2 border-l-[hsl(var(--foreground))]'
                  : 'hover:bg-[hsl(var(--accent))]/50 border-l-2 border-l-transparent',
              )}
            >
              {/* Index */}
              <span
                className={cn(
                  'text-[10px] font-mono w-5 shrink-0',
                  isSelected
                    ? 'text-[hsl(var(--foreground))] font-medium'
                    : 'text-[hsl(var(--muted-foreground))]',
                )}
              >
                {index + 1}
              </span>

              {/* Label */}
              <span
                className={cn(
                  'flex-1 text-xs truncate leading-snug',
                  isSelected
                    ? 'text-[hsl(var(--foreground))]'
                    : 'text-[hsl(var(--muted-foreground))] group-hover:text-[hsl(var(--foreground))]',
                )}
              >
                {label}
              </span>

              {/* Error indicator — distinct icon + color so colorblind users
                  and touch users (no `title` hover) can still tell workflow
                  failures (red XCircle) apart from scorer-only failures
                  (amber AlertTriangle). */}
              {/* An outcome, once recorded, replaces the icon: a case the
                  budget never started is not a workflow error, and the red
                  XCircle would say it was. */}
              <ItemOutcomeBadge outcome={itemOutcome(item)} className="shrink-0" />
              {itemOutcome(item) == null && item.error && (
                <span
                  className="inline-flex items-center text-red-500 shrink-0"
                  title="Workflow error"
                  aria-label="Workflow error"
                >
                  <XCircle size={11} />
                </span>
              )}
              {!item.error && item.scorerErrors && item.scorerErrors.length > 0 && (
                <span
                  className="inline-flex items-center text-amber-500 shrink-0"
                  title="Scorer errors"
                  aria-label="Scorer errors"
                >
                  <AlertTriangle size={11} />
                </span>
              )}

              {/* Avg score */}
              {avg != null ? (
                <span
                  className={cn(
                    'text-[11px] font-mono font-medium shrink-0 tabular-nums',
                    scoreTextColor(avg),
                  )}
                >
                  {avg.toFixed(2)}
                </span>
              ) : (
                <span className="text-[10px] text-[hsl(var(--muted-foreground))] shrink-0">-</span>
              )}

              {/* Chevron */}
              <ChevronRight
                size={12}
                className={cn(
                  'shrink-0 transition-all',
                  isSelected
                    ? 'text-[hsl(var(--foreground))] opacity-100'
                    : 'text-[hsl(var(--muted-foreground))] opacity-0 group-hover:opacity-60',
                )}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
