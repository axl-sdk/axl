/**
 * Validation for eval artifacts arriving over `POST /evals/import`.
 *
 * An imported artifact is the one eval result Studio did not measure. Everything
 * else in history was produced by this runtime's accounting rail; an import is
 * a file a user pasted in, and `compare` will happily certify a cost delta from
 * it if its `accounting` block says `completeness: 'complete'`.
 *
 * So a declared record has to EARN that trust by being internally consistent:
 * the operation counts must add up, and the provenance and breakdown splits must
 * sum back to the total they claim to split. A hand-edited "complete" record
 * with a made-up `knownCost` fails those identities, and is replaced by the same
 * `unverified` synthesis an artifact with no accounting at all receives.
 *
 * Import never REJECTS over accounting. The numeric results are still worth
 * having; what changes is whether downstream comparison is allowed to treat
 * them as certified. `metadata.importedAccounting` records which way it went so
 * that decision is visible rather than inferred.
 */

import type { Accounting } from '@axlsdk/axl';

/**
 * Every key of the outcome unions, as `EvalCoverage` promises them.
 *
 * Duplicated from `@axlsdk/eval`'s type-level unions on purpose: this is a
 * RUNTIME guard over a stranger's JSON, and a type cannot check a value. The
 * lists are contract §6 and change only when the unions do.
 */
const ITEM_OUTCOMES = [
  'completed',
  'failed',
  'cancelled',
  'budget_skipped',
  'budget_interrupted',
] as const;
const SCORER_OUTCOMES = [
  'scored',
  'failed',
  'skipped',
  'cancelled',
  'budget_skipped',
  'budget_interrupted',
] as const;

/** Float tolerance for the sum identities. Costs are USD floats, not decimals. */
const EPSILON = 1e-9;

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isCount(value: unknown): value is number {
  return isFiniteNonNegative(value) && Number.isInteger(value);
}

/**
 * Is this a structurally trustworthy `EvalBudgetStatus`?
 *
 * `accounting.budget.status` is half of the "budget stopped" verdict three
 * readers now render (the CLI summary, Studio's eval trends, and the run
 * panel's badge). An imported artifact can simply assert `'closed'`, and the
 * identity `knownOvershoot === max(0, knownSpend - limit)` is what a forged
 * block cannot satisfy while also claiming an unrelated spend.
 */
export function isValidImportedBudget(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const b = value as Record<string, unknown>;
  if (!isFiniteNonNegative(b.limit)) return false;
  if (!isFiniteNonNegative(b.knownSpend)) return false;
  if (!isFiniteNonNegative(b.knownOvershoot)) return false;
  if (b.status !== 'open' && b.status !== 'closed') return false;
  if (
    b.closedBy !== undefined &&
    b.closedBy !== 'case' &&
    b.closedBy !== 'scorer' &&
    b.closedBy !== 'operation'
  ) {
    return false;
  }
  // `AdmissionController.status` IS `knownSpend >= limit`, and `snapshot()`
  // serializes both from the same doubles — so the two agree in every genuine
  // export, overshooting runs included. Without this check the cheapest possible
  // forgery of the budget-stopped badge (`status: 'closed'` beside a $0 spend
  // against a $10 limit) passes every other identity.
  if (b.knownSpend >= b.limit !== (b.status === 'closed')) return false;
  const expected = Math.max(0, b.knownSpend - b.limit);
  return Math.abs(b.knownOvershoot - expected) <= EPSILON;
}

/**
 * Is this a structurally trustworthy `EvalCoverage`?
 *
 * The other half of the same verdict, and the source of every "N cases were
 * never attempted" caveat. `EvalCoverage` promises EVERY key of both outcome
 * unions is present, including zeros, so a consumer can render "0 skipped"
 * without inferring it from an absent key — a partial block silently reads as
 * zeros and turns a refusal into a clean run.
 *
 * Contract §6 states no sum identity between these counts and the item list
 * (a scorer detail with no `outcome` is counted in neither bucket, so a
 * scorer's counts legitimately total fewer than the items), so this checks
 * presence and shape only rather than inventing an identity to enforce.
 */
export function isValidImportedCoverage(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as { items?: unknown; scorers?: unknown };
  if (!c.items || typeof c.items !== 'object' || Array.isArray(c.items)) return false;
  const items = c.items as Record<string, unknown>;
  for (const key of ITEM_OUTCOMES) {
    if (!isCount(items[key])) return false;
  }
  if (!c.scorers || typeof c.scorers !== 'object' || Array.isArray(c.scorers)) return false;
  for (const bucket of Object.values(c.scorers as Record<string, unknown>)) {
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return false;
    const counts = bucket as Record<string, unknown>;
    for (const key of SCORER_OUTCOMES) {
      if (!isCount(counts[key])) return false;
    }
  }
  return true;
}

function sumOf(record: unknown): number | undefined {
  if (record === undefined) return 0;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  let total = 0;
  for (const value of Object.values(record as Record<string, unknown>)) {
    if (!isFiniteNonNegative(value)) return undefined;
    total += value;
  }
  return total;
}

function allNumeric(record: unknown): boolean {
  if (record === undefined) return true;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return false;
  return Object.values(record as Record<string, unknown>).every(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
}

/**
 * Is this a structurally trustworthy `Accounting` record?
 *
 * The sum identities are checked only for `'complete'` and `'incomplete'`.
 * An `'unverified'` record is by definition a synthesized view of an artifact
 * that carried no measurement — its `knownCost` is a copied `totalCost` with no
 * operations, no provenance and no breakdown behind it, so demanding that those
 * splits sum to it would reject exactly the honest records this feature mints.
 */
export function isValidImportedAccounting(value: unknown): value is Accounting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as Partial<Accounting> & Record<string, unknown>;

  if (a.version !== 1) return false;
  if (a.currency !== 'USD') return false;
  if (!isFiniteNonNegative(a.knownCost)) return false;
  if (
    a.completeness !== 'complete' &&
    a.completeness !== 'incomplete' &&
    a.completeness !== 'unverified'
  ) {
    return false;
  }
  if (!allNumeric(a.reasons)) return false;
  if (!allNumeric(a.usage)) return false;

  const ops = a.operations;
  if (!ops || typeof ops !== 'object') return false;
  for (const key of ['total', 'settled', 'unknown', 'denied'] as const) {
    if (!isFiniteNonNegative(ops[key])) return false;
  }
  if (!allNumeric(ops.byKind)) return false;
  if (ops.total !== ops.settled + ops.unknown) return false;

  if (a.completeness === 'unverified') return true;

  const provenanceTotal = sumOf(a.provenance);
  if (provenanceTotal === undefined) return false;
  if (Math.abs(provenanceTotal - a.knownCost) > EPSILON) return false;

  const breakdown = a.breakdown;
  if (!breakdown || typeof breakdown !== 'object') return false;
  const breakdownTotal = sumOf({
    generation: breakdown.generation,
    judging: breakdown.judging,
    external: breakdown.external,
  });
  if (breakdownTotal === undefined) return false;
  if (Math.abs(breakdownTotal - a.knownCost) > EPSILON) return false;

  return true;
}

/**
 * Whether every accounting block on an imported result — run level, per item,
 * per scorer — passes {@link isValidImportedAccounting}.
 *
 * All-or-nothing on purpose: a result whose run total is consistent but whose
 * items are forged is not half-trustworthy, and a per-block verdict would leave
 * a reader to reconcile a "declared" run against "invalid" items.
 */
export function importedAccountingIsTrustworthy(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as { accounting?: unknown; items?: unknown; summary?: unknown };
  if (r.accounting !== undefined && !isValidImportedAccounting(r.accounting)) return false;
  // `budget` and `coverage` are accounting-DERIVED facts, so they join the
  // all-or-nothing rule rather than riding in unchecked: together they are the
  // whole "this run was stopped by its budget" verdict, and a result badged
  // that way is read as "the numbers are short for a known reason" instead of
  // "the numbers are wrong".
  const budget = (r.accounting as { budget?: unknown } | undefined)?.budget;
  if (budget !== undefined && !isValidImportedBudget(budget)) return false;
  const coverage = (r.summary as { coverage?: unknown } | undefined)?.coverage;
  if (coverage !== undefined && !isValidImportedCoverage(coverage)) return false;
  if (!Array.isArray(r.items)) return true;
  for (const item of r.items) {
    if (!item || typeof item !== 'object') continue;
    const i = item as { accounting?: unknown; scoreDetails?: unknown };
    if (i.accounting !== undefined && !isValidImportedAccounting(i.accounting)) return false;
    if (i.scoreDetails && typeof i.scoreDetails === 'object') {
      for (const detail of Object.values(i.scoreDetails as Record<string, unknown>)) {
        const d = detail as { accounting?: unknown } | null;
        if (d?.accounting !== undefined && !isValidImportedAccounting(d.accounting)) return false;
      }
    }
  }
  return true;
}

/**
 * Strip every accounting block so `readAccounting` synthesizes an `unverified`
 * view — and with it the budget and coverage derived from the same measurement.
 *
 * Leaving `summary.coverage` behind would keep the caveats and the
 * budget-stopped badge alive on a result whose accounting was just refused,
 * which is precisely the claim that failed validation.
 */
export function stripAccounting<T>(result: T): T {
  const copy = structuredClone(result) as Record<string, unknown>;
  delete copy.accounting;
  const summary = copy.summary;
  if (summary && typeof summary === 'object') {
    delete (summary as Record<string, unknown>).coverage;
  }
  const items = copy.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const i = item as Record<string, unknown>;
      delete i.accounting;
      const details = i.scoreDetails;
      if (details && typeof details === 'object') {
        for (const detail of Object.values(details as Record<string, unknown>)) {
          if (detail && typeof detail === 'object') {
            delete (detail as Record<string, unknown>).accounting;
          }
        }
      }
    }
  }
  return copy as T;
}
