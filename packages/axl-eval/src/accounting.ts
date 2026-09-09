/**
 * Eval-side accounting helpers.
 *
 * The core owns measurement (`@axlsdk/axl`'s `Accounting`, `trackOutcome`,
 * `AdmissionController`). This module owns the three things eval adds on top:
 *
 * - **Scope plumbing** — {@link trackScope} opens a core accounting scope when
 *   the runtime has one, and produces an explicitly `uninstrumented` record
 *   when it does not. An eval driven by a hand-rolled runtime therefore reports
 *   "we measured nothing", never a confident `$0`.
 * - **Reading** — {@link readAccounting} turns any `EvalResult`, including a
 *   pre-0.24 artifact with no `accounting` at all, into an `EvalAccounting`.
 *   An absent record reads `'unverified'` and is NEVER upgraded to `'complete'`.
 * - **Union** — {@link aggregateAccounting} folds several records
 *   conservatively: sums of known spend, unions of reasons, and the WORST
 *   completeness of any input.
 *
 * Everything here is pure except `trackScope`, which only delegates.
 */

import { AxlError } from '@axlsdk/axl';
import type {
  Accounting,
  AccountingReason,
  AccountingUsage,
  AxlEvent,
  AxlRuntime,
  CostProvenance,
  ModelTimingRollup,
  OperationKind,
  TrackExecutionMetadata,
  TrackOutcomeOptions,
} from '@axlsdk/axl';

import type { EvalAccounting, EvalResult } from './types.js';

const USAGE_KEYS: (keyof AccountingUsage)[] = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'audioSeconds',
];

function zeroUsage(): AccountingUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    audioSeconds: 0,
  };
}

/** A scope in which nothing paid could happen — structurally complete at $0. */
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

/**
 * What a scope reports when the runtime cannot measure at all — no
 * `trackOutcome`, so no operation was ever observed.
 *
 * Deliberately `'incomplete'` with reason `'uninstrumented'` rather than a
 * confident `$0`: the work may well have spent money, we simply have no rail
 * to see it on. Callers' own `cost` values land in `callerReport`, never here.
 */
export function uninstrumentedAccounting(): Accounting {
  return { ...emptyAccounting(), completeness: 'incomplete', reasons: { uninstrumented: 1 } };
}

/** The outcome of {@link trackScope}: never a rejection, always an accounting. */
export type ScopeOutcome<T> = (
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: unknown }
) & {
  accounting: Accounting;
  /** `false` when the runtime had no `trackOutcome` (see {@link uninstrumentedAccounting}). */
  instrumented: boolean;
  metadata?: TrackExecutionMetadata;
  modelTiming?: ModelTimingRollup;
  traces?: AxlEvent[];
};

/** `true` when this runtime can open a core accounting scope. */
export function isInstrumented(runtime: AxlRuntime | undefined): boolean {
  return typeof runtime?.trackOutcome === 'function';
}

/**
 * Run `fn` inside a core accounting scope, or — on a runtime that has none —
 * run it plainly and report {@link uninstrumentedAccounting}.
 *
 * Never throws: the thrown value comes back verbatim under `status: 'rejected'`
 * so the caller can classify the outcome AND keep the spend that preceded it.
 */
export async function trackScope<T>(
  runtime: AxlRuntime,
  fn: () => Promise<T>,
  options?: TrackOutcomeOptions,
): Promise<ScopeOutcome<T>> {
  if (!isInstrumented(runtime)) {
    try {
      return {
        status: 'fulfilled',
        value: await fn(),
        accounting: uninstrumentedAccounting(),
        instrumented: false,
      };
    } catch (error) {
      return {
        status: 'rejected',
        error,
        accounting: uninstrumentedAccounting(),
        instrumented: false,
      };
    }
  }
  const outcome = await runtime.trackOutcome(fn, options);
  return { ...outcome, instrumented: true };
}

/**
 * Parse an `EvalConfig.budget` / `--budget` string into a USD limit.
 *
 * Strict by construction: `'$1'`, `'1'` and `'$1.00'` are the accepted forms.
 * Anything else — `'free'`, `'$-1'`, `'$1.2.3'`, `'1e999'`, `''`, `'$ 1'` —
 * throws `AxlError('INVALID_BUDGET')` rather than being coerced by
 * `parseFloat`, which would happily read `'$1.2.3'` as `1.2` and run an eval
 * against a limit the user never wrote.
 */
export function parseBudget(budget: string): number {
  const match = typeof budget === 'string' ? budget.match(/^\$?(\d+(?:\.\d+)?)$/) : null;
  if (!match) {
    throw new AxlError(
      'INVALID_BUDGET',
      `Invalid budget "${String(budget)}": expected a non-negative USD amount like "$1" or "0.50".`,
    );
  }
  const limit = Number(match[1]);
  if (!Number.isFinite(limit)) {
    throw new AxlError('INVALID_BUDGET', `Invalid budget "${budget}": not a finite amount.`);
  }
  return limit;
}

function usableCost(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Read the accounting of any `EvalResult`, including one written before this
 * field existed.
 *
 * A legacy artifact reads `'unverified'`: its `totalCost` is repeated as
 * `knownCost` for continuity, but no operation counts, no usage and no
 * generation/judging split are invented, and it is never reported as
 * `'complete'`. Turning an absent completeness into `'complete'` is exactly the
 * bug that would let a legacy run certify a cost comparison.
 */
export function readAccounting(result: EvalResult): EvalAccounting {
  if (result?.accounting) return result.accounting;
  const rescored = (result?.metadata as { rescored?: unknown } | undefined)?.rescored === true;
  return {
    ...emptyAccounting(),
    knownCost: usableCost(result?.totalCost),
    completeness: 'unverified',
    scope: rescored ? 'rescore' : 'run',
  };
}

function addUsage(target: AccountingUsage, source: AccountingUsage | undefined): void {
  if (!source) return;
  for (const key of USAGE_KEYS) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) target[key] += value;
  }
}

function addCounts<K extends string>(
  target: Partial<Record<K, number>>,
  source: Partial<Record<K, number>> | undefined,
): void {
  if (!source) return;
  for (const [key, count] of Object.entries(source) as [K, unknown][]) {
    if (typeof count === 'number' && Number.isFinite(count)) {
      target[key] = (target[key] ?? 0) + count;
    }
  }
}

/**
 * Fold several accounting records into one, conservatively.
 *
 * Numbers sum; reasons union with their counts; completeness takes the WORST
 * of the inputs (`unverified` > `incomplete` > `complete`), so a group
 * containing one legacy run is `unverified` as a whole and one incomplete run
 * makes the group incomplete. Inheriting the first input's flags — the bug this
 * exists to prevent — would report a group as complete because run 1 was.
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
    addUsage(out.usage, input.usage);
    addCounts<AccountingReason>(out.reasons, input.reasons);
    addCounts<OperationKind>(out.operations.byKind, input.operations?.byKind);
    addCounts<CostProvenance>(out.provenance, input.provenance);
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
