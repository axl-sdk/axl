# Multimodal image lighthouse — verification record

**Prepared:** 2026-08-31  
**Status:** Partial pass — L1/L2/L3/L4/L5/L6/L11 passed; L12 is blocked by
Gemini project quota after request-shape validation.

The opt-in tests are `packages/axl/src/__tests__/integration-multimodal-input.test.ts`.
They use the checked-in Studio Playground PNG, low output limits, and require `AXL_MULTIMODAL_LIVE=1` in
addition to the relevant provider key. No secret, base64 payload, request
authorization header, or provider-file reference belongs in this record.

| ID | Command selector | Planned model | Logical invocations / max HTTP attempts | Evidence to record after run | Status |
| --- | --- | --- | ---: | --- | --- |
| L1 | `-t '\[L1\]'` | `openai-responses:gpt-4o-mini` | 1 / 3 | Byte image returned text; terminal accounting passed; no base64 leaked to events | Passed |
| L2 | `-t '\[L2\]'` | `openai-responses:gpt-4o-mini` | 1 / 3 | HTTPS image returned schema-valid output with streaming events and accounting | Passed |
| L3 | `-t '\[L3\]'` + existing file ID or temporary-file opt-in | `anthropic:claude-sonnet-4-5` | 2 / 6 model requests; optionally 2 file operations | Temporary upload, provider-file tool continuation, accounting, and deletion all completed | Passed |
| L4 | `-t '\[L4\]'` | `google:gemini-3.7-flash` | 1 / 3 | Byte image returned schema-valid output through stateless Interactions; accounting passed | Passed |
| L5 (non-blocking) | `-t '\[L5\]'` | `openrouter:openai/gpt-4o-mini` | 1 / 3 | Base64 image returned text with response-priced accounting and no event leakage | Passed |
| L6 | `-t '\[L6\]'` | `openai-responses:gpt-4.1-nano` | 0 / 0 | Local `UNSUPPORTED_MODEL_INPUT` preflight | Passed locally |
| L11 | `-t '\[L11\]'` | `anthropic:claude-sonnet-4-5` | 1 / 3 | URL accepted without Axl host retrieval; terminal accounting passed | Passed |
| L12 | `-t '\[L12\]'` | `google:gemini-3.7-flash` | 1 / 3 | Explicit MIME fixed local/provider request validation; inference remained unavailable due repeated `429` quota responses | Quota blocked |

On a normal successful path, native blocking rows are five logical invocations,
seven with L3's existing provider-file reference, and eight with optional L5.
Because `fetchWithRetry` permits two retries for eligible transport, `429`,
`503`, and `529` failures, their maximum HTTP attempts are 15, 21, and 24.
Those figures do not bound paid provider processing or spend: a provider can
process a request even when the client sees a failed or ambiguous transport
result. The optional `AXL_ANTHROPIC_TEMP_FILE=1` route adds one Files API
upload and one delete operation. The uploaded fixture expires after one hour
even if cleanup cannot complete. This harness-only setup does not expose file
management as an Axl runtime API.

The direct-file named selectors above were used for multimodal evidence. An
earlier accidental run of the existing aggregate integration suite is not
multimodal verification evidence; it exercised at least 52 existing provider
test cases and also exposed unrelated Mistral/Groq failures. The aggregate run
did not execute this double-gated lighthouse.

L1 initially exposed that a synthetic 1×1 PNG was not accepted as a real image,
so the harness now uses the checked-in Studio screenshot. L4 exposed Gemini
3.7 Flash's `low` minimum thinking level; the adapter and contract tests were
corrected before the passing rerun. L12 first exposed that Gemini URI parts need
an explicit MIME type. After that request-shape repair, two direct reruns
reached only project quota responses, so URL inference is deliberately not
claimed as passed.

## Sources checked for selection (accessed 2026-08-31)

- [OpenAI image inputs](https://platform.openai.com/docs/guides/images)
- [Anthropic vision](https://platform.claude.com/docs/en/build-with-claude/vision)
- [Gemini Interactions overview](https://ai.google.dev/gemini-api/docs/interactions-overview), [migration](https://ai.google.dev/gemini-api/docs/migrate-to-interactions), and [image understanding](https://ai.google.dev/gemini-api/docs/image-understanding)
- [OpenRouter multimodal overview](https://openrouter.ai/docs/guides/overview/multimodal/overview) and [selected model metadata](https://openrouter.ai/openai/gpt-4o-mini)

Provider documentation shows possible upstream surfaces; Axl's exact supported
allowlists are in `docs/multimodal-input.md` and are what these rows certify.
