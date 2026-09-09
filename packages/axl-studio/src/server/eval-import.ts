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

/** Float tolerance for the sum identities. Costs are USD floats, not decimals. */
const EPSILON = 1e-9;

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
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
  const r = result as { accounting?: unknown; items?: unknown };
  if (r.accounting !== undefined && !isValidImportedAccounting(r.accounting)) return false;
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

/** Strip every accounting block so `readAccounting` synthesizes an `unverified` view. */
export function stripAccounting<T>(result: T): T {
  const copy = structuredClone(result) as Record<string, unknown>;
  delete copy.accounting;
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
