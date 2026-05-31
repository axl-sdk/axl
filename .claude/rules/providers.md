---
paths:
  - "packages/axl/src/providers/**"
---

# Provider adapters

One adapter per provider, all implementing the `Provider` interface in
`providers/types.ts`. **Zero SDK dependencies — raw `fetch` only.** New providers register
through the factory in `registry.ts`.

- **Two OpenAI adapters**: `openai` (Chat Completions) and `openai-responses` (Responses
  API). They share config but build *separate* instances — using both means effective
  concurrency/limits are the sum, not a shared counter.
- **Retry**: every network call goes through `fetchWithRetry` (exponential backoff on
  429/503/529). Its 3rd arg is an options object `{ maxRetries?, governor? }`.
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
