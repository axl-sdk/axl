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
an explicit MIME type. After that request-shape repair, three direct reruns
reached only project quota responses, so URL inference is deliberately not
claimed as passed.

## Sources checked for selection (accessed 2026-08-31)

- [OpenAI image inputs](https://platform.openai.com/docs/guides/images)
- [Anthropic vision](https://platform.claude.com/docs/en/build-with-claude/vision)
- [Gemini Interactions overview](https://ai.google.dev/gemini-api/docs/interactions-overview), [migration](https://ai.google.dev/gemini-api/docs/migrate-to-interactions), and [image understanding](https://ai.google.dev/gemini-api/docs/image-understanding)
- [OpenRouter multimodal overview](https://openrouter.ai/docs/guides/overview/multimodal/overview) and [selected model metadata](https://openrouter.ai/openai/gpt-4o-mini)

Provider documentation shows possible upstream surfaces; Axl's exact supported
allowlists are in `docs/multimodal-input.md` and are what these rows certify.

## Completed-file transcription checklist

**Status:** Passed for L7-L10, L17, and all three recorded-call recipes. The
same in-memory, eight-second MP3 fixture was used for every row. It is
attributed to Open Speech Repository in
`packages/axl/src/__tests__/fixtures/recorded-call.README.md`.

| ID | Command selector | Planned model | Ordinary successful path | Required evidence | Status |
| --- | --- | --- | --- | --- | --- |
| L7 | `-t '\[L7\]'` | `openai-transcription:gpt-transcribe` | 1 logical transcription; 1 multipart request | Nonempty text; exactly one safe start/end pair; no agent/ask event; no raw audio in events | Passed live |
| L8 | `-t '\[L8\]'` | `gemini-transcription:gemini-3.5-transcribe` | 1 logical transcription; Files start + finalize, optional readiness reads, Interactions, delete | English + verbatim word timestamps/diarization returned timed speaker words; exact stateless config observed; `cleanupStatus: deleted` | Passed live after composition repair |
| L8V | `-t '\[L8V\]'` | `gemini-transcription:gemini-3.5-transcribe` | 1 logical transcription with the same temporary Files lifecycle | Separate bounded custom-vocabulary request returned text and deleted its temporary file | Passed live |
| L9 | `-t '\[L9\]'` | `gemini-transcription:gemini-3.5-transcribe` | Test-owned Files start + finalize + bounded readiness reads; 1 provider-file Interaction; test-owned delete | HTTPS/same-origin/credential-free upload URL validated before bytes; Axl delta was exactly one stateless Interaction; temporary identifier absent from events; delete observed | Passed live |
| L10 | `-t '\[L10\]'` | `anthropic-transcription:claude-sonnet-4-5` | 0 / 0 | Exact local `UNSUPPORTED_TRANSCRIPTION_INPUT` registry preflight and zero fetch calls | Passed locally |
| L17 | `-t '\[L17\]'` | `openrouter-transcription:openai/whisper-1` | 1 logical transcription; 1 JSON STT request | Nonempty text; one exact endpoint request; positive seconds plus provider cost matched priced terminal accounting | Passed live |
| R7 / R8 / R17 | named selector with `AXL_TRANSCRIPTION_RECIPE_LIVE=1` | Each B1 provider followed by a low-cost text model | One transcription plus one ordinary text-agent call; Gemini bytes also has temporary Files lifecycle | Schema-valid nonempty summary and at least one action item; transcript explicitly passed as text; no raw audio in events | Passed live |

`AXL_TRANSCRIPTION_LIVE=1` is required in addition to the relevant key;
`AXL_TRANSCRIPTION_RECIPE_LIVE=1` independently arms the product recipe.
`AXL_DISABLE_LIVE_INTEGRATION=1` wins over both flags. Inference may retry under
the normal transport policy. Upload/finalize, readiness, and cleanup do not
retry, so these request counts are successful-path evidence rather than a paid
request or spend bound. Gemini residual file retention after cleanup failure is
documented as up to 48 hours.

The first L8 request used the combination shown in Google's launch guide:
custom vocabulary plus word timestamps and diarization. The live API returned
`400 custom_vocabulary is incompatible with timestamps`; the adapter still
deleted the temporary file. Axl now rejects that composition locally. The
passing L8 retained timestamps/diarization, while L8V separately certified
custom vocabulary.

R8 also clarified the Gemini transport split. Two legacy string-analysis
attempts produced non-schema output (one then reached the known retry-history
limit), and the first ordered-text Interactions attempt exhausted a 160-token
cap. The passing recipe used a text `ModelInput`, stateless Interactions,
`effort: 'none'`, a 256-token cap, and no retry. Legacy string-only `google:`
calls remain on `generateContent` for compatibility; dedicated transcription
and ordered-input paths use Interactions.

## Transcription sources checked for selection (accessed 2026-08-31)

- [OpenAI speech to text](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Gemini transcription](https://ai.google.dev/gemini-api/docs/transcribe) and [Gemini Files](https://ai.google.dev/gemini-api/docs/files)
- [OpenRouter speech-to-text](https://openrouter.ai/docs/guides/overview/multimodal/stt) and [selected Whisper model](https://openrouter.ai/openai/whisper-1)
