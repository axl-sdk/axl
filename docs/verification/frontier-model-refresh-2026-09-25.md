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
they do not show that the new model IDs accept these requests on a live account.

## Provider acceptance pending

The gated `pnpm test:integration:frontier` suite collected 43 cases and skipped
all of them without OpenAI, Anthropic, or Google credentials. No paid calls
were made. Live evidence is still needed for:

- OpenAI GPT-6 Responses and Chat endpoint acceptance, schema/stream/tool
  continuation, Sol/Luna Chat tools at explicit `none`, and real usage/cache
  semantics.
- Anthropic Opus 5.5 adaptive effort and genuine signed-thinking replay across
  compatible/incompatible prefixes, model changes, summaries, native opt-out,
  and streaming transformation placement.
- Gemini 3.8 Flash GenerateContent and Interactions acceptance, including
  image/audio interpretation, tool/stream/schema results, and observed usage
  buckets.

Google's published Gemini 3.8 rates do not establish a distinct recorded-audio
input rate. Positive audio-token calls remain unpriced, and any execution
containing one reports a lower-bound cost. Other unobservable billing tiers,
regional charges, and tool fees also remain unpriced. No default model changed.
