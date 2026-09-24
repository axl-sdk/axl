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
  API). They build separate instances but share one rate-governor scope per model (family
  `openai`), so their limits are one shared counter, not the sum.
- **Transport security and retry**: validate every adapter/embedder base URL with
  `assertSafeProviderBaseUrl` in its constructor before resolving an API-key
  callback. Every provider and embedder network call goes through
  `fetchWithRetry`; ESLint forbids direct global `fetch` in those source paths.
  `fetchWithRetry` forces manual redirects and retries 429/503/529 with
  exponential backoff. Its 3rd arg is an options object (`FetchWithRetryOptions` in
  `retry.ts`: `maxRetries`, `governor`, `provider`, `admission`, `timing`). The built-in HTTP MCP client shares
  the endpoint classifier and manual-redirect policy but deliberately does not
  retry potentially non-idempotent tool calls. Custom `Provider`
  implementations own their separate transport policy.
- **Typed errors**: every `!res.ok` site throws a `ProviderError` (extends `AxlError`,
  `code: 'PROVIDER_ERROR'`, message verbatim from each adapter's own
  `extractErrorMessage`) built via `buildProviderError` in `providers/errors.ts`;
  `fetchWithRetry` normalizes a thrown network failure to `ProviderError{ status: 0 }`
  (aborts propagate verbatim). `ProviderError.retryable` (via `isRetryableStatus`) is a
  **broader semantic failover hint** — kept SEPARATE from the narrow transport-retry set
  (`429`/`503`/`529`) in `retry.ts`. `parseRetryAfter` (`retry-after-ms` first, then
  `Retry-After` numeric-seconds or HTTP-date) is the single source of truth, shared by both. Full table + rationale: `docs/providers.md`
  (typed provider errors) and `docs/api-reference.md`.
- **Rate governance** (`governor-pool.ts`, `quota.ts`, `rate-limiter.ts`): every built-in
  chat adapter resolves a pooled `ScopeGovernor` per call, one per runtime scope (family +
  origin + credential + model). By default it adds zero wait until a rate-limit 429, then brakes
  the scope, retries on its own budget (`maxRateLimitRetries`) and paces adaptively (AIMD);
  `rateLimit: { adaptive: false }` restores the plain path. A quota *dialect* (first-party
  OpenAI/Anthropic at the vendor origin only) adds spend-cap classification and the 2xx
  headroom hint — nothing else depends on it. Static `rateLimit` caps bound *concurrency*, not
  token throughput, and a permit is never held across a nested `ctx.ask`, so
  `maxConcurrent: 1` can't deadlock agent-as-tool. Transcription and the memory embedder
  are not pooled. Full semantics: `docs/providers.md`; contract: `.internal/spec/27-*`.
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
