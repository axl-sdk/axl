/**
 * Client-side mirror of `@axlsdk/eval`'s accounting reader.
 *
 * The Studio SPA is a browser bundle and deliberately does not import the eval
 * package (see the `client-no-core-import-tripwire` test), so the reading rules
 * are re-stated here. They are re-stated, not re-invented: every function below
 * mirrors a named export of `packages/axl-eval/src/accounting.ts` or
 * `cli-format.ts`, and the wording of the rendered strings is kept parallel to
 * the `axl-eval` CLI so a run reads the same in both places.
 *
 * The one rule the whole module exists to enforce: **a spend figure is never
 * shown without saying how complete it is.** A pre-0.24 artifact carries no
 * `accounting` at all; it reads `'unverified'` and is NEVER upgraded to
 * `'complete'`, because an unverified $0 and a measured $0 are different facts
 * and only one of them means "this was free".
 */

import { formatCost } from '../../lib/utils';
import type {
  Accounting,
  AccountingCompleteness,
  EvalAccounting,
  EvalItem,
  EvalItemOutcome,
  EvalResultData,
  ScorerDetail,
  ScorerOutcome,
} from './types';

// ── Construction ─────────────────────────────────────────────────

function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    audioSeconds: 0,
  };
}

/** A structurally complete, empty record — mirrors eval's `emptyAccounting()`. */
export function emptyAccounting(): Accounting {
  return {
    version: 1,
    currency: 'USD',
    knownCost: 0,
    completeness: 'complete',
    reasons: {},
    usage: zeroUsage(),
    operations: { total: 0, settled: 0, unknown: 0, denied: 0, byKind: {} },
    breakdown: { generation: 0, judging: 0, external: 0 },
    provenance: {},
  };
}

function usableCost(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

// ── Reading ──────────────────────────────────────────────────────

/**
 * The accounting of any run, including one persisted before the field existed.
 *
 * Mirrors `readAccounting()` in `@axlsdk/eval`. A legacy artifact repeats its
 * `totalCost` as `knownCost` for continuity but reads `'unverified'`: no
 * operation counts and no generation/judging split are invented.
 */
export function readAccounting(result: EvalResultData): EvalAccounting {
  if (result?.accounting) return result.accounting;
  const rescored = (result?.metadata as { rescored?: unknown } | undefined)?.rescored === true;
  return {
    ...emptyAccounting(),
    knownCost: usableCost(result?.totalCost),
    completeness: 'unverified',
    scope: rescored ? 'rescore' : 'run',
  };
}

/**
 * One item's accounting (generation + judging; `breakdown` splits them).
 *
 * A pre-0.24 item carries only the caller's `cost` / `scorerCost`, so it reads
 * `'unverified'` — the figures are repeated, never certified.
 */
export function readItemAccounting(item: EvalItem): Accounting {
  if (item?.accounting) return item.accounting;
  const generation = usableCost(item?.cost);
  const judging = usableCost(item?.scorerCost);
  return {
    ...emptyAccounting(),
    knownCost: generation + judging,
    completeness: 'unverified',
    breakdown: { generation, judging, external: 0 },
  };
}

/** One scorer's accounting for one item. Legacy detail cost reads `'unverified'`. */
export function readScorerAccounting(detail: ScorerDetail | undefined): Accounting {
  if (detail?.accounting) return detail.accounting;
  const judging = usableCost(detail?.cost);
  return {
    ...emptyAccounting(),
    knownCost: judging,
    completeness: 'unverified',
    breakdown: { generation: 0, judging, external: 0 },
  };
}

// ── Union ────────────────────────────────────────────────────────

function addCounts(
  target: Record<string, number>,
  source: Record<string, number> | undefined,
): void {
  if (!source) return;
  for (const [key, count] of Object.entries(source)) {
    if (typeof count === 'number' && Number.isFinite(count)) {
      target[key] = (target[key] ?? 0) + count;
    }
  }
}

/**
 * Fold several records into one, conservatively — mirrors eval's
 * `aggregateAccounting()`.
 *
 * Numbers sum, reasons union, and completeness takes the WORST of the inputs
 * (`unverified` > `incomplete` > `complete`). Inheriting the first input's
 * flags — reporting a group as complete because run 1 was — is the specific
 * defect this exists to prevent.
 */
export function aggregateAccounting(inputs: readonly Accounting[]): Accounting {
  const out = emptyAccounting();
  let anyUnverified = false;
  let anyIncomplete = false;

  for (const input of inputs) {
    if (!input) continue;
    if (input.completeness === 'unverified') anyUnverified = true;
    else if (input.completeness === 'incomplete') anyIncomplete = true;

    out.knownCost += usableCost(input.knownCost);
    addCounts(out.reasons as Record<string, number>, input.reasons as Record<string, number>);
    addCounts(
      out.operations.byKind as Record<string, number>,
      input.operations?.byKind as Record<string, number>,
    );
    addCounts(out.provenance as Record<string, number>, input.provenance as Record<string, number>);
    if (input.usage) {
      for (const key of Object.keys(out.usage) as (keyof Accounting['usage'])[]) {
        const value = input.usage[key];
        if (typeof value === 'number' && Number.isFinite(value)) out.usage[key] += value;
      }
    }
    out.operations.total += input.operations?.total ?? 0;
    out.operations.settled += input.operations?.settled ?? 0;
    out.operations.unknown += input.operations?.unknown ?? 0;
    out.operations.denied += input.operations?.denied ?? 0;
    out.breakdown.generation += usableCost(input.breakdown?.generation);
    out.breakdown.judging += usableCost(input.breakdown?.judging);
    out.breakdown.external += usableCost(input.breakdown?.external);
  }

  out.completeness = anyUnverified ? 'unverified' : anyIncomplete ? 'incomplete' : 'complete';
  return out;
}

/** The worse of two completeness values (`unverified` > `incomplete` > `complete`). */
export function worseCompleteness(
  a: AccountingCompleteness,
  b: AccountingCompleteness,
): AccountingCompleteness {
  if (a === 'unverified' || b === 'unverified') return 'unverified';
  if (a === 'incomplete' || b === 'incomplete') return 'incomplete';
  return 'complete';
}

// ── Rendering ────────────────────────────────────────────────────

/** `"2 unpriced_model, 1 usage_missing"`, or `""` when nothing is unknown. */
export function reasonSummary(accounting: Accounting): string {
  return Object.entries(accounting.reasons ?? {})
    .filter(([, count]) => typeof count === 'number' && count > 0)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ');
}

/**
 * The completeness sentence shown next to every spend figure.
 *
 * Parallel to the CLI's `formatKnownSpend()` suffixes: `complete`,
 * `incomplete: 2 unpriced_model`, `unverified (legacy)`.
 */
export function completenessLabel(accounting: Accounting): string {
  if (accounting.completeness === 'complete') return 'complete';
  if (accounting.completeness === 'unverified') return 'unverified (legacy)';
  return `incomplete: ${reasonSummary(accounting) || 'unknown spend'}`;
}

/** The short chip text — `null` for a complete record, which needs no chip. */
export function completenessChip(accounting: Accounting): string | null {
  if (accounting.completeness === 'complete') return null;
  return accounting.completeness === 'unverified' ? 'unverified' : 'incomplete';
}

/**
 * Known spend plus its completeness, as one string. Mirrors the CLI's
 * `formatKnownSpend()` — `$1.50`, `$0.00 (unverified)`,
 * `$0.00 (incomplete: 2 unpriced_model)`.
 */
export function formatKnownSpend(accounting: Accounting): string {
  const cost = formatCost(accounting.knownCost);
  if (accounting.completeness === 'complete') return cost;
  if (accounting.completeness === 'unverified') return `${cost} (unverified)`;
  return `${cost} (incomplete: ${reasonSummary(accounting) || 'unknown spend'})`;
}

/** The full explanatory sentence used as a `title` / `aria-label`. */
export function spendDescription(accounting: Accounting, label = 'Known spend'): string {
  const base = `${label} ${formatCost(accounting.knownCost)}, ${completenessLabel(accounting)}`;
  if (accounting.completeness === 'incomplete') {
    return `${base}. This is a lower bound — Axl could not price every operation.`;
  }
  if (accounting.completeness === 'unverified') {
    return `${base}. This run predates measured accounting, so the figure is repeated as reported and cannot be certified.`;
  }
  return base;
}

/**
 * The budget outcome sentence, parallel to the CLI's `formatBudgetLine()`.
 * `null` when no budget was configured.
 */
export function formatBudgetLine(accounting: EvalAccounting): string | null {
  const budget = accounting.budget;
  if (!budget) return null;
  const limit = formatCost(budget.limit);
  const spent = formatCost(budget.knownSpend);
  if (budget.status === 'open') return `${spent} of ${limit} (open)`;
  const by = budget.closedBy ? `, first observed by ${budget.closedBy}` : '';
  return `STOPPED — ${spent} known spend against a ${limit} limit, ${formatCost(budget.knownOvershoot)} over${by}`;
}

/** `true` when the run's budget closed — the run is short by design, not broken. */
export function isBudgetStopped(accounting: EvalAccounting): boolean {
  return accounting.budget?.status === 'closed';
}

// ── Outcome vocabulary ───────────────────────────────────────────

/**
 * The five item outcomes, each with its own label. Collapsing them into one
 * "failed" pill is the defect these exist to prevent: a case the budget never
 * started is not a broken model.
 */
export const ITEM_OUTCOME_LABELS: Record<EvalItemOutcome, string> = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  budget_skipped: 'budget skipped',
  budget_interrupted: 'budget interrupted',
};

export const ITEM_OUTCOME_TITLES: Record<EvalItemOutcome, string> = {
  completed: 'Ran to completion (its scorers may still have been stopped)',
  failed: 'The workflow threw',
  cancelled: 'Cancelled by the caller before or during execution',
  budget_skipped: 'Never started — the run budget had already closed. No operations, no spend',
  budget_interrupted: 'Started and charged, then a further operation was denied by the budget',
};

/** The six scorer outcomes. A budget-skipped judge is "not run", never a 0. */
export const SCORER_OUTCOME_LABELS: Record<ScorerOutcome, string> = {
  scored: 'scored',
  failed: 'failed',
  skipped: 'not applicable',
  cancelled: 'cancelled',
  budget_skipped: 'not run (budget)',
  budget_interrupted: 'budget interrupted',
};

export const SCORER_OUTCOME_TITLES: Record<ScorerOutcome, string> = {
  scored: 'Produced a valid numeric score',
  failed: 'Ran and threw, or returned an out-of-range score',
  skipped: "Not applicable — the scorer's `applies` predicate returned false for this item",
  cancelled: 'Cancelled by the caller before or during the call',
  budget_skipped:
    'Never started — the run budget had closed. NOT a zero score; excluded from the mean',
  budget_interrupted: 'Started, then hit an operation the budget denied',
};

/** Outcomes that mean "this judge never produced a number" — never render a 0. */
export const SCORER_NOT_RUN: ScorerOutcome[] = [
  'budget_skipped',
  'budget_interrupted',
  'cancelled',
];

/**
 * The item's recorded outcome, or `null` on a pre-0.24 artifact that carries
 * none. A legacy item is deliberately NOT back-filled from `error`: "we don't
 * know how this ended" is the honest reading, and the legacy error string is
 * still rendered on its own.
 */
export function itemOutcome(item: EvalItem): EvalItemOutcome | null {
  return item?.outcome ?? null;
}

/** Same rule for a scorer detail. */
export function scorerOutcome(detail: ScorerDetail | undefined): ScorerOutcome | null {
  return detail?.outcome ?? null;
}

/** `true` when this scorer's outcome means it produced no number at all. */
export function scorerDidNotRun(detail: ScorerDetail | undefined): boolean {
  const outcome = scorerOutcome(detail);
  return outcome != null && SCORER_NOT_RUN.includes(outcome);
}

/**
 * Non-completed item counts for a run, in the CLI's order and wording:
 * `3 completed, 1 failed, 2 budget-skipped`. `null` when the artifact has no
 * coverage block (pre-0.24).
 */
export function formatCoverageLine(result: EvalResultData): string | null {
  const items = result.summary?.coverage?.items;
  if (!items) return null;
  const parts = (
    [
      ['failed', items.failed],
      ['cancelled', items.cancelled],
      ['budget-skipped', items.budget_skipped],
      ['budget-interrupted', items.budget_interrupted],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label}`);
  if (parts.length === 0) return null;
  return `${items.completed} completed, ${parts.join(', ')}`;
}
