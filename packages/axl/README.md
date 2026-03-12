# axl

Core SDK for orchestrating agentic systems in TypeScript.

## Installation

```bash
npm install @axlsdk/axl zod
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
  model: 'openai:gpt-4o',
  system: 'You are a research assistant.',
  tools: [calculator],
  thinking: 'high',
  maxTurns: 10,
  timeout: '30s',
  temperature: 0.7,
  version: 'v1.2',
});
```

Dynamic model and system prompt selection:

```typescript
const dynamicAgent = agent({
  model: (ctx) => ctx.metadata?.tier === 'premium'
    ? 'openai:gpt-4o'
    : 'openai:gpt-4.1-nano',
  system: (ctx) => `You are a ${ctx.metadata?.role ?? 'general'} assistant.`,
});
```

#### Dynamic Handoffs

`handoffs` accepts a static array or a function for runtime-conditional routing:

```typescript
const router = agent({
  model: 'openai:gpt-4o-mini',
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

#### Thinking (cross-provider reasoning control)

The `thinking` parameter provides a unified way to control reasoning depth across all providers:

```typescript
// Simple levels — works on any provider
const reasoner = agent({
  model: 'anthropic:claude-sonnet-4-5',
  system: 'You are a careful analyst.',
  thinking: 'high',  // 'low' | 'medium' | 'high' | 'max'
});

// Explicit budget (in tokens)
const budgetReasoner = agent({
  model: 'google:gemini-2.5-flash',
  system: 'Think step by step.',
  thinking: { budgetTokens: 5000 },
});

// Per-call override
const result = await reasoner.ask('Analyze this data', { thinking: 'low' });
```

Each provider maps `thinking` to its native API: `reasoning_effort` (OpenAI), `budget_tokens` (Anthropic), `thinkingBudget` (Gemini). See [docs/providers.md](../../docs/providers.md) for the full mapping table.

### `workflow(config)`

Define a named workflow with typed input/output:

```typescript
import { workflow } from '@axlsdk/axl';
import { z } from 'zod';

const myWorkflow = workflow({
  name: 'my-workflow',
  input: z.object({ query: z.string() }),
  output: z.object({ answer: z.string() }),
  handler: async (ctx) => {
    const answer = await ctx.ask(researcher, ctx.input.query);
    return { answer };
  },
});
```

### `AxlRuntime`

Register and execute workflows:

```typescript
import { AxlRuntime } from '@axlsdk/axl';

const runtime = new AxlRuntime();
runtime.register(myWorkflow);

// Execute
const result = await runtime.execute('my-workflow', { query: 'Hello' });

// Stream
const stream = runtime.stream('my-workflow', { query: 'Hello' });
for await (const event of stream) {
  if (event.type === 'token') process.stdout.write(event.data);
}

// Sessions
const session = runtime.session('user-123');
await session.send('my-workflow', { query: 'Hello' });
await session.send('my-workflow', { query: 'Follow-up' });
const history = await session.history();
```

### Context Primitives

All available on `ctx` inside workflow handlers. See the [API Reference](../../docs/api-reference.md) for complete option types, valid values, and defaults.

```typescript
// Invoke an agent
const answer = await ctx.ask(agent, 'prompt', { schema, retries });

// Run 3 agents in parallel — each gets the same question independently
const results = await ctx.spawn(3, async (i) => ctx.ask(agent, prompts[i]));

// Pick the answer that appeared most often (pure aggregation, no LLM involved)
const winner = ctx.vote(results, { strategy: 'majority', key: 'answer' });

// Self-correcting validation
const valid = await ctx.verify(
  async (lastOutput, error) => ctx.ask(agent, prompt),
  schema,
  { retries: 3, fallback: defaultValue },
);

// Cost control
const budgeted = await ctx.budget({ cost: '$1.00', onExceed: 'hard_stop' }, async () => {
  return ctx.ask(agent, prompt);
});

// First to complete
const fastest = await ctx.race([
  () => ctx.ask(agentA, prompt),
  () => ctx.ask(agentB, prompt),
], { schema });

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

// Human-in-the-loop
const decision = await ctx.awaitHuman({
  channel: 'slack',
  prompt: 'Approve this action?',
});

// Durable checkpoint
const value = await ctx.checkpoint(async () => expensiveOperation());
```

### OpenTelemetry Observability

Automatic span emission for every `ctx.*` primitive with cost-per-span attribution. Install `@opentelemetry/api` as an optional peer dependency.

```typescript
import { defineConfig, AxlRuntime } from '@axlsdk/axl';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const tracerProvider = new BasicTracerProvider();
tracerProvider.addSpanProcessor(new SimpleSpanProcessor(
  new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }),
));

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

Working memory backed by the existing `StateStore` interface:

```typescript
// Store and retrieve structured state
await ctx.remember('user-preferences', { theme: 'dark', lang: 'en' });
const prefs = await ctx.recall('user-preferences');
await ctx.forget('user-preferences');

// Scoped to session (default) or global
await ctx.remember('user-profile', data, { scope: 'global' });
const profile = await ctx.recall('user-profile', { scope: 'global' });
```

Semantic recall requires a vector store and embedder configured on the runtime:

```typescript
import { AxlRuntime, InMemoryVectorStore, OpenAIEmbedder } from '@axlsdk/axl';

const runtime = new AxlRuntime({
  memory: {
    vectorStore: new InMemoryVectorStore(),
    embedder: new OpenAIEmbedder({ model: 'text-embedding-3-small' }),
  },
});

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
  model: 'openai:gpt-4o',
  system: 'You are a helpful assistant.',
  guardrails: {
    input: async (prompt, ctx) => {
      if (containsPII(prompt)) return { block: true, reason: 'PII detected' };
      return { block: false };
    },
    output: async (response, ctx) => {
      if (isOffTopic(response)) return { block: true, reason: 'Off-topic response' };
      return { block: false };
    },
    onBlock: 'retry',   // 'retry' | 'throw' | (reason, ctx) => fallbackResponse
    maxRetries: 2,
  },
});
```

When `onBlock` is `'retry'`, the LLM sees the block reason and self-corrects (same pattern as `ctx.verify()`). Throws `GuardrailError` if retries are exhausted or `onBlock` is `'throw'`.

### Session Options

```typescript
const session = runtime.session('user-123', {
  history: {
    maxMessages: 100,          // Trim oldest messages when exceeded
    summarize: true,           // Auto-summarize trimmed messages
    summaryModel: 'openai:gpt-4o-mini',  // Model for summarization
  },
  persist: true,               // Save to StateStore (default: true)
});
```

`SessionOptions` type:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `history.maxMessages` | `number` | unlimited | Max messages to retain |
| `history.summarize` | `boolean` | `false` | Summarize trimmed messages |
| `history.summaryModel` | `string` | — | Model URI for summarization (required when `summarize: true`) |
| `persist` | `boolean` | `true` | Persist history to StateStore |

### Error Hierarchy

```typescript
import {
  AxlError,        // Base class
  VerifyError,     // Schema validation failed after retries
  QuorumNotMet,    // Quorum threshold not reached
  NoConsensus,     // Vote could not reach consensus
  TimeoutError,    // Operation exceeded timeout
  MaxTurnsError,   // Agent exceeded max tool-calling turns
  BudgetExceededError, // Budget limit exceeded
  GuardrailError,  // Guardrail blocked input or output
  ToolDenied,      // Agent tried to call unauthorized tool
} from '@axlsdk/axl';
```

### State Stores

```typescript
import { MemoryStore, SQLiteStore, RedisStore } from '@axlsdk/axl';

// In-memory (default)
const runtime = new AxlRuntime();

// SQLite (requires better-sqlite3)
const runtime = new AxlRuntime({
  state: { store: 'sqlite', sqlite: { path: './data/axl.db' } },
});

// Redis (requires ioredis)
const runtime = new AxlRuntime({
  state: { store: 'redis', redis: { url: 'redis://localhost:6379' } },
});
```

### Provider URIs

Four built-in providers using the `provider:model` URI scheme:

```
openai:gpt-4o                          # OpenAI Chat Completions
openai-responses:gpt-4o                # OpenAI Responses API
anthropic:claude-sonnet-4-5            # Anthropic
google:gemini-2.5-pro                  # Google Gemini
```

See [docs/providers.md](../../docs/providers.md) for the full model list including reasoning models.

## License

[Apache 2.0](../../LICENSE)
