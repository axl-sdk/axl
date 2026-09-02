# @axlsdk/axl

[![npm version](https://img.shields.io/npm/v/@axlsdk/axl)](https://www.npmjs.com/package/@axlsdk/axl)

Core SDK for orchestrating agentic systems in TypeScript. Part of the [Axl](https://github.com/axl-sdk/axl) monorepo.

## Installation

```bash
npm install @axlsdk/axl zod@^4
```

> **Note:** `zod` is a peer dependency — your application and Axl share a single Zod instance. Zod v4 (`^4.0.0`) is required.

> **Migrating from 0.15?** The 0.16.0 unified event model collapses `TraceEvent` and `StreamEvent` into a single `AxlEvent` union, renames `ExecutionInfo.steps` → `.events` and `AxlStream.steps` → `.lifecycle`, removes the deprecated `parentToolCallId` field, and changes `ctx.checkpoint(fn)` to `ctx.checkpoint(name, fn)`. See the [migration guide](../../docs/migration/unified-event-model.md) for the full rename/move table.

## Project Structure

The recommended pattern separates config, tools, agents, workflows, and runtime into their own modules. Dependencies flow one direction: tools → agents → workflows → runtime.

```
src/
  config.ts              — defineConfig (providers, state, trace)
  runtime.ts             — creates AxlRuntime, registers everything

  tools/
    db.ts                — tool wrapping database queries
    email.ts             — tool wrapping email service

  agents/
    support.ts           — support agent (imports its tools)
    billing.ts           — billing agent

  workflows/
    handle-ticket.ts     — orchestrates support + billing agents

axl.config.mts           — re-exports runtime for Axl Studio
```

### Config

Use `defineConfig` to create a typed configuration. Keep this separate from your runtime so you can swap configs per environment:

```typescript
// src/config.ts
import { defineConfig } from '@axlsdk/axl';

export const config = defineConfig({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    google: { apiKey: process.env.GOOGLE_API_KEY },
  },
  state: { store: 'sqlite', sqlite: { path: './data/axl.db' } },
  trace: { enabled: true, level: 'steps' },
});
```

Provider API keys are also read automatically from environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`), so for local development you can skip the `providers` block entirely.

**Beyond the big three**, Axl ships presets for any OpenAI-compatible endpoint — pick a model with `preset:model` and set the matching env var:

```typescript
agent({ model: 'openrouter:anthropic/claude-opus-4.7' }); // OPENROUTER_API_KEY — 300+ models, one key
agent({ model: 'groq:openai/gpt-oss-120b' });             // GROQ_API_KEY — fastest inference
agent({ model: 'deepseek:deepseek-reasoner' });           // DEEPSEEK_API_KEY
agent({ model: 'ollama:llama3' });                        // local — no key, $0
```

Presets: `openrouter`, `azure`, `xai`, `deepseek`, `mistral`, `groq`, `bedrock`, and self-hosted `ollama` / `vllm` / `lmstudio` / `llamacpp` / `sglang`. The unified `effort` knob and per-call cost tracking work across them. OpenAI Responses, Anthropic, Google, and OpenRouter accept image input without hard-coding a model catalog; the selected upstream model remains authoritative. Completed-file transcription is a separate, narrower contract. Build your own compatible provider by cloning a `ProviderProfile`; see [provider details](../../docs/providers.md) and [multimodal input](../../docs/multimodal-input.md).

Each provider also accepts an opt-in `rateLimit` (`{ maxConcurrent?, minIntervalMs?, acquireTimeoutMs? }`) for proactive client-side pacing on top of the automatic 429/503/529 backoff — useful when a large fan-out (e.g. an eval) shares one API key. It caps in-flight request concurrency (not token throughput) for that provider's chat calls. See [Providers → Rate limiting](../../docs/providers.md#rate-limiting-opt-in).

Built-in providers require HTTPS for remote endpoints and never follow redirects.
Literal loopback HTTP remains automatic for local inference; Docker service names,
private-network URLs, and other remote HTTP endpoints require the provider-local
`dangerouslyAllowInsecureHttp: true` acknowledgement. Keep Axl and proprietary
system prompts on your trusted backend—see
[Prompt confidentiality](../../docs/security.md#prompt-confidentiality-and-the-trusted-backend).

State store options: `'memory'` (default), `'sqlite'` (requires `better-sqlite3`), or a `RedisStore` instance for multi-process deployments. See [State Stores](#state-stores).

### Tools, Agents, and Workflows

Define each in its own module. Tools wrap your services, agents import the tools they need, workflows orchestrate agents:

```typescript
// src/tools/db.ts
import { tool } from '@axlsdk/axl';
import { z } from 'zod';
import { db } from '../services/db.js';

export const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Look up an order by ID',
  input: z.object({ orderId: z.string() }),
  handler: async ({ orderId }) => db.orders.findById(orderId),
});
```

```typescript
// src/agents/support.ts
import { agent } from '@axlsdk/axl';
import { lookupOrder } from '../tools/db.js';

export const supportAgent = agent({
  name: 'support',
  model: 'openai-responses:gpt-5.5',
  system: 'You are a customer support agent. Use tools to look up order information.',
  tools: [lookupOrder],
});
```

```typescript
// src/workflows/handle-ticket.ts
import { workflow } from '@axlsdk/axl';
import { z } from 'zod';
import { supportAgent } from '../agents/support.js';

export const handleTicket = workflow({
  name: 'handle-ticket',
  input: z.object({ message: z.string() }),
  handler: async (ctx) => ctx.ask(supportAgent, ctx.input.message),
});
```

### Runtime

The runtime is the composition root — it imports the config and registers all workflows. Your application and [Axl Studio](https://github.com/axl-sdk/axl/tree/main/packages/axl-studio) both import this module:

```typescript
// src/runtime.ts
import { AxlRuntime } from '@axlsdk/axl';
import { config } from './config.js';
import { handleTicket } from './workflows/handle-ticket.js';
import { supportAgent } from './agents/support.js';
import { lookupOrder } from './tools/db.js';

export const runtime = new AxlRuntime(config);
runtime.register(handleTicket);
runtime.registerAgent(supportAgent);
runtime.registerTool(lookupOrder);
```

```typescript
// axl.config.mts — thin entry point for Axl Studio
import { runtime } from './src/runtime.js';
export default runtime;
```

## API

### `tool(config)`

Define a tool with Zod input validation:

```typescript
import { tool } from '@axlsdk/axl';
import { z } from 'zod';

const calculator = tool({
  name: 'calculator',
  description: 'Evaluate arithmetic expressions',
  input: z.object({ expression: z.string() }),
  handler: ({ expression }) => {
    const result = new Function(`return (${expression})`)();
    return { result };
  },
  // handler also accepts (input, ctx) for nested agent invocations — see below
  retry: { attempts: 3, backoff: 'exponential' },
  sensitive: false,
  // Keep the complete handler result for the host while sending only this
  // allowlisted projection back to the model:
  toModelOutput: (result) => ({ answer: result.result }),
});
```

`toModelOutput` is an opt-in, synchronous mapper for successful agent-invoked local tools. Strings are sent verbatim; JSON-compatible values are strictly validated and serialized once. The full post-hook result stays on the succeeded `tool_call_end.data.outcome.result` for host rendering (subject to `trace.redact`). `sensitive: true` and thrown handler/hook/mock failures skip projection, and projection errors close the call as `failed` / `projection` with no raw fallback. Direct `tool.run()`/`_execute()`, MCP tools, and handoffs are unchanged. See the [API reference](../../docs/api-reference.md#model-facing-tool-output) for the exact type, validation, mock, and delivery contract.

A normally returned value succeeds even when it contains an `error` property,
and `hooks.after` runs after every normal handler return. Throw `ToolFailure`
when a known failure has an author-declared message that is safe for model
recovery; ordinary throws abort the ask without provider tool content. Live
events use schema v2: pre-start rejection is `tool_call_rejected`, while every
accepted call closes with a `succeeded`, `failed`, `denied`, or `cancelled`
outcome. See the
[migration guide](../../docs/migration/stream-first-observation.md).

Tool handlers receive a second parameter `ctx: WorkflowContext` (a child context), enabling the "agent-as-tool" composition pattern:

```typescript
const researchTool = tool({
  name: 'research',
  description: 'Delegate to a specialist',
  input: z.object({ question: z.string() }),
  handler: async (input, ctx) => ctx.ask(researcher, input.question),
});
```

### `agent(config)`

Define an agent with model, system prompt, tools, and handoffs:

```typescript
import { agent } from '@axlsdk/axl';

const researcher = agent({
  name: 'researcher',
  model: 'openai-responses:gpt-5.5',
  system: 'You are a research assistant.',
  tools: [calculator],
  effort: 'high',
  maxTurns: 10,
  timeout: '30s',
  temperature: 0.7,
  version: 'v1.2',
});
```

Dynamic model and system prompt selection:

```typescript
const dynamicAgent = agent({
  model: (ctx) =>
    ctx.metadata?.tier === 'premium'
      ? 'openai-responses:gpt-5.5'
      : 'openai-responses:gpt-5-nano',
  system: (ctx) => `You are a ${ctx.metadata?.role ?? 'general'} assistant.`,
});
```

#### Dynamic Handoffs

`handoffs` accepts a static array or a function for runtime-conditional routing:

```typescript
const router = agent({
  model: 'openai-responses:gpt-5-mini',
  system: 'Route to the right specialist.',
  handoffs: (ctx) => {
    const base = [
      { agent: billingAgent, description: 'Billing issues' },
      { agent: shippingAgent, description: 'Shipping questions' },
    ];
    if (ctx.metadata?.tier === 'enterprise') {
      base.push({ agent: priorityAgent, description: 'Priority support' });
    }
    return base;
  },
});
```

#### Workflow-Level Routing with `ctx.delegate()`

When your workflow (not an agent's LLM) needs to pick the best agent:

```typescript
const result = await ctx.delegate(
  [billingAgent, shippingAgent, returnsAgent],
  customerMessage,
);
```

`ctx.delegate()` creates a temporary router agent that uses handoffs to select the best candidate. For a single agent, it calls `ctx.ask()` directly with no routing overhead.

#### Effort (cross-provider reasoning control)

The `effort` parameter provides a unified way to control reasoning depth across all providers:

```typescript
// Simple levels — works on any provider
const reasoner = agent({
  model: 'anthropic:claude-opus-4-7',
  system: 'You are a careful analyst.',
  effort: 'high', // 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
});

// Explicit thinking budget (in tokens — supported on Gemini 2.x and Anthropic)
const budgetReasoner = agent({
  model: 'google:gemini-2.5-pro',
  system: 'Think step by step.',
  thinkingBudget: 5000,
});

// Per-call override
const result = await reasoner.ask('Analyze this data', { effort: 'low' });
```

Each provider maps `effort` to its native API: reasoning effort (OpenAI), adaptive thinking (Anthropic), thinking level/budget (Gemini). See [docs/providers.md](../../docs/providers.md) for the full mapping table.

### `workflow(config)`

Define a named workflow with typed input:

```typescript
import { workflow } from '@axlsdk/axl';
import { z } from 'zod';

const myWorkflow = workflow({
  name: 'my-workflow',
  input: z.object({ query: z.string() }),
  handler: async (ctx) => {
    return ctx.ask(researcher, ctx.input.query, {
      schema: z.object({ answer: z.string() }),
    });
  },
});
```

For single-ask workflows, use `schema` on `ctx.ask()` — it instructs the LLM and retries automatically on invalid output. The optional `output` field validates your handler's return value *after* it runs (no LLM retry), which is useful for multi-step workflows where your orchestration logic (spawn, vote, transform) could assemble the wrong shape:

```typescript
const answerSchema = z.object({ answer: z.number() });

const reliable = workflow({
  name: 'reliable',
  input: z.object({ question: z.string() }),
  output: answerSchema, // validates the spawn+vote result, not the LLM
  handler: async (ctx) => {
    const results = await ctx.spawn(3, async (_i) =>
      ctx.ask(mathAgent, ctx.input.question, { schema: answerSchema }),
    );
    return ctx.vote(results, { strategy: 'majority', key: 'answer' });
  },
});
```

### `AxlRuntime`

Register and execute workflows:

```typescript
runtime.register(myWorkflow);

// Execute
const result = await runtime.execute('my-workflow', { query: 'Hello' });

// Stream
const stream = runtime.stream('my-workflow', { query: 'Hello' });
for await (const event of stream) {
  if (event.type === 'token') process.stdout.write(event.data);
  if (event.type === 'error') console.error('Stream error:', event.data.message);
  if (event.type === 'done') console.log('Result:', event.data.result);
}

// Sessions — multi-turn conversations with persisted history.
// `send`/`stream`/`end`/`fork` are serialized per session id within
// the runtime; concurrent calls on the same id queue FIFO. Cross-process
// locking is NOT provided — see docs/api-reference.md for details.
const session = runtime.session('user-123');
await session.send('my-workflow', { query: 'Hello' });
await session.send('my-workflow', { query: 'Follow-up' });

// In multi-agent workflows, each committed assistant message carries
// `ChatMessage.agent` (the originating agent's name) so consumers can
// attribute history. Surfaced as a clickable badge in Studio.
const history = await session.history();
//   [{ role: 'user', content: '...' },
//    { role: 'assistant', content: '...', agent: 'triage' }, ...]

// Stream a session turn
const sessionStream = await session.stream('my-workflow', { query: 'Hello' });
for await (const event of sessionStream) {
  if (event.type === 'token') process.stdout.write(event.data);
}
```

#### Observing inside a workflow handler with `ctx.events`

To observe events between `ctx.ask()` calls — e.g., streaming `partial_object` snapshots to a UI as a multi-step structured-output workflow runs — read `ctx.events`. Same `AxlEvent` union and curated views (`.text`, `.lifecycle`, `.textByAsk`, `.partialObjects`) as `AxlStream`, scoped to the current context (and its children — agent-as-tool nested asks bubble up).

```typescript
// Schemas + agents the example references — declared so the snippet
// compiles standalone.
const outlineSchema = z.object({ outline: z.array(z.string()) });
const draftSchema = z.object({ draft: z.string() });
const planner = agent({ model: 'openai:gpt-4o', system: 'Plan an outline.' });
const writer = agent({ model: 'openai:gpt-4o', system: 'Write a draft.' });

const wf = workflow({
  name: 'two-step',
  input: z.object({ topic: z.string() }),
  handler: async (ctx) => {
    // Allocate the bus first — `ctx.events` is a lazy getter; the
    // streaming code path inside ctx.ask() only activates when an
    // observer was present at the time the ask started. Touching the
    // getter synchronously here wires every ask in this handler.
    // Defensive `void ctx.events;` (or `const events = ctx.events;`) is
    // the unambiguous pattern — relying on the IIFE alone is correct
    // but subtle, since the synchronous `for await (...ctx.events.partialObjects)`
    // expression evaluates the getter before the first suspension.
    const events = ctx.events;
    // Background observer. The IIFE returns a promise; attaching a `.catch`
    // ensures consumer errors surface in your logs instead of being
    // swallowed by the unhandled-rejection handler. The bus
    // auto-finishes on `workflow_end` / `error`, so the iterator
    // terminates with the run.
    void (async () => {
      for await (const partial of events.partialObjects) {
        // .partialObjects is the coalescing view: yields the LATEST
        // payload per askId, with the 1-indexed `attempt` (UIs can flag
        // a regenerating draft when it bumps to 2). Memory bounded by
        // O(active asks), not O(events). Designed for
        // streaming-structured-output UIs.
        console.log(`[ask ${partial.askId} attempt ${partial.attempt}]`, partial.object);
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

Subscribe before the first `ctx.ask()` — the streaming code path inside `ctx.ask()` only activates when an observer is present at the time the ask starts. The bus auto-terminates on `workflow_end` / `error` (and on signal abort, for ad-hoc `runtime.createContext({ signal })` flows). Configure the iterator-queue cap and overflow policy via `runtime.execute(..., { events: { maxQueued, onOverflow } })` — defaults (`maxQueued: 10_000`, `onOverflow: 'drop-oldest-non-terminal'`) are a default-on safety net against slow consumers. See [`docs/observability.md`](../../docs/observability.md#observation-paths) for the full Observation paths comparison, [`docs/api-reference.md`](../../docs/api-reference.md#ctxevents) for the type table, and [`docs/migration/stream-first-observation.md`](../../docs/migration/stream-first-observation.md) for upgrade notes.

The former `onToken`, `onToolCall`, and `onAgentStart` options on
`runtime.createContext()` are removed. Use `ctx.events`, `runtime.stream()`, or
the runtime trace listener according to observation scope; untyped callers that
still pass a removed key receive a targeted migration error.

### Context Primitives

All available on `ctx` inside workflow handlers. See the [API Reference](../../docs/api-reference.md) for complete option types, valid values, and defaults.

```typescript
// Invoke an agent (schema/validate retries accumulate — LLM sees all previous failed attempts)
const answer = await ctx.ask(agent, 'prompt', { schema, retries });

// Run 3 agents in parallel — each gets the same question independently
const results = await ctx.spawn(3, async (i) => ctx.ask(agent, prompts[i]));

// Pick the answer that appeared most often — also supports LLM-as-judge via scorer
const winner = await ctx.vote(results, { strategy: 'majority', key: 'answer' });

// Retry-until-valid loop — for APIs, pipelines, or as a repair fallback for ctx.ask()
const valid = await ctx.verify(
  async () => fetchRouteFromAPI(origin, destination),
  RouteSchema,
  { retries: 3, fallback: defaultRoute },
);

// Cost control — returns { value, budgetExceeded, totalCost }
const { value } = await ctx.budget(
  { cost: '$1.00', onExceed: 'hard_stop' },
  async () => ctx.ask(agent, prompt),
);

// First to complete
const fastest = await ctx.race(
  [() => ctx.ask(agentA, prompt), () => ctx.ask(agentB, prompt)],
  { schema },
);

// Concurrent independent tasks
const [a, b] = await ctx.parallel([
  () => ctx.ask(agentA, promptA),
  () => ctx.ask(agentB, promptB),
]);

// Map with bounded concurrency — resolve when 3 of N succeed, cancel the rest
const mapped = await ctx.map(items, async (item) => ctx.ask(agent, item), {
  concurrency: 5,
  quorum: 3,
});

// Human-in-the-loop — suspends until resolved via API or Studio
const decision = await ctx.awaitHuman({
  channel: 'approvals',
  prompt: 'Approve this action?',
});

// Scoped checkpoint — on first evaluation, executes and saves the result
// under the current execution ID. A later evaluation in that same explicit
// execution scope can replay it. Axl does not automatically restart or
// resume workflows across processes.
const checkpointed = await ctx.checkpoint('expensive-op', async () => expensiveOperation());
```

### OpenTelemetry Observability

Automatic span emission for every `ctx.*` primitive with cost-per-span attribution. Install `@opentelemetry/api` as an optional peer dependency.

```typescript
import { defineConfig, AxlRuntime } from '@axlsdk/axl';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const tracerProvider = new BasicTracerProvider();
tracerProvider.addSpanProcessor(
  new SimpleSpanProcessor(
    new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }),
  ),
);

const config = defineConfig({
  telemetry: {
    enabled: true,
    serviceName: 'my-app',
    tracerProvider,
  },
});

const runtime = new AxlRuntime(config);
await runtime.initializeTelemetry();
```

**Span model:** `axl.workflow.execute` > `axl.agent.ask` > `axl.tool.call`. Also: `axl.ctx.spawn`, `axl.ctx.race`, `axl.ctx.vote`, `axl.ctx.budget`, `axl.ctx.awaitHuman`. Each span includes relevant attributes (cost, duration, token counts, etc.).

When disabled (default), `NoopSpanManager` provides zero overhead.

```typescript
import { createSpanManager, NoopSpanManager } from '@axlsdk/axl';
```

### Memory Primitives

Working memory backed by the `StateStore` interface:

```typescript
// Store and retrieve structured state
await ctx.remember('user-preferences', { theme: 'dark', lang: 'en' });
const prefs = await ctx.recall('user-preferences');
await ctx.forget('user-preferences');

// Scoped to session (default) or global
await ctx.remember('user-profile', data, { scope: 'global' });
const profile = await ctx.recall('user-profile', { scope: 'global' });
```

Semantic recall requires a vector store and embedder on the config:

```typescript
import { defineConfig, AxlRuntime, InMemoryVectorStore, OpenAIEmbedder } from '@axlsdk/axl';

const config = defineConfig({
  memory: {
    vectorStore: new InMemoryVectorStore(),
    embedder: new OpenAIEmbedder({ model: 'text-embedding-3-small' }),
  },
});

const runtime = new AxlRuntime(config);

// In a workflow:
const relevant = await ctx.recall('knowledge-base', {
  query: 'refund policy',
  topK: 5,
});
```

Vector store implementations: `InMemoryVectorStore` (testing), `SqliteVectorStore` (production, requires `better-sqlite3`).

**Embedder cost attribution.** `OpenAIEmbedder` reports `{ tokens, cost, model }` on every embed call — computed from the response's `prompt_tokens` and a pricing table (`text-embedding-3-small` $0.02/1M, `-large` $0.13/1M, `ada-002` $0.10/1M). The cost flows through `runtime.trackExecution()` the same way agent-call cost does, counts against `ctx.budget()`, and shows up in Studio's Cost Dashboard under "Memory (Embedder)". See [observability.md](../../docs/observability.md#event-types) for the trace-event shape.

**Custom `Embedder` implementations** (breaking change in 0.15.0 — `embed()` previously returned `Promise<number[][]>`):

```typescript
import type { Embedder, EmbedResult } from '@axlsdk/axl';

class MyEmbedder implements Embedder {
  readonly dimensions = 1536;

  // `signal` is optional but recommended — lets budget hard-stops and user
  // aborts cancel in-flight embedder fetches mid-retry.
  async embed(texts: string[], signal?: AbortSignal): Promise<EmbedResult> {
    const vectors = await myProvider.embed(texts, { signal });
    return { vectors }; // `usage` optional — omit if you don't compute cost
  }
}
```

### Agent Guardrails

Input and output validation at the agent boundary. You define your own validation logic — Axl calls it before and after each LLM turn:

```typescript
// Your validation functions — Axl doesn't ship these, you bring your own
const containsPII = (text: string) => /\b\d{3}-\d{2}-\d{4}\b/.test(text);
const isOffTopic = (text: string) => !text.toLowerCase().includes('support');

const safe = agent({
  model: 'openai-responses:gpt-5.5',
  system: 'You are a helpful assistant.',
  guardrails: {
    input: async (prompt, ctx) => {
      if (containsPII(prompt)) return { block: true, reason: 'PII detected' };
      return { block: false };
    },
    output: async (response, ctx) => {
      if (isOffTopic(response))
        return { block: true, reason: 'Off-topic response' };
      return { block: false };
    },
    onBlock: 'retry', // 'retry' | 'throw' | (reason, ctx) => fallbackResponse
    maxRetries: 2,
  },
});
```

When `onBlock` is `'retry'`, the LLM's blocked output is appended to the conversation (as an assistant message) along with a system message containing the block reason, then the LLM is re-called so it can self-correct. These messages **accumulate** across retries — if the guardrail blocks multiple times, the LLM sees all prior failed attempts and corrections before its next try. All retry messages are ephemeral — they are **not** persisted to session history, so subsequent session turns never see the blocked attempts. Schema retries and validate retries use the same accumulating pattern. Input guardrails always throw since the prompt is user-supplied. Throws `GuardrailError` if retries are exhausted or `onBlock` is `'throw'`.

For **business rule validation** on the parsed typed object (not raw text), use `validate` on `ctx.ask()`:

```typescript
const UserSchema = z.object({
  name: z.string(),
  email: z.string(),
  role: z.enum(['admin', 'editor', 'viewer']),
});

const result = await ctx.ask(extractAgent, 'Extract user from this text', {
  schema: UserSchema,
  validate: (user) => {
    if (user.role === 'admin' && !user.email.endsWith('@company.com')) {
      return { valid: false, reason: 'Admin users must have a company email' };
    }
    return { valid: true };
  },
});
```

`validate` is per-call, co-located with the `schema` it validates. It runs **after** schema parsing succeeds, receiving the fully typed object. On failure, the LLM sees all previous attempts (accumulating context) and the validation reason. Requires `schema` — without it, validate is skipped (use guardrails for raw text). Throws `ValidationError` after retries are exhausted. Also supported on `ctx.delegate()`, `ctx.race()`, and `ctx.verify()`.

### State Stores

Three built-in implementations persist workflow checkpoints, pending `awaitHuman` requests, session history, memory entries, execution history, and eval history. Pending approval requests remain visible after process loss, but their workflow continuation is in-process only; use an application-owned durable command/idempotency protocol for cross-process approval. Cancellation compensation is serialized with public resolution. If compensation fails, the request stays visible and the runtime emits `decision_cleanup_failed` for operator retry or total deletion.

**Memory** (default) — in-process, no persistence. Use for development and stateless workflows.

```typescript
const runtime = new AxlRuntime();
```

**SQLite** — file-based persistence. Use for single-process deployments that need durable state across restarts.

```bash
npm install better-sqlite3
```

```typescript
const runtime = new AxlRuntime({
  state: { store: 'sqlite', sqlite: { path: './data/axl.db' } },
});
```

**Redis** — shared state across multiple processes. Use for multi-replica deployments or any setup where more than one process runs `AxlRuntime`.

```bash
npm install redis
```

```typescript
import { AxlRuntime, RedisStore } from '@axlsdk/axl';

const store = await RedisStore.create('redis://localhost:6379');
const runtime = new AxlRuntime({ state: { store } });

// Graceful shutdown — closes the Redis connection
await runtime.shutdown();
```

`RedisStore.create()` connects before returning, so any connection error surfaces at startup rather than on first use. The runtime's `shutdown()` closes the connection automatically.

Pass an options object instead of a URL string to set a custom `keyPrefix` (default `'axl:'`) — useful when multiple Axl deployments share a Redis cluster — or to configure TTLs:

```typescript
const store = await RedisStore.create({
  url: 'redis://localhost:6379',
  keyPrefix: 'axl:prod:', // staging would use 'axl:staging:'
  defaultTtl: 60 * 60 * 24 * 30, // 30 days for everything
  ttls: {
    checkpoint: 60 * 60 * 24 * 7,  // shorter for checkpoints
    sessionMeta: null,             // explicit opt-out
  },
});
```

The prefix is concatenated as-given — no normalization. Include a trailing colon if you want one. Empty string is rejected.

**TTLs are strongly recommended in production** — without them every `save*` accumulates forever and Redis eventually OOMs. Sliding window: `memory`, `session`, `sessionMeta` (every write refreshes; reads do NOT). Fixed-creation: `checkpoint`, `streamingEvents`. Fixed-refresh: `executionState`, `executionHistory`, `evalHistory`. `streamingEvents` is opt-in only (does NOT fall back to `defaultTtl`). See [api-reference.md](../../docs/api-reference.md#redisstore-options) for the full table.

#### Crash survival: `state.persist: 'streaming'`

Opt-in mode that flushes events to the configured store throughout a run, so a mid-execution crash leaves a recoverable trace.

```typescript
const runtime = new AxlRuntime({
  state: {
    store: await RedisStore.create(redisUrl),
    persist: 'streaming',          // default 'terminal' (back-compat)
    streamingBatchSize: 100,       // events per flush trigger
    streamingBatchInterval: 1000,  // ms
  },
});

// Boot sequence: lazy-load THEN recover THEN accept new work
await runtime.getExecutions();
const recovered = await runtime.recoverIncompleteStreams();
console.log(`Recovered ${recovered.length} crashed executions`);
app.listen(3000);
```

Excluded events (never flushed): `token`, `partial_object`, `string_delta` — reconstructable from `agent_call_end.data.response`. Scope: `runtime.execute()` and `runtime.stream()` only — `createContext()` flows are deliberately excluded (no terminal finalize path).

Synthesized recovered executions carry `status: 'failed'`, `error: 'process terminated (recovered from streaming buffer)'`, and `observation: { complete: false, reason: 'process_interrupted' }`; `workflow` is `__axl/recovered` when no `workflow_start` was captured. Events are bounded by `state.maxEventsPerExecution`. SQLite does not implement streaming methods — the runtime warns and falls back to terminal mode.

See [docs/migration/state-store-durability.md](../../docs/migration/state-store-durability.md) for the full design.

#### Execution lifecycle: `runtime.deleteExecution(id)`

GDPR right-to-be-forgotten. One call sweeps every per-execution surface (data + indexes + checkpoints + suspended state + streaming buffer + pending decisions) and emits an `execution_deleted` audit event.

```typescript
await runtime.deleteExecution(executionId);

runtime.on('execution_deleted', (e) => {
  // e: { executionId, wasActive, hadPendingDecision, removed }
  auditLog.write({ event: 'execution.deleted', ...e });
});

runtime.on('decision_cleanup_failed', (e) => {
  opsAlerts.write({ event: 'approval.cleanup_failed', ...e });
});
```

If the execution is still running, the workflow is aborted (and a paused `ctx.awaitHuman()` correctly wakes with `AbortError` — fixed in 0.17.7). The resurrection guard ensures the workflow's eventual `workflow_end` doesn't re-create the row. Deletion waits for any in-process approval resolution or cancellation compensation before the store sweep. Custom stores must make `resolveDecision` idempotent and implement the complete execution-scoped sweep in `deleteExecution`.

`ExecutionInfo.metadata` round-trips from `ExecuteOptions.metadata` (`userId`, `tenantId`, etc.) — queryable via `runtime.getExecutions().filter(...)`. Internal session control-plane keys (`sessionHistory`, `sessionId`) are stripped before persistence; they remain available via `ctx.metadata` for dynamic selectors.

### Session Options

```typescript
const session = runtime.session('user-123', {
  history: {
    maxMessages: 100,
    summarize: true,
    summaryModel: 'openai-responses:gpt-5-mini',
  },
  persist: true,
});
```

When `maxMessages` is exceeded:

- **`summarize: false`** (default) — oldest messages beyond the limit are dropped. Only the most recent `maxMessages` are kept.
- **`summarize: true`** — before dropping, the overflow messages are sent to `summaryModel` for summarization. The summary is saved to session metadata and included as context on subsequent turns. Each time the limit is exceeded again, the new overflow is summarized together with the previous summary, so context accumulates incrementally.

| Option                 | Type      | Default   | Description                                                   |
| ---------------------- | --------- | --------- | ------------------------------------------------------------- |
| `history.maxMessages`  | `number`  | unlimited | Max messages to retain in history                             |
| `history.summarize`    | `boolean` | `false`   | Summarize overflow messages instead of dropping them           |
| `history.summaryModel` | `string`  | —         | Model URI for summarization (required when `summarize: true`) |
| `persist`              | `boolean` | `true`    | Persist history to StateStore                                 |

### Error Hierarchy

```typescript
import {
  AxlError, // Base class
  VerifyError, // Schema validation failed after retries
  QuorumNotMet, // Quorum threshold not reached
  NoConsensus, // Vote could not reach consensus
  TimeoutError, // Operation exceeded timeout
  MaxTurnsError, // Agent exceeded max tool-calling turns
  BudgetExceededError, // Budget limit exceeded
  GuardrailError, // Guardrail blocked input or output
  ValidationError, // Post-schema business rule validation failed after retries
} from '@axlsdk/axl';
```

### Provider URIs

Four native adapters using the `provider:model` URI scheme (plus the OpenAI-compatible presets above):

```
openai-responses:gpt-5.5               # OpenAI Responses API (preferred over Chat Completions)
openai:gpt-5.4                         # OpenAI Chat Completions
anthropic:claude-opus-4-8              # Anthropic (supports effort: 'xhigh' and 'max')
google:gemini-3.1-pro-preview          # Google Gemini
```

See [docs/providers.md](../../docs/providers.md) for the full model list including reasoning models.

### Completed-file transcription

Use `ctx.transcribe()` for finite recordings, then explicitly pass
`Transcript.text` to an agent if analysis is needed. It is separate from chat
history and chat providers. OpenAI and Gemini use their documented model
contracts; any nonblank `openrouter-transcription:<vendor/model>` URI can
dispatch supported bytes/base64 to OpenRouter, where the selected model/route
decides endpoint compatibility. See [Multimodal input](../../docs/multimodal-input.md)
for the 25 MiB inline bound, source types, options, transcript redaction,
temporary Gemini Files cleanup, and live-verification commands.

## License

[Apache 2.0](../../LICENSE)
