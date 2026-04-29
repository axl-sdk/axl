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
        'px-4 py-3.5 rounded-xl min-w-0',
        tint ? tint : 'bg-[hsl(var(--card))] border border-[hsl(var(--border))]',
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))] truncate">
        {label}
      </p>
      {badge ? (
        <div className="mt-1">{badge}</div>
      ) : (
        <p
          className={cn(
            // Phones get a smaller value font so long mono strings (e.g.
            // `anthropic:claude-3-5-sonnet-20241022`) fit more characters
            // before the truncate kicks in. `select-text` lets touch users
            // long-press to select and copy the truncated value, since
            // `title` only surfaces on desktop hover.
            'text-lg sm:text-2xl font-semibold mt-1 font-mono tracking-tight truncate select-text',
            accent,
          )}
          title={value}
        >
          {value}
        </p>
      )}
      {subtitle && (
        <p
          className={cn(
            'text-xs mt-0.5 truncate',
            subtitleColor ?? 'text-[hsl(var(--muted-foreground))]',
          )}
          title={subtitle}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
}
