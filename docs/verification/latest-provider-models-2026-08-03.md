# Current provider model verification — 2026-08-03

This is the secret-free release artifact for the model catalog documented in
[`docs/providers.md`](../providers.md). Live calls used the repository's configured direct
provider accounts; no request or response content is retained here.

## Results

| Gate | Result | Coverage |
|---|---:|---|
| `pnpm test:integration` | 188 passed, 8 skipped | 186 core provider/orchestration cases plus 2 eval concurrency cases |
| `pnpm test:integration:frontier` | 23 passed | Exact current-model IDs, streams, tool continuation, usage, and cost |
| Direct GPT-5.6 Chat `max` probe | 4/4 confirmed unsupported | `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` |

The frontier matrix passed for:

- OpenAI Chat: all four GPT-5.6 IDs; OpenAI Responses: GPT-5.6 Luna native `max`,
  streaming, and tool continuation.
- Anthropic: Claude Fable 5, Opus 5, and Sonnet 5; Sonnet streaming and tool continuation.
- Gemini: Gemini 3.6 Flash and 3.5 Flash-Lite; streaming and tool continuation.
- xAI Chat: Grok 4.5, 4.3, 4.20 reasoning, and 4.20 non-reasoning; returned-cost
  streaming and tool continuation.

Static-priced OpenAI, Anthropic, and Gemini assertions required positive usage and cost.
xAI assertions required a finite, nonnegative provider-reported total.

## Contract observations

- Chat Completions rejected `reasoning_effort: "max"` on every exact GPT-5.6 ID; `xhigh` was
  the highest accepted tier. Axl maps portable Chat `max` to `xhigh` with a once-per-model
  warning, while Responses retains native `max`.
- Anthropic's `inference_geo: "not_available"` is an ordinary legacy response value only for
  exact models predating 4.6 geography selection. It is not a safe Standard-price signal for
  Claude 4.6+, Claude 5, or unknown models.
- Gemini can omit `candidatesTokenCount`. Axl does not infer a billed zero from finish reason,
  visible content, or token arithmetic; incomplete billed usage remains unknown.

## Unverified credential-gated surfaces

Azure OpenAI and AWS Bedrock credentials were unavailable. Those deployment-priced surfaces
remain deliberately unpriced and require separate account-level verification.
