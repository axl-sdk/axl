# General recorded-audio input evidence

**Date:** 2026-09-08<br>
**Status:** Partially certified — the OpenRouter lane passed every advertised
composition; the native `openai:` and `google:` lanes are implemented but
**not** live-certified in this environment (no keys).

This record covers the general-audio input rows `GA1`–`GA8` in
`packages/axl/src/__tests__/integration-general-audio.test.ts`. It supplements,
and does not change, the
[2026-08-31 multimodal lighthouse](./multimodal-input-lighthouse-2026-08-31.md)
and the [2026-09-02 OpenRouter catalog record](./openrouter-catalog-multimodal-2026-09-02.md).
No selected model in this record is a supported-model allowlist.

Live rows are **double-gated**: `AXL_MULTIMODAL_LIVE=1` *and*
`AXL_GENERAL_AUDIO_LIVE=1`, plus that row's provider key. A key alone never
spends. `AXL_DISABLE_LIVE_INTEGRATION=1` overrides both.

## Environment

Only `OPENROUTER_API_KEY` was present. `OPENAI_API_KEY`, `GOOGLE_API_KEY` /
`GEMINI_API_KEY`, and `ANTHROPIC_API_KEY` were absent, so the `openai:` and
`google:` rows could not be run here and remain open for the owner. The plan's
E1 fallback route (`openrouter:`) therefore carried the non-speech lighthouse.

Model for every OpenRouter row below: `openrouter:google/gemini-2.5-flash`
(override with `OPENROUTER_AUDIO_MODEL`).

## Rows that passed

### GA1-OR — non-speech understanding through `input_audio` (lighthouse)

```bash
AXL_MULTIMODAL_LIVE=1 AXL_GENERAL_AUDIO_LIVE=1 pnpm --filter @axlsdk/axl exec vitest run --config vitest.integration.config.ts src/__tests__/integration-general-audio.test.ts -t '\[GA1-OR\]'
```

An in-test generated ~3 s 16 kHz mono PCM WAV (220 → 1200 Hz sweep) was passed
as `Uint8Array` bytes; the engine base64-encoded it and emitted
`input_audio` with `format: 'wav'`. Reported cost `0.0001204`
(`usage.cost`, authoritative), `unpriced: false`, usage
`prompt_tokens: 93, completion_tokens: 16`, with
`prompt_tokens_details.audio_tokens: 75`.

Answer: *"This sound is a continuous, high-pitched sine wave whose pitch remains
constant."*

**Read this honestly.** The model demonstrably processed the input **as audio** —
it identified a sine tone, which a transcription detour cannot produce from a
non-speech recording. It did **not** detect the frequency rise. The lighthouse
claim this row supports is "a chat model reasons directly about a non-speech
recording", not "the model reports pitch change accurately". Acoustic-detail
accuracy is a model property, not an Axl transport property, and Axl advertises
neither.

### GA6 — base64 speech audio → text answer

```bash
AXL_MULTIMODAL_LIVE=1 AXL_GENERAL_AUDIO_LIVE=1 pnpm --filter @axlsdk/axl exec vitest run --config vitest.integration.config.ts src/__tests__/integration-general-audio.test.ts -t '\[GA6\]'
```

The checked-in `recorded-call.mp3.b64` speech fixture was passed as a base64
source and emitted with `format: 'mp3'`. Reported cost `0.0002286`,
`unpriced: false`, `audio_tokens: 200`.

Answer: *"This is a request to transcribe speech into text."*

### GA6-tool — audio survives a tool continuation

```bash
AXL_MULTIMODAL_LIVE=1 AXL_GENERAL_AUDIO_LIVE=1 pnpm --filter @axlsdk/axl exec vitest run --config vitest.integration.config.ts src/__tests__/integration-general-audio.test.ts -t '\[GA6-tool\]'
```

The audio-bearing ask defined one local tool. The model called it, and the
continuation request carried an `input_audio` object **deep-equal to the first
request's, at the same content index** — no re-encoding, no placeholder text, no
drop. Total ask cost `0.0004918` across two requests (the second reported
`0.0002631`).

Answer: *"The caller's account is active with a pro plan and no open tickets."*

### GA8-OR — streaming with audio input

```bash
AXL_MULTIMODAL_LIVE=1 AXL_GENERAL_AUDIO_LIVE=1 pnpm --filter @axlsdk/axl exec vitest run --config vitest.integration.config.ts src/__tests__/integration-general-audio.test.ts -t '\[GA8-OR\]'
```

The streamed audio ask produced ordinary text deltas only (3 token events). The
observed event-type set was checked against the canonical exported
`AXL_EVENT_TYPES`: **no new chunk or event type** appeared for an audio-bearing
call. The base64 sentinel was present in the captured request body (positive
control) and absent from every event. Reported cost `0.0001179`.

Answer: *"This sound is a constant sine wave tone with an unchanging pitch."*

### GA5 and GA7 — local, zero-fetch rows

```bash
AXL_MULTIMODAL_LIVE=1 AXL_GENERAL_AUDIO_LIVE=1 pnpm --filter @axlsdk/axl exec vitest run --config vitest.integration.config.ts src/__tests__/integration-general-audio.test.ts -t '\[GA5\]'
AXL_MULTIMODAL_LIVE=1 AXL_GENERAL_AUDIO_LIVE=1 pnpm --filter @axlsdk/axl exec vitest run --config vitest.integration.config.ts src/__tests__/integration-general-audio.test.ts -t '\[GA7\]'
```

GA5 passed: `anthropic:`, `openai-responses:`, and a provider whose
`inputCapabilities` omits `audio` each threw `UnsupportedModelInputError`
(`UNSUPPORTED_MODEL_INPUT`) with `modality: 'audio'` and **zero fetches**, with
no transcription fallback. GA7 passed: an unmappable media type
(`audio/x-unknown`) was rejected locally, naming the media type, with zero
fetches. Neither row needs a key and both always run.

## Rows NOT run, and why

| Row | Provider | Why not run |
| --- | --- | --- |
| GA1 | `google:` | No `GOOGLE_API_KEY` / `GEMINI_API_KEY` in this environment |
| GA2 | `openai:` | No `OPENAI_API_KEY` |
| GA3 | `google:` | No key |
| GA4 | `google:` | No key |
| GA4-openai | `openai:` | No key |
| GA8 | `google:` | No key |

Consequence for the public contract: `openai:` and `google:` audio transport is
**implemented but not live-certified**. Per the plan's rule that no
provider/composition is advertised without a passing live row,
[`docs/multimodal-input.md`](../multimodal-input.md) advertises **no**
compositions for those two adapters and says so explicitly. Only the OpenRouter
lane is certified for a text answer (speech and non-speech), tool continuation,
and streaming. Structured output with audio (`GA4`) is uncertified on **every**
adapter and is therefore advertised nowhere.

`providerMetadata` leak evidence on OpenRouter is indirect: the passing rows
assert that no base64 appears anywhere in the observed response body or events,
rather than enumerating a provider-echo field.

## Request and retry ceilings

The normal successful path is one logical chat request per row, except
`GA6-tool`, which is two (initial tool call plus continuation). `fetchWithRetry`
can make up to three HTTP attempts per logical request for eligible transport,
`429`, `503`, or `529` failures, so the transport-attempt ceiling is 3 per row
and 6 for `GA6-tool`. As in the earlier records, that is an attempt ceiling and
**not** a paid-call or spend ceiling: an upstream can process and bill a request
whose client result was failed or ambiguous. Every paid row caps `maxTokens` at
200 and uses audio fixtures of roughly ten seconds or less.

## Harness note

`GA8-OR` initially failed because the suite's streaming event-type allowlist was
hand-written and did not include the ordinary `pipeline` event. The allowlist
now compares against the exported `AXL_EVENT_TYPES` constant instead of a
hand-maintained list (commit `693c1fa`), so the assertion tests "no *new* event
type for audio" rather than "no event outside a list someone typed".
