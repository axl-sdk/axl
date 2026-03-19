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

// Provider types
import type { Effort, ToolChoice, ChatOptions, DelegateOptions } from '@axlsdk/axl';

// Testing
import { AxlTestRuntime, MockProvider, MockTool } from '@axlsdk/testing';

// Evaluation
import { dataset, scorer, llmScorer, defineEval } from '@axlsdk/eval';

// Studio (server API)
import { createServer, ConnectionManager, CostAggregator } from '@axlsdk/studio';
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
    types.ts         — StateStore interface
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
  types.ts           — EvalConfig, EvalResult, EvalItem, EvalSummary, EvalComparison
  dataset.ts         — dataset() factory with inline/file loading
  scorer.ts          — scorer() factory (deterministic)
  llm-scorer.ts      — llmScorer() factory (LLM-as-judge)
  define-eval.ts     — defineEval() (identity, for CLI discovery)
  runner.ts          — runEval() with concurrent execution
  compare.ts         — evalCompare() regression/improvement detection
  cli.ts             — CLI entry point

packages/axl-studio/src/
  cli.ts             — CLI entry: --port, --config, --conditions, --open flags
  resolve-runtime.ts — Config module interop (ESM default, CJS wrapping, named exports)
  server/
    index.ts         — createServer() factory, Hono app composition
    types.ts         — API types, WS message types, env bindings
    cost-aggregator.ts — Accumulates cost from trace events
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
      costs.ts       — GET/POST /api/costs
      evals.ts       — GET /api/evals, POST /api/evals/:name/run, POST /api/evals/compare
      playground.ts  — POST /api/playground/chat
    ws/
      handler.ts     — WebSocket message routing
      connection-manager.ts — Channel subscriptions + broadcast
  client/
    main.tsx         — React entry point
    App.tsx          — BrowserRouter + Sidebar + Routes (8 panels)
    index.css        — Tailwind directives + CSS variables
    lib/
      api.ts         — Typed fetch wrappers for all endpoints
      ws.ts          — WebSocket singleton with auto-reconnect
      query-client.ts — TanStack Query client
      utils.ts       — cn(), formatCost(), formatDuration(), formatTokens()
      types.ts       — Client-side types mirroring server API
    hooks/
      use-ws.ts      — useWs(channel, callback)
      use-ws-stream.ts — useWsStream(executionId)
    components/
      layout/        — Sidebar, PanelShell
      shared/        — JsonEditor, JsonViewer, CostBadge, StatusBadge, SchemaForm, StreamingText, etc.
    panels/
      playground/    — Agent Playground (chat, streaming, tool calls)
      workflow-runner/ — Workflow execution with timeline
      trace-explorer/ — Waterfall visualization of traces
      cost-dashboard/ — Cost tracking by agent/model/workflow
      memory-browser/ — Memory CRUD + semantic search
      session-manager/ — Session list, replay, handoff chain
      tool-inspector/ — Tool schemas + direct testing
      eval-runner/   — Eval execution + comparison
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
- `tests/studio/` — Studio REST API tests using Hono's `app.request()` (health, workflows, executions, sessions, agents, tools, memory, costs, decisions, evals, playground)
- `tests/smoke/` — Tarball content validation via `pnpm pack`
- `packages/axl-studio/src/__tests__/` — Inline studio unit tests (server, cost-aggregator, connection-manager, ws-handler)

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
- AxlStream requires `[Symbol.asyncDispose]` on iterator for TS 5.9+ compat
- WorkflowContext.ask() implements tool calling loop with max turns, budget tracking, self-correction retry
- zodToJsonSchema helper in context.ts wraps Zod v4's built-in `z.toJSONSchema()` for tool definitions
- Telemetry: `@opentelemetry/api` is optional peer dep; `NoopSpanManager` used when disabled; `runtime.initializeTelemetry()` activates span emission; cost-per-span on all agent/workflow spans
- State: `StateConfig.store` accepts `'memory'` | `'sqlite'` | `StateStore` instance. `'redis'` is NOT a valid string — pass `await RedisStore.create(url)` as the instance. RedisStore requires the `redis` peer dep (node-redis v5, not ioredis). Private constructor enforces async factory usage.
- Memory: `ctx.remember()`/`ctx.recall()`/`ctx.forget()` backed by StateStore; semantic recall via VectorStore + embedder; `MemoryManager` coordinates both
- Guardrails: `agent({ guardrails: { input, output, onBlock, maxRetries } })`; `GuardrailError` thrown on block; self-correcting retry on `'retry'` policy
- Validate: `ctx.ask(agent, prompt, { schema, validate, validateRetries })` — per-call post-schema business rule validation on typed object; requires schema (skipped without); `ValidationError` thrown after retries; output pipeline: guardrail → schema → validate, all with accumulating context and independent retry counters. Also supported on `ctx.delegate()` (forwarded to final ask), `ctx.race()` (invalid results discarded), and `ctx.verify()` (runs after schema parse)
- `ctx.verify()` error extraction: when `fn()` throws instead of returning, `rawOutput` is undefined (fn never returned), so verify recovers data from the error's `lastOutput`. `ValidationError` (e.g., `ctx.ask()` validate exhausted): `retry.parsed` and `retry.output` populated from `err.lastOutput` (the parsed object). `VerifyError` (e.g., `ctx.ask()` schema exhausted): `retry.output` populated from `err.lastOutput` (the raw LLM string), no `retry.parsed` (schema failed). This enables the repair pattern without catching errors inside `fn()`
- Session options: `runtime.session(id, { history: { maxMessages, summarize }, persist })` for history management
- Tool handlers receive `(input, ctx)` where `ctx` is a child `WorkflowContext` for nested agent invocations (agent-as-tool pattern)
- `WorkflowContext.createChildContext()` creates isolated child contexts (shares budget/abort/traces, isolates session/streaming/steps)
- Tool middleware: approval gate → hooks.before → handler → hooks.after; approval gate skipped for direct tool.run() calls
- `AgentConfig.handoffs` accepts `HandoffDescriptor[] | ((ctx: { metadata? }) => HandoffDescriptor[])` for dynamic routing based on runtime metadata
- Handoff modes: 'oneway' (default, exits source loop) and 'roundtrip' (returns result to source); roundtrip handoffs include a 'message' parameter
- StreamEvent union includes 'tool_approval' and handoff 'mode' field
- `ctx.delegate()` creates a temporary router agent with handoffs; single-agent case short-circuits to `ctx.ask()`. Router defaults to first candidate's model, `temperature: 0`, `maxTurns: 2`
- Studio: Hono server wraps AxlRuntime with REST API (`/api/*`) + WebSocket (`/ws`); React SPA served from `dist/client/`
- `AxlRuntime.createContext({ metadata? })` creates a lightweight `WorkflowContext` for ad-hoc tool testing and prototyping (has providers, state, MCP, telemetry — no session/streaming/budget)
- Studio: `POST /api/tools/:name/test` uses `tool.run(ctx, input)` with a context from `runtime.createContext()` so agent-as-tool handlers work
- Studio: AxlRuntime introspection via `registerTool()`, `registerAgent()`, `registerEval()`, `getWorkflows()`, `getTools()`, `getAgents()`, `getExecutions()`, `getRegisteredEvals()`
- Studio: `zodToJsonSchema()` exported from core for tool schema rendering in Tool Inspector (wraps `z.toJSONSchema()`)
- Studio: WebSocket uses channel multiplexing (subscribe/unsubscribe); channels: `execution:{id}`, `trace:{id}`, `trace:*`, `costs`, `decisions`
- Studio: `StateStore.listSessions()` optional method for session browsing (implemented in MemoryStore, SQLiteStore, RedisStore)
- Studio: CLI (`axl-studio`) auto-detects config (`axl.config.mts` → `.ts` → `.mjs` → `.js`), expects `export default runtime`. For `.ts`/`.tsx` configs, registers a `module.register()` resolve hook that forces `format: 'module'` so top-level `await` works in non-`"type":"module"` projects. `--conditions` flag adds custom import conditions via resolve hook (e.g., `--conditions development` for monorepo source exports)
