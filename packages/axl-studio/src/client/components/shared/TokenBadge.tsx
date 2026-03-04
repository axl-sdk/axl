import { formatTokens } from '../../lib/utils';

type Props = {
  tokens: number;
  label?: string;
  className?: string;
};

export function TokenBadge({ tokens, label, className }: Props) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono bg-[hsl(var(--secondary))] text-[hsl(var(--secondary-foreground))] ${className ?? ''}`}
    >
      {label && <span className="text-[hsl(var(--muted-foreground))]">{label}</span>}
      {formatTokens(tokens)}
    </span>
  );
}
