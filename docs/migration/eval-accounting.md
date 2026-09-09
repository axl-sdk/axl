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

What is not preserved: exotic reflection — a custom `Symbol.hasInstance`, or using the
provider object as an identity key in a `Map`/`Set` that is also keyed by the raw
instance elsewhere. Compare by `instanceof` or by a field, not by reference.

### 2. `trackExecution().cost` comes from the accounting scope

`cost` is now `accounting.knownCost` and `unpriced` is
`accounting.completeness !== 'complete'`; the return value also gains `accounting`.

For instrumented paths the numbers are **identical** to the old trace sum. They differ
only where the trace rail used to lose a charge — most visibly a leaf that never
settled, which previously contributed nothing silently and now marks the result
`unpriced` with a reason. A run that threw now reports its cost at all, via the new
non-throwing [`runtime.trackOutcome`](../api-reference.md#runtimetrackoutcomefn-options).

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
