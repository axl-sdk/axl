/**
 * A16.13 — compile-time parity between the core's structural eval types and
 * `@axlsdk/eval`'s real ones.
 *
 * `@axlsdk/axl` cannot import `@axlsdk/eval` (the dependency runs the other
 * way — see `accounting.test.ts`'s I12 guard), so `runtime.eval()` and
 * `runtime.runRegisteredEval()` type their `config`/`onProgress` against
 * hand-declared structural shapes in `runtime.ts`. Two hand-maintained copies
 * of a shape is the classic cross-package break: they drift, and nothing
 * notices until an integrator's `runtime.eval(myEvalConfig)` stops compiling.
 *
 * The other half is `Accounting`: `EvalAccounting` must EXTEND the core type,
 * not restate it, so an `Accounting` consumer keeps working on an eval result.
 *
 * This file is compiled by `pnpm typecheck` (the eval tsconfig includes the
 * whole `src` tree and excludes only the `.test.ts` glob) and never executed by
 * vitest. A drift makes the typecheck gate fail — see the sibling
 * `scorer-assignability.test-d.ts` for the same mechanism.
 */
import type { Accounting, AccountingReason, AccountingUsage, AxlRuntime } from '@axlsdk/axl';

import type { EvalAccounting, EvalConfig, EvalProgressEvent, EvalResult } from '../types.js';

/**
 * The runtime's structural shapes are read off the PUBLIC signature of
 * `runtime.eval()` rather than imported by name: `RuntimeEvalConfigShape` and
 * `EvalProgressEventShape` are declared in `runtime.ts` but are not currently
 * re-exported from the `@axlsdk/axl` barrel, so this is exactly the surface an
 * integrator has to satisfy.
 */
type RuntimeEvalConfigShape = Parameters<AxlRuntime['eval']>[0];
type RuntimeEvalOptions = NonNullable<Parameters<AxlRuntime['eval']>[1]>;
type EvalProgressEventShape = Parameters<NonNullable<RuntimeEvalOptions['onProgress']>>[0];

/** `true` only when A and B are the SAME type, not merely mutually assignable. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function expectTrue<T extends true>(): void {
  void 0 as unknown as T;
}

// ── 1. The runtime's structural EvalConfig accepts the real one ─────────────
// This is the exact assignment `runtime.eval(config)` performs. A field the
// runtime declares but `EvalConfig` renamed or retyped breaks here.
declare const realConfig: EvalConfig;
const asRuntimeShape: RuntimeEvalConfigShape = realConfig;
void asRuntimeShape;

// …and every primitive knob the runtime forwards is spelled identically on
// both sides, so a caller can build the config against either declaration.
expectTrue<Equals<EvalConfig['budget'], RuntimeEvalConfigShape['budget']>>();
expectTrue<Equals<EvalConfig['concurrency'], RuntimeEvalConfigShape['concurrency']>>();
expectTrue<Equals<EvalConfig['scorerConcurrency'], RuntimeEvalConfigShape['scorerConcurrency']>>();
expectTrue<
  Equals<EvalConfig['failOnScorerErrorRate'], RuntimeEvalConfigShape['failOnScorerErrorRate']>
>();
expectTrue<
  Equals<EvalConfig['failOnItemErrorRate'], RuntimeEvalConfigShape['failOnItemErrorRate']>
>();
expectTrue<Equals<EvalConfig['workflow'], RuntimeEvalConfigShape['workflow']>>();
expectTrue<Equals<EvalConfig['metadata'], RuntimeEvalConfigShape['metadata']>>();

// ── 2. Progress events are the same union in both directions ────────────────
// `runtime.eval({ onProgress })` types the callback with the core shape while
// the runner emits the eval one, so these must be MUTUALLY assignable.
expectTrue<Equals<EvalProgressEvent, EvalProgressEventShape>>();
declare const coreProgress: EvalProgressEventShape;
const asEvalProgress: EvalProgressEvent = coreProgress;
void asEvalProgress;

// ── 3. EvalAccounting extends the core Accounting, never a second copy ──────
declare const evalAccounting: EvalAccounting;
const asCoreAccounting: Accounting = evalAccounting;
void asCoreAccounting;

// Field-by-field identity: a re-declared local copy of the record would satisfy
// the structural assignment above while silently drifting on any one of these.
expectTrue<Equals<EvalAccounting['usage'], AccountingUsage>>();
expectTrue<Equals<EvalAccounting['usage'], Accounting['usage']>>();
expectTrue<Equals<EvalAccounting['reasons'], Accounting['reasons']>>();
expectTrue<Equals<EvalAccounting['operations'], Accounting['operations']>>();
expectTrue<Equals<EvalAccounting['breakdown'], Accounting['breakdown']>>();
expectTrue<Equals<EvalAccounting['provenance'], Accounting['provenance']>>();
expectTrue<Equals<EvalAccounting['completeness'], Accounting['completeness']>>();
expectTrue<Equals<keyof EvalAccounting['reasons'], AccountingReason>>();

// Rescore provenance carries the CORE record, so a reader can hand
// `source.generation` to anything that takes an `Accounting`.
expectTrue<Equals<NonNullable<EvalAccounting['source']>['generation'], Accounting | null>>();

// ── 4. The result's accounting is that same type ────────────────────────────
expectTrue<Equals<NonNullable<EvalResult['accounting']>, EvalAccounting>>();
declare const result: EvalResult;
const resultAccountingAsCore: Accounting | undefined = result.accounting;
void resultAccountingAsCore;

// A per-item / per-scorer record is the plain core type — items do not get a
// scope or a budget of their own.
expectTrue<Equals<NonNullable<EvalResult['items'][number]['accounting']>, Accounting>>();
