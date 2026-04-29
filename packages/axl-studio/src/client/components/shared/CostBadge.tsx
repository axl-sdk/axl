import { formatCost } from '../../lib/utils';

type Props = {
  cost: number;
  className?: string;
};

export function CostBadge({ cost, className }: Props) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap px-1.5 py-0.5 rounded text-xs font-mono bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))] ${className ?? ''}`}
    >
      {formatCost(cost)}
    </span>
  );
}
