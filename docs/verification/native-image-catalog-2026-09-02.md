# Native image catalog verification — 2026-09-02

**Status:** Passed with separate model-parameter findings
**Scope:** Current-model image admission through the native OpenAI Responses,
Anthropic, and Gemini transports

## Passing image-only smoke

The existing multimodal lighthouse was made model-overridable and run against
the current documented image models. Each row used the checked-in Playground
PNG and made exactly one successful model invocation:

| Row | Provider/model | Source and transport | Result |
| --- | --- | --- | --- |
| L1 | `openai-responses:gpt-5.6` | Inline PNG bytes through Responses | Passed; nonempty text and honest terminal accounting |
| L11 | `anthropic:claude-opus-5` | HTTPS image through native content blocks | Passed; nonempty text and honest terminal accounting |
| L4 | `google:gemini-3.8-flash` | Inline PNG bytes through stateless Interactions | Passed; schema-valid output and honest terminal accounting |

Command shape:

```bash
AXL_MULTIMODAL_LIVE=1 \
  OPENAI_IMAGE_MODEL=gpt-5.6 \
  ANTHROPIC_IMAGE_MODEL=claude-opus-5 \
  GEMINI_IMAGE_MODEL=gemini-3.8-flash \
  pnpm --filter @axlsdk/axl exec vitest run \
  --config vitest.integration.config.ts \
  src/__tests__/integration-multimodal-input.test.ts \
  -t '\[L1\]|\[L11\]|\[L4\]'
```

No API keys, image bytes, URLs containing credentials, or provider response
bodies are recorded here.

## Discriminating first run

The first run retained older row-level parameter choices and correctly reached
all three providers, but did not pass:

- GPT-5.6 rejected `temperature: 0` with HTTP 400 because that parameter is not
  supported by the model.
- Gemini 3.8 Flash rejected Axl's `effort: 'none'` mapping to `minimal` with
  HTTP 400; the provider reported that this model accepts `low`, `medium`, or
  `high`.
- Claude Opus 5 accepted the image request but returned no visible text under a
  32-token output ceiling while default thinking was active.

The smoke was first narrowed to image transport with a sufficient output
ceiling, proving the catalog-capable admission change independently of optional
parameters. The OpenAI and Gemini mismatches were then repaired with exact
current-model normalization and discriminating unit tests. A final bounded live
rerun retained `temperature: 0` for GPT-5.6 (and verified that Axl omits it) and
`effort: 'none'` for Gemini 3.8 Flash (mapped to `low`). These are parameter
compatibility findings, not failures of the image encoding.
