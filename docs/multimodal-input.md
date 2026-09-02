# Multimodal model input

Axl accepts ordered image input in `ctx.ask()`, `ctx.delegate()`, and
`agent.ask()`. Images are evidence for one call: Axl preserves them through
that call's retries and tool continuations, but does not turn them into stored
attachments or a general-purpose file service.

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

For rich input, Axl validates the effective model ID and every rich history
part before any provider call, context-summary call, or dynamic handoff. Raw
provider `messages`/`input`/`contents` container overrides are rejected. Invalid
shape throws `InvalidModelInputError` (`INVALID_MODEL_INPUT`); an unsupported
source or composition throws `UnsupportedModelInputError`
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

## Image capabilities

Image support is transport-based rather than a model allowlist. Axl accepts any
nonblank model ID on the native image transports below and does not duplicate
the providers' changing model catalogs. The selected provider model decides
whether it supports images and combinations such as tools or structured output;
an upstream capability rejection surfaces through `ctx.ask()` as a typed
`ProviderError`.

| Provider URI | Accepted model IDs | Sources | Constraints |
| --- | --- | --- | --- |
| `openai-responses:` | Any nonblank model ID | URL, bytes, base64, `provider-file` scoped to `openai-responses` | Uses Responses image items; the selected OpenAI model must support image input. No host fetch/upload by Axl. The legacy `openai:` Chat Completions adapter remains text-only. |
| `anthropic:` | Any nonblank model ID | URL, bytes, base64, `provider-file` scoped to `anthropic` | Uses native content blocks; the selected Anthropic model must support image input. Provider files are opaque references, not an Axl file API. |
| `google:` | Any nonblank model ID | Bytes, base64, `provider-file` scoped to `google` | Rich calls use Gemini Interactions with `store: false`; the selected model must support both Interactions and image input. Provider-files require an explicit `mediaType`. Direct HTTP image URLs fail locally: fetch them in application code and pass bytes/base64, or upload through Gemini Files and pass the returned URI as a provider-file. |
| `openrouter:` | Any nonblank `<vendor/model>` slug | URL, bytes, base64 | Axl passes the normalized `image_url` transport through without a catalog lookup. Tools, streaming, and structured output are permitted; selected model/route capability remains authoritative. Provider-file images and raw rich input-container overrides fail locally. An upstream capability rejection surfaces through `ctx.ask()` as typed `ProviderError`. |

Axl accepts at most 25 MiB of decoded inline image data across one `ModelInput`.
The bound is checked before bytes are copied or base64 is decoded. URL and
provider-file sources do not count toward it because Axl does not load their
contents; upstream request, image-count, and model limits still apply. Callers
can import `MAX_INLINE_MODEL_INPUT_BYTES` when preflighting their own inputs.

Gemini transport is deliberately hybrid. Legacy string-only `google:` requests
continue to use the existing `generateContent` transport. Model-specific
parameter normalization still applies. Rich image requests use the `/v1beta`
Interactions API and are stateless (`store: false`): Axl sends
application-owned history and does not use `previous_interaction_id`,
background execution, or a raw transport override.
Gemini Files are caller-owned for image input; unlike the explicit temporary
upload inside `ctx.transcribe()`, Axl does not fetch image URLs, upload chat
images, or delete caller-supplied image references.

For a Gemini image URL or a large/reused image, upload it in application code
and pass the returned URI. This example uses Google's optional SDK; Axl itself
keeps no Google SDK dependency:

```ts
import { GoogleGenAI } from '@google/genai';

const google = new GoogleGenAI({});
const uploaded = await google.files.upload({
  file: 'receipt.png',
  config: { mime_type: 'image/png' },
});
if (!uploaded.name || !uploaded.uri || !uploaded.mimeType) {
  throw new Error('Gemini Files returned an incomplete image reference');
}

try {
  const answer = await ctx.ask(visionAgent, [
    { type: 'text', text: 'Read this receipt.' },
    {
      type: 'image',
      source: {
        type: 'provider-file',
        provider: 'google',
        reference: uploaded.uri,
        mediaType: uploaded.mimeType,
      },
    },
  ]);
} finally {
  await google.files.delete({ name: uploaded.name });
}
```

Google requires Files when its complete request exceeds 100 MB and currently
retains uploaded files for up to 48 hours. Axl's 25 MiB inline safety bound is
intentionally lower and applies before provider selection; use a supported URL
or provider-file source rather than raising process memory exposure.

## Completed-file transcription

`ctx.transcribe(request)` is a dedicated completed-recording operation. It does
not call an agent, alter chat history, fall back to a general multimodal model,
or turn audio into a hidden `ctx.ask()`. Compose explicitly when analysis is
wanted: `const transcript = await ctx.transcribe(...); await ctx.ask(agent,
transcript.text)`. It accepts finite bytes, canonical base64, or the exact
provider-scoped reference documented below; local paths, URLs, streams, and
realtime audio are not input types.

Inline transcription bytes/base64 are limited to 25 MiB decoded. The limit is
checked before ownership copies and before base64 decoding. Split longer audio,
or upload it through a provider's file API and pass a provider-file reference
where the exact adapter supports one (currently Gemini). The corresponding
exported ceiling is `MAX_INLINE_TRANSCRIPTION_BYTES`.

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

Transcript text is included in unredacted trace events and persisted execution
history, just like ordinary model responses. Enable `trace.redact` before
processing sensitive recordings if observers or state stores should receive
only structural and accounting fields.

`TranscriptionRequest` is `{ model, audio, language?, timestamps?, diarization?,
providerOptions? }`. `RecordedAudioSource` is a closed `bytes | base64 |
provider-file` union. `Transcript` always contains `text`, and may contain
detected languages, timestamped segments/words, provider-reported usage, a
pricing status, and opaque provider metadata. `timestamps` is `'segment' |
'word'`; a provider rejects unsupported options locally before dispatch.

| Provider URI | Supported model | Sources | Native options / accounting |
| --- | --- | --- | --- |
| `openai-transcription:` | `gpt-transcribe` | Bytes, base64 | `language`; `providerOptions: { prompt?, temperature? }`. Axl sends multipart `/audio/transcriptions`; no provider-file or timestamps/diarization capability is claimed. Usage is only reported when OpenAI returns it. |
| `gemini-transcription:` | `gemini-3.5-transcribe` | Bytes, base64, `provider-file` scoped to `gemini-transcription` | `language`, word timestamps, diarization with word timestamps; `providerOptions: { mode?: 'verbatim' | 'smart', customVocabulary?: string[] }`. The default is `verbatim`; `customVocabulary` accepts at most 1,000 entries but cannot be combined with timestamps. Smart mode cannot request timestamps or diarization. A provider-file requires its explicit audio `mediaType`. Bytes/base64 use temporary Files upload, readiness polling when needed, stateless Interactions (`store: false`), then best-effort deletion. |
| `openrouter-transcription:` | Any nonblank `<vendor/model>` slug | Bytes, base64 | `language`; `providerOptions: { temperature?, provider? }`. Axl sends JSON to OpenRouter's dedicated STT endpoint without a catalog lookup; selected endpoint/model compatibility is authoritative. An upstream failure is wrapped as safe `TranscriptionOperationError`; response `seconds`, token counts, and `cost` are authoritative when present; missing price is surfaced as unpriced rather than zero. |

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
On provider failure, safe HTTP diagnostics (`status`, `retryable`, optional
`retryAfterMs`, and optional `requestId`) are retained on
`TranscriptionOperationError` and under `transcription_end.data.providerError`;
raw response bodies stay only on the non-enumerable error cause.

The OpenAI and Gemini transcription URI/model entries above are exact. OpenRouter
accepts any nonblank model slug and leaves endpoint compatibility to OpenRouter;
that is transport support, not a claim that every catalog model can transcribe.
Applications can register a custom dedicated adapter with
`runtime.registerTranscriptionProvider(name, provider)` and use `name:model`; it
remains separate from chat-provider registration and receives no hidden fallback.

## What is not supported

Completed-file transcription converts a finite recording to text. It does not
let a chat model reason directly about music, environmental sounds, tone, or
other non-speech audio. Axl does not currently accept audio parts in
`ModelInput`, continue tool calls with an original audio attachment, or combine
direct audio understanding with structured output. It never substitutes
transcription when a caller asks for general audio understanding.

Anthropic transcription, video, PDF/document input, multimodal tool results,
generated media, durable media sessions, public provider-file management, and
realtime voice are also unsupported. These boundaries are deliberate: Axl
rejects unsupported input instead of dropping it or silently converting it.

## Try image input end to end

Run the repository example with a current image-capable model URI. The examples
below are representative defaults, not model allowlists. The command
reuses the checked-in Studio Playground screenshot, so no upload is needed:

```bash
pnpm --filter @axlsdk/axl build
cd examples
npm install
IMAGE_MODEL=openai-responses:gpt-4o-mini npm run image-lighthouse
IMAGE_MODEL=anthropic:claude-sonnet-4-5 npm run image-lighthouse
IMAGE_MODEL=google:gemini-3.7-flash npm run image-lighthouse
# Representative OpenRouter transport certification path (not an allowlist):
IMAGE_MODEL=openrouter:openai/gpt-4o-mini npm run image-lighthouse
```

Set the matching `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, or
`OPENROUTER_API_KEY`. The example asks a first agent for a structured visual
finding and a second agent to verify it; start with the first native command to
confirm your key and chosen model. It intentionally makes paid calls and is not
part of default tests.

Optional cross-catalog integration tests also certify OpenRouter
image-plus-tool continuation and dedicated transcription transport with
representative non-OpenAI model slugs. Their models are configurable examples,
not allowlists. Commands, request-count ceilings, and the dated results are in
[Testing](./testing.md) and the
[OpenRouter verification record](./verification/openrouter-catalog-multimodal-2026-09-02.md).

## Verify transcription end to end

The optional transcription integration suite decodes the checked-in
eight-second MP3 fixture in memory. It is an excerpt from the Open Speech
Repository Harvard sentences recording; see
[`recorded-call.README.md`](../packages/axl/src/__tests__/fixtures/recorded-call.README.md)
for attribution and license notice. It separately verifies transcription and
the explicit composition of a transcript with a normal text agent for a
schema-valid summary and action-item list. Gemini coverage verifies language,
word timestamps, diarization, and custom vocabulary in the combinations the
API supports. Its analysis call uses ordered text input through the same
stateless Interactions transport used by rich calls. See
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

Those provider documents establish upstream surfaces. For OpenRouter, the table
documents Axl's generic transport contract; it does not guarantee modality or
parameter support for every catalog model/route.
