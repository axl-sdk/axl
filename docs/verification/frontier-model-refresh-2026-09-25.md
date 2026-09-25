# Frontier model refresh verification — 2026-09-25

This record covers Axl's implementation for `gpt-6-astra`, `gpt-6-sol`,
`gpt-6-luna`, `claude-opus-5-5`, and `gemini-3.8-flash`. It separates local
adapter/runtime verification from exact-model provider acceptance.

## Completed locally

The model contracts and Standard price schedules were rechecked against
[OpenAI guidance](https://developers.openai.com/api/docs/guides/latest-model),
[OpenAI pricing](https://developers.openai.com/api/docs/pricing),
[Anthropic's Opus 5.5 model page](https://platform.claude.com/docs/en/models/opus-5-5/overview),
[Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking),
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), and the
[Gemini 3.8 model card](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).

On the feature branch at `401bb7f`, focused provider/accounting tests passed
(261), as did the repository test suite, workspace typecheck, production build,
affected e2e tests (128), and Studio API tests (228). Deterministic tests cover
exact-ID routing and request guards, pricing arithmetic and Gemini's 2027 UTC
rate change across retries, Anthropic diagnostic normalization, generated and
cached summary accounting, and persisted Studio REST/WebSocket redaction and
lower-bound display. Studio's dev server loaded the trace and cost views.

The independent consequential-seam review approved the SDK diff with no open
code defects. These checks use controlled transports or fixture providers;
the exact-model acceptance evidence below comes from separate live calls.

## Exact-model live acceptance

The root `.env` contains OpenAI, Anthropic, and Google credentials. The live
loader accepts its `export` syntax; an earlier shell check missed that syntax.
Narrow, named test selections made **40 logical model calls** across those
providers. The entire frontier gate was not run because it also includes
unrelated legacy and xAI cases. No provider key or raw response is recorded here.

- **OpenAI:** GPT-6 Astra, Sol, and Luna accepted Responses text and strict
  schema calls and Chat text calls. Astra completed a Responses function-tool
  continuation; Luna returned terminal stream usage; Sol and Luna accepted Chat
  function tools with explicit `none`. Each tested response returned usage and
  an estimated Standard cost. Forbidden combinations remain covered by local
  zero-fetch assertions. Real cache-write and over-272K-token pricing were not
  exercised; their estimator arithmetic has local fixture coverage.
- **Anthropic:** Opus 5.5 accepted text, terminal streaming, and an automatic
  tool continuation with genuine signed thinking. An unchanged continuation
  preserved that thinking; an edited system prefix reported
  `prefix_binding_mismatch`. Opus-to-Fable 5.1 preserved compatible thinking,
  and Fable-to-Opus reported `model_binding_mismatch`. Live effort levels were
  `low` and `max`. Further live calls verified edited tool and prior-message
  resets, a provider 400 for explicit native `error` policy, and a terminal
  streamed reset with the same edited prefix. A runtime test then generated
  one `maxContext` summary and reused it on a second ask around a genuine
  signed tool turn. Both outgoing requests retained the original user text,
  signed thinking, and matching tool-use/result IDs; each affected call
  emitted one safe reset diagnostic. The other effort levels, `none` clamp,
  and forced-tool rejection have local zero-fetch/adapter coverage only.
  Anthropic may omit a thinking block on a simple adaptive-thinking request;
  two seed probes returned no signed block and were excluded from replay
  assertions.
- **Google:** Gemini 3.8 Flash accepted GenerateContent text, strict schema,
  function-tool continuation, and streaming calls, plus Interactions image and
  recorded-audio input. The responses reported the exact model and usage.
  `none` resolved to `low`. The image call received a positive token estimate;
  the audio call reported positive audio input tokens and remained unpriced.

The selected live scenarios passed under the approved 42-call / $5 ceiling.
This record does not claim a provider invoice audit: costs are adapter
estimates, and precise billed spend is unknown. Real cache-write and
over-272K-token billing, non-Standard billing tiers, and Anthropic effort
values other than the two exercised live remain unverified at the provider
boundary.

Google's published Gemini 3.8 rates do not establish a distinct recorded-audio
input rate. Positive audio-token calls remain unpriced, and any execution
containing one reports a lower-bound cost. Other unobservable billing tiers,
regional charges, and tool fees also remain unpriced. No default model changed.
