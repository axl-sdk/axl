import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface PanelHeaderProps {
  title: string;
  // ReactNode (not just string) so complex panels can pass metadata chips
  // (workflow · dataset · N scorers) or contextual info (selected-execution
  // summary) as a subhead without writing their own <header> markup.
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

// Canonical header for every studio panel — single source of truth for
// vertical sizing, typography, and layout. `min-h-[68px]` locks the row
// height so tall action controls (rounded-pill pickers) and short ones
// (flat buttons) produce the same header height, and an always-rendered
// description slot (collapsing to a non-breaking space when absent)
// keeps the title anchored at the same baseline across all tabs.
export function PanelHeader({ title, description, actions, className }: PanelHeaderProps) {
  return (
    <header
      className={cn(
        'shrink-0 flex items-center justify-between gap-3 sm:gap-6 px-4 sm:px-6 py-4 min-h-[68px]',
        'border-b border-[hsl(var(--border))]',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-semibold leading-tight truncate" title={title}>
          {title}
        </h2>
        {/*
          Block + truncate: `white-space: nowrap` inherits to inline span
          children, overflow:hidden clips the whole inline flow, and
          text-overflow:ellipsis adds a single trailing ellipsis. Inner
          spans must NOT set `truncate` themselves — that forces display:
          block on the span and breaks the inline flow. The non-breaking
          space fallback reserves the row when description is absent so
          headers don't jitter between tall/short forms.
        */}
        <div className="mt-1 text-xs text-[hsl(var(--muted-foreground))] truncate">
          {description ?? '\u00A0'}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}
