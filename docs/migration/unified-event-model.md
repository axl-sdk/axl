# Migration: Unified Event Model

> **Versions:** 0.15.x → 0.16.x
> **Spec:** Internal `spec/16-streaming-wire-reliability`
> **Scope:** Anyone consuming `TraceEvent`, `StreamEvent`, `ExecutionInfo.steps`, `AxlStream.steps`, or the `onToken` / `onToolCall` / `onAgentStart` callbacks.

## What changed

Axl had two parallel event models that duplicated each other:

- `TraceEvent` — rich, persisted to `ExecutionInfo.steps`, the authoritative trace record.
- `StreamEvent` — lean, emitted on the wire via `AxlStream`, derived from `TraceEvent` by a translation layer in `runtime.ts` that **dropped fields**.

The duplication caused three user-visible bugs that this release fixes:

1. **Nested asks were half-visible** on the wire. Token streams and tool-call args from sub-agents were silently dropped. Now every nested ask flows to the same wire with `askId` / `parentAskId` / `depth` so consumers can group-by and reconstruct the tree.
2. **Retries silently re-emitted tokens** in `AxlStream.fullText`, garbling output. Now `AxlStream.fullText` commits on `pipeline(status: 'committed')` and discards on `pipeline(status: 'failed')` — retried attempts never leak into the committed buffer.
3. **`validate + onToken` threw `INVALID_CONFIG`** rather than working — a defensive workaround for the retry-leak above. That configuration is now supported end-to-end because the retry-leak is fixed at the source.

This release collapses both models into one `AxlEvent` discriminated union. The wire format IS the trace format — same shape, full fidelity, zero translation. The translation layer is gone; the runtime is a pure fan-out.

## TL;DR

If you're migrating a typical consumer:

1. Rename `TraceEvent` / `StreamEvent` imports → `AxlEvent`.
2. Rename `ExecutionInfo.steps` → `.events`.
3. Rename `AxlStream.steps` → `.lifecycle`.
4. Rename event-type narrowing: `'agent_call'` → `'agent_call_end'`, `'tool_call'` → `'tool_call_end'`.
5. Add `meta` parameter to your `onToken` / `onToolCall` / `onAgentStart` callbacks. If you want root-only behavior, filter on `meta.depth === 0`.
6. If you wrap `done` events: read `data.result` instead of `data` (now always wrapped as `{ result }`).
7. If you wrap `error` events: read `data.message` instead of top-level `message`.
8. **Optional but recommended:** start consuming the new `ask_start`/`ask_end` events for ask-level cost rollup (`ask_end.cost` per spec decision 10), and the new `agent_call_start`/`tool_call_start` events for pre-execution observability.

## Before / after — typical consumer

### Reading `ExecutionInfo`

```diff
 const info = await runtime.execute(workflow, input);
- for (const step of info.steps) {
-   if (step.type === 'agent_call') console.log(step.data.response);
+ for (const event of info.events) {
+   if (event.type === 'agent_call_end') console.log(event.data.response);
 }
```

### Iterating `AxlStream`

```diff
- import type { StreamEvent } from '@axlsdk/axl';
+ import type { AxlEvent } from '@axlsdk/axl';

 const stream = runtime.stream(workflow, input);
 for await (const event of stream) {
   if (event.type === 'token') console.log(event.data);
-  if (event.type === 'tool_call') console.log(event.name, event.args);
-  if (event.type === 'tool_result') console.log(event.name, event.result);
-  if (event.type === 'agent_start') console.log(event.agent, event.model);
-  if (event.type === 'agent_end') console.log(event.agent, event.cost);
+  if (event.type === 'tool_call_start') console.log(event.tool, event.data.args);
+  if (event.type === 'tool_call_end') console.log(event.tool, event.data.result);
+  if (event.type === 'agent_call_start') console.log(event.agent, event.model);
+  if (event.type === 'agent_call_end') console.log(event.agent, event.cost);
 }
```

### `AxlStream.steps` → `.lifecycle`

```diff
- for await (const step of stream.steps) {
-   console.log(step.type);
+ for await (const event of stream.lifecycle) {
+   console.log(event.type);
 }
```

The `.lifecycle` iterator also includes the new `ask_start` / `ask_end` / `agent_call_start` / `tool_call_start` events.

### `done` and `error` events

Both are now wrapped under `data` for consistency with the rest of the union:

```diff
 stream.on('done', (event) => {
-  const result = event.data;
+  const result = event.data.result;
 });

 stream.on('error', (event) => {
-  const message = event.message;
+  const message = event.data.message;
 });
```

### Streaming callbacks gain `meta`

```diff
 const ctx = runtime.createContext({
-  onToken: (token) => display(token),
+  onToken: (token, meta) => {
+    if (meta.depth === 0) display(token); // root-only chat UI
+  },
 });
```

The `meta` object: `{ askId, parentAskId?, depth, agent }`. Drop the `depth === 0` filter to display tokens from nested asks too.

### `createChildContext` no longer isolates callbacks

In 0.15.x, `createChildContext()` cleared `onToken`/`onToolCall`/`onAgentStart` so a tool handler invoking a sub-agent didn't leak nested tokens to the outer chat UI. In 0.16.x, the child context **inherits** these callbacks; if you want root-only behavior, filter on `meta.depth === 0` at the callback site.

```diff
 const subAgent = agent({...});
 const myTool = tool({
   handler: async (input, ctx) => {
-    // 0.15.x: tokens from this ask were silently dropped
+    // 0.16.x: tokens reach the outer onToken with meta.depth >= 1
     return ctx.ask(subAgent, input.q);
   },
 });
```

If your code relied on the old isolation as a feature (e.g., your chat UI accidentally rendered subagent tokens because you didn't have a way to filter them), add the `meta.depth === 0` filter — that's the intentional consumer contract going forward.

### Validate + streaming now coexist

```diff
 const ctx = runtime.createContext({
   onToken: (token) => display(token),
 });
- // 0.15.x: this throws INVALID_CONFIG
+ // 0.16.x: validate runs against the buffered response
 const result = await ctx.ask(myAgent, 'q', {
   schema: z.object({...}),
   validate: (out) => ({ valid: out.x > 0 }),
 });
```

In PR 2 the new `pipeline` events and `AxlStream.fullText` commit-on-success fix will provide retry-boundary visibility — until then, retried tokens still concatenate in the raw stream. Consumers buffering tokens for display should filter on `event.type === 'pipeline' && event.status === 'failed'` to discard.

## New capability: ask-graph correlation

Every event originating within a `ctx.ask()` call now carries:

- `askId: string` — the ask invocation
- `parentAskId?: string` — the enclosing ask (absent on the root)
- `depth: number` — 0 for root; +1 per nested `ctx.ask()`
- `agent?: string` — the emitting agent's name

Reconstruct the ask tree by grouping on `askId` and parent-linking on `parentAskId`. The `step` field is monotonic across the **whole execution tree** (shared via `AsyncLocalStorage`), so consumers ordering events for waterfall UIs no longer need to merge per-ask counters.

```ts
// Build a per-ask cost rollup
const askCosts = new Map<string, number>();
for (const event of info.events) {
  if (event.type === 'ask_end') {
    askCosts.set(event.askId, event.cost); // authoritative per-ask cost
  }
}
```

`ask_end.cost` is the per-ask rollup of `agent_call_end.cost` + `tool_call_end.cost` **emitted within this ask, excluding nested asks** (spec decision 10). Nested asks contribute to their own `ask_end`. The whole-execution total is `ExecutionInfo.totalCost` (or sum the leaf events yourself).

## Failure surfacing — `error` vs `ask_end`

Ask-internal failures (gate retries exhausted, `ctx.verify` failure, handler throw) surface via `ask_end({ outcome: { ok: false, error } })` only — **not** the workflow-level `error` event. The workflow-level `error` is reserved for failures with no `ask_end` available (top-level workflow throws before any ask runs, infrastructure / abort errors).

```ts
// One handler for both — narrow on outcome.ok
runtime.on('trace', (event) => {
  if (event.type === 'ask_end') {
    if (event.outcome.ok) console.log('ask succeeded:', event.outcome.result);
    else console.error('ask failed:', event.outcome.error);
  } else if (event.type === 'error') {
    console.error('workflow error (not ask-internal):', event.data.message);
  }
});
```

If your existing error handler did `runtime.on('trace', e => { if (e.type === 'error') ... })`, ask-internal failures will no longer trigger it. Either:
- Add an `ask_end` handler for the ask-level outcome, or
- Listen for `workflow_end({ status: 'failed' })` for execution-level failure.

## SQLite schema migration

If you use `SQLiteStore`, the `execution_history.steps` column is renamed to `events` automatically on first open of an existing DB. The migration is transactional (`BEGIN IMMEDIATE`), idempotent (gated via `PRAGMA user_version`), and rolls back cleanly on failure. No manual action required.

If you query the table directly (outside `SQLiteStore.getExecution()`), update your SQL: `SELECT events FROM execution_history` instead of `SELECT steps`.

## Studio panels

Studio panels (Playground, Workflow Runner, Trace Explorer) ship migrated in 0.16.x — there's no split-release gap. If you embed Studio via `@axlsdk/studio/middleware`, mount it in 0.16.x exactly as before; the wire format IS the trace format and the bundled React client consumes `AxlEvent` directly.

## FAQ

**Q: Where did `StreamEvent` go?**
Deleted. The wire stream now carries `AxlEvent` directly. Narrow on `event.type` from the new union.

**Q: I had `event.cost` accumulators. Anything to worry about?**
Yes — `ask_end.cost` is a per-ask rollup. If you sum every event's `cost`, you'll double-count. We ship `eventCostContribution(event)` from `@axlsdk/axl` as the single source of truth for the "skip ask_end, finite-check, leaf-only" invariant — use it instead of hand-rolling the guard:

```ts
import { eventCostContribution } from '@axlsdk/axl';

let total = 0;
for (const event of info.events) {
  total += eventCostContribution(event);
}
```

Axl's built-in `runtime.trackExecution`, `ExecutionInfo.totalCost`, and Studio's cost aggregator all call the same helper internally, so upstream behavior is guaranteed to stay in lockstep with yours.

**Q: My tests fixture-built `TraceEvent` objects. How do I migrate?**
Stamp the new required fields (`executionId`, `step`, `timestamp`) and use the new tag names. For ask-scoped events add `askId` and `depth`. Cast via `as unknown as AxlEvent` if your fixture is partial — the runtime invariants are what matter.

**Q: I'm using `parentToolCallId` for telemetry correlation.**
Still works for one more minor cycle (`@deprecated` JSDoc only). Migrate to `parentAskId` (on `AskScoped`) — it's the going-forward correlation field. Removal is in the next minor.

**Q: My consumer doesn't use TypeScript. Will my code break?**
Most properties moved (`event.name` → `event.tool`, `event.message` → `event.data.message`, `event.data` → `event.data.result` on `done`). Expect runtime `undefined` reads where you accessed dropped fields. The migration steps in TL;DR apply identically.

## Reference

- Full event union: `packages/axl/src/types.ts` (search `export type AxlEvent`).
- Spec: `.internal/spec/16-streaming-wire-reliability.md`.
- CHANGELOG: see [`Unreleased` section](../../CHANGELOG.md).
