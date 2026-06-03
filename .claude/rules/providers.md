---
paths:
  - "packages/axl/src/providers/**"
---

# Provider adapters

Two kinds of adapter, both implementing the `Provider` interface in `providers/types.ts`,
both **zero SDK dependencies — raw `fetch` only**:
- **Native adapters** for providers with their own wire format: `openai` (Chat Completions),
  `openai-responses`, `anthropic`, `gemini`.
- **One generic engine** — `OpenAICompatibleProvider` (`providers/openai-compatible.ts`) —
  for everything that speaks the OpenAI Chat Completions format. It's parameterized by a
  `ProviderProfile`; presets live in `providers/profiles/*.ts` and register from
  `BUILTIN_PROFILES` in `registry.ts`. **`OpenAIProvider` is itself a thin subclass** of the
  engine carrying the canonical OpenAI profile. To add an OpenAI-compatible provider, add a
  profile — NOT a new adapter. New native (non-compatible) providers still register a factory
  in `registry.ts`.

**Profiles are data + small strategy fns** — `pricing` (`table`/`from-response`/`zero`/`unknown`;
a table miss is `undefined`, never `0`), `reasoning` (`emit` + `capture` + turn-aware
`roundTrip`), `capabilities` (`emitsMessageName`/`forbiddenParams`/`supportsJsonSchema`,
`PerModel<T>` where a provider's rules differ by model), `authHeader`, `allowMissingApiKey`,
`maxTokensField`, `parallelToolCalls`, `requestDefaults`. `forbiddenParams` strips
engine-computed values but preserves the user's explicit `providerOptions`. Keep
per-provider quirks in the profile (allowed to rot), not in the engine.

- **Two OpenAI adapters**: `openai` (Chat Completions) and `openai-responses` (Responses
  API). They share config but build *separate* instances — using both means effective
  concurrency/limits are the sum, not a shared counter.
- **Retry**: every network call goes through `fetchWithRetry` (exponential backoff on
  429/503/529). Its 3rd arg is an options object `{ maxRetries?, governor?, provider? }`.
- **Typed errors**: every `!res.ok` site throws a `ProviderError` (extends `AxlError`,
  `code: 'PROVIDER_ERROR'`, message verbatim from each adapter's own
  `extractErrorMessage`) built via `buildProviderError` in `providers/errors.ts`;
  `fetchWithRetry` normalizes a thrown network failure to `ProviderError{ status: 0 }`
  (aborts propagate verbatim). `ProviderError.retryable` (via `isRetryableStatus`) is a
  **broader semantic failover hint** — kept SEPARATE from the narrow transport-retry set
  (`429`/`503`/`529`) in `retry.ts`. `parseRetryAfter` (numeric-seconds + HTTP-date) is
  the single source of truth, shared by both. Full table + rationale: `docs/providers.md`
  (typed provider errors) and `docs/api-reference.md`.
- **Rate limiting** (opt-in): `ProviderConfig.rateLimit` builds a `RateLimiter`
  (dependency-free counting semaphore + FIFO queue) threaded in as the `governor`. An
  undefined governor ⇒ behavior byte-identical to no limiter. It caps request
  *concurrency*, not token throughput, and never holds a permit across a nested
  `ctx.ask`, so `maxConcurrent: 1` can't deadlock agent-as-tool. Full semantics:
  `docs/providers.md`.
- **`effort`** is the unified knob (`'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`);
  each adapter maps/clamps it to that provider's native reasoning mechanism.
  `thinkingBudget` is the precise-token override; `includeThoughts` returns reasoning
  summaries where supported.
  **The per-model mapping, clamping rules, and pricing live in the adapter code and
  `docs/providers.md` — read those; do NOT hardcode model lists or prices here or in
  CLAUDE.md, they change every release.**
- **`providerMetadata`** is the opaque round-trip bag (e.g. Gemini `thoughtSignature`,
  OpenAI Responses encrypted reasoning items). **`providerOptions`** is the per-call escape
  hatch, merged last into the raw request body — not portable across providers.

When you add a provider or change effort/thinking behavior, update `docs/providers.md` and
the live-API integration tests (`__tests__/integration*.test.ts`, gated on API keys).
