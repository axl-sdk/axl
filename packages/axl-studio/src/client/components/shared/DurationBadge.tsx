import { formatDuration } from '../../lib/utils';

type Props = {
  ms: number;
  className?: string;
};

export function DurationBadge({ ms, className }: Props) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))] ${className ?? ''}`}
    >
      {formatDuration(ms)}
    </span>
  );
}
