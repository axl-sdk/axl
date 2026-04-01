import { useMemo } from 'react';
import type { EvalItem } from './types';

type Props = {
  items: EvalItem[];
  scorerNames: string[];
};

const BUCKET_COUNT = 10;
const BUCKET_LABELS = [
  '[0, 0.1)',
  '[0.1, 0.2)',
  '[0.2, 0.3)',
  '[0.3, 0.4)',
  '[0.4, 0.5)',
  '[0.5, 0.6)',
  '[0.6, 0.7)',
  '[0.7, 0.8)',
  '[0.8, 0.9)',
  '[0.9, 1.0]',
];

function bucketIndex(score: number): number {
  // Clamp to [0, 1] and compute bucket; score of exactly 1.0 goes in last bucket
  const clamped = Math.max(0, Math.min(1, score));
  const idx = Math.floor(clamped * BUCKET_COUNT);
  return Math.min(idx, BUCKET_COUNT - 1);
}

function Distribution({
  name,
  buckets,
  maxCount,
}: {
  name: string;
  buckets: number[];
  maxCount: number;
}) {
  const hasScores = buckets.some((c) => c > 0);

  return (
    <div>
      <h4 className="text-xs font-mono font-medium mb-2">{name}</h4>
      {hasScores ? (
        <div className="space-y-0.5">
          {buckets.map((count, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="w-16 text-right font-mono text-[hsl(var(--muted-foreground))]">
                {BUCKET_LABELS[i]}
              </span>
              <div className="flex-1 h-4 bg-[hsl(var(--secondary))] rounded overflow-hidden">
                {count > 0 && (
                  <div
                    className="h-full bg-[hsl(var(--primary))] rounded"
                    style={{
                      width: `${(count / maxCount) * 100}%`,
                      opacity: 0.8,
                    }}
                  />
                )}
              </div>
              <span className="w-6 text-right font-mono text-[hsl(var(--muted-foreground))]">
                {count}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-[hsl(var(--muted-foreground))]">No valid scores</p>
      )}
    </div>
  );
}

export function ScoreDistribution({ items, scorerNames }: Props) {
  const distributions = useMemo(() => {
    return scorerNames.map((name) => {
      const buckets = new Array<number>(BUCKET_COUNT).fill(0);
      for (const item of items) {
        const score = item.scores[name];
        if (score != null && !item.error) {
          buckets[bucketIndex(score)]++;
        }
      }
      const maxCount = Math.max(...buckets, 1);
      return { name, buckets, maxCount };
    });
  }, [items, scorerNames]);

  if (scorerNames.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-medium mb-3">Score Distribution</h3>
      <div className="grid grid-cols-1 gap-4">
        {distributions.map((dist) => (
          <Distribution
            key={dist.name}
            name={dist.name}
            buckets={dist.buckets}
            maxCount={dist.maxCount}
          />
        ))}
      </div>
    </div>
  );
}
