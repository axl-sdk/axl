import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import {
  SCORER_OUTCOME_LABELS,
  formatBudgetLine,
  isBudgetStopped,
  readAccounting,
} from './accounting';
import { ItemOutcomeBadge, ScorerOutcomeBadge } from './OutcomeBadge';
import { SpendBadge } from './SpendBadge';
import type { EvalAccounting, EvalCoverage, EvalItemOutcome, EvalResultData } from './types';

const ITEM_OUTCOMES: EvalItemOutcome[] = [
  'completed',
  'failed',
  'cancelled',
  'budget_skipped',
  'budget_interrupted',
];

/**
 * A compact badge saying the run stopped on budget.
 *
 * Kept separate from the failure count so a truncated run reads as truncated
 * in scannable places (history rows, group rows) without the reader having to
 * open it — the same distinction the CLI makes by printing the budget stop
 * first and labelling it "NOT a model or scorer failure".
 */
export function BudgetStoppedBadge({
  accounting,
  className,
}: {
  accounting: EvalAccounting;
  className?: string;
}) {
  if (!isBudgetStopped(accounting)) return null;
  const line = formatBudgetLine(accounting);
  return (
    <span
      title={`Budget: ${line}. The run is incomplete by design; this is NOT a model or scorer failure.`}
      aria-label="Budget stopped"
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded-md text-[9px] font-medium uppercase tracking-wide bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200',
        className,
      )}
    >
      budget stopped
    </span>
  );
}

/** One labelled row in the accounting footer. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 flex-wrap">
      <span className="text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))] shrink-0">
        {label}
      </span>
      <span className="text-xs text-[hsl(var(--foreground))]">{children}</span>
    </div>
  );
}

/** Item and scorer counters, every outcome with its own label and count. */
function CoverageCounters({ coverage }: { coverage: EvalCoverage }) {
  const scorerNames = Object.keys(coverage.scorers ?? {});
  return (
    <div className="space-y-1.5">
      <Row label="Items">
        <span className="inline-flex items-center gap-1.5 flex-wrap">
          {ITEM_OUTCOMES.map((outcome) => (
            <span key={outcome} className="inline-flex items-center gap-1">
              <ItemOutcomeBadge outcome={outcome} />
              <span className="font-mono tabular-nums text-[hsl(var(--muted-foreground))]">
                {coverage.items?.[outcome] ?? 0}
              </span>
            </span>
          ))}
        </span>
      </Row>
      {scorerNames.map((name) => {
        const counts = coverage.scorers[name] ?? {};
        // Only the outcomes that actually occurred, plus the two budget ones
        // whenever a judge was stopped — a row of six zeros per scorer would
        // bury the one number that matters.
        const shown = (Object.keys(SCORER_OUTCOME_LABELS) as (keyof typeof counts)[]).filter(
          (o) => (counts[o] ?? 0) > 0,
        );
        if (shown.length === 0) return null;
        return (
          <Row key={name} label={name}>
            <span className="inline-flex items-center gap-1.5 flex-wrap">
              {shown.map((outcome) => (
                <span key={outcome} className="inline-flex items-center gap-1">
                  <ScorerOutcomeBadge outcome={outcome} />
                  <span className="font-mono tabular-nums text-[hsl(var(--muted-foreground))]">
                    {counts[outcome]}
                  </span>
                </span>
              ))}
            </span>
          </Row>
        );
      })}
    </div>
  );
}

/**
 * The run's spend, budget outcome and coverage, as one honest block.
 *
 * This replaces the old "Total cost: $X" footer, which showed a bare figure
 * and hid it entirely when it was zero — so a run whose model had no price
 * displayed nothing at all where the truth was "we could not price N
 * operations". Everything here renders even at $0.
 */
export function RunAccountingPanel({ result }: { result: EvalResultData }) {
  const accounting = readAccounting(result);
  const coverage = result.summary?.coverage;
  const budgetLine = formatBudgetLine(accounting);
  const callerReported = accounting.callerReported;
  const failures = result.summary?.failures ?? 0;

  return (
    <div className="px-4 py-3 border-t border-[hsl(var(--border))] bg-[hsl(var(--muted))]/50 space-y-2">
      <Row label="Known spend">
        <SpendBadge accounting={accounting} />
        {accounting.breakdown &&
          (accounting.breakdown.generation > 0 || accounting.breakdown.judging > 0) && (
            <span className="ml-2 text-[hsl(var(--muted-foreground))] font-mono text-[11px]">
              <SpendBadge
                accounting={{ ...accounting, knownCost: accounting.breakdown.generation }}
                label="Generation spend"
                compact
              />
              {' generation · '}
              <SpendBadge
                accounting={{ ...accounting, knownCost: accounting.breakdown.judging }}
                label="Judging spend"
                compact
              />
              {' judging'}
            </span>
          )}
      </Row>

      {budgetLine && (
        <Row label="Budget">
          <span
            className={cn(
              'font-mono text-[11px]',
              isBudgetStopped(accounting)
                ? 'text-amber-700 dark:text-amber-300'
                : 'text-[hsl(var(--muted-foreground))]',
            )}
          >
            {budgetLine}
          </span>
        </Row>
      )}

      {coverage && <CoverageCounters coverage={coverage} />}

      <Row label="With errors">
        <span
          className="font-mono tabular-nums text-[hsl(var(--muted-foreground))]"
          title="Legacy count of items carrying an error string. It still includes cancelled and budget-stopped items, which also carry one — read the item outcomes above to tell a model failure from a budget stop."
        >
          {failures}
        </span>
        <span className="ml-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">
          items carrying an error string (includes cancelled / budget-stopped)
        </span>
      </Row>

      {callerReported && callerReported.costItems > 0 && (
        <Row label="Caller-reported">
          <span
            className="font-mono text-[11px] text-[hsl(var(--muted-foreground))]"
            title="Values the executeWorkflow callback claimed. Kept for inspection and never summed into known spend, which measures Axl-observed operations."
          >
            ${callerReported.costTotal.toFixed(2)} across {callerReported.costItems} item
            {callerReported.costItems === 1 ? '' : 's'} — caller-reported (not counted)
          </span>
        </Row>
      )}
    </div>
  );
}
