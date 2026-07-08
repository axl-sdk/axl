# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Broad provider expansion: the OpenAI adapter now powers first-class presets for
OpenAI-compatible hosted providers and local runtimes while preserving Axl's
cross-provider `effort`, tool-calling, and cost surfaces.

### Added
- **OpenAI-compatible provider profiles.** New generic `OpenAICompatibleProvider`
  plus built-in presets for `openrouter`, `azure`, `xai`, `deepseek`, `mistral`,
  `groq`, `bedrock`, `ollama`, `vllm`, `lmstudio`, `llamacpp`, and `sglang`.
  Profiles are exported for cloning and documented in `docs/providers.md`.
- **Cross-provider reasoning support.** `effort` now maps to each profile's
  supported reasoning mechanism and is omitted for models that reject it.
  Reasoning traces and DeepSeek/OpenRouter tool-loop round trips are preserved.
- **Typed provider failures.** Provider adapters now throw exported
  `ProviderError`s for non-2xx responses and exhausted network failures, with
  provider, status, retryability, retry-after, request id, and raw body details.
- **Async API-key callbacks.** Provider `apiKey` values may now be
  `() => string | Promise<string>`, resolved per request for expiring
  credentials such as Azure Entra, Bedrock, Databricks, or IBM OAuth.
- **Unpriced-cost honesty.** `ask_end`, `ExecutionInfo`, `runtime.trackExecution`,
  `AxlTestRuntime`, budget status, and Studio now flag lower-bound totals when a
  model reports usage but no usable cost.
- **Cheaper structured-output prompts.** When `ctx.ask({ schema })` appends the
  JSON-Schema guidance, subschemas shared across (e.g.) discriminated-union arms
  are now hoisted into `$defs`/`$ref` once instead of duplicated inline, and the
  JSON is emitted compact (no pretty-print indentation). For large unions with
  shared sub-objects this cuts the appended schema tokens by an order of magnitude
  with no code change. The exported `zodToJsonSchema` (used for provider tool
  definitions) is unchanged — it stays inline, which is required for Gemini, whose
  schema sanitizer strips `$ref`/`$defs`. Zod→JSON-Schema conversions are also
  memoized by schema identity, benefiting the per-turn tool-definition path.
- **`schema_diagnostic` events for silent structured-output cliffs.** A new
  `AskScoped` event (surfaced in `ctx.events` / `AxlStream` and `.lifecycle`)
  fires — once per ask — when: an appended prompt schema or a tool-def schema
  exceeds a token threshold (`prompt_schema_oversized`); a schema carries
  `.refine()`/`.superRefine()` rules that `z.toJSONSchema` silently drops
  (`dropped_refinements`); or progressive `partial_object` streaming is disabled
  by a non-object schema root or by tools (`streaming_disabled`). The
  genuinely-surprising cliffs also emit a one-time deduped `console.warn`
  (silenceable via `AxlConfig.diagnostics.silent` or `AXL_DIAGNOSTICS_SILENT=true`);
  the oversized threshold is configurable via
  `AxlConfig.diagnostics.schemaOversizedTokens` (default 4000). See
  `docs/observability.md#schema-diagnostics`.

### Changed
- **Unknown model cost is now `undefined`, not `0`.** Pricing-table misses no
  longer look free in budgets or dashboards. Consumers that sum costs should use
  `eventCostContribution()` or null-guard optional `response.cost`.

## [0.18.2] - 2026-05-31

### Fixed
- **Typed scorers compile again under `strict` (regression from 0.18.1).** The `applies?` field added to `Scorer` / `ScorerConfig` in 0.18.1 was declared as a function-valued **property**, whose parameters `strictFunctionTypes` checks contravariantly. That broke assignability of a concretely-typed `Scorer<…, TInput, TAnnotations>` to the `Scorer<unknown, unknown, unknown>[]` element type of `EvalConfig.scorers` — so any scorer built with concrete generics failed to typecheck when passed to `defineEval`, whether or not it used `applies`. `applies` is now declared with **method syntax** (like `score`), which TS checks bivariantly, restoring 0.18.0 assignability. Runtime behavior is unchanged and the public `ScorerApplies` type alias stays (for authoring/documentation). A `*.test-d.ts` guard, compiled by the `typecheck` CI gate, now locks the assignment in. (0.18.1's "Purely additive" note was incorrect for typed scorers under `strict`.)

## [0.18.1] - 2026-05-31

Conditional scorers: scope a scorer to a subset of items with an `applies` predicate, so a judge that doesn't apply to every item no longer pollutes the mean or trips the failure-rate gate — and an `llmScorer` skips the provider call entirely.

### Added
- **Conditional scorers (`applies`).** `scorer()` and `llmScorer()` take an optional `applies?: (output, input, annotations?) => boolean` that scopes a scorer to a subset of items (e.g. a refusal judge only for refusal-expected items). When it returns `false` the scorer is skipped — for an `llmScorer`, **no provider call is made** — and the item counts as neither `scored` nor `failed`, so it's excluded from the mean *and* the failure-rate gate denominator (`failOnScorerErrorRate`, `compare --max-scorer-error-rate`). This replaces the old "return `NaN`" hack (see _Deprecated_). Skips render as a neutral "N/A" wherever a score shows — the CLI table and Studio's run / multi-run / compare views — via `ScorerDetail.skipped` and a per-scorer `EvalSummary.scorers[].skipped` count; in `compare`, a "paired n" note flags when the two sides scored different subsets. A throwing predicate is a failure, not a skip. New export: `ScorerApplies`. Purely additive.

### Deprecated
- **The `NaN`-skip workaround for conditional scorers.** Returning `NaN` / an out-of-range score to mean "not applicable" trips the 0.18.0 failure-rate gate — a non-finite score is correctly counted as a real failure, so a deterministic conditional scorer that `NaN`-skipped flagged ~90% failures. Use `applies` instead.

## [0.18.0] - 2026-05-30

Faster, harder-to-fool evals, plus proactive provider rate limiting and the latest flagship models (`gpt-5.5`, Opus 4.8). Scorers now run concurrently within an item — the dominant cost for LLM-judge evals — and a set of trust signals make a thinned or broken eval impossible to miss.

### Added
- **Opt-in provider rate governor.** Set `rateLimit: { maxConcurrent?, minIntervalMs?, acquireTimeoutMs? }` on a provider config to cap in-flight requests at the `fetchWithRetry` chokepoint — backpressure *before* you trip a 429, complementing the existing reactive backoff. Dependency-free, covers all four built-in adapters, zero overhead when unset. Caps request concurrency (not token throughput) for chat calls; `maxConcurrent: 1` serializes without deadlocking nested asks. `RateLimiter` / `RateLimitConfig` exported from `@axlsdk/axl`. (`fetchWithRetry`'s 3rd arg is now `{ maxRetries?, governor? }` — internal callers only.)
- **New flagship models.** OpenAI `gpt-5.5` ($5/$30 per 1M) and `gpt-5.5-pro` ($30/$180); Anthropic `claude-opus-4-8` ($5/$25, adaptive thinking + `xhigh`/`max` effort). Dated snapshots resolve via prefix match.
- **Concurrent scorers within an item.** New `scorerConcurrency` (default 5) on `EvalConfig` / `RescoreOptions` parallelizes the judge phase *within* an item; previously only `concurrency` (across items) was parallel. Cost, timing, and ordering are preserved deterministically. **Behavior change — see _Changed_.**
- **Scorer failure-rate trust signals.** When a judge call exhausts its retries it throws, the score becomes `null`, and the mean is silently computed over the survivors — so a gate can pass on a number drawn from half the dataset. Now per-scorer `scored`/`failed` counts surface everywhere (CLI table, `compare` warnings, Studio badges), and two opt-in, type-aware gates catch a thinned sample: source-side `EvalConfig.failOnScorerErrorRate` (flags `summary.degraded`, never throws) and gate-side `axl-eval compare --max-scorer-error-rate`. New exports: `DegradedScorer`, `evaluateScorerTolerance`, `evaluateScorerErrorRateGate`.
- **Total-workflow-wipeout guard.** A run where *every* item errored in the workflow (zero scorable output) now exits non-zero instead of silently going green. Non-configurable.
- **Dropped-annotation-key detection.** `dataset()` flags annotation fields stripped by the `annotations` schema — a silent no-op-scorer trap. `console.warn` by default; configurable via `onExtraAnnotationKeys: 'warn' | 'error' | 'ignore'`. Covers file-based datasets too, where the JSON is never type-checked.
- **Eval CLI flags.** `--concurrency <n>` (also `AXL_EVAL_CONCURRENCY`) overrides item concurrency per-invocation; `--scorers <a,b>` runs a subset for a focused loop, stamped so it can't be mistaken for a full baseline.

### Changed
- **Scorers run concurrently by default** (`scorerConcurrency: 5`). An eval with N judges per item now issues up to `concurrency × scorerConcurrency` concurrent calls (≤25 at defaults) instead of N serial ones — more rate-limit pressure (mitigated by backoff), and `budget` becomes a softer ceiling. Set `scorerConcurrency: 1` to restore serial scoring.
- **Aborted in-flight scorers count as cancellation, not errors** (reverses 0.17.9): an `AbortSignal`-interrupted scorer keeps its `null` score and records no `scorerErrors` entry.
- **`dataset()` validates falsy-but-defined annotations** (`0` / `''` / `false`) instead of passing them through raw.

### Documentation
- Launch-prep README with the first Studio visuals (Trace Explorer, Cost Dashboard, Eval Runner, Playground) and an architecture diagram; example model URIs standardized on `openai-responses:gpt-5.5`.
- New runnable `examples/` directory (`quickstart`, `consensus`, `support-bot`).
- Studio README slimmed to a visual tour; full REST/WS/middleware reference moved to `docs/studio-api.md`.

## [0.17.9] - 2026-05-28

A focused `@axlsdk/eval` release: tunable LLM judges and end-to-end cancellation.

### Added
- **`llmScorer()` accepts the full `ChatOptions` surface.** Six new optional fields — `maxTokens`, `effort`, `thinkingBudget`, `includeThoughts`, `stop`, `providerOptions` — forwarded verbatim to `provider.chat`. The motivating gap: reasoning judges (gpt-5.x, Opus 4.5+, Sonnet 4.6+, Gemini 3.x) need `effort: 'high'` to calibrate well, with no way to set it short of abandoning the helper. `temperature` (0.2) and the hardcoded JSON response format are unchanged; `providerOptions` can override the latter for strict JSON Schema mode.
- **End-to-end `AbortSignal` for scorers.** The signal now flows `RunEvalOptions.signal` → `ScorerContext.signal` → in-flight `provider.chat`, so Studio's cancel button and a new CLI `SIGINT`/`SIGTERM` handler abort doomed judge calls instead of letting them finish. `rescore()` checks it between items too. Press Ctrl+C once to cancel gracefully, twice to force-exit.

### Changed
- **`ScorerContext.resolveProvider` is typed against the real `Provider` interface** — single source of truth, so any future `ChatOptions` field is automatically available to scorers. Type-only change; a custom mock `ScorerContext` may need `unknown as Provider`.
- **Aborted LLM scorers surface as `scorerErrors` entries** with `'aborted'` in the message. (Superseded in 0.18.0 — aborts are now treated as cancellation.)

## [0.17.8] - 2026-05-25

A small Gemini-focused release: ship pricing for the new `gemini-3.5-flash` GA model, and fix a latent function-call correlation gap that surfaces under parallel tool calls on Gemini 3.x.

### Added
- **`google:gemini-3.5-flash` pricing.** Adds the GA identifier to `GEMINI_PRICING` at $1.50 input / $9.00 output per 1M tokens (cached input $0.15/1M — the standard 10% of input rate, no special-casing needed). The 3.x code paths (`isGemini3x` regex `^gemini-3[.-]`, `thinkingLevel` mapping, `minThinkingLevel`) already covered the model — this release adds pricing only. Versioned identifiers (`gemini-3.5-flash-001`-style) resolve to the same rate via the existing longest-prefix matcher.

### Fixed
- **Gemini provider now round-trips `functionCall.id` end-to-end for Gemini 3.x models.** Per Google's function-calling docs, Gemini 3 always returns a unique `id` on every `functionCall` and requires it back in the matching `functionResponse` so the model can correlate results to calls. Previously Axl generated a synthetic id (`call_N`) on incoming and built `functionResponse` without `id`, which could cause `gemini-3.5-flash` (and other 3.x models) to misattribute results in turns that issued parallel tool calls. The fix is asymmetric — the assistant-side round-trip via `providerMetadata.geminiParts` already preserved the id verbatim; only the incoming-id capture and outbound `functionResponse` build needed updating. Gemini 2.x behavior is unchanged: when no native `functionCall.id` has been observed in the conversation, the outbound `functionResponse` omits the `id` field (bit-for-bit identical payload to before).

## [0.17.7] - 2026-05-20

Production-grade state layer: **crash-survival** for in-flight traces, **GDPR delete**, and a hardened **`RedisStore`**. All changes are additive — existing code runs unchanged, the new `StateStore` methods are optional, and `state.persist` defaults to `'terminal'` (prior behavior). See the [State Store Durability migration guide](./docs/migration/state-store-durability.md).

### Added
- **`state.persist: 'streaming'` for crash-survival.** Events are batched and flushed to a durable buffer throughout the run (tunable via `streamingBatchSize` / `streamingBatchInterval`); after a crash, `runtime.recoverIncompleteStreams()` reconstructs the partial executions from the surviving buffer on the next process. Backed by four new optional `StateStore` methods — implemented by `RedisStore` and `MemoryStore`; `SQLiteStore` does not (keep `'terminal'`). Scoped to `runtime.execute()` / `stream()`, not ad-hoc `createContext()` flows.

  ```typescript
  const runtime = new AxlRuntime({
    state: { store: await RedisStore.create('redis://localhost:6379'), persist: 'streaming' },
  });
  // On the next process, after a crash:
  const recovered = await runtime.recoverIncompleteStreams();
  ```
- **`runtime.deleteExecution(id)` (GDPR right-to-be-forgotten).** Removes an execution from the in-memory caches and every per-execution `StateStore` surface — data, indexes, checkpoints, suspended state, streaming buffer, pending decision — in one atomic sweep. Deleting an active run aborts it and prevents a late `workflow_end` from resurrecting the row. Returns `true` if anything was removed. Symmetric to `runtime.deleteEvalResult(id)`; new optional `StateStore.deleteExecution?`, implemented by all three built-in stores. For bulk eviction by age, use Redis TTLs.
- **`DELETE /api/executions/:id` Studio endpoint** wrapping it (also scrubs the WS replay buffer). Blocked in `readOnly` mode.
- **Delete audit events.** `runtime.on('execution_deleted' | 'eval_deleted', ...)` fire on every delete (including unknown ids), carrying enough context to categorize by workflow/eval — wire straight into SOC2/GDPR audit logs. Studio's aggregators subscribe and rebuild immediately so deleted runs leave the dashboards at once.
- **`ExecutionInfo.metadata`.** Caller-supplied `ExecuteOptions.metadata` now round-trips through `getExecution()` / `getExecutions()` as a queryable tag surface (`userId`, `tenantId`, correlation ids). Internal control-plane keys (`sessionHistory` / `sessionId` / `resumeMode`) are stripped before persistence; the field is redacted under `trace.redact`. Persisted by all three stores (SQLite schema v3, auto-migrated).
- **`RedisStore` TTLs.** `defaultTtl` + per-category overrides bound storage lifetime so Redis can't grow unbounded. Each category uses the appropriate window (sliding for user-activity data, fixed for execution-owned data); `streamingEvents` is opt-in only — it never falls back to `defaultTtl`, so a generous default can't evict crashed-run buffers before recovery. See the migration guide for the full table.

  ```typescript
  await RedisStore.create({
    url: 'redis://localhost:6379',
    defaultTtl: 60 * 60 * 24 * 30,        // 30 days
    ttls: { checkpoint: 60 * 60 * 24 * 7, streamingEvents: 60 * 60 * 24 * 7 },
  });
  ```
- **`RedisStore.create({ keyPrefix })`** for shared clusters (e.g. `'axl:prod:'` vs `'axl:staging:'`). Default `'axl:'`; the URL-string form is unchanged.
- **`RedisStore` now implements the optional memory methods** (`saveMemory` / `getMemory` / `getAllMemory` / `deleteMemory`). Previously `ctx.remember()` against Redis silently fell back to a path that dropped the `metadata` option and hid entries from `getAllMemory` and `session.fork()`. Legacy entries migrate forward automatically on first read.

### Changed
- **`RedisStore.listExecutions` / `listEvalResults` are now O(log N).** Each save dual-writes the id into a timestamp-scored sorted set; reads use a `ZRANGE` + single `MGET` instead of `SMEMBERS` + N round-trips — flat regardless of history size. A one-time lazy backfill builds the index on startup; for six-figure installs, pass `skipMigration: true` and call `backfillExecutionIndex()` / `backfillEvalIndex()` during a maintenance window. Signatures unchanged.
- **All `RedisStore` multi-key writes are atomic** via `MULTI/EXEC`, so a crash mid-write can't leave half-committed state (an indexed id with no data blob, a session that lists but reads empty).

### Fixed
- **`ctx.awaitHuman()` now wakes on signal abort.** A workflow paused on `awaitHuman` used to hang forever when its execution was aborted (including via `deleteExecution` on the same id); the promise now races the signal and rejects with `AbortError`.
- **`persistExecution` survives non-cloneable `ExecutionInfo.metadata`.** A function in the metadata bag used to crash the terminal persist hook; non-cloneable keys are now dropped at the persist boundary and execution is never affected.
- **`string_delta` is excluded from `ExecutionInfo.events`.** Always documented as stream-only, but the in-memory cap filter omitted it — long schema-streaming runs accumulated per-character entries and bloated memory.

## [0.17.6] - 2026-05-13

### Added
- **Anthropic Claude Opus 4.7 support.** New model ID `claude-opus-4-7` at the same pricing as Opus 4.6 ($5 input / $25 output per 1M tokens). Helpers `supportsAdaptiveThinking`, `supportsEffort`, and `supportsMaxEffort` now match the 4.7 prefix, so adaptive thinking + `output_config.effort` flow works out of the box. Versioned variants (`claude-opus-4-7-YYYYMMDD`) resolve automatically via the existing prefix-match.
- **`'xhigh'` cross-provider effort tier.** New `Effort` value positioned between `'high'` and `'max'`. Maps to:
  - Anthropic Opus 4.7 → `output_config.effort: 'xhigh'` (alongside adaptive thinking)
  - OpenAI gpt-5.2+ → `reasoning_effort: 'xhigh'` (already supported internally; now reachable from the public `Effort` type)
  - Anthropic 4.6 / 4.5 / older, OpenAI gpt-5.1 and earlier, Gemini 3.x → clamps to `'high'`
  - Gemini 2.x → `thinkingBudget: 16384` (between high's 10000 and max's 24576)

  Additive change — existing code that uses `'low'`/`'medium'`/`'high'`/`'max'` is unaffected.
- **`google:gemini-3.1-flash-lite` GA pricing.** Adds the GA identifier alongside the existing `-preview` entry at the same rate ($0.25 / $1.50 per 1M tokens). The 3.x code paths (`isGemini3x` regex, `thinkingLevel` mapping, `minThinkingLevel`) already covered the GA identifier — this release adds pricing only. The preview identifier `gemini-3.1-flash-lite-preview` continues to work until Google shuts it down on 2026-05-25; migrate before then.

### Deferred
- **Anthropic task budgets** (public beta in Opus 4.7) — waiting on Anthropic's official API reference before wiring a typed param. Axl's `ctx.budget()` already covers the orchestration-side use case.

## [0.17.5] - 2026-05-07

### Char-by-char streaming for long string fields

The headline feature. `partial_object` snapshots fire only at JSON structural seams, so a 4 KB `summary` field used to appear all at once when its closing quote landed. Chat-style typewriter rendering now works out of the box.

```typescript
// Render `/summary` char-by-char as it streams
for await (const e of stream.stringStream({ path: '/summary' })) {
  setText(e.accumulated); // running text-so-far
}
```

- **`stream.stringStream(opts?)` / `ctx.events.stringStream(opts?)`.** Listener-based view yielding `StringStreamEvent` (`{ askId, agent?, path, delta, accumulated, attempt }`). `path` is an RFC 6901 JSON Pointer (`/summary`, `/sources/0/title`); filter by `path` and/or `askId`. Bind your UI to `accumulated` for typewriter UX. Late subscribers see current state on first iteration; doesn't race the main iterator.
- **`stringStreamFromEvents(source, opts?)`** for browser SPAs consuming raw events over WebSocket / SSE — same API, pure ECMAScript, zero Node deps, in its own tree-shakeable module. [Recipe in the observability docs](./docs/observability.md#recipe-typewriter-rendering-on-the-wire-browser-spa).
- **New `string_delta` AxlEvent variant** — the wire primitive behind the views (`data: { path, delta }` per chunk). Stream-only (never persisted to `ExecutionInfo.events`). New exports: `StringDeltaData`, `StringStreamEvent`, `StringStreamFilter`.

**Heads up:** typewriter renders on the leaf agent, not a router — agents with `handoffs` don't emit `string_delta` (handoffs are tools, and streaming gates off when tools are bound). The schema root must be an object (`z.array(...)` is gated off — wrap it). Paths must start with `/` (`path: 'summary'` throws). Subscribe before the first `ctx.ask()` — the streaming path activates only when an observer is already present (`const events = ctx.events;` on the handler's first line).

### Studio
- **Playground renders schema responses as a live JSON tree + a typewriter line for the actively-writing field**, instead of streaming raw JSON tokens (`{"summary":"H...`) as visible gibberish. Free-text responses keep token streaming.

### Documentation
- New ["picking the right view" decision matrix](./docs/observability.md#picking-the-right-view-token-vs-partial_object-vs-string_delta) and ["common pitfalls"](./docs/observability.md#common-pitfalls-when-things-look-broken) troubleshooting list in `docs/observability.md`; README recipe + comparison-table update.

## [0.17.4] - 2026-05-04

### Fixed

- **Studio aggregator no longer crashes on a malformed stored execution.** When `runtime.getExecutions()` / `runtime.getExecution()` loaded an `ExecutionInfo` from a `StateStore` where `events` was missing, `null`, or otherwise non-array (custom store implementations, schema drift, partial deserialization), Studio's `TraceAggregator.rebuild()` threw `TypeError: exec.events is not iterable` at startup — and because all four aggregators boot under `Promise.all`, a single bad row took down the Cost Dashboard, Trace Stats, Workflow Stats, and Eval Trends panels together. The same crash was reachable from `GET /api/executions/:id` and the redaction layer, which both iterate `events`. Fix is at the runtime boundary: `getExecutions()` and `getExecution()` now coerce non-array `events` to `[]` before returning, restoring the `events: AxlEvent[]` type contract for every consumer. One `console.warn` per offending `executionId` (deduped) flags the bad row so operators can investigate the underlying store. Built-in `SQLiteStore` was already safe; `RedisStore` and custom stores were the exposed paths.

## [0.17.3] - 2026-05-03

### Stream-First Observation API (Phase 1)

Iterate workflow events from inside the handler, between `ctx.ask()` calls. See the [migration guide](docs/migration/stream-first-observation.md) for the behavior changes.

- **`ctx.events` on every `WorkflowContext`.** Lazy `AxlEventBus` exposing the same `AxlEvent` iterable + curated views (`.text`, `.lifecycle`, `.textByAsk`, `.partialObjects`) as `AxlStream`, scoped to the current context — observe `partial_object` snapshots, or replace the legacy `onToken` / `onToolCall` / `onAgentStart` callbacks. Zero overhead unless subscribed; auto-terminates on `workflow_end` / `error`. Child contexts (agent-as-tool asks) share the parent's bus, so partials from nested asks surface on the outer iterator (scoped by `askId` / `depth`). New `AxlEventBus`, `EventStreamOverflowError`, `EventStreamOptions` exports.
- **Coalescing `partialObjects` view** (on `AxlStream` and `ctx.events`) yields the latest snapshot per `askId` — memory bound `O(active asks)`, not `O(events)`. Listener-based, so it doesn't race the main iterator. Carries `attempt: number` and drops stale snapshots on schema/validate/guardrail retry, so a UI never shows attempt-N after attempt-N+1 began. Late subscribers recover the latest snapshot per ask.
- **Bounded queue + overflow policy** (default `maxQueued: 10_000`, `onOverflow: 'drop-oldest-non-terminal'`). Terminal events always pass; the first overflow warns once. Replaces silent OOM under slow-consumer pressure with visible degradation. Opt out with `maxQueued: Infinity`; strict environments can pick `onOverflow: 'throw'`. Plumbed through every entry point (`execute` / `stream` / `createContext` / `Session.send` / `Session.stream` / `AxlTestRuntime`).

### Sessions
- **`Session.send` / `stream` accept `AbortSignal`** — a chat UI's "stop" button cancels a turn with the standard JS pattern instead of tracking the execution id. User signals and `runtime.abort()` converge on one path.
- **`Session.fork` copies session-scoped key-value memory** (previously dropped silently — the fork "forgot" what the source remembered). Vector embeddings still re-embed on the fork.
- **Multi-agent sessions stamp the originating agent** on each assistant message (`ChatMessage.agent`), surfaced as a clickable badge in Studio's Session Manager. Backward compatible; never sent on outbound provider payloads.
- **`runtime.on('session_lock_contended', ...)`** to observe when concurrent calls queue on one session id.

### Fixed
- **Concurrent `session.send()` calls no longer lose messages** — `send` / `stream` / `end` / `fork` serialize per session id. `fork` acquires both source and target locks (deadlock-free) and refuses to overwrite existing history without `{ overwrite: true }`. (Cross-process locking is not provided — see the Sessions → Concurrency docs.)
- **A throwing `ctx.events` listener no longer crashes the workflow** — listener exceptions are caught and logged.
- **Iterator early-break no longer orphans a waiter** (which previously lost the next event).
- **AbortSignal listener leak on long-lived signals fixed** — reusing one signal across many `execute()` calls used to accumulate listeners (`MaxListenersExceededWarning`, then a real leak).
- **`onOverflow: 'throw'` now propagates as a typed `EventStreamOverflowError`** (was swallowed by the trace-listener guard) without masking an in-flight error or desyncing the `ctx.events` and `AxlStream` buses.
- **`Session.stream` forwards `signal` to `runtime.stream`** (was silently dropped); unknown `bus.on('typo', fn)` warns instead of dropping silently.
- **`pnpm dev:studio` works under pnpm strict isolation** (tsx hook registration fallback).

### Documentation
- New [migration guide](docs/migration/stream-first-observation.md); self-contained `ctx.events` examples across the READMEs and `docs/{observability,api-reference,testing,use-cases}.md`, including the "subscribe early" pattern, the cost double-counting callout (`eventCostContribution` skips `ask_end`), and the corrected `runtime.execute()`-doesn't-accept-`onToken` claim.

## [0.17.2] - 2026-04-30

### Fixed

- **`@axlsdk/eval` / `@axlsdk/studio`: register tsx's CJS hook alongside the ESM hook.** When a `.ts` eval (or config) file lived in a CJS-typed package and its import chain reached a CJS workspace dep that did `require('./helper.ts')` transitively, the load failed with `ES Module ... cycle` / `Unknown file extension '.ts'`. Cause: 0.17.0 switched to `tsx/esm/api`'s `register()` for chained `.ts` imports, but only the ESM hook was registered — `require()` calls have their own resolution path and bypass it, falling through to Node's `require(esm)` machinery, which can't bridge to a `.ts` file with no CJS handler. `ensureTsxRegistered()` in `@axlsdk/axl`'s shared `cli-internals` now also registers `tsx/cjs/api`, mirroring what tsx's own CLI does. The `--conditions` caveat about CJS chains is unchanged — that's about Node's `module.register()` being ESM-only for *resolution* hooks, which is independent of which file extensions tsx can transform.

## [0.17.1] - 2026-04-30

### Fixed

- **`@axlsdk/eval`: `tsx` is now declared as an optional peer dependency.** Previously the CLI imported `tsx/esm/api` at runtime to load `.ts` config and eval files, but `tsx` wasn't declared anywhere in `@axlsdk/eval`'s `package.json` — it relied on the consumer hoisting it to project root. Under pnpm strict isolation (e.g., Nx workspaces), this resolution failed, and `@nx/dependency-checks` flagged the workaround (declaring `tsx` as a peerDep on the consumer's package + an eslint override) as undeclared-in-source. Now declared properly: pnpm 8+ and npm 7+ install it automatically via `auto-install-peers`; the runtime error message points Yarn Classic / opt-out users at the explicit install. No behavior change for consumers who already had `tsx` resolvable. Fixes a long-term plan item to make the TS loader pluggable rather than hardcoding `tsx` (tracked in `ROADMAP.md`).

## [0.17.0] - 2026-04-30

### Eval reliability: silent failures eliminated

The headline fix: when `tsx` loaded a `.ts` eval from a CJS package, the `executeWorkflow` export landed at `mod.default.executeWorkflow` but the CLI only checked `mod.executeWorkflow` — so it silently fell back to identity passthrough and shipped all-zero scores in CI with a green exit. Fixed across every dynamic-import site, then extended through the eval flow: partial batches are preserved, mismatched-N comparisons surface their truncation, and cancellation is distinct from failure.

### Breaking
- **`axl-eval`: silent identity-passthrough is now a hard error.** When no `executeWorkflow` export or registered workflow matches, the CLI exits non-zero with a `Found exports: [...]` hint (calling out `"type": "module"` as the likely cause) instead of scoring everything zero. Opt back in explicitly: `export const executeWorkflow = async (input) => ({ output: input });`.
- **`axl-eval`: multi-file batches exit non-zero on any per-file failure** (was: success if at least one file finished). Split per-file or wrap the CLI if your CI tolerates partial failure.

### Added
- **Multi-run partial preservation.** A run that fails mid-batch keeps its completed runs (tagged `metadata.fromPartialBatch` / `batchCompleted` / `batchAttempted` / `batchFailure`), aggregates over what completed, and still exits non-zero. Surfaced across the Eval Runner UI: `X/N PARTIAL` history badge, run-detail banner, Compare chips, hollow-ring trend markers.
- **Compare aligns mismatched N.** Pooling 5 baseline vs 2 candidate runs now truncates both to `min = 2` before computing means / regressions / CI, with `EvalComparison.{baseline,candidate}.runCount` and a Studio notice explaining it. Partial-batch awareness via `partial?: { completed, attempted }` (`EvalComparisonPartial` exported).
- **Studio: streaming runs distinguish cancellation from failure** — the `done` event carries `cancelled: true` xor `batchFailure`; new `run_cancelled` event type.
- **Studio: `POST /api/evals/import` accepts arrays** (multi-run `--output` artifacts), importing each entry under a shared `runGroupId`. Single-object form unchanged.
- **`axl-eval`: glob expansion** (`'evals/**/*.eval.ts'`, quoted) for Windows / non-expanding shells.
- **`EvalExecuteWorkflow` exported from `@axlsdk/axl`** — one source of truth for a shape that was inlined (and had drifted) four times.

### Fixed
- **Symmetric ESM/CJS interop for named exports** via a shared `pickExport(mod, key)` helper, so future named exports resolve consistently.
- **`--conditions development` now transforms chained `.ts` imports** (switched to a one-time `register()`). Caveat: `--conditions` is ESM-only — `require()` chains in CJS packages bypass the hook (use `"type": "module"` or `.mts`).
- **`validateEvalConfig` rejects malformed shapes** with a `Got: { keys: ... }` trailer, and a non-function `executeWorkflow` fails cleanly instead of crashing deep in `trackExecution()`.
- **`detectPartial` / `buildMultiRunResult` scan every run** for `batchAttempted` / `batchFailure` (was `runs[0]` only, which a cherry-picked pair could fool). Empty provider errors no longer render blank "Stopped after:" banners; `metadata.batchFailure` is scrubbed under redact mode.

## [0.16.1] - 2026-04-29

### Added
- **Studio: system theme detection with auto / light / dark toggle** in the sidebar footer — respects the OS scheme by default, persists to `localStorage`, syncs across tabs, and applies the resolved theme before the bundle loads to avoid a flash.
- **Studio: `ResizableSplit` stacks vertically on narrow containers** (via `ResizeObserver`) instead of crushing both panes — affects workflow runner, playground, tool inspector, session manager, and trace explorer on phone-sized viewports.

### Fixed
- **Studio: responsive layout for narrow viewports** — sidebar auto-collapses below 768px (until the user toggles, which then locks in), stat cards and badges clip cleanly instead of overflowing, wide tables scroll horizontally, and panel chrome tightens below `sm`. The sidebar `matchMedia` listener no longer stomps an explicit user toggle.
- **Studio: accessibility pass** — dark-mode contrast on muted text raised to WCAG AA, `prefers-reduced-motion` honored globally, eval error severity distinguished by icon (not color alone), `aria-expanded`/`aria-controls`/`focus-visible` on the sidebar toggle, and bigger touch targets on phones.

## [0.16.0] - 2026-04-28

### Unified Event Model

The two parallel event models — rich `TraceEvent` (persisted) and lean `StreamEvent` (wire-only, derived by a lossy translation layer) — collapse into a single `AxlEvent` discriminated union. The wire format IS the trace format: tokens, tool calls, ask boundaries, and agent turns are observable end-to-end at full fidelity, each correlated to its enclosing `ctx.ask()` via `askId` / `parentAskId` / `depth`. Also lands named checkpoints (`ctx.checkpoint(name, fn)`) and the Studio panels to visualize it all (live `AskTree`, `RetryIndicator`, `PartialObjectRenderer`).

See [`docs/migration/unified-event-model.md`](docs/migration/unified-event-model.md) for the consumer migration guide.

### Breaking changes
**Event model:**
- **`TraceEvent` and `StreamEvent` are deleted** — both become `AxlEvent` (exported from `@axlsdk/axl`); narrow on `event.type`. No alias kept.
- **Renames:** `ExecutionInfo.steps` → `.events` (SQLite column auto-migrates); `AxlStream.steps` → `.lifecycle`; `'agent_call'` → `'agent_call_end'`, `'tool_call'` → `'tool_call_end'` (paired with new `_start` variants); `event.name` → `event.tool`; `event.message` → `event.data.message` on `error`; `done.data` → `done.data.result`.
- **`'handoff'` splits into `'handoff_start'` + `'handoff_return'`** (`handoff_start` always fires before the target ask; `handoff_return` is roundtrip-only). Handoff targets now emit their own `ask_start` / `ask_end`.
- **Streaming callbacks gain a `meta` arg** — `onToken` / `onToolCall` / `onAgentStart` receive `meta: { askId, parentAskId?, depth, agent }`, and nested asks now propagate to the parent's callbacks. Add `if (meta.depth === 0)` for the prior root-only behavior.
- **`error` event scope narrowed** — ask-internal failures surface via `ask_end({ outcome: { ok: false } })` only; `error` is reserved for failures with no `ask_end` (top-level throw, infra/abort). Never both for one failure.
- **`step` is monotonic across the whole execution tree** (one ALS-shared counter spanning root, nested asks, and branch primitives). **`parentToolCallId` removed** (deprecated in 0.15.0) — use `parentAskId`.

**Checkpoints:**
- **`ctx.checkpoint(fn)` → `ctx.checkpoint(name, fn)`** — names are user-supplied and stable across runs (required for replay); `__auto/` is reserved for runtime auto-checkpointing. Fixes a corruption bug where nested contexts overwrote each other's `0`-indexed slots.
- **`StateStore.{save,get}Checkpoint(id, step)` → `(id, name)`** and **`CheckpointEventData.step` → `.name`** (SQLite v1→v2 auto-migrates). **Drain in-flight executions before upgrading** — legacy auto-checkpoint rows become unreachable under the new naming, so a resumed v1 run re-executes side effects rather than replaying. `StateStore.getLatestCheckpoint` removed.

**Studio:** `costs` WS payload is now `{ snapshots: Record<WindowId, CostData>, updatedAt }` (was bare `CostData`).

### Added
- **New event variants:** `ask_start` / `ask_end` (with a per-ask cost rollup, excluding nested asks), `agent_call_start`, `tool_call_start`, `pipeline` (retry/validation lifecycle: `start` / `failed` / `committed`), `partial_object` (progressive structured-output streaming, string-safe walker), plus first-class `memory_*`, `checkpoint_*`, and `await_human*`. Every ask-scoped event carries the `AskScoped` mixin (`askId` / `parentAskId?` / `depth` / `agent?`).
- **New exports:** `eventCostContribution(event)` (single source of truth for cost aggregation — skips `ask_end` rollups, guards NaN/negative), `parsePartialJson()`, `AXL_EVENT_TYPES`, `AxlEventOf<T>`, `redactEvent()` + `REDACTION_RULES` (table-driven, exhaustive per-variant scrubbing shared by core and Studio), the full set of per-variant data-shape types, and `AxlStream.textByAsk` / `.fullText` (per-`askId` scoped, retry-safe).
- **`config.state.maxEventsPerExecution`** (default `50_000`, `Infinity` opts out) bounds the in-memory events array; **`bufferCaps`** on `createStudioMiddleware()` / `createServer()` tunes the WS replay-buffer limits.
- **Testing:** `MockProvider.chunked(contents, chunkSize?)` and `MockProvider.sequence({ chunks })` for streaming / partial-JSON tests; `AxlTestRuntime` accepts `{ config }` for trace parity.
- **Studio:** live `AskTree` (the new default Workflow Runner timeline) + `AskDetails` / `RetryIndicator` / `PartialObjectRenderer`; Cost Dashboard retry-overhead breakdown by `retryReason`; Trace Explorer depth indentation + failure-row highlighting; `GET /api/executions/:id?since={step}` paginated tail; strict `AxlEvent` client types via type-only imports.

### Fixed
- **`AxlStream.fullText` no longer leaks retried-attempt tokens** — committed on `pipeline(committed)`, discarded on `pipeline(failed)` / `ask_end({ok:false})`. With the leak fixed at source, **`validate` + streaming now coexist** (was a hard error in 0.15.x).
- **Ask-failure invariant hardened** — `ctx.ask()` always emits `ask_end` regardless of exit path (pinned by tests across guardrail block, MaxTurns, Timeout, provider throw, budget). `workflow_end` is idempotent (first-wins); a throwing `onAgentCallComplete` hook no longer corrupts `ask_end.outcome`.
- **Per-ask cost rollup includes embedder cost** (was hardcoded to agent/tool leaves, dropping `ctx.recall()` cost inside an ask). **Handoff targets are real ask frames** (no longer orphaned under group-by-`askId`).
- **PII redaction gaps closed** — `token.data` and several variants are now scrubbed at emit time via the shared `REDACTION_RULES`; the multi-tenant filter is applied to replay-buffer events too.
- **DoS hardening** — WS replay-buffer global cap + per-buffer byte budget, `parsePartialJson` 256-depth cap, `?since=` validation, compare pooled-ID cap (25/side).
- **Browser SPA no longer crashes on `node:async_hooks`** — Studio client uses type-only imports, enforced by a CI tripwire.
- **`partial_object` throttle is string-safe** (commas inside string values no longer trigger per-comma emits); **Gemini schema sanitizer** strips Draft-2020-12 fields Gemini's endpoint rejects, translating `oneOf`→`anyOf` and `const`→`enum` (preserving discriminated unions / literals).

### Documentation
- New migration guide (`docs/migration/unified-event-model.md`) plus a comprehensive doc audit pass across the core README, `docs/security.md`, and the Studio README (fixed broken config examples, stale type references, missing event-table rows).

## [0.15.0] - 2026-04-17

Headline: **cost attribution for semantic memory** (embedder spend now rides the trace + budget rails), **first-class `workflow_start`/`workflow_end` events**, **per-item eval trace capture**, and **time-windowed Studio aggregates** that survive server restarts.

### Breaking changes
- **`Embedder.embed()` returns `Promise<EmbedResult>`** (`{ vectors, usage? }`) instead of `Promise<number[][]>`, so embedders can report cost. Custom embedders wrap their return as `{ vectors }`; a bare `number[][]` now throws a precise migration hint. `MemoryManager.remember()`/`.recall()` return `RememberResult`/`RecallResult`; `ctx.remember()`/`ctx.recall()` are unchanged.
- **`workflow_start` / `workflow_end` are first-class `TraceEvent` types** (were `type: 'log'` with `data.event`). Filter on `event.type === 'workflow_start'`; `event.workflow` is top-level. `runtime.stream()` now also emits `workflow_start`.
- **`EvalProgressEvent` is now a discriminated union** (`item_done` | `run_done`) — narrow on `type`.
- **Studio:** `POST /api/costs/reset` removed (replaced by time-window selection; returns `410 Gone` with a migration hint); `CostAggregator` export → `TraceAggregator`; `costs` WS payload → `{ snapshots, updatedAt }`.

### Added
- **Semantic memory cost attribution.** `OpenAIEmbedder` computes cost from a pricing table; `ctx.remember({ embed: true })` / `ctx.recall({ query })` emit `memory_*` events with top-level `cost` + `data.usage`, flowing through `runtime.trackExecution` aggregates and enforced by `ctx.budget({ cost })` (throws `BudgetExceededError` before hitting the embedder). `Embedder.embed(texts, signal?)` accepts an `AbortSignal`; a paid-but-failed embed still attributes its cost. New exports: `EmbedResult`, `EmbedUsage`, `RememberResult`, `RecallResult`.
- **Richer trace events.** `agent_call.data` now carries the resolved system prompt, model params, thinking content, 1-indexed `turn`, and `retryReason`; new `schema_check` and `tool_approval` events; gate events carry `attempt`/`maxAttempts`/`feedbackMessage`; verbose mode (`trace.level: 'full'`) snapshots `ChatMessage[]`. `config.trace.redact` extended to scrub the new content fields. `runtime.isRedactEnabled()` replaces the mutable `getConfig()`.
- **Per-item eval trace capture.** `runEval(..., { onProgress, signal, captureTraces })` populates `EvalItem.traces` (including on the failure path), reachable from `runtime.runRegisteredEval` / `runtime.eval` and the `axl-eval --capture-traces` flag (off by default). `rescore()` preserves original traces. New exports: `EvalProgressEvent`, `RunEvalOptions`, `EvalProgressEventShape`.
- **Time-windowed Studio aggregates** that rebuild from StateStore history on restart, behind a shared 24h/7d/30d/All window selector: `GET /api/{costs,eval-trends,workflow-stats,trace-stats}?window=`. New views — Eval Runner "Trends" tab (per-scorer line chart, By Scorer/Model/Duration toggle), Workflow Runner stats bar (p50/p95), Trace Explorer "Stats" tab — plus shared chart primitives and a `useAggregate` hook.
- **Studio streaming multi-run evals.** `POST /api/evals/:name/run` with `{ stream: true }` broadcasts progress over an `eval:{id}` WS channel and returns a tiny `done` pointer the client refetches (dodging the 64KB frame limit); `POST .../cancel` aborts. Execution state survives route navigation with a 5-minute stale-run watchdog.
- **Three-layer redaction** (emit / REST / WS) with a full set of non-mutating `redact*` helpers, `redactErrorMessage` (allow-lists structural error names that carry no user input), and multi-tenant `filterTraceEvent` + `verifyUpgrade` metadata. `formatCost` gains tiered precision so embedder costs don't collapse to `$0.0000`. Eval items keep a stable `Item N` label when scrubbed.
- **Studio testing scaffolding** — React Testing Library + per-file jsdom opt-in, with regression suites seeded for the shared components.

### Fixed
- **`CostData.byWorkflow` was always empty in production** — the aggregator's early-return short-circuited `workflow_start` events, and `emitTrace` only stamped `workflow` on start/end events. Both fixed; cost now buckets by workflow.
- **`OpenAIEmbedder` now uses `fetchWithRetry`** — a transient 429/503/529 on the embeddings endpoint was previously fatal.
- **`config.trace.redact` closed PII gaps** — now scrubs `tool_call` args/result, roundtrip `handoff` messages, `log` string fields, and gate `reason`s, while a one-level walk preserves nested numeric fields (`usage.tokens`/`.cost`).
- **`agent_call.duration` is per-turn** (was cumulative from `ctx.ask()` start); `onTrace` consumer exceptions no longer abort the workflow; `AbortError` detection widened beyond `DOMException`; `BudgetExceededError` messages render signs and `NaN`/`Infinity` literally instead of hiding them.
- **Studio: embedded middleware lost `POST` bodies** under host body-parsers (Express/NestJS/Koa) — most visibly, multi-run evals fell back to a single run. Fixed by re-serializing `req.body` to `req.rawBody`.

## [0.14.0] - 2026-04-14

### Breaking changes
- **Eval: `EvalResult.workflow` (top-level) removed.** Workflow names now live in `EvalResult.metadata.workflows: string[]` + `metadata.workflowCounts`, parallel to `models`/`modelCounts` — workflow is execution metadata (what ran), and the single-string field couldn't represent multi-workflow runs. Migration: read `result.metadata.workflows?.[0]` (or iterate the list); `MultiRunSummary.workflow` → `.workflows`. `EvalConfig.workflow` (the config input) is unchanged, and Studio's `getResultWorkflows()` falls back to the legacy field for old artifacts.

### Added
- **Studio: `POST /api/evals/import`** ingests a CLI eval artifact (`axl-eval --output result.json`) into runtime history as a first-class entry — compare or inspect CLI runs without re-running. An "Import result" button surfaces it; each history row also gets Export (client-side `Blob`) and Delete (`DELETE /api/evals/history/:id`, `readOnly`-gated) buttons. (This is the only Studio endpoint with large request bodies — raise the host JSON body limit if importing big files.)
- **Studio: `PanelHeader` + `CommandPicker`.** A canonical header component (stable height, `ReactNode` description slot for live metadata chips) and a reusable ⌘K command-palette picker (search, keyboard nav) used across Playground, Workflow Runner, Eval Runner, and Trace Explorer. Eval Runner gains an inline run-count stepper (any N from 1–25; each run costs money), and contextual subheads replace static copy with live counts.
- **Workflow names surface as badges** across the Run / History / Compare tabs, driven by trace-derived `metadata.workflows`. `trackExecution()` captures them automatically from `workflow_start` events (`metadata.workflows` / `workflowCallCounts`), and `runEval()` derives them from what actually ran instead of `config.workflow` — fixing A/B workflow runs that recorded the wrong name.
- **`StateStore.deleteEvalResult(id)`** + `AxlRuntime.deleteEvalResult(id)` (implemented on all three stores); `GET /api/health` reports `readOnly`; `axl-studio --read-only` CLI flag.

### Changed
- **Studio: panel titles normalized to `{Noun} {Verb}`** ("Workflows" → "Workflow Runner", "Evals" → "Eval Runner"); `readOnly` block list uses precise regex (compare allowed; import / run / rescore blocked).

### Fixed
- **Studio: `POST /api/evals/compare` is now ID-based** (`{ baselineId, candidateId }`, resolved server-side), dropping the wire payload from ~150KB to ~100B so it no longer hits host body-parser limits behind NestJS/Express. Allowed in `readOnly` mode (pure computation).
- **Studio: unified panel-header typography** (fixing a nested-`truncate` inline-flow bug), plus a batch of `CommandPicker` fixes (offscreen flip, arrow-nav reset, Tab / ⌘K handling, `aria-activedescendant`/`aria-selected`) and a run-count stepper double-commit race.

## [0.13.8] - 2026-04-12

### Fixed

- **Studio:** Embedded middleware (`createStudioMiddleware`) now works correctly when the host framework (Express, NestJS, Koa) has body-parsing middleware. Previously, framework body parsers consumed the raw request stream before Hono could read it, causing POST request bodies to be silently lost. Most visibly, multi-run evals (`{ runs: N }`) would silently fall back to a single run

## [0.13.7] - 2026-04-11

### Added
- **Eval statistics.** `evalCompare()` gains configurable regression `thresholds` (auto-calibrated from `scorerTypes`: 0 for deterministic, 0.05 for LLM; `--threshold` CLI flag, replacing the hardcoded 0.1) and 95% paired bootstrap confidence intervals on per-item score differences (`ci` / `significant` / `pRegression` / `pImprovement` / `n` fields). `--fail-on-regression` now gates only on statistically significant regressions. New exports: `pairedBootstrapCI()`, `BootstrapCIResult`, `EvalCompareOptions`.
- **Multi-run.** `axl-eval --runs N` runs an eval N times and reports mean ± std per scorer via `aggregateRuns()` (`MultiRunSummary`); `evalCompare()` accepts `EvalResult[]` arrays and pools per-item differences across runs for tighter CIs. Studio caps at 25.
- **Rescore.** `rescore()` re-runs scorers on saved `EvalItem.output` without re-executing the workflow (`axl-eval rescore <results.json> <eval-file>`; `POST /evals/:name/rescore`), tracking only scorer cost and preserving per-item metadata.
- **Per-item metadata + trace capture.** `runtime.trackExecution()` captures models, tokens, and agent-call counts from trace events (`trackCost()` delegates to it); `runEval()` forwards them to `EvalItem.metadata` and auto-aggregates `models`/`modelCounts` + `scorerTypes` into `EvalResult.metadata`.
- **Studio:** new eval components (`EvalHistoryTable`, `EvalCompareItemTable`, `EvalCompareRunPicker`, `EvalMultiRunSwitcher`), CI/significance columns with methodology tooltips, and model + LLM-scorer badges + token breakdowns across all eval tabs; root-level `dev:studio` script.

### Changed
- **Eval:** `evalCompare()` rounds to 3 decimals (was 2); `rescore()` strips `runGroupId`/`runIndex` so rescored results are independent.

### Fixed
- **Testing:** `MockProvider.fn()` / `.sequence()` now respect handler-provided `usage`/`cost` instead of overwriting them with defaults.
- **Build:** work around tsup TS5055 by redirecting DTS `outDir` to a temp directory across all packages.

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
