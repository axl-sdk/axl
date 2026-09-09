# Session current-input verification

Date: 2026-09-08. Status: text-session wire behavior live-verified.

`Session.send()` and `Session.stream()` now send a matching current input once by default. `SessionOptions.deduplicateInput: false` restores the previous duplicate provider request while preserving canonical session history. Rich inputs match by normalized ordered parts and source data.

## Live row

```bash
AXL_SESSION_INPUT_LIVE=1 pnpm --filter @axlsdk/axl exec vitest run --config vitest.integration.config.ts src/__tests__/integration-session-input.test.ts
```

| Model | HTTP attempts | Current user messages on wire | Input tokens | Output tokens | Reported cost (USD) | Unpriced |
| --- | --- | --- | --- | --- | --- | --- |
| `openrouter:google/gemini-2.5-flash-lite` | 1 | 1 | 46 | 2 | 0.0000054 | false |

Reasoning, cached, and cache-write counts were zero. Cost came from OpenRouter's authoritative response cost through Axl's normal event path. One workflow forwarded its exact string input to `ctx.ask()`; the test captured the outgoing message list and verified that persisted history contained one user and one assistant. The row imports this checkout's source directly. It made one logical ask, used `maxTokens: 32`, and invoked no judges. The transport permits at most three attempts for eligible transient errors; only one occurred.

The row requires both its explicit flag and `OPENROUTER_API_KEY`; `AXL_DISABLE_LIVE_INTEGRATION=1` overrides them. The published [OpenRouter rates](https://openrouter.ai/google/gemini-2.5-flash-lite) supported a pre-run estimate below $0.001 including retries. Actual paid spend was $0.0000054.

## Offline evidence and limits

The initial regression failed against the old implementation: the provider received two identical `hello` user messages instead of one. The final focused suite covers default/opt-out, send/stream, later equal turns, sequential/concurrent asks, history mutation, failure cleanup, child isolation, schema guidance/tools, and rich image/audio structural equality. Public-package e2e covers fresh session handles and rich history projection.

This one live row proves text-session transport and usage, not live media behavior or a measured before/after token delta. Rich media preservation is covered offline and by the existing general-audio verification record. Full unredacted `workflow_start.data.input` retains arbitrary original workflow input under the existing workflow contract; media-safe session history and model-input traces do not sanitize that lifecycle value. See [multimodal observability](../multimodal-input.md).
