# Multimodal image lighthouse — verification record

**Prepared:** 2026-08-31  
**Status:** Prepared only — no live request has been run or recorded by this file.

The opt-in tests are `packages/axl/src/__tests__/integration-multimodal-input.test.ts`.
They use a 1×1 PNG, low output limits, and require `AXL_MULTIMODAL_LIVE=1` in
addition to the relevant provider key. No secret, base64 payload, request
authorization header, or provider-file reference belongs in this record.

| ID | Command selector | Planned model | Logical invocations / max HTTP attempts | Evidence to record after run | Status |
| --- | --- | --- | ---: | --- | --- |
| L1 | `-t '\[L1\]'` | `openai-responses:gpt-4o-mini` | 1 / 3 | Response shape; `ask_end` accounting; source descriptor redaction | Pending |
| L2 | `-t '\[L2\]'` | `openai-responses:gpt-4o-mini` | 1 / 3 | Structured result; stream event kind; accounting | Pending |
| L3 | `-t '\[L3\]'` + `ANTHROPIC_IMAGE_FILE_ID` | `anthropic:claude-sonnet-4-5` | 2 / 6 | Existing opaque file reference only; one tool continuation; accounting | Pending setup |
| L4 | `-t '\[L4\]'` | `google:gemini-3.7-flash` | 1 / 3 | Structured result; Interactions response; accounting/unpriced signal | Pending |
| L5 (non-blocking) | `-t '\[L5\]'` | `openrouter:openai/gpt-4o-mini` | 1 / 3 | Upstream/model metadata; response-priced total; no broad catalog claim | Pending |
| L6 | `-t '\[L6\]'` | `openai-responses:gpt-4.1-nano` | 0 / 0 | Local `UNSUPPORTED_MODEL_INPUT` preflight | Passed locally |
| L11 | `-t '\[L11\]'` | `anthropic:claude-sonnet-4-5` | 1 / 3 | URL accepted without Axl host retrieval; accounting | Pending |
| L12 | `-t '\[L12\]'` | `google:gemini-3.7-flash` | 1 / 3 | URL accepted by stateless Interactions; accounting | Pending |

On a normal successful path, native blocking rows are five logical invocations,
seven with L3's existing provider-file reference, and eight with optional L5.
Because `fetchWithRetry` permits two retries for eligible transport, `429`,
`503`, and `529` failures, their maximum HTTP attempts are 15, 21, and 24.
Those figures do not bound paid provider processing or spend: a provider can
process a request even when the client sees a failed or ambiguous transport
result. Provider-file creation is intentionally outside this test suite because
Milestone A does not expose a generic file-management API.

An earlier accidental run of an existing aggregate integration suite is not
multimodal verification evidence. No multimodal live row has run; every live
row above remains pending.

## Sources checked for selection (accessed 2026-08-31)

- [OpenAI image inputs](https://platform.openai.com/docs/guides/images)
- [Anthropic vision](https://platform.claude.com/docs/en/build-with-claude/vision)
- [Gemini Interactions overview](https://ai.google.dev/gemini-api/docs/interactions-overview), [migration](https://ai.google.dev/gemini-api/docs/migrate-to-interactions), and [image understanding](https://ai.google.dev/gemini-api/docs/image-understanding)
- [OpenRouter multimodal overview](https://openrouter.ai/docs/guides/overview/multimodal/overview) and [selected model metadata](https://openrouter.ai/openai/gpt-4o-mini)

Provider documentation shows possible upstream surfaces; Axl's exact supported
allowlists are in `docs/multimodal-input.md` and are what these rows certify.
