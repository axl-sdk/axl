# Roadmap

> Last updated: September 2026

## Guiding Principles

1. **Keep the imperative `ctx.*` surface.** This is the core DX. No graph DSLs or builder chains.
2. **Stay zero-dependency for core.** Raw `fetch` providers are a strength. New capabilities (vector stores, OTel) are optional peer deps.
3. **Primitives over platforms.** Ship composable building blocks, not an all-in-one framework. Let developers choose their own deployment, storage, and infrastructure.
4. **Prove it with tests.** Every new feature should be testable with `AxlTestRuntime`.

## Status

### Complete

- **Completed-file transcription** — `ctx.transcribe()` is a dedicated,
  non-chat finite-recording operation with OpenAI, Gemini Interactions/Files,
  and catalog-capable OpenRouter STT adapters; paired safe lifecycle events,
  cleanup status, mock coverage, and an explicit transcript-to-agent recipe.
  OpenRouter model/route capability remains authoritative; general audio
  understanding and realtime voice remain separate work.

- **OpenTelemetry** — Automatic span emission for every `ctx.*` primitive with cost-per-span attribution
- **Memory Primitives** — `ctx.remember()`, `ctx.recall()`, `ctx.forget()` with session/global scope and semantic vector search
- **Agent Guardrails** — Input/output validation at the agent boundary with retry, throw, or custom policies
- **Session Options** — Configurable history limits, summarization, and persistence
- **Tool Middleware** — Approval gates (`requireApproval`) and lifecycle hooks (`before`/`after`)
- **Model-Facing Tool Output Projection** — Opt-in synchronous `toModelOutput` allowlists the successful post-hook tool result sent to the model while preserving the complete host-observable result. Strict JSON-compatible validation fails closed, `sensitive` takes precedence, configured `AxlTestRuntime.mockTool()` overrides inherit projection policy, and direct/MCP/handoff paths remain unchanged.
- **Agent Handoffs** — Oneway and roundtrip modes with descriptions, OTel spans, and session history
- **Unified Event Model and v2 Tool Lifecycle** — Single live `AxlEvent` discriminated union with required `schemaVersion: 2`; `ExecutionInfo.eventSchemaVersion` selects the reducer without scanning events, while `HistoricalExecutionInfo` keeps v1 history honest. Provider-issued tools use pre-start `tool_call_rejected` plus one four-state terminal outcome (`succeeded`, `failed`, `denied`, `cancelled`) for accepted calls. Normal returns succeed regardless of an `error` property; explicit `ToolFailure` permits author-declared model-safe recovery. See the [stream-first and tool-lifecycle migration guide](docs/migration/stream-first-observation.md).
- **Axl Studio** — Local development UI with 8 panels (Playground, Workflows, Traces, Costs, Memory, Sessions, Tools, Evals)
- **Evaluation Framework** — `dataset()`, `scorer()`, `llmScorer()`, `evalCompare()`, `rescore()`, `aggregateRuns()`, CLI with `compare`, `rescore` subcommands, `--runs` multi-run support
- **Configurable Model Parameters** — `temperature`, `maxTokens`, `effort`, `thinkingBudget`, `includeThoughts`, `toolChoice`, `stop` on `AgentConfig` and per-call via `AskOptions`
- **Unified Effort** — Cross-provider `effort` uses exact model and endpoint capabilities, including native `max` on GPT-5.6 Responses and Claude 5 (with GPT-5.6 Chat capped to `xhigh`), adaptive thinking on supported Claude families, `thinkingLevel` on Gemini 3.x, and `thinkingBudget` on Gemini 2.x.
- **Current Provider Catalog and Honest Pricing** — GPT-5.6, Claude 5, Gemini 3.6/3.5, and current compatible-provider profiles ship with exact model matching, observable cache-write accounting, context/tier-aware pricing, and fail-closed unknown cost.
- **State Durability & Lifecycle (0.17.7)** — `state.persist: 'streaming'` flushes events during the run via the `StreamingFlusher`; `runtime.recoverIncompleteStreams()` reconstructs partial `ExecutionInfo`s after a crash (live-execution-skip guard, event-cap bound, save-failure preserves buffer, `__axl/recovered` sentinel). `runtime.deleteExecution(id)` is the GDPR right-to-be-forgotten sweep (data + indexes + checkpoints + suspended state + streaming buffer + pending decisions; in-flight resurrection guard; signal-abort propagates to paused `ctx.awaitHuman`). `execution_deleted` runtime event for audit trails. Studio: `DELETE /api/executions/:id` + WS replay buffer scrub. `ExecutionInfo.metadata` lifts caller-supplied tags (`userId`/`tenantId`) into a queryable surface with control-plane key stripping + isolation. `runtime.shutdown()` drains the streaming flusher AND in-flight `persistExecution` chains. See [migration guide](docs/migration/state-store-durability.md).
- **Redis Production Hardening (0.17.7)** — `RedisStore.create({ keyPrefix, defaultTtl, ttls, skipMigration })` with per-category TTL config (`memory`/`session`/`sessionMeta` sliding, `checkpoint`/`streamingEvents` fixed-creation, `executionHistory`/`evalHistory`/`executionState` fixed-refresh). Every multi-key write atomic via `MULTI/EXEC`. `listExecutions`/`listEvalResults` use sorted-set fast path (reverse `ZRANGE ... BYSCORE` + `MGET`, O(log N), 2× over-fetch for TTL drift). Lazy backfill from legacy SET on startup. `RedisStore` now implements memory methods (race-safe legacy migration). `listPendingExecutions` self-prunes stale ids.
- **Structured-Output & `ctx.ask` Pipeline Control** — Prompt-guided structured output stays the portable default; the appended JSON Schema is now `$ref`-hoisted + compact + rendered from the schema's input side (order-of-magnitude token cut on large unions, correct for `.transform()`). `schemaPrompt` (`'json-schema'` | `'none'` | `{ render }`) decouples the model-facing prompt from the parse gate; `nativeStructuredOutput` opts into the provider's native `json_schema` (derived from the same Zod schema) with a per-adapter capability tier (`Provider.nativeStructuredOutputSupport`) that warns-and-proceeds when unsupported. Silent cliffs surface as a new `schema_diagnostic` event (oversized / dropped-refinements / streaming-disabled / no-guidance / native-unsupported) plus a bounded one-time `console.warn`. Repair via Zod `.transform()` / `ctx.verify`. Verified live across 8 providers. See [api-reference.md#structured-output](docs/api-reference.md#structured-output).
- **Stream-First Observation API (Phases 1–3, complete)** — `ctx.events` on every `WorkflowContext` exposes the same `AxlEvent` iterable + curated views as `AxlStream` (`.text`, `.lifecycle`, `.textByAsk`, plus `.partialObjects`). Bounded queues, strict overflow, explicit streaming mode, signal cleanup, retry-aware views, and event options span every execution surface. The obsolete `onToken`, `onToolCall`, and `onAgentStart` context callbacks are removed; `ctx.events`, `runtime.stream()`, and runtime trace listeners cover context, wire-execution, and cross-execution observation without listener exceptions acting as control flow. See [migration guide](docs/migration/stream-first-observation.md).

### Planned

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

#### Remaining Provider Ecosystem Expansion

The generic `OpenAICompatibleProvider` and Tier 1 presets are complete. Remaining work
focuses on enterprise authentication/reach and provider-specific fidelity while keeping the
native Anthropic and Gemini adapters for thinking and tool-continuation semantics.

The shipped profile contract carries per-preset pricing, reasoning emit/capture, auth-header
shape, and per-model capability flags. Unknown billing remains `undefined`, never zero.

**Tier 1 — complete:**

| Preset | URI example | Notes |
|--------|-------------|-------|
| OpenRouter | `openrouter:vendor/model` | One key → 300+ models; chat/tools/reasoning/cost plus pass-through image transport when the selected model/route supports it |
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

`ctx.checkpoint()` stores named results inside one execution scope; it is not a cross-process workflow-resume protocol. Durable resumption needs a portable serializable run state plus decision claims, leases, checkpoint lineage, and idempotency boundaries. Serverless environments (Lambda, Cloudflare Workers) make that missing contract especially visible.

```typescript
// Serialize
const snapshot = await ctx.serialize();
const blob = JSON.stringify(snapshot); // store anywhere

// Resume in a different process
const restored = workflow.resume(JSON.parse(blob));
```

This would graduate the current StateStore checkpoint primitive into an explicit durable-resume protocol. Until then, Axl does not claim automatic workflow replay after process loss.

### Future Considerations

Items we're tracking but not actively planning. These would move to Planned based on user demand.

#### Multimodal Extensions

Axl currently supports ordered image input and completed-file transcription.
The following are intentionally tracked as separate future product surfaces,
not implied by today's `ModelInput` or `ctx.transcribe()` contracts:

- **General audio understanding** — Direct audio parts for speech and
  non-speech reasoning, with independent proof for ordinary responses, tool
  continuations, and structured output. Each provider/model combination must
  be certified; transcription must never become a hidden fallback.
- **Documents, video, and generated media** — New input and output content
  types with their own limits, provider mappings, observation rules, and live
  evidence. Multimodal tool results belong here as an explicit output contract,
  not an accidental extension of JSON tool results.
- **File and artifact lifecycle** — Provider file upload/list/download/delete,
  durable media sessions, or an Axl-managed artifact service require explicit
  ownership, retention, security, and cleanup semantics before becoming public
  APIs.
- **Studio media workflows** — Audio selection, hosted uploads, attachment
  libraries, multi-file composition, drag/drop, clipboard capture, and Session
  Manager media UX should follow—not invent—the corresponding core lifecycle.
- **Compatible-provider certification** — Add direct Mistral and other
  OpenAI-compatible multimodal certifications when there is user demand. These
  remain evidence-backed provider/model claims; Axl will not advertise a
  universal compatibility guarantee.
- **Gemini Interactions consolidation and stable endpoint** — Legacy
  string-only `google:` calls intentionally remain on `generateContent`; move
  them to Interactions only after focused compatibility certification. That
  certification must cover ordinary and streaming text, structured output,
  tools and tool continuation, thinking/effort controls, usage and cost,
  provider metadata, errors and retries, and observable request behavior. Axl
  currently targets Google's `/v1beta` Interactions route for rich image and
  transcription traffic; moving all Interactions traffic to `/v1` requires a
  separate endpoint and lifecycle certification. Neither migration should be
  treated as a silent transport swap.

Promote any item to Planned only when its user journey, lifecycle owner,
provider scope, and live-verification budget are explicit.

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
