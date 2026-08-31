# Multimodal model input

Milestone A adds ordered image input to `ctx.ask()`, `ctx.delegate()`, and
`agent.ask()`. It is deliberately a small, per-call surface: it does not add a
durable attachment store, upload service, document parser, video support, or
realtime voice.

## Build one input shape

`ModelInput` is either the existing string shorthand or a non-empty ordered
array of text and image parts. `inputText()` returns the deterministic text
projection (text parts joined by `\n`), which is useful for logs and existing
input guardrails.

```ts
import { agent, inputText, type ModelInput } from '@axlsdk/axl';

const screenshot: ModelInput = [
  { type: 'text', text: 'Read the error badge in this screenshot.' },
  {
    type: 'image',
    label: 'checkout error',
    source: { type: 'bytes', data: pngBytes, mediaType: 'image/png' },
  },
  { type: 'text', text: 'Reply with one short sentence.' },
];

inputText(screenshot); // "Read ...\nReply ..."
await analyst.ask(screenshot);
```

`InputContentPart` is `InputTextPart | InputImagePart`. An image source is one
of the closed `InputMediaSource` variants:

| Source | Shape | Notes |
| --- | --- | --- |
| URL | `{ type: 'url', url, mediaType? }` | HTTPS is the portable choice. Axl validates the URL but never fetches it; the provider receives the reference. |
| Bytes | `{ type: 'bytes', data: Uint8Array, mediaType }` | Per-call only; an explicit IANA media type is required. |
| Base64 | `{ type: 'base64', data, mediaType }` | For advanced serializable callers; it must be valid base64 and has an explicit IANA media type. |
| Provider file | `{ type: 'provider-file', provider, reference, mediaType? }` | Opaque and provider-scoped. A reference for one provider is rejected by another. Axl does not upload, list, download, or retain files. |

Parts retain their order. A label is optional, and adapters add a following
`[Image: label]` text part where their wire format needs it. Schema guidance is
also a trailing text part for rich requests; a legacy string request keeps its
existing request composition.

## Runtime behavior and limits

Input guardrails still receive their first argument as a string for source
compatibility. Their `ctx.input` is an independently cloned `ModelInput` view.
`ctx.delegate()` routes the full ordered evidence by default; use
`routerInput: 'text'` only when the router should receive the text projection.
Retries, schema/validation recovery, tools, handoffs, and the selected delegate
keep the original input for that one ask.

An attachment is **per-call evidence**, not session state. A successful ask
does not automatically attach it to later `Session` turns. Application-created
JSON-compatible rich user history can be persisted; inline `Uint8Array` image
data cannot be silently persisted and fails loudly. Context estimates count
text and mark media as unmeasured rather than treating it as free context.

For rich input, Axl validates the exact effective model and every rich history
part before any provider call, context-summary call, or dynamic handoff. Raw
provider `messages`/`input`/`contents` container overrides are rejected. Invalid
shape throws `InvalidModelInputError` (`INVALID_MODEL_INPUT`); an unsupported
model, source, or composition throws `UnsupportedModelInputError`
(`UNSUPPORTED_MODEL_INPUT`). Neither error includes media bytes, base64, URLs,
or provider-file references.

Media pricing is intentionally conservative. A static text pricing table is not
used merely because a request contains an image. Axl reports a cost only when a
provider returns an authoritative total or a modality-aware estimator exists;
otherwise the normal `unpriced`/lower-bound signals apply.

## Observability and redaction

`ask_start`, `agent_call_start`, and completion callbacks retain the text
projection plus a bounded `ModelInputDescriptor`: part type, source kind, media
type, inline byte count, and optional locator/label. They never contain inline
bytes or base64. Full traces replace rich message content with its text
projection and keep descriptors separately. Redaction removes user text, URLs,
labels, and provider-file references while retaining provider/model metadata and
structural source kind/count/size information. Treat unredacted URL locators as
sensitive application data.

## Image capability table (Milestone A)

The allowlists below are intentionally exact; another model may be accepted by
its upstream API but is unsupported until Axl verifies its request contract.

| Provider URI | Supported image models | Sources | Constraints |
| --- | --- | --- | --- |
| `openai-responses:` | `gpt-4o`, `gpt-4o-2024-08-06`, `gpt-4o-2024-11-20`, `gpt-4o-mini`, `gpt-4o-mini-2024-07-18` | URL, bytes, base64, `provider-file` scoped to `openai-responses` | Uses Responses image items; no host fetch/upload by Axl. |
| `anthropic:` | `claude-sonnet-4-5`, `claude-opus-4-8` | URL, bytes, base64, `provider-file` scoped to `anthropic` | Provider files are opaque references, not an Axl file API. |
| `google:` | `gemini-3.7-flash` | URL, bytes, base64, `provider-file` scoped to `google` | Rich calls use Gemini Interactions with `store: false`; URL and provider-file sources require an explicit `mediaType`. |
| `openrouter:` | `openai/gpt-4o-mini` | URL, bytes, base64 | Non-blocking certification only; provider files and image+tools are rejected. Do not infer catalog-wide OpenRouter support. |

Gemini transport is deliberately hybrid. Legacy string-only `google:` requests
continue to use the existing `generateContent` transport. Model-specific
parameter normalization still applies. Rich image requests use the
GA Interactions API and are stateless (`store: false`): Axl sends
application-owned history and does not use `previous_interaction_id`,
background execution, or a raw transport override.

## Completed-file transcription (B1)

`ctx.transcribe(request)` is a dedicated completed-recording operation. It does
not call an agent, alter chat history, fall back to a general multimodal model,
or turn audio into a hidden `ctx.ask()`. Compose explicitly when analysis is
wanted: `const transcript = await ctx.transcribe(...); await ctx.ask(agent,
transcript.text)`. It accepts finite bytes, canonical base64, or the exact
provider-scoped reference documented below; local paths, URLs, streams, and
realtime audio are not input types.

```ts
const transcript = await ctx.transcribe({
  model: 'openai-transcription:gpt-transcribe',
  audio: { type: 'bytes', data: recording, mediaType: 'audio/mpeg' },
  language: 'en',
});
const review = await ctx.ask(
  agent({ model: 'openai-responses:gpt-4o-mini' }),
  `Summarize and extract action items:\n${transcript.text}`,
);
```

`TranscriptionRequest` is `{ model, audio, language?, timestamps?, diarization?,
providerOptions? }`. `RecordedAudioSource` is a closed `bytes | base64 |
provider-file` union. `Transcript` always contains `text`, and may contain
detected languages, timestamped segments/words, provider-reported usage, a
pricing status, and opaque provider metadata. `timestamps` is `'segment' |
'word'`; a provider rejects unsupported options locally before dispatch.

| Provider URI | Exact B1 model | Sources | Native options / accounting |
| --- | --- | --- | --- |
| `openai-transcription:` | `gpt-transcribe` | Bytes, base64 | `language`; `providerOptions: { prompt?, temperature? }`. Axl sends multipart `/audio/transcriptions`; no provider-file or timestamps/diarization capability is claimed. Usage is only reported when OpenAI returns it. |
| `gemini-transcription:` | `gemini-3.5-transcribe` | Bytes, base64, `provider-file` scoped to `gemini-transcription` | `language`, word timestamps, diarization with word timestamps; `providerOptions: { mode?: 'verbatim' | 'smart', customVocabulary?: string[] }`. The default is `verbatim`; `customVocabulary` accepts at most 1,000 entries but cannot be combined with timestamps. Smart mode cannot request timestamps or diarization. A provider-file requires its explicit audio `mediaType`. Bytes/base64 use temporary Files upload, readiness polling when needed, stateless Interactions (`store: false`), then best-effort deletion. |
| `openrouter-transcription:` | `openai/whisper-1` | Bytes, base64 | `language`; `providerOptions: { temperature?, provider? }`. Axl sends JSON to OpenRouter's dedicated STT endpoint. Response `seconds`, token counts, and `cost` are authoritative when present; missing price is surfaced as unpriced rather than zero. |

Gemini uploaded files are a narrow, request-scoped adapter transaction—not a
public Files client. The adapter attempts deletion after success, failure, or
caller cancellation and records only its bounded cleanup outcome. If deletion
cannot complete, Gemini may retain a temporary file for up to 48 hours; do not
put sensitive data in the fixture unless that residual retention is acceptable.
If a finalize response is ambiguous and omits a usable file name, Axl cannot
target a compensating delete; that identifier-less provider-side uncertainty is
the remaining unavoidable case.
For reuse, callers own the prior Gemini Files lifecycle and may pass their URI
as a matching provider-file reference. Axl never lists, downloads, hosts, or
fetches that reference.

`transcription_start` and paired `transcription_end` are v2-only lifecycle
events. They never contain inline audio, base64, provider-file references, or
raw provider bodies. Their descriptor carries a byte count only for a `bytes`
source; base64/provider-file sources carry no inferred size. With tracing
unredacted, `transcription_end.data.text` contains transcript text; with
`trace.redact`, transcript text and user error content are scrubbed while safe
structural/accounting fields remain. See the authoritative event fields in the
[API reference](./api-reference.md#axlevent-variants).

Built-in URI prefixes above are exact allowlists. Applications can register a
custom dedicated adapter with `runtime.registerTranscriptionProvider(name,
provider)` and use `name:model`; it remains separate from chat-provider
registration and receives no hidden fallback.

## General audio status

This table is separate so completed-file transcription is never mistaken for
general audio understanding.

| Surface | Status | Planned providers | Contract |
| --- | --- | --- | --- |
| B2 general audio understanding | Deferred | To be certified separately | Audio parts, non-speech reasoning, audio tool continuations, and audio structured output are not accepted now. |

Anthropic transcription, audio fallback through a general chat model, video,
PDF/document input, multimodal tool results, generated media, durable media
sessions, public provider-file management, and realtime voice are unsupported
or deferred rather than silently coerced.

## First-result lighthouse (about 15 minutes)

Run the repository example with one of the selectable exact model URIs. It
reuses the checked-in Studio Playground screenshot, so no upload is needed:

```bash
pnpm --filter @axlsdk/axl build
cd examples
npm install
IMAGE_MODEL=openai-responses:gpt-4o-mini npm run image-lighthouse
IMAGE_MODEL=anthropic:claude-sonnet-4-5 npm run image-lighthouse
IMAGE_MODEL=google:gemini-3.7-flash npm run image-lighthouse
# Non-blocking certification path:
IMAGE_MODEL=openrouter:openai/gpt-4o-mini npm run image-lighthouse
```

Set the matching `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, or
`OPENROUTER_API_KEY`. The example asks a first agent for a structured visual
finding and a second agent to verify it; start with the first native command to
confirm your key and chosen model. It intentionally makes paid calls and is not
part of default tests.

## Recorded-call lighthouse

The separately armed transcription rows decode the checked-in eight-second MP3
fixture in memory. It is an excerpt from the Open Speech Repository Harvard
sentences recording; see
[`recorded-call.README.md`](../packages/axl/src/__tests__/fixtures/recorded-call.README.md)
for attribution and license notice. `L7` proves transcription alone;
`R7`/`R8`/`R17` separately prove explicit transcription followed by a normal
text agent for a schema-valid summary and nonempty action-item list. The Gemini
`L8` requests language, word timestamps, and diarization and requires timed,
speaker-labelled words on success. `L8V` separately certifies custom
vocabulary because the live API rejects vocabulary combined with timestamps.
The Gemini `R8` analysis call uses an ordered text `ModelInput`, proving the
same stateless Interactions transport used by new rich calls. See
[Testing](./testing.md#completed-file-transcription-lighthouse) for opt-in
commands, count caveats, and the kill switch.

## Provider sources (accessed 2026-08-31)

- [OpenAI Responses image inputs](https://platform.openai.com/docs/guides/images)
- [Anthropic vision](https://platform.claude.com/docs/en/build-with-claude/vision)
- [Gemini Interactions overview](https://ai.google.dev/gemini-api/docs/interactions-overview), [migration guide](https://ai.google.dev/gemini-api/docs/migrate-to-interactions), and [image understanding](https://ai.google.dev/gemini-api/docs/image-understanding)
- [OpenRouter multimodal inputs](https://openrouter.ai/docs/guides/overview/multimodal/overview)
- [OpenAI speech to text](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Gemini transcription](https://ai.google.dev/gemini-api/docs/transcribe) and [Files API](https://ai.google.dev/gemini-api/docs/files)
- [OpenRouter speech-to-text](https://openrouter.ai/docs/guides/overview/multimodal/stt)

Those provider documents establish upstream surfaces, not broader Axl
allowlists. The table above is the supported Axl contract.
