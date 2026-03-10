# Axl Roadmap

> Last updated: March 2026
>
> See also: [Competitive Analysis](./competitive-analysis.md)

This roadmap is informed by a competitive analysis of Mastra and LangChain/LangGraph. It focuses on closing gaps that matter for production adoption while preserving Axl's core DX advantages: functional factories, imperative `ctx.*` surface, zero dependencies, and first-class concurrency/uncertainty/cost primitives.

---

## Guiding Principles

1. **Keep the imperative `ctx.*` surface.** This is the DX moat. Don't introduce graph DSLs or builder chains.
2. **Stay zero-dependency for core.** Raw `fetch` providers are a strength. New capabilities (vector stores, OTel) should be optional peer deps.
3. **Primitives over platforms.** Ship composable building blocks, not an all-in-one framework. Let developers choose their own deployment, storage, and infrastructure.
4. **Prove it with tests.** Axl's testing story is already a differentiator. Every new feature should be testable with `AxlTestRuntime`.

---

## Tier 1: Production Table Stakes — Complete

These close the gaps that block production adoption. Without them, teams choose Mastra or LangGraph by default. **All Tier 1 items are now implemented.**

### 1.1 Observability via OpenTelemetry — **Status: Implemented**

**Gap**: Mastra ships OTel built-in. LangGraph has LangSmith. Axl has `ctx.log()` only.

**What to build**: Automatic OTel span emission for every `ctx.*` primitive. Zero-config with optional exporter.

```typescript
const runtime = new AxlRuntime({
  telemetry: {
    serviceName: 'my-app',
    tracerProvider: provider, // Your configured TracerProvider instance
  },
});
```

**Span model**:

| Span | Attributes |
|------|------------|
| `axl.workflow.execute` | workflow name, input hash, duration, total cost |
| `axl.agent.ask` | agent name, model, prompt tokens, completion tokens, cost, cached tokens |
| `axl.tool.call` | tool name, duration, success/error |
| `axl.ctx.spawn` | count, quorum, completed, cancelled |
| `axl.ctx.race` | participant count, winner |
| `axl.ctx.vote` | strategy, result, scores |
| `axl.ctx.budget` | limit, spent, policy, exceeded |
| `axl.checkpoint.hit` / `axl.checkpoint.miss` (span events) | checkpoint step |
| `axl.ctx.awaitHuman` | channel, wait duration |

**Unique advantage**: No competing framework emits **cost-per-span**. Axl already tracks cost, so this comes for free and is immediately valuable for cost attribution in multi-agent systems.

**Implementation notes**:

- `@opentelemetry/api` as an optional peer dependency
- If no exporter configured, zero overhead (no-op)
- Spans nest naturally: workflow > ask > tool calls
- `ctx.log()` events attach as span events

---

### 1.2 Memory Primitives — **Status: Implemented**

**Gap**: Mastra has a 4-tier memory system. Axl has `StateStore` but no memory abstraction for agents.

**What to build**: Composable memory as `ctx.*` primitives, not a monolithic memory subsystem. Three capabilities, each independently usable:

#### Working Memory (structured state across turns)

```typescript
// Inside a workflow handler:
await ctx.remember('user-preferences', { theme: 'dark', lang: 'en' });
const prefs = await ctx.recall('user-preferences');

// Scoped to session by default, or explicitly:
await ctx.remember('user-preferences', data, { scope: 'global' });
```

Backed by the existing `StateStore` interface (MemoryStore, SQLiteStore, RedisStore).

#### Semantic Recall (vector-based retrieval)

```typescript
// Configure at runtime level:
const runtime = new AxlRuntime({
  memory: {
    vector: new PgVectorStore({ connectionString: '...' }),
    embedder: { model: 'openai:text-embedding-3-small' },
  },
});

// Use in workflows:
const relevant = await ctx.recall('past-conversations', {
  query: 'shipping policy',
  topK: 3,
});
```

Start with 2-3 vector store adapters (pgvector, SQLite vec, in-memory) as optional peer deps. Don't chase Mastra's 17 — focus on the ones most developers actually use.

#### Conversation History Management

Extend the existing `Session` class with configurable history strategies:

```typescript
const session = runtime.session('user-123', {
  history: {
    maxMessages: 100,
    summarize: true,                        // auto-summarize old messages before trimming
    summaryModel: 'openai:gpt-4o-mini',     // model used for summarization
  },
  persist: true,                            // persist to StateStore (default: true)
});
```

**What NOT to build (yet)**: Observational Memory (Mastra's Observer/Reflector pattern). It's novel but complex. Better to ship the foundation (working memory + semantic recall) first, then layer it on as a higher-level recipe.

---

### 1.3 Agent Guardrails — **Status: Implemented**

**Gap**: Mastra has "tripwire" workflow status. LangGraph has routing-based validation. Axl has `ctx.verify()` for output validation but no declarative agent-level guardrails.

**What to build**: Input and output validation at the agent boundary.

```typescript
const supportAgent = agent({
  name: 'customer-support',
  model: 'openai:gpt-4o',
  system: 'You are a helpful support agent.',
  guardrails: {
    input: async (prompt, ctx) => {
      if (containsPII(prompt)) return { block: true, reason: 'PII detected' };
      return { block: false };
    },
    output: async (response, ctx) => {
      if (containsHallucination(response)) return { block: true, reason: 'Hallucination detected' };
      return { block: false };
    },
    onBlock: 'retry',  // 'retry' | 'throw' | (reason, ctx) => fallbackResponse
    maxRetries: 2,
  },
});
```

**Design decisions**:

- Guardrails run synchronously in the ask() loop, before/after each LLM call
- On block with `'retry'`, the LLM sees the block reason and its previous output (same self-correcting pattern as `ctx.verify()`)
- Guardrails compose: agent-level + workflow-level via `ctx.verify()`
- Emit OTel spans for guardrail checks (pass/block/retry)

---

## Tier 2: DX Differentiation — Complete

These make Axl meaningfully better to use than competitors, beyond just closing gaps.

### Prep: Pre-Tier-2 Fixes — **Status: Implemented**

Before building new features, address gaps in the existing implementation:

- **Handoff OTel span**: `axl.agent.handoff` span wraps handoff execution with `source`, `target`, and `duration` attributes.
- **Handoff type (breaking change)**: `handoffs?: HandoffDescriptor[]` where `HandoffDescriptor = { agent: Agent; description?: string }`. The object form enables Tier 2 handoff improvements (descriptions surfaced to LLM).
- **Stream event types**: `StreamEvent` expanded with `agent_start`, `agent_end`, `tool_result`, `handoff`. New `stream.steps` getter filters to structural events. `onAgentStart` callback emits `agent_start` before each LLM call; trace events mapped to typed `agent_end`, `tool_result`, `handoff` events in `stream()`.

---

### 2.1 Tool Middleware and Approval Gates — **Status: Implemented**

**Inspiration**: Mastra's `requireApproval`, tool lifecycle hooks. LangGraph's `interrupt()` inside tools.

**What to build**: A unified hook system on tools, with `requireApproval` as sugar that compiles to a built-in `before` hook.

```typescript
const deleteTool = tool({
  name: 'delete-record',
  description: 'Delete a database record',
  input: z.object({ id: z.string() }),
  handler: async ({ id }) => db.delete(id),
  // Approval gate — sugar for a built-in before hook that calls ctx.awaitHuman()
  requireApproval: true,
  // Custom hooks — run in addition to requireApproval (before runs after approval)
  hooks: {
    before: async (input, ctx) => {
      ctx.log('tool.delete.attempt', { id: input.id });
      return input;  // return modified input, or throw to block
    },
    after: async (output, ctx) => {
      ctx.log('tool.delete.success', output);
      return output;  // return modified output
    },
  },
});
```

**Design decisions**:

- `requireApproval: true` compiles to a `before` hook that calls `ctx.awaitHuman()` with tool name and input as the approval prompt. On denial, emits `tool_denied` trace event and throws `ToolDenied`.
- User-defined `hooks.before` runs after the approval gate (if both are present).
- `hooks.after` runs after the handler, before the result is returned to the agent.
- Hook execution order: approval gate → `hooks.before` → handler → `hooks.after`.
- Hooks receive `(input/output, ctx)` where `ctx` is the `WorkflowContext`, enabling logging, budget checks, and other `ctx.*` primitives.
- OTel spans: `axl.tool.approval` (for approval gate), existing `axl.tool.call` (for execution).
- This reuses existing `ctx.awaitHuman()` infrastructure — no new pause/resume mechanism.

---

### 2.2 Agent Handoff Improvements — **Status: Implemented**

**Current state**: Axl has `handoffs: [{ agent }]` in the agent config (object form after prep work).

**What to build**: Make handoffs observable, descriptive, and controllable.

```typescript
const triage = agent({
  name: 'triage',
  model: 'openai:gpt-4o-mini',
  system: 'Route the user to the right specialist.',
  handoffs: [
    { agent: billingAgent, description: 'Billing and payment questions' },
    { agent: technicalAgent, description: 'Technical support and debugging' },
    { agent: generalAgent, description: 'General inquiries' },
  ],
});
```

Key additions:

- Handoff `description` surfaced to the LLM in the tool definition for better routing decisions
- `axl.agent.handoff` OTel span (added in prep) with attributes: source agent, target agent, duration, cost
- Handoff history accessible in sessions (`session.handoffs()`)
- Configurable handoff policies: `oneway` (conversation transfers) vs `roundtrip` (delegate and return)

---

### 2.3 Streaming Improvements — **Status: Implemented**

**Gap**: LangGraph offers token-level, node-update-level, and full-state streaming. Axl's `AxlStream` is token-focused.

**What to build**: Expand `StreamEvent` with typed variants and add filtered async iterables on `AxlStream`.

The stream always emits all events. Consumers filter at consumption time via getter methods, consistent with the existing `stream.text` pattern:

```typescript
const stream = runtime.stream('my-workflow', input);

// Token-level (existing behavior)
for await (const chunk of stream.text) {
  process.stdout.write(chunk);
}

// Step-level — typed events per agent turn / tool call / handoff
for await (const event of stream.steps) {
  // event.type: 'agent_start' | 'agent_end' | 'tool_call' | 'tool_result' | 'handoff'
}

// All events — full stream (existing behavior, now with richer types)
for await (const event of stream) {
  // Full StreamEvent union: token | tool_call | tool_result | agent_start | agent_end | handoff | step | done | error
}
```

**Design decisions**:

- No `mode` parameter — always emit everything, filter at consumption. More composable, supports multiple concurrent consumers on the same stream.
- `stream.text` already sets this precedent. Add `stream.steps` (and potentially `stream.tokens`) as filtered async iterables.
- New typed `StreamEvent` variants added in prep work. Each carries structured data (agent name, tool name/args/result, cost, etc.), not raw `TraceEvent` objects.

---

## Tier 3: Ecosystem Growth & Tooling

### 3.1 Axl Studio — Local Development & Debugging UI — **Status: Implemented**

**Gap**: Mastra has Studio. LangGraph has Studio. Axl has nothing. A comprehensive dev UI is table stakes for framework adoption — developers expect to visualize, debug, and test their agents without writing throwaway scripts.

**What to build**: `npx axl studio` — a full-featured local development UI shipped as `packages/axl-studio`.

> **Implementation notes**: See `docs/studio/` for detailed design documents covering all phases. Core AxlRuntime introspection APIs (Phase 0) are implemented. Package scaffold, Hono server, WebSocket infrastructure, React SPA with all 8 panels, and build pipeline are complete.

#### Architecture

```
packages/axl-studio/
  src/
    server/           — Hono HTTP server wrapping AxlRuntime (REST + WebSocket)
    client/           — Vite + React SPA (shadcn/ui + Tailwind)
  dist/
    client/           — Pre-built static assets (shipped with npm package)
  bin/
    axl-studio.ts     — CLI entry point
```

- **Server**: Hono serves the pre-built SPA and exposes a REST API + WebSocket for real-time streaming. Connects to the user's `AxlRuntime` instance (discovered via config file or CLI flags).
- **Client**: React SPA with shadcn/ui components, pre-built at publish time. Zero client-side build step for users — `npx axl studio` just starts the Hono server and opens the browser.
- **Communication**: WebSocket for real-time token streaming, trace events, and live cost updates. REST for CRUD operations (sessions, memory, evals).

#### Features

| Feature | Description |
|---------|-------------|
| **Agent Playground** | Chat with any registered agent. Tool calls rendered inline with expandable input/output. Multi-turn sessions with history. Model/system prompt overrides for quick iteration. |
| **Workflow Runner** | Execute any registered workflow with custom JSON input. Visual execution timeline showing agent calls, tool invocations, handoffs, and branching (spawn/race). |
| **Trace Explorer** | Waterfall view of OTel spans — nested workflow → agent → tool hierarchy. Cost-per-span, token counts, and duration. Filterable by agent, tool, or cost threshold. Like a lightweight Jaeger purpose-built for Axl. |
| **Cost Dashboard** | Per-agent and per-workflow cost tracking. Token usage breakdown (prompt, completion, cached, reasoning). Budget utilization for `ctx.budget()` calls. |
| **Memory Browser** | View all stored memories (session + global scope). Test semantic recall queries against the vector store. Inspect raw embeddings. Create/edit/delete memory entries. |
| **Session Manager** | Browse all sessions with conversation history. Replay sessions step-by-step. View handoff chains. Filter by agent, date, or cost. |
| **Tool Inspector** | List all registered tools with their Zod schemas rendered as forms. Test tools individually with custom input. View approval gates and hook configuration. |
| **Eval Runner** | Run registered evals from the UI. View per-item results with scores and reasoning. Compare two eval runs side-by-side with regression/improvement detection. |

#### Tech Stack Rationale

- **React** — Largest ecosystem for complex data-heavy UIs (trace waterfalls, timelines, comparison views). Maximizes contributor accessibility.
- **shadcn/ui + Tailwind** — Copy-paste components (no runtime dependency). Consistent design system out of the box. Easy to extend.
- **Hono** — Lightweight, fast, WinterCG-compatible. Perfect for a local dev server. Supports WebSocket natively.
- **Vite** — Fast development builds for studio contributors. Production build ships as static assets.

#### What NOT to build

- Visual graph editor or drag-and-drop workflow builder — Axl is imperative, not graph-based
- Full IDE or code editor — developers have their own editors
- Managed cloud deployment — studio is a local debugging tool
- User authentication — local dev only (no auth needed)

---

### 3.2 Configurable Model Parameters — **Status: Implemented**

All `ChatOptions` parameters (`temperature`, `maxTokens`, `thinking`, `reasoningEffort`, `toolChoice`, `stop`) exposed on `AgentConfig` and overridable per-call via `AskOptions`. Merge precedence: AskOptions > AgentConfig > internal defaults (maxTokens: 4096). Shared types `ReasoningEffort`, `ToolChoice`, and `AgentCallInfo` extracted to avoid duplication. `AxlTestRuntime` captures all resolved parameters in `RecordedAgentCall`. Handoffs correctly strip model params so the target agent uses its own config.

Unified `thinking` parameter (`'low'` | `'medium'` | `'high'` | `'max'` or `{ budgetTokens }`) works across all providers: maps to `reasoning_effort` (OpenAI), adaptive/manual thinking modes (Anthropic), `thinkingConfig.thinkingBudget` (Gemini). `'max'` maps to `'xhigh'` on OpenAI, adaptive `effort: 'max'` on Anthropic Opus 4.6 (falls back to manual mode with `budget_tokens: 30000` on other models), and `thinkingBudget: 24576` on Gemini.

---

### 3.3 MCP Server Exposure

**Current state**: Axl can consume MCP tools (client). Should also expose agents and tools as MCP servers.

```typescript
import { mcpServer } from 'axl/mcp';

const server = mcpServer({
  name: 'my-axl-agents',
  agents: [researcher, writer],
  tools: [calculator, webSearch],
  transport: 'stdio',  // or 'http'
});

server.listen();
```

This lets other AI systems (Claude Desktop, Cursor, other frameworks) use Axl agents as tools.

---

### 3.4 Vector Store Adapters

Start with the 3 most common:

| Adapter | Package | Why |
|---------|---------|-----|
| pgvector | `axl-store-pgvector` | Most deployed vector DB in production |
| SQLite vec | Built into `axl` (extend SQLiteStore) | Zero-config local development |
| In-memory | Built into `axl` (extend MemoryStore) | Testing |

Each adapter implements a `VectorStore` interface:

```typescript
interface VectorStore {
  upsert(index: string, items: { id: string; vector: number[]; metadata?: Record<string, unknown> }[]): Promise<void>;
  query(index: string, vector: number[], opts: { topK: number; filter?: Record<string, unknown> }): Promise<VectorResult[]>;
  delete(index: string, ids: string[]): Promise<void>;
}
```

---

### 3.5 Example Recipes / Cookbooks

Real-world examples that showcase Axl's strengths:

| Recipe | Showcases |
|--------|-----------|
| **Multi-agent customer support** | Handoffs, sessions, guardrails, streaming |
| **Cost-controlled research agent** | `ctx.budget()`, `ctx.map()`, `ctx.race()` |
| **Peer review pipeline** | `ctx.spawn()`, `ctx.vote()`, `llmScorer()` |
| **Human-in-the-loop approval workflow** | `ctx.awaitHuman()`, `requireApproval`, `ctx.checkpoint()` |
| **RAG-augmented Q&A** | Semantic recall, vector stores, sessions |
| **Eval-driven prompt iteration** | `dataset()`, `scorer()`, `llmScorer()`, `evalCompare()` |

Each recipe should be a standalone TypeScript file with inline comments, runnable with `npx tsx`.

---

### 3.6 Provider Ecosystem Expansion

Add providers based on demand:

| Provider | URI | Priority |
|----------|-----|----------|
| Ollama (local models) | `ollama:llama3` | High — local dev without API keys |
| AWS Bedrock | `bedrock:anthropic.claude-sonnet-4-5` | Medium — enterprise demand |
| Azure OpenAI | `azure:gpt-4o` | Medium — enterprise demand |
| Groq | `groq:llama3-70b` | Low — speed-focused use cases |
| Mistral | `mistral:mistral-large` | Low |

Each adapter follows the existing pattern: raw `fetch`, implements the `Provider` interface, registered via `ProviderRegistry`.

---

## What We Will NOT Build

These are conscious decisions, not oversights:

| Won't Build | Why |
|-------------|-----|
| **Graph DSL** | Imperative `ctx.*` is the core DX advantage. Explicit graphs are boilerplate-heavy (LangGraph's #1 complaint). |
| **Vercel AI SDK dependency** | Raw fetch keeps the core lean and independent. Mastra inherits Vercel's update cycles and bundle size. |
| **Class hierarchy** | Factory functions (`tool()`, `agent()`, `workflow()`) are the right call. Deep class hierarchies are a top complaint about LangChain. |
| **17 vector store adapters** | Start with 3. Focus on the primitives being excellent, not breadth. |
| **Schema alignment between steps** | Axl's TypeScript inference through `ctx` is more natural than Mastra's `.map()` between every mismatched step pair. |
| **Full IDE / visual editor** | Axl Studio is a debugging and testing tool, not a low-code platform or visual graph editor. |
| **Managed cloud platform** | Axl is a library, not a platform. Deployment is the user's choice. |
| **LCEL / pipe composition** | LLM calls should look like function calls, not pipeline DSLs. |

---

## Sequencing

```
Phase 1 (Tier 1)          Phase 2 (Tier 2)           Phase 3 (Tier 3)
─────────────────          ─────────────────           ─────────────────
OpenTelemetry              Prep fixes (spans, types)   Axl Studio (axl-studio)
Memory primitives          Tool middleware             MCP server exposure
Agent guardrails           Handoff improvements        Vector store adapters
                           Streaming improvements      Example recipes
                                                       Provider expansion
```

Tier 1 is prerequisite for production adoption. Tier 2 improves DX for developers already using Axl. Tier 3 grows the ecosystem and tooling.
