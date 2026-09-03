# Provider URI Reference

Agents reference models using the `provider:model` URI scheme. Axl ships four native
adapters plus OpenAI-compatible presets, all built on raw `fetch` with no provider SDKs.

All providers retry `429` (rate limit), `503` (unavailable), and `529` (overloaded)
responses with exponential backoff.

The base catalog and pricing were reviewed against first-party documentation on
August 3, 2026; native image transport and the current GPT-5.6, Claude Opus 5,
and Gemini 3.8 Flash parameter seams were refreshed on September 2. Exact known
IDs receive their documented parameter and pricing behavior. Other IDs may pass
through to the provider but remain unpriced and do not inherit model-specific
behavior. See the [catalog verification](./verification/latest-provider-models-2026-08-03.md)
and [native image refresh](./verification/native-image-catalog-2026-09-02.md).

## OpenAI — Responses API (preferred)

The Responses API is the preferred OpenAI integration. It supports prompt caching, native
reasoning, and automatic reasoning-context round-tripping through `providerMetadata`. All
models below use the `openai-responses:` prefix and share `openai` configuration by default.

```
openai-responses:gpt-5.6        # Alias of GPT-5.6 Sol
openai-responses:gpt-5.6-sol    # Highest-capability GPT-5.6 variant
openai-responses:gpt-5.6-terra  # Balanced GPT-5.6 variant
openai-responses:gpt-5.6-luna   # Fast GPT-5.6 variant
openai-responses:gpt-5-mini     # Cost-optimized reasoning and chat
openai-responses:gpt-5-nano     # High-throughput, straightforward tasks
openai-responses:o4-mini        # Dedicated reasoning (small)
openai-responses:o3              # Dedicated reasoning
openai-responses:o3-pro          # Dedicated reasoning (pro)
```

## OpenAI — Chat Completions API

The same models are available with the `openai:` prefix. Use Chat Completions for features the
Responses adapter does not support, such as stop sequences.

```
openai:gpt-5.6                  # Alias of GPT-5.6 Sol
openai:gpt-5.6-sol              # Highest-capability GPT-5.6 variant
openai:gpt-5.6-terra            # Balanced GPT-5.6 variant
openai:gpt-5.6-luna             # Fast GPT-5.6 variant
openai:gpt-5.5                  # Previous gen
openai:gpt-5.5-pro              # Previous gen (pro)
openai:gpt-5-mini               # Cost-optimized reasoning and chat
openai:gpt-5-nano               # High-throughput, straightforward tasks
openai:gpt-5.4                  # Previous gen
openai:gpt-5.4-pro              # Previous gen (pro)
openai:gpt-5.3                  # Previous gen
openai:gpt-5.2                  # Previous gen
openai:gpt-5.1                  # Previous gen
openai:gpt-5                    # Previous gen
openai:o4-mini                  # Dedicated reasoning (small)
openai:o3                       # Dedicated reasoning
openai:o3-mini                  # Dedicated reasoning (small)
openai:o3-pro                   # Dedicated reasoning (pro)
openai:o1                       # Legacy reasoning
openai:o1-mini                  # Legacy reasoning (small)
openai:o1-pro                   # Legacy reasoning (pro)
openai:gpt-4.1                  # Previous gen
openai:gpt-4.1-mini             # Previous gen (small)
openai:gpt-4.1-nano             # Previous gen (cheapest)
openai:gpt-4o                   # Legacy
openai:gpt-4o-mini              # Legacy
openai:gpt-4-turbo              # Legacy
openai:gpt-4                    # Legacy
openai:gpt-3.5-turbo            # Legacy
```

OpenAI's o-series uses the `developer` role, strips `temperature`, and supports `effort`.
GPT-5.x uses `system` and supports the same portable option. Exact GPT-5.6 Chat requests with
`effort: 'max'` use `xhigh` and report the clamp through a `provider_diagnostic`
event; choose `openai-responses:` for native `max`. For compatibility, unknown GPT-5-shaped IDs retain the older baseline request mapping,
but never inherit exact pricing or GPT-5.6-specific capabilities.

## Anthropic

```
anthropic:claude-fable-5        # Highest-capability Claude 5; thinking always on
anthropic:claude-opus-5         # Claude 5 flagship; thinking on by default
anthropic:claude-sonnet-5       # Claude 5 balanced; thinking on by default
anthropic:claude-opus-4-8       # Previous flagship
anthropic:claude-opus-4-7       # Previous flagship (supports effort: 'xhigh')
anthropic:claude-opus-4-6       # Previous flagship
anthropic:claude-sonnet-4-6     # Previous balanced model
anthropic:claude-sonnet-4-5     # Balanced
anthropic:claude-haiku-4-5      # Fast and affordable
anthropic:claude-opus-4-5       # Previous gen
```

`claude-opus-4-1` is deprecated on Anthropic-operated APIs and retires August 5,
2026; migrate to `claude-opus-4-8`. Claude Opus 4, Sonnet 4, Sonnet 3.7,
Sonnet/Haiku 3.5, and all Claude 3 models previously shown here are retired on the
first-party API. Migrate Opus workloads to `claude-opus-4-8`, Sonnet workloads to
`claude-sonnet-4-6`, and Haiku workloads to `claude-haiku-4-5`. Axl does not enforce
these lifecycle dates with a runtime allowlist: arbitrary IDs remain pass-through.
[Anthropic-operated and partner-cloud schedules can differ](https://platform.claude.com/docs/en/about-claude/model-deprecations).

## Google Gemini

```
google:gemini-3.8-flash              # Current image-capable fast model
google:gemini-3.6-flash              # Earlier fast model (GA)
google:gemini-3.5-flash              # Previous fast model (GA)
google:gemini-3.5-flash-lite         # Low-cost model (GA)
google:gemini-3.1-pro-preview        # Pro preview
google:gemini-3-flash-preview        # Flash preview
google:gemini-3.1-flash-lite         # Previous low-cost model (GA)
google:gemini-2.5-pro                # Previous gen (most capable)
google:gemini-2.5-flash              # Previous gen (fast)
google:gemini-2.5-flash-lite         # Previous gen (cheapest)
```

First-party lifecycle migrations: `gemini-3-pro-preview` shut down March 9, 2026
(`gemini-3.1-pro-preview` replacement); `gemini-3.1-flash-lite-preview` shut down
May 25, 2026 (`gemini-3.1-flash-lite`, with `gemini-3.5-flash-lite` now preferred);
and Gemini 2.0 Flash/Flash-Lite shut down June 1, 2026 (use `gemini-3.6-flash` /
`gemini-3.1-flash-lite`). `gemini-3-flash-preview` remains available, but Google
recommends `gemini-3.6-flash`. See [Gemini deprecations](https://ai.google.dev/gemini-api/docs/deprecations).

Gemini [requires every `functionResponse.response` to be a JSON
object](https://ai.google.dev/api/generate-content#FunctionResponse). Axl parses canonical
tool-message content as JSON when possible: objects remain the response, while parsed
primitives, `null`, and arrays are wrapped as `{ result: value }`; non-JSON text is wrapped
as `{ result: text }`. Because Axl's canonical tool-message content is string-only,
JSON-looking verbatim text is indistinguishable from serialized structured data at this
adapter boundary. Use a record projection such as `{ result: text }` when that semantic
distinction matters. This provider-envelope normalization does not change the canonical
`ChatMessage.content` seen by Axl or other providers.

### Rich image transport

String-only `google:` calls continue to use `generateContent` unchanged. Rich
image input accepts any nonblank `google:` model ID and currently uses the
`/v1beta`
[Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)
with `store: false`. It is stateless: Axl sends application-owned history and
does not use `previous_interaction_id`, background execution, or raw transport
overrides. Google remains authoritative for whether the selected model supports
Interactions and image input. Direct HTTP image URLs are not sent as Gemini
file URIs: applications must pass bytes/base64 or explicitly upload through
Gemini Files and supply the returned URI as a `google` provider-file. Axl does
not host-fetch or silently upload chat images. See
[Multimodal model input](./multimodal-input.md) for source rules and the
cross-provider table.

### Completed-file transcription

Transcription has its own registry and URI family; it is never routed through
chat adapters. The built-in mappings are `openai-transcription:gpt-transcribe`
to OpenAI multipart `/audio/transcriptions`,
`gemini-transcription:gemini-3.5-transcribe` to Gemini Files plus stateless
Interactions, and `openrouter-transcription:<vendor/model>` to OpenRouter's
JSON `/audio/transcriptions`. Gemini byte/base64 sources create a temporary
provider file, wait for readiness when necessary, transcribe with `store:
false`, and attempt deletion in `finally`; callers own any reusable
provider-file URI. OpenAI and OpenRouter accept inline sources only. OpenRouter
does not receive a runtime catalog lookup: its endpoint/model compatibility is
authoritative. `ctx.transcribe()` wraps an OpenRouter provider failure as safe
`TranscriptionOperationError`, retaining only bounded provider diagnostics and
the original `ProviderError` as a non-enumerable cause. See
[Multimodal model input](./multimodal-input.md#completed-file-transcription)
for exact source/options/cost semantics and the temporary-file retention risk.
All built-in inline transcription sources are capped at 25 MiB decoded before
copying or base64 decoding. `ctx.transcribe()` converts adapter failures into a
safe `TranscriptionOperationError` while preserving status, retryability,
optional retry delay, and optional request ID from `ProviderError`; the raw
provider body remains confined to the non-enumerable cause.

### Structured output & schema handling on Gemini

Gemini's schema sanitizer (`sanitizeSchemaForGemini`) strips a set of JSON-Schema
keywords it doesn't support — including `$ref` and `$defs`. This has two
consequences worth knowing:

- **Tool-definition schemas must stay inline.** Axl renders provider tool
  definitions with the inline (`$ref`-free) converter for exactly this reason. A
  `$ref`-hoisted tool schema would be sanitized down to a typeless `{}` on Gemini
  (with no 400 error — a silent type loss). This is why the appended-prompt schema
  compaction (which *does* use `$ref`) is scoped to prompt text only, where `$ref`
  is opaque bytes the model reads rather than a structural schema on the wire.
- **On the default JSON mode, the prompt text is the schema contract.** When a
  schema is requested without native structured output, Axl sends
  `responseMimeType: 'application/json'` with **no** `responseSchema` on Gemini
  (and a generic "respond with JSON" system line on Anthropic — schema never
  transmitted structurally). On those providers the appended prompt schema is the
  *entire* schema signal, so its content matters more than on OpenAI.

## xAI Grok (Chat preset)

The `xai:` preset is intentionally the existing OpenAI-compatible Chat Completions
surface. Current self-serve text IDs and aliases recognized by its exact capability
descriptors are:

```
xai:grok-4.5                         # Agentic coding; aliases: grok-4.5-latest, grok-build-latest
xai:grok-4.3                         # Fast general model; aliases: grok-4.3-latest, grok-latest
xai:grok-4.20                        # Alias of grok-4.20-0309-reasoning
xai:grok-4.20-non-reasoning          # Alias of grok-4.20-0309-non-reasoning
```

The exact Grok 4.20 beta/experimental aliases published on the corresponding xAI
model pages receive the same reasoning or non-reasoning descriptor. Grok 4.5 accepts
`low`/`medium`/`high` and maps portable `none` to `low`; Grok 4.3 additionally accepts
`none`. The current Chat contract does not establish a portable `reasoning_effort`
field for Grok 4.20, so Axl omits it for both 4.20 variants. Multi-agent, returned
reasoning state, and encrypted reasoning replay belong to xAI's Responses API and are
not claimed by this Chat preset. Unknown Grok siblings pass through without inferred
capabilities. Cost uses xAI's returned USD tick total rather than a static rate table.

## OpenAI-compatible providers & presets

The OpenAI `/v1/chat/completions` wire format is the de-facto standard, so one generic
engine — `OpenAICompatibleProvider`, parameterized by a `ProviderProfile` — serves every
endpoint that speaks it. Axl ships built-in **presets** registered under their own
`provider:` name; pick a model with `preset:model`:

```
openrouter:anthropic/claude-opus-4.7   # 300+ models behind one key (vendor/model slug)
openrouter:openai/gpt-5.6
azure:my-deployment                    # deployment name is the "model"
xai:grok-4.20
deepseek:deepseek-v4-pro
mistral:mistral-large-latest
groq:openai/gpt-oss-120b               # fastest inference; open-weight only
bedrock:openai.gpt-oss-120b            # AWS Bedrock (gpt-oss); region base URL + bearer token
ollama:llama3                          # local — no key, $0
vllm:meta-llama/Llama-3.3-70B-Instruct
lmstudio:<model>  ·  llamacpp:<model>  ·  sglang:<model>
```

Configure each like any provider (`apiKey` / `baseUrl` / `authHeader` / `rateLimit` under its
name), or rely on its env vars. Most presets read `<PRESET>_API_KEY` and
`<PRESET>_BASE_URL` (for example `OPENROUTER_API_KEY`, `XAI_API_KEY`); Azure uses
`AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL`, and Bedrock uses
`AWS_BEARER_TOKEN_BEDROCK` + `BEDROCK_BASE_URL`.

| Preset | Default base URL | Auth | Reasoning | Pricing |
|---|---|---|---|---|
| `openrouter` | `https://openrouter.ai/api/v1` | Bearer | `reasoning` object (effort/budget); captures `reasoning_details` | **provider-reported** (`usage.cost`, USD) |
| `azure` | *your resource* (`AZURE_OPENAI_BASE_URL`) | `api-key` header | reuses OpenAI (o-series/GPT-5) | unknown (deployment billing is not inferred) |
| `xai` | `https://api.x.ai/v1` | Bearer | exact Grok 4.3/4.5/4.20 Chat capabilities | **provider-reported** usage ticks |
| `deepseek` | `https://api.deepseek.com/v1` | Bearer | captures `reasoning_content`, round-trips on tool turns; no `json_schema` | exact V4 table; cache-hit/miss split |
| `mistral` | `https://api.mistral.ai/v1` | Bearer | `reasoning_effort` on supported families only | exact current-model table |
| `groq` | `https://api.groq.com/openai/v1` | Bearer | `reasoning_effort` on reasoning families only | exact current-model table |
| `bedrock` | *your region* (`BEDROCK_BASE_URL`) | Bearer (`AWS_BEARER_TOKEN_BEDROCK`) | `reasoning_effort` for gpt-oss | unknown |
| `ollama` | `http://localhost:11434/v1` | none | inline `<think>` | **$0** |
| `vllm` | `http://localhost:8000/v1` | optional | inline `<think>` | **$0** |
| `lmstudio` | `http://localhost:1234/v1` | none | inline `<think>` | **$0** |
| `llamacpp` | `http://localhost:8080/v1` | none | inline `<think>` | **$0** |
| `sglang` | `http://localhost:30000/v1` | none | inline `<think>` | **$0** |

Notes & caveats:
- **`effort` works across reasoning models**, not just OpenAI — each preset maps the unified
  knob to its provider's mechanism (and omits it where the provider/model rejects it, so it's
  never a silent 400).
- **Honest cost.** OpenRouter and xAI return per-call charges, which Axl surfaces directly;
  DeepSeek, Mistral, and Groq use exact built-in current-model tables; local presets are an
  explicit `$0`. Unknown models, Azure deployments, non-representable tiers, and unsupported
  billing modifiers return `undefined` (**unknown**, never a misleading `$0`). Built-in tables
  match exact IDs; custom profile tables retain prefix matching unless `match: 'exact'` is set.
- **Capability is per-model on marketplaces** (OpenRouter/Groq): one model supports
  strict `json_schema` and the next doesn't. Profile flags are sensible defaults; use
  [`providerOptions`](#provideroptions) for per-call overrides.
- **OpenRouter multimodal transport is catalog-capable, not catalog-aware.** Any
  nonblank `openrouter:<vendor/model>` URI accepts image URL, bytes, and base64
  in the standard `image_url` wire shape. Image requests may also use Axl tools,
  streaming, and structured output; whether the selected model/route supports
  that combination is OpenRouter's decision. Axl performs no catalog lookup and
  surfaces an image capability rejection through `ctx.ask()` as `ProviderError`.
  Provider-file images and raw rich input-container overrides remain local
  rejections. Any nonblank `openrouter-transcription:<vendor/model>` URI
  similarly sends supported completed-file bytes/base64 to the dedicated
  transcription endpoint; its failure reaches callers as the safe
  `TranscriptionOperationError` described above. URL, realtime, and
  general-audio input are not part of that adapter.
- **Self-hosted** is keyless by default; pass a key only if your server enforces one. Server
  caveats (not Axl bugs): Ollama's `/v1` drops streaming `tool_calls` deltas and lacks
  `tool_choice` (use its native `/api/chat` for heavy tool use); vLLM/SGLang/LM Studio
  tool-calling depends on server launch flags + per-model parsers.
- **Azure (v1 API):** set the base URL to `https://{resource}.openai.azure.com/openai/v1`;
  the deployment name goes in the model slot. API-key auth uses the `api-key` header; Entra
  token auth uses the async-key callback plus `authHeader: 'bearer'` (see below).
- **AWS Bedrock:** scoped to **gpt-oss** for now (Claude-on-Bedrock is a later native-adapter
  mode). Set a region base URL and a bearer token (`AWS_BEARER_TOKEN_BEDROCK`). Match the model
  id to the endpoint: the preferred `bedrock-mantle` endpoint uses **unsuffixed** ids
  (`openai.gpt-oss-120b`); the alternative `bedrock-runtime` endpoint uses the version-suffixed
  form (`openai.gpt-oss-120b-1:0`). Cost is unknown (Bedrock returns no per-call cost). No
  SigV4 — short-term tokens can use the async-key callback.
- **Expiring credentials (Azure-Entra, Bedrock short-term, Databricks/IBM OAuth):** set a
  provider's `apiKey` to a function `() => string | Promise<string>` — Axl resolves it per
  request, so your callback owns refresh. Azure Entra also needs `authHeader: 'bearer'` because
  the Azure preset defaults to `api-key` header auth. A plain string is the common case. (The
  callback covers the four chat adapters; the semantic-memory embedder still takes a static key.)

Build your own preset by cloning a `ProviderProfile` (see [Custom Providers](#custom-providers)).

## Configuration

```typescript
import { defineConfig } from '@axlsdk/axl';

export default defineConfig({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY },
    // openai-responses shares the openai config by default
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
    google: { apiKey: process.env.GOOGLE_API_KEY },
  },
});
```

### Transport security

Built-in provider adapters and `OpenAIEmbedder` require an absolute HTTP(S)
endpoint. HTTPS is accepted for any host. Plain HTTP is accepted automatically
only for literal loopback hosts: `localhost` (including a trailing dot), IPv4
`127.0.0.0/8`, and IPv6 `::1`. Classification uses the parsed URL hostname and
does not trust DNS resolution.

Docker service names, private IPs, `host.docker.internal`, and other non-loopback
HTTP endpoints therefore require an explicit, per-endpoint acknowledgement:

> **Migration:** an existing non-loopback `http://` `baseUrl` now fails closed.
> Move the endpoint to HTTPS when possible; otherwise add the explicit override
> to that provider block after confirming the network is intentionally trusted.

```typescript
export default defineConfig({
  providers: {
    ollama: {
      baseUrl: 'http://ollama:11434/v1',
      dangerouslyAllowInsecureHttp: true,
    },
  },
});
```

`dangerouslyAllowInsecureHttp` defaults to `false`. It permits only an otherwise
valid HTTP URL; it does not permit malformed URLs or other schemes. Direct
provider constructors, compatible-provider profiles, environment-provided base
URLs, `OpenAIEmbedder`, and built-in HTTP MCP clients follow the same rule.
`openai-responses` inherits the complete `openai` provider block—including this
option—only when it has no block of its own. HTTP MCP sets the option on its own
server entry.

Validation happens when that provider is first resolved, before an async API-key
callback or network request. An unused provider block remains lazy. A rejected
endpoint throws `AxlError` with `code: 'UNSAFE_TRANSPORT'` and an actionable
message that does not echo URL credentials or query values.

Provider, embedding, and HTTP MCP requests never follow HTTP redirects.
Provider/embedder 3xx responses use the adapter's existing non-success
`ProviderError` path with the original status; HTTP MCP reports an MCP HTTP
error. Configure the final endpoint URL instead. This prevents a POST body or
authorization header from being resent to a redirect target.

HTTP MCP tool calls intentionally do not use provider retry behavior because
they may be non-idempotent; a failed call is returned through the MCP error path.
Custom `Provider` implementations own their transport policy. The guard does not
defeat a trusted TLS-inspection root installed on the backend host; that host is
part of the application's trust boundary. See
[Security > Prompt confidentiality](./security.md#prompt-confidentiality-and-the-trusted-backend).

### Rate limiting (opt-in)

The automatic 429/503/529 backoff above is **reactive** — it only kicks in after a
request is rejected. For **proactive** pacing (so you don't storm a provider in the
first place), set `rateLimit` on a provider config. This is most useful when a large
fan-out shares one API key — e.g. an eval running `concurrency × scorerConcurrency`
(up to 25 by default) concurrent judge calls.

```typescript
export default defineConfig({
  providers: {
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      rateLimit: {
        maxConcurrent: 8,      // ≤ 8 requests in flight at once
        minIntervalMs: 50,     // ≥ 50ms between request starts (optional)
        acquireTimeoutMs: 30000, // fail loud if a call waits > 30s in the queue (optional)
      },
    },
  },
});
```

`RateLimitConfig` fields (all optional):

| Field | Type | Description |
|-------|------|-------------|
| `maxConcurrent` | `number` | Max requests in flight for this provider. Must be a finite integer ≥ 1 (invalid values disable the cap with a warning). `1` serializes all requests (a throughput floor, not a deadlock — see below). |
| `minIntervalMs` | `number` | Minimum ms between successive request *grants* (global spacing, no burst bucket). |
| `acquireTimeoutMs` | `number` | If set, a call that waits longer than this in the queue rejects (fail loud) instead of hanging on a misconfigured cap. |

**Scope & caveats:**

- **Caps request concurrency, not token throughput (TPM).** A permit is released at
  response *headers*, so streaming responses don't hold a permit for their whole
  lifetime. This bounds requests/min pressure, not tokens/min.
- **Chat calls only.** The governor wraps provider `chat`/`stream` calls. Memory
  **embedder** calls (e.g. `ctx.remember({ embed: true })`) are constructed outside
  the provider registry and are **not** governed in this version — they can still
  count against a shared key's limit.
- **Per provider instance / process.** Providers are singletons per (runtime,
  provider type), so one governor covers all chat calls through that adapter — but
  not other processes or runtimes sharing the same key.
- **`openai-responses` inherits `openai`'s `rateLimit`** when it has no config of its
  own (same fallback as `apiKey`/`baseUrl`). Note this builds a **separate governor
  instance** per adapter, not a shared counter — if you configure `providers.openai`
  and use *both* `openai:` and `openai-responses:` models, you get two independent
  caps against the same key (effective concurrency = the sum). Set `maxConcurrent`
  with that in mind, or give each adapter its own block.
- **No deadlock on nesting.** A permit is held only across a single HTTP call, never
  across a nested `ctx.ask()` (tool handlers run between provider calls, not during),
  so an agent-as-tool chain on the same provider under `maxConcurrent: 1` still
  completes — permits don't stack.
- **Custom providers** registered via `registerInstance` are not governed unless they
  wrap `fetchWithRetry({ governor })` themselves.

**Using it with `axl-eval`:** the eval CLI builds its runtime from your config
(`--config` or an auto-detected `axl.config.*`), so `providers.<name>.rateLimit` is
honored for judge calls — this is the canonical way to pace eval fan-out on a shared
key. A *bare* `axl-eval` run with no config (providers from env vars only) has no
governor; if you need pacing there, add a minimal `axl.config.ts` exporting an
`AxlRuntime` with the `rateLimit` block. (There is no per-run CLI flag for it today.)

You can also construct a `RateLimiter` directly (exported from `@axlsdk/axl`) if you
build a custom provider adapter.

### Retry backoff — worst case

The reactive retry does up to **2 retries (3 attempts total)** on `429`/`503`/`529`.
Delay per attempt honors a `Retry-After` header when present; otherwise it's
`1000ms × 2^attempt` (1s, then 2s) with ±25% jitter, and the wait is abort-aware
(a cancelled signal short-circuits the sleep). Worst case for a single call that
exhausts retries without `Retry-After`: roughly `1s + 2s ≈ 3s` of backoff plus three
request round-trips before the final error surfaces. Combined with the governor, the
whole retry loop runs inside one held permit, so backoff naturally applies
backpressure to other queued calls rather than letting them pile on a struggling
provider.

### Typed provider errors

Every adapter throws a `ProviderError` (extends `AxlError`, `code: 'PROVIDER_ERROR'`)
on a non-2xx HTTP response, and `fetchWithRetry` normalizes a thrown network failure
(DNS, connection reset, TLS, socket hangup) into a `ProviderError` with `status: 0`.
The `.message` is the provider's own error text, **verbatim** (no added prefix), so
existing message assertions keep working — only the thrown *type* changed.

```typescript
import { ProviderError } from '@axlsdk/axl';

try {
  await ctx.ask(agent, 'hi');
} catch (err) {
  if (err instanceof ProviderError) {
    err.provider;     // 'openai' | 'anthropic' | 'google' | 'openai-responses' | preset name
    err.status;       // HTTP status; 0 for network failures
    err.retryable;    // semantic failover hint (see below)
    err.retryAfterMs; // parsed Retry-After, raw/unclamped (when header present)
    err.requestId;    // provider request id (when a standard header is present)
    err.body;         // raw provider error body (NOT placed on the event stream)
  }
}
```

**Two separate retry concepts — do not conflate them:**

- **Transport auto-retry** (`429`/`503`/`529`) is what `fetchWithRetry` retries on the
  *same* provider with backoff. This set is deliberately narrow.
- **`ProviderError.retryable`** is a *broader semantic failover hint* for higher layers
  (e.g. "should I fail over to a different model/provider?"). Exported helper
  `isRetryableStatus(status)` returns the same classification:

  | status | `retryable` |
  |---|---|
  | `408`, `429`, `500`, `502`, `503`, `504`, `529` | `true` |
  | `0` (network) | `true` |
  | `400`, `401`, `403`, `404`, `409`, `413`, `422`, `425`, other 4xx | `false` |

  `404` (model/catalog miss) and `409` (conflict) are intentionally **not** retryable:
  cross-provider catalog-miss failover is a higher-layer *policy* decision, not a
  transport-level hint. Unmapped codes default to `false` (conservative).

**Retry-After** is surfaced on the thrown error (`retryAfterMs`, raw/unclamped) in both
numeric-seconds and HTTP-date forms. The in-loop transport sleep clamps to 60s so a
hostile/huge header can't stall the loop; the raw value still rides on the error.

`ProviderError.body` carries the raw provider response — see `docs/security.md` for why
it stays on the error and is never emitted on the event stream.

## Model Parameters

All model parameters are configurable on `AgentConfig` (agent-level defaults) and overridable per-call via `AskOptions`. Precedence: `AskOptions` > `AgentConfig` > internal defaults.

```typescript
const creative = agent({
  model: 'openai-responses:gpt-5.6',
  system: 'Write creative stories.',
  temperature: 0.9,   // higher = more creative (0.0–2.0)
  maxTokens: 8192,
});

const reasoner = agent({
  model: 'anthropic:claude-opus-4-6',
  system: 'Solve complex problems step by step.',
  effort: 'high',   // works across all providers
});

const precise = agent({
  model: 'openai-responses:gpt-5.6',
  system: 'Extract structured data.',
  temperature: 0.1,   // lower = more deterministic
  toolChoice: 'required',
});

// Per-call overrides
const answer = await ctx.ask(creative, prompt, { temperature: 0.2, maxTokens: 2048 });
const solution = await ctx.ask(reasoner, problem, { effort: 'low' });
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `temperature` | provider default | Controls randomness (0.0–2.0). Stripped automatically for reasoning models and when thinking is active on Anthropic. |
| `maxTokens` | `4096` | Maximum completion tokens per call. |
| `effort` | — | Unified effort level controlling reasoning depth across all providers (see below). |
| `thinkingBudget` | — | Explicit thinking token budget (advanced). Overrides effort-based allocation. Set to `0` to disable thinking while keeping `effort` for output control (Anthropic). |
| `includeThoughts` | — | Return reasoning summaries in responses. Supported on OpenAI Responses API and Gemini. No-op on Anthropic. |
| `toolChoice` | — | Controls whether and how the model uses tools (see below). |
| `stop` | — | Stop sequences — generation stops when any sequence is encountered (see below). |

### `effort`

The `effort` parameter provides a unified way to control reasoning depth across all providers. Values: `'none'` | `'low'` | `'medium'` | `'high'` | `'xhigh'` | `'max'`. Exact model and endpoint capabilities decide whether a tier is sent, clamped, or omitted. GPT-5.6 accepts native `'max'` on Responses; Chat Completions caps it to `'xhigh'`. Every clamp is reported through a `provider_diagnostic` event — see [Seeing a clamp at runtime](#seeing-a-clamp-at-runtime). Claude 5 accepts native `'max'`; older families retain their documented caps.

```typescript
// Most users — just effort:
const reasoner = agent({
  model: 'anthropic:claude-opus-4-6',
  system: 'Solve complex math problems.',
  effort: 'high',
});

// Disable thinking entirely:
agent({ model: 'anthropic:claude-opus-4-6', effort: 'none' });

// Per-call override:
const answer = await ctx.ask(reasoner, problem, { effort: 'low' });
```

**`thinkingBudget` — precise control (advanced):**

```typescript
// Explicit token budget:
const answer = await ctx.ask(reasoner, problem, { thinkingBudget: 8000 });

// Disable thinking but keep effort for output control (Anthropic optimization):
agent({ model: 'anthropic:claude-opus-4-6', effort: 'low', thinkingBudget: 0 });
```

**`includeThoughts` — reasoning summaries:**

```typescript
// OpenAI Responses API: returns reasoning summaries
agent({ model: 'openai-responses:o3', effort: 'high', includeThoughts: true });

// Gemini: returns thought summaries
agent({ model: 'google:gemini-2.5-pro', effort: 'high', includeThoughts: true });
```

#### How `effort` maps to each provider

| Provider | `'none'` | `'low'` | `'medium'` | `'high'` | `'xhigh'` | `'max'` | `thinkingBudget: N` |
|----------|----------|---------|-----------|----------|-----------|---------|---------------------|
| **OpenAI** (o-series) | `'minimal'`⁑ | `reasoning_effort: 'low'` | `reasoning_effort: 'medium'` | `reasoning_effort: 'high'` | capped to `'high'`⁂ | capped to `'high'`⁂ | nearest effort level* |
| **OpenAI** (GPT-5.x pre-5.1) | `'minimal'`⁑ | `reasoning_effort: 'low'` | `reasoning_effort: 'medium'` | `reasoning_effort: 'high'` | capped to `'high'`⁂ | capped to `'high'`⁂ | nearest effort level* |
| **OpenAI** (GPT-5.1) | `reasoning_effort: 'none'` | `reasoning_effort: 'low'` | `reasoning_effort: 'medium'` | `reasoning_effort: 'high'` | capped to `'high'`⁂ | capped to `'high'`⁂ | nearest effort level* |
| **OpenAI** (GPT-5.2+ baseline) | `reasoning_effort: 'none'` | `reasoning_effort: 'low'` | `reasoning_effort: 'medium'` | `reasoning_effort: 'high'` | `reasoning_effort: 'xhigh'` | `reasoning_effort: 'xhigh'` | nearest effort level* |
| **OpenAI Chat** (GPT-5.6) | `reasoning_effort: 'none'` | `reasoning_effort: 'low'` | `reasoning_effort: 'medium'` | `reasoning_effort: 'high'` | `reasoning_effort: 'xhigh'` | capped to `'xhigh'` | nearest effort level* |
| **OpenAI Responses** (GPT-5.6) | `reasoning.effort: 'none'` | `reasoning.effort: 'low'` | `reasoning.effort: 'medium'` | `reasoning.effort: 'high'` | `reasoning.effort: 'xhigh'` | `reasoning.effort: 'max'` | nearest effort level* |
| **Anthropic** (Claude 5) | model-specific minimum/default | adaptive + `effort: 'low'` | adaptive + `effort: 'medium'` | adaptive + `effort: 'high'` | adaptive + `effort: 'xhigh'` | adaptive + `effort: 'max'` | unsupported |
| **Anthropic** (Opus 4.8 / 4.7) | disabled | adaptive + `effort: 'low'` | adaptive + `effort: 'medium'` | adaptive + `effort: 'high'` | adaptive + `effort: 'xhigh'` | adaptive + `effort: 'max'` | manual `budget_tokens` |
| **Anthropic** (4.6) | disabled | adaptive + `effort: 'low'` | adaptive + `effort: 'medium'` | adaptive + `effort: 'high'` | capped to `'high'`◊ | adaptive + `effort: 'max'`† | manual `budget_tokens` |
| **Anthropic** (4.5) | disabled | `output_config.effort: 'low'` | `output_config.effort: 'medium'` | `output_config.effort: 'high'` | capped to `'high'`◊ | capped to `'high'` | manual `budget_tokens` |
| **Anthropic** (older) | disabled | `budget_tokens: 1024` | `budget_tokens: 5000` | `budget_tokens: 10000` | `budget_tokens: 10000`◊ | `budget_tokens: 30000` | exact budget |
| **Gemini** (3.x) | model minimum‡ | `thinkingLevel: 'low'` | `thinkingLevel: 'medium'` | `thinkingLevel: 'high'` | `thinkingLevel: 'high'`◊ | `thinkingLevel: 'high'` | nearest `thinkingLevel` |
| **Gemini** (2.x) | `thinkingBudget: 0` | `thinkingBudget: 1024` | `thinkingBudget: 5000` | `thinkingBudget: 10000` | `thinkingBudget: 16384` | `thinkingBudget: 24576`§ | exact budget |
| **OpenRouter** | `reasoning: {enabled:false}` | `reasoning: {effort:'low'}` | `'medium'` | `'high'` | clamped to `'high'` | clamped to `'high'` | `reasoning: {max_tokens: N}` ✓ |
| **Azure OpenAI** | same as OpenAI (per deployment's underlying model) | | | | | | nearest effort* |
| **xAI** (Grok 4.5) | `'low'` + warning | `'low'` | `'medium'` | `'high'` | capped to `'high'` | capped to `'high'` | no-op◆ |
| **xAI** (Grok 4.3) | `'none'` | `'low'` | `'medium'` | `'high'` | capped to `'high'` | capped to `'high'` | no-op◆ |
| **xAI** (Grok 4.20 reasoning IDs) | omit | omit | omit | omit | omit | omit | no-op◆ |
| **xAI** (Grok 4.20 non-reasoning IDs) | omit | omit | omit | omit | omit | omit | no-op◆ |
| **DeepSeek** | model-driven⊕ | model-driven⊕ | model-driven⊕ | model-driven⊕ | model-driven⊕ | model-driven⊕ | no-op◆ |
| **Mistral** (small/medium) | omit | `reasoning_effort: 'high'`¶ | `'high'` | `'high'` | `'high'` | `'high'` | no-op◆ |
| **Groq** (gpt-oss) | omit | `reasoning_effort: 'low'` | `'medium'` | `'high'` | `'high'` | `'high'` | no-op◆ |
| **Bedrock** (gpt-oss) | omit | `reasoning_effort: 'low'` | `'medium'` | `'high'` | `'high'` | `'high'` | no-op◆ |
| **Self-hosted** (ollama/vllm/…) | deploy-time⊗ | deploy-time⊗ | deploy-time⊗ | deploy-time⊗ | deploy-time⊗ | deploy-time⊗ | no-op◆ |

¶ Mistral's supported reasoning vocabulary is narrower than Axl's, so multiple levels collapse. Models/families not listed **omit** `reasoning_effort` — `effort` is a documented no-op there, never an error.

◆ These presets don't accept an explicit token budget, and (unlike OpenAI) Axl does **not** translate `thinkingBudget` to a nearest effort for them — it is a no-op. Use `effort`, or `providerOptions` for provider-native budget params.

⊕ DeepSeek reasoning is determined by the exact V4 model choice; `effort` is a no-op. Captured reasoning round-trips on tool-call turns.

⊗ Reasoning on self-hosted runtimes is configured at the server (launch flags / `chat_template_kwargs`), so `effort` is generally a no-op; inline `<think>` output is captured.

† Anthropic `effort: 'max'` only supported on Opus 4.8, 4.7, and 4.6. On Sonnet 4.6 and Opus 4.5, capped to `'high'`.

◊ Anthropic `effort: 'xhigh'` is only supported on Opus 4.8 and 4.7 (positioned between `'high'` and `'max'`). On other Anthropic models and on Gemini 3.x, it clamps to `'high'`.

⁑ OpenAI pre-gpt-5.1 models (o-series, gpt-5, gpt-5-mini, gpt-5-nano) do not support `reasoning_effort: 'none'`. Axl clamps to `'minimal'` — the lowest supported value.

⁂ `reasoning_effort: 'xhigh'` is only supported on models after gpt-5.1-codex-max (gpt-5.2+). On earlier models, `effort: 'xhigh'` and `effort: 'max'` both clamp to `'high'`. Additionally, `gpt-5-pro` only supports `'high'` — all effort values are clamped to `'high'`.

‡ Gemini 3.x cannot fully disable thinking. `effort: 'none'` maps to the
model's minimum: `'minimal'` for most known models, and `'low'` for 3.1 Pro and
Gemini 3.7/3.8 Flash, which do not support `'minimal'`.

§ Gemini 2.5 Pro supports up to 32768; other 2.5 models cap at 24576.

\* OpenAI doesn't support explicit token budgets. `thinkingBudget` is mapped to nearest effort: ≤1024 → `low`, ≤8192 → `medium`, >8192 → `high`.

#### Seeing a clamp at runtime

Every clamp in the table above is reported, not silent. When the resolved
provider cannot honor the requested `effort`, the runtime emits one
`provider_diagnostic { kind: 'effort_clamped' }` event per ask — carrying
`requested`, the provider-native `effective` level, and a `cause` — plus a
deduped `console.warn`. Adapters expose this through the optional
`Provider.effortResolution()` capability; the runtime owns the event and the
warning, so a third-party adapter that omits the method simply reports nothing.

Currently reported: **Gemini 3.x** `'none'` (→ model minimum) and
`'xhigh'`/`'max'` (→ `'high'`); **OpenAI Chat Completions** `'max'` (→ `'xhigh'`),
pre-5.1 `'none'` (→ `'minimal'`), sub-5.2 `'xhigh'` (→ `'high'`), and
`gpt-5-pro` (always `'high'`); **OpenAI Responses** the same minus the `'max'`
cap; **Anthropic** any effort outside a model's supported `output_config.effort`
levels, and models that cannot disable thinking (`'none'` → adaptive `'low'`).
An explicit `thinkingBudget` documented to override `effort` is not a clamp.
See [observability.md#provider-diagnostics](observability.md#provider-diagnostics).

#### Provider-specific behavior

- **OpenAI o-series** (o1/o3/o4-mini): Uses `developer` role instead of `system`, strips temperature, sends `reasoning_effort`. `effort: 'none'` sends `reasoning_effort: 'minimal'` (o-series doesn't support `'none'`). `effort: 'max'` sends `'high'` (o-series doesn't support `'xhigh'`).
- **OpenAI GPT-5.x Chat Completions**: Uses `system`, strips temperature when reasoning is active, and supports parallel tool calls. The compatibility baseline maps GPT-5.2+ `'max'` to `'xhigh'`, reported through a `provider_diagnostic` event. Earlier families retain their lower caps.
- **OpenAI Responses API**: Uses `reasoning: { effort }`; exact GPT-5.6 IDs accept native `'max'` and omit `temperature` because that family rejects it even when reasoning uses the provider default. Older models keep their documented clamps. `includeThoughts: true` enables reasoning summaries (`reasoning: { summary: 'detailed' }`). Reasoning context is automatically round-tripped via `providerMetadata.openaiReasoningItems`.
- **Anthropic Claude 5**: Fable 5 always reasons; Opus 5 and Sonnet 5 reason by default. All three accept the full active effort vocabulary through adaptive thinking. Opaque thinking blocks are preserved in `providerMetadata` for tool continuations. Axl does not request beta fast-mode or model-fallback headers; if Anthropic reports that a different fallback model served the call, Axl fails before persisting history or estimating cost.
- **Anthropic Opus 4.8**: Supports adaptive thinking and native `'xhigh'`/`'max'`.
- **Anthropic Opus 4.7**: Same adaptive-thinking behavior as 4.6. Additionally supports `effort: 'xhigh'` as a first-class tier between `'high'` and `'max'`, sent as `output_config.effort: 'xhigh'`. Same pricing as Opus 4.6 ($5/$25 per 1M tokens).
- **Anthropic 4.6** (Opus 4.6, Sonnet 4.6): `effort` enables adaptive thinking (`thinking: { type: "adaptive" }` + `output_config: { effort }`). Temperature stripped when thinking active. `thinkingBudget: 0` + `effort` sends only `output_config.effort` (no thinking block, temperature allowed). `effort: 'xhigh'` clamps to `'high'` (4.6 doesn't expose a distinct xhigh tier).
- **Anthropic 4.5** (Opus 4.5): Supports `output_config.effort` but not adaptive thinking. Temperature passes through. `effort: 'xhigh'` clamps to `'high'`.
- **Anthropic older**: Falls back to manual thinking (`budget_tokens`). No `effort` support.
- **Anthropic + maxTokens**: Auto-bumps `max_tokens` when thinking budget exceeds it (`budget + 1024`).
- **Gemini 3.x**: Exact current IDs use `thinkingLevel` and cannot fully disable thinking; `effort: 'none'` maps to the model minimum. Gemini 3.6 Flash ignores the portable `temperature` field because that model no longer accepts it. Tool-call signature metadata is preserved and validated across continuations.
- **Gemini 2.x**: Uses integer `thinkingBudget`. Can be set to 0 to disable.
- **`includeThoughts`**: Returns thought/reasoning summaries. Works on Gemini (`includeThoughts` in `thinkingConfig`) and OpenAI Responses API (`reasoning.summary: 'detailed'`). No-op on Anthropic (thoughts always returned when thinking active) and OpenAI Chat Completions.

### Provider Support Matrix

| Parameter | OpenAI Chat | OpenAI Responses | Anthropic | Google Gemini |
|-----------|:-----------:|:----------------:|:---------:|:-------------:|
| `temperature` | ✅ (stripped for reasoning) | ✅ (stripped for reasoning) | ✅ (stripped when thinking active) | ✅ |
| `maxTokens` | ✅ | ✅ | ✅ | ✅ |
| `effort` | ✅ o-series + GPT-5.x | ✅ o-series + GPT-5.x | ✅ | ✅ |
| `thinkingBudget` | ✅ (mapped to effort) | ✅ (mapped to effort) | ✅ (exact budget) | ✅ |
| `includeThoughts` | ❌ | ✅ | ❌ (no-op) | ✅ |
| `toolChoice` | ✅ | ✅ | ✅ | ✅ |
| `stop` | ✅ | ❌ silently ignored | ✅ | ✅ |
| `providerOptions` | ✅ | ✅ | ✅ | ✅ |

### Structured output: prompt-guided (default) vs. native

By default `ctx.ask({ schema })` is **prompt-guided**: Axl appends a JSON-Schema
description to the prompt and validates the reply client-side with Zod. This is
portable across every provider and degrades gracefully. Two knobs tune it (spec
22, `docs/api-reference.md`):

- **`schemaPrompt`** — controls the model-facing rendering only (the Zod schema
  is still the parse gate): `'json-schema'` (default), `'none'` (append nothing —
  parse gate only), or `{ render }` (custom string/function). Use `'none'` +
  hand-tuned system guidance when you want the schema to contribute zero prompt
  tokens.
- **`nativeStructuredOutput: true`** — opt into the provider's *native*
  `json_schema` path. Axl derives the provider schema from the **same** Zod
  schema (you never supply a second, drift-prone JSON Schema). Support varies:

  | Provider | Native `json_schema` support | On opt-in |
  |---|---|---|
  | OpenAI Chat / Responses | ✅ accepts `json_schema` | used as-is (non-strict — see note) |
  | OpenAI-compatible | ✅ when the profile's `supportsJsonSchema` is true (may be **per-model** — e.g. Groq only `openai/gpt-oss-*`) | else **downgraded** to `json_object` |
  | Google Gemini | ⚠️ accepted but sanitized (`$ref`/`$defs`/… stripped) | **lossy** |
  | Anthropic | ❌ ignored structurally (system-prompt JSON instruction) | **unsupported** |

  The derived provider schema is rendered from the Zod schema's **input** side
  (what the model must emit — consistent with the prompt rendering), so
  `.transform()` schemas stay non-empty and `.default()`/`.optional()` fields
  aren't spuriously marked required.

  When the resolved provider can't fully honor it (downgraded / lossy /
  unsupported), Axl emits a `native_output_unsupported` `schema_diagnostic` and a
  one-time warning, then **proceeds** — the prompt text remains the parse contract
  (see [observability.md#schema-diagnostics](./observability.md#schema-diagnostics)).

  > **Note — non-strict on OpenAI.** Axl currently sends `json_schema` **without**
  > `strict: true`, so on OpenAI the schema is guidance rather than hard
  > constrained decoding. True strict mode requires transforming the schema into
  > OpenAI's strict subset (every property `required`, `additionalProperties:false`
  > everywhere) and is a planned follow-up. Client-side Zod validation is the
  > enforcement boundary either way.

**Why prompt-guided is the default (not native).** Native constrained decoding
caps schema depth and can degrade output quality on complex schemas (e.g. large
discriminated unions), and behavior differs sharply per provider. Prompt-guided
+ client-side Zod validation is the portable, predictable default; reach for
`nativeStructuredOutput` on simple, flat schemas where a provider you control
enforces it well.

### `providerOptions`

Provider-specific options merged directly into the raw API request body. Use this as an escape hatch for provider features that don't fit the unified API.

```typescript
const agent = agent({
  model: 'anthropic:claude-opus-4-6',
  system: 'You are helpful.',
  providerOptions: {
    // Sent directly to the Anthropic API body
    output_config: { effort: 'max' },
  },
});
```

`providerOptions` is spread **last** into the request body, so it can override any computed field. This is not portable across providers — use `effort`/`thinkingBudget`/`includeThoughts` for cross-provider behavior. Available on `AgentConfig` (agent-level default) and `AskOptions` (per-call override).

> **OpenAI-compatible presets — `forbiddenParams` precedence.** Some presets strip request
> params their provider rejects (e.g. `stop` on Grok-4 reasoning models). Stripping runs
> **after** the `providerOptions` merge but **exempts any key you set explicitly in
> `providerOptions`** — it only removes Axl's *computed* value. So re-introducing a forbidden
> param via `providerOptions` is honored ("you asked for it"), and may produce a provider
> error — that's on you, by design.

> **Warning: shallow merge.** `providerOptions` is applied via `Object.assign(body, providerOptions)`, which is a **shallow merge**. Nested objects in `providerOptions` will **replace** the corresponding top-level key entirely, not deep-merge with it.
>
> This matters most for **Google Gemini**, where the request body nests `temperature`, `maxOutputTokens`, and `thinkingConfig` inside a `generationConfig` object. If you pass `providerOptions: { generationConfig: { ... } }`, it will replace the entire `generationConfig` that Axl built — including thinking configuration, temperature, and max tokens.
>
> ```typescript
> // WRONG — replaces the entire generationConfig, losing thinkingConfig and temperature:
> agent({
>   model: 'google:gemini-2.5-pro',
>   effort: 'high',
>   temperature: 0.7,
>   providerOptions: {
>     generationConfig: { responseMimeType: 'application/json' },
>   },
> });
>
> // CORRECT — set top-level fields that don't collide with nested objects:
> agent({
>   model: 'google:gemini-2.5-pro',
>   effort: 'high',
>   temperature: 0.7,
>   providerOptions: {
>     safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
>   },
> });
> ```
>
> For **OpenAI** and **Anthropic**, most options are top-level keys in the request body, so shallow merge rarely causes issues. If you do need to override a nested Gemini field, include all sibling fields in your `generationConfig` to avoid losing Axl's computed values.

### `toolChoice`

Controls whether the model calls tools when tools are available:

| Value | Behavior |
|-------|----------|
| `'auto'` | The model decides whether to call a tool or respond with text. This is the default when tools are present. |
| `'none'` | The model must not call any tools, even if tools are available. Useful when you want a text-only response from an agent that normally has tools. |
| `'required'` | The model must call at least one tool. Useful when you know the next step requires a tool action. |
| `{ type: 'function', function: { name: 'search' } }` | The model must call this specific tool. Useful for forcing a particular action. |

```typescript
const coder = agent({
  model: 'openai-responses:gpt-5.6',
  system: 'You are a coding assistant.',
  tools: [runTests, writeCode],
});

// Force the agent to use a tool
const result = await ctx.ask(coder, 'Check if the code works', {
  toolChoice: 'required',
});

// Force text-only response (no tool calls)
const summary = await ctx.ask(coder, 'Summarize the results', {
  toolChoice: 'none',
});

// Force a specific tool
const tests = await ctx.ask(coder, 'Verify the fix', {
  toolChoice: { type: 'function', function: { name: 'runTests' } },
});
```

### `stop`

Stop sequences tell the model to stop generating when it produces any of the specified strings. The stop sequence itself is not included in the output. You can specify up to 4 stop sequences.

```typescript
const agent = agent({
  model: 'openai-responses:gpt-5.6',
  system: 'Generate markdown sections.',
  stop: ['\n---', '\n## '],  // stop at section breaks
});
```

**Provider support:** The `openai-responses` provider (`openai-responses:*`) does not support stop sequences — the OpenAI Responses API has no `stop` parameter. Axl silently ignores it for this provider. All other built-in providers (OpenAI Chat Completions, Anthropic, Google Gemini) support stop sequences.

## Cost Estimation

Axl tracks approximate USD cost for every LLM call and surfaces it via `ctx.budget()`, span attributes, and `ProviderResponse.cost`. Costs are **estimates for budget tracking**, not guaranteed to match your invoice — always check your provider's billing dashboard for exact figures.

### How it works

Each provider adapter maintains an exact pricing contract for the billing dimensions it can
observe. A simple cached-input call is computed as:

```
cost = (non_cached_input_tokens × input_rate)
     + (cached_input_tokens × input_rate × cache_multiplier)
     + (output_tokens × output_rate)
```

Structured estimators additionally handle long-context rates, service tiers, cache-write TTLs,
and effective returned model IDs. If a model or required billing dimension is unknown, cost is
`undefined` — **"unknown", never a misleading `0`**. A fake `$0` would let `ctx.budget()`
treat a paid model as free. OpenRouter and xAI prefer provider-reported totals; local runtimes
are the only built-ins that deliberately return zero.

Claude Sonnet 5 uses Anthropic's introductory rate through August 31, 2026, then switches to
the announced standard rate on September 1 without requiring an SDK update.

### Prompt caching rates

Providers charge less for tokens served from cache. The rates differ by provider and, for OpenAI, by model generation.

#### OpenAI — cache multipliers vary by model era

| Model era | Models | Cache multiplier |
|-----------|--------|-----------------|
| gpt-4o / o1 | `gpt-4o`, `gpt-4o-mini`, `o1`, `o1-mini`, `o1-pro` | **50%** of input rate |
| gpt-4.1 / o3 / o4 | `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, `o3`, `o3-mini`, `o3-pro`, `o4-mini` | **25%** of input rate |
| gpt-5 | `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, and exact known GPT-5.x IDs | model-specific |

Only documented snapshot forms inherit a base model's price. An arbitrary suffix does not.

#### Anthropic — observable cache-read and write TTLs

| Operation | Multiplier |
|-----------|-----------|
| Cache read (hit) | **10%** of input rate |
| Cache write — 5-minute TTL (default) | **125%** of input rate |
| Cache write — 1-hour TTL | **200%** of input rate |

Axl reads the 5-minute and 1-hour creation buckets when Anthropic provides them and prices
each at the correct multiplier. It also exposes their sum as `usage.cache_write_tokens`.
An aggregate-only cache-write count stays observable but makes `cost` undefined because its
TTL mix cannot be reconstructed safely.

#### Google Gemini — exact cached-input rates

Current known Gemini rows carry explicit cached-input rates. A separate per-hour storage fee
applies and is not reflected in Axl's per-call estimate. Non-Standard tiers and unmodeled
billable modalities/tools are left unpriced.

### Custom providers

Custom providers that implement the `Provider` interface return `cost` from `chat()` and `stream()`. Axl does not impose any pricing logic on custom providers — cost estimation is entirely up to the implementation.

## Custom Providers

Implement the `Provider` interface and register via `ProviderRegistry`:

```typescript
import type { Provider, ChatMessage, ChatOptions, ProviderResponse, StreamChunk } from '@axlsdk/axl';

class MyProvider implements Provider {
  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    // Your implementation
  }

  async *stream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    // Your implementation
  }
}
```

Register in config:

```typescript
import { AxlRuntime, defineConfig } from '@axlsdk/axl';

const runtime = new AxlRuntime(defineConfig({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY },
  },
}));

runtime.registerProvider('my-provider', new MyProvider());
// Now use: 'my-provider:model-name'
```

### Custom OpenAI-compatible preset (recommended for compatible endpoints)

If your endpoint speaks the OpenAI Chat Completions format, you don't need a hand-written
adapter — clone a `ProviderProfile` and let the generic engine do the work:

```typescript
import { OpenAICompatibleProvider, reasoningEffortEmit, type ProviderProfile } from '@axlsdk/axl';

const MY_PROFILE: ProviderProfile = {
  name: 'acme',
  label: 'Acme',
  defaultBaseUrl: 'https://api.acme.ai/v1',
  envApiKey: 'ACME_API_KEY',
  pricing: { kind: 'from-response' },        // or { kind: 'table', table }, 'zero', 'unknown'
  reasoning: {
    emit: reasoningEffortEmit((r) => r.activeEffort),
    capture: 'reasoning_content',             // 'reasoning' | 'reasoning_details' | 'think_tags' | 'none'
  },
  capabilities: { supportsJsonSchema: false },
};

runtime.registerProvider('acme', new OpenAICompatibleProvider({ profile: MY_PROFILE }));
// Now use: 'acme:some-model'
```

Profile fields cover auth header shape (`authHeader`), per-model quirks (`PerModel<T>` for
`forbiddenParams` / `supportsJsonSchema` / the reasoning emit), `allowMissingApiKey` (local
servers), `maxTokensField`, `parallelToolCalls`, and `requestDefaults`. See the built-in
presets in `packages/axl/src/providers/profiles/` for worked examples, and the
[API reference](./api-reference.md#provider-profiles) for the full type.

## Catalog maintenance

Review catalogs after provider announcements, before release, and at least monthly while a
frontier family is current:

- Use first-party model, API, pricing, lifecycle, and usage documentation. Record the review
  date and source beside each adapter table or profile.
- Add only documented IDs and snapshot formats. Keep unknown IDs pass-through but unpriced.
- Recheck every billed category, modifier, and effective-dated rate; missing billing data must
  remain unknown rather than becoming an inferred zero.
- Add unit fixtures, run both live integration gates, and save a dated result under
  `docs/verification/`, including any credential-gated gaps.

Recheck Claude Sonnet 5 on or before its September 1, 2026 price transition.
