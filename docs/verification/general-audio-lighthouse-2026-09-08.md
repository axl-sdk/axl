# General recorded-audio input evidence

**Date:** 2026-09-08<br>
**Status:** Certified on `google:` and `openrouter:`; `openai:` certified for a
single-turn text answer only. Two `openai:` compositions were run and are
recorded as **provider rejections**, not Axl transport gaps.

This record covers the general-audio input rows `GA1`–`GA9` in
`packages/axl/src/__tests__/integration-general-audio.test.ts`. It supplements,
and does not change, the
[2026-08-31 multimodal lighthouse](./multimodal-input-lighthouse-2026-08-31.md)
and the [2026-09-02 OpenRouter catalog record](./openrouter-catalog-multimodal-2026-09-02.md).
No selected model in this record is a supported-model allowlist.

Live rows are **double-gated**: `AXL_MULTIMODAL_LIVE=1` *and*
`AXL_GENERAL_AUDIO_LIVE=1`, plus that row's provider key. A key alone never
spends. `AXL_DISABLE_LIVE_INTEGRATION=1` overrides both. `GA2` needs a third
flag, `AXL_GENERAL_AUDIO_OPENAI_TOOL_LIVE=1`, because it fails on the provider
side today (below).

## Environment and models

`GOOGLE_API_KEY`, `OPENAI_API_KEY`, and `OPENROUTER_API_KEY` were present.
Models (each env-overridable, none an allowlist):

| Lane | Model | Override |
| --- | --- | --- |
| `google:` | `gemini-3.7-flash` (Interactions, `store: false`) | `GEMINI_AUDIO_MODEL`, `GEMINI_AUDIO_EFFORT` |
| `openai:` | `gpt-audio-1.5` (Chat Completions) | `OPENAI_AUDIO_MODEL` |
| `openrouter:` | `google/gemini-2.5-flash` | `OPENROUTER_AUDIO_MODEL` |

Gemini 3.x cannot disable thinking, so `effort: 'none'` is clamped to `'low'`
(a `provider_diagnostic` event says so) and thought tokens count against
`max_output_tokens`; the Gemini rows therefore use `maxTokens` 400–800 rather
than 200.

## Rows that passed

Every command below has the form

```bash
AXL_MULTIMODAL_LIVE=1 AXL_GENERAL_AUDIO_LIVE=1 pnpm --filter @axlsdk/axl exec vitest run --config vitest.integration.config.ts src/__tests__/integration-general-audio.test.ts -t '\[<ROW>\]'
```

### GA1 — non-speech understanding on the Gemini lighthouse (`google:`)

The in-test generated ~3 s 16 kHz mono PCM WAV (220 → 1200 Hz sweep) was
passed as `Uint8Array` bytes and emitted as an Interactions
`{ type: 'audio', data, mime_type: 'audio/wav' }` step. `cost: 0`,
`unpriced: true` (Interactions reports no cost). Usage reported
`input_tokens_by_modality: [{ audio: 75 }, { text: 20 }]`, 55 thought tokens,
12 output tokens. The response echoed no audio.

Answer: *"The sound is a smooth electronic tone whose pitch steadily rises."*

The model both processed the input **as audio** and detected the frequency
rise. The lighthouse claim remains "a chat model reasons directly about a
non-speech recording"; acoustic accuracy is a model property Axl does not
advertise.

### GA1-OR — non-speech understanding through OpenRouter `input_audio`

Same WAV, emitted as `input_audio` with `format: 'wav'`. Reported cost
`0.0001204` (`usage.cost`, authoritative), `unpriced: false`,
`prompt_tokens: 93, completion_tokens: 16`,
`prompt_tokens_details.audio_tokens: 75`.

Answer: *"This sound is a continuous, high-pitched sine wave whose pitch remains
constant."* The model identified a sine tone (which a transcription detour
cannot produce) but did **not** detect the rise.

### GA3 — speech audio identical across a stateless tool continuation (`google:`)

The audio-bearing ask defined one local tool under a system prompt requiring
exactly one call. Two `interactions` requests were made; the continuation
echoed the model's thought and `function_call` steps and carried an audio step
**deep-equal to the first request's, at the same index**. Usage
`input_tokens_by_modality: [{ audio: 200 }, { text: 113 }]`; `unpriced: true`.

Answer: *"The caller recited standard phonetically balanced test sentences
about a birch canoe and gluing a sheet to a blue background."*

This row first failed with a bare 400 *"Invalid input received"* on the
continuation. Root cause: the adapter omitted `name` on the `function_result`
step, which Interactions requires. That was a pre-existing defect on every
`store: false` tool continuation, not an audio one; fixed in the same change
and covered by an offline `gemini.test.ts` expectation that fails without it.

### GA4 — structured output from speech audio (`google:`)

Schema `{ summary: string, speakerCount: number }`. The Interactions request
carried the audio step plus the response schema; the reply parsed and
validated. Usage `input_tokens_by_modality: [{ audio: 200 }, { text: 79 }]`.

Answer: `{ "summary": "A speaker reads aloud short sample sentences describing a
canoe sliding on planks and attaching a sheet to a dark blue background.",
"speakerCount": 1 }`

### GA6 — base64 speech audio → text answer (`openrouter:`)

`recorded-call.mp3.b64` as a base64 source, emitted with `format: 'mp3'`.
Cost `0.0002286`, `unpriced: false`, `audio_tokens: 200`.

Answer: *"This is a request to transcribe speech into text."*

### GA6-tool — audio survives a tool continuation (`openrouter:`)

The continuation carried an `input_audio` object deep-equal to the first
request's at the same index. Total ask cost `0.0004918` across two requests.

Answer: *"The caller's account is active with a pro plan and no open tickets."*

### GA8 and GA8-OR — streaming with audio input

Each row streams a text-only control ask on the same route, then the audio ask
(two logical requests). Both produced ordinary text deltas only, and the audio
ask's event-type set was **identical** to the control's:
`ask_start, provider_diagnostic, pipeline, agent_call_start, token,
agent_call_end, ask_end`. The base64 sentinel was present in the audio request
body, absent from the control request, and absent from every event.

- GA8 (`google:`, `streamGenerateContent` control vs Interactions audio):
  *"This is the sound of a slide whistle with a rising pitch."*
- GA8-OR: cost `0.0001229`; *"This sound is a continuous sine wave that does
  not change in pitch."*

### GA9 — audio user turn re-sent as application session history (`google:`)

A first ask carried the speech MP3. A second context was constructed with
`sessionHistory` holding that audio user turn and the assistant answer, then
asked a plain string. The second Interactions request carried the history
audio step **verbatim at index 0** of its first `user_input` step, and the
provider accepted it.

First: *"This recording is a speech test featuring a woman reading standardized
Harvard sentences."* Second: *"There was only one speaker."*

### GA5 and GA7 — local, zero-fetch rows

`anthropic:`, `openai-responses:`, and a provider whose `inputCapabilities`
omits `audio` each threw `UnsupportedModelInputError` (`modality: 'audio'`)
with **zero fetches** and no transcription fallback; `audio/x-unknown` was
rejected locally, naming the media type. Neither row needs a key.

## `openai:` rows — what was observed

### GA2-text — single-turn text answer from speech audio (passes)

One Chat Completions request carrying `input_audio` (`format: 'mp3'`);
`unpriced: true` by design. Usage `prompt_tokens: 107`,
`prompt_tokens_details: { audio_tokens: 80, text_tokens: 27 }`. No base64 in
the response body or any event. This is the passing row behind the `openai:`
capability-table entry.

Answer: *"It sounds like you're describing phrases used to test typing or
speech clarity."*

### GA4-openai — structured output is rejected by the provider

`gpt-audio-1.5` rejects both `response_format: json_schema` and `json_object`:

```
OpenAI API error (400): Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.
```

The row now certifies the **rejection**: exactly one Chat Completions request
carrying `input_audio`, a typed `ProviderError` with `status: 400` whose message
names `response_format`, and no base64 in the error. Audio plus structured
output is therefore advertised on no adapter.

### GA2 — first turn certified, tool continuation fails provider-side

The first request (audio + one tool) succeeded: the model returned a tool call
and usage reported `prompt_tokens: 186`,
`prompt_tokens_details: { audio_tokens: 80, text_tokens: 106 }`. That is the
first live proof that OpenAI reports per-modality audio usage on this path.

The continuation (assistant tool call + tool result + the original
`input_audio` message) failed **five consecutive times** with

```
OpenAI API error (500): The model produced invalid content. Consider modifying your prompt if you are seeing this error persistently.
```

including with `parallel_tool_calls: false` and `modalities: ['text']`. A
text-only control on the same model is impossible: the API answers *"This
model requires that either input content or output modality contain audio."*
The request body is the same shape OpenRouter accepted in GA6-tool; the
failure is on the provider side, so the row stays armed separately and no
`openai:` tool composition is advertised.

### GA10 — structured output from speech audio (`openrouter:`)

Same schema as GA4. One request carrying `input_audio` plus the schema; the
reply parsed and validated. Cost `0.0002931` (`usage.cost`), `audio_tokens: 200`.

Answer: `{ "summary": "This is a recording of a person speaking two sentences.",
"speakerCount": 1 }`

### GA11 — audio as a caller-owned Gemini Files reference (`google:`)

The row uploaded the tone WAV through the Files API in application code,
asked with a `provider-file` source (`provider: 'google'`, the returned
`file.uri`, `mediaType: 'audio/wav'`), and deleted the file afterwards. The
Interactions request carried `{ type: 'audio', uri, mime_type: 'audio/wav' }`
and **no bytes**: the tone sentinel was absent from the model request and from
every event. Usage `input_tokens_by_modality: [{ text: 20 }, { audio: 75 }]`,
`unpriced: true`.

Answer: *"This is a steady electronic beep with a constant pitch that does not
change."* (The model processed the file as audio; it did not report the rise.
Acoustic accuracy is not an Axl property.)

### GA12 — every OpenRouter format token beyond `wav`/`mp3`

Fixtures were transcoded from the tone WAV with ffmpeg at test time; `pcm16`
is the WAV data chunk with no header. Each row is one request; the wire
`format` token was asserted per row and every row got a text answer.

| media type | token | bytes | cost |
| --- | --- | --- | --- |
| `audio/aiff` | `aiff` | 96054 | 0.0001104 |
| `audio/aac` | `aac` | 11015 | 0.0001479 |
| `audio/ogg` | `ogg` | 6780 | 0.0001154 |
| `audio/flac` | `flac` | 19852 | 0.0001329 |
| `audio/mp4` | `m4a` | 11677 | 0.0001554 |
| `audio/l16` | `pcm16` | 96000 | 0.000065 |

## Rows not run

None. Every row in the suite ran on 2026-09-08.

## Consequence for the public contract

| Adapter | Advertised (passing row) | Not advertised |
| --- | --- | --- |
| `google:` | text answer from speech and non-speech (GA1), tool continuation (GA3), structured output (GA4), streaming (GA8), history re-send (GA9), Gemini Files `provider-file` source (GA11) | — |
| `openrouter:` | text answer (GA1-OR, GA6), tool continuation (GA6-tool), streaming (GA8-OR), structured output (GA10), all eight format tokens on the wire (GA12) | — |
| `openai:` | single-turn text answer with audio (GA2-text) | tool continuation (provider 500), structured output (provider 400) |

`providerMetadata` leak evidence remains indirect: passing rows assert that no
base64 appears anywhere in observed response bodies or events.

## Usage evidence for the modality-aware estimator

All three lanes report audio input tokens separately: OpenAI
`prompt_tokens_details.audio_tokens` / `text_tokens`, Gemini
`input_tokens_by_modality`, OpenRouter `prompt_tokens_details.audio_tokens`.

**Addendum (2026-09-08, same day):** this evidence was the last precondition
for a modality-aware estimator, and one shipped on the back of it. Audio-bearing
`openai:` Chat Completions and `google:` Interactions calls on a model carrying
a verified audio rate are now priced — audio tokens from their own rate row,
never the text row — and stay unpriced whenever a billed bucket has no
published rate or the reported counts do not reconcile. OpenRouter is
unchanged. The usage vectors recorded above are the fixtures the offline
estimator tests replay, and the live rows here now assert the estimate equals
the formula applied to the captured wire usage. See the accounting section of
[`docs/multimodal-input.md`](../multimodal-input.md) and
[`docs/providers.md`](../providers.md#rich-input-calls).

Priced re-run after the estimator and its review fix wave (`60efc9b`), each
value the formula applied to the captured wire usage:

| Row | Lane | Cost | `unpriced` |
| --- | --- | --- | --- |
| GA2-text | `openai:gpt-audio-1.5` | 0.0028675 | false |
| GA1 | `google:gemini-3.7-flash` | 0.00042375 | false |
| GA3 | `google:gemini-3.7-flash` | 0.001128 | false |
| GA4 | `google:gemini-3.7-flash` | 0.00031425 | false |
| GA11 | `google:gemini-3.7-flash` (Files URI) | 0.00042 | false |
| GA1-OR | `openrouter:google/gemini-2.5-flash` | 0.0001054 (`usage.cost`) | false |

`GA2` still fails on the provider-side 500 recorded above (three further
attempts on 2026-09-08 after the fix wave, none retried by Axl); it is not a
regression, since no estimator commit touches request building.

Two cache probes were run over raw HTTP with the same long prompt sent twice,
three seconds apart. `openai:gpt-audio-1.5` with a 120 s WAV (1200 audio
tokens, 1218 prompt tokens) reported `cached_tokens: 0` both times.
`google:gemini-2.5-flash` Interactions with a 50 s WAV (1601 audio tokens,
1609 input tokens) reported `total_cached_tokens: 0` both times and satisfied
`total_tokens = input + output + thought` on both responses. Neither lane
produced a cache hit on an audio-dominant prompt, so a cached-audio overlap
remains unobserved and the estimators unprice any call that reports both
cached and audio tokens until a probe shows how the buckets relate.

The `openai-responses:` pricing rows in `integration-pricing.test.ts` were run
live after the fix wave (six passed) and now assert that both audio usage
fields are absent on text-only calls, so the Responses lane's audio mapping
cannot silently move priced text traffic to unpriced.

## Request and retry ceilings

One logical chat request per row, except the continuation rows (`GA2`, `GA3`,
`GA6-tool`), the streaming rows (`GA8`, `GA8-OR`, text-only control first), and
`GA9` (two asks), which are two. `fetchWithRetry` can make up to three HTTP
attempts per logical request for eligible transport, `429`, `503`, or `529`
failures; `500` is not retried, so GA2's five failures were five separate armed
runs. That is an attempt ceiling and **not** a paid-call or spend ceiling.
`maxTokens` is 200 on OpenAI and OpenRouter rows and 400–800 on Gemini rows;
audio fixtures are roughly ten seconds or less.

## Harness notes

- `GA8-OR` initially failed on a hand-written event allowlist; comparing
  against `AXL_EVENT_TYPES` made the check a tautology. The rows now compare
  against a text-only control streamed on the same route.
- `GA8` on `google:` initially failed because the control ask (a plain string)
  routes to `generateContent`, not Interactions; the model-call matcher now
  recognises both.
- `GA3` first ended `incomplete` at `maxTokens: 200` because of thought tokens.

## V5 image billing and V3 service-tier follow-up

**Closed 2026-09-08.** Both rows used exactly `google:gemini-3.7-flash` through Interactions, one HTTP attempt each, with `store: false`, `effort: 'low'`, and `maxTokens: 400`. The tests import this checkout's source directly. Google returned no invoice cost; the priced value below is Axl's published-rate estimate.

| Row | Request / returned tier | Input tokens | Output / thought tokens | Total tokens | Axl cost (USD) |
| --- | --- | --- | --- | --- | --- |
| V5 image | Standard / top-level `standard` | 1,089 image + 13 text = 1,102 | 1 / 140 | 1,243 | 0.00135525 estimated |
| V3 tier | Priority / top-level `priority` | 9 text | 1 / 93 | 103 | `undefined` (unpriced) |

Both responses reported zero cached and server-side tool-use tokens. Neither returned `x-gemini-service-tier`; the documented top-level body field supplied the actual tier evidence. V5 answered `Invisible` for the tiny PNG fixture; V3 answered `ready`. These are transport/accounting observations, not image-understanding quality claims.

### V5 — published image rate and observed usage

The current [Google pricing page](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.7-flash) publishes one Standard input rate for `gemini-3.7-flash`: $0.75 per million input tokens through 2026-12-31, with $3.75 per million output tokens including thoughts. No different image-input rate is published for this row, so no separate image rate was added. The live row verified a positive image bucket, and the estimator matched `1102 × 0.75e-6 + (1 + 140) × 3.75e-6 = 0.00135525`.

### V3 — service-tier location

The [Interactions schema](https://ai.google.dev/api/interactions-api) defines `service_tier` at the top level of both request and response resources. The request reader already used that real field. The discovered bug was on the response side: Axl read `usage.service_tier` and missed the documented top-level tier. A regression fixture with top-level `priority` produced a Standard-rate estimate of $0.0002485 before the fix.

The adapter now combines top-level response tier, the documented [`x-gemini-service-tier` header](https://ai.google.dev/gemini-api/docs/priority-inference), and the old usage location as defensive evidence. Streaming retains invalid evidence across lifecycle frames. Any explicit non-standard, unknown, or conflicting evidence leaves cost undefined while keeping usage. Explicit non-standard requests remain unpriced even after a reported Standard downgrade.

V3 required a recognized actual response tier and observed `priority`, with no downgrade. Missing, unknown, or conflicting response evidence would fail verification. The absence of a numeric Axl cost is the intended result; Standard pricing was not applied to this Priority call. Actual Google charges were not observed. SSE tier parsing and header/downgrade handling are fixture-tested, not live-certified by this non-streaming row.

### Reproduction and bounds

Each row requires `GOOGLE_API_KEY` or `GEMINI_API_KEY` and its explicit flag. Run separately:

```bash
AXL_GEMINI_BILLING_LIVE=1 pnpm --filter @axlsdk/axl exec vitest run --config vitest.integration.config.ts src/__tests__/integration-gemini-billing.test.ts -t 'V5 uses'
AXL_GEMINI_BILLING_LIVE=1 pnpm --filter @axlsdk/axl exec vitest run --config vitest.integration.config.ts src/__tests__/integration-gemini-billing.test.ts -t 'V3 emits'
```

The recorded run selected this exact file once, executing its seven offline harness tests followed by V5 and V3, with no reruns. `AXL_DISABLE_LIVE_INTEGRATION=1` overrides the gate. Each live row makes one logical call with a 55-second abort and at most three transport attempts. Sanitized per-attempt request/status/header/usage evidence survives failure; credentials and inline media are excluded.

V5 and V3 satisfy the owner's prerequisites for the separate N1 no-audio-rate pricing expansion.
