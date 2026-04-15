# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed (final review round)

- **Core:** `formatBudgetCost` (in `BudgetExceededError.message`) rendered negative values as `$-1.50` instead of `-$1.50` and silently collapsed `NaN` / `Infinity` to `$0.00`, hiding cost-accounting bug signals behind the error message. Now places the sign before `$` and emits `$NaN` / `$Infinity` / `-$Infinity` literally so budget bugs surface loudly
- **Core:** `runtime.getConfig(): Readonly<AxlConfig>` replaced with narrow `runtime.isRedactEnabled(): boolean`. `Readonly<T>` is shallow — consumers could mutate `trace.redact` at runtime via sub-object access. The narrow boolean getter is the right surface for observability consumers and removes DRY violations (the three copy-pasted `isRedactOn` helpers in Studio route files are gone)
- **Studio:** `redactChatMessage` now uses `satisfies ChatMessage` with an explicit allow-list — if `ChatMessage` gains a new required field, typecheck fails and forces a review on whether to scrub or preserve
- **Studio:** Off-path executions redact test strengthened from `expect(...).not.toBe('[redacted]')` to an exact-value assertion so a regression returning e.g. `'[redacted]-suffix'` would fail loudly
- **Studio test helper:** `createTestServer({ redact: true })` no longer also sets `trace.enabled: true` — eliminates console-spam noise during redact-mode test runs
- **Testing:** `BudgetExceededError` message formatting (8 new edge-case tests) + 26 new unit tests in `redact.test.ts` covering every redactor (stream events, eval results, pending decisions, memory values, session messages including `providerMetadata` stripping + tool call arguments, empty content, zero-length lists, literal `'[redacted]'` as stored value, immutability)

### Added (observability redaction expansion)

- **Studio:** `config.trace.redact` is now an **observability-boundary filter** that scrubs user/LLM content at three layers — trace events at emission time (existing), Studio REST route responses at serialization time (new), and Studio WebSocket broadcasts at broadcast time (new). Under `redact: true`, nine more REST routes and two streaming WS paths scrub user/LLM content while preserving structural metadata (IDs, workflow/agent/tool names, cost/token metrics, durations, timestamps, roles, keys):
  - `GET /api/executions`, `GET /api/executions/:id` — `result` / `error` scrubbed, execution metadata preserved
  - `GET /api/memory/:scope`, `GET /api/memory/:scope/:key` — values scrubbed, **keys preserved** so the Memory Browser stays navigable
  - `GET /api/sessions/:id` — `message.content`, `tool_calls[*].function.arguments`, `providerMetadata` scrubbed; `role`, `name`, `tool_call_id`, `tool_calls[*].id`, `.function.name` preserved (handoff records pass through — no content fields)
  - `GET /api/evals/history`, `POST /api/evals/:name/run` (sync), `POST /api/evals/:name/rescore` — per-item `input`, `output`, `error`, `annotations`, `scorerErrors`, `scoreDetails[*].metadata` scrubbed; `scores`, `duration`, `cost`, `scorerCost`, summary, result-level metadata preserved so the Eval Runner renders stats under compliance mode
  - `GET /api/decisions` — `PendingDecision.prompt` and `metadata` scrubbed (metadata replaced with `{ redacted: true }` sentinel); `executionId` / `channel` / `createdAt` preserved
  - `POST /api/tools/:name/test` — tool output scrubbed
  - `POST /api/workflows/:name/execute` (sync) — result scrubbed
  - Streaming: `POST /api/workflows/:name/execute` with `stream: true` and `POST /api/playground/chat` — `StreamEvent` content scrubbed before WS broadcast (`token.data`, `tool_call.args`, `tool_result.result`, `tool_approval.args/.reason`, `done.data`, `error.message`). `agent_start`/`agent_end`/`handoff`/`step` pass through (`step.data` is already a redacted TraceEvent)
- **Studio:** New helpers in `packages/axl-studio/src/server/redact.ts` — `redactExecutionInfo`, `redactExecutionList`, `redactMemoryValue`, `redactMemoryList`, `redactSessionHistory`, `redactEvalResult`, `redactEvalHistoryEntry`, `redactEvalHistoryList`, `redactPendingDecision`, `redactPendingDecisionList`, `redactStreamEvent`, and generic `redactValue`. All return the original reference when `redact=false` (reference-equality preserved). None mutate input. Used by every Studio route that returns observability data
- **Core:** `runtime.isRedactEnabled(): boolean` — narrow public getter that Studio routes call to decide whether to apply scrubbing
- **Testing:** 45 new unit tests in `packages/axl-studio/src/__tests__/redact.test.ts` covering every helper with edge cases, plus integration tests in `tests/studio/api/` asserting both on-path (scrubbed) and off-path (raw) behavior for every redacted route (executions, memory, sessions, evals, decisions, tools, playground WS, workflows)

### Changed (docs)

- **docs/observability.md:** rewrote the "PII and redaction" section to describe the observability-boundary mental model with a complete per-route scrubbed/preserved field table. Documents the observability-boundary vs data-at-rest distinction: programmatic callers of `runtime.execute()` / `StateStore` still receive raw values, and write endpoints (`PUT /api/memory`, `POST /api/sessions/:id/send`) still accept raw data
- **docs/api-reference.md:** verbose mode + redaction section rewritten to match the new scope (previously described only the trace-event filter)
- **CLAUDE.md:** redaction bullet expanded with the three-layer scope and the full helper list

### Fixed (UX polish + integration bugs)

- **Studio:** `CostData.byWorkflow.executions` was always `0` in production. `CostAggregator.onTrace`'s early-return `cost == null && !tokens` short-circuited `workflow_start` events (which have neither), so they never reached the branch that increments the counter. Workflow execution counts were effectively broken. Fixed by handling `workflow_start` bookkeeping above the early-return gate
- **Studio:** Eval Runner **blank screen on Run**. Two separate root causes converged: (a) my dev-mode documentation told users to visit `http://localhost:4400` but Vite serves the client on `4401` in dev; (b) more fundamentally, the server's `POST /api/evals/:name/run` streaming path was broadcasting the full `EvalResult` (~313KB for a 12-item eval) over WS, which hit the 64KB frame budget and got replaced with a `{ __truncated: true, ... }` sentinel, which the client then set as `currentResult`. The render path tried to read `.items` / `.summary` / etc. on the sentinel → blank screen. **Architectural fix**: the streaming done event now broadcasts only `{ type: 'done', evalResultId, runGroupId? }` — a tiny pointer. The client refetches history to resolve the pointer and rebuilds `_multiRun` aggregates locally via a shared `buildMultiRunResult()` helper. Matches "bulk data via REST, events via WS" and eliminates the frame-budget issue entirely
- **Studio:** Workflow Runner showed **stale result on back-to-back runs**. `useWsStream`'s reset effect only fired when `executionId` transitioned to a non-null value, so going back to `null` between runs left `{ done: true, result: oldResult }` in stream state. The next run's first render saw that stale state, and the panel's adoption effect copied the old result into the new run's display. Fixed with three-way transition handling in `useWsStream`
- **Studio:** Workflow Runner **events flashed and disappeared** (regression from the above fix). Fully resetting state on `id → null` wiped `events` / `tokens`, so the just-completed run's timeline vanished the instant the adoption effect nulled out `executionId`. Fix: on `id → null`, clear only the adoption gate (`done`/`result`/`error`) but **preserve** `events`/`tokens` so the completed run stays visible until the user starts a new run. Three-way transition model is commented inline so future edits don't regress either direction
- **Studio:** Trace Explorer **top-level Expand button** only expanded `agent_call` bodies (the `TextBlock` sections). Non-agent bodies (tool_approval, gate events, memory/log events) used `JsonViewer` with a static `collapsed` prop that didn't respond to the trace-wide expand signal. Fixed by introducing `TraceJsonViewer`, a trace-context-aware wrapper that reads `TraceExpandContext` and uses a `key={`trace-expand-v${version}`}` to force remount on Expand/Collapse clicks. Now the button cascades into every event body
- **Studio:** Trace Explorer showed `Tokens: in=N out=undefined` on memory events. Embedding APIs are input-only (no output or reasoning tokens), but the rendering code assumed `event.tokens.output` was always set. Fixed to conditionally render each token field only when present
- **Core/Studio:** Redaction was inconsistent across the observability surface — `workflow_end.data.result` was scrubbed in trace events but the sibling `ExecutionInfo.result` leaked raw content through `GET /api/executions`. The Trace Explorer prominently displayed the raw result at the top of a redacted execution view. Expanded the `trace.redact` semantic from "trace events" to "observability boundary" (detailed above) and fixed the three initial inconsistent routes (executions, memory, sessions), then extended to the remaining six in the final review round
- **Studio:** Sub-cent cost values collapsed to `$0.0000` in the UI — embedder costs can be as small as `$6e-7` per call. `formatCost` now uses tiered precision: exactly 0 → `$0.00`, `< $0.000001` → `< $0.000001` noise sentinel, `< $0.0001` → scientific (`$1.50e-7`), `< $0.01` → 6 decimals (`$0.000095`), `>= $0.01` → 2 decimals
- **Studio:** Cost Dashboard tables now support **user-driven column sort** — clicking a sortable header toggles ascending/descending on that column. Refactored `CostTable` to a row-based generic API with per-column `sortKey` descriptors. Applied to all four breakdowns (by Agent, by Model, by Workflow, by Embedder) plus the Retry Overhead table
- **Studio:** Dev server dev config (`packages/axl-studio/axl.config.mts`, gitignored) now configures `InMemoryVectorStore` + a `MockEmbedder` that reports realistic usage, registers a `rag-workflow` that does semantic recall, a `memory-heavy-workflow` that does multi-recall + write-back, a `budget-demo-workflow` that trips a tight budget mid-loop, and a `rag-eval` that exercises the memory cost path end-to-end. Seed populates 10 facts via `ctx.remember({embed:true})` + runs the memory workflows so the Cost Dashboard's "Memory (Embedder)" section has data on first load. `AXL_DEV_REDACT=1 pnpm --filter @axlsdk/studio dev` enables redact at the dev server so you can manually verify compliance-mode rendering
- **Studio:** `packages/axl-studio/src/client/components/shared/TraceEventList.tsx` (new) — extracted the row + body renderer + expand/collapse state management + `TraceExpandContext` provider + `TextBlock`, `AgentCallBody`, `ToolApprovalBody`, `GateCheckBody`, `GenericBody` helpers into a single shared component. Both the Trace Explorer and Workflow Runner timeline now render `<TraceEventList events={...} />` — ~300 lines of duplicated JSX removed, and the Workflow Runner timeline now has feature parity with the Trace Explorer (system prompt / prompt / response collapsible blocks, retry badges, top-level Expand button, amber tint on retry/gate-failure events)

### Breaking changes

- **Core:** `Embedder.embed()` return type changed from `Promise<number[][]>` to `Promise<EmbedResult>`, where `EmbedResult = { vectors: number[][]; usage?: EmbedUsage }` and `EmbedUsage = { tokens?: number; cost?: number; model?: string }`. This lets embedders report cost so it flows through cost aggregation. The `OpenAIEmbedder` now computes cost from `response.usage.prompt_tokens` × a hardcoded pricing table (`text-embedding-3-small` $0.02/1M, `text-embedding-3-large` $0.13/1M, `text-embedding-ada-002` $0.10/1M). Users with a custom `Embedder` implementation must wrap their existing return value:

  ```ts
  import type { Embedder, EmbedResult } from '@axlsdk/axl';

  // Before:
  class MyEmbedder implements Embedder {
    readonly dimensions = 1536;
    async embed(texts: string[]): Promise<number[][]> {
      const vectors = await myEmbed(texts);
      return vectors;
    }
  }

  // After:
  class MyEmbedder implements Embedder {
    readonly dimensions = 1536;
    async embed(texts: string[]): Promise<EmbedResult> {
      const vectors = await myEmbed(texts);
      return { vectors }; // `usage` optional — omit if you don't compute cost
    }
  }
  ```

- **Core:** `MemoryManager.remember()` return type changed from `Promise<void>` to `Promise<RememberResult>` (`{ usage?: EmbedUsage }`), and `MemoryManager.recall()` changed from `Promise<unknown | VectorResult[] | null>` to `Promise<RecallResult>` (`{ data: unknown | VectorResult[] | null; usage?: EmbedUsage }`). `MemoryManager` is an internal coordination class — the only in-tree caller is `WorkflowContext`, which has been updated. The public user-facing surface (`ctx.remember()` / `ctx.recall()`) is unchanged: `ctx.recall()` still returns the raw data value. If you were constructing `MemoryManager` directly and calling its methods (rare), update call sites to destructure `{ data }` / `{ usage }`.

### Fixed (user scenario review round)

- **Core:** `CostData.byWorkflow.cost` was always `$0` in production — a pre-existing bug silently masked by tests that passed `workflow` explicitly. `emitTrace` only stamped `workflow` on `workflow_start` / `workflow_end` events; every other event type (`agent_call`, `tool_call`, `log`, `guardrail`, etc.) had `event.workflow` undefined, so the cost-aggregator's `byWorkflow` bucket never received any cost. Fix: `emitTrace` now auto-stamps `workflow: this.workflowName` on every event from a workflow context (callers can still override via `partial.workflow`). The Studio Cost Dashboard "Cost by Workflow" section now actually works
- **Core:** Semantic memory cost (`ctx.remember({embed:true})`, `ctx.recall({query})`) was riding the trace-event rail for `trackExecution` but **bypassing `budgetContext`**, so `ctx.budget({ cost, onExceed: 'hard_stop' })` silently failed to enforce the limit for RAG workloads. Fix: extracted `_accumulateBudgetCost(amount)` helper and call it from both the `agent_call` path and memory ops on success + partial-failure paths. Budgets now enforce across every cost source
- **Core:** `ctx.remember` / `ctx.recall` didn't check `budgetContext.exceeded` at the top of each call, so operations queued after a hard_stop trigger kept running. Added the same pre-check gate that `ctx.ask` uses — throws `BudgetExceededError` before hitting the embedder when a prior op already breached the budget
- **Core:** `MemoryManager.remember` could lose cost attribution on a partial failure. If `embedder.embed` succeeded (API call completed, user billed) but the downstream `vectorStore.upsert` failed, the usage data was silently discarded and the context's error-path trace event had no cost. Fix: `MemoryManager.remember` catches the upsert error, attaches the usage to it as a non-enumerable `axlEmbedUsage` property, and re-throws. `context.ts` reads this side-channel on the error path and still attributes the cost (plus feeds it into budget). Users with heavy semantic write workloads no longer see cost-tracking drift from their real provider bill during transient vector-store failures
- **Core:** `Embedder.embed(texts, signal?)` now accepts an optional `AbortSignal` as a second parameter, `MemoryManager.remember` / `recall` accept it as a new optional 6th param, and `WorkflowContext` passes a composed signal (user-abort + budget-hard_stop via `AbortSignal.any`) through on every memory op. User cancellations and hard_stop budget triggers now propagate to in-flight embedder fetches instead of completing silently. Adding the param to `Embedder` is non-breaking — existing custom impls that omit the second argument still satisfy the interface
- **Core:** `runtime.trackExecution` return type documents that `metadata.tokens` is narrowly scoped to agent prompt/completion/reasoning — embedder tokens are deliberately NOT summed in because they're a different category with different pricing. Consumers wanting embedder token totals should read `data.usage.tokens` on `memory_remember`/`memory_recall` trace events directly
- **Testing:** 4 new tests added covering: workflow auto-stamp on all events (`trace-events.test.ts`), budget accumulation from memory ops (`memory.test.ts`), budget pre-check gate on `ctx.remember`/`ctx.recall` (`memory.test.ts`), partial-failure cost preservation when `vectorStore.upsert` fails after successful embed (`memory.test.ts`)
- **Docs:** `CLAUDE.md` updated with embedder signal support, budget + memory cost integration, workflow auto-stamping, and `trackExecution.metadata.tokens` scope semantics

### Fixed (memory cost review round)

- **Core:** `EmbedResult`, `EmbedUsage`, `RememberResult`, `RecallResult` are now exported from `@axlsdk/axl`. Without these, users implementing a custom `Embedder` couldn't type the required return shape — the migration path in the breaking-change note was literally uncompilable. Caught in review
- **Studio:** `CostAggregator` was silently dropping memory events when the embedder reported tokens but no cost (local embedders, Azure proxies, models outside the hardcoded pricing table). The early-return gate `if (event.cost == null && !event.tokens) return` short-circuited before the `byEmbedder` bucketing branch could run. Fix: `context.ts` now mirrors `usage.tokens` to top-level `event.tokens.input` on `memory_remember`/`memory_recall` events so the gate allows them through. The aggregator now guards the `totalTokens` accumulation by `event.type === 'agent_call'` so embedder tokens don't conflate with agent prompt tokens in the UI summary
- **Eval:** `extractUserCost` rejected `NaN` and `Infinity` but accepted negative numbers. A negative cost would shrink `totalCost` below the budget-limit check, letting a buggy/malicious workflow run unbounded. Now requires `cost >= 0`. Also added `console.warn` when a user-supplied cost or metadata value is rejected as invalid — previously the type violation was silently swallowed
- **Eval:** `extractUserMetadata` accepted `Date`, `Map`, `Set`, `Error`, and class instances (all satisfy `typeof === 'object'` but aren't `Record<string, unknown>`). Added a prototype check that rejects any object whose prototype isn't `Object.prototype` or `null`
- **Core:** `log` event redaction collapsed every nested object to the string `'[redacted]'`, including `data.usage` on memory events. This meant `byEmbedder` could only bucket to `'unknown'` under redaction and token counts were lost. Redaction now walks one level into nested objects, preserving numeric/boolean fields (`usage.tokens`, `usage.cost`) while still scrubbing string fields (`usage.model`, which could carry tenant info)
- **Core:** `OpenAIEmbedder` now uses `fetchWithRetry` for consistency with every other provider adapter (`openai`, `openai-responses`, `anthropic`, `gemini`). A transient 429/503/529 on the embeddings endpoint was previously fatal; it now gets exponential-backoff retry with Retry-After support. Pre-existing gap, surfaced during review of the new cost-attribution path
- **Core:** `OpenAIEmbedder` now omits the `usage` field entirely when the API response has no usage block (Azure compat mode, custom proxies that strip usage). Previously a bare `{ model }` usage would trigger downstream `byEmbedder` bucketing with zero-everything entries. Clean short-circuit at the source
- **Docs:** `docs/observability.md` documents the memory cost attribution path — trace event shape, top-level cost/tokens, `byEmbedder` bucket, and explicit notes about redaction semantics (one-level walk preserving numerics, top-level numeric metrics never scrubbed, callers needing stricter compliance should filter via `onTrace` rather than rely on redaction). `docs/api-reference.md` now mentions cost tracking on the `ctx.remember` and `ctx.recall` documentation blocks
- **Testing:** 7 new tests added across `memory.test.ts`, `runner.test.ts`, and `cost-aggregator.test.ts` covering: negative cost rejection, NaN/Infinity cost rejection, zero cost preservation, exotic metadata rejection (Date/Map/Set/class), tokens-without-cost byEmbedder bucketing, numeric usage preservation under redaction, and embedder failure path not attributing cost
- **Nits:** Pricing table formatted consistently (`0.10` instead of `0.1` for `text-embedding-ada-002`). `CHANGELOG.md` migration snippet now shows the required import line (`import type { Embedder, EmbedResult }`). Unused-parameter underscore prefix removed from `extractUserCost(result, label)` / `extractUserMetadata(result, label)` now that `label` is actually used in the warning messages

### Added

- **Core:** Semantic memory operations (`ctx.remember({embed:true})`, `ctx.recall({query})`) now attribute embedder cost through the existing trace-event cost rail. `OpenAIEmbedder` reports `{ tokens, cost, model }` on every embed call; `MemoryManager` propagates the `usage` out; `WorkflowContext` emits it as the top-level `cost` field on the `memory_remember` / `memory_recall` log event (and nests the full `usage` object in `event.data.usage` for trace-explorer visibility). Cost flows automatically through `runtime.trackExecution()`, so per-eval and per-execution cost totals now include semantic memory spend. Previously embedding costs were silently excluded from all observability — a real accounting gap for users with heavy semantic recall workloads
- **Studio:** `CostData.byEmbedder` — embedder cost broken down by model, mirroring `byModel` for agent calls. Each entry carries `{ cost, calls, tokens }`. Emitted by the server `CostAggregator` and surfaced in the Cost Dashboard as a new "Memory (Embedder)" section that appears only when there's at least one embedder call on record. Optional on the client type so older servers continue to work via graceful fallback
- **Eval:** Runner hardening — `evalItem.cost` and `evalItem.metadata` are now type-guarded against non-number cost values and non-object metadata returned by user workflows. Previously `{ cost: "free" }` or `{ metadata: ["array"] }` would silently corrupt downstream totals via `NaN` or shape violations. TypeScript types still document `cost?: number` / `metadata?: Record<string, unknown>` as the contract, but the runner now validates at runtime at the trust boundary with the user's `executeWorkflow` callback

### Fixed (post-review round)

- **Core:** `config.trace.redact` was not scrubbing `workflow_start.data.input`, `workflow_end.data.result`, or `workflow_end.data.error` — a regression introduced when these events moved from `log` form to first-class types (the log-form redaction path used to cover them). Added dedicated redact branches for both, preserving structural fields (`status`, `duration`, `aborted`) while scrubbing user-derived content
- **Core:** `logTraceEvent` console output for `workflow_start` / `workflow_end` was still reading the old log-form shape (`data.workflow`) and always printing "completed" regardless of actual status. Now reads from the top-level `event.workflow` and surfaces the real status (`completed` / `failed` / `aborted`)
- **Core:** `AbortError` detection in `runtime.execute()` / `runtime.stream()` was `err instanceof DOMException && err.name === 'AbortError'` — strict enough to miss plain `Error` instances with `name === 'AbortError'` thrown by `signal.throwIfAborted()` or non-fetch code paths. Now uses `(err as {name?: unknown})?.name === 'AbortError'`, so `workflow_end.data.aborted: true` fires for every cancellation path
- **Core:** `runtime.trackExecution(fn, { captureTraces: true })` now attaches the captured `TraceEvent[]` to the thrown error as a non-enumerable `axlCapturedTraces` property when `fn()` rejects. Previously captured traces were silently discarded on error — exactly when they're most valuable. The eval runner reads this side-channel to populate `EvalItem.traces` on failed items
- **Core:** `ctx.remember()`, `ctx.recall()`, and `ctx.forget()` now emit their audit-trail `log` events on BOTH success and failure paths, with an `error` field on the failure variant. Previously failed operations were invisible to the audit trail — the exact scenario where a compliance officer most needs to know
- **Core:** New trace data types (`WorkflowStartTraceData`, `WorkflowEndTraceData`, `AgentCallTraceData`, `GuardrailTraceData`, `SchemaCheckTraceData`, `ValidateTraceData`, `ToolCallTraceData`, `ToolApprovalTraceData`, `HandoffTraceData`, `DelegateTraceData`, `VerifyTraceData`, `TraceEventType`) are now exported from `@axlsdk/axl`. Previously declared in `types.ts` but missing from the barrel, so consumers couldn't narrow `TraceEvent.data` via named types
- **Core:** `ExecuteOptions` is now exported from `@axlsdk/axl` so callers can type their `runtime.execute()` / `runtime.stream()` option bags
- **Core:** `HandoffTraceData.duration` was marked optional but is always emitted at the terminal point of the handoff — now required
- **Core:** `WorkflowContext._emitWorkflowStart` / `_emitWorkflowEnd` now fire INSIDE the `axl.workflow.execute` OTel span context (previously emitted before `withSpanAsync` started). Downstream OTel exporters that correlate trace events to spans via active-context now see them on the correct span
- **Studio:** `activeRuns` map in `/packages/axl-studio/src/server/routes/evals.ts` was module-scoped, causing multiple `createStudioMiddleware()` instances in the same process (multi-tenant deployments, concurrent unit tests) to collide on run IDs and leak `AbortController`s across middleware lifecycles. Now scoped inside `createEvalRoutes` as a closure-local map
- **Studio:** `CostData.retry` was declared non-optional on the client type, which conflicted with the graceful `?? emptyRetry()` fallback in the Cost Dashboard for back-compat with older servers. Now optional, matching reality
- **Studio:** `eval-store.startEvalRun` had no try/catch around the `apiStartEvalRun` POST — if the server rejected the request, the state machine was stuck in `running` with no `evalRunId`. Now catches and transitions to `status: 'error'` so the UI recovers
- **Studio:** Cost Dashboard "Retry Overhead" table had a dead "Calls (est.)" column showing `—` placeholders. Replaced with real per-reason call counts (`schemaCalls`, `validateCalls`, `guardrailCalls`, `primaryCalls`) plumbed through `CostAggregator` and exposed on `CostData.retry`
- **Studio:** `MAX_WS_FRAME_BYTES` constant is now shared between `connection-manager.ts` (outbound broadcast truncation) and `protocol.ts` (inbound message reject). Previously duplicated as two separate `65536` literals that could drift
- **Studio:** `filterTraceEvent` JSDoc now references `TraceEvent` from `@axlsdk/axl` and shows a tenant-scoping example using the discriminated union — previously the `(event: unknown)` signature left integrators guessing
- **Studio:** `eval-${Date.now()}-${randomUUID().slice(0,8)}` run ID format replaced with plain `eval-${randomUUID()}` — the timestamp leaked server clock, the truncated UUID defeated the point of a UUID

### Breaking changes

- **Core:** `workflow_start` and `workflow_end` are now emitted as first-class `TraceEvent` types — previously they were emitted as `type: 'log'` events with `data.event === 'workflow_start'` / `'workflow_end'`. Consumers that filtered via the old log-form shape must switch to `event.type === 'workflow_start'` / `'workflow_end'`. The event's `workflow` name now lives on the top-level `event.workflow` field; `data` carries the new `WorkflowStartTraceData { input }` / `WorkflowEndTraceData { status, duration, result?, error?, aborted? }` shapes. `trackExecution` and `AxlTestRuntime` have always handled both shapes; this change eliminates the divergence so consumers using the discriminated union actually receive these events in production. Additionally, `runtime.stream()` now emits `workflow_start` — previously it was silently omitted from the stream path (pre-existing bug, fixed alongside the unification)

### Added

- **Core:** `runtime.trackExecution(fn, { captureTraces: true })` now captures the full `TraceEvent[]` observed during `fn()` and returns it on the result, alongside the existing cost/metadata/models/workflows aggregates. Useful for per-item eval trace capture, test assertions, and debugging. Verbose-mode `agent_call.data.messages` snapshots are stripped from captured traces to keep memory bounded — subscribe to `runtime.on('trace', ...)` directly for those
- **Eval:** `runEval({}, executeWorkflow, runtime, { captureTraces: true })` captures per-item trace events via `trackExecution` and stores them on `EvalItem.traces`. Off by default. Scope is per-item via `AsyncLocalStorage` so concurrent items don't cross-contaminate. Works with any `executeWorkflow` callback that uses `runtime.execute()` or `ctx.ask()` internally
- **Studio:** Eval Runner item detail panel renders per-item traces inline when `captureTraces` is on — a collapsible list with one row per event (color-coded by type, agent/tool labels, duration, cost) that expands to a full JSON view on click
- **Core:** `ctx.remember()`, `ctx.recall()`, and `ctx.forget()` now emit `log` events with `{ event: 'memory_remember' | 'memory_recall' | 'memory_forget', key, scope, hit?, resultCount?, embed? }` — operation-only audit trail for compliance (values are never in the trace, so there's no PII leak surface). The `key` field is also scrubbed under `config.trace.redact`
- **Core:** New exported types `WorkflowStartTraceData`, `WorkflowEndTraceData`
- **Studio:** `createStudioMiddleware` accepts `filterTraceEvent?: (event, metadata) => boolean` — a per-connection broadcast filter for multi-tenant deployments. Combined with `verifyUpgrade` returning `{ allowed, metadata }`, lets integrators scope the trace firehose to the authenticated user's tenant/role. Filter errors are treated as `drop` (fail-closed) so a buggy predicate can't accidentally leak events cross-tenant. Replay buffers re-apply the filter on late subscribers
- **Studio:** `verifyUpgrade` callback evolved from `(req) => boolean | Promise<boolean>` to also accept `(req) => { allowed: boolean, metadata?: unknown } | Promise<...>`. Backward compatible — a bare boolean return still works. When the object form is used, the attached `metadata` is made available to `filterTraceEvent` on every outbound event
- **Studio:** `CostData.retry` — decomposes agent_call cost by retry reason. `primary` is first-attempt call cost; `schema` / `validate` / `guardrail` are retry-attempt costs bucketed by which gate triggered the retry; `retryCalls` is the total retry count across all reasons. Surfaces via `/api/costs` and the Cost Dashboard UI (new "Retry Overhead" section, shown only when retries have happened)
- **Core:** `ctx.verify()` now emits a `verify` trace event with `{ passed, attempts, lastError? }` on each terminal outcome (success, exhaustion, fallback). The type existed in `TraceEvent` and Studio's trace-utils referenced it, but nothing was actually emitting it — the Trace Explorer would silently miss `ctx.verify()` calls

### Fixed

- **Core:** `onTrace` consumer exceptions no longer crash the workflow. A throwing trace handler (e.g. a buggy logger/sink/metrics forwarder) is now caught inside `emitTrace`, logged via `console.error`, and the workflow continues. Previously a single bad handler could silently abort an in-flight execution
- **Core:** Redaction coverage was incomplete — `config.trace.redact` now also scrubs `tool_call.data.args` + `data.result`, `tool_approval.data.args`, `handoff.data.message` (roundtrip), and string fields on `log` events (while preserving the `event` discriminator, numeric fields, and boolean fields). Previously a compliance deployment could still leak PII via tool call arguments, approval contexts, and system logs like `await_human` prompts or user-emitted `ctx.log` values
- **Core:** Redaction of `agent_call.data.messages` was producing a `string` in place of a `ChatMessage[]` — now returns a `ChatMessage[]` with a single stub entry carrying the redacted count, so downstream narrowers (including the Studio Trace Explorer) iterate safely
- **Core:** Aborted workflows now set `aborted: true` on `workflow_end` (inside `WorkflowEndTraceData`) so consumers can distinguish cancellation / budget hard_stop from genuine errors. Previously all aborts fell into `status: 'failed'` with no signal of cancellation intent
- **Core:** `structuredClone` of `currentMessages` for verbose trace snapshots is now wrapped in try/catch — exotic `providerMetadata` (Buffer, Function, symbols) that the cloner can't handle falls back to a shallow copy with a console warning, instead of crashing the workflow on a debug-mode snapshot
- **Core:** Nested child contexts (agent-as-tool) now stamp `parentToolCallId` on every trace event emitted from the child. Lets consumers reconstruct call graphs by joining nested agent/tool events back to the outer `tool_call` that spawned them. Previously there was no correlation key between parent and child traces
- **Core:** `runtime.stream()` was silently dropping `tool_approval` stream events after the internal trace event was renamed from `tool_denied`-with-`denied:false` to a dedicated `tool_approval` type. The stream handler has been updated to route the new trace type, and a regression test exercising the full trace→stream pipeline locks it in. Also removed an adjacent bug where `tool_denied` (for unknown-tool hallucinations) was manufacturing bogus `tool_approval { approved: false }` stream events
- **Studio:** WebSocket outbound broadcasts now enforce a 64KB soft cap via `truncateIfOversized` in `connection-manager.ts`. Verbose-mode `agent_call` events with large `messages[]` snapshots that exceed the frame budget are replaced with a placeholder carrying `{ __truncated: true, originalBytes, maxBytes, hint }` — the structural fields (`type`, `step`, `agent`, `tool`) are preserved so the Trace Explorer still renders the event row, just with an explicit truncation marker instead of silently dropping the frame or closing the socket
- **Testing:** `AxlTestRuntime` now accepts an `AxlConfig` via its options (`new AxlTestRuntime({ config: { trace: { level: 'full', redact: true } } })`). Previously the test runtime hardcoded an empty config, so `trace.level` and `trace.redact` behavior couldn't be validated in unit tests — tests and production drifted silently. The config is threaded into the underlying `WorkflowContext`, so verbose snapshots and redaction policy now work identically in tests and prod
- **Core:** `agent_call.duration` was cumulative from the start of `ctx.ask()` instead of per-turn, which read misleadingly now that `data.turn` surfaces the turn counter. Each `agent_call` event now reports the wall-clock time of that specific turn's provider call
- **Core:** `config.trace.redact` now redacts the `reason` field on `guardrail`, `schema_check`, and `validate` events — validator-supplied `reason` strings can trivially echo user input (e.g. "Value 'john@acme.com' is not a valid slug") and were previously leaking through
- **Core:** Verbose `agent_call.data.messages` snapshot is now a deep clone (`structuredClone`) instead of a shallow copy, so async consumers never observe post-mutation state if messages are pushed to after the snapshot
- **Core:** Redacted `agent_call.data.messages` now preserves the `ChatMessage[]` shape (single stub entry with the redacted count) instead of collapsing to a string — downstream narrowers that iterate messages no longer crash when redaction is enabled
- **Core:** Input guardrail trace events now carry `attempt: 1, maxAttempts: 1` for shape consistency with output guardrails, so consumers only need one narrower across all guardrail events
- **Core:** `ctx.delegate()` single-agent short-circuit and multi-agent router now both emit `delegate` events with a consistent `reason` field (`'single_candidate'` or `'routed'`)

### Added

- **Core:** `HandoffTraceData` gained `source` (mirrors `event.agent` for join-convenience) and `message` (the `message` arg the source agent passed when invoking `handoff_to_X` in roundtrip mode) — lets consumers see *why* an agent chose to delegate, not just that it did. `message` is subject to `config.trace.redact`
- **Core:** `TraceEventBase` gained optional `parentToolCallId` — set on every trace event emitted from a child context spawned by a tool handler (via `createChildContext(parentToolCallId)`). Enables joining nested agent-as-tool call graphs back to the outer `tool_call`. The Studio Trace Explorer indents nested events via `getDepth()` so the hierarchy is visually obvious
- **Core:** New per-type data shapes exported: `VerifyTraceData { attempts, passed, lastError? }` is now actually emitted by `ctx.verify()`, not just declared
- **Core:** `TraceEvent` is now a discriminated union over the `type` discriminator — consumers that narrow via `type` get statically-typed access to `data` and event-specific fields. Prevents silent drift when trace data shapes change: for example, the runtime stream handler now fails to compile if `AgentCallTraceData` fields are renamed. New per-type data shapes exported: `ToolCallTraceData`, `HandoffTraceData`, `DelegateTraceData`, `VerifyTraceData` (alongside the existing `AgentCallTraceData`, `GuardrailTraceData`, `SchemaCheckTraceData`, `ValidateTraceData`, `ToolApprovalTraceData`)
- **Core:** `ExecuteOptions.awaitHumanHandler` — `runtime.execute()` and `runtime.stream()` now accept an in-process approval handler, consistent with `CreateContextOptions`. Lets tests and embedded use cases handle `requireApproval` decisions inline instead of suspending execution and polling `getPendingDecisions()`
- **Core:** Trace events are now observability-grade. The `agent_call` event carries the resolved system prompt, resolved model params (temperature, maxTokens, effort, thinkingBudget, includeThoughts, toolChoice, stop), provider `thinking_content`, the 1-indexed loop `turn`, and a `retryReason` tag (`'schema' | 'validate' | 'guardrail'`) when the call was triggered by a failed gate on the previous turn. Dynamic system prompts are captured as they resolved at execution time, not as source code
- **Core:** New `schema_check` trace event emitted on every schema parse (pass and fail) — closes the largest observability gap, where schema failures were previously silent retries. Event includes `{ valid, reason?, attempt, maxAttempts, feedbackMessage? }` mirroring the existing `validate` and `guardrail` events
- **Core:** All three gate events (`guardrail`, `schema_check`, `validate`) now include `attempt` (1-indexed) and `maxAttempts` counters so consumers can tell "attempt 2 of 3" without cross-referencing siblings. They also include `feedbackMessage` — the exact corrective message about to be injected into the conversation — populated only when the gate failed and a retry is happening. This gives the trace explorer visibility into what the LLM sees between retry attempts, which was previously invisible
- **Core:** New `tool_approval` trace event emitted from the approval gate on both outcomes — `{ approved: boolean, args, reason? }`. Replaces the previous overloaded `tool_denied` event which was being (mis-)used to signal approval success with `{ denied: false }`. `tool_denied` is still emitted for the pre-existing "tool not available" path
- **Core:** `delegate` trace event is now emitted on the single-agent short-circuit path (with `reason: 'single_candidate'`), not just when a router is created. Consumers always see the routing decision
- **Core:** Verbose trace mode — `config.trace.level === 'full'` adds a complete `ChatMessage[]` snapshot to each `agent_call` event under `data.messages`, giving exact byte-level visibility into what the model saw on every turn (growing with tool results and retry feedback). Off by default — enable for debugging
- **Core:** `config.trace.redact` now also redacts `system`, `thinking`, `messages` fields on `agent_call` events and `feedbackMessage` on gate events, in addition to the existing `prompt`/`response` redaction. Structural fields (`turn`, `attempt`, `maxAttempts`, `params`) remain visible so traces stay useful when redacted
- **Core:** New exported types: `TraceEventType`, `AgentCallTraceData`, `GuardrailTraceData`, `SchemaCheckTraceData`, `ValidateTraceData`, `ToolApprovalTraceData`
- **Studio:** Trace Explorer panel renders the enriched events natively — dedicated collapsible sections for system prompt, prompt, response, thinking, verbose message history; chip-style param display; `attempt/maxAttempts` badge on gate events; retry badge + amber row tint on agent_call events that were triggered by a prior gate failure; failed gate events also tint amber so retry clusters visually pop in the waterfall. Retry feedback messages the LLM sees between attempts are rendered prominently in the expanded gate body
- **Eval:** `runEval()` accepts an optional 4th argument `RunEvalOptions` with `onProgress` callback (fired after each item completes) and `signal` (AbortSignal for cancellation). New types `EvalProgressEvent` and `RunEvalOptions` exported from `@axlsdk/eval`
- **Core:** `runtime.runRegisteredEval()` now accepts `onProgress` and `signal` options, forwarded to `runEval()`
- **Studio:** Eval run endpoint (`POST /api/evals/:name/run`) supports `stream: true` in the request body — returns `{ evalRunId }` immediately and broadcasts per-item and per-run progress events over a new `eval:` WebSocket channel. Synchronous mode (default) is unchanged for backward compatibility
- **Studio:** Cancel endpoint `POST /api/evals/runs/:evalRunId/cancel` aborts an active streaming eval run
- **Studio:** Eval execution state now survives route navigation — a global store (outside React component lifecycle) tracks running evals, so navigating away and returning to the eval panel shows the running progress or completed result instead of a blank panel
- **Studio:** Eval running view shows a progress bar (items completed), run counter (for multi-run), elapsed timer, and cancel button instead of a static spinner

## [0.14.0] - 2026-04-14

### Breaking changes

- **Eval:** `EvalResult.workflow` (top-level single-string field) has been **removed**. Workflow names now live exclusively in `EvalResult.metadata.workflows: string[]` alongside `metadata.workflowCounts: Record<string, number>`, parallel to how `metadata.models` / `metadata.modelCounts` already work. This is a deliberate consolidation: workflow is execution metadata (what ran), not a definitional property of the eval (what the eval *is*), and the previous single-string field couldn't honestly represent multi-workflow runs.

  **Migration:**
  - Replace `result.workflow` reads with `result.metadata.workflows?.[0]` (primary workflow) or iterate `result.metadata.workflows` (full list).
  - `MultiRunSummary.workflow` is also renamed to `MultiRunSummary.workflows: string[]`.
  - `EvalConfig.workflow` (the config input for `registerEval` and `runEval`) is unchanged — still a single string. Only the *result* type changed.
  - `axl-eval --output` artifacts generated by older versions still work when imported into Studio — the Studio client's `getResultWorkflows()` helper falls back to the legacy top-level field. New CLI outputs drop the field entirely.
  - The fallback to `config.workflow` is preserved inside the runner: when no trace-derived workflows are captured (e.g. test harnesses using `AxlTestRuntime` that bypass `runtime.execute()`), `config.workflow` populates `metadata.workflows` so the field is always present when the config has one.

### Fixed

- **Studio:** Unified panel header typography, padding, and row height across all 8 panels. Headers no longer shift vertical position when switching tabs. Fixes a latent `truncate` bug where header descriptions with nested `<span className="truncate">` children silently broke the outer block's inline flow (inner `truncate` forces `display: block`, which `white-space: nowrap` cannot traverse); inner truncates removed — the outer wrapper's `overflow: hidden` + inherited `white-space: nowrap` handles clipping with a single trailing ellipsis
- **Studio:** `CommandPicker` popover now flips above the trigger when there isn't enough room below, so it no longer clips offscreen on short viewports
- **Studio:** `CommandPicker` keyboard arrow navigation no longer snaps back to the selected row after every keystroke — a user-moved flag stops the reset-to-selection effect once the cursor has been manually moved
- **Studio:** `CommandPicker` Tab now closes the popover instead of leaving a ghost listbox behind focus; ⌘K shortcut also guards `contentEditable` surfaces (Monaco, CodeMirror) and lets users toggle from inside the picker's own search input
- **Studio:** `CommandPicker` accessibility: correct `aria-activedescendant` on the listbox, `aria-selected` now reflects highlight (not the persisted value), `aria-controls` ties the trigger to the popover id, and the search input has an explicit `aria-label`
- **Studio:** Run-count stepper fixes a double-commit race between Enter keydown and blur (Enter could fire `onChange` twice) and keeps the draft in sync with external `value` changes while not editing
- **Studio:** `POST /api/evals/compare` no longer hits host body-parser limits when Studio is mounted as middleware. Compare now accepts `{ baselineId, candidateId, options? }` (each ID is `string` for a single run or `string[]` for a pooled multi-run group), resolving full results from runtime history server-side. Drops the wire payload from ~150KB to ~100B and fixes `PayloadTooLargeError: request entity too large` reported when comparing eval results behind NestJS/Express. Compare is also now allowed in `readOnly` mode (it's pure computation)

### Added

- **Studio:** `PanelHeader` — canonical header component for every panel, owning title typography, description slot, and action row styling. Widens the description prop to `ReactNode` so panels can pass metadata chips (counts, selected-item summary) as a live subhead. Locks a minimum row height and always reserves the description line (non-breaking space fallback) so headers no longer jitter between tall/short variants across tabs
- **Studio:** `CommandPicker` — reusable command-palette-style picker with search, keyboard nav, and ⌘K shortcut. Two variants: `picker` (primary action with search icon and optional kbd hint) and `filter` (compact dropdown for table/view filters). Used across Agent Playground, Workflow Runner, Eval Runner, and Trace Explorer
- **Studio:** Inline run-count stepper in the Eval Runner header (`[− N +]` with Shift+click ±5, click-to-type edit mode, Enter/Space keyboard path, ArrowUp/Down to step). Replaces the previous preset dropdown so users can pick any N between 1–25 — each run costs money, so precise selection matters. Announces native `role="spinbutton"` semantics with `aria-valuenow/min/max/valuetext`
- **Studio:** Contextual subheads in Playground, Cost Dashboard, Memory Browser, Session Manager, and Tool Inspector — replaces static marketing copy with live counts and selected-item summaries (e.g. "14 entries · session scope", "3 registered tools · select one to inspect")
- **Studio:** `POST /api/evals/import` — ingest a CLI eval artifact (e.g. from `axl-eval --output result.json`) into runtime history. Generates a fresh UUID so repeated imports of the same file create distinct entries. Imported entries are first-class history records and work with the run detail view, comparison, and rescore (rescore requires a matching registered eval name). Blocked in `readOnly` mode. **Only Studio endpoint with potentially large request bodies — host frameworks must raise their JSON body limit on the Studio mount if importing sizeable files**
- **Studio:** "Import result" button in the Eval Runner panel header — lets users compare or inspect CLI eval artifacts inside Studio without re-running them
- **Studio:** `GET /api/health` now reports `readOnly: boolean`, used by the client to gate mutating UI affordances
- **Studio:** Export button on each history row in the Eval Runner panel — downloads the full `EvalResult` as JSON via client-side `Blob` + `createObjectURL`. Filename format: `<eval>-<short-id>-<iso-date>.json`. No server-side file write; always available regardless of readOnly mode
- **Studio:** Delete button on each history row in the Eval Runner panel — removes a single history entry via `DELETE /api/evals/history/:id`. Confirms via native dialog, clears any compare selections that referenced the deleted ID, and invalidates the currentResult drilldown if applicable. Disabled in `readOnly` mode with an explanatory tooltip
- **Core:** `StateStore.deleteEvalResult(id)` optional method + `AxlRuntime.deleteEvalResult(id)`. Implementations added to `MemoryStore`, `SQLiteStore`, `RedisStore`. Returns `true` when an entry was removed, `false` if the id didn't exist
- **Studio:** Compare view, Run tab, and History tab all surface workflow names as badges — driven by trace-derived `metadata.workflows` (parallel to `metadata.models`). Multiple badges render when multiple workflows were observed per result, with a "changed" indicator in the Compare view when baseline and candidate workflow sets differ
- **Core:** `trackExecution()` now captures workflow names automatically from `workflow_start` trace events — new `metadata.workflows: string[]` (insertion-ordered, deduped) and `metadata.workflowCallCounts: Record<string, number>` fields on the return type. Parallel to the existing models/modelCallCounts mechanism. No user-facing API change — callers still just wrap their work in `trackExecution()` and get richer metadata back
- **Eval:** `runEval()` now derives `EvalResult.metadata.workflows` (and `metadata.workflowCounts`) from `trackExecution`'s observed workflows rather than from `config.workflow`. The config value is retained as a fallback for callers that bypass the runtime's `execute()` path entirely (e.g. test harnesses that don't go through `runtime.execute`). Parallel to the existing `models`/`modelCounts` aggregation. Fixes a bug where A/B testing workflows via the `executeWorkflow` callback would silently record the config's workflow name instead of what actually ran. Note: this is the runtime hook for the breaking-change consolidation — `EvalResult.workflow` (top-level) was removed in the same release; see "Breaking changes" above
- **Studio:** `axl-studio --read-only` CLI flag (also `--readonly`) plus `dev:read-only` pnpm script for local testing

### Changed

- **Studio:** Panel titles normalized to the `{Noun} {Verb}` pattern — "Workflows" → "Workflow Runner" and "Evals" → "Eval Runner". Matches the existing "Agent Playground", "Trace Explorer", "Cost Dashboard", "Memory Browser", "Session Manager", and "Tool Inspector" titles. Sidebar labels remain short (scannability) while panel titles stay descriptive
- **Studio:** `readOnly` mode block list now uses precise regex patterns instead of `startsWith` matching. `POST /api/evals/compare` is allowed; `POST /api/evals/import`, `POST /api/evals/:name/run`, and `POST /api/evals/:name/rescore` remain blocked

## [0.13.8] - 2026-04-12

### Fixed

- **Studio:** Embedded middleware (`createStudioMiddleware`) now works correctly when the host framework (Express, NestJS, Koa) has body-parsing middleware. Previously, framework body parsers consumed the raw request stream before Hono could read it, causing POST request bodies to be silently lost. Most visibly, multi-run evals (`{ runs: N }`) would silently fall back to a single run

## [0.13.7] - 2026-04-11

### Added

- **Core:** `AxlRuntime.trackExecution()` method — extends `trackCost()` to also capture models, tokens, and agent call counts from trace events during execution. `trackCost()` now delegates to `trackExecution()`. Used by eval runner and CLI for per-item metadata
- **Core:** `runtime.runRegisteredEval()` accepts optional `options` parameter with `metadata` for injecting custom metadata into eval results
- **Eval:** Configurable regression thresholds — `evalCompare()` accepts `EvalCompareOptions` with `thresholds` (global number or per-scorer map). Auto-calibrates from `scorerTypes` metadata: `0` for deterministic scorers, `0.05` for LLM scorers. CLI: `--threshold` flag on `compare` subcommand. Replaces hardcoded `0.1`. New exported type: `EvalCompareOptions`
- **Eval:** Per-item paired bootstrap confidence intervals — `evalCompare()` computes 95% CIs on per-item score differences. New `ci` and `significant` fields on `EvalComparison.scorers`. `--fail-on-regression` now only exits 1 for statistically significant regressions when CI data is available
- **Eval:** `pairedBootstrapCI()` and `BootstrapCIResult` type — pure-math bootstrap CI function with optional seeded PRNG for deterministic tests. Exported from `@axlsdk/eval`
- **Eval:** Rescore mode — `rescore()` function and `RescoreOptions` type. Re-runs scorers on saved `EvalItem.output` without re-executing the workflow. CLI: `axl-eval rescore <results.json> <eval-file>`. Tracks only scorer cost
- **Eval:** Multi-run — `--runs N` CLI flag runs evals N times, reports mean +/- std per scorer via `aggregateRuns()` (`MultiRunSummary` type). Results include `runGroupId`/`runIndex` in metadata
- **Eval:** Multi-run comparison — `evalCompare()` accepts `EvalResult[]` arrays, pools per-item paired differences across runs for tighter bootstrap CIs
- **Eval:** `runEval()` now stores `scorerTypes` (map of scorer name to `'llm'` | `'deterministic'`) in result metadata
- **Eval:** `pRegression`, `pImprovement`, and `n` fields on `BootstrapCIResult` and `EvalComparison` scorer entries — bootstrap probability estimates for regression/improvement direction and sample size used for CI computation
- **Eval:** `EvalItem.metadata` field — per-item execution metadata (models, tokens, agentCalls) forwarded from the runtime
- **Eval:** `runEval()` `executeWorkflow` callback now accepts optional `metadata` in return type — enables runtimes to forward execution context per item
- **Eval:** Result-level model aggregation — `runEval()` auto-populates `models` and `modelCounts` in `EvalResult.metadata` with unique model URIs across all items
- **Eval:** `rescore()` preserves per-item `metadata` from original result (execution context survives re-scoring)
- **Eval:** Shared `utils.ts` module — `computeStats()` and `round()` extracted from runner for reuse in rescore
- **Studio:** 4 new eval components: `EvalHistoryTable` (grouped multi-run history), `EvalCompareItemTable` (full item-level comparison), `EvalCompareRunPicker` (baseline/candidate selection), `EvalMultiRunSwitcher` (run navigation)
- **Studio:** CI and significance columns in `EvalCompareView` scorer comparison table
- **Studio:** Significance tooltips explaining bootstrap CI methodology
- **Studio:** Model badges across all eval tabs (Run stat cards, History expanded rows, Compare header, Item detail)
- **Studio:** Token counts in eval UI with input/output/reasoning breakdown
- **Studio:** LLM scorer badges across all eval tabs
- **Studio:** `POST /evals/:name/rescore` endpoint — re-scores a history entry with registered eval's scorers
- **Studio:** `POST /evals/:name/run` accepts `{ runs: N }` body for multi-run execution (capped at 25)
- **Studio:** `compareEvals()` API accepts optional `options` parameter for threshold forwarding
- **DX:** Root-level `dev:studio` script (pre-builds core SDK, starts Vite + Hono dev servers) and `dev:studio:kill` for process cleanup

### Changed

- **Eval:** `evalCompare()` rounding precision increased from 2 to 3 decimal places
- **Eval:** `rescore()` strips `runGroupId` and `runIndex` from inherited metadata (rescored results are independent evaluations)

### Fixed

- **Build:** Work around tsup TS5055 error by redirecting DTS `compilerOptions.outDir` to a temp directory across all 4 packages
- **Testing:** `MockProvider.fn()` and `MockProvider.sequence()` now respect handler-provided `usage` and `cost` fields instead of silently overwriting them with defaults. Existing code that omits these fields is unaffected (defaults still apply)

## [0.13.6] - 2026-04-06

### Added

- **Core:** `callId` field on `tool_call` and `tool_result` `StreamEvent` variants — correlates tool invocations with their results across streaming consumers
- **Core:** `done` `StreamEvent` now uses `data` field (instead of `result`) for consistency with other event variants
- **Core:** `ExecutionInfo.result` field — captures the workflow return value on completed executions
- **Core:** `onToolCall` callback now includes `callId` in its payload (`{ name, args, callId? }`)
- **Core:** `AxlStream.promise.catch(() => {})` safety — prevents unhandled rejection warnings when no consumer attaches a `.catch()` handler
- **Studio:** `ConnectionManager` replay buffer for `execution:*` channels — events are buffered per-channel so late WebSocket subscribers receive the full event history (capped at 500 events, cleaned up 30s after stream completes)
- **Studio:** `POST /api/playground/chat` route uses `ctx.ask(agent)` directly instead of requiring a workflow — accepts `{ message, agent?, sessionId? }`, resolves the agent from registered agents, and streams results via WebSocket
- **Studio:** UI overhaul across all 8 panels — `JsonViewer` and `JsonEditor` shared components, `StatCard` for metric display, `trace-utils` for trace data extraction, `extractLabel()` utility for eval item previews, `EvalItemSidebar` for navigating eval items
- **Studio:** `server/index.ts` static file and SPA fallback handlers now skip `/ws` path to avoid interfering with WebSocket upgrade requests

### Changed

- **Studio:** Score colors simplified from 5-tier to 3-tier system: `>=0.8` green, `>=0.5` amber, `<0.5` red

### Fixed

- **Core:** `AxlStream._error()` now pushes a serializable `{ type: 'error', message: string }` event through the async iterator and Readable, matching `_done()`'s pattern — `for await` consumers no longer silently miss errors
- **Core:** `StreamEvent` error variant changed from `{ type: 'error'; error: Error }` to `{ type: 'error'; message: string }` for JSON serializability
- **Studio:** Removed redundant manual error broadcasts in workflow and session streaming routes — errors now flow through the iterator automatically

## [0.13.5] - 2026-04-01

### Added

- **Eval:** `ScorerResult` type — scorers can now return `{ score, metadata?, cost? }` instead of a plain number, enabling rich metadata (e.g., reasoning, confidence) to flow through eval results
- **Eval:** `ScorerDetail` type — per-scorer data on each `EvalItem` with `score`, `metadata`, `duration`, and `cost`
- **Eval:** `normalizeScorerResult()` exported helper that converts `number | ScorerResult` to `ScorerResult`
- **Eval:** `EvalItem` new fields: `duration` (workflow execution ms), `cost` (workflow cost), `scorerCost` (total scorer cost), `scoreDetails` (rich per-scorer data)
- **Eval:** `EvalSummary.timing` — per-item duration statistics (`mean`, `min`, `max`, `p50`, `p95`)
- **Eval:** `EvalComparison.timing` and `EvalComparison.cost` — timing and cost deltas between baseline and candidate runs
- **Eval:** `EvalRegression.itemIndex` and `EvalImprovement.itemIndex` — index into items array for lookup
- **Studio:** Refactored eval panel with sub-components: `EvalSummaryTable`, `EvalItemList`, `EvalItemDetail`, `ScoreDistribution`, `EvalCompareView` — adds filtering/sorting, score distribution visualization, per-item reasoning display, timing/cost badges, and expandable regression detail with side-by-side outputs
- **Studio:** History tab eval name filter dropdown — scopes table and scorer columns to a single eval when multiple exist
- **Studio:** Item detail view shows annotations (ground truth) alongside input and output

### Changed

- **Eval:** Runner uses pre-allocated array for deterministic item ordering regardless of concurrency — fixes `evalCompare` index-based item matching

- **Eval:** `Scorer.score()` return type widened from `number | Promise<number>` to `number | ScorerResult | Promise<number | ScorerResult>`
- **Eval:** `llmScorer()` now returns `ScorerResult` with metadata from the validated schema (e.g., reasoning) and LLM cost, replacing the `_lastCost` instance hack

## [0.13.4] - 2026-04-01

### Changed

- **Eval:** `llmScorer()` `schema` is now optional — defaults to `z.object({ score: z.number().min(0).max(1), reasoning: z.string() })`, eliminating boilerplate for the common case
- **Eval:** `llmScorer()` now injects the JSON Schema into the LLM prompt (via `zodToJsonSchema()`), so the judge LLM knows exactly what structure to produce — especially important for custom schemas with extra fields (e.g., `category`, `confidence`)
- **Eval:** `zod` is now a peer dependency of `@axlsdk/eval` (was dev-only)
- **Eval:** `llmScorer()` now formats Zod validation errors into human-readable messages (e.g., `"reasoning: Required"`) instead of exposing raw JSON arrays

## [0.13.3] - 2026-04-01

### Fixed

- **Core:** `extractJson()` fast path no longer returns trailing text after JSON — content like `{"score": 0.7}\nI hope this helps!` is now correctly extracted
- **Eval:** Scorer returning `NaN`, `Infinity`, or `-Infinity` is now treated as an error (`null` score) instead of being stored as a valid score that pollutes summary statistics

## [0.13.2] - 2026-04-01

### Fixed

- **Eval:** LLM scorers now request JSON mode (`responseFormat: { type: 'json_object' }`) from providers, preventing Gemini and other models from wrapping JSON in markdown fences which caused 60-87% of scorer evaluations to fail with JSON.parse errors

### Added

- **Core:** `extractJson()` utility exported from `@axlsdk/axl` — robust JSON extraction from LLM responses that handles raw JSON, markdown fenced blocks, and JSON embedded in prose text. Used by both `ctx.ask()` schema parsing and `llmScorer`

### Changed

- **Core:** `stripMarkdownFences()` replaced by `extractJson()` in `ctx.ask()` structured output parsing — now handles balanced brace matching for JSON embedded in prose, not just markdown fences

## [0.13.1] - 2026-04-01

### Changed

- **Eval:** `EvalItem.errors` renamed to `EvalItem.scorerErrors` to distinguish from the workflow-level `error` field

## [0.13.0] - 2026-03-31

### Added

- **Core:** `AxlRuntime.resolveProvider(uri)` public method resolves a `provider:model` URI to `{ provider, model }` using the runtime's provider registry
- **Eval:** `runEval()` now auto-resolves LLM scorer providers from the runtime's provider registry using each scorer's model URI — eval files no longer need to export a `provider`
- **Eval:** LLM scorer costs are now tracked in `totalCost` and count toward budget limits
- **Eval:** CLI now surfaces scorer errors in the formatted output table instead of silently reporting 0.00 scores. Scorers with no valid scores show `--` instead of misleading `0.00` values
- **Studio:** Eval Runner panel now displays scorer-level errors (amber warnings) in per-item detail view, filters out null error scores from badge display, and shows "No valid scores" when all items for a scorer errored

### Changed

- **Eval:** `Scorer.score()` now receives an optional `ScorerContext` as its 4th parameter, replacing the `_resolveProvider` mutation pattern. LLM scorers read `context.resolveProvider` instead of relying on external mutation
- **Eval:** `EvalItem.scores` type changed from `Record<string, number>` to `Record<string, number | null>`. Error scores are now `null` instead of `-1`
- **Eval:** `runEval()` signature changed from `(config, executeWorkflow, provider, runtime)` to `(config, executeWorkflow, runtime)` — the explicit `provider` parameter has been removed. LLM scorer providers are now resolved automatically from the runtime's provider registry. Migration: remove the `provider` argument, ensure the relevant API key env vars are set (e.g., `OPENAI_API_KEY`, `GOOGLE_AI_API_KEY`), or register providers via `runtime.registerProvider()`

## [0.12.0] - 2026-03-31

### Added

- **Core:** `TraceEvent` now includes optional `tokens` field (`{ input?, output?, reasoning? }`), emitted from `agent_call` trace events using `ProviderResponse.usage`. The Studio Cost Dashboard token counters (input, output, reasoning) now populate correctly
- **Core:** `StateStore` interface gains optional execution history methods (`saveExecution`, `getExecution`, `listExecutions`) and eval history methods (`saveEvalResult`, `listEvalResults`). All three built-in stores (MemoryStore, SQLiteStore, RedisStore) implement them
- **Core:** `EvalHistoryEntry` type exported from `@axlsdk/axl` for eval result persistence
- **Core:** `AxlRuntime.getEvalHistory()` and `AxlRuntime.saveEvalResult()` for programmatic eval history access
- **Core:** Completed/failed workflow executions are automatically persisted to the StateStore (when backed by SQLite or Redis, history survives process restarts)
- **Core:** `AxlRuntime.runRegisteredEval()` automatically persists eval results to history
- **Core:** `AxlRuntime.getExecutions()` and `getExecution()` lazy-load historical data from the StateStore, merging with in-memory active executions

### Changed

- **Core:** `AxlRuntime.getExecutions()` is now async (returns `Promise<ExecutionInfo[]>` instead of `ExecutionInfo[]`). This is a breaking change for callers that used it synchronously

### Fixed

- **Studio:** Eval Runner history tab now persists across page navigation and refresh — backed by server-side storage via the runtime instead of client-only React state
- **Studio:** Cost Dashboard token counters (input, output, reasoning) now show actual values instead of zero

## [0.11.6] - 2026-03-30

### Fixed

- **Studio:** Eval Runner results renderer crashed with `Cannot read properties of undefined (reading 'toFixed')`. The panel's local types assumed `summary` was `Record<string, {mean, min, max, count}>` but the real `EvalResult` from `@axlsdk/eval` has `summary: { count, failures, scorers: Record<string, {mean, min, max, p50, p95}> }`. Now correctly reads `summary.scorers`, displays p50/p95 columns, shows run metadata (count, failures, duration, cost), and aligns the comparison view to `EvalComparison`

## [0.11.5] - 2026-03-30

### Fixed

- **Studio:** Eval Runner panel now shows registered evals (from `defineEval()` + lazy loading or `runtime.registerEval()`) instead of requiring manual workflow/dataset/scorers JSON. The panel fetches from `GET /api/evals` and runs evals by name via `POST /api/evals/:name/run`, displaying workflow, dataset, and scorer metadata for each eval

## [0.11.4] - 2026-03-30

### Fixed

- **Studio:** Eval lazy loader (`createEvalLoader`) now works in the CJS bundle. `import.meta.url` is `undefined` in tsup's CJS output (stubbed as `{}`), so `tsImport()` received an invalid `parentURL`. Falls back to `pathToFileURL(__filename).href` — same class of fix as the 0.10.4 `fileURLToPath` issue, but in the eval loading path

## [0.11.3] - 2026-03-30

### Fixed

- **Studio:** `<base>` tag injected by `createStudioMiddleware` basePath is now inserted immediately after `<head>` instead of before `</head>`. Per the HTML spec, `<base>` must appear before any elements with relative URL attributes — the previous placement caused browsers to resolve `./assets/*` against the document root instead of the basePath, resulting in 503 errors when Studio is mounted at a sub-path

## [0.11.2] - 2026-03-30

### Fixed

- **Eval CLI & Studio:** Eval file module resolution now unwraps the CJS double-default (`mod.default.default`) the same way config loading does. Previously, eval files compiled from TypeScript to CJS (e.g., `.js` files in CJS-default projects) would fail validation because the double-wrapped default wasn't unwrapped

## [0.11.1] - 2026-03-30

### Fixed

- **Eval CLI & Studio:** TypeScript config and eval files are now loaded via tsx's `tsImport()` API instead of `register()` + `import()` with ESM-forcing resolve hooks. Previously, `.ts` eval files in CJS-default projects (no `"type": "module"`) were compiled as CJS by tsx, breaking `import` statements and `.js` → `.ts` remapping. `tsImport()` handles ESM/CJS format correctly without process-wide side effects — no more hook chaining or fighting tsx's format detection

## [0.11.0] - 2026-03-30

### Added

- **`createContext()` options**: `budget`, `signal`, `sessionHistory`, `onToken`, `awaitHumanHandler` — contexts created via `runtime.createContext()` can now participate in cost tracking, cancellation, session history, streaming, and human-in-the-loop approval
- **`createContext()` auto-wires trace emission and cost tracking**: Contexts always emit trace events to the runtime's `EventEmitter` and create a `budgetContext` (with `limit: Infinity` by default) for cost accumulation
- **`ctx.totalCost` getter** on `WorkflowContext` — returns the accumulated cost from the context's `budgetContext`
- **`runtime.trackCost(fn)`** — scoped cost attribution using `AsyncLocalStorage`. Wraps an async function and returns `{ result, cost }` with the total cost of all agent calls made within
- **`CreateContextOptions` type** exported from `@axlsdk/axl`
- **Eval CLI runtime support**: `axl-eval` now resolves an `AxlRuntime` and passes it to `executeWorkflow`. Three-tier resolution: `--config <path>` (explicit), auto-detect `axl.config.*` in cwd, or fallback to bare `new AxlRuntime()` (providers from env vars)
- **Eval CLI `--conditions` flag**: comma-separated Node.js import conditions for monorepo source exports
- **Eval CLI cost tracking**: custom `executeWorkflow` calls are wrapped with `runtime.trackCost()` for automatic per-item cost attribution

### Changed

- **Breaking: `runEval()` signature** (`@axlsdk/eval`): `runtime` and `provider` are now required positional parameters. `runtime` is typed as `AxlRuntime` instead of `unknown`

### Fixed

- Contexts from `createContext()` now emit trace events to the runtime `EventEmitter` — previously `createContext()` was "lightweight" and skipped trace wiring, causing cost to show as $0.00 for eval files using `runtime.createContext()` + `ctx.ask()`
- `_awaitHumanImpl` throws a clear error instead of hanging indefinitely when no approval handler is configured
- Eval cost tracking correctly scoped per execution via `trackCost` — previously used a shared trace listener that double-counted costs under concurrency
- **Studio basePath injection for root requests**: `<base>` tag and `window.__AXL_STUDIO_BASE__` are now correctly injected for root path requests (`/` and `/index.html`). Previously, `serveStatic` served the raw `index.html` for these paths, bypassing injection — breaking asset loading at `/studio` (no trailing slash) and causing React Router to ignore the basePath

## [0.10.4] - 2026-03-22

### Fixed

- **CJS bundle of `@axlsdk/studio/middleware`** no longer throws `TypeError` on `fileURLToPath(undefined)`. tsup replaces `import.meta` with an empty object in CJS, so the `import.meta.dirname ?? dirname(fileURLToPath(import.meta.url))` pattern broke. Added `__dirname` fallback between the two, matching the pattern already used in `cli.ts`

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

[Unreleased]: https://github.com/axl-sdk/axl/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/axl-sdk/axl/compare/v0.13.8...v0.14.0
[0.13.8]: https://github.com/axl-sdk/axl/compare/v0.13.7...v0.13.8
[0.13.7]: https://github.com/axl-sdk/axl/compare/v0.13.6...v0.13.7
[0.13.6]: https://github.com/axl-sdk/axl/compare/v0.13.5...v0.13.6
[0.13.3]: https://github.com/axl-sdk/axl/compare/v0.13.2...v0.13.3
[0.13.2]: https://github.com/axl-sdk/axl/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/axl-sdk/axl/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/axl-sdk/axl/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/axl-sdk/axl/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/axl-sdk/axl/compare/v0.10.4...v0.11.0
[0.7.6]: https://github.com/axl-sdk/axl/compare/v0.7.5...v0.7.6
[0.7.0]: https://github.com/axl-sdk/axl/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/axl-sdk/axl/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/axl-sdk/axl/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/axl-sdk/axl/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/axl-sdk/axl/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/axl-sdk/axl/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/axl-sdk/axl/releases/tag/v0.1.0
