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
| `steps` | One line per workflow step: agent calls, tool calls, verify results, budget usage. Includes cost and duration. **Default.** `agent_call_end` events already carry the resolved system prompt, resolved model params, reasoning/thinking content, turn counter, and retry reason — none of those depend on `full` mode |
| `full` | Everything in `steps`, plus: a complete `ChatMessage[]` snapshot on every `agent_call_end` event (under `data.messages`) so you can reconstruct exactly what the model saw on any given turn, including tool results and retry feedback accumulated across loop iterations. This grows with conversation depth, so it's off by default — enable when debugging |

### Example Output (`steps` level)

```
[axl] execution:abc-123 | workflow:HandleSupport | started
[axl] execution:abc-123 | step:1 agent_call_end | agent:SupportBot | model:openai-responses:gpt-5.4 | 1.2s | $0.003
[axl] execution:abc-123 | step:2 tool_call_end  | tool:get_order | args:["ORD-456"] | 45ms
[axl] execution:abc-123 | step:3 agent_call_end | agent:SupportBot | model:openai-responses:gpt-5.4 | 0.8s | $0.002
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

All events share the `AxlEventBase` shape; `data` and other variant-specific fields are narrowed by `type`. See [api-reference.md](./api-reference.md#axlevent) for the full per-type schemas. The full set of types:

| Type | When emitted | Key `data` fields |
|------|-------------|-------------------|
| `workflow_start` / `workflow_end` | Workflow lifecycle | `input` / `status`, `duration`, `result?`, `error?`, `aborted?` |
| `ask_start` / `ask_end` | Bound every `ctx.ask()` call (one pair per invocation, including nested). | `prompt` on start; `outcome: { ok: true, result } \| { ok: false, error }`, `cost`, `duration` on end |
| `agent_call_start` / `agent_call_end` | Per LLM call (every loop turn of `ctx.ask()`). `_start` fires before the request; `_end` after the response. | `_start`: `agent`, `model`, `turn`. `_end` `data`: `prompt`, `response`, `system`, `thinking?`, `params`, `turn`, `retryReason?`, `messages?` (verbose only) |
| `token` | Streaming text chunk (stream-only, never persisted to `ExecutionInfo.events`) | `data: string` |
| `tool_call_start` / `tool_call_end` | Tool invocation lifecycle | `_start` `data`: `args`. `_end` `data`: `args`, `result`, `callId` |
| `tool_approval` | `requireApproval` gate fires — **both** approve and deny | `approved`, `args`, `reason?` |
| `tool_denied` | Agent tried to call a tool that doesn't exist | `reason`, `args` |
| `guardrail` | Input or output guardrail runs — pass or fail | `guardrailType`, `blocked`, `reason?`, `attempt?`, `maxAttempts?`, `feedbackMessage?` (output only, on retry) |
| `schema_check` | Every schema parse on a structured-output call — pass or fail | `valid`, `reason?`, `attempt`, `maxAttempts`, `feedbackMessage?` (on retry) |
| `validate` | Post-schema business rule validator runs — pass or fail | `valid`, `reason?`, `attempt`, `maxAttempts`, `feedbackMessage?` (on retry) |
| `delegate` | `ctx.delegate()` routes to a candidate (including the single-agent short-circuit) | `candidates`, `selected?`, `routerModel?`, `reason` (`'routed'` \| `'single_candidate'`) |
| `handoff_start` | Fires BEFORE the target ask begins, on every handoff. **Not** AskScoped — spans two asks via `fromAskId` / `toAskId`. | `source`, `target`, `mode`, `message?` (roundtrip only) |
| `handoff_return` | Fires AFTER control returns to source. **Roundtrip mode only** (oneway terminates at target). **Not** AskScoped. | `source`, `target`, `duration` |
| `verify` | `ctx.verify()` completes (pass or fail) | `attempts`, `passed`, `lastError?` |
| `log` | `ctx.log()` user-emitted event | caller-provided |
| `memory_remember` / `memory_recall` / `memory_forget` | Memory ops audit | `{ key, scope, hit?, count?, embed?, usage? }` |
| `done` / `error` | Terminal workflow markers (wrap their payload under `data` — `done.data = { result }`, `error.data = { message, name?, code? }`) | see signatures |

**`pipeline`** (retry/validation lifecycle, three statuses: `start` / `committed` / `failed`) and **`partial_object`** (progressive structured output, emitted at string-safe boundaries when `ctx.ask()` has a `schema` and no tools) are emitted. `AxlStream.fullText` commits on `pipeline(committed)` and discards the in-progress buffer on `pipeline(failed)` or `ask_end({ok: false})`, so retried attempts' tokens never leak into the committed text.

**`workflow_start` / `workflow_end` are first-class event types as of 0.15.0** — previously emitted as `log` events with `data.event === 'workflow_start'` / `'workflow_end'`. Consumers filtering on the old log-form shape must switch to `event.type === 'workflow_start'` / `'workflow_end'`; `event.workflow` is now top-level, `data` carries `WorkflowStartData { input }` / `WorkflowEndData { status, duration, result?, error?, aborted? }`. `runtime.stream()` now also emits `workflow_start` (was silently omitted). Aborted workflows emit `workflow_end` with `data.aborted: true` so consumers can distinguish cancellation / budget hard-stop from genuine errors without a separate event subscription.

**Agent-as-tool correlation.** When an agent-as-tool handler spawns a child `WorkflowContext` (via `ctx.createChildContext()` inside a tool) and the child performs `ctx.ask()`, the nested ask's events all carry `parentAskId === outerAsk.askId` (on `AskScoped`, see below). Consumers reconstruct call graphs by parent-linking on `parentAskId`. The Trace Explorer visualizes nesting via `getDepth()`. The legacy `parentToolCallId` field was removed in 0.17.0 — `parentAskId` is the going-forward correlation primitive.

### Ask-graph correlation (`AskScoped`)

Every event originating within a `ctx.ask()` call carries an `AskScoped` mixin:

| Field | Type | Description |
|---|---|---|
| `askId` | `string` | The ask invocation. Stable for all events emitted within a single `ctx.ask()` (including its agent_call turns and tool calls) |
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

Use the exported helper `eventCostContribution(event)` — it returns `0` for `ask_end` rollups and for non-finite values, and the event's cost otherwise. This is the single source of truth Axl's internals use; third-party accumulators should match:

```typescript
import { eventCostContribution } from '@axlsdk/axl';

let total = 0;
for (const event of info.events) {
  total += eventCostContribution(event);
}
```

The whole-execution total is `ExecutionInfo.totalCost`. Axl's built-in `runtime.trackExecution`, `ExecutionInfo.totalCost`, Studio's cost aggregator, and `AxlTestRuntime.totalCost()` all apply this guard via `eventCostContribution` internally.

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

### Streaming callbacks: `meta` parameter

`onToken`, `onToolCall`, and `onAgentStart` (on `runtime.createContext()`, `runtime.execute()`, and `runtime.stream()`) receive a second `meta: CallbackMeta` parameter:

```typescript
type CallbackMeta = {
  askId: string;
  parentAskId?: string;
  depth: number;
  agent: string;
};
```

`createChildContext` no longer isolates these callbacks — nested asks (e.g., agent-as-tool handlers calling `ctx.ask()`) propagate to the same outer callbacks. To preserve the old root-only behavior, filter on `meta.depth === 0`:

```typescript
const ctx = runtime.createContext({
  onToken: (token, meta) => {
    if (meta.depth === 0) display(token); // root-only chat UI
  },
});
```

Drop the `depth === 0` filter to display tokens from nested asks too.

### Debugging retries

Three common symptoms and what to look for in traces:

**"My agent cost 3× what I expected."** Filter for `agent_call_end` events and check the `data.turn` field — if you see `turn: 2`, `turn: 3`, etc., the tool-calling loop ran multiple iterations. Check `data.retryReason` on those calls to see whether it was a schema, validate, or guardrail retry. Check the preceding `schema_check` / `validate` / `guardrail` event for the exact failure reason and `feedbackMessage` that was sent back to the LLM.

**"My structured output keeps failing."** Filter for `schema_check` events with `valid: false`. The `reason` field has the Zod parse error; the `feedbackMessage` is the exact message the model saw on its next attempt. If the feedback isn't clear enough to help the model correct itself, that's a prompt/schema design problem, not a retry-count problem.

**"Why did my agent respond that way?"** Enable `trace.level: 'full'` and check the `data.messages` array on the relevant `agent_call_end` — it has the exact conversation (system prompt, history, tool results, retry feedback) as the model saw it. `system`, `params`, `thinking`, and `retryReason` are visible in default mode without needing verbose.

### PII and redaction

`config.trace.redact` is an **observability-boundary filter** that scrubs user/LLM content everywhere it would otherwise flow to observability consumers. The mental model: "what can the observability layer see?". Under `redact: true`, structural metadata (workflow names, agent names, tool names, cost/token metrics, durations, status, roles, keys, IDs, `askId`/`parentAskId`/`depth`) stays visible — but any field that carries prompt/response/user/LLM content is replaced with `'[redacted]'`.

The filter applies at three layers:

**1. AxlEvents** — at `emitEvent()` emission time. Scrubs:

- `agent_call_end.data`: `prompt`, `response`, `system`, `thinking`, `messages` (replaced with a single placeholder message preserving the count)
- `ask_start.prompt` and `ask_end.outcome` (`outcome.result` on success, `outcome.error` on failure)
- `guardrail` / `schema_check` / `validate`: `reason`, `feedbackMessage`
- `tool_call_start.data.args`, `tool_call_end.data`: `args`, `result`
- `tool_approval.data`: `args`, `reason`
- `handoff_start.data.message` (roundtrip handoffs only — `handoff_return` carries no user/LLM content)
- `workflow_start.data.input`, `workflow_end.data.result`/`error`
- `done.data.result`, `error.data.message`
- `log` events: string fields, with a one-level walk so nested numeric fields like `memory_remember.data.usage.tokens` / `.cost` survive while string fields like `.usage.model` are scrubbed. Arrays and deeper nesting collapse to the `'[redacted]'` sentinel

**2. Studio REST routes** — at response serialization time, via `runtime.isRedactEnabled()`. Scrubs:

| Route | Scrubbed fields | Preserved |
|---|---|---|
| `GET /api/executions` / `:id` | `result`, `error` | `executionId`, `workflow`, `status`, `duration`, `totalCost`, `startedAt`, `completedAt`, `events` (already scrubbed at emit time) |
| `GET /api/memory/:scope` / `:key` | `value` | `key` (programmer-chosen identifier, needed for navigation) |
| `GET /api/sessions/:id` | `message.content`, `message.tool_calls[*].function.arguments`; `message.providerMetadata` is dropped entirely (opaque bag that may carry encoded reasoning / cache keys) | `role`, `name`, `tool_call_id`, `tool_calls[*].id`, `tool_calls[*].type`, `tool_calls[*].function.name`, `handoffHistory` (no content fields to scrub) |
| `GET /api/evals/history`, `POST /api/evals/:name/run` (sync), `POST /api/evals/:name/rescore` | per-item `input`, `output`, `error`, `annotations`, `scorerErrors`, `scoreDetails[*].metadata` | per-item `scores`, `duration`, `cost`, `scorerCost`, `metadata` (models / tokens / workflows), `traces` (already scrubbed at emit time); result-level `summary`, `metadata`, `totalCost`, `duration`, `timestamp` |
| `GET /api/decisions` | `prompt`, `metadata` (replaced with `{ redacted: true }`) | `executionId`, `channel`, `createdAt` |
| `POST /api/tools/:name/test` | `result` | tool name, input schema |
| `POST /api/workflows/:name/execute` (sync) | `result` | — |

**3. Studio WebSocket broadcasts** — for streaming endpoints (playground, workflow execute with `stream: true`) **and** the trace firehose (`trace:*` channels). Scrubs the new `AxlEvent` variants directly via `redactStreamEvent`:

- `token.data` — streaming LLM output
- `tool_call_start.data.args`, `tool_call_end.data.args`/`result`
- `tool_approval.data.args`/`.reason`
- `ask_start.prompt`, `ask_end.outcome`
- `done.data.result`, `error.data.message`
- `handoff_start.data.message` (roundtrip only)
- structural fields (`type`, `step`, `agent`, `tool`, `askId`, `parentAskId`, `depth`, cost/duration/token totals) pass through

In 0.16.0 the trace WS channel applies `redactStreamEvent` directly so the firehose can no longer bypass the per-route scrub (closing a previous PII leak).

**Top-level numeric fields (`cost`, `tokens`, `duration`) are never scrubbed**, even under `redact: true`. They're load-bearing — `trackExecution`'s cost-aggregation listener and Studio's `CostAggregator` both read `event.cost` directly, so zeroing them would silently break total cost tracking when redaction is enabled. If your compliance environment treats aggregate spend as sensitive, filter events out entirely in your `onTrace` / `filterTraceEvent` handler rather than relying on redaction to scrub them.

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
| `axl.tool.call` | `axl.tool.name`, `axl.tool.duration`, `axl.tool.success` |
| `axl.ctx.spawn` | `axl.spawn.count`, `axl.spawn.quorum`, `axl.spawn.completed` |
| `axl.ctx.race` | `axl.race.participants`, `axl.race.winner` |
| `axl.ctx.vote` | `axl.vote.strategy`, `axl.vote.result` |
| `axl.ctx.budget` | `axl.budget.limit`, `axl.budget.totalCost`, `axl.budget.exceeded` |
| `axl.ctx.awaitHuman` | `axl.awaitHuman.channel`, `axl.awaitHuman.wait_duration` |
| `axl.tool.approval` | `axl.tool.name`, `axl.tool.approval.approved` |
| `axl.agent.handoff` | `axl.handoff.source`, `axl.handoff.target`, `axl.handoff.mode` |

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
