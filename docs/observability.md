# Observability

> **Migrating from 0.15.x?** See the [unified event model migration guide](./migration/unified-event-model.md) for the full rename/move table (`TraceEvent`/`StreamEvent` → `AxlEvent`, `ExecutionInfo.steps` → `.events`, `AxlStream.steps` → `.lifecycle`, event tag renames, callback `meta` parameter, and the new ask-tree correlation model).

## Trace Mode

Every workflow execution produces a structured trace. In development, this is your primary debugging tool.

### Configuration

```typescript
// axl.config.mts
import { defineConfig } from '@axlsdk/axl';

export default defineConfig({
  trace: {
    enabled: true,
    level: 'steps',    // "off" | "steps" | "full"
    output: 'console', // "console" | "json" | "file"
  },
});
```

Or via environment variable:

```bash
AXL_TRACE_ENABLED=true AXL_TRACE_LEVEL=full node server.js
```

### Trace Levels

| Level | What's logged |
|-------|--------------|
| `off` | Nothing. |
| `steps` | One line per workflow step: agent calls, tool calls, verify results, budget usage. Includes cost and duration. **Default.** Request-side `agent_call_start` events already carry the resolved system prompt and model params; response-side `agent_call_end` events carry reasoning/thinking content. Both carry the turn counter and retry reason — none of those fields depend on `full` mode |
| `full` | Everything in `steps`, plus: a complete `ChatMessage[]` request snapshot on every `agent_call_start` event (under `data.messages`) so you can reconstruct exactly what the model was about to see on that turn, including tool results and retry feedback accumulated across loop iterations. This grows with conversation depth, so it's off by default — enable when debugging |

### Example Output (`steps` level)

```
[axl] execution:abc-123 | workflow:HandleSupport | started
[axl] execution:abc-123 | step:1 agent_call_end | agent:SupportBot | model:openai-responses:gpt-5.5 | 1.2s | $0.003
[axl] execution:abc-123 | step:2 tool_call_end  | tool:get_order | args:["ORD-456"] | 45ms
[axl] execution:abc-123 | step:3 agent_call_end | agent:SupportBot | model:openai-responses:gpt-5.5 | 0.8s | $0.002
[axl] execution:abc-123 | step:4 tool_call_end  | tool:refund_order | args:["ORD-456"] | 120ms
[axl] execution:abc-123 | workflow:HandleSupport | completed | 2.4s | $0.005
```

## Programmatic Trace Access

Subscribe to trace events for custom logging, dashboards, or forwarding to external systems:

```typescript
runtime.on('trace', (event) => {
  // event: AxlEvent — discriminated by `type`
  // Common fields: { executionId, step, type, agent?, tool?, promptVersion?, cost?, duration?, ... }
  myLogger.info(event);
  datadogClient.send(event);
});
```

### Event types

All live events share the v2 `AxlEventBase` shape, including required
`schemaVersion: 2`; `data` and other variant-specific fields are narrowed by
`type`. See [api-reference.md](./api-reference.md#axlevent) for the full per-type
schemas. The full set of types:

| Type | When emitted | Key `data` fields |
|------|-------------|-------------------|
| `workflow_start` / `workflow_end` | Workflow lifecycle | `input` / `status`, `duration`, `result?`, `error?`, `aborted?` |
| `ask_start` / `ask_end` | Bound every `ctx.ask()` call (one pair per invocation, including nested). | `prompt` on start; `outcome: { ok: true, result } \| { ok: false, error }`, `cost`, `duration`, and `unpriced?: boolean` on end |
| `agent_call_start` / `agent_call_end` | Per LLM call (every loop turn of `ctx.ask()`). `_start` fires before the request; `_end` after the response. | `_start` `data`: `prompt`, `system?`, `params`, `turn`, `retryReason?`, `toolNames?`, and `messages?` (full trace only). `_end` `data`: `response`, `thinking?`, `turn`, `retryReason?`. On the error path, `_end` also carries `error` (message), plus `status` + `retryable` when the thrown error was a `ProviderError` (the raw `ProviderError.body` is intentionally **not** emitted — see [security.md](./security.md)) |
| `token` | Streaming text chunk (stream-only, never persisted to `ExecutionInfo.events`) | `data: string` |
| `tool_call_rejected` | Unavailable tool, invalid JSON, or invalid local arguments before execution starts; no start/end pair | `reason`, `requestedTool`, plus `availableTools`, generic `message`, or structural `issues` by reason |
| `tool_call_start` / `tool_call_end` | Accepted tool invocation lifecycle | `_start` `data`: validated `args`, `requestedTool?`. `_end` `data`: same `args`, `requestedTool?`, and discriminated `outcome` (`succeeded`, `failed`, `denied`, `cancelled`) |
| `tool_approval` | `requireApproval` gate fires — **both** approve and deny | `approved`, `args`, `reason?` |
| `guardrail` | Input or output guardrail runs — pass or fail | `guardrailType`, `blocked`, `reason?`, `attempt?`, `maxAttempts?`, `feedbackMessage?` (output only, on retry) |
| `schema_check` | Every schema parse on a structured-output call — pass or fail | `valid`, `reason?`, `attempt`, `maxAttempts`, `feedbackMessage?` (on retry) |
| `validate` | Post-schema business rule validator runs — pass or fail | `valid`, `reason?`, `attempt`, `maxAttempts`, `feedbackMessage?` (on retry) |
| `delegate` | `ctx.delegate()` routes to a candidate (including the single-agent short-circuit) | `candidates`, `selected?`, `routerModel?`, `reason` (`'routed'` \| `'single_candidate'`) |
| `handoff_start` | Fires BEFORE the target ask begins, on every handoff. **Not** AskScoped — spans two asks via `fromAskId` / `toAskId`. | `source`, `target`, `mode`, `message?` (roundtrip only) |
| `handoff_return` | Fires AFTER control returns to source. **Roundtrip mode only** (oneway terminates at target). **Not** AskScoped. | `source`, `target`, `duration` |
| `verify` | `ctx.verify()` completes (pass or fail) | `attempts`, `passed`, `lastError?` |
| `pipeline` | Retry/validation lifecycle (multi-state via `status`: `start` / `committed` / `failed`). Emitted alongside the legacy `guardrail` / `schema_check` / `validate` gate events | `status`, `stage` (`'initial' \| 'schema' \| 'validate' \| 'guardrail'`), `attempt`, `maxAttempts`, `reason?` (only on `status: 'failed'`) |
| `partial_object` | Progressive structured output — emitted at string-safe boundaries when `ctx.ask()` has a `schema` and no tools. **Stream-only** — never persisted to `ExecutionInfo.events` | `attempt`, `data: { object: unknown }` (DeepPartial of the schema type) |
| `string_delta` | Per-chunk character-level deltas inside string VALUES of progressive structured output. Same gating as `partial_object` (schema set, no tools, root is `ZodObject`). **Stream-only** — never persisted. Designed for chat-style typewriter rendering of long string fields via the `stringStream` view helper | `attempt`, `data: { path, delta }` (`path` = RFC 6901 JSON Pointer; `delta` = unescaped chars added in this chunk) |
| `log` | `ctx.log()` user-emitted event | caller-provided |
| `memory_remember` / `memory_recall` / `memory_forget` | Memory ops audit | `{ key, scope, hit?, count?, embed?, usage? }` |
| `checkpoint_save` / `checkpoint_replay` | `ctx.checkpoint(name, fn)` — `save` on first execution, `replay` when a saved value short-circuits the function call | `name` (caller-supplied stable id, or `__auto/<primitive>/...` for runtime-internal auto-checkpoints) |
| `await_human` | `ctx.awaitHuman()` suspends execution waiting for a human decision. Paired with `await_human_resolved` when the decision arrives | `prompt?`, `channel?` |
| `await_human_resolved` | Paired terminal of an `await_human` request — carries the `HumanDecision` returned to the workflow | `channel?`, `decision` |
| `done` / `error` | Terminal workflow markers (wrap their payload under `data` — `done.data = { result }`, `error.data = { message, name?, code? }`) | see signatures |

`AxlStream.fullText` commits on `pipeline(committed)` and discards the in-progress buffer on `pipeline(failed)` or `ask_end({ok: false})`, so retried attempts' tokens never leak into the committed text.

### Tool lifecycle outcomes and trace completeness

Tool lifecycle status follows control flow, not user-owned result fields. A
normally returned `{ error: ... }` is `succeeded`; an explicit `ToolFailure` is
`failed` with `kind: 'tool_failure'` and `disposition: 'continue'`; an ordinary
throw is `failed` with `kind: 'unexpected'` and `disposition: 'abort'`. MCP
`isError` and approval denial also continue the agent loop, while cancellation
and approval/output infrastructure failures abort it.

`tool_call_end.data.outcome` is the authoritative terminal:

- `succeeded` carries the post-`after` complete host result;
- `failed.failure` identifies `phase`, `kind`, `disposition`, structured error,
  and result/attempt count only where one exists;
- `denied` carries an optional reason and means no hook or handler ran;
- `cancelled.cancellation` identifies the cancellation phase and retains a raw
  result only when execution had already produced one.

Failure event details are host observability data, never an implicit provider
message. Only `ToolFailure.modelMessage`, bounded MCP protocol error content,
and denial content cross the provider boundary. `trace.redact` scrubs host
arguments, results, reasons, error messages, and error causes.

For v2 events, pair an accepted call with
`(executionId, askId, callId)`. Every complete, untruncated trace has one end per
start with the same canonical tool name. This is not a transactional delivery
promise: queue overflow, persistence caps, disconnected clients, strict
listener failure, or process death may omit a terminal from one consumer view.
Treat an orphan start in such a view as an incomplete trace, not a synthesized
tool failure.

### Event schema versions and historical traces

All new live `AxlEvent`s have `schemaVersion: 2`, and all new live
`ExecutionInfo` records have `eventSchemaVersion: 2`. History APIs return
`HistoricalExecutionInfo`; absent execution/event version metadata is the v1
sentinel. New writers emit v2 only, while built-in stores and Studio retain a
dedicated v1 reader for legacy `tool_call_end.data.result`, `tool_denied`, and
orphan-start semantics. Consumers reading history must narrow the execution
version before applying a v2 reducer and must not infer v2 outcomes from v1
shapes.

**`workflow_start` / `workflow_end` are first-class event types as of 0.15.0** — previously emitted as `log` events with `data.event === 'workflow_start'` / `'workflow_end'`. Consumers filtering on the old log-form shape must switch to `event.type === 'workflow_start'` / `'workflow_end'`; `event.workflow` is now top-level, `data` carries `WorkflowStartData { input }` / `WorkflowEndData { status, duration, result?, error?, aborted? }`. `runtime.stream()` now also emits `workflow_start` (was silently omitted). Aborted workflows emit `workflow_end` with `data.aborted: true` so consumers can distinguish cancellation / budget hard-stop from genuine errors without a separate event subscription.

**Agent-as-tool correlation.** When an agent-as-tool handler spawns a child `WorkflowContext` (via `ctx.createChildContext()` inside a tool) and the child performs `ctx.ask()`, the nested ask's events all carry `parentAskId === outerAsk.askId` (on `AskScoped`, see below). Consumers reconstruct call graphs by parent-linking on `parentAskId`. The Trace Explorer visualizes nesting via `getDepth()`. The legacy `parentToolCallId` field was removed in 0.16.0 — `parentAskId` is the going-forward correlation primitive.

### Ask-graph correlation (`AskScoped`)

Every event originating within a `ctx.ask()` call carries an `AskScoped` mixin:

| Field | Type | Description |
|---|---|---|
| `askId` | `string` | The ask invocation. Stable for all events emitted within a single `ctx.ask()` (including its `agent_call_*` turns and tool calls) |
| `parentAskId` | `string?` | The enclosing ask (absent on the root). Set when one ask invokes another via the agent-as-tool pattern |
| `depth` | `number` | `0` for root; `+1` per nested `ctx.ask()` |
| `agent` | `string?` | Emitting agent's name |

Reconstruct the ask tree by grouping on `askId` and parent-linking on `parentAskId`. The `step` field is monotonic across the **whole execution tree** (shared via `AsyncLocalStorage`), so consumers ordering events for waterfall UIs no longer need to merge per-ask counters.

```typescript
// Build a per-ask cost rollup
const askCosts = new Map<string, number>();
for (const event of info.events) {
  if (event.type === 'ask_end') {
    askCosts.set(event.askId, event.cost); // authoritative per-ask cost
  }
}
```

`handoff_start` and `handoff_return` are the single exception — they span two asks atomically and carry `fromAskId` / `toAskId` / `sourceDepth` / `targetDepth` instead of the `AskScoped` shape. Treat each as an edge in your ask graph: `handoff_start` is the forward edge (always emitted, fires before the target ask begins so it orders correctly in step-sorted timelines), `handoff_return` is the back edge (roundtrip handoffs only — oneway handoffs are terminal at the target, so the target's `ask_end` IS the end of the chain).

### Cost: avoid double-counting in custom accumulators

`ask_end.cost` is the **per-ask rollup** of `agent_call_end.cost` + `tool_call_end.cost` emitted within that ask, **excluding nested asks** (nested asks contribute to their own `ask_end`). If you sum `event.cost` across every event you observe, you'll double-count.

**Unknown cost (`ask_end.unpriced`).** When an ask used a model with no usable per-call price (a pricing-table miss, or a provider that doesn't report cost), the unpriced call's `cost` is `undefined` — it contributes nothing to the rollup, so `ask_end.cost` becomes a **lower bound** and `ask_end.unpriced` is `true`. A *failed* call (which carries no usage) is NOT flagged. Treat `unpriced` asks as "at least `cost`", not exact (Studio renders them `≥ $X`). `agent_call_end.cost` is `number | undefined` for the same reason.

**Execution-level aggregate (`ExecutionInfo.unpriced`).** To answer "is this execution's `totalCost` exact?" without scanning the timeline, read `ExecutionInfo.unpriced` (from `runtime.execute()` / `getExecutions()` / recovered streams) — `true` when any cost-bearing call was unpriced. The same flag is on `runtime.trackExecution().unpriced` and `AxlTestRuntime.unpriced()`. All three derive from the exported `isUnpricedLeaf(event)` discriminator (the single source of truth shared with the per-ask rollup and Studio's `CostData.unpricedCalls`).

Use the exported helper `eventCostContribution(event)` — it returns `0` for `ask_end` rollups, for non-finite values, and for an undefined (unpriced) cost, and the event's cost otherwise. This is the single source of truth Axl's internals use; third-party accumulators should match:

```typescript
import { eventCostContribution } from '@axlsdk/axl';

let total = 0;
for (const event of info.events) {
  total += eventCostContribution(event);
}
```

The whole-execution total is `ExecutionInfo.totalCost`. Axl's built-in `runtime.trackExecution`, `ExecutionInfo.totalCost`, Studio's cost aggregator, and `AxlTestRuntime.totalCost()` all apply this guard via `eventCostContribution` internally.

### Budget honesty

The same unpriced condition is surfaced on the budget rail. A [`ctx.budget()`](api-reference.md#ctxbudgetoptions-fn) block whose calls ran an unpriced model returns `BudgetResult.unpriced === true` (and `ctx.getBudgetStatus().unpriced` is `true` mid-block); inner budgets propagate the flag to their parent. When this happens Axl logs a **one-time `console.warn` per budget block**.

⚠️ **Honesty, not enforcement.** `unpriced` reports that `totalCost` is a lower bound — it does **not** make the limit enforceable. The enforcement rail only ever sees *measured* cost, so a cost limit (including `hard_stop`) **cannot trip on unpriced spend** (e.g. unpriced/self-hosted/Bedrock models). A `hard_stop` budget pointed at an unpriced model will run unbounded by dollars. Token-denominated budgets are the planned mechanism for governing unpriced models; until then, treat `unpriced: true` as "the limit could not be enforced for part of this block." To restore enforceable cost limits, register pricing for the model so calls carry a usable cost.

### Failure surfacing — `ask_end` vs. `error`

Ask-internal failures (gate retries exhausted, `ctx.verify` failure, handler throw) surface via `ask_end({ outcome: { ok: false, error } })` only — **not** the workflow-level `error` event. The workflow-level `error` is reserved for failures with no `ask_end` available (top-level workflow throws before any ask runs, infrastructure / abort errors). Consumers narrow on `outcome.ok`:

```typescript
runtime.on('trace', (event) => {
  if (event.type === 'ask_end' && !event.outcome.ok) {
    console.error('ask failed:', event.outcome.error);
  } else if (event.type === 'error') {
    console.error('workflow error (not ask-internal):', event.data.message);
  }
});
```

**Semantic memory cost attribution.** `ctx.remember({embed: true})` and `ctx.recall({query})` call a paid embedding API. The operation emits a `memory_remember` / `memory_recall` event on BOTH success and failure paths (failure variant includes an `error` field), and when the embedder reported usage it sets:

- **Top-level `cost`** — USD amount, picked up automatically by `runtime.trackExecution()` and Studio's cost aggregator (flows into `totalCost` like any provider call).
- **Top-level `tokens.input`** — input tokens consumed by the embedder (kept separate from agent prompt tokens in the `totalTokens` summary).
- **`data.usage`** — full `{ tokens?, cost?, model? }` breakdown for trace inspection.

`ctx.remember` additionally recovers cost attribution on the partial-failure path: if the embedder succeeded but a downstream `vectorStore.upsert` threw, `MemoryManager.remember` attaches the usage to the error via a non-enumerable `axlEmbedUsage` property so the event still reports real spend and budget still sees the charge. (Plain key-value `remember` with `embed: false` never embeds, so there's no cost on the failure path.)

`OpenAIEmbedder` computes cost from a pricing table:

| Model | Cost |
|---|---|
| `text-embedding-3-small` | $0.02 / 1M tokens |
| `text-embedding-3-large` | $0.13 / 1M tokens |
| `text-embedding-ada-002` | $0.10 / 1M tokens |

Unknown models report `tokens` but no `cost`. The Studio Cost Dashboard renders a "Memory (Embedder)" section when there's at least one embedder call, bucketing cost by embedder model via `CostData.byEmbedder: Record<string, { cost, calls, tokens }>`.

**Memory cost + budget.** Embedder cost feeds the same `budgetContext` as agent calls via `_accumulateBudgetCost` — `ctx.budget({ cost, onExceed: 'hard_stop' })` enforces across both. `ctx.remember` / `ctx.recall` also check `budgetContext.exceeded` at call top and throw `BudgetExceededError` before hitting the embedder if a prior call already breached the limit. The composed `AbortSignal` (user-abort + budget hard-stop) is forwarded to the embedder fetch so in-flight calls cancel.

### Observation paths

Four ways to observe what happens during a workflow run. Pick by scope:

| Path | Scope | When to use |
|------|-------|-------------|
| `runtime.stream(name, input)` → `AxlStream` | One specific execution (wire) | Per-run UIs (chat streaming, progress bars, waterfalls). Returns an `AsyncIterable<AxlEvent>` plus curated views (`.text`, `.lifecycle`, `.textByAsk`, `.partialObjects`, `.fullText`) and a `.promise` for the final result |
| `ctx.events` (`AxlEventBus`) | One specific context (inside the workflow handler) | Observe events **between `ctx.ask()` calls** in a workflow handler, or on ad-hoc contexts from `runtime.createContext()`. Same `AxlEvent` union as `AxlStream`; same curated views (`.text`, `.lifecycle`, `.textByAsk`, `.partialObjects`). Lazy — zero overhead if no consumer subscribes |
| `runtime.on('trace', event => …)` | Every execution | Cross-execution observability (background telemetry, cost dashboards, audit logs). Receives every `AxlEvent` from every `execute()` / `stream()` / `createContext()` call |
| `runtime.recoverIncompleteStreams()` | Post-crash recovery | Reconstructs partial `ExecutionInfo`s for runs whose process died mid-flight, IF `state.persist: 'streaming'` was configured. Wire into process startup AFTER lazy-loading historical state and BEFORE accepting new work. See ["Crash recovery"](#crash-recovery-statepersist-streaming) below |

`runtime.execute()` itself is final-result-only by design — it does **not** accept `onToken` or any other event callback. To observe a workflow run from inside the handler, read `ctx.events`; from outside, use `runtime.stream()` (per-execution) or `runtime.on('trace', …)` (cross-execution).

The legacy `onToken` / `onToolCall` / `onAgentStart` options have been removed
from `runtime.createContext()`. Untyped callers receive a targeted migration
error and the values are never invoked. See the
[stream-first migration guide](migration/stream-first-observation.md).

#### `ctx.events` — observing between `ctx.ask()` calls

The customer use case: a workflow handler that runs several `ctx.ask()` calls and wants to stream `partial_object` events to a UI as they happen.

```typescript
// Schemas + agents the example uses — declared so the snippet is
// self-contained.
const outlineSchema = z.object({ outline: z.array(z.string()) });
const draftSchema = z.object({ draft: z.string() });
const planner = agent({ model: 'openai:gpt-4o', system: 'Plan an outline.' });
const writer = agent({ model: 'openai:gpt-4o', system: 'Write the draft.' });

const wf = workflow({
  name: 'multi-step',
  input: z.object({ topic: z.string() }),
  handler: async (ctx) => {
    // Allocate the bus first — `ctx.events` is a lazy getter; the
    // streaming code path inside ctx.ask() only activates when an
    // observer was present at the time the ask started. Touching the
    // getter synchronously here wires every ask in this handler. See
    // "Subscribe early" below.
    const events = ctx.events;
    // Background observer. `.catch` keeps consumer errors visible —
    // without it, a throw inside the body would surface as an
    // unhandled rejection at the process level.
    void (async () => {
      for await (const partial of events.partialObjects) {
        console.log(
          `[ask ${partial.askId} attempt ${partial.attempt}]`,
          partial.object,
        );
      }
    })().catch((err) => ctx.log('observer.failed', { error: String(err) }));

    const outline = await ctx.ask(planner, ctx.input.topic, { schema: outlineSchema });
    // ctx.ask's second arg is a string prompt — serialize the
    // structured outline for the next agent.
    const draft = await ctx.ask(writer, JSON.stringify(outline), { schema: draftSchema });
    return draft;
  },
});
```

##### Recipe: chat-style typewriter rendering of a long string field

For a schema with a long `summary` string, `partial_object` doesn't fire mid-string — it waits for the closing `"`. To render the field char-by-char as it arrives, subscribe to `stringStream`:

```typescript
import { agent, workflow } from '@axlsdk/axl';
import { z } from 'zod';

const summarizer = agent({
  name: 'summarizer',
  model: 'openai:gpt-4o',
  system: 'Summarize the input thoroughly.',
});

const wf = workflow({
  name: 'streaming-summary',
  input: z.object({ text: z.string() }),
  handler: async (ctx) => {
    const events = ctx.events;
    void (async () => {
      // Renders one (or many) ask's `/summary` field char-by-char.
      // Bind your UI component to `event.accumulated` for the running
      // text, or `event.delta` for incremental append.
      for await (const e of events.stringStream({ path: '/summary' })) {
        process.stdout.write(e.delta); // typewriter effect
      }
    })().catch(() => {});

    return await ctx.ask(summarizer, ctx.input.text, {
      schema: z.object({ summary: z.string(), keywords: z.array(z.string()) }),
    });
  },
});
```

In a React UI consuming `runtime.stream(...)`:

```tsx
import { useState, useEffect } from 'react';
import type { AxlStream } from '@axlsdk/axl';

function StreamingField({ stream, path }: { stream: AxlStream; path: string }) {
  const [text, setText] = useState('');
  useEffect(() => {
    const iter = stream.stringStream({ path });
    let cancelled = false;
    (async () => {
      for await (const e of iter) {
        if (cancelled) break;
        setText(e.accumulated); // re-render with running text
      }
    })();
    return () => {
      cancelled = true;
      void (iter[Symbol.asyncIterator]() as { return?: () => Promise<unknown> }).return?.();
    };
  }, [stream, path]);
  return <span>{text}</span>;
}
```

Notes:

- **Late mount renders current state immediately.** The view seeds late subscribers with a synthetic event carrying `delta === accumulated === <full text-so-far>`, so a component mounting mid-ask doesn't render empty.
- **Filter by path or askId.** Both are optional; `stringStream({ path: '/summary' })` matches across all asks; `stringStream({ askId })` matches all paths within one ask; passing both narrows.
- **Concatenate per (askId, path).** If you don't filter and want to reconstruct each field separately, key your UI state on `${event.askId}|${event.path}`.
- **Schema retries reset the stream.** On `pipeline(failed)`, the per-ask accumulator is cleared and pending events are dropped, so attempt-N text never leaks into attempt-N+1's render. Watch `event.attempt` to render a "regenerating" indicator.
- **Same gating as `partial_object`.** Schema must be set, no tools registered, schema root must be a `z.object(...)`.

##### Recipe: typewriter rendering on the wire (browser SPA)

The pattern above assumes the consumer holds a live `AxlStream` instance — true for Node-side servers, but not for a browser SPA receiving events over WebSocket / SSE. There the events arrive as raw JSON and there's no bus accumulator on the client.

`stringStreamFromEvents(source, opts?)` is a browser-safe reconstructor: same shape and filter API as `bus.stringStream(...)`, but takes any `AsyncIterable<AxlEvent>` as input. Pure ECMAScript, no Node deps.

```typescript
import { stringStreamFromEvents } from '@axlsdk/axl';

// Adapt your transport (here: a WebSocket emitting JSON-encoded AxlEvents)
async function* readWs(ws: WebSocket): AsyncIterable<AxlEvent> {
  const queue: AxlEvent[] = [];
  let resolver: (() => void) | null = null;
  ws.addEventListener('message', (m) => {
    queue.push(JSON.parse(m.data).data); // adjust to your wire envelope
    resolver?.();
  });
  while (true) {
    while (queue.length) yield queue.shift()!;
    await new Promise<void>((r) => (resolver = r));
  }
}

for await (const e of stringStreamFromEvents(readWs(ws), { path: '/summary' })) {
  setText(e.accumulated);
}
```

Differences from the live-bus view:

- **No late-subscriber seeding.** The helper accumulates only events handed to its iterator. If the source has already produced `string_delta` events before iteration begins, those are missed. For cross-reconnect recovery, the server has to surface the current accumulator state on resubscribe (out of scope — the wire transport is the caller's responsibility).
- **No race-with-bus-iterator concern.** This is a stateless consumer of an iterable; iterating it twice on the same source consumes events twice (fork the source first if you need that).
- **Identical retry behaviour for re-rendered fields.** `pipeline(failed)` clears the helper's per-ask accumulator just like the bus view does, so the next yielded event starts with `accumulated === delta`. A UI re-rendering `event.accumulated` per yield naturally overwrites stale attempt-N text in place when attempt-N+1 begins — no explicit retry handling needed.

##### Picking the right view: `token` vs. `partial_object` vs. `string_delta`

| Use case | Right view | Why |
|---|---|---|
| Free-text chat response (no schema) | `.text` / `.textByAsk` (token) | Tokens are the raw response stream; no schema means no structure to render. |
| Structured response, render whole object as it builds (form, card, validation UI) | `.partialObjects` | Each event has the complete current state of the object. Throttled to structural JSON seams so consumers don't re-render mid-key. |
| Structured response with one (or more) long string fields you want to typewrite | `.stringStream({ path: '/summary' })` | `partial_object` doesn't emit while the string is mid-flight. `stringStream` emits per chunk with running `accumulated`. |
| Both — render the structure AND typewrite long fields inside it | Subscribe to BOTH on the same bus | Listener-based views don't race; one consumer of each is fine. |
| Wire/SSE/WebSocket from browser, no `AxlStream` access | `stringStreamFromEvents(source, opts)` | Browser-safe reconstructor with the same shape as `.stringStream`. |
| Audit log / debugging — every event in order | `for await (const e of ctx.events)` | Raw firehose. Use the curated views to filter. |

##### Common pitfalls (when things look broken)

- **No `string_delta` events at all.** The gate is `schema set` AND `no tools` AND `schema root is z.object(...)`. Common misses:
  - You set `schema: z.array(...)` — non-object roots are gated off. Wrap in `z.object({ items: z.array(...) })`.
  - Your agent has `handoffs: [...]` configured — handoffs are tools internally, so the agent runs in tool-calling mode and `string_delta` is suppressed. The handoff target's own `ctx.ask` (with no further handoffs and a schema) DOES emit. If you want typewriter on the source, restructure so the schema'd response comes from a leaf agent.
  - Your agent has `tools: [...]` — same reason. Tool-calling mode produces JSON that goes to the tool, not to a UI.
- **Subscriber sees nothing despite events firing.** You allocated `ctx.events` AFTER the first `ctx.ask()` started. The streaming code path is gated per ask on whether an observer is present. The fix: `const events = ctx.events;` on the first line of the workflow handler, before any `ctx.ask()`.
- **`stringStream({ path: 'summary' })` returns nothing.** The walker emits RFC 6901 paths — leading `/`. Use `'/summary'`, not `'summary'`. Since 0.17.7 this throws a clear error instead of silently never matching.
- **Path with `/` or `~` in the schema key.** The walker percent-encodes these per RFC 6901: `~` → `~0`, `/` → `~1`. So a schema key `"a/b"` produces path `/a~1b`. The encoding is automatic but the consumer-side filter must use the encoded form.
- **Attempt-N text leaks into the UI.** You're appending `event.delta` to your own buffer rather than re-rendering `event.accumulated`. The accumulator clear on `pipeline(failed)` only affects what the runtime tracks; if you maintain your own buffer, you must reset on `event.attempt` change. Re-rendering `event.accumulated` per yield avoids this entirely.
- **Studio's Trace Explorer shows no `string_delta` rows.** They're not persisted to `ExecutionInfo.events` (stream-only). Studio's Playground filters them from the activity feed (alongside `token` and `partial_object`) since they'd produce hundreds of rows; the chat bubble itself renders schema responses as a live JSON tree + a typewriter line for the actively-writing string field, so you don't lose visibility — you just don't see hundreds of raw delta rows in the activity timeline.
- **`MockProvider` test driving the wrong chunks.** The walker is per-chunk batching. If you pass `chunks: ['{"x":"foo"}']` (one big chunk), you get ONE `string_delta` with `delta: 'foo'` — not three single-char events. Use `MockProvider.chunked(content, 1)` for per-char tests.

- **`ctx.events.partialObjects`** is the coalescing view — yields the latest `partial_object` payload per `askId`. When the LLM streams faster than your UI renders, intermediate snapshots are silently superseded; the consumer sees only the most recent state per ask. Memory-bounded by `O(active asks)`, not `O(events emitted)`. Listener-based, so it does NOT race with the main `for await (const e of ctx.events)` iterator.
- **`ctx.events.stringStream({ path?, askId? })`** is the per-field streaming view for **chat-style typewriter rendering of long string fields**. `partial_object` snapshots are throttled to structural JSON boundaries — they don't fire while a long string is being written, so a 4 KB `summary` field appears all at once when the closing quote lands. `string_delta` events fill that gap with unescaped chars keyed by RFC 6901 JSON Pointer (`/summary`, `/sources/0/title`). The view yields `{ askId, agent?, path, delta, accumulated, attempt }` — bind a UI component to one `path` and set its text to `event.accumulated` per yield. A slow subscriber coalesces undrained chunks for the same ask/path, so `delta` means all chars since that subscriber's previous yield, not necessarily one provider chunk. Distinct pending fields obey `maxQueued`/`onOverflow`; late subscribers seed through the same bounded queue. Listener-based: does NOT race with the main iterator.
- **`ctx.events.lifecycle`** filters to structural events (`ask_start`, `ask_end`, `agent_call_*`, `tool_call_*`, `handoff_*`, etc.) — useful for waterfall UIs.
- **`ctx.events.text`** yields root-only token chunks (chat-bubble view).
- **`ctx.events.textByAsk`** yields `{ askId, agent?, text }` for split-pane UIs that render each sub-agent in its own lane.
- **Subscribe early.** The bus is allocated lazily on first `ctx.events` access, AND the streaming code path inside `ctx.ask()` activates only when an observer is present at the time the ask starts. If you allocate `ctx.events` AFTER a `ctx.ask()` has begun, that in-flight ask will not stream `token` / `partial_object` events at all. Subsequent asks (started after the bus exists) stream normally — the gate is re-checked per ask. The unambiguous pattern: `const events = ctx.events;` on the first line of the handler.
- **Late subscribers partly recover.** The bus's iterator queue retains events emitted before any consumer iterates, so a late `for await (const e of ctx.events)` will still drain whatever is queued. The `partialObjects` view additionally seeds from a per-bus `latestPartialByAsk` map at subscription time, so a Studio-style late subscriber sees the latest coalesced state per ask even when earlier events were drained by another iterator. Neither rescues the streaming-gate behavior — for full token/partial fidelity, allocate the bus before the first ask.
- **`ctx.events` does not bridge process loss at `ctx.awaitHuman()`.** The continuation and bus belong to the current runtime. A persisted orphan request remains visible but Axl does not replay it; use an application-owned durable approval protocol (see Security > Approval Gates).
- **`ctx.race()` losers drain only to a bounded terminal barrier.** The primitive returns its winner immediately and aborts losers. The runtime waits up to `branchDrainTimeoutMs` (default 5 seconds) so cancellation terminals and late measurable provider cost remain canonical. If continuations ignore abort past the bound, finalization proceeds with `workflow_end.data.observation` and `ExecutionInfo.observation` set to `{ complete: false, reason: 'branch_drain_timeout', ... }`; later branch events are ignored. Consumers reconstructing "what won" must filter on the resolved value/winner, not event presence.
- **Pick one cost-accumulation channel.** Subscribing to `ctx.events` AND `runtime.on('trace', ...)` simultaneously and summing `event.cost` in both would double-count — the same event flows to both surfaces. The channels are alternatives: `ctx.events` for in-handler observation; `runtime.on('trace', ...)` for cross-execution telemetry. Use one for cost rollup at any given layer, or use the runtime's pre-aggregated `ExecutionInfo.totalCost` instead.
- **Auto-dispose on signal abort.** When `runtime.createContext({ signal })` is constructed with an `AbortSignal` and the signal fires, the bus is auto-disposed (iterators terminate with `done: true`). This protects the long-lived ad-hoc context case — a consumer that iterates `ctx.events` and never sees a workflow terminal would otherwise leak the iterator. If `signal` is already aborted at the time `ctx.events` is first accessed, the bus terminates immediately on access. (Implementation detail: only the root context registers the abort listener; child contexts inherit the parent's bus slot and would otherwise double-fire `_finish`.)
- **Auto-termination.** The bus is finished automatically when the runtime emits `workflow_end` or `error`, so iterators resolve with `done: true` cleanly. For ad-hoc `runtime.createContext()` flows that never run a workflow, call `ctx.disposeEvents()` when done observing.
- **Child contexts** (the agent-as-tool pattern) share the parent's bus via a mutable slot, so nested-ask events bubble up to the parent's `ctx.events` iterator with full `askId` / `parentAskId` / `depth` correlation.

#### Bounded queue and overflow policy

Both `AxlStream` and `ctx.events` apply a default-on safety cap on their iterator queue. Configure via the `events` option on `runtime.execute()` / `runtime.stream()` / `runtime.createContext()`:

```typescript
runtime.execute('my-workflow', input, {
  events: {
    maxQueued: 5_000,                          // default 10_000
    onOverflow: 'drop-oldest-non-terminal',    // default; or 'throw'
  },
});
```

- **`maxQueued`** (default `10_000`): soft cap on events buffered while waiting for a consumer, including distinct pending fields for each `stringStream()` subscriber. Same-field string updates coalesce without character loss. Set to `Infinity` to disable.
- **`onOverflow: 'drop-oldest-non-terminal'`** (default): when the cap is hit, the oldest non-terminal event is dropped to make room. Terminal events (`done`, `error`, `workflow_end`) always pass through. The first drop per bus emits a one-shot `console.warn` so saturating consumers see the signal without log spam.
- **Check `.observationStatus`.** After consuming an `AxlEventBus` or `AxlStream`, inspect this property before asserting complete start/end pairing. Default-policy drops produce `{ complete: false, reason: 'queue_overflow', droppedEvents }`.
- **`onOverflow: 'throw'`**: throw an `EventStreamOverflowError` at the producer call site. **This will fail the active workflow** — the throw unwinds the agent loop and the runtime promise rejects with the typed error. Catch with `instanceof EventStreamOverflowError` (exported from `@axlsdk/axl`) to distinguish overflow from other workflow errors. **Where the throw fires depends on which bus saturates:** on `runtime.stream()`, the wire-side `AxlStream` bus is always active, so any saturation throws. On `runtime.execute()`, the workflow has no `AxlStream` — the throw fires only when the workflow handler allocated `ctx.events` and that bus saturates. If you want strict overflow detection on `runtime.execute()`, allocate `ctx.events` at the top of the handler. Use only in tests or strict environments where silent drop would mask a problem.

Existing 0.x consumers gain the cap automatically with this release. If your workflow somehow relied on unbounded queueing, opt out with `events: { maxQueued: Infinity }`. See the full upgrade notes in [docs/migration/stream-first-observation.md](migration/stream-first-observation.md).

### Migrating removed streaming callbacks

The `onToken` / `onToolCall` / `onAgentStart` options on
`runtime.createContext()` no longer exist. Use `ctx.events` for an ad-hoc
context, `AxlStream` for a wire consumer, or the runtime trace emitter for
cross-execution observation. Filter events with `event.depth === 0` to preserve
root-only behavior, or route nested output by `askId` with `.textByAsk`.

The [stream-first migration guide](migration/stream-first-observation.md)
contains equivalent recipes and the callback-throw behavior change. The
[unified event-model guide](migration/unified-event-model.md) preserves the
historical callback contract for consumers migrating through older 0.x
releases.

### Debugging retries

Three common symptoms and what to look for in traces:

**"My agent cost 3× what I expected."** Filter for `agent_call_end` events and check the `data.turn` field — if you see `turn: 2`, `turn: 3`, etc., the tool-calling loop ran multiple iterations. Check `data.retryReason` on those calls to see whether it was a schema, validate, or guardrail retry. Check the preceding `schema_check` / `validate` / `guardrail` event for the exact failure reason and `feedbackMessage` that was sent back to the LLM.

**"My structured output keeps failing."** Filter for `schema_check` events with `valid: false`. The `reason` field has the Zod parse error; the `feedbackMessage` is the exact message the model saw on its next attempt. If the feedback isn't clear enough to help the model correct itself, that's a prompt/schema design problem, not a retry-count problem.

**"Why did my agent respond that way?"** Enable `trace.level: 'full'` and check the `data.messages` array on the relevant `agent_call_start` — it has the exact request conversation (system prompt, history, tool results, retry feedback) immediately before the provider call. Request-side `system` and `params`, plus response-side `thinking`, are visible in default mode without needing verbose; `retryReason` is mirrored on both start and end.

### Structured-output prompt cost

When you call `ctx.ask(prompt, { schema })`, Axl appends a JSON-Schema rendering
of the schema to the user prompt (`Respond with valid JSON matching this
schema: …`). This text is part of the input tokens on every attempt, so a large
schema is a recurring cost.

Two things keep that text small automatically, with no code change:

- **Shared subschemas are hoisted.** Subschemas reused across the schema — the
  classic case is a `z.discriminatedUnion` whose arms share the same sub-objects —
  are emitted once under `$defs` and referenced via `$ref`, rather than duplicated
  inline at every occurrence. For large unions this is an order-of-magnitude
  reduction in the appended tokens.
- **The JSON is compact.** No pretty-print indentation is added to the prompt
  rendering.

This applies only to the **prompt** rendering. Provider **tool definitions** still
use the inline (`$ref`-free) rendering, which is required for Gemini (its schema
sanitizer strips `$ref`/`$defs`). To read the exact appended text, enable
`trace.level: 'full'` and inspect the last user message in `agent_call_start`'s
`data.messages`.

If a schema's appended text is still large, that's usually inherent schema size
(many fields, deep nesting, per-field `.describe()` text) rather than rendering
overhead — measure with `data.prompt` before adding hand-tuned guidance.

### Schema diagnostics

Some structured-output problems fail *silently* — the model is never told about
a rule, or streaming quietly turns off — so you only notice via wasted retries
or a missing progressive UI. Axl surfaces these as `schema_diagnostic` events
(one per ask, per cliff) and, for the genuinely surprising ones, a one-time
`console.warn`. The event is `AskScoped` and carries a `kind`-discriminated
`data`:

| `data.kind` | Fires when | `console.warn`? |
|---|---|---|
| `prompt_schema_oversized` | The appended prompt schema — or a tool-def schema — exceeds the token threshold (`data.site: 'prompt' \| 'tool'`, `data.tool?`) | No (event-only) |
| `dropped_refinements` | The schema carries `.refine()`/`.superRefine()` rules that `z.toJSONSchema` drops, so the model never sees them and `.parse` may reject (`data.count`, `data.paths`, `data.site`, `data.tool?`) | Yes |
| `streaming_disabled` | Progressive `partial_object` streaming is off because the schema root isn't a `ZodObject` (`cause: 'non-object'`) or tools are present (`cause: 'tools'`). Only fires when streaming is actually active (an observer is present) — a plain non-streaming `execute()` never emits it | Only for `non-object` (the `tools` cause is expected) |
| `schema_prompt_none_no_guidance` | `schemaPrompt: 'none'` was set with a schema and no override, so the model gets zero shape guidance | Yes |
| `native_output_unsupported` | `nativeStructuredOutput` was requested but the resolved provider can't honor the derived schema — it `downgraded` it to plain JSON mode, sanitized it `lossy`, or left it `unsupported` (prompt-only). The call proceeds regardless | Yes |

**Why the `console.warn`.** The trace console is off by default and the median
consumer never wires up `ctx.events`, so an event alone would re-bury the pain.
The warn mirrors the budget-honesty precedent: **process-level, deduped once per
`agent + kind + schema`**, pointing here. `prompt_schema_oversized` and the
`tools` streaming cause are event-only because they're tunable/expected, not
surprising.

**Acting on each:**
- `dropped_refinements` → surface the rule into the prompt (`schemaPrompt`) or
  enforce it after parsing with `ctx.verify` / a Zod `.transform()`. Plain
  constraints (`.min()`, `.email()`, `.regex()`) are *not* reported — they
  render into JSON Schema fine.
- `streaming_disabled` (`non-object`) → wrap the schema:
  `z.object({ result: <yourSchema> })` re-enables `partial_object` streaming.
- `prompt_schema_oversized` → see [Structured-output prompt cost](#structured-output-prompt-cost);
  Phase-1 compaction already removes most bloat, so a remaining oversized signal
  usually means genuinely large schema content.

**Configuration** (`AxlConfig.diagnostics`):

```ts
defineConfig({
  diagnostics: {
    schemaOversizedTokens: 4000, // token threshold for `prompt_schema_oversized` (default 4000)
    silent: true,                // suppress the console.warn (events still fire)
  },
});
```

Set `AXL_DIAGNOSTICS_SILENT=true` to silence the warns process-wide without a
config change. The structured events always fire regardless.

### PII and redaction

`config.trace.redact` is an **observability-boundary filter** that scrubs user/LLM content everywhere it would otherwise flow to observability consumers. The mental model: "what can the observability layer see?". Under `redact: true`, structural metadata (workflow names, agent names, tool names, cost/token metrics, durations, status, roles, keys, IDs, `askId`/`parentAskId`/`depth`) stays visible — but any field that carries prompt/response/user/LLM content is replaced with `'[redacted]'`.

The filter applies at three layers:

**1. AxlEvents** — at `emitEvent()` emission time. Scrubs:

- `agent_call_start.data`: `prompt`, `system`, `messages` (replaced with a single placeholder message preserving the count)
- `agent_call_end.data`: `response`, `thinking`, `error`
- `ask_start.prompt` and `ask_end.outcome` (`outcome.result` on success, `outcome.error` on failure)
- `guardrail` / `schema_check` / `validate`: `reason`, `feedbackMessage`
- `tool_call_rejected.data`: rejected `args`, issue `message`, and invalid-JSON `message`
- `tool_call_start.data.args`; `tool_call_end.data`: `args`, every outcome `result`, denial/cancellation `reason`, and failure `error.message`/`error.cause`
- `tool_approval.data`: `args`, `reason`
- `handoff_start.data.message` (roundtrip handoffs only — `handoff_return` carries no user/LLM content)
- `workflow_start.data.input`, `workflow_end.data.result`/`error`
- `done.data.result`, `error.data.message`
- `log` events: string fields, with a one-level walk so nested numeric fields like `memory_remember.data.usage.tokens` / `.cost` survive while string fields like `.usage.model` are scrubbed. Arrays and deeper nesting collapse to the `'[redacted]'` sentinel

**2. Studio REST routes** — at response serialization time, via `runtime.isRedactEnabled()`. Scrubs:

| Route | Scrubbed fields | Preserved |
|---|---|---|
| `GET /api/executions` / `:id` | `result`, `error`, `metadata` (replaced with `{ redacted: true }` — caller-supplied `userId`/`tenantId`/correlation ids are PII surfaces) | `executionId`, `workflow`, `status`, `duration`, `totalCost`, `startedAt`, `completedAt`, `events` (already scrubbed at emit time) |
| `DELETE /api/executions/:id` | (no content) | (blocked in `readOnly`; also scrubs the WS replay buffer for `execution:{id}` via `ConnectionManager.clearChannelBuffer`) |
| `GET /api/memory/:scope` / `:key` | `value` | `key` (programmer-chosen identifier, needed for navigation) |
| `GET /api/sessions/:id` | `message.content`, `message.tool_calls[*].function.arguments`; `message.providerMetadata` is dropped entirely (opaque bag that may carry encoded reasoning / cache keys) | `role`, `name`, `tool_call_id`, `tool_calls[*].id`, `tool_calls[*].type`, `tool_calls[*].function.name`, `handoffHistory` (no content fields to scrub) |
| `GET /api/evals/history`, `POST /api/evals/:name/run` (sync), `POST /api/evals/:name/rescore` | per-item `input`, `output`, `error`, `annotations`, `scorerErrors`, `scoreDetails[*].metadata` | per-item `scores`, `duration`, `cost`, `scorerCost`, `metadata` (models / tokens / workflows), `traces` (already scrubbed at emit time); result-level `summary`, `metadata`, `totalCost`, `duration`, `timestamp` |
| `GET /api/decisions` | `prompt`, `metadata` (replaced with `{ redacted: true }`) | `executionId`, `channel`, `createdAt` |
| `POST /api/tools/:name/test` | `result` | tool name, input schema |
| `POST /api/workflows/:name/execute` (sync) | `result` | — |

**3. Studio WebSocket broadcasts** — for streaming endpoints (playground, workflow execute with `stream: true`) **and** the trace firehose (`trace:*` channels). Scrubs the new `AxlEvent` variants directly via `redactStreamEvent`:

- `token.data` — streaming LLM output
- `tool_call_rejected.data.args`/diagnostic messages
- `tool_call_start.data.args`; `tool_call_end.data.args`, outcome results/reasons, and failure error details
- `tool_approval.data.args`/`.reason`
- `ask_start.prompt`, `ask_end.outcome`
- `done.data.result`, `error.data.message`
- `handoff_start.data.message` (roundtrip only)
- structural fields (`type`, `step`, `agent`, `tool`, `askId`, `parentAskId`, `depth`, cost/duration/token totals) pass through

In 0.16.0 the trace WS channel applies `redactStreamEvent` directly so the firehose can no longer bypass the per-route scrub (closing a previous PII leak).

**Top-level numeric fields (`cost`, `tokens`, `duration`) are never scrubbed**, even under `redact: true`. They're load-bearing — `trackExecution`'s cost-aggregation listener and Studio's `TraceAggregator<CostData>` both read `event.cost` directly, so zeroing them would silently break total cost tracking when redaction is enabled. If your compliance environment treats aggregate spend as sensitive, filter events out entirely in your `onTrace` / `filterTraceEvent` handler rather than relying on redaction to scrub them.

**Redaction is an observability-boundary filter, not a data-at-rest transform.** Programmatic callers of `runtime.execute()`, `runtime.getExecution()`, and direct `StateStore` access still receive raw values. Write endpoints (`PUT /api/memory`, `POST /api/sessions/:id/send`) still accept raw data. If you need scrubbed state-at-rest, configure your own `StateStore` wrapper that stores scrubbed values.

```typescript
const runtime = new AxlRuntime({
  trace: { enabled: true, level: 'full', redact: true },
});
```

## Execution Inspector

Each execution is identified by a unique `execution_id`. The runtime provides an inspection API:

```typescript
const exec = await runtime.getExecution('abc-123');
exec.events;      // All AxlEvents with inputs, outputs, cost, duration
exec.totalCost;   // Total LLM cost
exec.duration;    // Wall-clock time
exec.status;      // "running" | "completed" | "failed" | "waiting" (awaitHuman)
exec.result;      // Workflow return value (when completed)
exec.error;       // Error details if failed
```

## OpenTelemetry Integration

Axl emits OpenTelemetry spans for every `ctx.*` primitive, enabling integration with any OTel-compatible backend (Jaeger, Honeycomb, Datadog, Grafana Tempo, etc.).

### Setup

```typescript
import { defineConfig, AxlRuntime } from '@axlsdk/axl';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const exporter = new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' });
const provider = new BasicTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

const config = defineConfig({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY },
  },
  telemetry: {
    enabled: true,
    serviceName: 'support-bot',
    tracerProvider: provider,
  },
});

const runtime = new AxlRuntime(config);
await runtime.initializeTelemetry();

// All workflow executions now emit OTel spans automatically
```

**Peer dependency:** `@opentelemetry/api` is an optional peer dependency. Install it alongside your preferred SDK packages:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-trace-base
```

### Span Model

Every `ctx.*` primitive emits a span. Spans nest naturally: a workflow span contains agent spans, which contain tool call spans.

| Span Name | Key Attributes |
|-----------|------------|
| `axl.workflow.execute` | `axl.workflow.name`, `axl.workflow.duration`, `axl.workflow.cost` |
| `axl.agent.ask` | `axl.agent.name`, `axl.agent.model`, `axl.agent.prompt_tokens`, `axl.agent.completion_tokens`, `axl.agent.cost` |
| `axl.tool.call` | `axl.tool.name`, `axl.tool.duration`, `axl.tool.outcome`, `axl.tool.success`, `axl.tool.phase` (failed/cancelled) |
| `axl.ctx.spawn` | `axl.spawn.count`, `axl.spawn.quorum`, `axl.spawn.completed` |
| `axl.ctx.race` | `axl.race.participants`, `axl.race.winner` |
| `axl.ctx.vote` | `axl.vote.strategy`, `axl.vote.result` |
| `axl.ctx.budget` | `axl.budget.limit`, `axl.budget.totalCost`, `axl.budget.exceeded` |
| `axl.ctx.awaitHuman` | `axl.awaitHuman.channel`, `axl.awaitHuman.wait_duration` |
| `axl.tool.approval` | `axl.tool.name`, `axl.tool.approval.approved` |
| `axl.agent.handoff` | `axl.handoff.source`, `axl.handoff.target`, `axl.handoff.mode` |

Tool span status derives from the terminal control-flow outcome: `succeeded` is
OTel `OK`; `failed` and `cancelled` are `ERROR`; `denied` is `UNSET` with
`axl.tool.outcome = 'denied'`. Pre-start rejections do not create a dedicated
tool span. Raw arguments, results, denial reasons, and error messages are never
span attributes. Axl-generated span status descriptions are also intentionally
empty on errors; use the host error channel or redacted lifecycle event for
diagnostics rather than exporting exception text through OTel.

### Cost-Per-Span

Axl emits **cost-per-span** as an OTel attribute. Because Axl already tracks LLM costs at every level (including cached token discounts), cost attribution across agents, workflows, and individual calls is available out of the box. This enables cost dashboards, per-customer cost attribution, and budget alerting via standard OTel tooling.

### Token Usage

Provider responses include detailed token usage. For reasoning models (o1, o3, o4-mini), the usage object also reports `reasoning_tokens` and `cached_tokens`:

```typescript
{
  prompt_tokens: 1200,
  completion_tokens: 450,
  total_tokens: 1650,
  reasoning_tokens: 300,  // Reasoning models only
  cached_tokens: 800,     // When prompt caching is active
}
```

Cost estimates automatically account for provider-specific cache discounts (OpenAI: 50%, Anthropic: 10% reads / 125% writes, Gemini: 10%).

### `ctx.log()` as Span Events

Structured log events emitted via `ctx.log()` are automatically forwarded as OTel span events on the current active span:

```typescript
ctx.log('refund_processed', { orderId, amount });
// Appears as an OTel span event on the enclosing agent.ask or workflow.execute span
```

### Zero Overhead When Disabled

When no telemetry exporter is configured, the runtime uses a `NoopSpanManager` that performs no allocations and has zero overhead. This is the default — you only pay for telemetry when you opt in.

### Prompt Version Tracking

When an agent has a `version` field, it appears in trace events and OTel span attributes:

```typescript
const PlanGenerator = agent({
  model: 'anthropic:claude-sonnet-4-6',
  system: 'You are an expert fitness coach.',
  version: 'plan-v2.1',
});
```

```
[axl] step:1 agent_call_end | agent:PlanGenerator | version:plan-v2.1 | model:anthropic:claude-sonnet-4-6 | 2.1s | $0.008
```

This lets you correlate trace output to specific prompt versions, which is especially useful when comparing eval results.

## Crash Recovery: `state.persist: 'streaming'`

Opt-in durability mode that flushes events to the configured `StateStore` throughout a run, so a process crash mid-execution leaves a recoverable trace. Default is `'terminal'` (events written only at workflow end — back-compat, zero overhead).

```ts
const runtime = new AxlRuntime({
  state: {
    store: await RedisStore.create(redisUrl),
    persist: 'streaming',
    streamingBatchSize: 100,     // events per flush trigger (default 100)
    streamingBatchInterval: 1000, // ms (default 1000)
  },
});

// On the NEXT process, after a crash:
await runtime.getExecutions();              // hydrate historical cache first
const recovered = await runtime.recoverIncompleteStreams();
console.log(`Recovered ${recovered.length} crashed executions`);
// Now safe to accept new requests
```

**Excluded event types** (never flushed, never persisted to `ExecutionInfo.events`): `token`, `partial_object`, `string_delta` — high-volume stream-only events that consumers can reconstruct from `agent_call_end.data.response`. Same exclusion list governs Studio's WebSocket replay buffer.

**Scope.** Only `runtime.execute()` / `runtime.stream()` flush to the buffer. `runtime.createContext()` ad-hoc contexts (Studio playground, tool tests, evals) are deliberately excluded — they have no terminal finalize path, so allowing them to write would leave phantom orphans for `recoverIncompleteStreams()` to mis-recover on every restart.

**Recovered execution shape.** The synthesized `HistoricalExecutionInfo` keeps
the streaming buffer's event schema version; it does not upgrade v1 events or
invent missing tool terminals. It carries `status: 'failed'`,
`error: 'process terminated (recovered from streaming buffer)'`, and
`workflow: '__axl/recovered'` when the buffer is missing a `workflow_start`
event. The events array is bounded by `state.maxEventsPerExecution` (default
50k) — a crashed run with 500k events doesn't resurrect as an unbounded
execution. Consumers reading `getExecutions()` should narrow
`eventSchemaVersion` and can filter on the `__axl/` workflow prefix to exclude
recovered runs from dashboards.

**Safety contracts:**
- Recovery skips ids actively running in the current process (prevents corrupting a live workflow).
- `saveExecution` failure during recovery preserves the streaming buffer for the next attempt (no data loss on intermittent Redis failures).
- Recovery is idempotent — re-running it is safe; "canonical exists" branch drops orphan buffers without writing.

**Store coverage:** `RedisStore` implements the streaming methods atomically via MULTI. `MemoryStore` implements them in-process (good for tests; lost on crash by design). `SQLiteStore` does NOT — single-process file storage gets less value from crash-survival, and the runtime emits a one-shot warning when `persist: 'streaming'` is configured against it.

See [docs/migration/state-store-durability.md](./migration/state-store-durability.md#2-statepersist-streaming-for-crash-survival) for the full recovery contract and per-store coverage table.

## Windowed Aggregates (Studio)

Studio's aggregate views (Cost Dashboard, Eval Runner, Workflow Runner, Trace Explorer) compute time-windowed statistics from persisted execution and eval history. When backed by SQLiteStore or RedisStore, aggregates survive server restarts.

### Window selection

All four panels share a window selector: `24h | 7d | 30d | All`. Default is `7d`. The selection is persisted to `localStorage['axl.studio.window']` and shared across panels.

### How it works

Each aggregate panel is backed by a typed aggregator that:

1. **Rebuilds from history** on server start — replays persisted executions (up to 2000) or eval entries (up to 500) through a pure reducer function
2. **Folds live events** as they arrive via the runtime's event emitter
3. **Periodically rebuilds** every 5 minutes to evict events that fall outside time windows

Aggregate state is compute-on-read from the existing `ExecutionInfo.events` and `EvalHistoryEntry` data — no new persisted schema or materialized tables.

### REST endpoints

| Endpoint | Source | Description |
|---|---|---|
| `GET /api/costs?window=7d` | `AxlEvent` | Cost by agent, model, workflow + token totals |
| `GET /api/eval-trends?window=7d` | `EvalHistoryEntry` | Per-eval score trends, mean/std, cost |
| `GET /api/workflow-stats?window=7d` | `ExecutionInfo` | Per-workflow totals, failure rate, p50/p95 duration |
| `GET /api/trace-stats?window=7d` | `AxlEvent` | Event distribution, tool calls, retry breakdown |

All endpoints accept `?window=24h|7d|30d|all` (default `7d`). `GET /api/costs` also accepts `?windows=all` (plural) which returns the full per-window snapshot map in a single response — intended for debugging. All four endpoints are pure computation and allowed in `readOnly` mode.

### WebSocket channels

Each aggregator broadcasts to its own WS channel (`costs`, `eval-trends`, `workflow-stats`, `trace-stats`) with the payload `{ snapshots: Record<WindowId, State>, updatedAt: number }`.

### Migration from 0.14

- `POST /api/costs/reset` was **removed** in 0.15.0 — any client that was hitting it for a manual reset gets `404`. Use window selection instead; snapshots evict automatically as their window slides.
- The `CostAggregator` class was replaced by a generic `TraceAggregator<CostData>` configured with a pure `reduceCost` reducer. Behavior is preserved; any external consumer importing `CostAggregator` from `@axlsdk/studio` must switch to `TraceAggregator`.
- The `costs` WS channel payload changed from `CostData` to `{ snapshots: Record<WindowId, CostData>, updatedAt: number }`. Existing clients that read the old shape must select a window from `snapshots` (typically `snapshots['7d']`).

### Migration from 0.17

- `ExecutionInfo.metadata` is now lifted from `ExecuteOptions.metadata` (session control-plane keys `sessionHistory`/`sessionId` are stripped). Consumers reading `executionInfo.metadata` that previously saw `undefined` now see real values; narrow accordingly.
- `DELETE /api/executions/:id` is a new Studio endpoint. It scrubs the WS replay buffer for `execution:{id}` in addition to running `runtime.deleteExecution` — late subscribers can no longer reconstruct events for a deleted run.
- `runtime.on('execution_deleted', ...)` is a new audit-trail event. Subscribe for compliance logging without wrapping `runtime.deleteExecution`.
- `state.persist: 'streaming'` is the new opt-in durability mode. Existing deployments default to `'terminal'` (back-compat). See ["Crash Recovery"](#crash-recovery-statepersist-streaming) above.
- Custom `StateStore` implementers: `deleteExecution`'s contract widened to require a total per-execution sweep (checkpoints + state + pending decisions + streaming buffer + canonical row in one call). Implementations that only delete the canonical row leak PII through the side surfaces.
