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
// vertical sizing, typography, and layout.
//
// Desktop (sm+): one row, title left, actions pinned right via
// `justify-between`. `min-h-[68px]` (sm+) locks the row height so tall
// action controls (rounded-pill pickers) and short ones (flat buttons)
// render the same height across tabs.
//
// Phones (<sm): the workflow-runner / eval-runner pack 200-320px of
// actions next to the title. Forcing one row would either crush the title
// to "…" or push actions off-screen. `flex-wrap` lets actions drop below
// the title when the row would overflow; the title gets `basis-[200px]`
// so it claims the full row when it has to (instead of degenerating to
// a 1px ellipsis-only column).
//
// An always-rendered description slot (non-breaking space when absent)
// keeps the title anchored at the same baseline across tabs.
export function PanelHeader({ title, description, actions, className }: PanelHeaderProps) {
  return (
    <header
      className={cn(
        'shrink-0 flex flex-wrap items-center justify-between gap-y-3 gap-x-3 sm:gap-x-6 px-4 sm:px-6 py-4 sm:min-h-[68px]',
        'border-b border-[hsl(var(--border))]',
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-[200px]">
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
      {actions && (
        <div className="flex items-center gap-2 flex-wrap shrink-0 ml-auto">{actions}</div>
      )}
    </header>
  );
}
