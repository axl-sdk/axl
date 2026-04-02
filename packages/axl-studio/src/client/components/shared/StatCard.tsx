import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function StatCard({
  label,
  value,
  subtitle,
  subtitleColor,
  accent,
  tint,
  badge,
}: {
  label: string;
  value?: string;
  subtitle?: string;
  subtitleColor?: string;
  accent?: string;
  tint?: string;
  badge?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'px-4 py-3.5 rounded-xl',
        tint ? tint : 'bg-[hsl(var(--card))] border border-[hsl(var(--border))]',
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
        {label}
      </p>
      {badge ? (
        <div className="mt-1">{badge}</div>
      ) : (
        <p className={cn('text-2xl font-semibold mt-1 font-mono tracking-tight', accent)}>
          {value}
        </p>
      )}
      {subtitle && (
        <p className={cn('text-xs mt-0.5', subtitleColor ?? 'text-[hsl(var(--muted-foreground))]')}>
          {subtitle}
        </p>
      )}
    </div>
  );
}
