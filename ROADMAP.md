# Roadmap

> Last updated: April 2026

## Guiding Principles

1. **Keep the imperative `ctx.*` surface.** This is the core DX. No graph DSLs or builder chains.
2. **Stay zero-dependency for core.** Raw `fetch` providers are a strength. New capabilities (vector stores, OTel) are optional peer deps.
3. **Primitives over platforms.** Ship composable building blocks, not an all-in-one framework. Let developers choose their own deployment, storage, and infrastructure.
4. **Prove it with tests.** Every new feature should be testable with `AxlTestRuntime`.

## Status

### Complete

- **OpenTelemetry** — Automatic span emission for every `ctx.*` primitive with cost-per-span attribution
- **Memory Primitives** — `ctx.remember()`, `ctx.recall()`, `ctx.forget()` with session/global scope and semantic vector search
- **Agent Guardrails** — Input/output validation at the agent boundary with retry, throw, or custom policies
- **Session Options** — Configurable history limits, summarization, and persistence
- **Tool Middleware** — Approval gates (`requireApproval`) and lifecycle hooks (`before`/`after`)
- **Agent Handoffs** — Oneway and roundtrip modes with descriptions, OTel spans, and session history
- **Streaming Improvements** — Typed `StreamEvent` variants, `stream.steps` filtered iterable
- **Axl Studio** — Local development UI with 8 panels (Playground, Workflows, Traces, Costs, Memory, Sessions, Tools, Evals)
- **Evaluation Framework** — `dataset()`, `scorer()`, `llmScorer()`, `evalCompare()`, `rescore()`, `aggregateRuns()`, CLI with `compare`, `rescore` subcommands, `--runs` multi-run support
- **Configurable Model Parameters** — `temperature`, `maxTokens`, `effort`, `thinkingBudget`, `includeThoughts`, `toolChoice`, `stop` on `AgentConfig` and per-call via `AskOptions`
- **Unified Effort** — Cross-provider `effort` parameter (`'none'` | `'low'` | `'medium'` | `'high'` | `'max'`) maps to reasoning_effort (OpenAI o-series + GPT-5.x), adaptive thinking + output_config.effort (Anthropic 4.6), thinkingLevel (Gemini 3.x), thinkingBudget (Gemini 2.x)

### Planned

#### Configurable Session Summarization

The session summarization system (triggered when `maxMessages` is exceeded with `summarize: true`) currently uses a hardcoded prompt and a fixed `maxTokens: 1024` limit. Planned improvements:

- Configurable `summaryMaxTokens` on `SessionOptions.history`
- Custom `summaryPrompt` for domain-specific summarization (e.g., preserving medical terms, legal context)
- Pluggable summarization function for full control over the summarization strategy

#### MCP Server Exposure

Axl can consume MCP tools (client). Next step: expose agents and tools as MCP servers so other AI systems can use them.

```typescript
import { mcpServer } from '@axlsdk/axl/mcp';

const server = mcpServer({
  name: 'my-axl-agents',
  agents: [researcher, writer],
  tools: [calculator, webSearch],
  transport: 'stdio',
});

server.listen();
```

#### Additional Vector Store Adapters

Currently: `InMemoryVectorStore` (testing) and `SqliteVectorStore` (production). Planned:

| Adapter | Why |
|---------|-----|
| pgvector | Most deployed vector DB in production |

#### Provider Ecosystem Expansion

| Provider | URI | Priority |
|----------|-----|----------|
| Ollama (local models) | `ollama:llama3` | High |
| AWS Bedrock | `bedrock:anthropic.claude-sonnet-4-6` | Medium |
| Azure OpenAI | `azure:gpt-4o` | Medium |
| Groq | `groq:llama3-70b` | Low |
| Mistral | `mistral:mistral-large` | Low |

Each adapter follows the existing pattern: raw `fetch`, implements the `Provider` interface, registered via `ProviderRegistry`.

#### Example Recipes

Real-world examples that showcase Axl's strengths as standalone, runnable TypeScript files:

| Recipe | Showcases |
|--------|-----------|
| Multi-agent customer support | Handoffs, sessions, guardrails, streaming |
| Cost-controlled research agent | `ctx.budget()`, `ctx.map()`, `ctx.race()` |
| Peer review pipeline | `ctx.spawn()`, `ctx.vote()`, `llmScorer()` |
| Human-in-the-loop approval | `ctx.awaitHuman()`, `requireApproval`, `ctx.checkpoint()` |
| RAG-augmented Q&A | Semantic recall, vector stores, sessions |
| Eval-driven prompt iteration | `dataset()`, `scorer()`, `llmScorer()`, `evalCompare()` |

#### Reference Tool Package (`@axlsdk/tools`)

A companion package shipping battle-tested tool implementations for common agentic patterns. Users building coding agents, research agents, or browsing agents need these on day one — "bring your own tools" is the right default, but the gap is visible when competing SDKs ship them built-in.

| Tool | Description | Priority |
|------|-------------|----------|
| `shellTool()` | Sandboxed shell command execution with timeout and output capture | High |
| `fileEditTool()` | File read/write/patch with diff-based editing | High |
| `webSearchTool()` | Web search via pluggable backend (Tavily, Serper, Brave) | High |
| `fileSearchTool()` | Chunked file/directory search with embedding-based retrieval | Medium |
| `browserTool()` | Headless browser interaction (Playwright-based) | Medium |

Design constraints:
- Each tool follows `tool()` conventions — Zod input schema, typed output, works with `MockTool`
- Backends are pluggable (e.g., `webSearchTool({ provider: 'tavily', apiKey })`) so users aren't locked to one service
- Zero required dependencies in the package — backends are optional peer deps
- All tools work with `AxlTestRuntime` via `MockTool` for testing

#### Dynamic Tool Loading

When agents have access to hundreds of tools (especially via MCP servers), sending all tool definitions in every request wastes context and degrades model performance. Dynamic tool loading lets agents discover tools on demand.

```typescript
const researcher = agent({
  name: 'researcher',
  model: 'openai:gpt-4o',
  tools: toolSearch({
    tools: [/* 200+ tools */],
    maxPerRequest: 10,
  }),
});
```

Two approaches under consideration:
1. **Query-based filtering**: A `toolFilter` function on agent config that receives the current message and returns a subset of tools to include
2. **Embedding-based search**: Tools are embedded at registration time; the agent's message is matched against tool descriptions to select the most relevant subset

Both can coexist — (1) is simpler and deterministic, (2) handles large tool sets better.

#### Portable Run State

`ctx.checkpoint()` + StateStore provides durable execution, but state is tied to a specific store instance. For serverless environments (Lambda, Cloudflare Workers) where there's no persistent store between invocations, a portable serializable state blob would be valuable.

```typescript
// Serialize
const snapshot = await ctx.serialize();
const blob = JSON.stringify(snapshot); // store anywhere

// Resume in a different process
const restored = workflow.resume(JSON.parse(blob));
```

This complements (not replaces) the existing StateStore-based approach. The snapshot captures enough state to replay from the last checkpoint without access to the original store.

### Future Considerations

Items we're tracking but not actively planning. These would move to Planned based on user demand.

#### Realtime / Voice Agents

OpenAI ships WebRTC, WebSocket, SIP, and Twilio transports for voice agents. This is a large surface area with deep provider coupling (OpenAI's Realtime API, Gemini Live, etc.). The multi-provider story for realtime is still immature industry-wide.

If we pursue this, it would likely be a separate package (`@axlsdk/realtime`) with a transport-agnostic interface, similar to how the core SDK abstracts providers.

## What We Will Not Build

These are conscious decisions, not oversights:

| Decision | Rationale |
|----------|-----------|
| Graph DSL | Imperative `ctx.*` is the core DX advantage. |
| Deep class hierarchies | Factory functions (`tool()`, `agent()`, `workflow()`) are simpler and more composable. |
| Visual workflow editor | Axl Studio is a debugging tool, not a low-code platform. |
| Managed cloud platform | Axl is a library. Deployment is the user's choice. |
| Pipe/chain composition | LLM calls should look like function calls, not pipeline DSLs. |
| Vercel AI SDK dependency | Raw `fetch` keeps the core lean and independent. Adapters built on third-party SDKs inherit their update cycles, bundle size, and abstractions. |
| Hosted tools (server-side execution) | Axl is a client-side SDK. `@axlsdk/tools` ships reference implementations that users run in their own infra, not on our servers. |
