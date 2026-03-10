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
- Zod for schema validation
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
import { GuardrailError } from '@axlsdk/axl';

// Tier 2 types
import type { ToolHooks, HandoffRecord, AgentCallInfo } from '@axlsdk/axl';

// Provider types
import type { Thinking, ReasoningEffort, ToolChoice, ChatOptions } from '@axlsdk/axl';

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
- All agentic primitives are on `ctx`: `ctx.ask()`, `ctx.spawn()`, `ctx.vote()`, `ctx.verify()`, `ctx.budget()`, `ctx.race()`, `ctx.parallel()`, `ctx.map()`, `ctx.awaitHuman()`, `ctx.remember()`, `ctx.recall()`, `ctx.forget()`, `ctx.log()`
- Provider URI scheme: `provider:model` (e.g., `openai:gpt-4o`, `openai-responses:gpt-4o`)
- Tool definitions use Zod schemas for input validation
- Agents are inert definitions until called via `ctx.ask()` or `agent.ask()`
- Workflows are named async functions receiving `WorkflowContext`
- Agent `guardrails` config: `input`/`output` validators with `onBlock` policy (`'retry'` | `'throw'` | custom fn) and `maxRetries`
- Tool `requireApproval` triggers `ctx.awaitHuman()` before agent-initiated tool execution; `hooks.before`/`hooks.after` transform input/output

## Error Hierarchy
- `AxlError` (base) → `VerifyError`, `QuorumNotMet`, `NoConsensus`, `TimeoutError`, `GuardrailError`, `ToolDenied`

## File Structure
```
packages/axl/src/
  index.ts           — Barrel exports
  tool.ts            — tool() factory with retry, Zod validation
  agent.ts           — agent() factory with dynamic model/system
  workflow.ts        — workflow() factory
  config.ts          — defineConfig(), parseDuration(), parseCost(), resolveConfig()
  context.ts         — WorkflowContext with all ctx.* primitives (~700 lines)
  runtime.ts         — AxlRuntime: register, execute, stream, session
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
  cli.ts             — CLI entry: --port, --config, --open flags
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
- Reasoning model support (o1/o3/o4-mini): developer role, temperature stripping, reasoning_effort
- ChatOptions includes `thinking`, `reasoningEffort`, `toolChoice`, `maxTokens`, `stop`; all configurable on `AgentConfig` and overridable per-call via `AskOptions` (precedence: AskOptions > AgentConfig > defaults, maxTokens default: 4096). ToolDefinition supports `strict`
- `thinking` is the unified cross-provider param (`'low'|'medium'|'high'|'max'` or `{budgetTokens}`); maps to reasoning_effort (OpenAI, `'max'`→`'xhigh'`), adaptive mode + effort (Anthropic 4.6), budget_tokens (Anthropic older, `'max'`→30000), thinkingBudget (Gemini, `'max'`→24576). `reasoningEffort` is the OpenAI-specific escape hatch. `thinking` takes precedence when both set
- Anthropic 4.6 models (Opus 4.6, Sonnet 4.6) use adaptive thinking (`thinking: { type: "adaptive" }` + `output_config: { effort }`) for string levels; budget form falls back to manual mode (`thinking: { type: "enabled", budget_tokens }`) for precise control
- ProviderResponse.usage includes optional `reasoning_tokens` and `cached_tokens`
- AxlStream requires `[Symbol.asyncDispose]` on iterator for TS 5.9+ compat
- WorkflowContext.ask() implements tool calling loop with max turns, budget tracking, self-correction retry
- zodToJsonSchema helper in context.ts converts Zod schemas to JSON Schema for tool definitions
- Telemetry: `@opentelemetry/api` is optional peer dep; `NoopSpanManager` used when disabled; `runtime.initializeTelemetry()` activates span emission; cost-per-span on all agent/workflow spans
- Memory: `ctx.remember()`/`ctx.recall()`/`ctx.forget()` backed by StateStore; semantic recall via VectorStore + embedder; `MemoryManager` coordinates both
- Guardrails: `agent({ guardrails: { input, output, onBlock, maxRetries } })`; `GuardrailError` thrown on block; self-correcting retry on `'retry'` policy
- Session options: `runtime.session(id, { history: { maxMessages, summarize }, persist })` for history management
- Tool middleware: approval gate → hooks.before → handler → hooks.after; approval gate skipped for direct tool.run() calls
- Handoff modes: 'oneway' (default, exits source loop) and 'roundtrip' (returns result to source); roundtrip handoffs include a 'message' parameter
- StreamEvent union includes 'tool_approval' and handoff 'mode' field
- Studio: Hono server wraps AxlRuntime with REST API (`/api/*`) + WebSocket (`/ws`); React SPA served from `dist/client/`
- Studio: AxlRuntime introspection via `registerTool()`, `registerAgent()`, `registerEval()`, `getWorkflows()`, `getTools()`, `getAgents()`, `getExecutions()`, `getRegisteredEvals()`
- Studio: `zodToJsonSchema()` exported from core for tool schema rendering in Tool Inspector
- Studio: WebSocket uses channel multiplexing (subscribe/unsubscribe); channels: `execution:{id}`, `trace:{id}`, `trace:*`, `costs`, `decisions`
- Studio: `StateStore.listSessions()` optional method for session browsing (implemented in MemoryStore, SQLiteStore, RedisStore)
- Studio: CLI (`axl-studio`) loads user's `axl.config.ts` via dynamic import, expects `export default runtime`
