/**
 * Core accounting — one authoritative record of what a workload spent.
 *
 * This module owns the *measurement* rail. It is deliberately independent of
 * the trace/event rail (`event-utils.ts`): trace retention, trace level,
 * redaction and capture change diagnostics, never the numbers here. Both rails
 * are fed by the same settlement producer (the scoped provider facade and the
 * instrumented tool / memory / transcription boundaries), so turning tracing
 * off cannot change `Accounting`.
 *
 * The three concepts:
 *
 * - **Operation** — one logical paid unit of work (a chat call, a stream, an
 *   embedding, a transcription, a tool invocation attempt, a declared external
 *   call). It has a stable id and a lifecycle: `admitted` → `dispatched` →
 *   `settled` | `denied` | `abandoned`. Transport retries are subordinate to
 *   the operation; they never mint a second one.
 * - **Scope** — an `AsyncLocalStorage` frame opened by
 *   `AxlRuntime.trackOutcome()`. Scopes nest; an operation settled in a child
 *   is recorded exactly once in every open ancestor (deduped by operation id),
 *   so a parent total is the sum of disjoint operations and never a double
 *   charge.
 * - **Admission** — a synchronous known-spend threshold ({@link
 *   AdmissionController}) attached to a scope. It is a threshold, not a
 *   reservation system: work already dispatched settles and is counted.
 *
 * Zero is never confused with unknown. A known $0 settles `complete`; anything
 * dispatched whose charge we could not establish settles `unknown` with a
 * {@link AccountingReason}, which makes the scope `incomplete` and makes
 * `knownCost` an explicit lower bound.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { AdmissionDeniedError, AxlError } from './errors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * How much of the declared/instrumented scope the numbers actually cover.
 *
 * This is coverage of Axl-observable operations, NOT invoice reconciliation.
 *
 * - `'complete'` — every operation in the scope reached a terminal state with a
 *   usable charge (including known $0).
 * - `'incomplete'` — at least one operation settled without a usable charge;
 *   `knownCost` is a lower bound and `reasons` says why.
 * - `'unverified'` — reserved for READERS of artifacts that carry no
 *   accounting at all (legacy eval results). A live scope never produces it.
 */
export type AccountingCompleteness = 'complete' | 'incomplete' | 'unverified';

/** Where a settled USD figure came from. Keys of `Accounting.provenance`. */
export type CostProvenance =
  /** The vendor supplied the USD figure itself (e.g. OpenRouter `usage.cost`). */
  | 'provider_reported'
  /** An Axl/adapter price table was applied to reported usage. */
  | 'price_table_estimate'
  /** An adapter supplied a cost without declaring its basis. */
  | 'adapter_reported'
  /** `withExternalOperation` / tool / legacy caller value. */
  | 'caller_reported';

/** Why an operation could not contribute a usable charge. */
export type AccountingReason =
  /** Usage was reported but no usable cost was (undefined / NaN / negative / ∞). */
  | 'unpriced_model'
  /** Dispatched, but the terminal outcome carried no usage (failure/abort/stall). */
  | 'usage_missing'
  /** Dispatched and never settled before its scope finalized. */
  | 'abandoned'
  /** An external operation finished without calling `report.setCost()`. */
  | 'external_unreported'
  /**
   * A consumer ran work with no accounting scope available (e.g. `@axlsdk/eval`
   * driving a runtime that predates `trackOutcome`). Core defines the name only
   * — no core producer emits it.
   */
  | 'uninstrumented';

/** The instrumented boundaries that can open an operation. */
export type OperationKind = 'chat' | 'stream' | 'embedding' | 'transcription' | 'tool' | 'external';

/** Whether a scope's operations are generating an answer or judging one. */
export type OperationPurpose = 'generation' | 'judging';

/**
 * Usage folded across a scope's settled operations.
 *
 * `reasoningTokens` / `cachedTokens` / `cacheWriteTokens` are counted ONCE in
 * their own bucket. `inputTokens` is the provider's already-folded
 * `prompt_tokens` — cached tokens are not re-added to it.
 */
export type AccountingUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  audioSeconds: number;
};

/** The authoritative accounting record for one tracked scope. */
export type Accounting = {
  version: 1;
  currency: 'USD';
  /** Sum of settled, usable, disjoint charges. Never includes caller aggregates. */
  knownCost: number;
  completeness: AccountingCompleteness;
  /** Reason → count of operations carrying it. Empty object when complete. */
  reasons: Partial<Record<AccountingReason, number>>;
  usage: AccountingUsage;
  operations: {
    /**
     * Operations admitted and opened in this scope (or a descendant). An
     * operation later refused at the dispatch check is retracted from this
     * count and appears under `denied` instead, so
     * `total === settled + unknown` always holds.
     */
    total: number;
    /** Terminal with a usable cost, including a known $0. */
    settled: number;
    /** Terminal or abandoned without a usable cost. Drives `completeness`. */
    unknown: number;
    /** Refused admission — never dispatched, contributes nothing anywhere. */
    denied: number;
    /** `total` split by kind. Denied operations are not included. */
    byKind: Partial<Record<OperationKind, number>>;
  };
  /** `knownCost` split. `external` is kind `'external'`; the rest by scope purpose. */
  breakdown: { generation: number; judging: number; external: number };
  /** `knownCost` split by provenance. Keys sum to `knownCost`. */
  provenance: Partial<Record<CostProvenance, number>>;
};

/**
 * The dispatch-level admission hook.
 *
 * `fetchWithRetry` calls `beforeDispatch` after acquiring a rate-governor
 * permit and immediately before EVERY `fetch` attempt, outside the
 * network-error catch. Throwing an {@link AdmissionDeniedError} from it stops
 * the request before it leaves the process; the permit is still released.
 *
 * A third-party adapter that ignores this hook still gets the
 * operation-open check, but a request already queued behind a governor or
 * sleeping in its own backoff cannot be stopped. See `docs/providers.md`.
 */
export type DispatchAdmission = {
  /** @param attempt 1-indexed transport attempt. Throws to refuse the dispatch. */
  beforeDispatch(attempt: number): void;
};

/** Reports a declared external charge for one `withExternalOperation` call. */
export type ExternalOperationReport = {
  /**
   * Record a finite, non-negative, DISJOINT USD charge for this operation.
   * Explicit `0` means known-free. Nested Axl calls account for themselves and
   * must be excluded.
   *
   * @throws AxlError `INVALID_COST_REPORT` on a non-finite/negative amount or a
   *   second call.
   */
  setCost(amountUsd: number, usage?: Partial<AccountingUsage>): void;
};

/** Descriptor for `withExternalOperation` / {@link externalOperation}. */
export type ExternalOperationDescriptor = { name: string };

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/** @internal Module-private settlement channel into the controller. */
const RECORD_SPEND: unique symbol = Symbol('axl.admission.recordSpend');

/**
 * A synchronous known-spend threshold for one invocation.
 *
 * Attach it to a scope via `runtime.trackOutcome(fn, { admission })`. Every
 * instrumented operation checks it when it opens, and every built-in transport
 * checks it again immediately before each dispatch.
 *
 * It is a **threshold, not a reservation**: a call admitted before a sibling
 * settles may push known spend past `limit`. `knownOvershoot` reports how far.
 * Never share one controller across unrelated invocations.
 */
export class AdmissionController {
  /** The configured USD threshold. Admission closes at `knownSpend >= limit`. */
  readonly limit: number;
  private spend = 0;

  constructor(options: { limit: number }) {
    const limit = options?.limit;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
      throw new AxlError(
        'INVALID_BUDGET',
        `AdmissionController limit must be a finite number >= 0, received ${String(limit)}.`,
      );
    }
    this.limit = limit;
  }

  /** USD settled so far under this controller. Unknown spend is NOT included. */
  get knownSpend(): number {
    return this.spend;
  }

  /** `true` once `knownSpend >= limit`. A `limit` of 0 is closed from the start. */
  get closed(): boolean {
    return this.spend >= this.limit;
  }

  get status(): 'open' | 'closed' {
    return this.closed ? 'closed' : 'open';
  }

  /** `max(0, knownSpend - limit)`, unconditionally — necessarily 0 while open. */
  get knownOvershoot(): number {
    return Math.max(0, this.spend - this.limit);
  }

  /** Synchronous admission decision. No await between the check and the answer. */
  admit(): { admitted: true } | { admitted: false; limit: number; knownSpend: number } {
    if (this.closed) return { admitted: false, limit: this.limit, knownSpend: this.spend };
    return { admitted: true };
  }

  snapshot(): {
    limit: number;
    status: 'open' | 'closed';
    knownSpend: number;
    knownOvershoot: number;
  } {
    return {
      limit: this.limit,
      status: this.status,
      knownSpend: this.knownSpend,
      knownOvershoot: this.knownOvershoot,
    };
  }

  /** @internal Applied synchronously at settlement, in the tick it is observed. */
  [RECORD_SPEND](amountUsd: number): void {
    this.spend += amountUsd;
  }
}

// ---------------------------------------------------------------------------
// Operations and scopes (internal)
// ---------------------------------------------------------------------------

/** What an operation is about. `model`/`provider`/`name` are for diagnostics. */
export type OperationDescriptor = {
  kind: OperationKind;
  model?: string;
  provider?: string;
  name?: string;
};

type OperationRecord = {
  id: string;
  kind: OperationKind;
  purpose: OperationPurpose;
  model?: string;
  /** Set once the transport reports the request actually left the process. */
  dispatched: boolean;
  /**
   * `true` when the adapter positively establishes it can report dispatch
   * (`Provider.reportsRequestLifecycle`). Only such an adapter can prove "no
   * charge" by NOT dispatching; anyone else's usage-less failure is unknown.
   */
  dispatchObservable: boolean;
};

type SettlementInput = {
  cost?: number;
  provenance?: CostProvenance;
  usage?: Partial<AccountingUsage>;
};

function emptyUsage(): AccountingUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    audioSeconds: 0,
  };
}

/** A cost is usable only when it is a finite, non-negative number. */
function isUsableCost(cost: unknown): cost is number {
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0;
}

let operationCounter = 0;
function nextOperationId(): string {
  operationCounter += 1;
  return `op_${operationCounter}`;
}

/**
 * One `trackOutcome` frame. Internal — consumers see only {@link Accounting}.
 */
class AccountingScope {
  readonly parent?: AccountingScope;
  readonly purpose: OperationPurpose;
  readonly admission?: AdmissionController;

  private finalized = false;
  /** Operation ids that already reached a terminal state IN THIS SCOPE. */
  private readonly seen = new Set<string>();
  /** Operations opened here or in a descendant that have not settled yet. */
  private readonly openOps = new Map<string, OperationRecord>();

  private knownCost = 0;
  private readonly usage = emptyUsage();
  private total = 0;
  private settled = 0;
  private unknown = 0;
  private denied = 0;
  private readonly byKind = new Map<OperationKind, number>();
  private readonly reasons = new Map<AccountingReason, number>();
  private readonly breakdown = { generation: 0, judging: 0, external: 0 };
  private readonly provenance = new Map<CostProvenance, number>();

  constructor(options: {
    parent?: AccountingScope;
    purpose: OperationPurpose;
    admission?: AdmissionController;
  }) {
    this.parent = options.parent;
    this.purpose = options.purpose;
    this.admission = options.admission;
  }

  get isFinalized(): boolean {
    return this.finalized;
  }

  recordOpen(op: OperationRecord): void {
    this.openOps.set(op.id, op);
    this.total += 1;
    this.byKind.set(op.kind, (this.byKind.get(op.kind) ?? 0) + 1);
  }

  /** An operation refused admission BEFORE it was ever opened. */
  recordDenied(): void {
    this.denied += 1;
  }

  /** An already-open operation refused at the dispatch check: retract it. */
  recordRetracted(op: OperationRecord): void {
    this.seen.add(op.id);
    this.openOps.delete(op.id);
    this.total -= 1;
    const kindCount = (this.byKind.get(op.kind) ?? 1) - 1;
    if (kindCount > 0) this.byKind.set(op.kind, kindCount);
    else this.byKind.delete(op.kind);
    this.denied += 1;
  }

  recordSettled(
    op: OperationRecord,
    cost: number,
    provenance: CostProvenance,
    usage?: Partial<AccountingUsage>,
  ): void {
    this.seen.add(op.id);
    this.openOps.delete(op.id);
    this.settled += 1;
    this.knownCost += cost;
    if (op.kind === 'external') this.breakdown.external += cost;
    else this.breakdown[op.purpose] += cost;
    this.provenance.set(provenance, (this.provenance.get(provenance) ?? 0) + cost);
    if (usage) this.addUsage(usage);
  }

  recordUnknown(
    op: OperationRecord,
    reason: AccountingReason,
    usage?: Partial<AccountingUsage>,
  ): void {
    this.seen.add(op.id);
    this.openOps.delete(op.id);
    this.unknown += 1;
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1);
    if (usage) this.addUsage(usage);
  }

  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }

  private addUsage(usage: Partial<AccountingUsage>): void {
    for (const key of Object.keys(this.usage) as (keyof AccountingUsage)[]) {
      const value = usage[key];
      if (typeof value === 'number' && Number.isFinite(value)) this.usage[key] += value;
    }
  }

  /**
   * Terminal for the scope: mark everything still open as unresolved and stop
   * accepting further settlements. Never waits on a non-cooperative provider.
   */
  finalize(): void {
    if (this.finalized) return;
    for (const op of [...this.openOps.values()]) {
      // LOCAL only. This scope stops here and reports the operation unresolved,
      // but an ancestor that is still open has not given up on it: the real
      // settlement, if it ever arrives, still reaches those ancestors and their
      // controllers. Forcing `abandoned` upward would drop a real charge from a
      // live budget. Once every scope has finalized, a late settlement finds
      // nothing to record and is ignored.
      this.recordUnknown(op, op.kind === 'external' ? 'external_unreported' : 'abandoned');
    }
    this.finalized = true;
  }

  toAccounting(): Accounting {
    return {
      version: 1,
      currency: 'USD',
      knownCost: this.knownCost,
      completeness: this.unknown > 0 ? 'incomplete' : 'complete',
      reasons: Object.fromEntries(this.reasons) as Partial<Record<AccountingReason, number>>,
      usage: { ...this.usage },
      operations: {
        total: this.total,
        settled: this.settled,
        unknown: this.unknown,
        denied: this.denied,
        byKind: Object.fromEntries(this.byKind) as Partial<Record<OperationKind, number>>,
      },
      breakdown: { ...this.breakdown },
      provenance: Object.fromEntries(this.provenance) as Partial<Record<CostProvenance, number>>,
    };
  }
}

const accountingStorage = new AsyncLocalStorage<AccountingScope>();

/** @internal Set while an instrumented operation's body runs, so transports
 *  that do not receive `ChatOptions` (embedder, transcription) can still find
 *  their dispatch hook. */
const dispatchAdmissionStorage = new AsyncLocalStorage<DispatchAdmission>();

/**
 * The dispatch hook for the operation currently executing on this async
 * context, or `undefined` outside one.
 *
 * @internal Used by the embedder and transcription transports, which do not
 * carry `ChatOptions`.
 */
export function currentDispatchAdmission(): DispatchAdmission | undefined {
  return dispatchAdmissionStorage.getStore();
}

/** @internal Run `fn` with `admission` as the ambient dispatch hook. */
export function runWithDispatchAdmission<T>(
  admission: DispatchAdmission | undefined,
  fn: () => T,
): T {
  if (!admission) return fn();
  return dispatchAdmissionStorage.run(admission, fn);
}

/**
 * Walk the scope chain from `start` and apply one terminal recording per scope,
 * deduped by operation id.
 *
 * A scope that already recorded a terminal for this operation — because it saw
 * one, or because it finalized while the operation was still in flight and
 * abandoned it locally — is SKIPPED rather than ending the walk. Abandonment is
 * per scope: a child that gave up on an operation must not force the same
 * verdict onto an ancestor that is still open and can still receive the real
 * settlement. For those ancestors this walk is the operation's first terminal,
 * so nothing is replaced and nothing is double counted.
 */
function settleOperationUp(
  start: AccountingScope,
  op: OperationRecord,
  outcome:
    | {
        outcome: 'settled';
        cost: number;
        provenance: CostProvenance;
        usage?: Partial<AccountingUsage>;
      }
    | { outcome: 'unknown'; reason: AccountingReason; usage?: Partial<AccountingUsage> }
    | { outcome: 'retracted' },
): void {
  // One controller may be attached to several scopes in the chain (a run
  // controller shared by run and item scopes). Charge it exactly once.
  const chargedControllers = new Set<AdmissionController>();
  let scope: AccountingScope | undefined = start;
  while (scope) {
    if (scope.isFinalized || scope.hasSeen(op.id)) {
      scope = scope.parent;
      continue;
    }
    switch (outcome.outcome) {
      case 'settled':
        scope.recordSettled(op, outcome.cost, outcome.provenance, outcome.usage);
        if (scope.admission && !chargedControllers.has(scope.admission)) {
          chargedControllers.add(scope.admission);
          scope.admission[RECORD_SPEND](outcome.cost);
        }
        break;
      case 'unknown':
        scope.recordUnknown(op, outcome.reason, outcome.usage);
        break;
      case 'retracted':
        scope.recordRetracted(op);
        break;
    }
    scope = scope.parent;
  }
}

/**
 * Refuse admission when the NARROWEST closed controller in the chain says so.
 * Purely synchronous — there is no await between reading known spend and
 * deciding.
 */
function denyingController(
  scope: AccountingScope | undefined,
): { controller: AdmissionController; scope: AccountingScope } | undefined {
  let current = scope;
  while (current) {
    if (current.admission?.closed) return { controller: current.admission, scope: current };
    current = current.parent;
  }
  return undefined;
}

function admissionDenied(
  controller: AdmissionController,
  descriptor: OperationDescriptor,
): AdmissionDeniedError {
  return new AdmissionDeniedError({
    limit: controller.limit,
    knownSpend: controller.knownSpend,
    operation: { kind: descriptor.kind, model: descriptor.model },
  });
}

/**
 * A live operation. Returned by {@link openOperation} while a scope is active.
 *
 * @internal
 */
export type OperationHandle = {
  readonly id: string;
  /** Pass into `ChatOptions.dispatchAdmission` / `fetchWithRetry`. */
  readonly dispatchAdmission: DispatchAdmission;
  /** The transport reported the request actually left the process. */
  markDispatched(): void;
  /** Adapter declares it reports dispatch, so a non-dispatch proves no charge. */
  markDispatchObservable(): void;
  /** Terminal with a charge the adapter/caller supplied (may be unusable). */
  settle(input: SettlementInput): void;
  /** Terminal without a usable charge, for an explicit reason. */
  settleUnknown(reason: AccountingReason, usage?: Partial<AccountingUsage>): void;
  /** Terminal on a thrown error: known $0, unknown, or a dispatch denial. */
  settleFailure(usage?: Partial<AccountingUsage>): void;
  /** Run `fn` with this operation's dispatch hook ambient. */
  run<T>(fn: () => T): T;
};

/**
 * Check admission and open an operation on the active scope.
 *
 * Returns `undefined` when no scope is active — callers then delegate verbatim
 * with no admission and no accounting, exactly as before this seam existed.
 *
 * @throws AdmissionDeniedError when the narrowest enclosing controller is
 *   closed. The operation is recorded as `denied` and never dispatched.
 * @internal
 */
export function openOperation(descriptor: OperationDescriptor): OperationHandle | undefined {
  const scope = accountingStorage.getStore();
  if (!scope || scope.isFinalized) return undefined;

  const denier = denyingController(scope);
  if (denier) {
    // A denied operation is never opened, so it contributes to `denied` only.
    // Same termination rule as the open walk below: a finalized scope ends it,
    // so no ancestor can accumulate a `denied` count for an operation it would
    // never have counted in `total`.
    let s: AccountingScope | undefined = scope;
    while (s && !s.isFinalized) {
      s.recordDenied();
      s = s.parent;
    }
    throw admissionDenied(denier.controller, descriptor);
  }

  const op: OperationRecord = {
    id: nextOperationId(),
    kind: descriptor.kind,
    purpose: scope.purpose,
    model: descriptor.model,
    dispatched: false,
    dispatchObservable: false,
  };
  let s: AccountingScope | undefined = scope;
  while (s && !s.isFinalized) {
    s.recordOpen(op);
    s = s.parent;
  }

  let terminal = false;
  const finish = (outcome: Parameters<typeof settleOperationUp>[2]): void => {
    if (terminal) return;
    terminal = true;
    settleOperationUp(scope, op, outcome);
  };

  const handle: OperationHandle = {
    id: op.id,
    dispatchAdmission: {
      beforeDispatch(_attempt: number): void {
        const closed = denyingController(scope);
        if (!closed) return;
        if (op.dispatched) {
          // A RETRY attempt: an earlier attempt already left the process and
          // may well have been billed. Retracting here would erase a real
          // operation and let the scope claim `complete`. It is unresolved
          // work, which is exactly `usage_missing`.
          finish({ outcome: 'unknown', reason: 'usage_missing' });
        } else {
          // Nothing ever left, so the operation is retracted: no charge, no
          // reason, no incompleteness.
          finish({ outcome: 'retracted' });
        }
        throw admissionDenied(closed.controller, descriptor);
      },
    },
    markDispatched(): void {
      op.dispatched = true;
    },
    markDispatchObservable(): void {
      op.dispatchObservable = true;
    },
    settle(input: SettlementInput): void {
      if (isUsableCost(input.cost)) {
        finish({
          outcome: 'settled',
          cost: input.cost,
          provenance: input.provenance ?? 'adapter_reported',
          usage: input.usage,
        });
        return;
      }
      // A cost that was offered but is NaN/negative/∞, or usage with no cost at
      // all, is an unpriced model — never a silent zero.
      if (input.cost !== undefined || input.usage !== undefined) {
        finish({ outcome: 'unknown', reason: 'unpriced_model', usage: input.usage });
        return;
      }
      handle.settleFailure();
    },
    settleUnknown(reason: AccountingReason, usage?: Partial<AccountingUsage>): void {
      finish({ outcome: 'unknown', reason, usage });
    },
    settleFailure(usage?: Partial<AccountingUsage>): void {
      // Only an adapter that positively reports dispatch can prove that nothing
      // was billed. Anyone else's usage-less failure stays unknown.
      if (op.dispatchObservable && !op.dispatched) {
        finish({ outcome: 'settled', cost: 0, provenance: 'adapter_reported', usage });
        return;
      }
      finish({ outcome: 'unknown', reason: 'usage_missing', usage });
    },
    run<T>(fn: () => T): T {
      return runWithDispatchAdmission(handle.dispatchAdmission, fn);
    },
  };
  return handle;
}

/**
 * Run `fn` inside a fresh accounting scope and return its accounting.
 *
 * @internal `AxlRuntime.trackOutcome` is the public entry point.
 */
export async function runInAccountingScope<T>(
  options: { purpose?: OperationPurpose; admission?: AdmissionController },
  fn: () => Promise<T>,
): Promise<{
  outcome: { status: 'fulfilled'; value: T } | { status: 'rejected'; error: unknown };
  accounting: Accounting;
}> {
  const parent = accountingStorage.getStore();
  const scope = new AccountingScope({
    parent,
    purpose: options.purpose ?? parent?.purpose ?? 'generation',
    admission: options.admission,
  });
  try {
    const value = await accountingStorage.run(scope, fn);
    scope.finalize();
    return { outcome: { status: 'fulfilled', value }, accounting: scope.toAccounting() };
  } catch (error) {
    scope.finalize();
    return { outcome: { status: 'rejected', error }, accounting: scope.toAccounting() };
  }
}

// ---------------------------------------------------------------------------
// External operations
// ---------------------------------------------------------------------------

function validateReportedCost(amountUsd: number): void {
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd < 0) {
    throw new AxlError(
      'INVALID_COST_REPORT',
      `report.setCost() requires a finite USD amount >= 0, received ${String(amountUsd)}.`,
    );
  }
}

/**
 * Declare a paid unit of work Axl cannot observe — a third-party API call
 * inside a tool, a custom scorer's own model call — so it joins the scope's
 * accounting as an `'external'` operation.
 *
 * Admission is checked BEFORE `fn` runs. The operation finalizes on return,
 * throw or abort; a cost reported before a later throw is kept. Not calling
 * `report.setCost()` makes the scope `incomplete` with reason
 * `'external_unreported'` — never free.
 *
 * The reported amount must be DISJOINT: nested `ctx.ask` / provider calls
 * account for themselves and must be excluded, or the scope double-charges.
 *
 * Outside any accounting scope `fn` still runs, with a report that validates
 * its argument but records nothing.
 *
 * @throws AdmissionDeniedError when the enclosing budget has closed.
 */
export async function externalOperation<T>(
  descriptor: ExternalOperationDescriptor,
  fn: (report: ExternalOperationReport) => Promise<T>,
): Promise<T> {
  const handle = openOperation({ kind: 'external', name: descriptor.name });
  if (!handle) {
    let reportedOutside = false;
    return fn({
      // Same checks in the same order as the in-scope report below, so a
      // caller's bug reads identically with and without a scope.
      setCost(amountUsd: number): void {
        if (reportedOutside) {
          throw new AxlError(
            'INVALID_COST_REPORT',
            'report.setCost() was already called for this external operation.',
          );
        }
        validateReportedCost(amountUsd);
        reportedOutside = true;
      },
    });
  }

  let reported = false;
  let cost = 0;
  let usage: Partial<AccountingUsage> | undefined;
  const report: ExternalOperationReport = {
    setCost(amountUsd: number, reportedUsage?: Partial<AccountingUsage>): void {
      if (reported) {
        throw new AxlError(
          'INVALID_COST_REPORT',
          'report.setCost() was already called for this external operation.',
        );
      }
      validateReportedCost(amountUsd);
      reported = true;
      cost = amountUsd;
      usage = reportedUsage;
    },
  };

  try {
    return await handle.run(() => fn(report));
  } finally {
    if (reported) handle.settle({ cost, provenance: 'caller_reported', usage });
    else handle.settleUnknown('external_unreported');
  }
}
