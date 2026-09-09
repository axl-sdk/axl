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
- it is not turned into a tool failure fed back to the model, and it is not retried.

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
