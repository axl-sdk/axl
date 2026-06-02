import { formatCost } from '../../lib/utils';

type Props = {
  cost: number;
  /** When true, an unpriced model ran: `cost` is a lower bound, shown as `≥ $X`
   *  with an explanatory tooltip rather than a misleading exact figure. */
  unpriced?: boolean;
  className?: string;
};

export function CostBadge({ cost, unpriced, className }: Props) {
  return (
    <span
      title={unpriced ? 'Lower bound — this ask used an unpriced model (cost unknown)' : undefined}
      className={`inline-flex items-center whitespace-nowrap px-1.5 py-0.5 rounded text-xs font-mono bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))] ${className ?? ''}`}
    >
      {unpriced ? `≥ ${formatCost(cost)}` : formatCost(cost)}
    </span>
  );
}
