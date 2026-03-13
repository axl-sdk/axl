# Roadmap

> Last updated: March 2026

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
- **Evaluation Framework** — `dataset()`, `scorer()`, `llmScorer()`, `evalCompare()`, CLI
- **Configurable Model Parameters** — `temperature`, `maxTokens`, `effort`, `thinkingBudget`, `includeThoughts`, `toolChoice`, `stop` on `AgentConfig` and per-call via `AskOptions`
- **Unified Effort** — Cross-provider `effort` parameter (`'none'` | `'low'` | `'medium'` | `'high'` | `'max'`) maps to reasoning_effort (OpenAI o-series + GPT-5.x), adaptive thinking + output_config.effort (Anthropic 4.6), thinkingLevel (Gemini 3.x), thinkingBudget (Gemini 2.x)

### Planned

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
| AWS Bedrock | `bedrock:anthropic.claude-sonnet-4-5` | Medium |
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

## What We Will Not Build

These are conscious decisions, not oversights:

| Decision | Rationale |
|----------|-----------|
| Graph DSL | Imperative `ctx.*` is the core DX advantage. |
| Deep class hierarchies | Factory functions (`tool()`, `agent()`, `workflow()`) are simpler and more composable. |
| Visual workflow editor | Axl Studio is a debugging tool, not a low-code platform. |
| Managed cloud platform | Axl is a library. Deployment is the user's choice. |
| Pipe/chain composition | LLM calls should look like function calls, not pipeline DSLs. |
