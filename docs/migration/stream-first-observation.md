# Migration: Stream-First Observation

> **Versions:** 0.16.x → next
> **Scope:** Anyone iterating `AxlStream`, calling `runtime.execute()` / `runtime.stream()` / `runtime.createContext()`, using `Session.send` / `Session.stream`, or wanting to observe events from inside a workflow handler.

## What changed

Phase 1 of the Stream-First Observation API ships:

1. **`ctx.events`** — a lazy `AxlEventBus` accessible from every `WorkflowContext`. Iterate `AxlEvent` from inside a workflow handler — including between `ctx.ask()` calls — without standing up a `runtime.stream()` consumer outside.
2. **Coalescing `partialObjects` view** on both `AxlStream` and `ctx.events`. Yields the latest `partial_object` payload per `askId` with the 1-indexed `attempt`. Designed for streaming-structured-output UIs that render the current state, not every intermediate snapshot.
3. **Bounded queue + overflow policy** on every `AxlEventBus`. Default cap of `10_000` events, overflow drops the oldest non-terminal. Strict mode (`'throw'`) raises a typed `EventStreamOverflowError`.
4. **`events: EventStreamOptions`** plumbed through every entry point: `runtime.execute()`, `runtime.stream()`, `runtime.createContext()`, `Session.send`, `Session.stream`, `AxlTestRuntime.execute`.

## TL;DR

For most consumers there is **nothing to do** — defaults preserve existing behavior in all but two narrow cases (see "Behavior changes" below). If you want to use the new feature, subscribe to `ctx.events` at the top of your workflow handler.

## New API at a glance

```typescript
// Inside a workflow handler — observe between asks
const wf = workflow({
  name: 'two-step',
  input: z.object({ topic: z.string() }),
  handler: async (ctx) => {
    void (async () => {
      for await (const partial of ctx.events.partialObjects) {
        ws.send(JSON.stringify({ askId: partial.askId, attempt: partial.attempt, object: partial.object }));
      }
    })().catch((err) => ctx.log('observer.failed', { error: String(err) }));

    const outline = await ctx.ask(planner, ctx.input.topic, { schema: outlineSchema });
    return ctx.ask(writer, outline, { schema: draftSchema });
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

Before this release, `runtime.execute()` always took the non-streaming `provider.chat` code path. After this release, the streaming path activates whenever an observer is present at the time `ctx.ask()` starts — either the legacy `onToken` callback OR an allocated `ctx.events`. If your workflow handler does **not** access `ctx.events`, behavior is unchanged.

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

## Lifecycle gotchas

- **Subscribe early.** The `ctx.events` bus is allocated on first access. The streaming code path inside `ctx.ask()` activates only when an observer is present at the time the ask starts. If you allocate `ctx.events` AFTER a `ctx.ask()` has begun, that in-flight ask will not stream `token` / `partial_object` events. Subsequent asks (started after the bus exists) stream normally — the gate is re-checked per ask.
- **Auto-dispose on signal abort.** When `runtime.createContext({ signal })` is constructed with an `AbortSignal` and the signal fires, the bus is auto-disposed (iterators terminate with `done: true`). If `signal` is already aborted at the time `ctx.events` is first accessed, the bus terminates immediately on access. This protects long-lived ad-hoc context flows from leaking iterator consumers.
- **Manual disposal for ad-hoc contexts without a signal.** `ctx.disposeEvents()` is idempotent and safe to call after `workflow_end` / `error` already auto-finished the bus. Workflow-driven contexts (`runtime.execute` / `runtime.stream`) terminate automatically and don't need this.
- **`ctx.events` does not bridge across `awaitHuman` suspension.** When a workflow suspends and is later resumed via `runtime.resumeExecution()`, the resumed run gets a fresh `WorkflowContext` with its own bus. For cross-suspension observation, use `runtime.on('trace', …)` instead.

## See also

- [Observability paths](../observability.md#observation-paths) — full table comparing all four observation channels.
- [`ctx.events`](../api-reference.md#ctxevents) — type reference, lifecycle, and curated views.
- [`EventStreamOptions`](../api-reference.md#eventstreamoptions) — queue-cap and overflow-policy reference.
- [`AxlStream`](../api-reference.md#axlstream) — wire-side stream and curated views.
