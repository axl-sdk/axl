# Axl

TypeScript SDK for orchestrating agentic systems. Treats concurrency, structured output, uncertainty, and cost as first-class primitives.

```typescript
import { tool, agent, workflow, AxlRuntime } from '@axlsdk/axl';
import { z } from 'zod';

const searchTool = tool({
  name: 'search',
  description: 'Search the web',
  input: z.object({ query: z.string() }),
  handler: async ({ query }) => fetch(`https://api.search.com?q=${query}`).then(r => r.json()),
});

const researcher = agent({
  model: 'openai:gpt-4o',
  system: 'You are a research assistant. Use the search tool to find information.',
  tools: [searchTool],
  effort: 'high',
});

const researchWorkflow = workflow({
  name: 'research',
  input: z.object({ topic: z.string() }),
  handler: async (ctx) => ctx.ask(researcher, `Research: ${ctx.input.topic}`),
});

const runtime = new AxlRuntime();
runtime.register(researchWorkflow);
const result = await runtime.execute('research', { topic: 'TypeScript SDKs' });
```

## Why Axl

Most LLM frameworks treat agents as sequential pipelines — one model call, one tool call, one response. But real agentic systems need concurrency, consensus, cost control, and human oversight. Axl makes these first-class primitives:

1. **Concurrency is Default.** Agents run in parallel (`spawn`). Sequential execution is the exception.
2. **Probabilistic Control Flow.** LLM output is uncertain. `verify` replaces manual retry loops with self-correcting validation.
3. **Structured Output.** Agents return typed objects, not raw strings. Zod schemas enforce structure at the boundary.
4. **Trust is a Primitive.** Consensus (`vote`) and verification are built-in, not patterns you reinvent per project.
5. **Resource Awareness.** Budgeting (`budget`) and timeouts are first-class APIs, not afterthoughts.
6. **Brownfield Native.** Axl is a library, not a replacement. It embeds directly in your existing TypeScript/Node.js backend with zero infrastructure.

Every agentic primitive is a TypeScript function on `ctx`. The type safety comes from TypeScript + Zod. IDE support (autocomplete, go-to-definition, refactoring) comes free. No DSL to learn, no compiler to debug, no graph to draw.

## Features

- **Tools** with Zod validation, retry policies, and sensitive output redaction
- **Agents** with dynamic model/system selection, tool binding, and handoffs
- **Workflows** as named async functions with typed input/output schemas
- **Concurrency primitives**: `spawn`, `race`, `parallel`, `map` with quorum support
- **Consensus**: `vote` with majority, unanimous, highest/lowest, mean, median, and custom strategies
- **Schema enforcement**: `verify` with self-correcting retry and fallback
- **Cost control**: `budget` with warn, finish_and_stop, and hard_stop policies
- **Human-in-the-loop**: `awaitHuman` for suspension and resume
- **Durable execution**: `checkpoint` with checkpoint-replay semantics
- **Streaming**: `AxlStream` (Readable + AsyncIterable + EventEmitter)
- **Sessions**: Multi-turn conversations with fork and persistent history
- **Providers**: OpenAI (Chat Completions + Responses API), Anthropic, and Google Gemini adapters (raw fetch, zero SDK dependencies)
- **Effort**: Unified `effort` parameter (`'none' | 'low' | 'medium' | 'high' | 'max'`) — controls reasoning depth identically across OpenAI, Anthropic, and Gemini. Advanced: `thinkingBudget` for precise token control, `includeThoughts` for reasoning summaries
- **MCP**: Model Context Protocol support with stdio and HTTP transports
- **Context window management**: Automatic summarization when history exceeds limits
- **OpenTelemetry**: Automatic span emission for all primitives with cost-per-span attribution
- **Memory**: Working memory (`ctx.remember`/`ctx.recall`/`ctx.forget`) and semantic recall via vector stores
- **Guardrails**: Input/output validation at the agent boundary with retry, throw, or custom policies
- **Tool middleware**: Approval gates (`requireApproval`) and lifecycle hooks (`before`/`after`) on tools
- **Handoff modes**: Oneway (conversation transfer) and roundtrip (delegate-and-return) agent handoffs
- **Session options**: Configurable history limits, summarization, and persistence

## How Axl Compares

Axl competes primarily with [Mastra](https://mastra.ai) and [LangGraph.js](https://github.com/langchain-ai/langgraphjs) in the TypeScript agent framework space. Here's an honest comparison:

| | Axl | Mastra | LangGraph.js |
|---|---|---|---|
| **Workflow style** | Plain async functions with `ctx.*` | Step chain (`.then().branch().parallel()`) | Explicit graph (`addNode`, `addEdge`) |
| **Concurrency** | `spawn`, `race`, `parallel`, `map` with quorum | `.parallel()`, `.foreach()` | `Send` API (fan-out) |
| **Consensus / voting** | `vote` (7 strategies), `verify` | — | — |
| **Cost control** | `budget` with hard_stop / finish_and_stop / warn | Token reporting only | — |
| **Structured output** | Zod schema on `ctx.ask()` + self-correcting retry | Zod via Vercel AI SDK | `withStructuredOutput()` |
| **Human-in-the-loop** | `awaitHuman` + tool approval gates | Tool suspend/resume, `requireApproval` | `interrupt()` + `Command` |
| **Testing utilities** | `MockProvider`, `MockTool`, `AxlTestRuntime` | — | — |
| **Evaluation** | `dataset`, `scorer`, `llmScorer`, `evalCompare`, CLI | Built-in scorers (`@mastra/evals`) | Via LangSmith (external) |
| **Agent handoffs** | `handoffs` with ACL isolation, oneway + roundtrip | Sub-agents as tools | Subgraphs as nodes |
| **Memory** | Working memory + semantic recall (vector stores) | Working memory + semantic recall + observational (auto-compression) | Checkpointer-based |
| **Observability** | OpenTelemetry with cost-per-span | OpenTelemetry built-in | LangSmith integration |
| **Streaming** | `AxlStream` (Readable + AsyncIterable) | Via Vercel AI SDK | Multiple modes |
| **Local dev UI** | Axl Studio | Mastra Studio | LangGraph Studio |
| **Deployment** | Manual | One-command (Vercel, CF, Netlify) | LangGraph Platform |
| **Dependencies** | Zero (raw `fetch`) | Vercel AI SDK | `@langchain/core` ecosystem |
| **Durable execution** | `checkpoint` (checkpoint-replay) | Workflow suspend/resume | Checkpointers (every superstep) |

**Where Axl shines:** Concurrency primitives, consensus/voting, cost control, testing story, zero dependencies, and imperative workflow style (plain TypeScript, no DSL).

**Where others are ahead:** Mastra has more vector store adapters, observational memory (auto-compression), and one-command deployment. LangGraph has more mature durable execution and a larger Python ecosystem. Both have more established communities.

## Installation

```bash
npm install @axlsdk/axl zod
```

Optional peer dependencies:

```bash
npm install better-sqlite3                          # SQLite state store
npm install ioredis                                  # Redis state store
npm install @opentelemetry/api                       # OpenTelemetry spans
npm install @opentelemetry/exporter-trace-otlp-http  # OTel HTTP exporter
```

## Packages

| Package | Description |
|---------|-------------|
| [`@axlsdk/axl`](./packages/axl) | Core SDK: tools, agents, workflows, runtime, providers, state stores |
| [`@axlsdk/testing`](./packages/axl-testing) | Test utilities: MockProvider, MockTool, AxlTestRuntime |
| [`@axlsdk/eval`](./packages/axl-eval) | Evaluation framework: datasets, scorers, LLM-as-judge, CLI |
| [`@axlsdk/studio`](./packages/axl-studio) | Local development UI: Hono server + React SPA for debugging agents and workflows |

## Quick Start

### Define Tools

```typescript
import { tool } from '@axlsdk/axl';
import { z } from 'zod';

const calculator = tool({
  name: 'calculator',
  description: 'Evaluate arithmetic expressions',
  input: z.object({ expression: z.string() }),
  handler: ({ expression }) => ({ result: eval(expression) }),
});
```

### Define Agents

```typescript
import { agent } from '@axlsdk/axl';

const mathAgent = agent({
  model: 'openai:gpt-4o',
  system: 'You are a math assistant. Use the calculator for all arithmetic.',
  tools: [calculator],
  effort: 'high',   // portable across all providers: maps to reasoning_effort (OpenAI), budget_tokens (Anthropic), thinkingBudget (Gemini)
});
```

### Orchestrate with Workflows

```typescript
import { workflow, AxlRuntime } from '@axlsdk/axl';
import { z } from 'zod';

const pipeline = workflow({
  name: 'math-pipeline',
  input: z.object({ question: z.string() }),
  output: z.object({ answer: z.number() }),
  handler: async (ctx) => {
    // Run 3 agents in parallel — each gets the same question independently
    const results = await ctx.spawn(3, async () =>
      ctx.ask(mathAgent, ctx.input.question, {
        schema: z.object({ answer: z.number() }),
      })
    );
    // Pick the answer that appeared most often across the 3 responses
    return ctx.vote(results, { strategy: 'majority', key: 'answer' });
  },
});

const runtime = new AxlRuntime();
runtime.register(pipeline);
const result = await runtime.execute('math-pipeline', { question: 'What is 42 * 17?' });
```

### Stream Responses

```typescript
const stream = runtime.stream('math-pipeline', { question: 'What is 42 * 17?' });

for await (const event of stream) {
  if (event.type === 'token') process.stdout.write(event.data);
  if (event.type === 'tool_call') console.log(`Tool: ${event.name}`);
}

const result = await stream.promise;
```

### Budget and Cost Control

```typescript
const controlled = workflow({
  name: 'budget-controlled',
  input: z.object({ task: z.string() }),
  handler: async (ctx) => {
    return ctx.budget({ cost: '$0.50', onExceed: 'hard_stop' }, async () => {
      return ctx.ask(researcher, ctx.input.task);
    });
  },
});
```

### Agent Handoffs

```typescript
const specialist = agent({
  name: 'specialist',
  model: 'anthropic:claude-sonnet-4-5',
  system: 'You are a domain expert.',
  tools: [calculator],
});

const router = agent({
  name: 'router',
  model: 'openai:gpt-4o',
  system: 'Route questions to the specialist.',
  handoffs: [{ agent: specialist }],  // default mode: 'oneway' — transfers conversation
});

// Roundtrip handoff — delegate and return result to the source agent
const researcher = agent({
  name: 'researcher',
  model: 'openai:gpt-4o',
  system: 'You research topics thoroughly.',
  tools: [searchTool],
});

const coordinator = agent({
  name: 'coordinator',
  model: 'openai:gpt-4o',
  system: 'You coordinate research tasks.',
  handoffs: [
    { agent: researcher, description: 'Research a topic', mode: 'roundtrip' },
  ],
});
```

### Tool Middleware & Approval Gates

```typescript
const dangerousTool = tool({
  name: 'delete_record',
  description: 'Delete a database record',
  input: z.object({ id: z.string() }),
  handler: async ({ id }) => db.delete(id),
  requireApproval: true,
  hooks: {
    before: async (input, ctx) => {
      ctx.log('delete_attempt', { id: input.id });
      return input;
    },
  },
});
```

### OpenTelemetry Observability

Every `ctx.*` primitive emits OTel spans with cost-per-span attribution:

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

Spans: `workflow.execute`, `agent.ask`, `tool.call`, `ctx.spawn`, `ctx.race`, `ctx.vote`, `ctx.budget`, `ctx.awaitHuman`. Zero overhead when disabled (NoopSpanManager).

### Memory Primitives

```typescript
// Working memory — persists across turns
await ctx.remember('user-preferences', { theme: 'dark', lang: 'en' });
const prefs = await ctx.recall('user-preferences');
await ctx.forget('user-preferences');

// Semantic recall — requires vector store configured on runtime
const relevant = await ctx.recall('past-conversations', {
  query: 'shipping policy',
  topK: 3,
});
```

### Agent Guardrails

```typescript
// You define your own validation logic — Axl calls it at the agent boundary
const containsPII = (text: string) => /\b\d{3}-\d{2}-\d{4}\b/.test(text);
const isOffTopic = (text: string) => !text.toLowerCase().includes('support');

const safe = agent({
  model: 'openai:gpt-4o',
  system: 'You are a helpful assistant.',
  guardrails: {
    input: async (prompt) => {
      if (containsPII(prompt)) return { block: true, reason: 'PII detected' };
      return { block: false };
    },
    output: async (response) => {
      if (isOffTopic(response)) return { block: true, reason: 'Off-topic' };
      return { block: false };
    },
    onBlock: 'retry',   // blocked responses are retried with the reason sent to the LLM
    maxRetries: 2,
  },
});
```

### Session Options

```typescript
const session = runtime.session('user-123', {
  history: {
    maxMessages: 100,       // keep last 100 messages; older ones are trimmed
    summarize: true,         // summarize trimmed messages instead of dropping them
    summaryModel: 'openai:gpt-4o-mini',  // model used to generate the summary
  },
  persist: true,             // save session history to the state store (default: true)
});
```

### Testing

```typescript
import { AxlTestRuntime, MockProvider } from '@axlsdk/testing';

const runtime = new AxlTestRuntime();
runtime.register(myWorkflow);
runtime.mockProvider('openai', MockProvider.sequence([
  { content: 'Hello!' },
  { content: 'World!' },
]));

const result = await runtime.execute('my-workflow', { query: 'Hi' });
expect(runtime.agentCalls()).toHaveLength(1);
```

### Evaluation

```typescript
import { dataset, scorer, runEval } from '@axlsdk/eval';
import { z } from 'zod';

const ds = dataset({
  name: 'math-test',
  schema: z.object({ question: z.string() }),
  annotations: z.object({ answer: z.number() }),
  items: [
    { input: { question: '2+2' }, annotations: { answer: 4 } },
    { input: { question: '3*5' }, annotations: { answer: 15 } },
  ],
});

const exactMatch = scorer({
  name: 'exact',
  description: 'Check if the answer matches exactly',
  score: (output, input, annotations) => output.answer === annotations?.answer ? 1 : 0,
});

// Runs each dataset item through your workflow and scores the output
const results = await runEval(
  {
    workflow: 'math-pipeline',  // label stored in results for comparison
    dataset: ds,
    scorers: [exactMatch],
  },
  async (input) => {
    const output = await runtime.execute('math-pipeline', input);
    return { output };
  },
);
```

## Configuration

```typescript
import { defineConfig } from '@axlsdk/axl';

export default defineConfig({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY },
    // openai-responses shares the openai config by default
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    google: { apiKey: process.env.GOOGLE_API_KEY },
  },
  state: { store: 'sqlite', sqlite: { path: './data/axl.db' } },
  trace: { enabled: true, output: 'console', level: 'steps' },
  telemetry: {
    enabled: true,
    serviceName: 'my-app',
    // tracerProvider: yourConfiguredTracerProvider,
  },
});
```

## Context Primitives

All agentic primitives are available on the `WorkflowContext` (`ctx`). See the [API Reference](./docs/api-reference.md) for complete option types, valid values, and defaults.

| Primitive | Description |
|-----------|-------------|
| `ctx.ask(agent, prompt, options?)` | Invoke an agent with optional schema validation |
| `ctx.spawn(n, fn, options?)` | Run N concurrent tasks; with `quorum`, resolve as soon as enough succeed and cancel the rest |
| `ctx.vote(results, options)` | Pick a winner from spawn/map results — 7 strategies: majority, unanimous, highest, lowest, mean, median, custom. Supports `scorer` for LLM-as-judge and `reducer` for custom aggregation. See [vote reference](./docs/use-cases.md#vote-strategy-reference) |
| `ctx.verify(fn, schema, options?)` | Self-correcting schema validation |
| `ctx.budget(options, fn)` | Cost-bounded execution |
| `ctx.race(fns, options?)` | First-to-complete with schema validation |
| `ctx.parallel(fns)` | Run independent tasks concurrently |
| `ctx.map(items, fn, options?)` | Map with bounded concurrency; with `quorum`, succeed when enough items complete |
| `ctx.awaitHuman(options)` | Suspend for human decision |
| `ctx.checkpoint(fn)` | Durable execution with replay |
| `ctx.remember(key, value, options?)` | Store working memory |
| `ctx.recall(key, options?)` | Retrieve memory or semantic search |
| `ctx.forget(key, options?)` | Delete memory entry |
| `ctx.log(event, data?)` | Structured trace event |

## Provider URI Format

Agents reference models using the `provider:model` URI scheme:

```typescript
'openai:gpt-4o'                // OpenAI Chat Completions
'openai-responses:gpt-4o'      // OpenAI Responses API
'anthropic:claude-sonnet-4-5'  // Anthropic
'google:gemini-2.5-pro'        // Google Gemini
```

Four built-in providers with support for all current models including reasoning models (o1/o3/o4-mini). See [docs/providers.md](./docs/providers.md) for the full model list.

## Documentation

| Guide | Description |
|-------|-------------|
| [Architecture](./docs/architecture.md) | System architecture, deployment modes, and execution flow |
| [Use Cases](./docs/use-cases.md) | Real-world examples: support bots, consensus, budget control, handoffs, batch processing |
| [Security](./docs/security.md) | Tool ACL, input sanitization, prompt injection mitigations, secrets handling |
| [Testing](./docs/testing.md) | MockProvider, AxlTestRuntime, snapshot testing, assertion helpers |
| [Observability](./docs/observability.md) | Trace modes, OpenTelemetry integration, cost-per-span attribution |
| [Integration](./docs/integration.md) | Express.js integration, Axl Studio setup, local development workflow |
| [Providers](./docs/providers.md) | Full provider URI reference with all supported models |
| [Roadmap](./ROADMAP.md) | What's planned for Axl |

## Requirements

- Node.js >= 20.0.0
- TypeScript >= 5.7 (recommended)

## License

[Apache 2.0](./LICENSE)
