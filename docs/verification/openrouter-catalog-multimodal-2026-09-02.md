# OpenRouter catalog multimodal evidence

**Date:** 2026-09-02<br>
**Status:** Passed — representative cross-catalog image-plus-tool and
transcription transport checks.

This record supplements, rather than changes, the historical
[2026-08-31 multimodal lighthouse](./multimodal-input-lighthouse-2026-08-31.md).
The earlier record certifies its named paths at that time; this one records the
generic OpenRouter transport contract after exact-model gates were removed.
Neither record makes its selected model a supported-model allowlist.

## Image plus tool continuation — L19

**Default model:** `openrouter:mistralai/mistral-medium-3-5`<br>
**Override:** `OPENROUTER_CATALOG_IMAGE_MODEL=<vendor/model>`

```bash
AXL_MULTIMODAL_LIVE=1 AXL_OPENROUTER_CATALOG_IMAGE_LIVE=1 pnpm --filter @axlsdk/axl exec vitest run --config vitest.integration.config.ts src/__tests__/integration-multimodal-input.test.ts -t '\[L19\]'
```

Result: **1 passed, 22 skipped**, with a 2686 ms test duration. Neutral tool,
prompt, and schema metadata exposed no expected heading. The normalized local
tool argument was exactly `Agent Playground`; the tool ran once and the model
produced a nonempty final answer. Exactly two `POST /api/v1/chat/completions`
requests were observed, both carrying the selected model. Terminal accounting
remained honest and no base64 image data appeared in events.

The normal successful path is two logical chat requests (initial tool call and
continuation). `fetchWithRetry` can make up to three attempts per logical
request for eligible transport, `429`, `503`, or `529` failures, so the
transport-attempt ceiling is six. That is not a paid-call or spend ceiling:
OpenRouter can process a request despite a failed or ambiguous client result.

## Completed-file transcription — L20

**Default model:** `openrouter-transcription:mistralai/voxtral-mini-3b-2507`<br>
**Override:** `OPENROUTER_CATALOG_TRANSCRIPTION_MODEL=<vendor/model>`

```bash
AXL_TRANSCRIPTION_LIVE=1 AXL_OPENROUTER_CATALOG_TRANSCRIPTION_LIVE=1 pnpm --filter @axlsdk/axl exec vitest run --config vitest.integration.config.ts src/__tests__/integration-multimodal-input.test.ts -t '\[L20\]'
```

Result: **1 passed, 22 skipped**, with a 571 ms test duration. The recording
produced a nonempty transcript. Exactly one `POST /api/v1/audio/transcriptions`
request carried the selected model; terminal accounting was consistently
priced-or-unpriced, and no raw audio appeared in events.

The normal successful path is one logical transcription request. The same
eligible retry policy allows up to three transport attempts; this likewise does
not bound upstream processing or spend.

## Scope of this evidence

Both defaults are env-overridable representatives, not allowlists. They prove
that Axl's generic transport interoperates with current non-OpenAI OpenRouter
catalog entries for the two consequential multimodal seams. A broader live
matrix was not needed: streaming, schema retry, effective model overrides,
colon-qualified variants, invalid input, retry/cancellation, and privacy are
deterministic SDK behavior covered at the real adapter seam. Additional models
would primarily measure OpenRouter catalog and route variability, which remains
authoritative at dispatch.
