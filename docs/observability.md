# Observability

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
| `steps` | One line per workflow step: agent calls, tool calls, verify results, budget usage. Includes cost and duration. **Default.** `agent_call` events already carry the resolved system prompt, resolved model params, reasoning/thinking content, turn counter, and retry reason — none of those depend on `full` mode |
| `full` | Everything in `steps`, plus: a complete `ChatMessage[]` snapshot on every `agent_call` event (under `data.messages`) so you can reconstruct exactly what the model saw on any given turn, including tool results and retry feedback accumulated across loop iterations. This grows with conversation depth, so it's off by default — enable when debugging |

### Example Output (`steps` level)

```
[axl] execution:abc-123 | workflow:HandleSupport | started
[axl] execution:abc-123 | step:1 agent_call | agent:SupportBot | model:openai-responses:gpt-5.4 | 1.2s | $0.003
[axl] execution:abc-123 | step:2 tool_call  | tool:get_order | args:["ORD-456"] | 45ms
[axl] execution:abc-123 | step:3 agent_call | agent:SupportBot | model:openai-responses:gpt-5.4 | 0.8s | $0.002
[axl] execution:abc-123 | step:4 tool_call  | tool:refund_order | args:["ORD-456"] | 120ms
[axl] execution:abc-123 | workflow:HandleSupport | completed | 2.4s | $0.005
```

## Programmatic Trace Access

Subscribe to trace events for custom logging, dashboards, or forwarding to external systems:

```typescript
runtime.on('trace', (event) => {
  // event: { executionId, step, type, agent?, tool?, promptVersion?, cost?, duration?, ... }
  myLogger.info(event);
  datadogClient.send(event);
});
```

### Trace event types

All events share the base `TraceEvent` shape; `data` is narrowed by `type`. See [api-reference.md](./api-reference.md#traceevent) for the full per-type schemas. The full set of types:

| Type | When emitted | Key `data` fields |
|------|-------------|-------------------|
| `workflow_start` / `workflow_end` | Workflow lifecycle | `input` / `result` |
| `agent_call` | Every LLM call (every loop turn of `ctx.ask()`) | `prompt`, `response`, `system`, `thinking?`, `params`, `turn`, `retryReason?`, `messages?` (verbose only) |
| `tool_call` | Tool execution completes | `args`, `result`, `callId` |
| `tool_approval` | `requireApproval` gate fires — **both** approve and deny | `approved`, `args`, `reason?` |
| `tool_denied` | Agent tried to call a tool that doesn't exist | `reason`, `args` |
| `guardrail` | Input or output guardrail runs — pass or fail | `guardrailType`, `blocked`, `reason?`, `attempt?`, `maxAttempts?`, `feedbackMessage?` (output only, on retry) |
| `schema_check` | Every schema parse on a structured-output call — pass or fail | `valid`, `reason?`, `attempt`, `maxAttempts`, `feedbackMessage?` (on retry) |
| `validate` | Post-schema business rule validator runs — pass or fail | `valid`, `reason?`, `attempt`, `maxAttempts`, `feedbackMessage?` (on retry) |
| `delegate` | `ctx.delegate()` routes to a candidate (including the single-agent short-circuit) | `candidates`, `selected?`, `routerModel?`, `reason?` |
| `handoff` | One agent hands off to another via a `handoff_to_*` tool | `target`, `mode`, `duration` |
| `verify` | `ctx.verify()` completes (pass or fail) | `attempts`, `passed`, `lastError?` |
| `log` | `ctx.log()` user-emitted event OR system audit events like `memory_remember` / `memory_recall` / `memory_forget` / `workflow_start` | caller-provided or `{ event, key, scope, hit?, resultCount?, embed?, usage? }` for memory ops |

**Semantic memory cost attribution.** `ctx.remember({embed: true})` and `ctx.recall({query})` call a paid embedding API. The operation emits a `log` event with `event: 'memory_remember'` or `'memory_recall'`, and when the embedder reported usage it sets:

- **Top-level `cost`** — USD amount, picked up automatically by `runtime.trackExecution()` and Studio's `CostAggregator` (flows into `totalCost` like any provider call).
- **Top-level `tokens.input`** — input tokens consumed by the embedder (kept separate from agent prompt tokens in the `totalTokens` summary).
- **`data.usage`** — full `{ tokens?, cost?, model? }` breakdown for trace inspection.

The Studio Cost Dashboard renders a "Memory (Embedder)" section when there's at least one embedder call, bucketing cost by embedder model via `CostData.byEmbedder`.

### Debugging retries

Three common symptoms and what to look for in traces:

**"My agent cost 3× what I expected."** Filter for `agent_call` events and check the `turn` field — if you see `turn: 2`, `turn: 3`, etc., the tool-calling loop ran multiple iterations. Check `retryReason` on those calls to see whether it was a schema, validate, or guardrail retry. Check the preceding `schema_check` / `validate` / `guardrail` event for the exact failure reason and `feedbackMessage` that was sent back to the LLM.

**"My structured output keeps failing."** Filter for `schema_check` events with `valid: false`. The `reason` field has the Zod parse error; the `feedbackMessage` is the exact message the model saw on its next attempt. If the feedback isn't clear enough to help the model correct itself, that's a prompt/schema design problem, not a retry-count problem.

**"Why did my agent respond that way?"** Enable `trace.level: 'full'` and check the `messages` array on the relevant `agent_call` — it has the exact conversation (system prompt, history, tool results, retry feedback) as the model saw it. `system`, `params`, `thinking`, and `retryReason` are visible in default mode without needing verbose.

### PII and redaction

`config.trace.redact` is an **observability-boundary filter** that scrubs user/LLM content everywhere it would otherwise flow to observability consumers. The mental model: "what can the observability layer see?". Under `redact: true`, structural metadata (workflow names, agent names, tool names, cost/token metrics, durations, status, roles, keys, IDs) stays visible — but any field that carries prompt/response/user/LLM content is replaced with `'[redacted]'`.

The filter applies at three layers:

**1. Trace events** — at `emitTrace()` emission time. Scrubs:

- `agent_call.data`: `prompt`, `response`, `system`, `thinking`, `messages`
- `guardrail` / `schema_check` / `validate`: `reason`, `feedbackMessage`
- `tool_call.data`: `args`, `result`
- `tool_approval.data`: `args`, `reason`
- `handoff.data.message` (roundtrip handoffs)
- `workflow_start.data.input`, `workflow_end.data.result`/`error`
- `log` events: string fields, with a one-level walk so nested numeric fields like `memory_remember.data.usage.tokens` / `.cost` survive while string fields like `.usage.model` are scrubbed

**2. Studio REST routes** — at response serialization time, via `runtime.isRedactEnabled()`. Scrubs:

| Route | Scrubbed fields | Preserved |
|---|---|---|
| `GET /api/executions` / `:id` | `result`, `error` | `executionId`, `workflow`, `status`, `duration`, `totalCost`, `startedAt` |
| `GET /api/memory/:scope` / `:key` | `value` | `key` (programmer-chosen identifier, needed for navigation) |
| `GET /api/sessions/:id` | `message.content`, `message.tool_calls[*].function.arguments`, `message.providerMetadata` | `role`, `name`, `tool_call_id`, `tool_calls[*].id`, `tool_calls[*].function.name`, handoff records |
| `GET /api/evals/history`, `POST /api/evals/:name/run` (sync), `POST /api/evals/:name/rescore` | per-item `input`, `output`, `error`, `annotations`, `scorerErrors`, `scoreDetails[*].metadata` | per-item `scores`, `duration`, `cost`, `scorerCost`; result-level `summary`, `metadata`, `totalCost`, `duration`, `timestamp` |
| `GET /api/decisions` | `prompt`, `metadata` (replaced with `{ redacted: true }`) | `executionId`, `channel`, `createdAt` |
| `POST /api/tools/:name/test` | `result` | tool name, input schema |
| `POST /api/workflows/:name/execute` (sync) | `result` | — |

**3. Studio WebSocket broadcasts** — for streaming endpoints (playground, workflow execute with `stream: true`). Scrubs `StreamEvent` fields before they hit the WS channel:

- `token.data` — streaming LLM output
- `tool_call.args`, `tool_result.result` — tool invocations
- `tool_approval.args`, `.reason`
- `done.data` — final workflow result
- `error.message`
- `step.data` passes through because the underlying `TraceEvent` was already scrubbed at emit time

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
exec.steps;       // All steps with inputs, outputs, cost, duration
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
[axl] step:1 agent_call | agent:PlanGenerator | version:plan-v2.1 | model:anthropic:claude-sonnet-4-6 | 2.1s | $0.008
```

This lets you correlate trace output to specific prompt versions, which is especially useful when comparing eval results.
