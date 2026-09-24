import { cn } from '../../lib/utils';
import {
  ITEM_OUTCOME_LABELS,
  ITEM_OUTCOME_TITLES,
  SCORER_OUTCOME_LABELS,
  SCORER_OUTCOME_TITLES,
} from './accounting';
import type { EvalItemOutcome, ScorerOutcome } from './types';

/**
 * Colour per outcome. The two budget outcomes share an amber family distinct
 * from failure red on purpose: a run the budget truncated is short by design,
 * and painting it the same colour as a broken model is the misreading these
 * badges exist to prevent. Colour is never the only signal — each badge also
 * carries its own words.
 */
const ITEM_OUTCOME_CLASSES: Record<EvalItemOutcome, string> = {
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  cancelled: 'bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]',
  budget_skipped: 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200',
  budget_interrupted: 'bg-orange-100 text-orange-900 dark:bg-orange-950/60 dark:text-orange-200',
};

const SCORER_OUTCOME_CLASSES: Record<ScorerOutcome, string> = {
  scored: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  skipped: 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]',
  cancelled: 'bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]',
  budget_skipped: 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200',
  budget_interrupted: 'bg-orange-100 text-orange-900 dark:bg-orange-950/60 dark:text-orange-200',
};

/** How one dataset item ended, in its own words. Renders nothing for a
 *  pre-0.24 item that recorded no outcome — see `itemOutcome()`. */
export function ItemOutcomeBadge({
  outcome,
  className,
}: {
  outcome: EvalItemOutcome | null;
  className?: string;
}) {
  if (!outcome) return null;
  return (
    <span
      title={ITEM_OUTCOME_TITLES[outcome]}
      aria-label={`Item outcome: ${ITEM_OUTCOME_LABELS[outcome]}`}
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap',
        ITEM_OUTCOME_CLASSES[outcome],
        className,
      )}
    >
      {ITEM_OUTCOME_LABELS[outcome]}
    </span>
  );
}

/**
 * How one scorer ended for one item.
 *
 * `budget_skipped` reads "not run (budget)" — never a `0`, and never folded in
 * with a genuine failure. A judge that never ran carries no information about
 * the output's quality, so presenting it as a zero score would silently drag
 * every mean that included it.
 */
export function ScorerOutcomeBadge({
  outcome,
  className,
}: {
  outcome: ScorerOutcome | null;
  className?: string;
}) {
  if (!outcome) return null;
  return (
    <span
      title={SCORER_OUTCOME_TITLES[outcome]}
      aria-label={`Scorer outcome: ${SCORER_OUTCOME_LABELS[outcome]}`}
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap',
        SCORER_OUTCOME_CLASSES[outcome],
        className,
      )}
    >
      {SCORER_OUTCOME_LABELS[outcome]}
    </span>
  );
}
