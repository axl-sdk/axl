# Axl - TypeScript SDK for Agentic Systems

## Project Overview
Axl is an open-source TypeScript SDK for orchestrating agentic systems. It treats concurrency, structured output, uncertainty, and cost as first-class primitives.

## Architecture
- **Monorepo** with 4 packages:
  - `packages/axl` — Core SDK: `tool()`, `agent()`, `workflow()`, `AxlRuntime`, provider adapters, state stores
  - `packages/axl-testing` — `MockProvider`, `MockTool`, `AxlTestRuntime`
  - `packages/axl-eval` — `dataset()`, `scorer()`, `llmScorer()`, eval runner, CLI
  - `packages/axl-studio` — Local development UI: Hono server + React SPA wrapping AxlRuntime

## Tech Stack
- TypeScript (strict mode)
- Zod v4 for schema validation (peer dependency `zod@^4.0.0`)
- Vitest for testing
- pnpm workspaces for monorepo management
- Node.js 20+

## Package Exports
```typescript
// Core SDK
import { tool, agent, workflow, AxlRuntime, defineConfig } from '@axlsdk/axl';

// Telemetry
import { createSpanManager, NoopSpanManager } from '@axlsdk/axl';

// Memory
import { MemoryManager, OpenAIEmbedder, InMemoryVectorStore, SqliteVectorStore } from '@axlsdk/axl';

// Sessions
import { Session, SessionOptions } from '@axlsdk/axl';

// Errors
import { GuardrailError, ValidationError } from '@axlsdk/axl';

// Tier 2 types
import type { ToolHooks, HandoffRecord, AgentCallInfo } from '@axlsdk/axl';

// State types
import type { StateStore, ExecutionState, PendingDecision, EvalHistoryEntry } from '@axlsdk/axl';

// Provider types
import type { Effort, ToolChoice, ChatOptions, DelegateOptions, CreateContextOptions } from '@axlsdk/axl';

// Testing
import { AxlTestRuntime, MockProvider, MockTool } from '@axlsdk/testing';

// Evaluation
import { dataset, scorer, llmScorer, defineEval, normalizeScorerResult, runEval, evalCompare, pairedBootstrapCI, rescore, aggregateRuns } from '@axlsdk/eval';
import type { ScorerResult, ScorerDetail, EvalCompareOptions, RescoreOptions, MultiRunSummary, BootstrapCIResult } from '@axlsdk/eval';

// Studio (server API)
import { createServer, ConnectionManager, TraceAggregator, ExecutionAggregator, EvalAggregator } from '@axlsdk/studio';

// Studio (embeddable middleware)
import { createStudioMiddleware, handleWsMessage } from '@axlsdk/studio/middleware';
import type { StudioMiddleware, StudioMiddlewareOptions, StudioWebSocket, EvalLoaderConfig } from '@axlsdk/studio/middleware';
```

## Living Documentation
All docs (`docs/`), READMEs (`packages/*/README.md`), specs (`.internal/spec/`), and `CLAUDE.md` are living documents. **Always update relevant documentation after making code changes.** If you add, rename, or remove APIs, features, files, or conventions, update the corresponding docs in the same PR.

## Key Conventions
- All agentic primitives are on `ctx`: `ctx.ask()`, `ctx.delegate()`, `ctx.spawn()`, `ctx.vote()`, `ctx.verify()`, `ctx.budget()`, `ctx.race()`, `ctx.parallel()`, `ctx.map()`, `ctx.awaitHuman()`, `ctx.remember()`, `ctx.recall()`, `ctx.forget()`, `ctx.log()`
- Provider URI scheme: `provider:model` (e.g., `openai:gpt-4o`, `openai-responses:gpt-4o`)
- Tool definitions use Zod schemas for input validation
- Agents are inert definitions until called via `ctx.ask()` or `agent.ask()`
- Workflows are named async functions receiving `WorkflowContext`
- Agent `guardrails` config: `input`/`output` validators with `onBlock` policy (`'retry'` | `'throw'` | custom fn) and `maxRetries`
- `validate` on `AskOptions`: per-call post-schema business rule validation on typed object, co-located with the `schema` it validates. Requires schema (skipped without one). `validateRetries` (default 2). Output pipeline: guardrail (raw text) → schema (parse+Zod) → validate (typed object), each with independent retry counters and accumulating context
- Tool `requireApproval` triggers `ctx.awaitHuman()` before agent-initiated tool execution; `hooks.before`/`hooks.after` transform input/output

## Error Hierarchy
- `AxlError` (base) → `VerifyError`, `ValidationError`, `QuorumNotMet`, `NoConsensus`, `TimeoutError`, `MaxTurnsError`, `BudgetExceededError`, `GuardrailError`, `ToolDenied`

## File Structure
```
packages/axl/src/
  index.ts           — Barrel exports
  tool.ts            — tool() factory with retry, Zod validation
  agent.ts           — agent() factory with dynamic model/system
  workflow.ts        — workflow() factory
  config.ts          — defineConfig(), parseDuration(), parseCost(), resolveConfig()
  context.ts         — WorkflowContext with all ctx.* primitives (~2300 lines)
  runtime.ts         — AxlRuntime: register, execute, stream, session, createContext
  session.ts         — Session class for multi-turn conversations
  stream.ts          — AxlStream (Readable + EventEmitter + AsyncIterable)
  types.ts           — All shared types
  errors.ts          — Error hierarchy
  providers/
    types.ts         — Provider interface, ChatOptions, ToolDefinition
    retry.ts         — fetchWithRetry() — exponential backoff for 429/503/529
    openai.ts        — OpenAI Chat Completions adapter
    openai-responses.ts — OpenAI Responses API adapter
    anthropic.ts     — Anthropic adapter
    gemini.ts        — Google Gemini adapter
    registry.ts      — ProviderRegistry with factory pattern
  telemetry/
    types.ts         — SpanManager interface, TelemetryConfig
    span-manager.ts  — createSpanManager() with OTel integration
    noop.ts          — NoopSpanManager (zero overhead when disabled)
  memory/
    types.ts         — MemoryManager interface, VectorStore interface
    manager.ts       — MemoryManager implementation (remember/recall/forget)
    embedder.ts      — OpenAIEmbedder (text-embedding-3-small/large)
    vector-memory.ts — InMemoryVectorStore (testing)
    vector-sqlite.ts — SqliteVectorStore (sqlite-vec)
  state/
    types.ts         — StateStore interface, EvalHistoryEntry, PendingDecision, ExecutionState
    memory.ts        — MemoryStore (in-memory Maps)
    sqlite.ts        — SQLiteStore (file-based JSON placeholder)
    redis.ts         — RedisStore (node-redis; created via async `RedisStore.create(url)` factory)
  __tests__/         — Vitest test files

packages/axl-testing/src/
  index.ts           — Exports
  mock-provider.ts   — MockProvider with sequence/echo/json/replay/fn modes
  mock-tool.ts       — MockTool wrapper
  test-runtime.ts    — AxlTestRuntime (mirrors WorkflowContext for testing)

packages/axl-eval/src/
  index.ts           — Exports
  types.ts           — EvalConfig, EvalResult, EvalItem, EvalSummary, EvalComparison, ScorerDetail
  dataset.ts         — dataset() factory with inline/file loading
  scorer.ts          — scorer() factory (deterministic)
  llm-scorer.ts      — llmScorer() factory (LLM-as-judge)
  define-eval.ts     — defineEval() (identity, for CLI discovery)
  runner.ts          — runEval() with concurrent execution
  compare.ts         — evalCompare() regression/improvement detection with bootstrap CI
  bootstrap.ts       — pairedBootstrapCI() with seeded PRNG for deterministic tests
  rescore.ts         — rescore() re-runs scorers on saved outputs
  multi-run.ts       — aggregateRuns() computes mean ± std across multiple runs
  utils.ts           — Shared computeStats(), round() helpers
  cli.ts             — CLI entry: --config, --conditions, --output, --runs, --threshold flags
  cli-utils.ts       — Config detection, tsx loader, ESM forcing, conditions, resolveRuntime

packages/axl-studio/src/
  cli.ts             — CLI entry: --port, --config, --conditions, --open flags
  middleware.ts      — Embeddable middleware: createStudioMiddleware(), Node.js adapter
  eval-loader.ts     — Lazy eval file discovery: createEvalLoader(), glob resolution, tsx/conditions
  resolve-runtime.ts — Config module interop (ESM default, CJS wrapping, named exports)
  server/
    index.ts         — createServer() factory, Hono app composition (basePath, readOnly, cors)
    types.ts         — API types, WS message types, env bindings
    aggregates/
      aggregate-snapshots.ts — AggregateSnapshots<State> helper, WindowId, withinWindow
      trace-aggregator.ts    — TraceAggregator<State> (TraceEvent consumer)
      execution-aggregator.ts — ExecutionAggregator<State> (ExecutionInfo consumer)
      eval-aggregator.ts     — EvalAggregator<State> (EvalHistoryEntry consumer)
      reducers.ts            — Pure reducer functions for all four panels
      index.ts               — Barrel exports
    middleware/
      error-handler.ts — Axl errors -> JSON error envelope
    routes/
      health.ts      — GET /api/health
      workflows.ts   — GET/POST /api/workflows
      executions.ts  — GET/POST /api/executions
      sessions.ts    — GET/POST/DELETE /api/sessions
      agents.ts      — GET /api/agents
      tools.ts       — GET/POST /api/tools
      memory.ts      — GET/PUT/DELETE /api/memory
      decisions.ts   — GET/POST /api/decisions
      costs.ts       — GET /api/costs?window=
      eval-trends.ts — GET /api/eval-trends?window=
      workflow-stats.ts — GET /api/workflow-stats?window=
      trace-stats.ts — GET /api/trace-stats?window=
      evals.ts       — GET /api/evals, GET /api/evals/history, POST /api/evals/:name/run, POST /api/evals/:name/rescore, POST /api/evals/import, DELETE /api/evals/history/:id, POST /api/evals/compare
      playground.ts  — POST /api/playground/chat
    ws/
      handler.ts     — WebSocket message routing (Hono adapter)
      connection-manager.ts — Channel subscriptions + broadcast (BroadcastTarget) + replay buffer for execution channels
      protocol.ts    — Shared WS protocol: handleWsMessage(), channel validation
  client/
    main.tsx         — React entry point
    App.tsx          — BrowserRouter + Sidebar + Routes (8 panels)
    index.css        — Tailwind directives + CSS variables
    lib/
      api.ts         — Typed fetch wrappers for all endpoints
      ws.ts          — WebSocket singleton with auto-reconnect
      query-client.ts — TanStack Query client
      utils.ts       — cn(), formatCost(), formatDuration(), formatTokens(), extractLabel()
      trace-utils.ts — Trace data extraction helpers for the Trace Explorer panel
      types.ts       — Client-side types mirroring server API
    hooks/
      use-ws.ts      — useWs(channel, callback)
      use-ws-stream.ts — useWsStream(executionId)
    components/
      layout/        — Sidebar, PanelShell
      shared/        — JsonEditor, JsonViewer, CostBadge, StatusBadge, SchemaForm, StreamingText, StatCard, EmptyState, DurationBadge, TokenBadge, WindowSelector
    panels/
      playground/    — Agent Playground (chat, streaming, tool calls)
      workflow-runner/ — Workflow execution with timeline
      trace-explorer/ — Waterfall visualization of traces
      cost-dashboard/ — Cost tracking by agent/model/workflow
      memory-browser/ — Memory CRUD + semantic search
      session-manager/ — Session list, replay, handoff chain
      tool-inspector/ — Tool schemas + direct testing
      eval-runner/   — Eval execution + comparison (EvalSummaryTable, EvalItemList, EvalItemSidebar, EvalItemDetail, ScoreDistribution, EvalCompareView, EvalHistoryTable, EvalCompareItemTable, EvalCompareRunPicker, EvalMultiRunSwitcher). Score colors: 3-tier system (>=0.8 green, >=0.5 amber, <0.5 red)
```

## Testing
```bash
pnpm test          # Run all tests (unit + e2e + studio)
pnpm test:watch    # Watch mode
pnpm -r test       # Run tests across all packages
pnpm test:e2e      # E2E scenario tests only (tests/e2e/)
pnpm test:studio   # Studio API tests only (tests/studio/)
pnpm test:smoke    # Pack validation smoke tests (tests/smoke/)
```

Test infrastructure lives in `tests/` workspace:
- `tests/e2e/` — Cross-package E2E scenarios (basic workflow, streaming, sessions, handoffs, structured output, error handling, eval)
- `tests/studio/` — Studio REST API + middleware integration tests (health, workflows, executions, sessions, agents, tools, memory, costs, decisions, evals, playground, middleware)
- `tests/smoke/` — Tarball content validation via `pnpm pack`
- `packages/axl-studio/src/__tests__/` — Inline studio unit tests (server, cost-aggregator, connection-manager, ws-handler, protocol, middleware)

All tests use `MockProvider` — no API keys needed.

## Building
```bash
pnpm build         # Build all packages (tsup: ESM + CJS + DTS)
pnpm -r typecheck  # Type check without emitting

# Studio-specific
pnpm --filter @axlsdk/studio build          # Build client (Vite) + server (tsup)
pnpm --filter @axlsdk/studio build:client   # Build React SPA only
pnpm --filter @axlsdk/studio build:server   # Build Hono server + CLI only
pnpm --filter @axlsdk/studio dev            # Concurrent Vite + server dev mode
```

## Publishing to npm
Packages are published under the `@axlsdk` scope via a tag-triggered GitHub Actions workflow (`.github/workflows/publish.yml`). Requires an `NPM_TOKEN` secret in the repo settings.

```bash
# 1. Bump versions in all 4 package.json files (packages/axl, axl-testing, axl-eval, axl-studio)
# 2. Commit the version bump
git add -A && git commit -m "chore: Bump to X.Y.Z"
# 3. Create an annotated tag
git tag -a vX.Y.Z -m "Release X.Y.Z"
# 4. Push commit and tag (tag triggers the publish workflow)
git push && git push origin vX.Y.Z
```

If publish fails, delete and recreate the tag:
```bash
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
git tag -a vX.Y.Z -m "Release X.Y.Z" && git push origin vX.Y.Z
```

## Implementation Notes
- All imports use `.js` extension (ESM convention for TypeScript)
- tsconfig.base.json uses `"types": ["node"]` for Node.js globals
- tsup bundles ESM + CJS + DTS for each package
- Provider adapters use raw `fetch` (no SDK dependencies) with automatic retry on 429/503/529 via `fetchWithRetry` (exponential backoff, 3 total attempts)
- Two OpenAI providers: `openai` (Chat Completions API) and `openai-responses` (Responses API)
- Reasoning model support: o-series (o1/o3/o4-mini) use developer role, temperature stripping; GPT-5.x also supports reasoning but uses system role. `isOSeriesModel()` detects o-series, `supportsReasoningEffort()` detects o-series + GPT-5.x
- ChatOptions includes `effort`, `thinkingBudget`, `includeThoughts`, `toolChoice`, `maxTokens`, `stop`, `providerOptions`; all configurable on `AgentConfig` and overridable per-call via `AskOptions` (precedence: AskOptions > AgentConfig > defaults, maxTokens default: 4096). ToolDefinition supports `strict`
- `providerOptions` (`Record<string, unknown>`) is an escape hatch for provider-specific wire options. Merged last into the raw API request body via `Object.assign`, so it can override any computed field. Not portable across providers. Visible in `AgentCallInfo` traces
- `effort` is the unified cross-provider param (`'none'|'low'|'medium'|'high'|'max'`); `'none'` disables thinking/reasoning. Maps to: reasoning_effort (OpenAI o-series + GPT-5.x, `'max'`→`'xhigh'`), adaptive thinking + output_config.effort (Anthropic 4.6), output_config.effort only (Anthropic 4.5), budget_tokens fallback (Anthropic older), thinkingLevel (Gemini 3.x), thinkingBudget (Gemini 2.x). OpenAI effort values are clamped per model: `'none'`→`'minimal'` on pre-gpt-5.1 (which don't support `'none'`), `'xhigh'`→`'high'` on pre-gpt-5.4, and always `'high'` on gpt-5-pro
- `thinkingBudget` is the precise token budget override. Set to 0 to disable thinking while keeping `effort` for output control (Anthropic standalone optimization). On OpenAI, mapped to nearest effort level (≤1024→low, ≤8192→medium, >8192→high)
- `includeThoughts` returns reasoning summaries: OpenAI Responses API (`reasoning.summary: 'detailed'`), Gemini (`includeThoughts` in thinkingConfig). No-op on Anthropic and OpenAI Chat Completions
- Gemini 3.x models (gemini-3-*, gemini-3.1-*) use `thinkingLevel` string enum ('low'|'medium'|'high') instead of `thinkingBudget` integer; `'max'` caps at `'high'`; cannot fully disable thinking (`'none'` maps to model minimum: `'minimal'` or `'low'` for 3.1 Pro). Gemini 2.5 Pro supports `thinkingBudget` up to 32768 (other 2.5 models: 24576). Usage includes `thoughtsTokenCount` → `reasoning_tokens`
- `providerMetadata` on `ChatMessage` and `ProviderResponse`: opaque bag for provider-specific round-trip data. Gemini uses it to preserve `thoughtSignature` for reasoning context. OpenAI Responses API uses `providerMetadata.openaiReasoningItems` to round-trip encrypted reasoning content across multi-turn conversations
- Anthropic 4.6 models (Opus 4.6, Sonnet 4.6) use adaptive thinking (`thinking: { type: "adaptive" }` + `output_config: { effort }`) when `effort` is set. Opus 4.5 supports `output_config.effort` but not adaptive thinking. `thinkingBudget` falls back to manual mode (`thinking: { type: "enabled", budget_tokens }`) for precise control. `effort` + `thinkingBudget: 0` sends standalone `output_config.effort` without thinking block
- ProviderResponse.usage includes optional `reasoning_tokens` and `cached_tokens`
- TraceEvent includes optional `tokens: { input?, output?, reasoning? }` — emitted on `agent_call` events from `ProviderResponse.usage`. Used by Studio's cost aggregator for token tracking
- AxlStream requires `[Symbol.asyncDispose]` on iterator for TS 5.9+ compat. `promise.catch(() => {})` prevents unhandled rejection warnings when no consumer attaches a handler
- WorkflowContext.ask() implements tool calling loop with max turns, budget tracking, self-correction retry
- zodToJsonSchema helper in context.ts wraps Zod v4's built-in `z.toJSONSchema()` for tool definitions
- Telemetry: `@opentelemetry/api` is optional peer dep; `NoopSpanManager` used when disabled; `runtime.initializeTelemetry()` activates span emission; cost-per-span on all agent/workflow spans
- State: `StateConfig.store` accepts `'memory'` | `'sqlite'` | `StateStore` instance. `'redis'` is NOT a valid string — pass `await RedisStore.create(url)` as the instance. RedisStore requires the `redis` peer dep (node-redis v5, not ioredis). Private constructor enforces async factory usage
- StateStore optional methods: `saveExecution`/`getExecution`/`listExecutions` for execution history persistence, `saveEvalResult`/`listEvalResults` for eval history. All 3 built-in stores implement them. Completed/failed executions and eval results auto-persist; lazy-loaded on first access. With SQLite/Redis, history survives restarts
- `AxlRuntime.resolveProvider(uri)` resolves a `provider:model` URI to `{ provider: Provider, model: string }` using the runtime's provider registry. The eval runner uses this to auto-resolve LLM scorer providers
- `ExecutionInfo` includes `result?: unknown` field — captures the workflow return value on completed executions
- `AxlRuntime.getExecutions()` is async (`Promise<ExecutionInfo[]>`), lazy-loads historical from StateStore, merges with in-memory active executions. `getExecution(id)` falls through to store if not in memory
- `AxlRuntime.getEvalHistory()` returns eval run history (most recent first); `saveEvalResult(entry)` persists to in-memory cache + StateStore and emits `eval_result` event for live aggregation. `runRegisteredEval(name, options?)` auto-saves results; `options` accepts `{ metadata?: Record<string, unknown> }` to inject custom metadata
- `EvalHistoryEntry` type: `{ id, eval, timestamp, data }` — exported from `@axlsdk/axl`
- Eval enriched results: `EvalItem` has `duration`, `cost`, `scorerCost`, `scoreDetails` (per-scorer `ScorerDetail` with metadata/timing/cost), `metadata?` (execution context forwarded from runtime: `models`, `modelCallCounts`, `tokens`, `agentCalls`, `workflows`, `workflowCallCounts`). `EvalResult` **no longer has a top-level `workflow: string` field** (removed in 0.14.x) — workflow names live in `EvalResult.metadata.workflows: string[]` and `EvalResult.metadata.workflowCounts: Record<string, number>`, aggregated across items parallel to models/modelCounts. When no trace-derived workflows are captured (test harnesses bypassing `runtime.execute()`), `config.workflow` populates `metadata.workflows` as a fallback so the field is always present when the config has one. `MultiRunSummary.workflows: string[]` (was `workflow: string`, renamed). `EvalConfig.workflow` (input to `registerEval`/`runEval`) is unchanged. `EvalSummary` has `timing` stats. `EvalComparison` has `timing`/`cost` deltas, `ci?`/`significant?` per scorer. `EvalRegression`/`EvalImprovement` include `itemIndex`. Runner pre-allocates `evalItems` array for deterministic item ordering under concurrency. `runEval()` aggregates unique models from item metadata into `EvalResult.metadata.models`
- Scorer return type: `Scorer.score()` returns `number | ScorerResult | Promise<number | ScorerResult>`. `ScorerResult` is `{ score, metadata?, cost? }`. `llmScorer()` returns `ScorerResult` with schema metadata (e.g., reasoning) and LLM cost. `normalizeScorerResult()` converts `number | ScorerResult` to `ScorerResult`. LLM scorer attaches `cost` to thrown errors so the runner captures cost even on parse/validation failure
- `evalCompare()` accepts `EvalResult | EvalResult[]` for baseline/candidate, optional `EvalCompareOptions` with `thresholds`. Computes paired bootstrap CI (95%) on per-item score differences. Auto-calibrates threshold from `scorerTypes` metadata (0 for deterministic, 0.05 for LLM, 0.1 legacy fallback). `significant` = CI excludes zero AND |delta| >= threshold. Per-scorer entries include `pRegression?`, `pImprovement?` (bootstrap probability estimates), `n?` (paired sample count). Rounds to 3 decimal places
- `pairedBootstrapCI(differences, { nResamples?, alpha?, seed? })` — pure-math bootstrap CI, 1000 resamples default. Seeded xorshift32 PRNG for deterministic tests. Returns `BootstrapCIResult` with `lower`, `upper`, `mean`, `pRegression`, `pImprovement`
- `rescore(result, scorers, runtime, { concurrency? })` — re-runs scorers on saved outputs without re-executing the workflow. Returns new `EvalResult` with `rescored: true`, `originalId` in metadata. Strips `runGroupId`/`runIndex` from inherited metadata. Preserves per-item `metadata` (models, tokens). Only tracks scorer cost
- `aggregateRuns(runs)` — computes mean, std, min, max of per-scorer means across multiple `EvalResult[]`. Returns `MultiRunSummary` with `runGroupId`, `runCount`, aggregate `scorers`, `timing?`
- `runEval()` stores `scorerTypes: Record<string, 'llm' | 'deterministic'>` in `EvalResult.metadata`
- Memory: `ctx.remember()`/`ctx.recall()`/`ctx.forget()` backed by StateStore; semantic recall via VectorStore + embedder; `MemoryManager` coordinates both
- Guardrails: `agent({ guardrails: { input, output, onBlock, maxRetries } })`; `GuardrailError` thrown on block; self-correcting retry on `'retry'` policy
- Validate: `ctx.ask(agent, prompt, { schema, validate, validateRetries })` — per-call post-schema business rule validation on typed object; requires schema (skipped without); `ValidationError` thrown after retries; output pipeline: guardrail → schema → validate, all with accumulating context and independent retry counters. Also supported on `ctx.delegate()` (forwarded to final ask), `ctx.race()` (invalid results discarded), and `ctx.verify()` (runs after schema parse)
- `ctx.verify()` error extraction: when `fn()` throws instead of returning, `rawOutput` is undefined (fn never returned), so verify recovers data from the error's `lastOutput`. `ValidationError` (e.g., `ctx.ask()` validate exhausted): `retry.parsed` and `retry.output` populated from `err.lastOutput` (the parsed object). `VerifyError` (e.g., `ctx.ask()` schema exhausted): `retry.output` populated from `err.lastOutput` (the raw LLM string), no `retry.parsed` (schema failed). This enables the repair pattern without catching errors inside `fn()`
- Session options: `runtime.session(id, { history: { maxMessages, summarize }, persist })` for history management
- Tool handlers receive `(input, ctx)` where `ctx` is a child `WorkflowContext` for nested agent invocations (agent-as-tool pattern)
- `WorkflowContext.createChildContext()` creates isolated child contexts (shares budget/abort/traces, isolates session/streaming/steps)
- Tool middleware: approval gate → hooks.before → handler → hooks.after; approval gate skipped for direct tool.run() calls. `onToolCall` callback includes `callId` (`{ name, args, callId? }`)
- Studio: `POST /api/playground/chat` uses `ctx.ask(agent)` directly (no workflow required) — accepts `{ message, agent?, sessionId? }`, resolves agent from registered agents, streams results via WebSocket channel `execution:{id}`
- `AgentConfig.handoffs` accepts `HandoffDescriptor[] | ((ctx: { metadata? }) => HandoffDescriptor[])` for dynamic routing based on runtime metadata
- Handoff modes: 'oneway' (default, exits source loop) and 'roundtrip' (returns result to source); roundtrip handoffs include a 'message' parameter
- StreamEvent union: `token` (`data`), `tool_call` (`name`, `args`, `callId?`), `tool_result` (`name`, `result`, `callId?`), `tool_approval` (`name`, `args`, `approved`, `reason?`), `agent_start` (`agent`, `model?`), `agent_end` (`agent`, `cost?`, `duration?`), `handoff` (`source`, `target`, `mode?`), `step` (`step`, `data`), `done` (`data`), `error` (`message`)
- `ctx.delegate()` creates a temporary router agent with handoffs; single-agent case short-circuits to `ctx.ask()`. Router defaults to first candidate's model, `temperature: 0`, `maxTurns: 2`
- Studio: Hono server wraps AxlRuntime with REST API (`/api/*`) + WebSocket (`/ws`); React SPA served from `dist/client/`. Two modes: standalone CLI (`axl-studio`) and embeddable middleware (`createStudioMiddleware()` from `@axlsdk/studio/middleware`)
- `AxlRuntime.createContext(options?)` creates a `WorkflowContext` for ad-hoc tool testing, evals, and prototyping. Options: `metadata`, `budget`, `signal`, `sessionHistory`, `onToken`, `awaitHumanHandler`. Auto-wires `onTrace` to the runtime's `EventEmitter` and always creates a `budgetContext` (`limit: Infinity` by default) for cost accumulation. `ctx.totalCost` getter returns accumulated cost
- `runtime.trackExecution(fn)` wraps an async function with `AsyncLocalStorage`-based cost and metadata attribution; returns `{ result, cost, metadata }` where metadata includes `models` (unique URIs), `modelCallCounts`, `tokens` (input/output/reasoning sums), `agentCalls` count, `workflows` (insertion-ordered unique workflow names from `workflow_start` trace events), and `workflowCallCounts`. Note: the production runtime emits `workflow_start` via `ctx.log('workflow_start', ...)` → `type: 'log'` with `data.event === 'workflow_start'`; `AxlTestRuntime` emits `type: 'workflow_start'` directly. `trackExecution` handles both shapes. `trackCost(fn)` is a convenience wrapper returning `{ result, cost }`. Both used by eval runner and CLI for per-item scoping
- Studio: `POST /api/tools/:name/test` uses `tool.run(ctx, input)` with a context from `runtime.createContext()` so agent-as-tool handlers work
- Studio: AxlRuntime introspection via `registerTool()`, `registerAgent()`, `registerEval()`, `getWorkflows()`, `getTools()`, `getAgents()`, `getExecutions()`, `getRegisteredEvals()`
- Studio: `zodToJsonSchema()` exported from core for tool schema rendering in Tool Inspector (wraps `z.toJSONSchema()`)
- Studio: WebSocket uses channel multiplexing (subscribe/unsubscribe); channels: `execution:{id}`, `trace:{id}`, `trace:*`, `eval:{id}`, `costs`, `eval-trends`, `workflow-stats`, `trace-stats`, `decisions`. Protocol logic in `ws/protocol.ts`, shared between Hono handler and Node.js middleware. Channel names validated against allowlist, 256-char max, 64KB message size limit. Execution and eval channels (`execution:*`, `eval:*`) have replay buffering: events stored per-channel (max 500), late subscribers receive full history, buffers cleaned up 30s after stream completes
- Studio: Time-windowed aggregates — four aggregators (`TraceAggregator<CostData>`, `TraceAggregator<TraceStatsData>`, `ExecutionAggregator<WorkflowStatsData>`, `EvalAggregator<EvalTrendData>`) rebuild from StateStore history on startup and fold live events. Shared `AggregateSnapshots<State>` helper manages per-window snapshots (24h/7d/30d/all) and WS broadcast. Pure reducers in `server/aggregates/reducers.ts`. Periodic rebuild every 5 minutes. Execution cap: 2000 (500 for eval). `WindowSelector` component with `localStorage['axl.studio.window']` persistence shared across all aggregate panels. `POST /api/costs/reset` removed; `CostAggregator` class replaced by `TraceAggregator`. `costs` WS channel payload changed from `CostData` to `{ snapshots: Record<WindowId, CostData>, updatedAt }`
- Studio: Embeddable middleware (`@axlsdk/studio/middleware`): `createStudioMiddleware({ runtime, basePath?, serveClient?, verifyUpgrade?, readOnly?, evals? })` returns `{ handler, handleWebSocket, upgradeWebSocket, app, connectionManager, close }`. Works with Express, Fastify, Koa, NestJS, raw `http.Server`, Hono-in-Hono. `verifyUpgrade` callback for WS auth (WS upgrades bypass framework middleware). `readOnly: true` disables mutating endpoints. CORS not applied (host framework responsibility). `basePath` injected at runtime into index.html via `<base>` tag + `window.__AXL_STUDIO_BASE__`. The `handler` re-serializes `req.body` as `req.rawBody` (Buffer) before calling `getRequestListener`, so framework body parsers (Express, NestJS, Koa) that consume the raw stream don't cause Hono to see an empty body. Relies on `@hono/node-server`'s `rawBody instanceof Buffer` check in `newRequestFromIncoming` (verified @1.19.9)
- Studio: Lazy eval loading (`evals` option on middleware): `evals: 'path/*.eval.ts'` or `evals: { files: '...', conditions: ['development'] }`. Dynamically imports eval files on first eval route access (not at startup). Eval files are standalone entry points — can import from any module without circular deps. Supports glob patterns, explicit paths, and monorepo import conditions (process-wide via `module.register()`). Eval names are the file's cwd-relative path minus `.eval.*` suffix: `evals/api/accuracy.eval.ts` → `"evals/api/accuracy"`. Completely stable — names never change when other patterns or files change. Nested names with `/` must be URL-encoded in run endpoint. Coexists with `runtime.registerEval()`. Files cached for middleware lifetime (restart to pick up changes)
- Studio: `StateStore.listSessions()` optional method for session browsing (implemented in MemoryStore, SQLiteStore, RedisStore)
- Studio: `POST /api/evals/:name/run` accepts `{ runs: N }` body for multi-run execution (capped at 25). When `runs > 1`, the response includes `_multiRun: { aggregate: MultiRunSummary, allRuns: EvalResult[] }` enrichment on the result object
- Studio: `POST /api/evals/compare` is **ID-based** — body is `{ baselineId, candidateId, options? }` where each ID is `string` (single run) or `string[]` (pooled multi-run group). The server resolves IDs from `runtime.getEvalHistory()`. Returns 404 listing missing IDs if any can't be found. Keeps the wire payload tiny so host body-parser limits (Express/NestJS default 100KB) don't fire when Studio is mounted as middleware. Compare is pure computation and is **allowed in `readOnly` mode**
- Studio: `DELETE /api/evals/history/:id` removes a single entry; calls `runtime.deleteEvalResult(id)` which mutates the in-memory cache and delegates to `StateStore.deleteEvalResult?` (implemented on MemoryStore/SQLiteStore/RedisStore, returns `boolean`). Returns 404 if the id didn't exist. Blocked in `readOnly` mode
- Studio: Eval Runner panel history rows have Export (client-side `Blob` download, always available) and Delete (server DELETE, `readOnly`-gated) buttons. Delete also clears any compare selections that referenced the deleted id so stale IDs don't 404 the next compare
- Studio: `POST /api/evals/import` accepts `{ result: EvalResult, eval? }` to ingest a CLI artifact (e.g., from `axl-eval --output result.json`) into runtime history. Generates a fresh UUID for both the history entry and `result.id` so repeated imports don't collide. Eval name derivation chain: `body.eval ?? result.metadata.workflows[0] ?? legacy result.workflow ?? 'imported'` — the `metadata.workflows` step is the modern primary path; the top-level `workflow` is a back-compat fallback for pre-0.14 CLI artifacts. Imported entries are indistinguishable from native runs in the picker, run detail view, comparison, and rescore (rescore requires a matching registered eval name). Blocked in `readOnly` mode. **This is the only Studio endpoint with potentially large request bodies** — host frameworks must raise their JSON body limit if importing sizeable files
- Studio: `readOnly` mode now uses regex patterns instead of `startsWith` matching, so route allow/block decisions are precise. `POST /api/evals/compare` is allowed; `POST /api/evals/import`, `POST /api/evals/:name/run`, and `POST /api/evals/:name/rescore` remain blocked
- Studio: `GET /api/health` includes `readOnly: boolean` so the client can gate mutating UI affordances (e.g., the "Import result" button hides in readOnly mode)
- Eval CLI: `axl-eval` binary resolves runtime via three-tier: `--config <path>` → auto-detect `axl.config.*` → bare `new AxlRuntime()`. Supports `--conditions` for monorepo imports. Wraps `executeWorkflow` with `runtime.trackCost()`. Calls `runtime.shutdown()` on completion. Subcommands: `compare` (with `--threshold`, `--fail-on-regression`), `rescore`. Flags: `--runs N` for multi-run, `--output`, `--config`, `--conditions`. Config resolution utilities (tsx `tsImport`, conditions) are copied from studio (can't import from studio due to dependency direction)
- Studio: CLI (`axl-studio`) auto-detects config (`axl.config.mts` → `.ts` → `.mjs` → `.js`), expects `export default runtime`. TypeScript files loaded via tsx's `tsImport()` API — handles ESM/CJS correctly without process-wide side effects (no `register()` hooks or ESM-forcing workarounds). `--conditions` flag adds custom import conditions via resolve hook (e.g., `--conditions development` for monorepo source exports)
