import { cn, formatCost } from '../../lib/utils';
import { completenessChip, completenessLabel, spendDescription } from './accounting';
import type { Accounting } from './types';

/**
 * The single way an eval view renders money.
 *
 * Every eval spend figure in Studio goes through this component, because the
 * figure alone is not the fact: `$0.00` from a fully-priced run and `$0.00`
 * from a run whose model had no price are opposite claims. The badge therefore
 * always carries the completeness — visibly as a chip when the record is not
 * `complete`, and always in the accessible name, so a screen reader and an
 * automated check see the same statement a sighted reader does.
 *
 * A run that predates measured accounting reads `unverified`; it is never
 * shown as `complete` and never silently hidden for being $0.
 */
export function SpendBadge({
  accounting,
  label = 'Known spend',
  className,
  compact,
}: {
  accounting: Accounting;
  /** Prefix used in the accessible name, e.g. `Judging spend`. */
  label?: string;
  className?: string;
  /** Drop the visible chip (keeping the accessible name) where space is tight,
   *  e.g. a dense table cell that already shows a row-level badge. */
  compact?: boolean;
}) {
  const chip = completenessChip(accounting);
  return (
    <span
      className={cn('inline-flex items-center gap-1 whitespace-nowrap', className)}
      title={spendDescription(accounting, label)}
      aria-label={`${label} ${formatCost(accounting.knownCost)}, ${completenessLabel(accounting)}`}
    >
      <span className="font-mono tabular-nums">
        {accounting.completeness === 'incomplete' ? '≥ ' : ''}
        {formatCost(accounting.knownCost)}
      </span>
      {chip && !compact && <CompletenessChip accounting={accounting} />}
    </span>
  );
}

/**
 * The standalone completeness chip. Renders nothing for a `complete` record —
 * a complete figure needs no caveat, and a chip on every row would train
 * readers to ignore it.
 */
export function CompletenessChip({
  accounting,
  className,
}: {
  accounting: Accounting;
  className?: string;
}) {
  const chip = completenessChip(accounting);
  if (!chip) return null;
  const isUnverified = accounting.completeness === 'unverified';
  return (
    <span
      title={spendDescription(accounting)}
      className={cn(
        'inline-flex items-center px-1 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide',
        isUnverified
          ? 'bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]'
          : 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200',
        className,
      )}
    >
      {chip}
    </span>
  );
}
