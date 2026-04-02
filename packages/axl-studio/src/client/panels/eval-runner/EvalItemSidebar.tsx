import { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn, extractLabel } from '../../lib/utils';
import type { EvalItem } from './types';
import { scoreTextColor } from './types';

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

  const failureCount = items.filter((i) => i.error).length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-[hsl(var(--border))]">
        <div className="flex items-center justify-between">
          <button
            onClick={onDeselectItem}
            className={cn(
              'text-xs font-medium transition-colors',
              selectedIndex == null
                ? 'text-[hsl(var(--foreground))]'
                : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]',
            )}
          >
            {items.length} items
          </button>
          {failureCount > 0 ? (
            <span className="text-[10px] font-medium text-red-600 dark:text-red-400">
              {failureCount} failed
            </span>
          ) : (
            <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              all passed
            </span>
          )}
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
                'w-full text-left px-4 py-2.5 flex items-center gap-3 border-b border-[hsl(var(--border))]/50 transition-colors group',
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

              {/* Error indicator */}
              {item.error && (
                <span className="text-[10px] text-red-500 shrink-0" title="Workflow error">
                  !
                </span>
              )}
              {!item.error && item.scorerErrors && item.scorerErrors.length > 0 && (
                <span className="text-[10px] text-amber-500 shrink-0" title="Scorer errors">
                  !
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
