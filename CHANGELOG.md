# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Spec/16 — Unified Event Model

The two parallel event models — rich `TraceEvent` (persisted to `ExecutionInfo.steps`) and lean `StreamEvent` (wire-only, derived by a translation layer that dropped fields) — collapse into a single `AxlEvent` discriminated union. The wire format IS the trace format. Tokens, tool calls, ask boundaries, and agent turns are observable end-to-end at full fidelity. Every event is correlated to its enclosing `ctx.ask()` via `askId` / `parentAskId` / `depth`, so consumers reconstruct the ask graph by group-by + parent-link.

This release also lands named checkpoints (`ctx.checkpoint(name, fn)`), removes the deprecated `parentToolCallId` field, and ships the Studio panels needed to visualize the new model (live `AskTree`, `RetryIndicator`, `PartialObjectRenderer`).

See [`docs/migration/unified-event-model.md`](docs/migration/unified-event-model.md) for a step-by-step consumer migration guide.

### Breaking changes

#### Event model

- **`TraceEvent` and `StreamEvent` are deleted.** Both collapse into `AxlEvent` (exported from `@axlsdk/axl`). External TS imports of either get compile errors — switch to `AxlEvent` and narrow on `event.type`. No alias kept.
- **`ExecutionInfo.steps` → `ExecutionInfo.events`.** Read sites rename verbatim. The on-disk SQLite column auto-migrates on first open via `PRAGMA user_version` (transactional, idempotent).
- **`AxlStream.steps` → `AxlStream.lifecycle`.** Same iterator shape; the rename reflects that these are events, not pipeline steps. Filter set expanded to include `ask_*`, `agent_call_*`, `tool_call_*`, `tool_approval`, `tool_denied`, `delegate`, `handoff_start`, `handoff_return`, `pipeline`, `verify`, `workflow_*`, `checkpoint_*`, `await_human*`.
- **Event type renames:** `'agent_call'` → `'agent_call_end'`, `'tool_call'` → `'tool_call_end'`. The new `_end` variants pair with newly-emitted `_start` events (see Added). `event.name` → `event.tool` on tool events; `event.message` → `event.data.message` on `error`; `done.data` → `done.data.result`.
- **Handoff event split: `'handoff'` → `'handoff_start'` + `'handoff_return'`.** `handoff_start` always fires BEFORE the target ask begins so it orders correctly in step-sorted timelines. `handoff_return` is roundtrip-only (oneway terminates at target). `HandoffData` exports split into `HandoffStartData` + `HandoffReturnData`. Handoff target asks now also emit their own `ask_start` / `ask_end`, so drill-downs no longer show "unknown agent".
- **Streaming-callback signatures gain `meta`.** `onToken`, `onToolCall`, `onAgentStart` now take a second `meta: CallbackMeta = { askId, parentAskId?, depth, agent }` parameter. Existing chat UIs that want root-only behavior add `if (meta.depth === 0)` to preserve the prior behavior.
- **`createChildContext` no longer isolates streaming callbacks.** Nested asks now propagate tokens, tool calls, and agent starts to the same callbacks as the parent — consumers filter via `meta.depth` to recover root-only behavior. Spec §3.2.
- **`createChildContext()` no longer accepts `parentToolCallId`** — the signature is `createChildContext(): WorkflowContext`. Callers passing `toolCall.id` should drop the argument; `parentAskId` from the ALS frame already correlates nested events to the outer ask.
- **`error` event scope narrowed.** Ask-internal failures (gate exhaustion, `ctx.verify` failure, handler throw) surface via `ask_end({ outcome: { ok: false, error } })` ONLY — never the workflow-level `error` event. `error` is reserved for failures with no `ask_end` available (top-level workflow throw, infrastructure / abort errors). Consumers must never see both for the same failure. Spec decision 9.
- **`step` is monotonic across the whole execution tree** via a single `AsyncLocalStorage`-shared counter. Consumers ordering by `step` see one shared counter spanning the root ask, every nested ask, and every branch primitive (spawn / parallel / race / map).
- **`AxlEventBase.parentToolCallId` removed.** The deprecated correlation field announced in 0.15.0 is gone. Use `parentAskId` (on `AskScoped`).

#### Checkpoint API

- **`ctx.checkpoint(fn)` → `ctx.checkpoint(name, fn)`.** Names are user-supplied and stable across runs (required for replay). The `__auto/` prefix is reserved for runtime auto-checkpointing of `ctx.ask` / `spawn` / `race` / `parallel` / `map`. Closes a data-corruption bug where nested `WorkflowContext`s each had their own `0`-indexed counter and silently overwrote each other's checkpoint slots.
- **`StateStore.{save,get}Checkpoint(executionId, step: number)` → `(executionId, name: string)`.** Custom `StateStore` impls switch the parameter type. `MemoryStore` / `SQLiteStore` / `RedisStore` already migrated.
- **SQLite schema v1→v2:** `checkpoints.step` (INTEGER) → `checkpoints.name` (TEXT). Auto-migrated on first open. **Drain or cancel running executions before upgrading** — legacy auto-checkpoint rows (`"0"`, `"1"`, …) become unreachable under the new `__auto/<agent>/ask/<n>` naming, so in-flight v1 executions resumed under v2 will re-execute side effects rather than replay from saved state. User-named checkpoints are unaffected.
- **`StateStore.getLatestCheckpoint` removed.** Undefined semantics under named keys.
- **`CheckpointEventData.step` (number) → `CheckpointEventData.name` (string).**

#### Other

- **Runtime translation layer at `runtime.ts:709-783` deleted.** The block that derived `agent_end` / `tool_result` / `step` from `AxlEvent` traces is gone — every event flows verbatim from `emitEvent` to the wire.
- **Studio: `costs` WS payload is `{ snapshots: Record<WindowId, CostData>, updatedAt }`** (was bare `CostData`). Custom WS subscribers update; the bundled client already handles this.

### Added

#### Event variants

- **`ask_start` / `ask_end`** — bound every `ctx.ask()` call. `ask_start` carries `prompt`; `ask_end` carries `outcome: { ok: true, result } | { ok: false, error }`, `cost`, `duration`. `ask_end.cost` is the per-ask rollup (leaf cost summed within the frame, EXCLUDING nested asks — spec decision 10).
- **`agent_call_start`** — pre-call marker per LLM turn, paired with `agent_call_end`. Carries `agent`, `model`, `turn`.
- **`tool_call_start`** — pre-call marker per tool invocation, paired with `tool_call_end`. Carries `tool`, `callId`, `data: { args }`.
- **`pipeline`** — retry/validation lifecycle (statuses: `start` / `failed` / `committed`). `start` fires once per LLM turn that contributes to the final result (initial + each gate-rejection retry). `failed` fires before each retry continue with the gate stage (`schema` / `validate` / `guardrail`) and feedback message. `committed` fires once on success before `done`. Tool-calling continuations within the same ask do NOT fire additional starts. Spec §4.2.
- **`partial_object`** — progressive structured-output streaming for asks with a Zod object schema and no tools. Emits at structural boundaries (`,` / `}` / `]`, string-safe walker). Backed by a tolerant JSON parser (`parsePartialJson`, 256-depth cap, zero deps). Monotonicity guaranteed within an attempt.
- **`memory_remember` / `memory_recall` / `memory_forget`** — first-class typed variants (previously sub-discriminated under `log`). Narrow on `event.type` for typed access to `data.{key, scope, usage, hit, ...}`.
- **`checkpoint_save` / `checkpoint_replay`** — first-class typed variants for durable execution events.
- **`await_human` / `await_human_resolved`** — first-class typed variants for human-in-the-loop pause/resume.
- **`AskScoped` mixin** — every ask-scoped event carries `askId`, `parentAskId?`, `depth`, `agent?` for tree reconstruction.

#### Helpers and types

- **`eventCostContribution(event)`** exported from `@axlsdk/axl` as the single source of truth for spec §10 cost aggregation (skips `ask_end` rollups, finite-checks, leaf-only). Used by the runtime accumulator, `AxlTestRuntime`, `trackExecution`, Studio's `reduceCost`, and the Playground / Workflow Runner panels.
- **`isCostBearingLeaf(event)`** / **`isRootLevel(event)`** / **`COST_BEARING_LEAF_TYPES`** — supporting helpers for custom cost aggregators.
- **`parsePartialJson(text)`** — tolerant JSON parser for progressive-render pipelines. 256-depth recursion cap.
- **`AxlEventOf<T>`** Extract helper, **`AXL_EVENT_TYPES`** const tuple (single source of truth for the discriminator), **`AxlEventBase`**, **`AskScoped`**, **`CallbackMeta`** type exports.
- **Per-variant data shapes:** `AgentCallStartData`, `AgentCallEndData`, `AgentCallParams`, `ToolCallData`, `ToolCallStartData`, `ToolApprovalData`, `ToolDeniedData`, `HandoffStartData`, `HandoffReturnData`, `DelegateData`, `VerifyData`, `WorkflowStartData`, `WorkflowEndData`, `MemoryEventData`, `CheckpointEventData`, `AwaitHumanData`, `AwaitHumanResolvedData`, `GuardrailData`, `SchemaCheckData`, `ValidateData`.
- **`AnyWorkflow`** type alias (`Workflow<any, any>`) — centralizes the bivariant escape hatch used by `AxlRuntime.register` and `AxlTestRuntime.register`.
- **`REDACTION_RULES`** + **`redactEvent(event)`** + **`REDACTED`** sentinel — table-driven, exhaustive per-variant scrubbing shared between core's emit-time scrub and Studio's WS/REST scrub. Adding a new variant without a rule fails typecheck via `Record<AxlEventType, RuleFor<...>>`.
- **`AxlStream.textByAsk`** iterator yields `{ askId, agent?, text }` per token chunk for split-pane UIs that render each sub-agent in its own lane.
- **`AxlStream.fullText`** commits on `pipeline(committed)` and discards the in-progress buffer on `pipeline(failed)` or `ask_end({ok:false})`. Per-`askId` scoping (`Map<askId, string[]>`) means concurrent root-level asks (`ctx.parallel` / `spawn` / `race` / `map`) keep each branch's chunks contiguous and a failure on one branch only discards THAT branch's tokens.

#### Configuration

- **`config.state.maxEventsPerExecution`** — bounds the in-memory `ExecutionInfo.events` array per execution. Default `50_000`; `Infinity` opts out. When the cap is hit, the cap-th slot is replaced with a sentinel `log` event (`data.event: 'events_truncated'`); the trace channel and WS broadcast continue to receive every event. Pathological values (`0`, negative, fractional, `NaN`) rejected at construction with `RangeError`.
- **`bufferCaps`** option on `createStudioMiddleware()` / `createServer()` / `ConnectionManager` — `{ maxEventsPerBuffer?, maxBytesPerBuffer?, maxActiveBuffers? }`. Production deployments under sustained execution churn can dial WS replay-buffer limits without forking. Defaults: `1000` events / `4 MiB` per buffer, `256` concurrent buffers. Pathological values rejected with `RangeError`.

#### Testing

- **`MockProvider.chunked(contents, chunkSize?)`** static helper builds a `sequence()` from plain strings split into fixed-size chunks (default 4 chars). Used for streaming, partial-JSON, and structural-boundary tests.
- **`MockProvider.sequence()` accepts `chunks?: string[]`** per response. `stream()` yields one `text_delta` per chunk; `chunks.join('') === content` asserted at construction.
- **`AxlTestRuntime` accepts `{ config }`** in its constructor options for `trace.level` / `trace.redact` parity with production.

#### Studio panels

- **New shared components:** `AskTree` (hierarchical live ask graph by `askId`, parent-linked via `parentAskId`, with status badges, inline `RetryIndicator`, cost rollup, handoff arrows), `AskDetails` (side-panel event timeline for a selected ask), `RetryIndicator` (inline pipeline-state badge), `PartialObjectRenderer` (progressive JSON view that resets on `pipeline(failed)`).
- **Playground:** opt-in subagent activity drawer (auto-opens the first time a nested-ask event lands; one-way latch — explicit user-off wins). Tool activity reconstruction migrated to the AxlEvent shape.
- **Workflow Runner:** `AskTree` is the new default timeline view with a Tree / Flat toggle. Clicking an ask opens an `AskDetails` drawer alongside.
- **Cost Dashboard:** retry overhead breakdown — decomposes `agent_call` cost + call counts by `retryReason` (`primary` / `schema` / `validate` / `guardrail`).
- **Trace Explorer:** native `event.depth` indentation, `pipeline(failed)` and `ask_end(ok:false)` highlighted as failure rows.
- **Strict client types:** the Studio React client now imports the strict `AxlEvent` discriminated union from `@axlsdk/axl` via type-only imports (safe under `verbatimModuleSyntax: true`). ~10 inline `event.data as { ... }` casts removed across panels.

#### Studio REST + WS

- **`GET /api/executions/:id?since={step}`** — paginated tail. `step > since` filter; `since=-1` is an explicit "everything from step 0" sentinel; malformed values return `400 INVALID_PARAM` with diagnostic.
- **WS replay buffer** excludes `token` and `partial_object` (reconstructable from final `agent_call_end` and `done`), uses byte-aware frame size checks (`Buffer.byteLength` on both inbound and outbound — closes an asymmetry where multi-byte payloads could pass `length` but exceed 64KB on the wire).

### Fixed

- **`AxlStream.fullText` no longer leaks retried-attempt tokens** — buffer split into in-progress and committed halves, flushed on `pipeline(committed)`, discarded on `pipeline(failed)` or terminal-throw `ask_end({ok:false})`. Spec §4.3.
- **`validate` + streaming now coexist.** Was an `INVALID_CONFIG` hard error in 0.15.x as a defensive workaround for the retry-leak above; with the leak fixed at the source, the workaround is removed. Spec §4.1.
- **Nested-ask events propagate to outer-context streaming callbacks.** `onToken`, `onToolCall`, `onAgentStart` from a parent context now fire for nested `ctx.ask()` invocations (with `meta.depth >= 1`). Filter on `meta.depth === 0` to recover root-only behavior. Spec §3.2.
- **Workflow `workflow_end` is idempotent (first-wins).** A post-completion side effect (`stateStore.deleteCheckpoints`, `persistExecution`) that throws after `_emitWorkflowEnd(completed)` no longer triggers a second `workflow_end(failed)` with conflicting status.
- **`onAgentCallComplete` hook throws no longer corrupt `ask_end.outcome`.** The hook is now wrapped in `try/catch + console.error` (mirroring the `onTrace` consumer-safety pattern); a buggy hook is logged but the ask's actual outcome survives intact.
- **Spec §9 invariant hardened** — `ctx.ask()` body refactored to `try/catch/finally` so `ask_end` always emits regardless of which path exits. Pinned by tests for input-guardrail block, MaxTurnsError, TimeoutError, provider HTTP throw, and BudgetExceededError mid-ask.
- **Per-ask cost rollup includes embedder cost.** `frame.askCost` previously hardcoded `agent_call_end | tool_call_end`, dropping `memory_remember` / `memory_recall` cost when `ctx.recall()` ran inside an ask. Now uses `COST_BEARING_LEAF_TYPES`.
- **PII redaction gaps closed.** `token.data` is now scrubbed at emit time (was leaking on the direct trace channel). Emit-time scrub also covers `tool_call_start`, `tool_denied`, `partial_object`, `verify`, `pipeline(failed).reason`, and `done` / `error`. Studio's `redactStreamEvent` shares the same `REDACTION_RULES` table — single source of truth across emit, REST, and WS.
- **Studio multi-tenant filter applied to replay-buffer events.** Late subscribers no longer see historical cross-tenant events on reconnect.
- **DoS hardening** — WS replay buffer global cap (oldest-complete-first eviction) + per-buffer byte budget; `parsePartialJson` 256-depth recursion cap; `parseInt` validation on `?since=`; `POST /api/evals/compare` pooled-ID count cap (25/side).
- **Browser SPA no longer crashes on `node:async_hooks`** — Studio client imports use type-only `import type { … } from '@axlsdk/axl'` (safe under `verbatimModuleSyntax: true`); the browser-compat tripwire test rejects value imports, side-effect imports, mixed-type imports, and dynamic `import('@axlsdk/axl')` at CI time.
- **Handoff target is a real ask frame.** Target's `executeAgentCall` runs under `askStorage.run(targetFrame, ...)` so its events carry `askId === handoffToAskId` and `parentAskId === handoffFromAskId`. Consumers grouping by askId no longer see the target as an orphan.
- **`partial_object` throttle is string-safe.** A char-by-char walker tracks `inString` + `escaped` state across chunks so commas inside string values no longer trigger per-comma parse+emit (50+ emissions on a prose-heavy field collapse to 1).
- **SQLite migration races** — `user_version` is re-read inside `BEGIN IMMEDIATE` so a concurrent constructor race can't double-apply a non-idempotent migration.
- **Gemini schema sanitizer** — Zod v4's `z.toJSONSchema()` emits Draft 2020-12 fields (`additionalProperties`, `oneOf`, `const`, `$ref`, `$defs`, `not`, `allOf`, ...) that Gemini's tool/responseSchema endpoint rejects with a 400. `sanitizeSchemaForGemini` recursively strips unsupported fields and translates `oneOf` → `anyOf` (preserves `z.discriminatedUnion()`) and `const: x` → `enum: [x]` (preserves `z.literal(x)`). Pre-existing bug surfaced by the live integration test pass; unrelated to spec/16.

### Documentation

- New migration guide at `docs/migration/unified-event-model.md` covering renames, callback `meta`, the named-checkpoints API, the `parentToolCallId` removal, and post-fix invariants for `fullText` / `validate + streaming`.
- Comprehensive doc audit pass — fixed broken `new AxlRuntime({ config: { ... } })` examples in `docs/security.md` and `packages/axl-studio/README.md`, replaced lingering `AgentCallData` type references with the actual `AgentCallStartData` / `AgentCallEndData` exports, added missing event-table rows for `pipeline` / `partial_object` / `await_human*` / `checkpoint_*`, documented `config.state.maxEventsPerExecution` / `AnyWorkflow` / `parsePartialJson` / `MockProvider.chunked()`, fixed scrubbed-fields paths (`handoff.data.message` → `handoff_start.data.message`, `tool_approval.args` → `tool_approval.data.args`), corrected the Studio replay-buffer cap (500 → 1000), fixed a broken `#trace-event-types` anchor in the core README.

## [0.15.0] - 2026-04-17

### Breaking changes

- **Core:** `Embedder.embed()` return type changed from `Promise<number[][]>` to `Promise<EmbedResult>` where `EmbedResult = { vectors: number[][]; usage?: EmbedUsage }` and `EmbedUsage = { tokens?: number; cost?: number; model?: string }`. Lets embedders report cost so it flows through the cost aggregator. Custom `Embedder` implementations must wrap their return value:

  ```ts
  import type { Embedder, EmbedResult } from '@axlsdk/axl';

  // Before:
  async embed(texts: string[]): Promise<number[][]> { return await myEmbed(texts); }

  // After:
  async embed(texts: string[]): Promise<EmbedResult> {
    const vectors = await myEmbed(texts);
    return { vectors }; // usage optional
  }
  ```

  `MemoryManager.remember()` / `.recall()` return types also changed (`RememberResult` / `RecallResult` wrapping optional `usage`). `ctx.remember()` / `ctx.recall()` public surface is unchanged. A custom embedder still returning the legacy bare `number[][]` shape now throws a precise migration hint from `assertEmbedResult` instead of a cryptic `TypeError: Cannot read properties of undefined (reading 'vectors')` deep inside upsert/search
- **Core:** `workflow_start` and `workflow_end` are now first-class `TraceEvent` types — previously emitted as `type: 'log'` with `data.event === 'workflow_start'` / `'workflow_end'`. Consumers filtering via the old log-form shape must switch to `event.type === 'workflow_start'` / `'workflow_end'`. `event.workflow` is now a top-level field; `data` carries `WorkflowStartTraceData { input }` / `WorkflowEndTraceData { status, duration, result?, error?, aborted? }`. `runtime.stream()` now also emits `workflow_start` (previously silently omitted). `AxlTestRuntime` already emits the first-class shape; no compatibility shim is provided — the filter change is a source-level edit
- **Eval:** `EvalProgressEvent` expanded from single-variant `{ type: 'item_done', ... }` to a discriminated union: `{ type: 'item_done'; itemIndex; totalItems } | { type: 'run_done'; totalItems; failures }`. Consumers must narrow on `type` before accessing variant-specific fields. `run_done` fires once after stats are computed, letting UIs transition from "processing items" → "computing" → "done"
- **Studio:** `POST /api/costs/reset` removed. The reset button is replaced by time-window selection; scripts hitting the old endpoint now receive a structured `410 Gone` envelope pointing at `GET /api/costs?window=24h|7d|30d|all`. `CostAggregator` class removed as a named export from `@axlsdk/studio` — replaced by `TraceAggregator`
- **Studio:** `costs` WS channel payload shape changed from `CostData` to `{ snapshots: Record<WindowId, CostData>, updatedAt: number }`. Client ships in the same bundle, so no internal break; document as a breaking change for anyone who subscribed via custom WS client

### Added

#### Core — trace observability

- `TraceEvent` is now a discriminated union over `type` — narrowing gives statically-typed `data`. New per-type exports: `TraceEventType`, `AgentCallTraceData`, `GuardrailTraceData`, `SchemaCheckTraceData`, `ValidateTraceData`, `ToolCallTraceData`, `ToolApprovalTraceData`, `HandoffTraceData`, `DelegateTraceData`, `VerifyTraceData`, `WorkflowStartTraceData`, `WorkflowEndTraceData`. `ExecuteOptions` also exported
- `agent_call.data` now carries resolved system prompt, resolved model params (`temperature`/`maxTokens`/`effort`/`thinkingBudget`/`includeThoughts`/`toolChoice`/`stop`), provider `thinking_content`, 1-indexed `turn`, and `retryReason` (`'schema'|'validate'|'guardrail'`) when the call was triggered by a prior gate failure
- New `schema_check` event closes the schema-retry observability gap. `schema_check`/`validate`/`guardrail` all include `attempt`/`maxAttempts`/`feedbackMessage` (the exact corrective message about to be injected on retry)
- New `tool_approval` event replaces the overloaded `tool_denied`-with-`denied:false` on the approve path
- `ctx.verify()` now emits a `verify` event (the type existed but nothing was emitting)
- `ctx.delegate()` single-agent short-circuit emits `delegate { reason: 'single_candidate' }`; multi-agent router emits `{ reason: 'routed' }`
- `parentToolCallId` stamped on every event from a child context (agent-as-tool) — enables joining nested call graphs back to the outer `tool_call`
- Verbose trace mode (`config.trace.level === 'full'`) adds a deep-cloned `ChatMessage[]` snapshot to each `agent_call.data.messages`
- `HandoffTraceData` gains `source` (mirrors `event.agent` for join-convenience) and `message` (the roundtrip arg the source agent passed)
- `config.trace.redact` extended to scrub `agent_call.data.system`/`thinking`/`messages`, gate-event `feedbackMessage`/`reason`, `tool_call.data.args`/`.result`, `tool_approval.data.args`, `handoff.data.message`, log-event string fields (one-level walk preserves nested numeric/boolean fields like `usage.tokens`/`.cost`)
- `ExecuteOptions.awaitHumanHandler` — `runtime.execute()` and `.stream()` accept an in-process approval handler (parity with `CreateContextOptions`)

#### Core — memory cost attribution

- Semantic memory cost flows through the trace rail — `OpenAIEmbedder` computes cost from a pricing table (`text-embedding-3-small` $0.02/1M, `-large` $0.13/1M, `ada-002` $0.10/1M); `MemoryManager` propagates `usage`; `ctx.remember({embed:true})` / `ctx.recall({query})` emit `memory_*` events with top-level `cost` and `data.usage`. Memory spend automatically flows through `runtime.trackExecution` aggregates
- Memory cost feeds `budgetContext` via `_accumulateBudgetCost` — `ctx.budget({ cost, onExceed })` now enforces across agent calls AND semantic memory. `ctx.remember` / `ctx.recall` check `budgetContext.exceeded` at call top and throw `BudgetExceededError` before hitting the embedder
- `Embedder.embed(texts, signal?)` accepts an optional `AbortSignal`; `WorkflowContext` composes user-abort + budget-hard_stop via `AbortSignal.any` on every memory op
- `ctx.remember`/`ctx.recall`/`ctx.forget` emit operation-only audit-trail events (values never in the trace; `key` scrubbed under `redact`); fire on both success and failure paths (failure carries `error` field)
- Partial-failure cost preservation: if `embedder.embed` succeeded but `vectorStore.upsert` fails, `MemoryManager.remember` attaches the usage to the thrown error via a non-enumerable `axlEmbedUsage` property and `context.ts` extracts it, so budget and cost aggregator still see the paid-for API call
- New exports: `EmbedResult`, `EmbedUsage`, `RememberResult`, `RecallResult`

#### Core — misc

- `runtime.isRedactEnabled(): boolean` — narrow public getter (replaces `runtime.getConfig()`, which returned a shallow-readonly config that consumers could mutate)
- `runtime.trackExecution(fn, { captureTraces: true })` captures per-invocation `TraceEvent[]`. On failure, traces are attached to the thrown error via a non-enumerable `axlCapturedTraces` property — exactly when they're most valuable
- `runtime.getConfig(): Readonly<AxlConfig>` replaced with `runtime.isRedactEnabled(): boolean`. The full-config accessor was shallow-readonly (consumers could mutate `trace.redact` via sub-object access) and encouraged tight coupling; the narrow boolean is the right surface for observability consumers

#### Eval

- `runEval()` accepts `RunEvalOptions` 4th arg: `onProgress` callback, `signal` (AbortSignal), `captureTraces`. Per-item `EvalItem.traces` populated when capture is on, including on the failure path via the `axlCapturedTraces` side-channel
- `runtime.runRegisteredEval(name, { captureTraces })` and `runtime.eval(config, { captureTraces })` forward to `runEval` — per-item trace capture is reachable from the runtime surface (previously only via direct `runEval` calls). The matching `EvalProgressEventShape` union is exported from `@axlsdk/axl` so callers can type `onProgress` without importing the optional `@axlsdk/eval` peer dep
- `rescore()` preserves `original.traces` — the workflow didn't re-run, so execution traces remain accurate and useful for diagnosing score changes
- Type-guarded cost/metadata extraction from user `executeWorkflow` returns — rejects `NaN`/`Infinity`/negative `cost` and exotic `metadata` (`Date`/`Map`/`Set`/class instances) with a console warn at the trust boundary
- Scorer `NaN`/`Infinity` returns recorded as `null` in `scores` with a `scorerErrors` entry — don't abort the run and don't poison `totalCost`
- New exports: `EvalProgressEvent`, `RunEvalOptions`

#### Eval CLI

- `axl-eval --capture-traces` flag — populates `EvalItem.traces` on every item (success + failure). Documented caveat: memory proportional to dataset × turns × agents, off by default

#### Studio — trace/streaming/redaction

- Trace Explorer: native rendering of enriched `agent_call` events — collapsible system/prompt/response/thinking/messages blocks, chip-style param display, `attempt/maxAttempts` badges on gate events, retry badge + amber tint on retry-triggered `agent_call` rows, failed gate events also tint amber. Top-level Expand cascades into every event body via `TraceJsonViewer` (context-aware wrapper that force-remounts on toggle)
- Failure-red event dots — gate events with `valid: false`/`blocked: true`, `verify` with `passed: false`, `tool_approval` with `approved: false`, `tool_denied`, aborted `workflow_end`, and `log` events with an `error` field now render with a red dot + red waterfall bar so failure clusters pop visually
- Shared `TraceEventList` component used by Trace Explorer, Workflow Runner timeline, AND Eval Runner's per-item trace viewer — single renderer, consistent UX across all three views (retry pills, attempt counters, body collapsibles, cost/duration badges, Expand-all toolbar)
- Eval Runner streaming multi-run — `POST /api/evals/:name/run` with `{ stream: true }` returns `{ evalRunId }` immediately and broadcasts progress over a new `eval:{evalRunId}` WS channel (`item_done` / `run_done` / `done` / `error`). The `done` event carries only `{ evalResultId, runGroupId? }` — the client refetches from history and rebuilds `_multiRun` locally via shared `buildMultiRunResult()` (avoids the 64KB WS frame limit on large `EvalResult` payloads). `POST /api/evals/runs/:evalRunId/cancel` aborts an active run
- Eval Runner `captureTraces` body flag on `POST /api/evals/:name/run` — UI toggle defaults ON (Studio's value prop is observability); toggle off for very large datasets. Library default (`runEval`) remains OFF so CLI batch jobs don't pay memory silently
- Eval execution state survives route navigation (module-level external store via `useSyncExternalStore`); running view shows progress bar, run counter, elapsed timer, cancel button. Stale-run watchdog transitions store to `error` after 5 minutes of WS silence (server-crash recovery)
- `config.trace.redact` is now a three-layer observability-boundary filter — trace events at emission, REST responses at serialization, WS broadcasts. Under `redact: true`: `GET /api/executions{,/:id}`, `GET /api/memory/:scope{,/:key}`, `GET /api/sessions/:id`, `GET /api/evals/history`, `POST /api/evals/:name/run` (sync), `POST /api/evals/:name/rescore`, `GET /api/decisions`, `POST /api/tools/:name/test`, `POST /api/workflows/:name/execute` (sync), plus two streaming WS paths (`/workflows/:name/execute` with `stream:true`, `/api/playground/chat`) scrub user/LLM content while preserving IDs, keys, names, metrics, roles, and timestamps
- `redactErrorMessage` — scrubs error envelopes in redact mode so `ValidationError`, `GuardrailError`, `VerifyError`, and provider errors don't leak user content through REST `error.message` fields and the `eval:*` WS channel. Allow-lists structural error names (`BudgetExceededError`, `TimeoutError`, `MaxTurnsError`, `QuorumNotMet`, `NoConsensus`, `ToolDenied`) which don't carry user input; everything else surfaces as a generic structural message
- Redaction helpers in `src/server/redact.ts`: `redactExecutionInfo`/`List`, `redactMemoryValue`/`List`, `redactSessionHistory`/`ChatMessage` (uses `satisfies ChatMessage` to fail-compile on new fields), `redactEvalResult`/`HistoryEntry`/`HistoryList`, `redactPendingDecision`/`List`, `redactStreamEvent`, `redactErrorMessage`, generic `redactValue` — none mutate, all return the original reference when `redact: false`
- `filterTraceEvent?: (event, metadata) => boolean` on `createStudioMiddleware` — per-connection broadcast filter for multi-tenant deployments, fail-closed on predicate error, also applied to replay buffers (late subscribers can't see historical cross-tenant events)
- `verifyUpgrade` may return `{ allowed, metadata }` — metadata is attached to the connection and passed to `filterTraceEvent` on every outbound event (backward compatible with bare boolean return). Close-race guard tightened: connections are rejected even if `close()` runs partway through an in-flight async upgrade
- WS broadcast enforces a 64KB soft cap via `truncateIfOversized` with a structural placeholder preserving `type`/`step`/`agent`/`tool`
- Cost Dashboard: "Retry Overhead" section decomposes `agent_call` cost by `retryReason` (primary/schema/validate/guardrail) with per-reason call counts; "Memory (Embedder)" section surfaces `CostData.byEmbedder` bucketing cost by embedder model. All breakdown tables user-sortable via a row-based generic `CostTable`
- `formatCost` tiered precision — `< $0.000001` sentinel, `< $0.0001` scientific, `< $0.01` 6 decimals, `>= $0.01` 2 decimals (embedder costs no longer collapse to `$0.0000`)

#### Studio — aggregates

- Time-windowed history aggregates — Cost Dashboard, Eval Runner, Workflow Runner, and Trace Explorer now survive server restarts by rebuilding from StateStore history. All four panels share a window selector (24h / 7d / 30d / All, default 7d, persisted to localStorage)
- `GET /api/costs?window=24h|7d|30d|all` — replaces the all-time-only cost endpoint with per-window snapshots. `?windows=all` returns all four windows for debugging
- `GET /api/eval-trends?window=` — per-eval score trends (latest, mean, std), cost breakdown, run timeline
- `GET /api/workflow-stats?window=` — per-workflow total/completed/failed counts, p50/p95/avg duration, failure rate
- `GET /api/trace-stats?window=` — event type distribution, tool call counts (calls/approved/denied), retry breakdown by agent
- Eval Runner "Trends" tab with per-eval line chart (one line per scorer), cost-over-time sparkline, per-scorer Latest/Mean/Std table, and a segmented "By Scorer | By Model | Duration" view toggle. By Model groups runs by most-called model from `metadata.modelCounts`; Duration plots per-run time by model. Clicking a point navigates to run detail
- Workflow Runner stats bar with execution counts, failure rate, and duration percentiles. Clicking a workflow row in the stats table selects it for the next run
- Trace Explorer "Stats" tab — event type distribution, top-N tool-calls bar chart, retry-by-agent stacked bar (segments per schema/validate/guardrail), tool-approval/denial stacked bar
- Cost Dashboard footer (`Window · Last updated · N executions`) showing how fresh the aggregate is
- Workflow Runner split into `Run | Stats` tabs (mirrors Trace Explorer's `Events | Stats` pattern)
- Shared chart primitives in `components/shared/charts/`: `LineChart`, `SparkLine`, `BarChart`, `StackedBarChart`
- `useAggregate<T>(channel, fetchFn)` shared client hook wiring window state, REST fetch, WS subscription, and `updatedAt` freshness
- `EvalTrendRun` now carries `model` and `duration` so trend charts can segment and compare without refetching raw history entries
- `AggregateSnapshots` constructor accepts a `broadcastTransform` option to enrich/strip state before WS broadcast
- Stats-accuracy disclosures — Eval Trends marks mean/std columns with an asterisk + footnote when runCount > 50; Workflow Stats p50/p95 headers note percentiles are approximate at 200+ executions

#### Studio — item labels under redact

- Eval Runner item list falls back to a stable `Item N` label when `item.input` is scrubbed under redact. Row index column was already visible, but the input-preview column would otherwise read `[redacted]` on every row, making items indistinguishable; this keeps the panel navigable in compliance mode

#### Studio — testing

- React Testing Library scaffolding — vitest picks up `.test.tsx` files, jsdom is opt-in per-file via `// @vitest-environment jsdom`, and `setup-dom.ts` loads jest-dom matchers + RTL `cleanup` only when a DOM is present. Regression suites seeded for `StatCard`, `WindowSelector`, `CostBadge`/`formatCost`, `TraceEventList`, `WorkflowStatsBar`

#### Runtime

- `AxlRuntime.saveEvalResult()` emits `eval_result` event for live eval aggregation

### Fixed

- **Core:** `CostData.byWorkflow.executions` was always `0` in production — the cost aggregator's `cost == null && !tokens` early-return short-circuited `workflow_start` events (which carry neither) before reaching the execution counter
- **Core:** `CostData.byWorkflow.cost` was always `$0` — `emitTrace` only stamped `workflow` on `workflow_start`/`workflow_end`; every other event type had `event.workflow` undefined, so the `byWorkflow` bucket never received cost. `emitTrace` now auto-stamps `workflow` on every event from a workflow context
- **Core:** `OpenAIEmbedder` didn't use `fetchWithRetry` — a transient 429/503/529 on the embeddings endpoint was fatal. Now gets exponential-backoff retry with `Retry-After` support, matching the other provider adapters
- **Core:** `config.trace.redact` didn't scrub `tool_call.data.args`/`.result`, `handoff.data.message` (roundtrip), string fields on `log` events, or `reason` on `guardrail`/`validate` events — compliance deployments could leak PII via tool args, handoff context, system logs, and validator reasons that echo user input
- **Core:** Log event redaction collapsed nested objects to `'[redacted]'`, including numeric fields inside objects like `data.usage`. Redaction now walks one level, preserving numeric/boolean fields while scrubbing strings
- **Core:** `agent_call.duration` was cumulative from the start of `ctx.ask()` instead of per-turn. Each `agent_call` event now reports wall-clock time of that specific turn's provider call
- **Core:** `onTrace` consumer exceptions could silently abort an in-flight workflow. `emitTrace` now catches throws, logs via `console.error`, and continues
- **Core:** `AbortError` detection in `runtime.execute()`/`.stream()` was `err instanceof DOMException && err.name === 'AbortError'` — too strict, missed plain `Error` instances with `name === 'AbortError'` thrown by `signal.throwIfAborted()` or non-fetch code paths
- **Core:** `formatBudgetCost` (in `BudgetExceededError.message`) rendered negative values as `$-1.50` instead of `-$1.50` and silently collapsed `NaN` / `Infinity` to `$0.00`, hiding cost-accounting bug signals. Now places the sign before `$` and emits `$NaN` / `$Infinity` / `-$Infinity` literally so bugs surface loudly
- **Studio:** `POST /api/costs/reset` (removed in this release) now returns a structured `410 Gone` envelope with a migration hint pointing at `GET /api/costs?window=…`, instead of the bare Hono default 404. Helps scripts and CI dashboards upgrading from 0.14.x surface the correct fix
- **Studio:** Workflow Runner and Trace Explorer had regressed the shared `TraceEventList` renderer in a prior refactor — silently dropping the Expand-all toolbar, retry pills, gate-failure amber tint, attempt counter pills, `AgentCallBody`/`GateCheckBody`/`ToolApprovalBody` collapsibles, `TraceJsonViewer` context-aware JSON expansion, `CostBadge` on rows, and `DurationBadge`. Both panels now route through `TraceEventList` again. A tripwire test in `panel-trace-list-tripwire.test.ts` catches future re-regressions
- **Studio:** `trace-utils.ts` `EVENT_COLORS` / `getDepth` referenced `workflow_complete` and `tool_call_complete` as event types — these names don't exist in the `TraceEvent` union. Dead branches removed
- **Studio:** Embedded middleware (`createStudioMiddleware`) lost `POST` request bodies when the host framework (Express, NestJS, Koa) had body-parsing middleware. Most visibly, multi-run evals (`{ runs: N }`) fell back to a single run. Handler now re-serializes `req.body` to `req.rawBody` (Buffer) before calling `getRequestListener`, so Hono's `rawBody instanceof Buffer` check picks it up

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

[Unreleased]: https://github.com/axl-sdk/axl/compare/v0.15.0...HEAD
[0.15.0]: https://github.com/axl-sdk/axl/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/axl-sdk/axl/compare/v0.13.8...v0.14.0
[0.13.8]: https://github.com/axl-sdk/axl/compare/v0.13.7...v0.13.8
[0.13.7]: https://github.com/axl-sdk/axl/compare/v0.13.6...v0.13.7
[0.13.6]: https://github.com/axl-sdk/axl/compare/v0.13.5...v0.13.6
[0.13.5]: https://github.com/axl-sdk/axl/compare/v0.13.4...v0.13.5
[0.13.4]: https://github.com/axl-sdk/axl/compare/v0.13.3...v0.13.4
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
