# Observability

## Trace Mode

Every workflow execution produces a structured trace. In development, this is your primary debugging tool.

### Configuration

```typescript
// axl.config.ts
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
| `steps` | One line per workflow step: agent calls, tool calls, verify results, budget usage. Includes cost and duration. |
| `full` | Everything in `steps`, plus: full LLM prompts, full LLM responses, tool arguments, tool return values, token counts. |

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

## Execution Inspector

Each execution is identified by a unique `execution_id`. The runtime provides an inspection API:

```typescript
const exec = await runtime.getExecution('abc-123');
exec.steps;       // All steps with inputs, outputs, cost, duration
exec.totalCost;   // Total LLM cost
exec.duration;    // Wall-clock time
exec.status;      // "running" | "completed" | "failed" | "waiting" (awaitHuman)
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
