# Architecture

Axl operates on an **Embedded Runtime Model**. In development, it runs in-process inside your Node.js application. In production, it can optionally be deployed as a standalone sidecar for isolation and scaling.

## Components

1. **The SDK (`@axlsdk/axl`):** A TypeScript library that embeds directly in your Node.js process. It manages the event loop, LLM context, tool dispatch, and state persistence. No separate binary, no separate process.
2. **The Host App:** Your existing application (NestJS, Express, Next.js, Hono, Fastify) that provides tools and triggers workflows.

## Deployment Modes

| Mode | How it works | Best for |
|------|-------------|----------|
| **Embedded (Default)** | SDK runs in-process via `@axlsdk/axl`. Zero infrastructure. | Development, prototyping, small-medium workloads |
| **Sidecar (Planned)** | Runtime runs as a separate Node.js process. Communicates via Unix socket or gRPC. | Isolation, independent scaling, large workloads |
| **Studio (Local Dev)** | `npx @axlsdk/studio` wraps AxlRuntime with a Hono server + React SPA for interactive debugging. | Development, testing, iteration |

## Execution Flow

1. **Define:** You define tools, agents, and workflows using TypeScript functions from the `@axlsdk/axl` package.
2. **Create Runtime:** You instantiate `AxlRuntime` with your config, agents, tools, and workflows.
3. **Trigger:** The host dispatches a job (`runtime.execute("WorkflowName", inputs)`) — a direct function call, no network hop.
4. **Orchestration:** The runtime executes the workflow logic, invoking tools in-process and LLM providers over HTTP.
5. **Streaming:** Intermediate results are emitted via an `EventEmitter`-style API as the workflow executes.

```typescript
import { AxlRuntime, workflow, agent, tool } from '@axlsdk/axl';
import { z } from 'zod';

// 1. Define
const myTool = tool({ name: 'search', description: '...', input: z.object({ q: z.string() }), handler: async ({ q }) => ({ results: [] }) });
const myAgent = agent({ model: 'openai-responses:gpt-5.4', system: '...', tools: [myTool] });
const myWorkflow = workflow({ name: 'research', input: z.object({ topic: z.string() }), handler: async (ctx) => ctx.ask(myAgent, ctx.input.topic) });

// 2. Create Runtime
const runtime = new AxlRuntime();
runtime.register(myWorkflow);

// 3. Trigger
const result = await runtime.execute('research', { topic: 'TypeScript SDKs' });

// 4 & 5. Or stream
const stream = runtime.stream('research', { topic: 'TypeScript SDKs' });
for await (const event of stream) {
  if (event.type === 'token') process.stdout.write(event.data);
}
```

## Core Abstractions

### Tools

Tools are typed functions that agents can call. Each tool has a Zod input schema, a handler, and optional configuration (retry policy, sensitivity, approval gates, hooks).

### Agents

Agents are inert definitions that wrap an LLM model, system prompt, tools, and handoff targets. They don't do anything until invoked via `ctx.ask()`. Agents support dynamic model and system prompt selection based on runtime context.

### Workflows

Workflows are named async functions that receive a `WorkflowContext` (`ctx`). The context provides all agentic primitives: `ask`, `spawn`, `vote`, `verify`, `budget`, `race`, `parallel`, `map`, `awaitHuman`, `checkpoint`, `remember`, `recall`, `forget`, and `log`. See the [API Reference](./api-reference.md) for complete option types, valid values, and defaults.

### Runtime

`AxlRuntime` is the top-level coordinator. It holds the provider registry, state store, telemetry config, and memory config. Workflows are registered on the runtime and executed via `runtime.execute()` or `runtime.stream()`.

### Sessions

Sessions provide multi-turn conversation state. Each session maintains message history and can persist across requests via the state store. Sessions support forking, configurable history limits, and automatic summarization.

## Provider Architecture

Provider adapters use raw `fetch` with zero SDK dependencies. Each adapter implements the `Provider` interface (`chat` and `stream` methods) and is registered via the `ProviderRegistry` using a factory pattern. Provider URIs follow the `provider:model` scheme.

All providers include automatic retry with exponential backoff on `429` (rate limit), `503` (service unavailable), and `529` (overloaded) responses.

## State Management

The `StateStore` interface abstracts persistence. Three built-in implementations:

| Store | Use Case |
|-------|----------|
| `MemoryStore` | In-memory (default, development) |
| `SQLiteStore` | File-based persistence (requires `better-sqlite3`) |
| `RedisStore` | Multi-process deployments (requires `ioredis`) |

State stores handle workflow execution state (for `checkpoint`/resume), session history, memory entries, and pending human decisions.
