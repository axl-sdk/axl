# @axlsdk/axl

[![npm version](https://img.shields.io/npm/v/@axlsdk/axl)](https://www.npmjs.com/package/@axlsdk/axl)

Core SDK for orchestrating agentic systems in TypeScript. Part of the [Axl](https://github.com/axl-sdk/axl) monorepo.

## Installation

```bash
npm install @axlsdk/axl zod@^4
```

> **Note:** `zod` is a peer dependency — your application and Axl share a single Zod instance. Zod v4 (`^4.0.0`) is required.

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
  model: 'openai-responses:gpt-5.4',
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
});
```

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
  model: 'openai-responses:gpt-5.4',
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
      ? 'openai-responses:gpt-5.4'
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
  model: 'anthropic:claude-opus-4-6',
  system: 'You are a careful analyst.',
  effort: 'high', // 'none' | 'low' | 'medium' | 'high' | 'max'
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
  if (event.type === 'error') console.error('Stream error:', event.message);
  if (event.type === 'done') console.log('Result:', event.data);
}

// Sessions
const session = runtime.session('user-123');
await session.send('my-workflow', { query: 'Hello' });
await session.send('my-workflow', { query: 'Follow-up' });

// Stream a session turn
const sessionStream = await session.stream('my-workflow', { query: 'Hello' });
for await (const event of sessionStream) {
  if (event.type === 'token') process.stdout.write(event.data);
}
```

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

// Durable checkpoint — on first run, executes and saves the result.
// On replay after a restart, returns the saved result without re-executing,
// preventing duplicate side effects (double API calls, double charges, etc.)
const checkpointed = await ctx.checkpoint(async () => expensiveOperation());
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

### Agent Guardrails

Input and output validation at the agent boundary. You define your own validation logic — Axl calls it before and after each LLM turn:

```typescript
// Your validation functions — Axl doesn't ship these, you bring your own
const containsPII = (text: string) => /\b\d{3}-\d{2}-\d{4}\b/.test(text);
const isOffTopic = (text: string) => !text.toLowerCase().includes('support');

const safe = agent({
  model: 'openai-responses:gpt-5.4',
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

Three built-in implementations. All persist the same data: workflow execution checkpoints, `awaitHuman` decisions, session history, memory entries, execution history, eval history, and the execution state needed for suspend/resume.

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
  ToolDenied, // Agent tried to call unauthorized tool
} from '@axlsdk/axl';
```

### Provider URIs

Four built-in providers using the `provider:model` URI scheme:

```
openai-responses:gpt-5.4               # OpenAI Responses API (preferred over Chat Completions)
openai:gpt-5.4                         # OpenAI Chat Completions
anthropic:claude-sonnet-4-6            # Anthropic
google:gemini-3.1-pro-preview          # Google Gemini
```

See [docs/providers.md](../../docs/providers.md) for the full model list including reasoning models.

## License

[Apache 2.0](../../LICENSE)
