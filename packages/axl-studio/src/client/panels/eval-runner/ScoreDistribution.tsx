import { useMemo } from 'react';
import { cn } from '../../lib/utils';
import { scoreBarColor } from './types';
import type { EvalItem } from './types';

type Props = {
  items: EvalItem[];
  scorerNames: string[];
};

/** Compact strip chart — each scorer gets a single row with tick marks for each item's score. */
function ScorerStrip({ name, scores, mean }: { name: string; scores: number[]; mean: number }) {
  if (scores.length === 0) {
    return (
      <div className="flex items-center gap-3">
        <span
          className="w-28 text-xs font-mono truncate text-[hsl(var(--muted-foreground))]"
          title={name}
        >
          {name}
        </span>
        <span className="text-xs text-[hsl(var(--muted-foreground))]">No valid scores</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="w-28 text-xs font-mono truncate" title={name}>
        {name}
      </span>
      <div className="flex-1 h-5 relative bg-[hsl(var(--secondary))] rounded">
        {/* Scale markers */}
        {[0.25, 0.5, 0.75].map((v) => (
          <div
            key={v}
            className="absolute top-0 bottom-0 w-px bg-[hsl(var(--border))]"
            style={{ left: `${v * 100}%` }}
          />
        ))}
        {/* Score ticks */}
        {scores.map((score, i) => (
          <div
            key={i}
            className={cn('absolute w-1 top-[3px] bottom-[3px] rounded-sm', scoreBarColor(score))}
            style={{
              left: `${Math.max(1, Math.min(99, score * 100))}%`,
              transform: 'translateX(-50%)',
              opacity: 0.45,
            }}
            title={score.toFixed(3)}
          />
        ))}
        {/* Mean marker */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-[hsl(var(--foreground))]"
          style={{ left: `${mean * 100}%`, opacity: 0.3 }}
          title={`Mean: ${mean.toFixed(3)}`}
        />
      </div>
      <span className="w-12 text-xs font-mono text-right text-[hsl(var(--muted-foreground))] tabular-nums">
        {mean.toFixed(3)}
      </span>
    </div>
  );
}

export function ScoreDistribution({ items, scorerNames }: Props) {
  const distributions = useMemo(() => {
    return scorerNames.map((name) => {
      const scores: number[] = [];
      for (const item of items) {
        const score = item.scores[name];
        if (score != null && !item.error) {
          scores.push(score);
        }
      }
      const mean = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      return { name, scores, mean };
    });
  }, [items, scorerNames]);

  if (scorerNames.length === 0) return null;

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] overflow-hidden">
      <div className="px-4 py-2.5 bg-[hsl(var(--muted))] border-b border-[hsl(var(--border))]">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          Score Distribution
        </h3>
      </div>
      <div className="p-4 space-y-2">
        {/* Scale labels */}
        <div className="flex items-center gap-3 mb-1">
          <span className="w-28" />
          <div className="flex-1 flex justify-between text-[10px] font-mono text-[hsl(var(--muted-foreground))]">
            <span>0</span>
            <span>0.25</span>
            <span>0.5</span>
            <span>0.75</span>
            <span>1.0</span>
          </div>
          <span className="w-12" />
        </div>
        {distributions.map((dist) => (
          <ScorerStrip key={dist.name} name={dist.name} scores={dist.scores} mean={dist.mean} />
        ))}
      </div>
    </div>
  );
}
