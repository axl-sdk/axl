# Roadmap

> Last updated: June 2026

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
- **Model-Facing Tool Output Projection** — Opt-in synchronous `toModelOutput` allowlists the successful post-hook tool result sent to the model while preserving the complete host-observable result. Strict JSON-compatible validation fails closed, `sensitive` takes precedence, configured `AxlTestRuntime.mockTool()` overrides inherit projection policy, and direct/MCP/handoff paths remain unchanged.
- **Agent Handoffs** — Oneway and roundtrip modes with descriptions, OTel spans, and session history
- **Unified Event Model** — Single `AxlEvent` discriminated union (replaces the 0.15 `StreamEvent` + `TraceEvent` split). Wire format = trace format. Adds `ask_start`/`ask_end`, `agent_call_start`, `tool_call_start`, ask-graph correlation (`askId`/`parentAskId`/`depth`). `AxlStream.lifecycle` filtered iterable. See [migration guide](docs/migration/unified-event-model.md)
- **Axl Studio** — Local development UI with 8 panels (Playground, Workflows, Traces, Costs, Memory, Sessions, Tools, Evals)
- **Evaluation Framework** — `dataset()`, `scorer()`, `llmScorer()`, `evalCompare()`, `rescore()`, `aggregateRuns()`, CLI with `compare`, `rescore` subcommands, `--runs` multi-run support
- **Configurable Model Parameters** — `temperature`, `maxTokens`, `effort`, `thinkingBudget`, `includeThoughts`, `toolChoice`, `stop` on `AgentConfig` and per-call via `AskOptions`
- **Unified Effort** — Cross-provider `effort` parameter (`'none'` | `'low'` | `'medium'` | `'high'` | `'xhigh'` | `'max'`) maps to reasoning_effort (OpenAI o-series + GPT-5.x, `'xhigh'` on gpt-5.2+), adaptive thinking + output_config.effort (Anthropic 4.7/4.6, `'xhigh'` on Opus 4.7), thinkingLevel (Gemini 3.x), thinkingBudget (Gemini 2.x)
- **State Durability & Lifecycle (0.17.7)** — `state.persist: 'streaming'` flushes events during the run via the `StreamingFlusher`; `runtime.recoverIncompleteStreams()` reconstructs partial `ExecutionInfo`s after a crash (live-execution-skip guard, event-cap bound, save-failure preserves buffer, `__axl/recovered` sentinel). `runtime.deleteExecution(id)` is the GDPR right-to-be-forgotten sweep (data + indexes + checkpoints + suspended state + streaming buffer + pending decisions; in-flight resurrection guard; signal-abort propagates to paused `ctx.awaitHuman`). `execution_deleted` runtime event for audit trails. Studio: `DELETE /api/executions/:id` + WS replay buffer scrub. `ExecutionInfo.metadata` lifts caller-supplied tags (`userId`/`tenantId`) into a queryable surface with control-plane key stripping + isolation. `runtime.shutdown()` drains the streaming flusher AND in-flight `persistExecution` chains. See [migration guide](docs/migration/state-store-durability.md).
- **Redis Production Hardening (0.17.7)** — `RedisStore.create({ keyPrefix, defaultTtl, ttls, skipMigration })` with per-category TTL config (`memory`/`session`/`sessionMeta` sliding, `checkpoint`/`streamingEvents` fixed-creation, `executionHistory`/`evalHistory`/`executionState` fixed-refresh). Every multi-key write atomic via `MULTI/EXEC`. `listExecutions`/`listEvalResults` use sorted-set fast path (reverse `ZRANGE ... BYSCORE` + `MGET`, O(log N), 2× over-fetch for TTL drift). Lazy backfill from legacy SET on startup. `RedisStore` now implements memory methods (race-safe legacy migration). `listPendingExecutions` self-prunes stale ids.
- **Structured-Output & `ctx.ask` Pipeline Control** — Prompt-guided structured output stays the portable default; the appended JSON Schema is now `$ref`-hoisted + compact + rendered from the schema's input side (order-of-magnitude token cut on large unions, correct for `.transform()`). `schemaPrompt` (`'json-schema'` | `'none'` | `{ render }`) decouples the model-facing prompt from the parse gate; `nativeStructuredOutput` opts into the provider's native `json_schema` (derived from the same Zod schema) with a per-adapter capability tier (`Provider.nativeStructuredOutputSupport`) that warns-and-proceeds when unsupported. Silent cliffs surface as a new `schema_diagnostic` event (oversized / dropped-refinements / streaming-disabled / no-guidance / native-unsupported) plus a bounded one-time `console.warn`. Repair via Zod `.transform()` / `ctx.verify`. Verified live across 8 providers. See [api-reference.md#structured-output](docs/api-reference.md#structured-output).
- **Stream-First Observation API (Phase 1, complete)** — `ctx.events` on every `WorkflowContext` exposes the same `AxlEvent` iterable + curated views as `AxlStream` (`.text`, `.lifecycle`, `.textByAsk`, plus the new `.partialObjects` coalescing view). Observe events between `ctx.ask()` calls inside a workflow handler. Bounded-queue safety net (`maxQueued` + `onOverflow`) shipped on both `AxlStream` and `ctx.events`. `partialObjects` is schema-retry-aware (drops pending on `pipeline(failed)`, surfaces `attempt` to consumers) and recovers latest snapshot for late subscribers via the per-bus `latestPartialByAsk` map. `EventStreamOverflowError` (typed) propagates from strict-mode runs to BOTH the wire-side `AxlStream` bus and the in-handler `ctx.events` bus before the workflow fails. `events: EventStreamOptions` plumbed through `runtime.execute` / `runtime.stream` / `runtime.createContext` / `Session.send` / `Session.stream` / `AxlTestRuntime.execute`. `ctx.events` auto-disposes on signal abort. AbortSignal listeners on long-lived signals are cleaned up on workflow completion (no `MaxListenersExceededWarning` under sustained load). Iterator early-break is a clean `return()` — no event loss. Throwing user listeners are isolated from the workflow. The `onToken` / `onToolCall` / `onAgentStart` callbacks on `runtime.createContext()` remain for back-compat — Phase 2 (deprecation warning) and Phase 3 (removal at next major) tracked separately. See [migration guide](docs/migration/stream-first-observation.md).

### Planned

#### Tool lifecycle semantics (next major)

Tool execution still carries two inherited ambiguities that should be removed deliberately,
not patched piecemeal: a normally returned object with an `error` property is treated as a
failure for after-hook and span purposes, while invalid arguments emit no tool-call pair and
approval denial or a failing before-hook emit a start without a matching end. Before the next
major, design an explicit returned-versus-thrown outcome contract and terminal event semantics,
publish migration guidance, and update tool execution as one coherent breaking change. Until
then, the current behavior remains compatibility-locked.

#### Stream-First Observation API — Phases 2 & 3

Phase 1 (above) shipped `ctx.events` and the bounded-queue safety net. Remaining work:

- **Phase 2.** Soft-deprecate `onToken` / `onToolCall` / `onAgentStart` on `CreateContextOptions` — keep them working with a one-time console warning pointing at the new iterable. Migrate all in-tree examples (`docs/`, `packages/*/README.md`, `tests/e2e/`) to the iterable.
- **Phase 3.** Remove the callback options at the next major. Audit `packages/axl-studio/src/server/routes/playground.ts` and `tools.ts` for any embed paths that read the callbacks before removing them.

Out of scope (decided): adding `onToken` to `runtime.execute()` / `ExecuteOptions`. That would entrench the callback model in a third place. `runtime.execute()` stays final-result-only by design — observation belongs on `ctx.events` (inside the handler), `stream()` (per-execution), or the runtime trace emitter (cross-execution).

#### Strict-mode native structured output

`nativeStructuredOutput` currently sends OpenAI a **non-strict** `json_schema` (schema-as-guidance, not hard constrained decoding), because a Zod-derived schema isn't automatically OpenAI-strict-compliant (strict requires every property in `required` — optionals modeled as nullable — and `additionalProperties: false` on every object). Planned: an opt-in transform that rewrites the derived schema into the provider's strict subset and sets `strict: true`, so `nativeStructuredOutput` engages real constrained decoding where the provider supports it. Needs live-API iteration per provider; client-side Zod validation remains the guarantee in the meantime.

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

The OpenAI `/v1/chat/completions` + Bearer wire format is the de-facto standard — aggregators, the non-Big-3 labs, every self-hosted runtime, and (now) the enterprise clouds all speak it. The `OpenAIProvider` already accepts a custom `baseUrl`, so basic chat/tools/streaming works against these today. Rather than hand-write one ~500-line adapter per provider, the plan generalizes the existing adapter into a **generic `OpenAICompatibleProvider` parameterized by a `ProviderProfile`**, and ships breadth as **registry presets** — turning a coverage problem into a configuration problem (the shape Vercel's `@ai-sdk/openai-compatible` and LiteLLM converged on). The native `anthropic`/`gemini` adapters stay native to preserve thinking/effort fidelity, and the zero-dependency raw-`fetch` guarantee is preserved.

The generalization fixes three OpenAI-specific behaviors that currently misfire on other providers: the unified `effort` knob is gated to OpenAI model names (silent no-op elsewhere), unpriced models report a misleading `$0` instead of "unknown" cost, and reasoning traces from non-OpenAI providers are dropped. A profile carries per-preset pricing, reasoning emit/capture, auth-header shape, and capability flags (with per-model overrides where providers diverge).

**Tier 1 — the generic engine + highest-leverage breadth:**

| Preset | URI example | Notes |
|--------|-------------|-------|
| OpenRouter | `openrouter:vendor/model` | One key → 300+ models; unified reasoning + provider-reported cost |
| Azure OpenAI (v1) | `azure:<deployment>` | Deployment-name-as-model; `api-key` header auth |
| xAI Grok · DeepSeek · Mistral · Groq | `xai:…` `deepseek:…` `mistral:…` `groq:…` | Each a profile + small quirk set |
| Self-hosted (Ollama, vLLM, LM Studio, llama.cpp, SGLang) | `ollama:…` `vllm:…` … | First-class local presets — keyless, zero-cost, correct default ports |

**Tier 2 — enterprise reach:** AWS Bedrock (`openai.gpt-oss-*` via its bearer-key OpenAI-compatible endpoint; Claude-on-Bedrock routes through native `anthropic`), an async `apiKey` callback for expiring tokens (unblocks Vertex / Azure-Entra / Databricks / watsonx), and data-platform presets (Snowflake Cortex, Databricks, OCI).

**Tier 3 — fidelity & long tail:** Vertex auth modes on the native adapters; additional frontier-lab and aggregator presets (mostly reachable via OpenRouter already).

All presets follow the existing pattern: raw `fetch`, the `Provider` interface, registered via `ProviderRegistry`. Embeddings remain OpenAI-only until a parallel `OpenAICompatibleEmbedder` lands (tracked separately).

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

#### Reference Tool Package (`@axlsdk/tools`) — Q2 2026 target

A companion package shipping battle-tested tool implementations for common agentic patterns. Users building coding agents, research agents, or browsing agents need these on day one — "bring your own tools" is the right default, but the gap is visible when competing SDKs ship them built-in.

Timing is pressing: OpenAI's April 2026 Agents SDK update ships sandbox-native shell and apply-patch tools in Python, with TypeScript to follow. Axl's provider-agnostic equivalents are the right response — same primitives, usable with any model.

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

#### `agent.asTool()` Helper

Axl already supports the agent-as-tool pattern — wrap `ctx.ask(subAgent, input)` in a `tool()` and give it to an outer agent. This is distinct from `handoffs: 'roundtrip'` (which carries source conversation) and provides **session isolation**: the sub-agent sees a fresh context. The pattern works today, but requires boilerplate:

```typescript
const specialistTool = tool({
  name: 'consult_specialist',
  description: 'Ask the specialist agent a question',
  input: z.object({ question: z.string() }),
  handler: async (input, ctx) => ctx.ask(specialist, input.question),
});
```

Planned ergonomic sugar:

```typescript
const specialistTool = specialist.asTool({
  name: 'consult_specialist',  // optional, defaults to agent name
  description: '...',           // optional, defaults to agent system prompt
});
```

Implementation is a thin helper on the `Agent` prototype — wraps `ctx.ask(this, ...)` with a default input schema (`{ question: string }`) or accepts a custom one. Does not collapse the other three multi-agent patterns (`handoffs: oneway`, `handoffs: roundtrip`, `ctx.delegate`/`ctx.spawn`); each has distinct semantics and should remain explicit.

Naming aligns with OpenAI Agents JS's `agent.asTool()`, making mental-model portability easier for developers evaluating both SDKs.

#### AGENTS.md Convention Support

`AGENTS.md` is emerging as a cross-ecosystem convention for project-level agent instructions (used by Claude Code, OpenAI's April 2026 harness, and similar tools). Axl agents currently take `system` prompts in code; this adds an optional loader that merges project-level guidance from `AGENTS.md`.

```typescript
const dev = agent({
  name: 'dev',
  model: 'openai:gpt-4o',
  system: 'You are a coding assistant.',
  projectContext: 'AGENTS.md',  // auto-prepended to system prompt
});
```

Resolution: path relative to the file that defined the agent, or `process.cwd()` for absolute paths. Files are read once at agent creation, not per-call. Studio's Playground panel can optionally surface which agents loaded AGENTS.md context.

Low priority — convention alignment rather than core capability. Implement if developer demand materializes.

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

#### Native-First, Pluggable TypeScript Loader

`@axlsdk/eval` and `@axlsdk/studio` currently hardcode [tsx](https://github.com/privatenumber/tsx) as the loader for `.ts` config and eval files (declared as an optional peer dependency since 0.17.x). This couples the SDK to tsx's release cadence, ships esbuild to consumers who only use `.js` configs, and ignores Node's own trajectory.

- **Native first.** Node 22.6+ ships `--experimental-strip-types`; Node 23.6+ enables it by default. For most config/eval files (no enums, no JSX, no namespaces), native type stripping is sufficient — no loader needed. The CLI should detect this capability and prefer it over tsx.
- **Pluggable loader.** Demote tsx from "the loader" to "one supported fallback." Add a `--loader` flag (or `loader` config option) that accepts `tsx`, `ts-node`, or a custom loader path. Auto-detect what's already in the consumer's `devDependencies` so monorepos that standardize on a different TS loader don't fight us.
- **Drop the hard tsx coupling at 1.0.** Once native support is stable across our supported Node range, tsx becomes purely opt-in for users with TS features that strip-types can't handle (enums, namespaces, JSX in config files — rare in practice).

This is the long-term answer to the resolution complaint that drove the 0.17.x peerDep declaration. The peerDep is correct *given* tsx is the loader; the deeper fix is to stop assuming it has to be.

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
