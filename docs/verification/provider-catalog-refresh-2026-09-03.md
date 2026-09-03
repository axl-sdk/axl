# Provider catalog refresh verification — 2026-09-03

**Status:** Live-verified, with one named access limit
**Scope:** The models whose rates were added or corrected on
`fix/provider-catalog-refresh-2026-09`, and the one provider wire question the
session review raised. Rates themselves come from the provider pricing pages and
are not re-derived here; live verification confirms the SDK reaches each model
and prices its usage.

## Newly priced models are reachable and priced

Each row made a tiny request through the native adapter and asserted a nonempty
response, positive `total_tokens`, and `cost` a positive number.

| Provider/model | Gate | Result |
| --- | --- | --- |
| `anthropic:claude-fable-5-1` | frontier (`integration-latest-models.test.ts`) | Passed; default thinking mode accepted, priced |
| `openai:gpt-5.6-sol` | frontier (pre-existing row) | Passed |
| `google:gemini-3.7-flash` | routine (`integration-pricing.test.ts`, new row) | Passed |
| `google:gemini-3.8-flash` | routine (new row) | Passed |
| `google:gemini-3.6-flash` | routine (pre-existing row) + 3-variant diagnostic | Passed 3/3 in diagnostic; see transient note |
| `anthropic:claude-mythos-5-1`, `claude-mythos-5` | one-off access probe | **404 — no access** (Glasswing-gated); rates stay table-only |

Command shapes:

```bash
pnpm --filter @axlsdk/axl exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration-pricing.test.ts
pnpm --filter @axlsdk/axl exec vitest run --config vitest.frontier-integration.config.ts \
  -t 'OpenAI live|Anthropic live|Gemini live'
```

## Assistant-first requests are accepted by all three providers

The session review asked whether a request whose first non-system message is an
`assistant` turn is rejected (the summarization tail-anchoring work assumed it
might be). One probe per provider, `maxTokens: 16`, messages
`[assistant: 'prior', user: 'Reply with exactly: ok']`:

| Provider/model | Result |
| --- | --- |
| `anthropic:claude-haiku-4-5` | 200, 32 tokens, content `ok` |
| `openai:gpt-4.1-nano` | 200, 18 tokens |
| `google:gemini-2.5-flash-lite` | 200, 9 tokens |

Consequence: the user-turn anchoring in `summarizeHistory` is well-formedness and
cross-provider portability, not a workaround for a rejection. Code comments and
the CHANGELOG were reworded to say so.

## Transient failures observed, classified, not fixed

- **`gemini-3.6-flash` routine row failed once with `cost: undefined`**, then
  passed 3/3 (including the identical request shape) in a follow-up diagnostic
  that captured the raw response: `modelVersion: 'gemini-3.6-flash'` each time.
  A pricing-table miss would be deterministic, so this was the Gemini adapter
  failing closed on one response whose usage did not reconcile or lacked a
  definitive Standard tier — intended behavior, shared with the 3.7/3.8 rows
  that passed. Not caused by this branch; the row is left as is.
- **Gemini 3.5 tool-continuation frontier row failed once** with the
  continuation reporting no usage, then passed on rerun. Pre-existing test,
  untouched here; same fail-closed normalizer.

## Finding recorded for follow-up: Anthropic prompt caching is never requested

A hard-asserting cache-read case for `claude-fable-5-1` (run once, then removed
as beyond this branch's scope) failed because the second identical long-prompt
request reported no `cached_tokens`. The cause is not the model: the Anthropic
adapter contains no `cache_control` field anywhere, and Anthropic's pricing page
states caching requires one. So Axl never obtains Anthropic cache reads, and the
existing routine cache tests pass only because they assert conditionally
(`if (cached_tokens > 0)`). The model was reached and priced on both calls
(1000+ prompt tokens each). Tracked in the branch's `.internal` checklist.

No API keys, prompt contents, or provider response bodies beyond token counts
are recorded here.
