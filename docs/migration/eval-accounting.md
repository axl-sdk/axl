# Migration: Trustworthy Accounting and Budgets

> **Versions:** 0.23.x → 0.24.0
> **Scope (core):** Anyone calling `runtime.resolveProvider()`, reading `trackExecution().cost` / `.unpriced`, implementing a custom `Provider`, or relying on a budget stop surfacing as a tool failure.

## Why this matters

"What did this run cost?" used to be answered by summing trace events. That rail is
configuration-dependent and lossy: a run that threw, a leaf that never settled, or a
lowered trace level could quietly under-report. Cost is now measured on its own
authoritative rail — [`Accounting`](../api-reference.md#accounting) — which is
independent of tracing, reports what it could *not* establish instead of rounding it
to zero, and can stop new spend at a threshold.

See [accounting vs. traces](../observability.md#two-cost-rails-accounting-vs-traces)
for the full model.

## Core-side breaking changes

### 1. `runtime.resolveProvider()` returns a facade

`resolveProvider(uri).provider === registeredProviderInstance` is now **`false`**. The
returned object is a scoped facade that routes `chat`/`stream` through accounting and
budget admission.

The facade forwards everything else verbatim — custom properties and accessors, class
private-field methods, property writes, the capability methods, and `instanceof`. Its
identity is **stable per runtime per adapter**, so caching a resolution still works.

```typescript
// Before
expect(runtime.resolveProvider('mock:m').provider).toBe(myProvider);

// After
expect(runtime.resolveProvider('mock:m').provider).toBeInstanceOf(MyProvider);
```

What is not preserved:

- **Exotic reflection** — a custom `Symbol.hasInstance`, or using the provider object as
  an identity key in a `Map`/`Set` that is also keyed by the raw instance elsewhere.
  Compare by `instanceof` or by a field, not by reference.
- **Monkey-patching the raw adapter after the facade has already called the method.**
  The facade binds each forwarded method once and caches it; writes *through the facade*
  invalidate that cache, but a write directly onto the registered instance
  (`rawProvider.someMethod = fn`) does not, so an already-bound method keeps serving the
  old function. Patch through `resolveProvider(uri).provider`, or patch before first use.
- **An accessor that returns `this`.** Property reads evaluate on the raw instance so
  class private fields keep working, which means a getter like `get self() { return this }`
  hands back the *unwrapped* adapter; calls made through that reference bypass accounting.

### 2. `trackExecution().cost` comes from the accounting scope

`cost` is now `accounting.knownCost` and `unpriced` is
`accounting.completeness !== 'complete'`; the return value also gains `accounting`.

`cost` itself is unchanged wherever the old trace sum was already right, and higher
wherever that rail lost a charge — a leaf that never settled contributed nothing
silently and is now reported. A run that threw reports its cost at all for the first
time, via the non-throwing
[`runtime.trackOutcome`](../api-reference.md#runtimetrackoutcomefn-options).

**`unpriced` is deliberately wider than before.** It now also flags a call that
**dispatched and came back with neither usage nor a cost** — the trace rail treated that
as "no measurable work" and left `unpriced` false. Expect the flag to flip from `false`
to `true` for:

- a **usage-omitting gateway** or any custom `Provider` returning just `{ content }`,
- a **$0 local adapter** whose profile is not `pricing: { kind: 'zero' }`,
- a **caught provider failure** with no usage on it.

None of these is a new charge; the run's `cost` is the same number it always was. What
changed is that Axl now says out loud that it could not confirm the number, rather than
presenting a lower bound as exact. `accounting.reasons.usage_missing` names the calls
involved.

**`ctx.budget()` keeps the narrower rule, on purpose.** `ctx.getBudgetStatus().unpriced`
and `BudgetResult.unpriced` still flag only a call that reported positive billable work
without a price, so a synthesized empty response or a $0 local provider does not trip a
budget's honesty signal. The two surfaces can therefore disagree about the same run:
`trackExecution().unpriced === true` alongside `ctx.budget().unpriced === false` is
expected, not a bug. Budget enforcement behavior is unchanged.

`runtime.trackCost()` is unchanged.

### 3. A denied operation is a stop, not a failure

When an [`AdmissionController`](../api-reference.md#admissioncontroller) is attached to a
scope, refusing an operation throws
[`AdmissionDeniedError`](../api-reference.md#admissiondeniederror), which passes through
every wrapping boundary intact:

- it is not normalized into a `ProviderError`,
- it is not wrapped in a `TranscriptionOperationError`,
- it is not turned into a tool failure fed back to the model, and it is not retried,
- it is not a `validate` failure in `ctx.ask` or `ctx.verify`, is not retried by
  `ctx.verify`, and never yields its `fallback`,
- `ctx.budget()` rejects with it rather than returning `budgetExceeded: true`, and
- `ctx.spawn`, `ctx.map`, and `ctx.race` reject with it rather than recording
  `{ ok: false }` or throwing `QuorumNotMet`. `ctx.race` and quorum-mode
  `spawn` / `map` also cancel their remaining branches; in default mode,
  in-flight siblings run on and are refused at their next admission check.

If you catch broadly around `ctx.ask` or a tool call and translate errors into a
model-visible message, rethrow `AdmissionDeniedError` so the run actually stops.

This is separate from `ctx.budget()`, whose `BudgetExceededError` and `hard_stop`
semantics are unchanged.

### 4. New optional adapter surface

`ProviderResponse` and the terminal `StreamChunk` gain optional `costProvenance`, and
`ChatOptions` gains an internal `dispatchAdmission`. Both are optional: a custom
`Provider` that ignores them keeps compiling and working. A cost with no provenance is
recorded as `'adapter_reported'` rather than being mislabeled.

An adapter that ignores `dispatchAdmission` still gets the operation-open admission
check; what it loses is refusal of a request already queued in its own governor or
sleeping in its own backoff. See
[dispatch admission](../providers.md#dispatch-admission) to opt in.

## What did not change

`ctx.budget()`, `BudgetExceededError`, `ExecutionInfo.unpriced`, `event.cost` on trace
events, `runtime.trackCost()`, and every provider wire format.

---

## Eval-side breaking changes

> **Scope (eval):** Anyone reading `EvalResult.totalCost` / `EvalItem.cost`, returning a
> `cost` from an eval `executeWorkflow` callback, gating CI on `summary.failures`, or
> consuming stored eval artifacts.

### 1. `totalCost` is measured, not reported

`EvalResult.totalCost` is now a view of `EvalResult.accounting.knownCost` — what the
runtime observed, on the same rail as every other Axl cost. Three consequences:

- **A case that failed after paying now contributes its charge.** Previously a thrown
  workflow contributed `$0`, so a run that broke halfway looked cheap. Expect totals on
  failing runs to go **up** — they were under-reported before.
- **The number no longer depends on tracing.** Trace level, `redact`, and
  `captureTraces` do not change a single figure.
- **`unpriced` is present exactly when `accounting.completeness !== 'complete'`**, and
  `accounting.reasons` says why (`unpriced_model`, `usage_missing`, `uninstrumented`,
  …). A total that could not be established fully is a lower bound, and now says so
  instead of rounding to zero.

`EvalItem.cost` and `EvalItem.scorerCost` are likewise views of
`item.accounting.breakdown.generation` / `.judging`.

### 2. A callback's `cost` is a claim, not a total

Returning `{ output, cost }` from `executeWorkflow` no longer sets the item's cost or
feeds the run total. The value is preserved verbatim on `EvalItem.callerReport.cost`,
and summarized on `accounting.callerReported`, so it can still be inspected and
compared against what was measured — it just cannot overstate or understate the run.

```ts
// Before: item.cost === 0.005, totalCost included it.
// After:  item.cost is the MEASURED generation spend;
//         item.callerReport.cost === 0.005.
async () => ({ output: 'ok', cost: 0.005 });
```

The same applies to a scorer that returns `{ score, cost }`: it lands on
`scoreDetails[name].cost` only when nothing was measured for that scorer on an
uninstrumented runtime, and is never summed into a total.

**If a scorer or tool really does spend money Axl cannot see** — a hosted grader, a vendor
search or embedding API — report it instead of returning it, and it is counted:

```ts
import { externalOperation } from '@axlsdk/axl';

// In a scorer (no ctx). Inside a workflow use ctx.withExternalOperation(...).
return externalOperation({ name: 'vendor-grade' }, async (report) => {
  const res = await callVendor(output);
  report.setCost(res.usd); // joins knownCost and accounting.breakdown.external
  return res.score;
});
```

Admission is checked before `fn` runs, so an external operation obeys `budget` like any
other paid call, and forgetting `setCost` marks the scope incomplete with
`reasons.external_unreported` rather than reading as free.

Reserved diagnostic metadata keys (`models`, `modelCallCounts`, `workflows`,
`workflowCallCounts`, `tokens`, `agentCalls`) returned by a callback no longer override
the runtime's own; they are kept under `EvalItem.callerReport.metadata`.

**If your runtime is uninstrumented** — a hand-rolled `{} as AxlRuntime` in a test, say —
the run is `incomplete` with `reasons.uninstrumented`, `totalCost` is `0`, and your
callback's numbers live in `callerReport`. Use a real `AxlRuntime` to get measured costs.

### 3. Items and scorers carry an outcome

`EvalItem.outcome` distinguishes `completed`, `failed`, `cancelled`, `budget_skipped`
(never started) and `budget_interrupted` (stopped mid-flight), with the same taxonomy
per scorer on `ScorerDetail.outcome`. `EvalSummary.coverage` counts both populations.

`EvalSummary.failures` keeps its old meaning — items that produced no output — so it now
includes budget-stopped cases. **Gate CI on `summary.coverage` instead**: only it
separates "the workflow broke" from "we stopped paying". The `axl-eval` CLI already
does, and prints a distinct `[axl-eval] BUDGET STOPPED …` line before exiting non-zero.

The stop is reported from coverage, not from the budget's own status: a run whose spend
lands exactly on the limit with every case and scorer completed exits **0**, because
nothing was refused — closed admission with no refused work is a coincidence of arithmetic,
not a truncated run. `axl-eval rescore --budget` reports and exits by the same rule, after
writing the partial artifact so the scores that were produced are kept.

### 4. `budget` stops a run at a threshold

`EvalConfig.budget` (and `--budget`, and `rescore`'s new option) closes admission once
known spend reaches the limit: subsequent cases are `budget_skipped`, subsequent LLM
scorers are skipped, deterministic scorers still run, and an in-flight case whose next
call is denied becomes `budget_interrupted` with its earlier charge kept.

It is a **threshold, not a reservation** — concurrent calls admitted before a sibling
settles can carry the run past the limit, and `accounting.budget.knownOvershoot` reports
by how much. An invalid limit throws `AxlError('INVALID_BUDGET')` before the dataset is
even loaded.

### 5. Captured requests are new, opt-in, and change nothing by default

Nothing about an existing run changes: `captureRequests` is off unless you pass
it, `EvalResult.diagnostics` is absent, and no artifact directory is created. If
you turn it on, configure `diagnostics.artifacts` first — a run that asks for
capture on a runtime with nowhere to put it fails immediately with
`AxlError('DIAGNOSTICS_UNAVAILABLE')` rather than after spending.

Two things to check before enabling it in production:

- **Your `StateStore` must implement `getEvalRetention`.** The built-in Memory,
  SQLite and Redis stores do. A custom store without it is rejected at runtime
  construction, because an artifact whose owner's lifetime cannot be read is an
  artifact nothing will ever reclaim.
- **Captured requests contain prompts and responses.** They are redacted before
  they are written when `trace.redact` is on, and again on the way out of
  Studio — see [security.md](../security.md#captured-requests).

### 6. Reading older artifacts

`readAccounting(result)` returns a result's accounting, or synthesizes an `unverified`
record from `totalCost` for a pre-0.24 artifact. `unverified` propagates: through
`aggregateRuns`, through a rescore, and through a JSON round trip. `evalCompare` refuses
to certify a cost comparison whose inputs are unverified, incomplete, of differing scope,
or which covered different amounts of work — `comparison.cost.certified` is `false` and
`.reason` says why, while both raw totals are still shown. `deltaPercent` is `null`
rather than `Infinity` when the baseline was free.

**The structural identities hold only for live records.** On a `complete` or `incomplete`
record, `provenance` sums to `knownCost` and `breakdown` splits it. A synthesized
`unverified` record carries only the single total the old artifact recorded, with a zeroed
breakdown and provenance — those zeros mean "no split available", not "the split is zero".
Render them as unknown rather than charting a legacy run as 100% generation.
