# Migration: Stream-First Observation

> **Versions:** 0.19.x → next breaking release
> **Scope:** Anyone iterating `AxlStream`, calling `runtime.execute()` / `runtime.stream()` / `runtime.createContext()`, using `Session.send` / `Session.stream`, observing events from inside a workflow handler, or using the legacy `onToken` / `onToolCall` / `onAgentStart` callbacks.

## What changed

The Stream-First Observation API and the v2 tool lifecycle now ship as one
coherent contract:

1. **`ctx.events`** — a lazy `AxlEventBus` accessible from every `WorkflowContext`. Iterate `AxlEvent` from inside a workflow handler — including between `ctx.ask()` calls — without standing up a `runtime.stream()` consumer outside.
2. **Coalescing `partialObjects` view** on both `AxlStream` and `ctx.events`. Yields the latest `partial_object` payload per `askId` with the 1-indexed `attempt`. Designed for streaming-structured-output UIs that render the current state, not every intermediate snapshot.
3. **Bounded queue + overflow policy** on every `AxlEventBus`. Default cap of `10_000` events, overflow drops the oldest non-terminal. Strict mode (`'throw'`) raises a typed `EventStreamOverflowError`.
4. **`events: EventStreamOptions`** plumbed through every entry point: `runtime.execute()`, `runtime.stream()`, `runtime.createContext()`, `Session.send`, `Session.stream`, `AxlTestRuntime.execute`.
5. **Legacy callback removal.** `onToken`, `onToolCall`, and `onAgentStart` are
   no longer accepted by `runtime.createContext()`. TypeScript rejects them;
   JavaScript or cast-through-`unknown` callers receive a targeted runtime error
   pointing to this guide. The values are never invoked.
6. **Explicit wire streaming mode.** `runtime.stream()` selects the provider's
   streaming path directly; it no longer installs an internal callback
   sentinel or allocates `ctx.events` behind the consumer's back. Child
   contexts inherit that mode.
7. **Tool lifecycle event schema v2.** Live events carry
   `schemaVersion: 2`, live `ExecutionInfo` carries `eventSchemaVersion: 2`,
   pre-start failures emit `tool_call_rejected`, and every accepted tool call
   closes with one `tool_call_end.data.outcome` status: `succeeded`, `failed`,
   `denied`, or `cancelled`.
8. **Return means success.** A normally returned tool value succeeds regardless
   of property names. A returned `{ error: ... }` is ordinary application data;
   use the exported `ToolFailure` when a known failure is safe to explain to the
   model, or throw an ordinary error to abort the ask.

## TL;DR

Remove all three callback options before upgrading. Subscribe to `ctx.events`
before the first `ctx.ask()` on an ad-hoc context, use `runtime.stream()` for one
wire execution, or use `runtime.on('trace', ...)` for cross-execution
observation. Audit tools that both return an object with an `error` field and
define `hooks.after`: that hook now runs because normal return control flow is
always success.

## New API at a glance

```typescript
// Inside a workflow handler — observe between asks. Self-contained
// snippet (declare the agents/schemas it uses, allocate the bus
// before the first ask).
const outlineSchema = z.object({ outline: z.array(z.string()) });
const draftSchema = z.object({ draft: z.string() });
const planner = agent({ model: 'openai:gpt-4o', system: 'Plan an outline.' });
const writer = agent({ model: 'openai:gpt-4o', system: 'Write the draft.' });

const wf = workflow({
  name: 'two-step',
  input: z.object({ topic: z.string() }),
  handler: async (ctx) => {
    // `ctx.events` is a lazy getter; touch it synchronously before
    // the first ctx.ask() so the streaming gate fires for every ask
    // in this handler. Defensive `void ctx.events;` (or
    // `const events = ctx.events;`) is the unambiguous pattern.
    const events = ctx.events;
    void (async () => {
      for await (const partial of events.partialObjects) {
        // partial: { askId, agent?, object, attempt }
        console.log(`[ask ${partial.askId} attempt ${partial.attempt}]`, partial.object);
      }
    })().catch((err) => ctx.log('observer.failed', { error: String(err) }));

    const outline = await ctx.ask(planner, ctx.input.topic, { schema: outlineSchema });
    return ctx.ask(writer, JSON.stringify(outline), { schema: draftSchema });
  },
});

// New options on every entry point
runtime.execute('two-step', input, { events: { maxQueued: 5_000 } });
runtime.stream('two-step', input, { events: { onOverflow: 'throw' } });
runtime.createContext({ signal: ac.signal, events: { maxQueued: 100 } });
session.send('two-step', input, { events: { maxQueued: 5_000 } });
session.stream('two-step', input, { events: { onOverflow: 'throw' } });
```

## Behavior changes (read this if you're upgrading)

### 1. `AxlStream` now applies a default queue cap

Before this release, `AxlStream`'s iterator queue was unbounded — a slow consumer would let it grow until the process OOM'd. The default is now `maxQueued: 10_000` with `onOverflow: 'drop-oldest-non-terminal'`. Terminal events (`done`, `error`, `workflow_end`) are never dropped. Listener-based `stringStream()` subscribers use the same cap: undrained updates coalesce per ask/path and distinct pending fields follow the overflow policy. The first overflow per stream emits a one-shot `console.warn`.

**Action required:** none for typical consumers. The cap is well above any normal usage.

**If you somehow relied on unbounded queueing:**

```typescript
runtime.stream(name, input, { events: { maxQueued: Infinity } });
```

This restores pre-release behavior.

### 2. `runtime.execute()` can now stream tokens — under one condition

Before the stream-first preparation release, `runtime.execute()` always took
the non-streaming `provider.chat` code path. Now the streaming path activates
when the workflow handler has allocated `ctx.events` before `ctx.ask()` starts.
The removed callbacks are not streaming gates. If your workflow handler does
**not** access `ctx.events`, behavior is unchanged.

If your handler does access `ctx.events`, individual `ctx.ask()` calls now go through `provider.stream` instead of `provider.chat`. The final `ProviderResponse` is the same shape; the difference is per-token streaming events fire alongside it.

**Action required:** none unless you have provider-specific assumptions about which API path is taken (e.g., a custom provider that implements `chat` but not `stream`). All four built-in providers (`openai`, `openai-responses`, `anthropic`, `gemini`) implement both.

### 3. `Session.stream`'s `signal` option now actually works

Before this release, passing `{ signal }` to `Session.stream` was silently dropped — the signal threw if pre-aborted but never reached `runtime.stream()`. After this release the signal is correctly forwarded.

**Action required:** none. If you were passing a signal expecting it to abort the stream, it now does.

### 4. `onOverflow: 'throw'` on `AxlStream` now actually throws

Before this release, setting `onOverflow: 'throw'` on `runtime.stream`'s `events` option (or directly on `AxlStream`) was silently swallowed — the runtime's internal `onTrace` try/catch (designed to isolate buggy user trace listeners) ate the strict-mode signal. After this release, the bus throws a typed `EventStreamOverflowError` and `WorkflowContext.emitEvent` re-throws it through the trace-listener guard so it reaches the workflow's promise rejection.

**Action required:** if you opted into `'throw'` and were depending on the silent-swallow behavior, switch to the default `'drop-oldest-non-terminal'`. If you actually wanted strict-mode failure, your `runtime.stream()` promise will now reject with `EventStreamOverflowError`. Catch it explicitly:

```typescript
import { EventStreamOverflowError } from '@axlsdk/axl';

try {
  const stream = runtime.stream(name, input, { events: { onOverflow: 'throw' } });
  await stream.promise;
} catch (err) {
  if (err instanceof EventStreamOverflowError) {
    // overflow — slow consumer, runaway producer, or test-mode strict failure
  } else {
    throw err;
  }
}
```

> **Note:** on `runtime.execute()` (no `AxlStream`), `'throw'` only fires if the workflow handler allocated `ctx.events` and that bus saturates. On `runtime.stream()`, the wire-side `AxlStream` bus always applies the policy.

### 5. Tool return values are no longer inspected for an `error` property

Previously, a normally returned object with an `error` property could be
classified as a tool failure. That heuristic is gone. Inherited, accessor,
proxy-backed, nested, and truthy `error` properties do not affect handler
classification; normal hook and output-preparation behavior still applies:

```typescript
const lookup = tool({
  name: 'lookup',
  description: 'Look up a case',
  input: z.object({ id: z.string() }),
  handler: async ({ id }) => ({ id, error: null, status: 'open' }),
  hooks: {
    after: async (result) => ({ ...result, observed: true }),
  },
});
```

The `after` hook now runs after every normal handler return. If an older tool
returned `{ error: ... }` and relied on Axl skipping `after`, audit that hook for
newly-triggered side effects before upgrading.

Known failures that are safe for model recovery must be explicit:

```typescript
import { ToolFailure } from '@axlsdk/axl';

throw new ToolFailure({
  message: 'Case service rejected the transition', // host diagnostic
  modelMessage: 'The case cannot be updated in its current state.',
  code: 'CASE_STATE_CONFLICT',
  cause,
});
```

A handler-thrown `ToolFailure` is retried according to the existing `retry`
policy; hooks retain their existing no-retry behavior. If the failure remains
terminal, its author-declared `modelMessage` is sent to the model and the agent
loop continues. An ordinary hook/handler throw is host-diagnostic only, closes
the call as failed, and aborts the ask without a tool message. Denial and MCP
`isError` also continue; cancellation and approval/projection/serialization
failures abort.

### 6. Tool lifecycle events use the v2 terminal union

Invalid JSON, invalid local arguments, and unavailable tools now emit
`tool_call_rejected` without a `tool_call_start`. `tool_denied` is removed.
Accepted calls emit `tool_call_start`, then exactly one correlated
`tool_call_end` in a complete trace. Narrow the terminal result before reading
variant fields:

```typescript
ctx.events.on('tool_call_end', (event) => {
  const { outcome } = event.data;
  switch (outcome.status) {
    case 'succeeded':
      renderResult(outcome.result);
      break;
    case 'failed':
      reportFailure(outcome.failure.phase, outcome.failure.error);
      break;
    case 'denied':
      renderDenied(outcome.reason);
      break;
    case 'cancelled':
      renderCancelled(outcome.cancellation.phase);
      break;
  }
});
```

Pair v2 calls by `(executionId, askId, callId)`, never by tool name or globally
by `callId`. Duration covers wall time from start through the terminal decision,
including approval wait, hooks, retries, handler work, and output preparation.
Queue overflow, capped persistence, disconnection, and process death can still
produce an incomplete consumer view; do not synthesize a failure for an orphan
start.

### 7. Persisted event history is dual-read, single-write

New live events have `schemaVersion: 2`; new live executions have
`eventSchemaVersion: 2`. History APIs return `HistoricalExecutionInfo`, a union
of v2 executions and legacy v1 executions. Missing version metadata means v1.
New writers produce only v2, while built-in stores and Studio continue to read
v1 without guessing a v2 outcome from legacy `data.result` or `tool_denied`
events. Narrow on `eventSchemaVersion === 2` before using v2-only event shapes.

## When to use which observation surface

| You want to … | Use |
|---|---|
| Stream tokens to a chat-bubble UI | `runtime.stream(name, input).text` |
| Render an incrementally-filling form | `runtime.stream(name, input).partialObjects` (or `ctx.events.partialObjects` from inside the handler) |
| Observe events between two `ctx.ask()` calls in a workflow handler | `ctx.events` (subscribe at the top of the handler) |
| Application-wide telemetry / cost dashboards / OTel | `runtime.on('trace', event => …)` |
| Test a tool in isolation | `runtime.createContext()` + `tool.run(ctx, input)`; iterate `ctx.events` if you want event-level assertions |

The four channels are **alternatives**, not additive — accumulating cost from `ctx.events` AND `runtime.on('trace', …)` would double-count.

Allocating `ctx.events` selects the provider streaming transport for subsequent
asks. The removed `onAgentStart`/`onToolCall`-only path did not. If you need only
structural events and must keep a custom provider on its non-streaming transport,
use `runtime.on('trace', ...)` filtered by `executionId` instead of allocating
the context bus.

## Migrating legacy callbacks

Create the context first, attach an event observer, and only then start the
ask. The bus is lazy, so this ordering also makes the provider's streaming path
explicit.

### Tokens and root-only filtering

```typescript
// Before
const ctx = runtime.createContext({
  onToken: (token, meta) => {
    if (meta.depth === 0) display(token);
  },
});

// After
const ctx = runtime.createContext();
ctx.events.on('token', (event) => {
  if (event.depth === 0) display(event.data);
});
```

If you only need text, use the string-only curated view:

```typescript
void (async () => {
  for await (const token of ctx.events.text) display(token);
})();
```

The `.text` view intentionally yields only strings. Use the typed `token`
event listener above when you need `depth`, `askId`, or agent correlation.

### Tool and agent starts

```typescript
// Before (0.19.x)
const ctx = runtime.createContext({
  onAgentStart: ({ agent, model }, meta) =>
    recordAgentStart({ agent, model, askId: meta.askId, depth: meta.depth }),
  onToolCall: ({ name, args, callId }, meta) =>
    recordToolStart({ name, args, callId, askId: meta.askId, depth: meta.depth }),
});

// After
ctx.events.on('tool_call_start', (event) => {
  recordToolStart({
    name: event.tool,
    args: event.data.args,
    callId: event.callId,
    askId: event.askId,
    depth: event.depth,
    agent: event.agent,
  });
});
ctx.events.on('tool_call_end', (event) => {
  recordToolEnd(event.askId, event.callId, event.data.outcome);
});
ctx.events.on('tool_call_rejected', (event) => {
  recordToolRejection(event.askId, event.callId, event.data);
});

ctx.events.on('agent_call_start', (event) => {
  recordAgentStart({
    agent: event.agent,
    model: event.model,
    askId: event.askId,
    depth: event.depth,
  });
});
```

For a staged application migration, a userland adapter can preserve
callback-shaped consumers without restoring callback control flow:

```typescript
import type { AxlEventBus, AxlEventOf } from '@axlsdk/axl';

type ObserverMeta = {
  askId: string;
  parentAskId?: string;
  depth: number;
  agent?: string;
};

function meta(
  event: AxlEventOf<'token' | 'agent_call_start' | 'tool_call_start'>,
): ObserverMeta {
  return {
    askId: event.askId,
    ...(event.parentAskId ? { parentAskId: event.parentAskId } : {}),
    depth: event.depth,
    ...(event.agent ? { agent: event.agent } : {}),
  };
}

export function attachLegacyObservers(
  events: AxlEventBus,
  observers: {
    token?: (value: string, meta: ObserverMeta) => void;
    agentStart?: (value: { agent: string; model: string }, meta: ObserverMeta) => void;
    toolStart?: (
      value: { name: string; args: unknown; callId: string },
      meta: ObserverMeta,
    ) => void;
  },
): () => void {
  const onToken = (event: AxlEventOf<'token'>) => observers.token?.(event.data, meta(event));
  const onAgent = (event: AxlEventOf<'agent_call_start'>) =>
    observers.agentStart?.({ agent: event.agent, model: event.model }, meta(event));
  const onTool = (event: AxlEventOf<'tool_call_start'>) =>
    observers.toolStart?.(
      { name: event.tool, args: event.data.args, callId: event.callId },
      meta(event),
    );

  events.on('token', onToken);
  events.on('agent_call_start', onAgent);
  events.on('tool_call_start', onTool);
  return () => {
    events.off('token', onToken);
    events.off('agent_call_start', onAgent);
    events.off('tool_call_start', onTool);
  };
}
```

This adapter is not exported by Axl. Listener exceptions remain isolated and
cannot reproduce the removed callbacks' accidental control-flow behavior.

Unlike the old callbacks, the event union also exposes correlated terminal
events. Match `tool_call_end` to its start with
`(executionId, askId, callId)`, not tool name.

### Nested asks

Use `event.depth === 0` for the old root-only display. To retain nested output,
route by `askId`, or consume the built-in grouped view:

```typescript
void (async () => {
  for await (const chunk of ctx.events.textByAsk) {
    appendToMessage(chunk.askId, chunk.text, {
      agent: chunk.agent,
    });
  }
})();
```

### Cross-execution and cross-suspension observation

An ad-hoc context's bus covers that context only. Use the runtime trace emitter
for telemetry spanning many executions or an `awaitHuman` suspension/resume:

```typescript
runtime.on('trace', (event) => persistTelemetry(event));
```

Use `runtime.stream()` when the observer owns one wire execution. It selects
streaming mode directly and returns both the event iterable and final-result
promise; it does not need a hidden callback sentinel.

### Ad-hoc context cleanup

Prefer a signal so cancellation disposes the event bus and any active ask:

```typescript
const controller = new AbortController();
const ctx = runtime.createContext({ signal: controller.signal });
const events = ctx.events;

try {
  return await tool.run(ctx, input);
} finally {
  controller.abort();
  // If no signal is available, call ctx.disposeEvents() instead.
}
```

### Callback throws no longer control the workflow

Legacy callbacks ran synchronously, so a throw could accidentally interrupt
the ask. Event listeners are observation boundaries: listener exceptions are
isolated and logged so telemetry or UI code cannot crash the workflow. Use an
`AbortController`, a tool approval policy, or explicit workflow logic when the
observer must affect control flow.

```typescript
const controller = new AbortController();
const listener = (event: AxlEvent) => {
  if (event.executionId === executionId && shouldCancel(event)) {
    controller.abort('cancelled by application policy');
  }
};

runtime.on('trace', listener);
try {
  await runtime.execute('workflow', input, { signal: controller.signal });
} finally {
  runtime.off('trace', listener);
}
```

If an untyped caller still supplies any removed callback key to
`runtime.createContext()`, context creation throws immediately with an
`INVALID_CONFIG` migration error. Presence is rejected even when the property
value is `undefined`; the runtime does not read or invoke the value. Remove the
key rather than disabling its value.

## Migrating tests and configured tool mocks

`AxlTestRuntime.toolCalls()` now returns correlated records with the typed v2
`outcome`; it no longer assumes every end is `{ args, result }`. Narrow the
status before reading a result:

```typescript
const [call] = runtime.toolCalls('lookup');
expect(call.callId).toBeTruthy();
if (call.outcome.status !== 'succeeded') {
  throw new Error(`Expected success, got ${call.outcome.status}`);
}
expect(call.outcome.result).toEqual({ found: true });
```

Configured `mockTool()` handlers intentionally still bypass the configured
local schema, approval, retry, hooks, and real handler. Provider argument JSON
parsing still happens before mock selection. The configured tool contributes
only its `sensitive` and `toModelOutput` policy. A mock return, including
`{ error: ... }`, succeeds; an ordinary mock throw aborts; a `ToolFailure`
continues with only its explicit model-safe text.

## Studio, counters, cost, and OpenTelemetry

Studio dual-reads history. Missing version metadata is v1 and stays labeled
legacy; v2 is rendered from the terminal union. Trace aggregates no longer use
one ambiguous `calls/approved/denied` bucket. V2 counts are
`accepted/succeeded/failed/failedByPhase/denied/cancelled/rejected/approved`,
and v1 `calls/approved/denied` remain under a separate `legacy` bucket.

The new lifecycle adds observable starts, rejections, and terminal ends, so
event totals and accepted-call counts can increase relative to v1. It does not
add provider work or billing. Continue calculating spend from cost-bearing
model/embedder events (or `eventCostContribution`), never by counting tool
events.

Tool spans expose only structural status: `succeeded` maps to OTel `OK`,
`failed` and `cancelled` map to `ERROR`, and `denied` maps to `UNSET`.
`axl.tool.outcome`, `axl.tool.phase`, and duration remain available. Raw
handler/hook/approval messages, results, and provider-safe tool text are not
placed in span attributes or status descriptions.

## Rollback and mixed-version deployments

The breaking runtime is single-write v2 and dual-read v1/v2. A rollback to a
0.19.x runtime is unsafe after any v2 execution has been persisted because the
older reader does not understand `tool_call_rejected` or the terminal union.
Before deploying, verify every service that reads execution history and every
Studio instance understands v2. During a rolling upgrade, upgrade readers
first, then writers. Do not rewrite old rows or strip version metadata.

If rollback is required after v2 writes begin, stop new executions and restore
the previous application together with a database snapshot taken before the
first v2 write, or keep the new dual-read runtime in place while reverting only
unrelated application code. Downgrading just the package against mixed history
is not supported.

## Lifecycle gotchas

- **Subscribe early.** The `ctx.events` bus is allocated on first access. The streaming code path inside `ctx.ask()` activates only when an observer is present at the time the ask starts. If you allocate `ctx.events` AFTER a `ctx.ask()` has begun, that in-flight ask will not stream `token` / `partial_object` events at all (the agent loop went through `provider.chat` instead of `provider.stream`). Subsequent asks (started after the bus exists) stream normally — the gate is re-checked per ask. The unambiguous pattern is `const events = ctx.events;` on the first line of the handler — touching the getter synchronously wires every subsequent ask. (The IIFE pattern works because `for await (...ctx.events.partialObjects)` evaluates the getter before its first await, but the explicit allocation is foolproof against refactors that move the iterator setup into a helper.)
- **Late subscription is partly recoverable for `partialObjects`.** The bus's iterator queue retains events emitted before any consumer iterates, so a late `for await (const e of ctx.events)` will still drain whatever is already queued. The `partialObjects` view additionally seeds from a per-bus `latestPartialByAsk` map so a late subscriber sees the latest coalesced state from earlier in the run. Neither rescues you from the streaming-gate behavior — for full token/partial fidelity, allocate the bus before the first ask.
- **Handler exceptions still terminate the bus.** When the workflow handler throws, the runtime emits a terminal `error` event and finishes the bus, so `for await (const e of ctx.events)` resolves cleanly with `done: true`. You don't need defensive `try/finally` around the observer iteration. The thrown error is independently rejected on the `runtime.execute()` / `runtime.stream()` promise.
- **Auto-dispose on signal abort.** When `runtime.createContext({ signal })` is constructed with an `AbortSignal` and the signal fires, the bus is auto-disposed (iterators terminate with `done: true`). If `signal` is already aborted at the time `ctx.events` is first accessed, the bus terminates immediately on access. This protects long-lived ad-hoc context flows from leaking iterator consumers.
- **Manual disposal for ad-hoc contexts without a signal.** `ctx.disposeEvents()` is idempotent and safe to call after `workflow_end` / `error` already auto-finished the bus. Workflow-driven contexts (`runtime.execute` / `runtime.stream`) terminate automatically and don't need this. Prefer `signal: AbortSignal.timeout(...)` over manual disposal — it composes with timeout/cancellation/budget without manual threading.
- **Cost rollup — pick one channel.** Don't `total += event.cost` from `ctx.events` AND `runtime.on('trace', …)` — same events fan out to both, you'll double-count. Use `eventCostContribution(event)` from `@axlsdk/axl` (skips per-ask `ask_end` rollups) or read `ctx.totalCost`. The four observation channels are alternatives, not additive.
- **`ctx.events` does not bridge across re-execution after `awaitHuman` suspension.** A later execution gets a fresh `WorkflowContext` with its own bus. For cross-execution observation, use `runtime.on('trace', …)` instead. The legacy cross-process resume helper is not an exactly-once decision protocol; see the approval-gate security notes.

## See also

- [Observability paths](../observability.md#observation-paths) — full table comparing all four observation channels.
- [`ctx.events`](../api-reference.md#ctxevents) — type reference, lifecycle, and curated views.
- [`EventStreamOptions`](../api-reference.md#eventstreamoptions) — queue-cap and overflow-policy reference.
- [`AxlStream`](../api-reference.md#axlstream) — wire-side stream and curated views.
