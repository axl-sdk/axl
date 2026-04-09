import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { MultiRunAggregate } from './types';

type Props = {
  currentIndex: number;
  totalRuns: number;
  aggregate: MultiRunAggregate;
  onIndexChange: (index: number) => void;
};

export function EvalMultiRunSwitcher({ currentIndex, totalRuns, aggregate, onIndexChange }: Props) {
  const isAggregate = currentIndex === -1;
  const canPrev = currentIndex > -1;
  const canNext = currentIndex < totalRuns - 1;

  return (
    <div className="px-6">
      <div className="flex items-center justify-between px-4 py-2 rounded-lg bg-[hsl(var(--muted))]">
        <button
          onClick={() => onIndexChange(currentIndex - 1)}
          disabled={!canPrev}
          className="p-1 rounded hover:bg-[hsl(var(--accent))] disabled:opacity-30 transition-colors cursor-pointer"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="text-center">
          <span className="text-sm font-medium">
            {isAggregate
              ? `Aggregate (${totalRuns} runs)`
              : `Run ${currentIndex + 1} of ${totalRuns}`}
          </span>
          {!isAggregate && (
            <button
              onClick={() => onIndexChange(-1)}
              className="ml-3 text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] underline transition-colors cursor-pointer"
            >
              View aggregate
            </button>
          )}
          {isAggregate &&
            (() => {
              const scorerValues = Object.values(aggregate.scorers);
              const overallMean =
                scorerValues.reduce((sum, s) => sum + s.mean, 0) / Math.max(scorerValues.length, 1);
              return (
                <div className="text-xs text-[hsl(var(--muted-foreground))]">
                  Overall mean: {overallMean.toFixed(3)} across {scorerValues.length} scorer
                  {scorerValues.length !== 1 ? 's' : ''}
                </div>
              );
            })()}
        </div>
        <button
          onClick={() => onIndexChange(currentIndex + 1)}
          disabled={!canNext}
          className="p-1 rounded hover:bg-[hsl(var(--accent))] disabled:opacity-30 transition-colors cursor-pointer"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
