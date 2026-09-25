# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Generated `maxContext` summaries now emit a paired, ask-scoped `agent_call_start` / `agent_call_end` with `data.purpose: 'summary'` and the summary model URI. Their known cost joins the ask trace and budget once; unknown-price summaries mark totals as lower bounds. Cached summary reuse incurs no new charge.
- Exact GPT-6 Astra, Sol, and Luna support on OpenAI Responses and Chat Completions, with endpoint-aware reasoning and local typed errors for unsupported Chat tool or sampling combinations. Direct Standard text pricing covers cache reads/writes and the 272K-token long-context boundary; unsupported billing remains unpriced. Selected live calls verified text/schema on all three Responses IDs, Chat text on all three, Astra tool continuation, Luna streaming, and Sol/Luna Chat tools at explicit `none`; cache-write and long-context billing remain unverified live.
- Claude Opus 5.5 support with always-on adaptive thinking, five positive effort levels, a diagnostic low-floor clamp for `none`, and Standard base/cache pricing. Opus 5.5 and Fable 5.1 reject forced tool choice before dispatch. Signed thinking replay uses Anthropic's binding beta and default `drop_block` recovery; safe dropped-block counts appear per affected call in adapter diagnostics and runtime traces. Selected live calls verified signed tool replay, both model-switch directions, edited system/tool/message prefixes, native error opt-out, streamed reset, and automatic summary regeneration with cached reuse.
- Gemini 3.8 Flash frontier certification cases and dated Standard pricing for exact Gemini 3.6/3.7/3.8 Flash IDs. The estimator selects Google's published successor rate at dispatch of the returned transport attempt from 2027-01-01 UTC, including retries across the boundary; recorded audio stays unpriced pending a model-specific rate. Selected Gemini 3.8 live calls verified GenerateContent text/schema/tool/stream and Interactions image/audio. Studio traces display safe reasoning-reset counts, and mixed priced/unpriced cost summaries show a lower bound.

## [0.24.2] - 2026-09-25

### Fixed

- `trackOutcome` now derives agent model counts, tokens, and successful-call timing from the accounting settlement scope. Evals running work on a second runtime or a compatible ESM/CJS copy retain measured model metadata and `modelTiming`.
- Tools created by one ESM/CJS copy can be invoked by the other copy's runtime, including model-requested calls.
- Gemini 429s that explicitly identify a daily quota or billing/spend cap fail fast without braking the model scope. Ambiguous `RESOURCE_EXHAUSTED` errors still retry because Gemini also uses that status for short rate limits.
- Clarified that `ctx.ask`'s `timeout` is a between-turn budget and `stallTimeout` applies only during dispatched provider work. A strict deadline across a 429 pause, queue, or transport backoff requires an ask or context `signal`, such as `AbortSignal.timeout(...)`.

## [0.24.1] - 2026-09-25

### Fixed

- Accounting scopes, admission controllers, and request capture now join across compatible ESM/CJS or duplicated `@axlsdk/axl` loads in one JavaScript realm. Cross-copy calls keep their cost and capture refs, share nested budgets, and emit a one-time warning with both copies' paths and versions. Budget denials from another copy also stop tool retries. Incompatible participating copies refuse paid work and mark the enclosing scope `incomplete` / `uninstrumented` instead of reporting a confident $0. Both copies must use this or a later compatible accounting protocol; older releases cannot detect or join the new scope.

## [0.24.0] - 2026-09-24

### Added

- **Authoritative cost accounting.** `runtime.trackOutcome(fn, options?)` runs
  `fn` and **always** returns its outcome plus an `Accounting` record for every
  paid operation inside it — provider chat/stream, tool invocations (including
  each retry attempt), memory embeddings, transcription, and declared external
  work. It never throws: a run that failed after a paid call now reports that
  call's charge, and the rejected `error` is the **original thrown value**
  (`===` what was thrown, primitives and frozen objects included). Accounting is
  derived from settlement rather than from trace events, so it is byte-identical
  under `trace: false`, `trace.level: 'steps'` / `'full'`, with `captureTraces`
  on or off, and with redaction on or off. Scopes nest and are isolated: an
  operation is counted exactly once in every enclosing scope, and concurrent
  scopes on one runtime never see each other's operations or spend.
- **Known $0 is distinguished from unknown.** `Accounting.completeness` is
  `'complete'` only when every operation reached a terminal state with a usable
  charge — a genuinely free call included. Otherwise it is `'incomplete'`,
  `knownCost` is an explicit lower bound, and `reasons` counts why:
  `unpriced_model`, `usage_missing`, `abandoned`, `external_unreported`, or
  `uninstrumented`. At finalization `operations.total === settled + unknown`,
  with denied operations tracked separately and excluded.
- **`AdmissionController`** — a synchronous known-spend threshold for one
  invocation, attached with `trackOutcome(fn, { admission })`. It closes at
  `knownSpend >= limit` and refuses new paid operations with a typed
  `AdmissionDeniedError` before the request leaves the process, so a refusal
  never accompanies a charge. It is a threshold, not a reservation:
  `knownOvershoot` reports how far a concurrently in-flight call pushed spend
  past the limit. Built-in adapters check admission a second time immediately
  before **every** `fetch` attempt — after the rate-governor grant and after
  retry backoff — so a request that waited in a queue cannot spend against a
  budget that closed while it waited; the governor permit is still released, so
  a sibling request queued on the same governor proceeds.
- **`externalOperation(descriptor, fn)` and `ctx.withExternalOperation(...)`** —
  declare paid work Axl cannot observe (a vendor API called from a tool) so it
  joins the scope's accounting and its budget. Admission is checked before `fn`
  runs; a cost reported before a later throw is kept; not reporting one marks
  the scope incomplete with `external_unreported` rather than being read as
  free. A non-finite, negative, or duplicate `setCost` throws
  `AxlError('INVALID_COST_REPORT')` so an invalid report can neither shrink nor
  poison a total.
- **`costProvenance`** on `ProviderResponse` and the terminal `StreamChunk`,
  with `Accounting.provenance` reporting the split. A vendor-supplied USD figure
  (`provider_reported`) stays distinguishable from an Axl price-table estimate
  (`price_table_estimate`). Every built-in adapter stamps it; it is optional for
  custom adapters, which are reported as `adapter_reported` rather than
  mislabeled.
- **Eval runs report measured spend.** `EvalResult.accounting` carries the run's
  `Accounting` record — known cost, completeness and reasons, a
  `generation` / `judging` / `external` breakdown, per-scorer detail on
  `ScorerDetail.accounting`, and per-item detail on `EvalItem.accounting`.
  `totalCost`, `unpriced`, `item.cost`, `item.scorerCost` and
  `scoreDetails[].cost` remain as views over it. Every eval entry point
  (`runEval`, `runtime.eval()`, `runRegisteredEval()`, the `axl-eval` CLI
  including `--runs` and `rescore`) reports the same figures for the same work.
- **`EvalConfig.budget` (and `axl-eval --budget`) stops a run at a threshold.**
  Once known spend reaches the limit, later cases are `budget_skipped` and later
  LLM scorers are skipped, while deterministic scorers still run; a case whose
  next call is denied becomes `budget_interrupted` and keeps its earlier charge.
  `accounting.budget` reports `limit`, `knownSpend`, `knownOvershoot`, `status`
  and `closedBy`. An invalid limit throws `AxlError('INVALID_BUDGET')` before the
  dataset is loaded. `rescore` accepts its own budget, covering only new judging.
- **Item and scorer outcomes.** `EvalItem.outcome` and `ScorerDetail.outcome`
  distinguish `completed` / `scored`, `failed`, `cancelled`, `budget_skipped`
  and `budget_interrupted`, and `EvalSummary.coverage` counts both populations —
  so a truncated run can no longer be mistaken for a clean one. Scorer means and
  failure-rate gates exclude judges that never ran.
- **`readAccounting(result)` and `aggregateAccounting(inputs)`.** The first
  returns a result's accounting or synthesizes an `unverified` record from a
  pre-0.24 artifact's `totalCost`; the second folds several conservatively
  (worst completeness wins). `MultiRunSummary.accounting` uses them, and
  `EvalComparison.cost` gains `certified` plus a `reason` — a cost comparison is
  refused when either side is unverified or incomplete, the scopes differ, or the
  two sides covered different amounts of work, with both raw totals still shown.
  The `cost` block is emitted whenever either side carries accounting, including
  when both totals are `$0`, and the scope check covers **every** run on a side
  so a mixed run/rescore aggregate cannot certify. `deltaPercent` is `null`
  rather than `Infinity` when the baseline was free.
- **Studio presents measured eval spend, not bare totals.** Every eval view —
  summary, history, item list and detail, compare, trends and the multi-run
  aggregate — renders known spend through one badge that carries its
  completeness (`complete`, `incomplete: 2 unpriced_model`, or
  `unverified (legacy)`), in wording parallel to the `axl-eval` CLI. An unknown
  `$0` is no longer hidden, and a pre-0.24 artifact is never shown as complete.
  Runs with a budget get a dedicated outcome row (limit, status, known spend,
  overshoot, `closedBy`) and a "budget stopped" badge in history, so a
  truncated run reads as truncated rather than as a wall of model failures;
  `summary.failures` stays visible with its legacy meaning spelled out.
  Item and scorer outcomes each render distinctly — a judge the budget skipped
  shows as "not run (budget)" instead of a zero — and per-item generation and
  judging spend are shown separately, with any `callerReport` labelled
  "caller-reported (not counted)". The compare view states whether the cost
  comparison is certified and why not, and shows an uncertified delta
  descriptively instead of as a saving. Multi-run groups and trend windows
  union accounting conservatively: one legacy or incomplete run makes the whole
  group or window uncertifiable rather than inheriting the first run's flags.
- **`GET /api/eval-trends` carries spend completeness.** Each trend point gains
  `completeness` and `budgetStopped`; each eval gains `costCompleteness` and
  `budgetStoppedRuns`; the payload gains `totalCostCompleteness`. See
  [docs/studio-api.md](docs/studio-api.md#eval-trend-spend-and-completeness).
- **Opt-in request capture.** `runEval` / `runtime.eval()` / `runRegisteredEval`
  / `rescore` accept `captureRequests`, and `axl-eval` accepts
  `--capture-requests`, recording the provider-neutral request Axl submitted for
  every model call in the run — the case's own turns, tool continuations, nested
  asks, LLM-judge calls, and each transport attempt. `EvalResult.diagnostics`
  reports what was captured (`fidelity: 'runtime_request'`, status, record and
  byte counts, redaction), while `EvalItem.diagnostics` and
  `ScorerDetail.diagnostics` point at the operations they own. Capture is
  **off** by default and never changes what a run costs: a failing, bounded or
  redacted capture leaves `accounting` byte-identical. Every capture entry point
  is total — an unserializable schema or an unrecognized content part degrades
  the diagnostics rail to `status: 'unavailable'` with a reason and leaves the
  run's accounting, admission, retries and returned value untouched. Records are
  bounded per record, per run and per pending queue, written through a queue
  that never delays a provider call, and redacted before they are written
  whenever `trace.redact` is on. A call that never returned leaves a `start`
  record with no `end` — the one you most want to read. A request or response
  that cannot be projected at all costs that ONE record — the same stub the byte
  bound produces, told apart by a `captured.reason` where an over-size stub
  carries `bytes` — never the rest of the run; `status: 'unavailable'` is
  reserved for a failure that really is run-wide. The reason names the error's
  class, never its message, because a stub is written straight to the sink and
  a message can carry the very call redaction was meant to scrub. A retry record
  that could not be projected costs only itself: the response that follows is
  still captured. A
  stream that was closed
  early, aborted, ended without a `done` chunk, or threw mid-iteration is
  instead sealed with an `end` record carrying an explicit `termination`, so the
  two cases stay distinguishable.
- **`RuntimeEvalConfigShape` and `EvalProgressEventShape` are exported from
  `@axlsdk/axl`.** Both appear in the signature of `runtime.eval()`, so typing
  that call no longer needs the optional `@axlsdk/eval` peer dependency.
- **Diagnostic artifact store.** `diagnostics.artifacts` configures where
  captured requests live: `root` for the built-in `FileDiagnosticArtifactStore`,
  or a custom `store` implementing `DiagnosticArtifactStore`. Artifacts follow
  the eval history row that owns them — staged while the run writes, committed
  only after the row is saved (rolled back if that save fails), deleted with
  `deleteEvalResult`, and reclaimed by a startup pass plus a periodic sweep for
  anything orphaned, expired or abandoned by a dead writer. A row may only
  commit or delete an artifact whose manifest names **it** as the owner, so one
  result can never rewrite or destroy another's evidence; `commit`,
  `markDeletePending` and `refreshExpiry` report an artifact that has already
  gone (`{ ok: false, reason: 'missing' }` — the `ArtifactWriteResult` type is
  exported alongside the interface) instead of succeeding silently, and
  a result whose artifact vanished is stored as `unavailable` rather than
  published claiming evidence it cannot serve — including when the SWEEP is
  what removed it, so a stored result is self-describing and no reader has to
  make a liveness call to discover its evidence is gone. That correction is
  written back only while the state store still holds the row, so it can never
  resurrect a result that expired or was deleted, nor extend the retention an
  operator configured. Corrections go through a new optional
  `StateStore.updateEvalResult` — an update-only, retention-neutral write
  (`SET ... XX KEEPTTL` on Redis, which needs Redis >= 6.0; `UPDATE ... WHERE
  id` on SQLite) — because checking first and then saving leaves a window a
  delete slips through, and a store that cannot promise it simply gets no
  correction written. A Redis older than 6.0 rejects `KEEPTTL`, which now
  surfaces as a `REDIS_VERSION_UNSUPPORTED` error named once in a warning
  rather than vanishing into a best-effort catch; corrections then apply to
  that process's cache only, and the stored row is left untouched. A delete
  started in-process beats a correction already in flight,
  `runtime.getEvalResult(id)` confirms the row still exists before serving it —
  and Studio's rescore and compare routes resolve every id through it, so a
  rescore can never republish an expired run's items under a fresh id — and a
  plain re-save keeps the time the row had left rather than
  starting its `ttls.evalHistory` window over — including leaving a
  deliberately untimed row untimed. The writer's lease is renewed on
  a timer for as long as it holds the artifact — not by writing — so a run that
  exhausted its capture bound early, or that is waiting on a tool or a human,
  keeps its records; the hold is bounded by `artifacts.maxHoldMs` (24 h) and a
  run that throws between staging and finalizing rolls its artifact back, so
  neither a caller bug nor a failed run can pin an artifact the sweeper would
  never reclaim. `runtime.openDiagnosticArtifact` serves only committed
  artifacts. A `rescore` with `captureRequests` records the judge calls it makes
  — correlated to the case they scored — into the same artifact its source
  records were copied into, with one `maxRunBytes` budget covering both halves,
  and every degraded rescore reports `artifactId: ''` rather than naming the
  source run's artifact — dropping the per-item refs into it with it. The copy
  may take at most three quarters of the run bound, so the judging it exists to
  record always has room, and a rescore reports the WORSE of its two halves —
  `unavailable` over `truncated` over `complete` — so a sink that died is never
  reported as a limit the caller set. A rescore asked to capture on a runtime
  that cannot host capture throws before any judging, exactly as `runEval` does.
  Every path that stages an artifact releases it if it then fails — the runner,
  the rescore, and Studio's import — so no failure leaves a directory renewing a
  lease no sweep can reclaim. A manifest's `redaction` now reports what the writer
  actually applied — a run captured under `trace.redact` reads back as
  `applied`, an artifact holding copied records only claims `applied` when both
  halves were scrubbed, and an imported bundle is described by its own records rather than
  by the importing deployment's setting. Expiry mirrors the
  owning row: `StateStore.getEvalRetention` is implemented by the Memory, SQLite
  and Redis stores (the last from `PTTL`), and a custom store without it is
  refused **at configuration time** rather than mid-run. An interrupted writer's
  artifact reads back as `interrupted` with its records intact.
- **`runtime.getEvalResult(id)`** returns one eval history entry without
  materializing the whole history to find it. Studio's diagnostics routes
  resolve an artifact through a history id on every request; the previous
  `getEvalHistory()` scan copied every result's full `data` blob first.
- **`axl-eval --capture-requests --output result.json`** writes a
  `result.requests.jsonl` sidecar alongside the result — codec version 1, one
  JSON record per line, validated on the way back in.
- **Studio captured-request endpoints.** `GET /api/evals/:id/diagnostics`
  returns the manifest and `GET /api/evals/:id/diagnostics/records` streams the
  records as NDJSON, both resolved through the eval history id and both redacted
  again at delivery. `POST /api/evals/:name/run` and `.../rescore` accept
  `captureRequests: true`, and `POST /api/evals/import` accepts an optional
  `requests` sidecar — bounded per record as well as in total, so one enormous
  line inside the overall ceiling is refused — re-staged under a **new**
  artifact id owned by the new history row — an imported bundle can never name a path, a URL, or storage in
  the deployment it came from.
- **Studio inspects and downloads captured requests.** A run whose result
  carries a `diagnostics` block gets a "Captured requests" panel on its run
  detail and a marker on its History row: status with what it means, record
  count and size, fidelity, whether the **stored** bytes are redacted, expiry,
  and a rescore's `copiedFrom` provenance. "Download records (.jsonl)" saves the
  NDJSON as `<eval>-<id>.requests.jsonl`, and an inline viewer parses the same
  stream line by line — capped at 200 operations, which it says — reassembling
  the artifact's per-phase lines into one row per operation, so a completed call
  shows its request and its response together and only a genuinely missing
  record reads as missing. A stub names its own cause (over the size limit vs a
  request that could not be projected), and a record scrubbed on delivery is
  distinguished from stored bytes that are scrubbed. A manifest that reads
  `unavailable`, or whose artifact was swept since the result was loaded, shows
  the reason and disables both actions instead of repeating counters for
  evidence that is gone; a run that captured nothing, and a multi-run aggregate
  view (whose result carries run 1's manifest), render nothing.
- **Eval items record why they failed.** A `failed` item now carries
  `item.failure = { name, provider?, status?, retryable?, requestId? }`,
  captured before the thrown value is flattened to `error`. Every field comes
  from the first `ProviderError` on the thrown value or its `cause` chain
  (bounded walk). With none, only the thrown `name` is recorded.
  `failure` never records `ProviderError.body`; `item.error` keeps the error
  message as before, which for some providers can include error-response text.
  The CLI summary adds a
  `Failure causes:` line that groups failed items by status and provider (for
  example `5 × 429 (openai), 2 × other`), so throttling reads differently from a
  bug. The field is additive: `EvalItemOutcome` and the coverage counters are
  unchanged. `rescore` carries it through, and the type is exported as
  `EvalItemFailure`. Studio's Eval Runner item detail shows the cause beside
  the message (provider, `HTTP <status>` or `network`, retryable, request id;
  the name alone for a non-provider error). Under `trace.redact`, `failure` is
  projected to those five keys and any other key is dropped. A multi-run
  Studio result's `summary.itemErrorRate` is the **worst** run's record (not
  run 1's) plus `runsExceeded`, the number of runs over their limit.
  `POST /api/evals/import` drops a `summary.itemErrorRate` that is
  inconsistent with its own counts and marks it
  `metadata.importedItemErrorRate: 'invalid'`.
- **`CallTiming.rateLimitRetries`** counts the rate-limit 429s a call received
  and retried, so a throttled call is distinguishable from one queued behind a
  `maxConcurrent` cap. Built-in adapters always set it (`0` when none); also
  the OTel span attribute `axl.agent.rate_limit_retries`. `axl-eval` totals it
  per model on `summary.modelTiming[model].rateLimitRetries`, and the CLI adds
  `rate-limited N×` to a model's timing row when the total is above 0.

### Changed

- **Breaking (security): a configured `apiKey` now beats the environment.**
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GOOGLE_API_KEY`/`GEMINI_API_KEY`
  used to overwrite a provider's configured `apiKey`, including a rotating-key
  callback, whenever the variable was set. That could send one tenant's calls
  on another credential. The variables are now only a fallback for a provider
  with no `apiKey`, as `docs/api-reference.md` already documented. Any
  configured `apiKey` wins, including a callback and an explicit empty
  string: `apiKey: ''` (for example `process.env.MY_KEY ?? ''`) no longer
  picks up the environment key and now fails as a missing API key (a preset
  that allows no key, such as a local server, simply sends none). A config
  that kept a placeholder key and relied on the variable must drop the
  placeholder. `resolveConfig` also no longer mutates the caller's
  `providers` object.
- **Breaking (exit codes): `axl-eval` now fails a run that lost more than 5% of
  its items.** `EvalConfig.failOnItemErrorRate` defaults to `0.05`. A run whose
  `failed / (count − cancelled − budget_skipped − budget_interrupted)` is
  strictly above the limit exits non-zero with `ITEM ERROR RATE EXCEEDED`.
  Previously a run that lost 250 of 339 items exited 0 and was scored over the
  survivors. **To opt out**, set `failOnItemErrorRate: 1` in the eval file or pass
  `--max-item-error-rate 1`. Any other value in `[0, 1]` sets the limit, and the
  flag overrides the config. `runEval` records the verdict on the new
  `summary.itemErrorRate` (present only when an item failed, so clean artifacts
  are unchanged) and never throws on it. An invalid limit **throws**
  `AxlError('INVALID_ITEM_ERROR_RATE')` before the dataset loads. Under `--runs N`
  each run is gated individually, the failing run is named, and the result
  artifact is still written. `rescore` does not apply the gate and rejects the
  flag.
- **Breaking (exit codes): `axl-eval compare` refuses to certify a thinned
  side by default.** Each compared run's item error rate is checked against
  `0.05`, and the refusal names coverage, the side, and the run. This includes
  pre-0.24 artifacts, whose rate is derived from their items, and rescored
  artifacts. `--max-item-error-rate <0..1>` overrides the limit (`1` disables
  it). A side that lost items within the limit still gets a warning. The pure
  decision is exported as `evaluateItemErrorRateGate(baseline, candidate,
  limit?)` beside `evaluateScorerErrorRateGate`.
- **A rate-limit 429 now waits and retries instead of failing after 3
  attempts, on every built-in chat provider** (OpenAI, OpenAI Responses,
  Anthropic, Gemini, and every OpenAI-compatible preset, at any `baseUrl`). On
  by default, no configuration needed. See
  [providers.md → Rate limiting](docs/providers.md#rate-limiting).
  - **A 429 pauses the scope** (one model on one account) for the exponential
    backoff (1 s, 2 s, 4 s, … up to 60 s), lengthened by a longer `Retry-After`.
    The call retries on its own budget, `RateLimitConfig.maxRateLimitRetries`
    (default 8), separate from the 2 retries for 503/529/network errors.
  - **Then the scope paces itself** at about half its recent request rate,
    recovers on success, and returns to unpaced once traffic stays well below
    that rate. Axl logs one warning per scope when pacing starts.
  - **Nothing changes before the first 429.** No request is estimated, and
    quota headers alone never slow a scope.
  - **Spend caps fail fast on first-party OpenAI and Anthropic**, which are the
    only providers whose 429 bodies Axl reads. Everywhere else every 429 is
    treated as a rate limit, so a spend-cap, daily-quota or gateway-policy 429
    fails only after the retry budget is spent (about 3 minutes, instead of
    about 3 s) and holds other calls on that model meanwhile.
  - **Opt out** per provider with `rateLimit: { adaptive: false }`.

  Also: a throttled call can now take minutes (an ask or context `signal` stops
  its wait; `timeout` is checked only between turns, and `AdmissionController`
  can refuse the next dispatch once spend closes). An abort during a pause, queue wait or
  `503` backoff rejects with the signal's own `reason`. `acquireTimeoutMs`
  bounds only a call's first permit wait. A call that arrives during a pause
  starts that clock when the pause ends.
- **`CallTiming.queuedMs` and `retryMs` no longer overlap.** `queuedMs` now
  covers every wait Axl imposes on itself (the first permit, spacing, adaptive
  pacing, a rate-limit pause, the re-acquire after a 429). `retryMs` is the span between
  the first and final dispatch *minus* those waits. So `429` → 30 s pause →
  `200` reports about 30 s of `queuedMs` and a `retryMs` of only the first
  attempt. On paths without a pause (for example `503` retries) `retryMs` is
  unchanged. `attempts` counts requests actually sent.
- **Rate governors are pooled per runtime, one per scope.** A scope is provider
  family + base-URL origin + credential source + model. `openai` and
  `openai-responses` are one family, a string `apiKey` is compared by value and
  a callback by identity (a rotating token callback is one scope), and the key
  is never logged. Consequences for existing `rateLimit` configs:
  - **Behavior change: `openai:` + `openai-responses:` no longer add up.** With
    one `providers.openai` block, calls through both adapters on one model now
    share one `maxConcurrent` cap instead of each getting its own, so a config
    sized for the sum sees half the concurrency.
  - **Behavior change: caps are per model.** `maxConcurrent` bounds each model
    separately, where one adapter-wide cap used to cover all of its models.
  - Two provider blocks reaching one scope (for example `openai` and
    `openai-responses` with the same key) use the strictest value per field and
    warn once. A block with no `rateLimit` on such a scope is governed by the
    other block.
  - Runtimes never share governors by inference, even on one key. Register one
    provider instance in both runtimes to share; `docs/providers.md` has the
    recipe and its limits.
  - `ProviderRegistry.register(name, factory)` is unchanged; user factories
    still take `(config)`. `registry.clearCache()` now also discards the pooled
    governors.
  - **Breaking for `OpenAICompatibleProvider` subclasses:** the protected
    `governor` field is replaced by `protected governorFor(model)`. A subclass
    that issued its own `fetchWithRetry({ governor: this.governor })` must pass
    `this.governorFor(model)` instead. The adapters' new private member is
    namespaced (`axlRateGovernors`) so it does not collide with subclass members.
  - `RateLimiter.pump()` is now `protected` so an internal subclass can gate
    grants. It is not part of the documented API.
  - A factory registered with `register()` is not joined to the runtime's pool,
    like a registered instance. The one-time "request queued" warning now fires
    once per scope rather than once per adapter.
  - Transcription adapters and the memory embedder keep their per-instance
    behavior.
- **Breaking: `runtime.resolveProvider(uri)` returns a scoped facade**, so
  `resolveProvider(uri).provider === registeredInstance` is now `false`. The
  facade routes `chat`/`stream` through accounting and admission and forwards
  everything else verbatim — custom properties, accessors, class private-field
  methods, property writes, capability methods, and `instanceof`. Its identity
  is stable per runtime per adapter. Exotic reflection (a custom
  `Symbol.hasInstance`, identity-keyed maps) is not preserved. See
  [the migration guide](docs/migration/eval-accounting.md).
- **Breaking: `trackExecution().cost` / `.unpriced` derive from the accounting
  scope**, not from a sum over trace events, and the result gains `accounting`.
  `cost` is unchanged wherever the trace sum was already right and higher where
  that rail lost a charge (a leaf that never settled). **`unpriced` is wider**:
  it now also flags a call that dispatched and returned neither usage nor a
  cost, so it flips `false` → `true` for usage-omitting gateways, custom
  adapters returning bare content, $0 local adapters not declaring
  `pricing: { kind: 'zero' }`, and caught provider failures. No new charge is
  implied — Axl now says it could not confirm the figure instead of presenting a
  lower bound as exact. `ctx.getBudgetStatus().unpriced` / `BudgetResult.unpriced`
  deliberately keep the narrower positive-billable-work rule, so the two
  surfaces can disagree about one run. `trackExecution` is now a throwing
  compatibility wrapper over `trackOutcome`; `runtime.trackCost()` and every
  `ctx.budget()` behavior are unchanged.
- **Breaking: `AdmissionDeniedError` passes through every safe boundary
  unwrapped.** A budget refusal is a stop, not a failure: it is never normalized
  into a `ProviderError`, never wrapped in a `TranscriptionOperationError`,
  never converted into a tool failure fed back to the model, and never retried.
  Code that catches broadly around `ctx.ask` or a tool call and translates
  errors into a model-visible message must rethrow it. `ctx.budget()`,
  `BudgetExceededError`, and `hard_stop` semantics are unchanged.
- **Breaking: an eval's `totalCost` is measured, not reported.** It is now a
  view of `accounting.knownCost`, so a case that threw **after** a paid call
  contributes that charge instead of `$0` — totals on failing runs go up,
  because they were under-reported before. The figure no longer varies with
  trace level, redaction or `captureTraces`, and `unpriced` is present exactly
  when completeness is not `complete`.
- **Breaking: a callback's `cost` is a claim, not a total.** A `cost` returned
  from an eval `executeWorkflow` no longer sets `item.cost` or feeds the run
  total; it is preserved on `EvalItem.callerReport.cost` and summarized on
  `accounting.callerReported`. A scorer-returned `cost` reaches
  `scoreDetails[].cost` only when nothing was measured for that scorer on an
  uninstrumented runtime, and is never summed. Reserved diagnostic metadata keys
  returned by a callback (`models`, `tokens`, …) no longer override the
  runtime's own and are kept under `callerReport.metadata`. An uninstrumented
  runtime (`{} as AxlRuntime`) now yields `incomplete` accounting with
  `reasons.uninstrumented` and a `totalCost` of `0`.
- **Studio reads "budget stopped" the way the eval package does.** The run
  banner, the run/group history badges, the multi-run `budgetStoppedRuns` count
  and the trend-window chip all now require refused work, not merely a closed
  controller — a run that set its budget to its expected spend and completed
  every case no longer reads as truncated in four places at once. The compare
  view keeps the sign of an uncertified cost delta in its text (it is
  deliberately uncoloured), labels the compared figure "Known spend (per run)"
  because `compare.ts` averages a group, and a compare side with no runs loaded
  reports `unverified` rather than a certified `$0.00`. The trends cost
  sparkline marks lower-bound and unverified points as hollow rings on dashed
  segments, with the count in its accessible name, instead of drawing them as
  part of one measured trend; the window spend figure states its own
  completeness rather than borrowing the shared cost badge's "unpriced model"
  wording. A budget-thinned scorer mean now carries a caveat in the multi-run
  aggregate view, which renders no coverage block of its own.
- **`refusedWork(coverage)` and `isBudgetStopped(summary)`** are exported from
  `@axlsdk/eval`. They own the one rule that separates "the budget closed" from
  "the budget truncated this run" — a stop requires refused cases or refused
  judges, not just a closed controller — so the CLI, the Studio server and the
  Studio browser mirror cannot drift apart on it.
- **`EvalComparison.summary` states a cost change only when `cost.certified`.**
  A one-line "40% cheaper" has no room for the refusal reason, so an
  uncertified saving read as a measured one. The structured `cost` block still
  carries both totals, the delta and the reason.
- **Breaking: `axl-eval` exits non-zero when a budget refused work**, printing a
  distinct `[axl-eval] BUDGET STOPPED …` line first. The exit is driven by
  coverage, not by the controller's status: a run whose spend lands exactly on
  the limit with every case and scorer completed refused nothing and exits `0`.
  `axl-eval rescore --budget` reports and exits by the same rule, after writing
  the partial artifact. A budget stop is deliberately not
  counted as a model failure in the wipeout/degraded logic, and the summary
  prints known spend with a completeness label (e.g.
  `Cost: $1.50 (incomplete: 1 unpriced_model)`) plus budget and coverage rows.
  `EvalSummary.failures` keeps its old meaning — items that produced no output,
  budget-stopped cases included — so gate CI on `summary.coverage` instead.
- **Studio: `callerReport.metadata` is scrubbed under redaction.** It is raw
  callback output, so it is dropped like scorer metadata; item and scorer
  `outcome` / `accounting` are preserved as structural, non-content fields. Eval
  imports without accounting are stamped `unverified` on the way in.
- **Studio: a declared `accounting` on an import must prove itself.** An
  imported result carrying its own `accounting` is kept only if the record is
  internally consistent — version 1, USD, a finite non-negative `knownCost`, a
  known `completeness`, `operations.total === settled + unknown`, and (for
  `complete` / `incomplete`) provenance and breakdown splits that sum back to
  `knownCost`. Item-level and scorer-level records are held to the same rule,
  all-or-nothing — and so are the two accounting-derived facts a reader turns
  into a budget-stopped badge: `accounting.budget` (finite non-negative figures,
  a known `status`, `knownOvershoot === max(0, knownSpend - limit)`, and
  `status === 'closed'` exactly when `knownSpend >= limit`, the only rule an
  `AdmissionController` closes on) and
  `summary.coverage` (every outcome key present as a non-negative integer),
  including a coverage block that arrives with no accounting beside it.
  A failing result loses all three, so nothing downstream can excuse its missing
  cases as a budget stop. A record that fails is replaced by the same `unverified`
  synthesis an artifact with no accounting receives, so `compare` refuses to
  certify a cost delta from a hand-edited "complete" file. Import never rejects
  a result over its accounting; `metadata.importedAccounting` records
  `'declared'` or `'invalid'` so the decision is visible rather than inferred.
- **Studio: in redact mode `EvalItem.metadata` keeps only the measured keys**
  (`models`, `modelCallCounts`, `workflows`, `workflowCallCounts`, `tokens`,
  `agentCalls`); every other key is masked, matching the policy already applied
  to `callerReport.metadata`.
- **A settled charge reaches its `AdmissionController` across duplicate
  installs.** The internal settlement channel is a registry symbol and
  `AdmissionDeniedError` is now recognized structurally, so a budget attached
  through a second copy of `@axlsdk/axl` (ESM alongside CJS) still records spend
  and still reads as a stop rather than a model failure. An object that carries
  no settlement channel at all raises
  `AxlError('INCOMPATIBLE_ADMISSION_CONTROLLER')` naming the duplicate-install
  cause, instead of a bare `TypeError`. The new `isAdmissionDeniedError(err)`
  predicate is exported for callers that classify errors themselves.

### Fixed

- **Studio no longer presents run 1's `modelTiming` as a multi-run
  aggregate.** The aggregate summary of a multi-run eval (the sync response
  and the Eval Runner's rebuilt group) spread run 1's per-model latency and
  rate-limit totals as if they covered the batch. It now omits
  `modelTiming`. Each run in `_multiRun.allRuns` keeps its own.
- **`rescore` keeps `summary.timing` and `summary.modelTiming`.** A rescored
  result dropped the source run's wall-clock and per-model provider latency. A
  rescore makes no generation calls, so it now carries both forward unchanged.
- **`retry-after-ms` is honored, and no retry hint shortens a backoff.**
  OpenAI and Azure OpenAI send this millisecond retry hint. When it's present
  and positive, it now takes precedence over `Retry-After` (as in OpenAI's own
  SDK) for both the retry wait and `ProviderError.retryAfterMs`. On every
  retry path a hint may now only lengthen the exponential backoff (1 s, 2 s,
  4 s, …, clamped at 60 s), never shorten it: `retry-after-ms` values of tens
  of milliseconds would otherwise spend a whole retry budget in seconds under
  sustained throttling. Previously a short `Retry-After` (for example `1` on
  a later retry) was used as-is. `ProviderError.retryAfterMs` still carries
  the raw, unclamped value.
- **A 503/529 retry never sleeps past 60 s.** A huge `Retry-After` was clamped to
  60 s before the ±25% jitter was applied, so the wait could reach 75 s. The
  clamp now applies after jitter as well.
- **Retried provider responses no longer leak their connection.** When the
  transport retries a 429, 503 or 529, it now cancels the discarded response's
  body before backing off, instead of leaving it open until garbage collection.
  A response that is returned (success, a non-retryable error, or the last
  attempt after retries run out) keeps its body, so `ProviderError.body` is
  still the raw provider text.
- **An aborted, rate-limited queue no longer holds the process open.** When
  every call waiting on `minIntervalMs` spacing (or on adaptive pacing after a
  rate-limit 429) aborts or times out, the limiter now clears its spacing
  timer instead of leaving it armed for up to one interval.
- **Retry backoffs no longer pile abort listeners onto a shared signal.** Each
  completed backoff sleep now removes its listener from the call's
  `AbortSignal`. Before, every retry on a long-lived signal (for example one
  `AbortController` for a whole run) left a listener behind until that signal
  was aborted or collected, which could trigger Node's
  `MaxListenersExceededWarning`.
- **Studio: every run of a multi-run eval response is redacted.** Under
  `trace.redact`, a synchronous `POST /api/evals/:name/run` with `runs > 1`
  masked only the top-level `items`, while `_multiRun.allRuns` served each
  run's inputs, outputs and error messages raw. Each run is now scrubbed the
  same way as the top-level result, and so is `_multiRun.batchFailure`. The
  history read applies the same rule to an imported artifact that carries
  `_multiRun`. Import drops a `_multiRun` the read cannot walk and marks it
  `metadata.importedMultiRun: 'invalid'`. Under redaction, a stored item or
  run with an unexpected shape is replaced with `[redacted]` instead of
  failing the whole history list.
- **Studio: eval compare responses are redacted.** Under `trace.redact`,
  `POST /api/evals/compare` returned each regression's and improvement's
  `input` (the baseline item's raw input) and each side's
  `metadata.batchFailure` unmasked, so comparing two history ids bypassed
  the history scrub. `readOnly` deployments allow compare, so this was
  reachable by the least-privileged Studio role. Those fields are now masked;
  `itemIndex`, scores and every statistic are unchanged.

## [0.23.3] - 2026-09-09

### Added

- **Modality-aware audio cost estimation.** Audio-bearing `openai:` Chat
  Completions and `google:` Interactions calls are now **priced** instead of
  unpriced, so `ctx.budget()` can enforce a cost limit on audio work and cost
  dashboards show a published-rate estimate rather than a `≥ $X` lower bound. Audio
  tokens bill from a per-model audio rate row, never from the text row: the
  prompt splits into disjoint cached / cache-write / audio / text buckets and
  each bills at its own published rate, with output plus (on Gemini) thought
  tokens at the output rate. Rates are carried for `gpt-audio-1.5`,
  `gpt-audio`, `gemini-2.5-flash`, and `gemini-3.7-flash` (reviewed 2026-09-08
  against the first-party pricing pages; the announced 2027 Gemini increase is
  deliberately not encoded). A call with any billed bucket lacking a
  published rate — or whose reported counts do not reconcile — stays
  `undefined`, never `0`: an audio-bearing call on a model without an audio
  rate, a missing audio count on an audio-bearing request (missing is not
  zero), an unknown Gemini modality,
  server-side tool tokens, cached tokens co-occurring with audio tokens (the
  providers do not document whether the two buckets overlap), a Gemini
  `total_tokens` that does not reconcile with its parts, a non-text reply, a
  non-Standard tier, a non-canonical base URL, or a long-context crossing that
  carries audio. A custom `ProviderProfile` using `pricing: { kind: 'table' }`
  is likewise unpriced on a call that billed audio tokens, since a
  `PricingTable` cannot express an audio rate. `openrouter:` is unchanged
  (`usage.cost` stays authoritative), images on `openai:` Chat Completions stay
  unmodeled, and `MockProvider` is untouched. Text-only pricing is unchanged,
  **with one exception**: a text call whose usage nonetheless reports audio
  tokens, on a model with no published audio rate, is now unpriced rather than
  billed at the text rate — usage is authoritative, so a reported audio bucket
  means real audio billing at a price Axl does not know.
  **This is not retroactive:** executions recorded before this release keep
  `unpriced: true` for audio work, so anyone diffing historical against new
  executions sees a step change at the release boundary.
  Reconciled text- and image-only Gemini Interactions calls use ordinary
  catalog rates, independent of audio-rate availability; see the pricing
  expansion below and [`docs/providers.md`](docs/providers.md#rich-input-calls).
- `ProviderResponse.usage` and terminal stream chunks gain optional
  `audio_input_tokens` / `audio_output_tokens` — the audio share of
  `prompt_tokens` / `completion_tokens`, populated on `openai:`,
  `openrouter:` (observability only), and `google:` Interactions. Both fields
  are **absent, never `0`**, when the provider reported no split or an
  unusable count, and `prompt_tokens` remains the folded total. The two usage
  shapes stay in field parity, so streaming consumers see the same fields as
  `chat()`. `AxlEventBase.tokens` and the public `PricingTable` type are
  deliberately unchanged.
- **General recorded-audio input.** `InputContentPart` gains an audio member,
  `InputAudioPart` (`{ type: 'audio', source: RecordedAudioSource, label? }`), so
  a chat model can reason directly about a finite recording — speech *and*
  non-speech sound. Sources are `bytes | base64 | provider-file`; an audio URL is
  unrepresentable by construction because the part reuses the same
  `RecordedAudioSource` union `ctx.transcribe()` accepts. This is usable in this
  release: audio parts are reachable through the barrel-exported
  `InputContentPart` and are accepted at runtime on the adapters below. The
  `InputAudioPart` *name* is exported as documentation, not as an availability
  gate.
  Transport ships on `openai:` (Chat Completions `input_audio`, `wav | mp3`,
  bytes/base64), `openrouter:` (`input_audio` with a wider closed format table,
  bytes/base64), `google:` (Interactions `{ type: 'audio', data | uri,
  mime_type }`, bytes/base64/provider-file), and `MockProvider`. Ordered audio
  survives retries, schema and guardrail recovery, tool continuations, delegate,
  handoff, and streaming, exactly like an image. `anthropic:`,
  `openai-responses:`, and every other OpenAI-compatible preset reject an audio
  part with a zero-request `UnsupportedModelInputError` (`modality: 'audio'`) and
  never fall back to transcription.
  **Live-certified compositions:** `google:` for a text answer from speech and
  non-speech audio, a stateless tool continuation, structured output,
  streaming, and an audio turn re-sent from application session history;
  `openrouter:` for a text answer, a tool continuation, and streaming;
  `openai:` for a single-turn text answer only — `gpt-audio-1.5` failed the
  tool continuation provider-side (`500`) and rejects `response_format`
  (`400`), so those compositions are recorded, not advertised. See
  [`docs/verification/general-audio-lighthouse-2026-09-08.md`](docs/verification/general-audio-lighthouse-2026-09-08.md)
  and [`docs/multimodal-input.md`](docs/multimodal-input.md#general-recorded-audio-input).
- `InputModalitySupport.audio` on `Provider.inputCapabilities` — declaring it is
  the sole audio opt-in. The runtime fails closed for audio *before*
  `validateInput`, and re-checks the capability if a validator substitutes a
  different effective model. Image preflight is unchanged.
- `CapabilityFlags.inputModalities` and the `ProfileInputModalities` type on the
  OpenAI-compatible engine, so a profile declares rich-input support explicitly
  instead of the engine branching on the provider's name.
- `summarizeModelInput` is exported from the core barrel: the context-safe
  projection rendering media as `[image <mediaType>]` / `[audio <mediaType>]`.
- `MockProvider.withInputModalities(['image' | 'audio'][])` — restrict the rich
  modalities the mock declares, so a provider that does not support a modality
  can be exercised offline. Both are declared by default.
- `ModelInputDescriptor` gains an `audio` part variant; its `locator` can only
  come from a provider-file reference.
- `axl.input.audio` span attribute on the `axl.model_input` event.
- Live certification rows `GA1`–`GA12` (plus `GA2-text`) in
  `packages/axl/src/__tests__/integration-general-audio.test.ts`, double-gated
  behind `AXL_MULTIMODAL_LIVE=1` + `AXL_GENERAL_AUDIO_LIVE=1` (`GA2` additionally
  behind `AXL_GENERAL_AUDIO_OPENAI_TOOL_LIVE=1`).

### Changed

- Refined development-agent routing, added budget implementation and debugging roles, and made plan leads accountable for orchestration timing, rework, and evidence-backed process improvements.

- **`InputContentPart` is widened with the audio member.** This is additive for
  *producers* — no existing code can construct an audio part, and the runtime
  guarantees audio never reaches a provider that did not opt in. It is **not**
  compile-time safe for *consumers*: any code that branches over
  `InputContentPart` or `ModelInputDescriptor` with a non-exhaustive `else`
  (`if (part.type === 'text') … else /* image */ …`) will now silently label
  audio as image. Switch exhaustively over `part.type`. Every in-repo projection,
  including the three Studio sites, was made exhaustive with a `never` arm in
  this change. Released as a patch under the 0.x rule.
- **`MockProvider.echo()` projects media parts instead of dropping them.** It now
  returns `summarizeModelInput(...)` rather than `inputText(...)`, so a prompt of
  `['before', image, 'after']` echoes `'before\n[image image/png]\nafter'` where
  it previously echoed `'before\nafter'`. Tests asserting on `echo()` output with
  media in the prompt need updating. One projection is shared with the runtime's
  context summarizer so echo and context estimates cannot disagree.
- `inputCapabilities()` now returns an `audio` key on `google:`, `openai:`,
  `openrouter:`, and `MockProvider`. A consumer asserting on that object with
  `toEqual` will need the new key.
- `UnsupportedModelInputError.modality` reports the **offending** part's modality
  rather than a hardcoded value, so a mixed input whose audio part is rejected
  reports `'audio'` and one whose image part is rejected reports `'image'`.
- Three user-visible message strings changed:
  `Inline image data must not exceed 25 MiB total; use a URL or provider-file
  source where supported` → `Inline media data must not exceed 25 MiB total; use
  a provider-file source, or a URL for images, where supported`;
  `Uint8Array image input cannot be persisted in session history` →
  `Uint8Array media input cannot be persisted in session history`; and
  `part N.type must be 'text' or 'image'` →
  `part N.type must be 'text', 'image', or 'audio'`.
- The persisted-session-history bytes guard is now type-agnostic over every
  non-text part instead of an image-specific branch.
- `axl.input.source.*` and `axl.input.inline_bytes` span attributes now count
  **all** non-text parts, so an audio-bearing ask is not reported as carrying
  zero media bytes. `axl.input.images` stays image-only for existing consumers.
- `estimateMessagesTokens` treats audio history as unmeasured media exactly like
  images, so audio is never counted as zero context and the unmeasured-context
  warning still fires.
- **Gemini Interactions now prices known text/image usage on models without an
  audio rate.** A verified audio rate is required only when audio tokens are
  positive. Reconciled text/image calls, including cached and long-context
  calls, use the existing catalog rates; positive audio without a rate and
  all other unsupported billing cases remain unpriced. Previously recorded
  executions are not rewritten.

### Fixed

- **`SQLiteStore`, `SqliteVectorStore` and `RedisStore` work from the ESM
  build.** Each loads its optional dependency with a synchronous `require()`,
  which the bundler rewrote to a shim that has no `require` to bind in an ESM
  output and throws on call. The stores caught that throw and reported it as a
  missing dependency, so an ESM consumer saw "better-sqlite3 is required" /
  "redis is required" with the package installed and resolvable. The CJS build
  was unaffected. The ESM bundle now defines `require` via `createRequire`, and
  a smoke test constructs each store from the built ESM entry point.

- **Gemini Interactions now honors response service tiers when estimating cost.**
  Top-level response tiers, the `x-gemini-service-tier` header, and streaming
  lifecycle events are checked together. Any non-standard, unknown, or
  conflicting evidence leaves cost unknown while preserving token usage.
  Non-standard requests remain unpriced even when Google reports a Standard
  downgrade. Standard calls keep their existing estimates.

- **Session workflows no longer send the current user input twice by default.**
  When a workflow passes the same current input to `ctx.ask()`, the model sees
  it once while persisted history remains unchanged. Matching includes the
  full ordered rich input, so media is preserved and later equal turns remain
  distinct. Set `SessionOptions.deduplicateInput: false` to retain the legacy
  duplicate provider request.

## [0.23.2] - 2026-09-07

### Fixed

- **A Node `Buffer` passed as a `bytes` media source is now copied, not
  aliased.** `Buffer.prototype.slice()` shares memory, so the ownership copy
  the runtime takes on normalization (and the `MockProvider` call record) was a
  view over the caller's buffer for the most common input path,
  `readFileSync`. Both now allocate a fresh `Uint8Array`. Images and audio.
- **`ctx.delegate({ routerInput: 'text' })` on a media-only input throws
  `InvalidModelInputError`** instead of routing on an empty user turn.
- **`Session.send()` / `stream()` no longer persist a rich `ModelInput` as
  JSON.** A workflow input made of text/image/audio parts was recorded as a
  JSON string — inline base64 included — which bypassed the inline media cap
  and was re-sent to the model as *text* on every later turn. The `user` turn
  is now the context-safe projection (`question\n[audio audio/wav]`); media
  stays per-call evidence, and a malformed part fails with
  `InvalidModelInputError` before the workflow runs. Application objects are
  still recorded as JSON.
- **Gemini Interactions tool continuations no longer fail with `400 Invalid
  input received`.** The stateless (`store: false`) continuation omitted the
  required `name` on each `function_result` step. The adapter now remembers
  every `function_call`'s name by `call_id` and echoes it on the matching
  result; a tool result whose name cannot be resolved (application history
  with no matching call and no `name`) throws `InvalidModelInputError` naming
  the call id instead of sending an empty name for the provider to reject.
  Pre-existing; it affected every Interactions tool round-trip, not only
  audio-bearing ones.
- Eval item annotations now preserve omitted runtime accounting fields and their
  model/workflow roll-ups across direct, CLI, and registered evals. Metadata is
  collected independently of trace capture and shallow-merged with valid user
  metadata; explicit user keys still override tracked values. Cost behavior is unchanged.

## [0.23.1] - 2026-09-04

### Added

- **Three distinct `ctx.ask()` time controls.** `timeout` is now documented and consistently
  resolved as a graceful between-turn budget (Ask > Agent > Defaults > 60 seconds), excluding
  only `awaitHuman` wait. New opt-in `stallTimeout` aborts a dispatched provider request that
  stops making progress (`StallTimeoutError extends TimeoutError`); built-in adapters start it
  after limiter queueing, reset it on every stream chunk, and pause it for SDK retry backoff.
  Runtime settlement does not depend on provider cooperation: a custom provider or stream
  iterator that ignores cancellation still releases the caller at the stall boundary. Any such
  abandoned work can finish or be billed later and cannot update already-terminal accounting;
  dispatched stalled calls mark the resulting event, ask, budget, and execution totals unpriced.
  New per-ask `signal` composes with context/branch cancellation first-wins, preserves the
  caller's exact abort reason, is sibling-local, and is inherited by nested asks. Partial
  responses from hard aborts are discarded. See [API reference](docs/api-reference.md#ask-deadlines-cancellation-and-stalled-requests).

### Fixed

- **Streaming timing now preserves `wireMs >= firstTokenMs`.** First-content parsing and
  generator scheduling can finish just after the corresponding body-read wait, previously
  allowing an immediately truncated stream to report `wireMs` one millisecond below
  `firstTokenMs`. `wireMs` now includes that pre-first-content delivery gap while still
  excluding time a consumer spends paused after any yielded chunk, including a tool delta
  that precedes first content.

## [0.23.0] - 2026-09-03

### Added

- **Per-call latency breakdown (`CallTiming`) on provider responses and
  `agent_call_end`.** Under an opt-in `rateLimit`, `agent_call_end.duration` conflates the
  SDK's own queue wait, provider 429 backoff, and real model latency, so a latency
  comparison across models, or an eval under fan-out, measured the queue as much as the
  provider. All four built-in chat adapters (`anthropic`, `openai` and every
  OpenAI-compatible preset, `openai-responses`, `gemini`) now report `timing` on `chat()`
  and on the terminal `done` chunk of `stream()`, and the runtime copies it onto
  `agent_call_end.timing` beside the unchanged `duration`: `queuedMs` (Axl's own
  governor, `0` without one), `attempts` / `retryMs` (failed attempts and their backoff),
  `ttfbMs` (dispatch → headers), `firstTokenMs` (dispatch → first content delta,
  streaming only), and `wireMs` (provider time; on a stream only the time spent awaiting
  body reads, so slow `ctx.events` consumers are not charged to the model). The block is
  optional end to end: a custom `Provider` that omits it stays valid, so treat every
  field as possibly absent. See
  [api-reference.md#calltiming](docs/api-reference.md#calltiming),
  [providers.md](docs/providers.md#rate-limiting-opt-in) and
  [observability.md](docs/observability.md#per-call-timing).
- **Failed provider calls carry `timing` too.** One rule: present whenever the provider
  returned a response. Every adapter attaches the block to the `ProviderError` it throws at
  a non-2xx response and at every mid-stream failure (an SSE `error` frame, or a stream
  truncated before its terminal event), and the runtime copies it onto the error-path
  `agent_call_end`. A 429 storm shows its `attempts` and `retryMs` instead of going dark,
  and a stream that hung after its first token is distinguishable from one that never
  produced a token. Branch on the presence of `timing`, never on `status`: `status: 0`
  only means "no HTTP status to map". The key is absent when there was no response to
  measure (a connection failure, an abort, or a non-provider throw).
- **OpenTelemetry spans carry the same figures.** When telemetry is enabled the
  `axl.agent.ask` span sets `axl.agent.queued_ms`, `retry_ms`, `attempts`, `ttfb_ms`,
  `wire_ms` and `first_token_ms` (streaming only), only when the call reported timing.
- **`TimeoutError` explains where a timed-out ask's budget went.** When at least one
  completed turn of the ask reported `timing`, the message appends
  `(elapsed Nms: queued Nms, retries Nms, wire Nms, other Nms)` and a readonly `breakdown`
  property (`TimeoutBreakdown`) carries the same numbers. The existing
  `ctx.ask() exceeded timeout of Nms` prefix is preserved verbatim, and with no
  instrumented turn the message is byte-identical to before with `breakdown` undefined —
  an all-zero breakdown would falsely blame tools and gates on an uninstrumented provider.
- **`runtime.trackExecution()` rolls timing up per model.** A new optional `modelTiming`
  return field, keyed like `metadata.modelCallCounts`, sums the block per model over the
  **successful** timed calls (`calls` is that count; `firstTokenMs` carries its own
  `firstTokenCalls` denominator). Failed calls are excluded on purpose: a rollup blending
  answers with failures describes neither, and a fast 429 would flatter a model. The raw
  per-call blocks are collected as `samples` only under the new `captureTimingSamples`
  option, so every other caller keeps paying only for the sums. `fetchWithRetry` gains an
  optional passive `timing: { onDispatch, onComplete }` observer with no change to its
  return type.
- **`axl-eval` reports provider latency per model, separate from wall clock.**
  `EvalItem.duration` and `summary.timing` measure the whole workflow, queue included, so
  under `concurrency` fan-out against a `maxConcurrent` cap they describe your pacing more
  than the model. Each item now also carries compact per-model sums,
  `item.timing[model] = { calls, queuedMs, retryMs, wireMs, firstTokenMs?, firstTokenCalls? }`,
  and the run carries `summary.modelTiming[model]` where every field is a
  `{ mean, min, max, p50, p95 }` distribution over **per-call** values, so `p95` is a real
  call percentile and a model throttled hard on the day shows it in `retryMs` rather than
  inflating `wireMs`. `firstTokenMs`, the figure that actually discriminates between
  models, runs over streaming calls only. The CLI prints one line per model under the
  `Timing` row, in milliseconds. Populated on both the default and the `captureTraces`
  path; cost, `unpriced`, `metadata` and budget enforcement on the default path are
  unchanged. New exported types `ItemModelTiming` and `ModelTimingStats`. See
  [testing.md](docs/testing.md#comparing-model-latency-in-an-eval).
- **`MockProvider` responses accept a `timing` block** that surfaces on
  `ProviderResponse.timing` and on the streamed `done` chunk, so runtime and eval timing
  behavior is testable with exact integers and no transport. `MockProvider.stream()` now
  also forwards the fixture `cost` on that `done` chunk, matching `chat()`: a test that
  streams a mock with a non-zero `cost` under a `ctx.budget` or an eval `budget` now sees
  that cost and can newly stop or fail, where streamed mock asks previously cost `$0`.
- **`promptCache` option — opt-in Anthropic prompt caching of the stable prefix.**
  `AgentConfig.promptCache` / `AskOptions.promptCache` (AskOptions wins). On
  Anthropic the adapter renders `system` as ordered blocks with one `cache_control`
  breakpoint on the first block — the agent's own prompt — so the tool definitions
  are covered too, while runtime-injected summaries, handoff headers, the JSON-mode
  instruction and the user turn stay uncached. A large one-shot user document is
  therefore never written to cache. OpenAI and Gemini cache automatically, so the
  flag is a no-op there. **Off by default:** a system prompt that changes every call
  would pay Anthropic's 1.25x write premium with no reads. With it off, requests are
  byte-identical to before. Live-verified on `claude-sonnet-4-6`: repeat calls read
  1,618 cached tokens at ~1/10 the cost, and a 2,000-token unique user turn wrote
  nothing. When it is on, one `log` warning names the agent if consecutive calls
  on one context either write without ever reading (a per-call-changing prefix)
  or show no cache activity at all (a prefix below the model's minimum, which
  Anthropic silently ignores). If `providerOptions` supplies a top-level
  `cache_control`, `system`, or `tools`, Axl adds no breakpoint of its own — the
  caller owns the prefix. `ChatMessage` gains an optional `origin?: 'runtime'`
  provenance field, set by the runtime on the summary and handoff-header system
  messages it synthesizes and never sent on the wire, so adapters can tell them
  from the caller's own prompt. `Provider` gains an optional
  `realizesPromptCache?(model)` capability (like `nativeStructuredOutputSupport`);
  the runtime emits the promptCache diagnostics only for adapters that declare
  it, and the built-in Anthropic adapter does. See
  [providers.md#prompt-caching](docs/providers.md#prompt-caching).
- **Claude Fable 5.1 (`claude-fable-5-1`) capabilities and pricing.** Adaptive
  always-on thinking with all five effort levels (thinking cannot be disabled;
  `effort: 'none'` clamps to `'low'` and reports a `provider_diagnostic`), priced
  at $10/$50. `claude-mythos-5-1` and `claude-mythos-5` are priced at the same
  rates but intentionally have **no** capability entry: they are
  limited-availability models with no published per-model thinking semantics, so
  their requests pass through unmodified rather than carrying an inferred shape.
  Because Axl prices them, it also now reports that pass-through: requesting an
  `effort` on a **priced** model with no capability entry emits
  `provider_diagnostic { kind: 'effort_clamped', effective: 'unset' }` so the
  dropped knob is visible rather than silently billed at full rate. Unpriced
  pass-through IDs stay silent as before. No new event type or `kind` value.
- **Per-model cache-read multipliers on Anthropic.** Cache hits are 0.1x base
  input on every model except Claude Fable 5.1 and Mythos 5.1, which read cache
  at **0.025x**. `estimateAnthropicCost` previously hardcoded 0.1x, which would
  have overpriced Fable 5.1 cache reads 4x.

### Breaking Changes

- **`OpenAICompatibleProvider.parseSSEStream` is now `private` and is no longer an
  override point.** It was `protected`, but `protected` could not
  carry the guarantee it implied — TypeScript checks an override for assignability, so a
  subclass that simply dropped the timing recorder still compiled and then reported
  `wireMs === ttfbMs` for every stream, and the recorder's type was never exported from
  the barrel for a subclass to name. A provider with a different wire format implements
  `Provider`; an OpenAI-compatible one adds a `ProviderProfile`.

### Fixed

- **Context summarization could discard the entire conversation.** When an
  agent's fixed overhead (system prompt + tool definitions +
  `contextManagement.reserveTokens`, which defaults to 2000) met or exceeded its
  `maxContext`, the history budget went non-positive, no message could "fit",
  and `summarizeHistory` returned a lone summary message with **every real turn
  dropped** — including the newest one the next reply depends on. The cached
  summary could never be reused in that state either, so each ask paid a fresh
  summarization call and overwrote the persisted `summaryCache`. Summarization
  now retains the most recent exchange where it can, always anchored on a user
  turn so the request opens the way every provider documents — `sessionHistory`
  does not alternate roles, since `ctx.ask` only ever appends assistant turns.
  (Live-probed 2026-09-03: Anthropic, OpenAI and Gemini each accepted an
  assistant-first request, so this is well-formedness and portability, not a
  workaround for a rejection.) Where no
  user turn is available to anchor on, the history is summarized in full
  instead; the current input is appended separately either way, so no ask
  reaches a provider without a user turn. An unsatisfiable context budget emits a `log` warning
  naming the agent, its `maxContext`, and the overhead breakdown instead of
  silently discarding history. A cached summary that no longer leaves room for
  the newest turn is regenerated rather than reused, so turns added since the
  previous summary cannot become permanently invisible to the model.

- **`gemini-3.7-flash` and `gemini-3.8-flash` had no pricing.** Both were
  already supported for requests (effort mapping, multimodal input) but were
  missing from the rate table, so `response.cost` was `undefined` for the two
  newest Flash models. Both are now priced at $0.75 / $0.075 cached / $3.75.
- **`gemini-3.6-flash` was priced ~2x too high.** It moved onto the same Flash
  promotional rate ($0.75 / $3.75, announced through 2026-12-31); the table still
  carried the pre-promotion $1.50 / $7.50.
- **`gemini-3-flash-preview` is no longer priced.** It has dropped off Google's
  published pricing page while remaining callable, so its usage is now reported
  with `cost: undefined` instead of a stale, unverifiable rate. Requests to it
  are unaffected, but **cost enforcement changes**: per the existing unpriced
  contract, `ctx.budget()` cannot enforce a cost limit on spend it cannot price,
  so a `maxCost` cap no longer trips on this model. The spend is still surfaced —
  the budget reports `unpriced: true` and warns once per scope — but if you
  relied on a hard cost cap here, pin a priced model such as
  `gemini-3.8-flash`.
- **`gpt-5.6` / `gpt-5.6-sol` was priced above its current rate.** The catalog
  held $5 / $0.50 cached / $6.25 cache write / $30, but Sol is on a promotional
  $4 / $0.40 / $5 / $20 (announced as running at least through 2026-11-21), so
  output was overestimated 50%. The long-context tier derives from the short row
  and moves with it. `gpt-5.6-terra` and `gpt-5.6-luna` were already correct.
- **Claude Sonnet 5 was overpriced 50% from September 1, 2026.** The rate table
  encoded Anthropic's *announced* increase from the introductory $2/$10 to
  $3/$15 as a forward-dated gate, so every `claude-sonnet-5` cost estimate
  switched to $3/$15 once that date arrived. Anthropic cancelled the increase and
  $2/$10 is now the standard price. `estimateAnthropicCost` no longer takes a
  `now` argument and no rate varies with the clock: tables hold only the
  currently published price. See
  [providers.md#cost-estimation](docs/providers.md#cost-estimation).

## [0.22.3] - 2026-09-03

### Added

- **`retryFeedback` hook on `AskOptions` and `DelegateOptions`.** One hook across
  the guardrail, schema, and `validate` gates decides what the model is told when
  an attempt is rejected. It receives the stage, the rejected output, the gate's
  reason and error, the parsed value (validate only, typed from `schema`), and
  the default text. Return a string to replace the default, nothing to keep it,
  or `{ retry: false }` to stop retrying with the gate's usual typed error; a
  thrown error propagates. It runs only while a retry remains and after the
  gate's own event, so `guardrail` / `schema_check` / `validate` events keep the
  default text and `pipeline(failed).reason` carries what was sent. Forwarded on
  delegate and handoffs like `validate`. New types `RetryFeedbackHook<T>`,
  `RetryFeedbackInfo<T>`, `RetryFeedbackResult`. See
  [api-reference.md#custom-retry-feedback](docs/api-reference.md#custom-retry-feedback).
- **`provider_diagnostic` event reports clamped `effort`.** When an adapter has
  to send a different reasoning level than requested (Gemini 3.x cannot disable
  thinking and caps at `'high'`; OpenAI Chat caps `'max'` at `'xhigh'`; some
  Anthropic models always think, and legacy budget models cap at the `'high'`
  tier), the runtime emits one `provider_diagnostic { kind: 'effort_clamped' }`
  event per ask, before its first `agent_call_start`, with `requested`, the
  provider-native `effective` level, and a `cause`. `agent_call_start` still
  reports the requested effort; join by `askId`. Providers opt in via the
  optional `Provider.effortResolution()` capability (types `EffortResolution`,
  `ProviderDiagnosticData`); `MockProvider.withEffortResolution()` drives it in
  tests. **`provider_diagnostic` is a new member of `AxlEvent['type']`**: an
  exhaustive `switch` over event types gains a case. See
  [observability.md#provider-diagnostics](docs/observability.md#provider-diagnostics).

### Changed

- **Clamp warnings moved from adapters to the runtime.** The once-per-process
  `console.warn`s in the Gemini, Anthropic, and OpenAI Chat adapters are gone;
  the runtime warns once per distinct clamp and honors
  `AxlConfig.diagnostics.silent` / `AXL_DIAGNOSTICS_SILENT`. Request bodies are
  unchanged. Calling an adapter directly no longer logs a clamp warning; use
  `Provider.effortResolution()`.

### Fixed

- **Gate-retry feedback is delivered as a user turn.** Guardrail, schema, and
  `validate` retries appended the correction as a `system` message. Adapters
  hoist system messages out of the conversation, so the model saw a request
  ending on its own rejected attempt: an assistant prefill on Anthropic, and a
  hard "does not support a terminal assistant/model prefill" throw on Gemini
  models that reject a terminal model turn, which failed every validation retry
  there. Feedback is now a `user` turn after the assistant attempt. The
  `validate` and schema feedback texts were rewritten to ask for a corrected
  response without affirming the rejected output or pointing at content the
  model cannot see. `trace.level: 'full'` message snapshots reflect the new
  shape; gate and `pipeline` events keep their shape and carry the new text.

## [0.22.2] - 2026-09-02

### Changed

- **Native image transports follow provider catalogs.** OpenAI Responses,
  Anthropic, and Google image input now accept any nonblank model ID instead of
  maintaining stale model allowlists. Axl still validates source types,
  provider-file ownership, request composition, and raw overrides locally; the
  upstream provider remains authoritative for whether its selected model
  supports images and reports an unsupported model through `ProviderError`.
- **Current-model parameter normalization.** GPT-5.6 Responses requests omit
  unsupported `temperature` even when reasoning uses the provider default, and
  Gemini 3.8 Flash maps `effort: 'none'` to its supported `low` thinking floor.
- **Rich model overrides and stream failures fail coherently.** Native image
  adapters and OpenRouter reject non-string or blank `providerOptions.model`
  values before dispatch, so validation, observation, and the wire model cannot
  diverge. Anthropic and Gemini in-band streaming error events now surface as
  typed `ProviderError` failures instead of being ignored or thrown as plain
  errors.
- **Multimodal documentation is product-facing.** The public guide now explains
  shipped image and transcription behavior without internal milestone labels,
  while the roadmap tracks the complete set of deferred multimodal extensions
  and the criteria for promoting them into planned work. The public docs also
  omit historical release checklists that do not help SDK consumers.

## [0.22.1] - 2026-09-02

### Changed

- **OpenRouter multimodal transport is catalog-capable.** Any nonblank
  `openrouter:<vendor/model>` URI now accepts image URL, bytes, and base64
  sources, including requests with tools, streaming, or structured output.
  Any nonblank `openrouter-transcription:<vendor/model>` URI now dispatches
  supported completed-file bytes/base64 to OpenRouter's transcription endpoint.
  Axl does not fetch OpenRouter's catalog at runtime: the selected model and
  route remain authoritative for modality and composition support. An image
  rejection surfaces through `ctx.ask()` as `ProviderError`; `ctx.transcribe()`
  wraps an upstream endpoint/model rejection as safe
  `TranscriptionOperationError` with bounded provider diagnostics and a
  non-enumerable `ProviderError` cause.
  Provider-file images, raw rich input-container overrides, URL/realtime audio,
  and general audio input remain unsupported.
- **Release communication is automated.** Successful tag-triggered npm publishing
  now creates a GitHub Release and Announcements discussion from the canonical
  versioned changelog section, with an extraction contract checked in CI.

### Fixed

- **Lint is clean.** Eval Zod-error recognition now uses a structural type guard,
  and Studio's HTTP upgrade listener uses Node's `Duplex` signature instead of
  unbounded `any` types.

## [0.22.0] - 2026-09-02

### Added

- **Ordered image input.** `ModelInput` accepts text and image parts on `ask` and
  `delegate`, with bounded observability descriptors, typed preflight errors,
  native OpenAI Responses/Anthropic/Gemini mappings, and one non-blocking
  OpenRouter certification path. See `docs/multimodal-input.md` for provider
  transport/source capabilities and attachment lifetime rules.
- **Completed-file transcription.** `ctx.transcribe()` provides a typed,
  non-chat operation for finite recording bytes/base64 (plus Gemini-owned file
  references), with exact OpenAI `gpt-transcribe`, Gemini
  `gemini-3.5-transcribe`, and OpenRouter `openai/whisper-1` adapters. It emits
  safe paired lifecycle events, keeps provider-reported pricing honest, and
  composes explicitly with `ctx.ask()`. See `docs/multimodal-input.md`.

### Breaking Changes

- **Node.js 22 is now the minimum supported runtime.** Node.js 20 reached end
  of life in March 2026, so CI and all published package engine declarations
  now target supported Node.js 22 and 24 releases.

### Fixed

- **Inline media is bounded before allocation.** Ordered image inputs accept at
  most 25 MiB decoded across one logical input, and transcription bytes/base64
  accept at most 25 MiB. Oversized values fail before ownership copies,
  base64 decoding, provider validation, or network dispatch. Both limits are
  exported for caller-side preflight and chunking.
- **Transcription failures retain safe provider diagnostics.** Wrapped errors
  and terminal events now expose HTTP status, retryability, optional retry
  delay, and optional request ID while keeping raw provider bodies out of
  observer and persistence surfaces.

- **Gemini image URLs now fail before dispatch.** Live discrimination showed
  that `gemini-3.7-flash` accepts the same image inline or through a Gemini
  Files URI while a raw HTTPS image URI returns a misleading `429`. Axl keeps
  its no-host-fetch/no-hidden-upload boundary: pass bytes/base64 or explicitly
  upload through Gemini Files and use a `google` provider-file reference.

## [0.21.1] - 2026-08-28

### Fixed

- **Actionable invalid tool arguments.** Local schema rejections now give the
  model bounded field paths and expectations derived from the provider-facing
  tool schema, allowing corrective retries without exposing rejected values,
  custom Zod messages, or dynamic record keys.

## [0.21.0] - 2026-08-20

### Breaking Changes

- **SDK transport guard.** Built-in providers, `OpenAIEmbedder`, and HTTP MCP
  clients now reject non-loopback HTTP endpoints unless that endpoint explicitly sets
  `dangerouslyAllowInsecureHttp: true`. HTTPS and literal loopback HTTP remain
  zero-configuration; unsafe URLs fail before async credential callbacks or
  network I/O. Migrate remote endpoints to HTTPS. If a trusted development
  endpoint cannot support TLS yet, opt in on that endpoint only with
  `dangerouslyAllowInsecureHttp: true`.

- **Provider redirects fail closed.** Provider and embedding POST requests no longer
  follow HTTP redirects, preventing request bodies or authorization headers from
  being resent to a redirect target. Existing redirecting gateways must be
  reconfigured to use their final HTTPS endpoint URL directly.

- **HTTP MCP redirects fail closed.** MCP POST requests no longer follow
  redirects or retry automatically, so non-idempotent tool-call arguments are
  never resent to another endpoint. Configure the final MCP URI directly.

- **Standalone Studio is local-only by default.** The CLI now binds explicitly
  to `127.0.0.1`, does not emit wildcard CORS headers, and rejects browser
  requests with non-local Host or Origin values before REST or WebSocket
  routing, preventing cross-origin mutation and DNS-rebinding access to its
  administrative API. Container users can explicitly use
  `--dangerously-bind 0.0.0.0` behind a loopback-only published port.
  `createServer()` now applies CORS only when explicitly passed `cors: true`;
  embedded middleware continues to leave HTTP authentication and CORS to the
  host application.

- **Production Studio WebSockets fail closed.** `upgradeWebSocket()` now refuses
  to attach in production without `verifyUpgrade`. Deployments whose host
  independently authenticates raw upgrades must explicitly set
  `dangerouslyAllowUnauthenticatedWebSockets: true`.

### Fixed

- **Studio session redaction.** `trace.redact: true` now scrubs non-streaming session
  results and every session WebSocket event at the Studio serialization boundary.

- **Studio session client payloads.** The exported session send and stream
  helpers now accept a workflow name and send the server's required
  `{ workflow, message }` request body.

## [0.20.1] - 2026-08-03

### Added

- **Latest provider models.** Adds GPT-5.6 Sol (including the `gpt-5.6` alias),
  Terra, and Luna; Claude Fable 5, Opus 5, and Sonnet 5; and Gemini 3.6 Flash and
  3.5 Flash-Lite. The xAI Chat preset now recognizes current Grok 4.5, 4.3, and
  4.20 variants. Each model has explicit reasoning, streaming, tool-continuation,
  and pricing behavior.
- **Cache-write usage telemetry.** `cache_write_tokens` now flows through provider
  responses and terminal stream chunks, including Anthropic's distinct 5-minute and
  1-hour cache-creation buckets.

### Changed

- **Honest provider cost estimates.** Built-in pricing now matches exact known models and
  observable Standard/on-demand calls. OpenRouter and xAI use provider-reported totals;
  DeepSeek, Mistral, and Groq use exact current-model tables. Unknown models, billing modes,
  deployments, modifiers, or incomplete usage return `undefined` instead of a guessed cost.
- **Endpoint-specific GPT-5.6 reasoning.** OpenAI Responses sends native `max`; Chat
  Completions warns once per model and sends its highest accepted tier, `xhigh`.
- **Tool-workflow documentation.** The Core, Studio, Eval, and migration guides now
  explain in user-facing terms how explicit tool outcomes, safe failure messages, and
  incomplete-run detection improve application behavior, debugging, and evaluation.

## [0.20.0] - 2026-07-20

### Added

- **Tool lifecycle event schema v2.** Every new live event carries
  `schemaVersion: 2` and every new live `ExecutionInfo` carries
  `eventSchemaVersion: 2`. Provider-issued tool requests rejected before
  execution emit `tool_call_rejected`; accepted calls close with one
  `tool_call_end.data.outcome` status: `succeeded`, `failed`, `denied`, or
  `cancelled`. `HistoricalExecutionInfo` and `HistoricalAxlEvent` preserve an
  explicit v1/v2 read union; missing version metadata is v1, and new writers
  emit only v2.
- **Model-safe `ToolFailure`.** Tool authors can throw exported `ToolFailure`
  with separate host `message` and provider-safe `modelMessage`. Existing
  handler retry policy still applies; a terminal `ToolFailure` records a
  structured failed outcome and permits agent-loop continuation without
  exposing an ordinary exception message.
- **Machine-readable observation completeness.** `AxlEventBus` and
  `AxlStream` expose `observationStatus` after lossy queue overflow, including
  aggregate drops from slow `stringStream()` subscribers. Persisted executions
  distinguish `persistence_truncated`, recovered v2 runs report
  `process_interrupted`, and bounded loser finalization reports
  `branch_drain_timeout` instead of presenting a partial trace as whole.
- **Approval-cleanup operational signal.** The runtime emits
  `decision_cleanup_failed` with the execution, workflow, compensation
  operation, and store error when cancellation cannot remove a persisted
  approval request. Listener failures cannot replace the original workflow
  error.

### Removed

- **`runtime.createContext()` observation callbacks.** `onToken`, `onToolCall`,
  and `onAgentStart` are removed from the public type and runtime. Untyped
  callers receive a targeted migration error and the values are never invoked.
  Use `ctx.events` for an ad-hoc context, `runtime.stream()` for one wire
  execution, or the runtime trace emitter for cross-execution observation. See
  the [stream-first migration guide](docs/migration/stream-first-observation.md).
- **Legacy `tool_denied` live event.** Unavailable tools are now pre-start
  `tool_call_rejected` events with `reason: 'unavailable'`.
- **Dead `ToolDenied` error export.** Unavailable provider requests are
  recoverable rejections, not thrown ACL errors. Historical `tool_denied`
  event data remains readable through the v1 history union.
- **Misleading workflow-resume entry points.** `runtime.resumeExecution()` and
  `runtime.resumePending()` are removed. Pending approvals remain visible after
  process loss, but Axl only resolves the continuation in its owning process.
  The inert `metadata.resumeMode` control channel is also removed; callers may
  now use that key as ordinary persisted metadata.

### Changed

- **Normal tool returns always succeed.** Axl no longer inspects an `error`
  property on user-owned return values. `hooks.after` runs exactly once after
  every normal local-handler return; code that previously returned
  `{ error: ... }` and relied on skipping `after` must be audited for newly
  triggered side effects. Ordinary hook/handler throws abort the ask without a
  provider tool message; denial, MCP `isError`, and explicit `ToolFailure`
  outcomes may continue.
- **Tool observation is terminal and phase-aware.** Failure and cancellation
  phases are represented in the terminal union; output preparation happens
  before the end event; duration includes approval wait, hooks, retry/backoff,
  handler work, and projection/serialization. Complete v2 traces pair starts
  and ends by `(executionId, askId, callId)`, while lossy/interrupted views stay
  explicitly incomplete rather than synthesizing outcomes.
- **`runtime.stream()` now selects streaming mode explicitly.** It no longer
  installs an internal `onToken` sentinel or allocates `ctx.events` solely to
  choose `provider.stream`; child contexts inherit the explicit mode.
- **Slow `stringStream()` subscribers are bounded.** Undrained deltas coalesce
  per ask/path without character loss; distinct pending fields obey the same
  `maxQueued` / `onOverflow` policy as the main event queue.
- **Race/quorum terminal drain is bounded.** `branchDrainTimeoutMs` defaults to
  5 seconds. Cooperative losers still finalize before `workflow_end`; an
  abort-ignoring continuation no longer hangs the entire workflow forever and
  instead marks the trace incomplete.

### Fixed

- **Tool boundaries fail closed on hostile edge shapes.** Provider tool
  arguments must decode to a top-level JSON object; strict projections reject
  every symbol key, including non-enumerable keys; direct `AbortError`s thrown
  by projection or serialization settle as cancellation rather than output
  failure.
- **Human decisions are runtime-validated.** Non-boolean discriminants,
  arrays/accessors, symbol or unknown keys, invalid field types, and
  contradictory approval/denial data fail before resolver or state-store
  mutation.
- **In-process approval release is failure-atomic.** The runtime removes the
  persisted pending request before releasing its resolver, so a state-store
  failure keeps the gate closed and retryable. Cancellation serializes with
  public resolution, compensates ambiguous saves, and keeps its cleanup barrier
  discoverable until a total execution delete can join it. Unknown, orphaned,
  invalid, and concurrently resolved requests have distinct error codes and
  Studio HTTP statuses (400/404/409).
- **Race/quorum losers finalize before the workflow snapshot when bounded.** Runtime
  completion drains `race`, `spawn({ quorum })`, and `map({ quorum })` branch
  continuations so losing cancellation terminals and late measurable provider
  cost precede `workflow_end` and persistence within the configured terminal
  bound. Late map losers cannot mutate a resolved quorum result, and strict
  event overflow from any loser still fails the workflow.
- **Strict event overflow bypasses recovery boundaries.** The typed integrity
  error now propagates through tool phases/retries, ask/verify/race validators,
  budgets, and concurrent result aggregation instead of being reclassified as
  an ordinary application failure. If overflow replaces an in-flight
  application failure at a terminal boundary, the original error is retained
  as `.cause`.

## [0.19.1] - 2026-07-17

### Added

- **Model-facing tool output projection.** Local tools can define a synchronous `toModelOutput` allowlist that keeps the complete post-hook result on the host-facing `tool_call_end` event while sending only validated, purpose-built content to the model. Adds exported `ToolModelOutput` and fail-closed `ToolModelOutputError`; existing tools, direct invocation, MCP, and handoffs retain their prior behavior.

### Changed

- **Configured tool mocks honor model-output policy.** `AxlTestRuntime.mockTool()` still bypasses the configured handler, schema, approval, retry, and hooks, but a matching configured local tool now deliberately supplies its `sensitive` and `toModelOutput` policy so tests shape model context the same way as production. Unconfigured overrides retain legacy serialization.

### Fixed

- **Projection error causes avoid accidental serialization.** `ToolModelOutputError.cause` remains available to trusted host code but is now non-enumerable, so ordinary `JSON.stringify(error)` does not include mapper-supplied sensitive details.
- **Gemini tool-result envelopes stay valid for every canonical output.** Primitive, `null`, array, and JSON-string tool messages are wrapped under `{ result }` so Gemini always receives its required object-valued `functionResponse.response`; object results remain unchanged.
- **Aborted tool loops stop before provider continuation.** `ctx.ask()` now checks an already-aborted signal after raw tool completion, at each loop boundary, and immediately before provider dispatch. A cancelled ask skips an otherwise eligible projection, and a provider that ignores `AbortSignal` cannot receive another request.

## [0.19.0] - 2026-07-08

Two themes. **Broad provider expansion:** the OpenAI adapter now powers
first-class presets for OpenAI-compatible hosted providers and local runtimes
while preserving Axl's cross-provider `effort`, tool-calling, and cost surfaces.
**Structured-output & `ctx.ask` pipeline control:** cheaper, more accurate
schema prompts by default; `schemaPrompt` and `nativeStructuredOutput` to steer
the model-facing contract independently of the Zod parse gate; and a
`schema_diagnostic` event that surfaces the previously-silent structured-output
cliffs.

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
- **Cheaper, more accurate structured-output prompts.** When `ctx.ask({ schema })`
  appends the JSON-Schema guidance, subschemas shared across (e.g.)
  discriminated-union arms are now hoisted into `$defs`/`$ref` once instead of
  duplicated inline, and the JSON is emitted compact (no pretty-print
  indentation) — an order-of-magnitude token cut for large unions with shared
  sub-objects, with no code change. The guidance is also rendered from the
  schema's **input** side (`z.toJSONSchema`'s `io: 'input'`), so a `.transform()`/
  `.pipe()` schema shows the model the pre-transform fields it must produce
  instead of collapsing to an empty `{}` (the default `'output'` mode's behavior
  for transforms); plain schemas are unchanged except non-strict objects
  correctly omit `additionalProperties: false` while `.strict()` keeps it. The
  exported `zodToJsonSchema` (used for provider tool definitions) stays inline,
  which is required for Gemini, whose schema sanitizer strips `$ref`/`$defs`;
  Zod→JSON-Schema conversions are memoized by schema identity, benefiting the
  per-turn tool-definition path.
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
- **`schemaPrompt` — decouple the prompt contract from the parse schema.** A new
  `AskOptions`/`AgentConfig` option controls how a `ctx.ask` output schema is
  rendered into the model-facing prompt, independently of the Zod `.parse` gate:
  `'json-schema'` (default), `'none'` (append nothing — schema stays the parse
  gate only; fires a `schema_prompt_none_no_guidance` diagnostic), or
  `{ render: string | (schema) => string }` for fully custom guidance. Forwarded
  through `ctx.delegate`.
- **`nativeStructuredOutput` — provider-neutral native structured output.** A new
  `AskOptions`/`AgentConfig` boolean opts into the provider's native `json_schema`
  path, deriving the provider schema from the **same** Zod schema (no second,
  contradictable JSON Schema). Providers that can't honor it — Anthropic
  (ignores), Gemini (lossy sanitize), OpenAI-compatible profiles with
  `supportsJsonSchema: false` (downgrade to `json_object`) — emit a
  `native_output_unsupported` diagnostic and proceed. Adds an optional
  `Provider.nativeStructuredOutputSupport(model)` capability method. The derived
  provider schema is rendered from the Zod schema's **input** side (consistent
  with the prompt), so `.transform()` schemas stay non-empty and
  `.default()`/`.optional()` fields aren't spuriously marked required. Forwarded
  through `ctx.delegate` to the terminal agent on both the single- and
  multi-candidate (handoff) paths. On OpenAI the `json_schema` is sent non-strict
  (schema-as-guidance); true strict-mode constrained decoding is a follow-up.
  See `docs/api-reference.md#structured-output` and `docs/providers.md`.
- **Repair recipes for recoverable output.** Documented first-class support for
  repairing structurally-off output without a reject-and-retry: a Zod
  `.transform()`/`.pipe()` in the schema (pure, runs inside `.parse`, no extra
  LLM turn) and `ctx.verify` (LLM-in-the-loop). See `docs/use-cases.md`.

### Fixed
- **Groq `json_schema` support is now per-model.** `nativeStructuredOutput` on
  Groq's `llama`/`gemma`/etc models used to send a `response_format: json_schema`
  those models reject with a 400; only the `openai/gpt-oss-*` family supports it.
  The `groq` profile now advertises `supportsJsonSchema` per-model so the request
  downgrades cleanly to `json_object` (with a `native_output_unsupported`
  diagnostic) on unsupported models and uses the native path on `gpt-oss`.
  Verified against the live Groq API. (Surfaced by the new native-output path;
  no prior code sent `json_schema` through the OpenAI-compatible engine.)

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

[Unreleased]: https://github.com/axl-sdk/axl/compare/v0.24.0...HEAD
[0.24.0]: https://github.com/axl-sdk/axl/compare/v0.23.3...v0.24.0
[0.23.3]: https://github.com/axl-sdk/axl/compare/v0.23.2...v0.23.3
[0.23.2]: https://github.com/axl-sdk/axl/compare/v0.23.1...v0.23.2
[0.23.1]: https://github.com/axl-sdk/axl/compare/v0.23.0...v0.23.1
[0.23.0]: https://github.com/axl-sdk/axl/compare/v0.22.3...v0.23.0
[0.22.3]: https://github.com/axl-sdk/axl/compare/v0.22.2...v0.22.3
[0.22.2]: https://github.com/axl-sdk/axl/compare/v0.22.1...v0.22.2
[0.22.1]: https://github.com/axl-sdk/axl/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/axl-sdk/axl/compare/v0.21.1...v0.22.0
[0.21.1]: https://github.com/axl-sdk/axl/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/axl-sdk/axl/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/axl-sdk/axl/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/axl-sdk/axl/compare/v0.19.1...v0.20.0
[0.19.1]: https://github.com/axl-sdk/axl/compare/v0.19.0...v0.19.1
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
