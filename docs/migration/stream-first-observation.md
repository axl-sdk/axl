# Migration: Stream-First Observation

> **Versions:** 0.16.x → next major
> **Scope:** Anyone iterating `AxlStream`, calling `runtime.execute()` / `runtime.stream()` / `runtime.createContext()`, using `Session.send` / `Session.stream`, observing events from inside a workflow handler, or using the legacy `onToken` / `onToolCall` / `onAgentStart` callbacks.

## What changed

The first two phases of the Stream-First Observation API ship:

1. **`ctx.events`** — a lazy `AxlEventBus` accessible from every `WorkflowContext`. Iterate `AxlEvent` from inside a workflow handler — including between `ctx.ask()` calls — without standing up a `runtime.stream()` consumer outside.
2. **Coalescing `partialObjects` view** on both `AxlStream` and `ctx.events`. Yields the latest `partial_object` payload per `askId` with the 1-indexed `attempt`. Designed for streaming-structured-output UIs that render the current state, not every intermediate snapshot.
3. **Bounded queue + overflow policy** on every `AxlEventBus`. Default cap of `10_000` events, overflow drops the oldest non-terminal. Strict mode (`'throw'`) raises a typed `EventStreamOverflowError`.
4. **`events: EventStreamOptions`** plumbed through every entry point: `runtime.execute()`, `runtime.stream()`, `runtime.createContext()`, `Session.send`, `Session.stream`, `AxlTestRuntime.execute`.
5. **Legacy callback deprecation.** `onToken`, `onToolCall`, and `onAgentStart`
   on `runtime.createContext()` still work, but are type-deprecated and warn
   once per process. They will be removed in the next breaking release.
6. **Explicit wire streaming mode.** `runtime.stream()` selects the provider's
   streaming path directly; it no longer installs an internal callback
   sentinel or allocates `ctx.events` behind the consumer's back. Child
   contexts inherit that mode.

## TL;DR

If you do not use the deprecated callbacks, defaults preserve existing behavior
apart from the narrow cases below. Callback consumers should migrate now;
subscribe to `ctx.events` before the first `ctx.ask()` on an ad-hoc context.

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

Before this release, `AxlStream`'s iterator queue was unbounded — a slow consumer would let it grow until the process OOM'd. The default is now `maxQueued: 10_000` with `onOverflow: 'drop-oldest-non-terminal'`. Terminal events (`done`, `error`, `workflow_end`) are never dropped. The first overflow per stream emits a one-shot `console.warn`.

**Action required:** none for typical consumers. The cap is well above any normal usage.

**If you somehow relied on unbounded queueing:**

```typescript
runtime.stream(name, input, { events: { maxQueued: Infinity } });
```

This restores pre-release behavior.

### 2. `runtime.execute()` can now stream tokens — under one condition

Before this release, `runtime.execute()` always took the non-streaming `provider.chat` code path. After this release, the streaming path activates when the workflow handler has allocated `ctx.events` before `ctx.ask()` starts. (`onToken` can also activate streaming on an ad-hoc context created with `runtime.createContext()`, but it is deprecated and is not an `ExecuteOptions` field.) If your workflow handler does **not** access `ctx.events`, behavior is unchanged.

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

## When to use which observation surface

| You want to … | Use |
|---|---|
| Stream tokens to a chat-bubble UI | `runtime.stream(name, input).text` |
| Render an incrementally-filling form | `runtime.stream(name, input).partialObjects` (or `ctx.events.partialObjects` from inside the handler) |
| Observe events between two `ctx.ask()` calls in a workflow handler | `ctx.events` (subscribe at the top of the handler) |
| Application-wide telemetry / cost dashboards / OTel | `runtime.on('trace', event => …)` |
| Test a tool in isolation | `runtime.createContext()` + `tool.run(ctx, input)`; iterate `ctx.events` if you want event-level assertions |

The four channels are **alternatives**, not additive — accumulating cost from `ctx.events` AND `runtime.on('trace', …)` would double-count.

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

ctx.events.on('agent_call_start', (event) => {
  recordAgentStart({
    agent: event.agent,
    model: event.model,
    askId: event.askId,
    depth: event.depth,
  });
});
```

Unlike the old callbacks, the event union also exposes correlated terminal
events. Match `tool_call_end` to its start with `askId` + `callId`, not tool
name.

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

## Lifecycle gotchas

- **Subscribe early.** The `ctx.events` bus is allocated on first access. The streaming code path inside `ctx.ask()` activates only when an observer is present at the time the ask starts. If you allocate `ctx.events` AFTER a `ctx.ask()` has begun, that in-flight ask will not stream `token` / `partial_object` events at all (the agent loop went through `provider.chat` instead of `provider.stream`). Subsequent asks (started after the bus exists) stream normally — the gate is re-checked per ask. The unambiguous pattern is `const events = ctx.events;` on the first line of the handler — touching the getter synchronously wires every subsequent ask. (The IIFE pattern works because `for await (...ctx.events.partialObjects)` evaluates the getter before its first await, but the explicit allocation is foolproof against refactors that move the iterator setup into a helper.)
- **Late subscription is partly recoverable for `partialObjects`.** The bus's iterator queue retains events emitted before any consumer iterates, so a late `for await (const e of ctx.events)` will still drain whatever is already queued. The `partialObjects` view additionally seeds from a per-bus `latestPartialByAsk` map so a late subscriber sees the latest coalesced state from earlier in the run. Neither rescues you from the streaming-gate behavior — for full token/partial fidelity, allocate the bus before the first ask.
- **Handler exceptions still terminate the bus.** When the workflow handler throws, the runtime emits a terminal `error` event and finishes the bus, so `for await (const e of ctx.events)` resolves cleanly with `done: true`. You don't need defensive `try/finally` around the observer iteration. The thrown error is independently rejected on the `runtime.execute()` / `runtime.stream()` promise.
- **Auto-dispose on signal abort.** When `runtime.createContext({ signal })` is constructed with an `AbortSignal` and the signal fires, the bus is auto-disposed (iterators terminate with `done: true`). If `signal` is already aborted at the time `ctx.events` is first accessed, the bus terminates immediately on access. This protects long-lived ad-hoc context flows from leaking iterator consumers.
- **Manual disposal for ad-hoc contexts without a signal.** `ctx.disposeEvents()` is idempotent and safe to call after `workflow_end` / `error` already auto-finished the bus. Workflow-driven contexts (`runtime.execute` / `runtime.stream`) terminate automatically and don't need this. Prefer `signal: AbortSignal.timeout(...)` over manual disposal — it composes with timeout/cancellation/budget without manual threading.
- **Cost rollup — pick one channel.** Don't `total += event.cost` from `ctx.events` AND `runtime.on('trace', …)` — same events fan out to both, you'll double-count. Use `eventCostContribution(event)` from `@axlsdk/axl` (skips per-ask `ask_end` rollups) or read `ctx.totalCost`. The four observation channels are alternatives, not additive.
- **`ctx.events` does not bridge across `awaitHuman` suspension.** When a workflow suspends and is later resumed via `runtime.resumeExecution()`, the resumed run gets a fresh `WorkflowContext` with its own bus. For cross-suspension observation, use `runtime.on('trace', …)` instead.

## See also

- [Observability paths](../observability.md#observation-paths) — full table comparing all four observation channels.
- [`ctx.events`](../api-reference.md#ctxevents) — type reference, lifecycle, and curated views.
- [`EventStreamOptions`](../api-reference.md#eventstreamoptions) — queue-cap and overflow-policy reference.
- [`AxlStream`](../api-reference.md#axlstream) — wire-side stream and curated views.
