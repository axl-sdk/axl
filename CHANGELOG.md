# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.3] - 2026-03-22

### Fixed

- **`executeWorkflow` README example** now includes a null guard for the `runtime` parameter and uses `AxlRuntime` type instead of `any`. Documents that the CLI does not provide a runtime and that cost tracking requires manual `{ output, cost }` return in custom `executeWorkflow` functions

## [0.10.2] - 2026-03-22

### Added

- **`runtime` parameter on `executeWorkflow`**: Eval files that export `executeWorkflow` now receive the `AxlRuntime` as an optional second argument: `(input, runtime?) => Promise<...>`. This lets eval files call agents via `runtime.createContext()` without needing a registered workflow — essential for monorepo setups where the eval file can't import the runtime directly. Fully backward compatible (existing eval files that only accept `input` are unaffected)

## [0.10.1] - 2026-03-22

### Added

- **Lazy eval loading on Studio middleware** (`evals` option on `createStudioMiddleware`): Dynamically import eval files on first access to eval endpoints, not at startup. Eval files are standalone entry points that can import from any module without creating circular deps in the static module graph. Supports glob patterns (`'evals/*.eval.ts'`), explicit file paths, recursive globs (`'evals/**/*.eval.ts'`), and monorepo import conditions. Eval names are the file's cwd-relative path (`evals/api/accuracy.eval.ts` → `"evals/api/accuracy"`), completely stable regardless of what other files or patterns exist. `@axlsdk/eval` can remain a `devDependency` — bundlers can't see dynamic `import()` calls. Lazy-loaded evals coexist with evals registered directly via `runtime.registerEval()`

### Fixed

- **Flaky `awaitHuman` test**: MemoryStore persists decisions to a shared temp file that accumulated across test runs. Added cleanup and replaced fixed `setTimeout` with polling helper

## [0.10.0] - 2026-03-20

### Added

- **Embeddable Studio Middleware** (`@axlsdk/studio/middleware`): New `createStudioMiddleware()` export that wraps Studio's server as Node.js-compatible middleware. Mount inside any HTTP framework (Express, Fastify, Koa, NestJS, raw `http.Server`, Hono-in-Hono) — single process, direct object references, no proxy layer. Returns `handler`, `handleWebSocket`, `upgradeWebSocket`, `app`, `connectionManager`, and `close`. Supports `basePath` for mounting at any URL path, `verifyUpgrade` for WebSocket auth, `readOnly` mode, and `serveClient` toggle
- **`BroadcastTarget` interface** on `ConnectionManager`: Generalizes the socket type from Hono's `WSContext` to any object with `send()` and optional `close()`. Enables the middleware's `handleWebSocket()` to work with any WebSocket implementation (`ws`, NestJS gateways, Bun, Deno)
- **`handleWsMessage()` export** from `@axlsdk/studio/middleware`: Shared WebSocket protocol handler for Hono-in-Hono consumers who wire up WebSocket manually
- **`closeAll()` method** on `ConnectionManager`: Closes all connections and clears state (used during middleware shutdown)
- **`maxConnections` limit** on `ConnectionManager`: Rejects new connections beyond 100
- **Channel validation** on WebSocket protocol: Validates channel names against allowlist (`execution:`, `trace:`, `costs`, `decisions`), enforces 256-char limit, rejects 64KB+ messages
- **`basePath` option** on `createServer()`: Injects `<base>` tag and `window.__AXL_STUDIO_BASE__` into index.html for runtime path configuration
- **`readOnly` option** on `createServer()`: Disables all mutating API endpoints (returns 405 with standard error envelope)
- **`cors` option** on `createServer()`: Conditional CORS (false for embedded middleware where host framework owns CORS policy)
- **Client-side basePath support**: `api.ts`, `ws.ts`, and `App.tsx` read `window.__AXL_STUDIO_BASE__` for API prefix, WebSocket URL, and React Router basename

### Fixed

- **Client WebSocket wildcard matching**: `trace:*` subscriptions now correctly receive events sent with actual channel names (e.g., `trace:abc123`). Previously, the `WsClient.onmessage` handler only did exact-match lookups, so wildcard listeners were never invoked — the Trace Explorer's live event feed silently fell back to polling
- **`readOnly` middleware under Hono `app.route()` mounting**: Path matching now extracts the `/api/...` portion from `c.req.path`, which includes the parent route prefix when mounted via `parentApp.route('/studio', studioApp)`
- **`readOnly` error response**: Now returns the standard API envelope `{ ok: false, error: { code: 'READ_ONLY', message } }` instead of a non-conforming `{ error: string }` response
- **`close()` lifecycle**: Handler returns 503 after `close()` is called, preventing workflow execution through a shut-down middleware. `handleWebSocket()` also rejects connections after close. The `upgrade` listener is removed from the HTTP server during cleanup, preventing stale handlers after shutdown
- **`upgradeWebSocket()` double-call guard**: Throws a clear error instead of leaking the previous `WebSocketServer` instance
- **`subscribe()` on unregistered socket**: Now a no-op instead of creating an orphaned channel entry that could leak memory
- **Channel validation**: `costs` and `decisions` now require exact match (previously `costsomething` and `decisionsbanana` were accepted via `startsWith`)
- **`normalizeBasePath` consecutive slashes**: `/studio//admin` is now rejected instead of silently accepted
- **Race condition in `verifyUpgrade`**: Guards against `wss` being nulled if `close()` is called during an in-flight async upgrade handshake

### Changed

- **Vite `base: './'`**: Asset references in built HTML are now relative, enabling the SPA to work at any mount point when combined with the `<base>` tag injection

## [0.9.1] - 2026-03-19

### Fixed

- `ctx.verify()` now extracts structured output from errors thrown by `fn()`. When `fn()` throws (e.g., inner `ctx.ask()` exhausted its retries), `fn()` never returned a value so `retry.output` was previously `undefined`. Now `verify` recovers data from the error's `lastOutput`: `ValidationError` populates both `retry.parsed` and `retry.output`; `VerifyError` (schema failure) populates `retry.output` only. `VerifyError` from `fn()` is also re-thrown directly after retries instead of being wrapped in a new `VerifyError`

## [0.9.0] - 2026-03-19

### Changed

- **BREAKING: Zod v4 required** — Upgraded from Zod v3 (`^3.24.0`) to Zod v4 (`^4.0.0`). `zod` is now a peer dependency of `@axlsdk/axl` (was a regular dependency). Users must install `zod@^4.0.0` alongside `@axlsdk/axl`. Key Zod v4 changes that affect user code: `z.ZodTypeAny` removed (use `z.ZodType`), `._def` internals moved to `._zod.def`, `.strict()` deprecated (use `z.strictObject()`), `ZodError.errors` getter removed (use `.issues`), error customization param `message` deprecated (use `error`). `.parse()`, `.safeParse()`, `z.infer<>`, and `z.object()`/`z.string()`/etc. are unchanged. Note: in Zod v4, manually constructed `ZodError` instances (via `new ZodError(...)`) no longer extend `Error` — only errors thrown by `.parse()` do. `VerifyError.zodError` may be a manually constructed instance, so `err.zodError instanceof Error` may return `false`. Use `instanceof ZodError` instead. See [Zod v4 changelog](https://zod.dev/v4/changelog) for the full migration guide
- **`zodToJsonSchema()` output format changed** — Now wraps Zod v4's built-in `z.toJSONSchema()`. Gains support for discriminated unions, records, tuples, intersections, and other previously unsupported types. Output differences: objects now include `additionalProperties: false`, nullable uses `anyOf` with null type instead of `nullable: true`, unions use `anyOf` instead of `oneOf`, default values include a `default` annotation. Direct callers of `zodToJsonSchema()` who assert on its output shape will need to update

## [0.8.0] - 2026-03-18

### Added

- **`validate` on AskOptions**: Per-call post-schema business rule validation that receives the parsed typed object (not raw text). Co-located with the `schema` it validates for full type inference (`OutputValidator<T>`). Requires `schema` — skipped without one. Retries with accumulating context so the LLM sees all previous failed attempts. Configured via `validate` (validator function) and `validateRetries` (default: 2). Throws `ValidationError` on exhaustion
- **`validate` on DelegateOptions, RaceOptions, VerifyOptions**: Validate is supported across all schema-accepting primitives. On `ctx.delegate()`, forwarded to the final agent call (including through handoffs). On `ctx.race()`, results that fail validate are discarded like schema failures. On `ctx.verify()`, runs after schema parse with the same retry semantics
- **`ValidationError`**: New error class for post-schema validation failures (includes `lastOutput`, `reason`, `retries`)
- **`ValidateResult` / `OutputValidator` / `VerifyRetry` types**: Exported from `@axlsdk/axl` for typed validator functions and verify retry context

### Changed

- **Schema retries now use accumulating context** (behavioral change): Previously, schema validation failures triggered a recursive retry that only showed the most recent error. Now schema retries use the same accumulating pattern as guardrails — the LLM sees all previous failed attempts in the conversation history, improving self-correction. Note: this means retry prompts consume more tokens than before (context grows linearly with each retry), which is a tradeoff for significantly better self-correction
- **Output pipeline runs as three sequential gates**: Output guardrail → schema validation → validate, each with independent retry counters. On any gate failure, the new LLM response goes through all gates again
- **`ctx.verify()` fn signature** (breaking): Changed from `(lastOutput?: unknown, errorMessage?: string)` to `(retry?: VerifyRetry<T>)`. The retry context provides typed `parsed` (only on validate failures), `output` (raw), and `error`. Migration: replace `(lastOutput, error) =>` with `(retry) =>` and access `retry?.error`, `retry?.output`, `retry?.parsed`
- **Handoff forwarding** now includes `validate` and `validateRetries` — previously only `schema`, `retries`, and `metadata` were forwarded to handoff targets

## [0.7.6] - 2026-03-18

### Fixed

- OpenAI cached token pricing now uses per-model multipliers instead of a flat 50%: gpt-4o era = 50%, gpt-4.1/o3/o4 era = 25%, gpt-5 era = 10%
- Streaming calls now correctly report cost and contribute to `ctx.budget()` tracking; previously `response.cost` was always `undefined` for streamed responses
- OpenAI Responses API streaming now correctly handles `event:` and `data:` lines split across read chunks; previously `response.completed` was silently dropped for reasoning models with larger payloads, losing usage and cost data

## [0.7.5] - 2026-03-18

### Fixed

- **Studio CLI:** Pass Hono app instance to `createNodeWebSocket()` instead of `undefined` — fixes WebSocket upgrade crash (`TypeError: Cannot read properties of undefined (reading 'request')`)

## [0.7.4] - 2026-03-17

### Fixed

- **Studio CLI:** Restore `--help` / `-h` flag and port validation, both lost during refactor
- **Studio CLI:** ESM-forcing resolve hook no longer fires for `.mts`/`.cts` files (fix from 0.7.3 now properly tested)

## [0.7.3] - 2026-03-17

### Fixed

- **Studio CLI:** ESM-forcing resolve hook no longer fires for `.mts`/`.cts` files — previously `endsWith('.ts')` matched these extensions too, which was wrong for `.cts` (would force a deliberately CJS file to ESM)
- **Studio CLI:** CJS/ESM error message no longer suggests "rename to .mts" for files that are already `.mts`
- **Studio CLI:** Show exported object shape when config exports something other than an AxlRuntime (helps diagnose config mistakes)

## [0.7.2] - 2026-03-17

### Added

- **Studio CLI:** Config auto-detection — searches for `axl.config.mts` → `.ts` → `.mjs` → `.js` when no `--config` is specified
- **Studio CLI:** ESM-forcing resolve hook for `.ts`/`.tsx` config files — top-level `await` now works regardless of the nearest package.json `"type"` field
- **Studio CLI:** `--conditions` flag for custom Node.js import conditions (e.g., `--conditions development` to resolve workspace packages through source exports)
- **Studio CLI:** Actionable error messages when config loading fails due to CJS/ESM compatibility issues (suggests `.mts` rename or `"type": "module"`)

### Changed

- **Studio CLI:** Default config recommendation changed from `axl.config.ts` to `axl.config.mts` for guaranteed ESM semantics

## [0.7.1] - 2026-03-17

### Fixed

- **Studio CLI:** Register both ESM and CJS tsx hooks so `.ts` config files load correctly in projects without `"type": "module"` in package.json
- **Studio CLI:** Handle CJS-to-ESM interop wrapping when resolving `export default` from config files (fixes "not a valid AxlRuntime" error)
- **Studio CLI:** Support `.mts`, `.cts`, and `.mtsx`/`.ctsx` config file extensions

## [0.7.0] - 2026-03-17

### Changed

- **Breaking:** `RedisStore` migrated from `ioredis` to `redis` (node-redis v5)** — the official Redis client maintained by Redis Ltd. Install `redis` instead of `ioredis`: `npm install redis`
- **Breaking:** `StateConfig.store` no longer accepts `'redis'` as a string** — pass a `RedisStore` instance directly instead. The `'memory'` and `'sqlite'` shorthands are unchanged
- **Breaking:** `StateConfig.redis` sub-config removed** — URL is now passed directly to `RedisStore.create(url?)`
- **Breaking:** `RedisStore` constructor is now private** — use the async `RedisStore.create(url?)` factory, which connects before returning and surfaces connection errors at startup

Migration:

```typescript
// Before (≤0.6.0)
const runtime = new AxlRuntime({
  state: { store: 'redis', redis: { url: 'redis://localhost:6379' } },
});

// After
import { AxlRuntime, RedisStore } from '@axlsdk/axl';
const store = await RedisStore.create('redis://localhost:6379');
const runtime = new AxlRuntime({ state: { store } });
```

## [0.6.0] - 2026-03-16

### Added

- Gemini 3.x thinking support: `thinkingLevel` string enum (`'low'|'medium'|'high'`) for Gemini 3.x models (`gemini-3-*`, `gemini-3.1-*`); `'none'` maps to model minimum, `'max'` caps at `'high'`
- `providerMetadata` on `ChatMessage` and `ProviderResponse` — opaque bag for provider-specific round-trip data; does not affect cross-provider portability
- Gemini thought signature (`thoughtSignature`) preserved across multi-turn sessions via `providerMetadata`, preventing reasoning context loss
- OpenAI Responses API reasoning context round-tripping via `providerMetadata.openaiReasoningItems` — encrypted reasoning items passed back on each turn
- `includeThoughts: true` returns reasoning summaries where supported: `reasoning.summary: 'detailed'` on OpenAI Responses, `includeThoughts` in Gemini `thinkingConfig`; no-op on Anthropic and OpenAI Chat Completions
- `thinking_delta` stream chunk type for Gemini thought summary delta events
- Gemini 2.5 Pro `thinkingBudget` cap raised to 32768 tokens (other 2.5 models: 24576)
- Gemini `thoughtsTokenCount` in usage mapped to `reasoning_tokens`
- Gemini 3.1 Pro Preview and Flash Lite Preview model pricing
- `ToolDefinition.strict` field for OpenAI strict tool schema enforcement
- `MockProvider` sequence/fn/stream modes support `providerMetadata` for testing round-trip reasoning behavior

### Changed

- **Breaking:** `Thinking` and `ReasoningEffort` types removed; replaced by flat `effort` (`'none'|'low'|'medium'|'high'|'max'`), `thinkingBudget` (number), and `includeThoughts` (boolean) on `ChatOptions`, `AgentConfig`, and `AskOptions`
- **Breaking:** `thinking` and `reasoningEffort` fields removed from `AgentConfig`, `AskOptions`, and `ChatOptions`
- `effort` maps to native reasoning APIs per provider: `reasoning_effort` (OpenAI o-series + GPT-5.x, `'max'`→`'xhigh'`), adaptive thinking + `output_config.effort` (Anthropic 4.6), `output_config.effort` only (Anthropic 4.5), `budget_tokens` fallback (older Anthropic), `thinkingLevel` (Gemini 3.x), `thinkingBudget` (Gemini 2.x)
- OpenAI effort clamped per model: `'none'`→`'minimal'` on pre-GPT-5.1 (which doesn't support disabling reasoning), `'xhigh'`→`'high'` on pre-GPT-5.2, always `'high'` on gpt-5-pro
- Anthropic 4.6 models (Opus 4.6, Sonnet 4.6) use adaptive thinking (`type: "adaptive"` + `output_config: { effort }`); Opus 4.5 supports `output_config.effort` but not adaptive; `thinkingBudget` falls back to manual mode (`type: "enabled", budget_tokens`)
- `effort` + `thinkingBudget: 0` sends standalone `output_config.effort` without a thinking block (Anthropic optimization for output quality without reasoning overhead)
- Dynamic handoffs function now receives merged per-call metadata, consistent with `resolveModel` and `resolveSystem`
- Schema validation retries no longer append invalid assistant responses to session history
- Token pricing prefix matching uses pre-sorted longest-first keys across all providers

### Fixed

- Dynamic handoffs function that throws degrades gracefully — error is logged, agent continues without handoffs instead of crashing
- `ctx.delegate()` now validates for duplicate agent names, preventing unreachable candidates and duplicate tool name errors

## [0.5.0] - 2026-03-10

### Added

- `effort` (`'low'|'medium'|'high'|'max'`), `thinkingBudget` (token budget), and `includeThoughts` on `AgentConfig` (agent-level defaults) and `AskOptions` (per-call overrides)
- Per-call model param overrides in `AskOptions`: `temperature`, `maxTokens`, `toolChoice`, `stop`. Precedence: `AskOptions` > `AgentConfig` > defaults; `maxTokens` defaults to 4096
- `AgentCallInfo` type emitted in `agent_call` trace events — captures model, token usage, cost, duration, and `providerOptions`
- `ToolChoice` type exported from core
- Thinking support across all providers:
  - **OpenAI** (o-series + GPT-5.x): maps `effort` to `reasoning_effort`; `'max'`→`'xhigh'`; guards reasoning params behind `isReasoningModel()` check; disables `parallel_tool_calls` for reasoning models
  - **Anthropic**: adaptive thinking + `output_config.effort` for 4.6 models; manual `budget_tokens` for older; auto-bumps `max_tokens` when `budget_tokens` exceeds it; strips `temperature` when thinking is enabled
  - **Gemini 2.x**: maps `thinkingBudget` to `thinkingConfig.thinkingBudget`; `'max'` uses model maximum budget
  - **OpenAI Responses**: same `reasoning_effort` mapping as Chat Completions

### Changed

- Agent handoffs now strip all model params from the source call — target agents always use their own `AgentConfig` defaults

## [0.4.0] - 2026-03-04

Initial public open-source release on npm under the `@axlsdk` scope. No new features over 0.3.0.

## [0.3.0]

### Added

- **OpenTelemetry integration** — optional `@opentelemetry/api` peer dependency; automatic spans for all `ctx.*` primitives with cost-per-span attribution; `axl.workflow.execute` > `axl.agent.ask` > `axl.tool.call` span hierarchy; `NoopSpanManager` for zero overhead when disabled; `runtime.initializeTelemetry()` activates span emission; `axl.tool.approval` and `axl.agent.handoff` spans with `mode` and `duration` attributes
- **Memory primitives** — `ctx.remember()` / `ctx.recall()` / `ctx.forget()` backed by `StateStore`; semantic recall via `VectorStore` + `Embedder` interfaces; `MemoryManager` coordinates both
- `InMemoryVectorStore` (testing) and `SqliteVectorStore` (production, requires `better-sqlite3`)
- `OpenAIEmbedder` for semantic recall using `text-embedding-3-small` / `text-embedding-3-large`
- **Agent guardrails** — `input`/`output` validator functions on `agent()` config; `onBlock: 'retry' | 'throw' | fn` policy; `maxRetries`; blocked `'retry'` outputs accumulate in the conversation for LLM self-correction (ephemeral, not persisted to session); `GuardrailError` thrown when retries are exhausted or `onBlock` is `'throw'`
- `runtime.session(id, { history: { maxMessages, summarize, summaryModel }, persist })` — history window management with configurable limits and optional LLM-assisted summarization of overflow messages

## [0.2.0]

### Added

- **Tool middleware** — `tool({ requireApproval: true })` gates agent-initiated execution through `ctx.awaitHuman()`; direct `tool.run()` bypasses the gate
- `tool({ hooks: { before, after } })` — input/output transform hooks; errors in hooks are isolated and do not abort the tool call
- **Handoff modes** — `'oneway'` (default: exits the source agent's tool-calling loop) and `'roundtrip'` (returns the target's result back to the source); roundtrip handoffs include a `message` parameter for delegating context
- `HandoffRecord.duration` populated with actual handoff execution time
- `session.handoffs()` returns handoff history as `HandoffRecord[]`; `session.fork()` copies it to the new session
- `StreamEvent` union expanded with typed payloads: `agent_start`, `agent_end`, `tool_call`, `tool_result`, `handoff`, `tool_approval`
- `stream.steps` getter — filters to structural events (excludes `token` and raw `step` events)
- `tool_approval` stream events emitted for both approvals and denials

## [0.1.0] - 2026-02-13

### Added

#### Core SDK (`axl`)
- `tool()` factory with Zod input validation, retry policies, and sensitive output redaction
- `agent()` factory with dynamic model/system selection, tool binding, handoffs, and prompt versioning
- `workflow()` factory for named async functions with typed input/output schemas
- `AxlRuntime` for workflow registration, execution, streaming, and session management
- `defineConfig()` for static configuration with provider URIs and environment variables
- `WorkflowContext` with all agentic primitives:
  - `ctx.ask()` — agent invocation with tool-calling loop and schema validation
  - `ctx.spawn()` — concurrent agent execution with optional quorum
  - `ctx.vote()` — consensus voting (majority, unanimous, highest, lowest, mean, median, custom)
  - `ctx.verify()` — self-correcting schema validation with retry and fallback
  - `ctx.budget()` — cost tracking with warn, finish_and_stop, and hard_stop policies
  - `ctx.race()` — first-to-complete with schema validation
  - `ctx.parallel()` — concurrent execution of independent tasks
  - `ctx.map()` — concurrent mapping with bounded concurrency and quorum
  - `ctx.awaitHuman()` — human-in-the-loop suspension and resume
  - `ctx.checkpoint()` — durable execution with checkpoint-replay semantics
  - `ctx.log()` — structured event logging
- Provider adapters for OpenAI and Anthropic (raw `fetch`, zero SDK dependencies)
- `ProviderRegistry` with factory pattern and lazy instantiation
- State stores: `MemoryStore`, `SQLiteStore` (better-sqlite3), `RedisStore` (ioredis)
- `Session` class with multi-turn history, fork, and streaming support
- `AxlStream` (Readable + AsyncIterable + EventEmitter) for streaming workflows
- MCP (Model Context Protocol) support with stdio and HTTP transports
- Context window management with automatic summarization
- Error hierarchy: `AxlError`, `VerifyError`, `QuorumNotMet`, `NoConsensus`, `TimeoutError`, `BudgetExceededError`, `MaxTurnsError`, `ToolDenied`

#### Testing Utilities (`axl-testing`)
- `MockProvider` with sequence, echo, json, replay, and fn modes
- `MockTool` wrapper for tool mocking
- `AxlTestRuntime` mirroring `WorkflowContext` for deterministic testing

#### Evaluation Framework (`axl-eval`)
- `dataset()` factory with inline and file loading
- `scorer()` for deterministic scoring functions
- `llmScorer()` for LLM-as-judge evaluation
- `defineEval()` for eval discovery
- `runEval()` with concurrent execution
- `evalCompare()` for regression and improvement detection
- CLI entry point (`axl-eval`) for running evaluations

#### Studio (`axl-studio`)
- `npx @axlsdk/studio` local development UI wrapping `AxlRuntime` with a Hono server + React SPA
- REST API (`/api/*`) for workflows, executions, sessions, agents, tools, memory, decisions, costs, evals, and playground
- WebSocket (`/ws`) with channel multiplexing for real-time streaming and trace events
- `createServer()` factory, `ConnectionManager` for channel subscriptions, `CostAggregator` for cost tracking
- Eight panels: Agent Playground, Workflow Runner, Trace Explorer, Cost Dashboard, Memory Browser, Session Manager, Tool Inspector, Eval Runner

[Unreleased]: https://github.com/axl-sdk/axl/compare/v0.7.6...HEAD
[0.7.6]: https://github.com/axl-sdk/axl/compare/v0.7.5...v0.7.6
[0.7.0]: https://github.com/axl-sdk/axl/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/axl-sdk/axl/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/axl-sdk/axl/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/axl-sdk/axl/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/axl-sdk/axl/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/axl-sdk/axl/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/axl-sdk/axl/releases/tag/v0.1.0
