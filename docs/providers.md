# Provider URI Reference

Agents reference models using the `provider:model` URI scheme. Four built-in providers are supported, all using raw `fetch` with zero SDK dependencies.

All providers include automatic retry with exponential backoff on `429` (rate limit), `503` (service unavailable), and `529` (overloaded) responses.

## OpenAI — Chat Completions API

```
openai:gpt-4o                   # Flagship multimodal
openai:gpt-4o-mini              # Fast and affordable
openai:gpt-4.1                  # GPT-4.1
openai:gpt-4.1-mini             # GPT-4.1 small
openai:gpt-4.1-nano             # GPT-4.1 cheapest
openai:gpt-5                    # GPT-5
openai:gpt-5-mini               # GPT-5 small
openai:gpt-5-nano               # GPT-5 cheapest
openai:gpt-5.1                  # GPT-5.1
openai:gpt-5.2                  # GPT-5.2
openai:gpt-5.3                  # GPT-5.3
openai:gpt-5.4                  # GPT-5.4
openai:gpt-5.4-pro              # GPT-5.4 (pro)
openai:o1                       # Reasoning
openai:o1-mini                  # Reasoning (small)
openai:o1-pro                   # Reasoning (pro)
openai:o3                       # Reasoning
openai:o3-mini                  # Reasoning (small)
openai:o3-pro                   # Reasoning (pro)
openai:o4-mini                  # Reasoning (small)
openai:gpt-4-turbo              # Legacy
openai:gpt-4                    # Legacy
openai:gpt-3.5-turbo            # Legacy
```

Reasoning model support (o1/o3/o4-mini): uses `developer` role instead of `system`, strips `temperature`, supports `effort` option. GPT-5.x models also support `effort` (reasoning) but use `system` role.

## OpenAI — Responses API

```
openai-responses:gpt-4o
openai-responses:o3
```

Same models as Chat Completions, with better prompt caching, native reasoning support, and automatic reasoning context round-tripping via `providerMetadata`. Shares the `openai` provider config by default.

## Anthropic

```
anthropic:claude-opus-4-6       # Most capable
anthropic:claude-sonnet-4-6     # Balanced (latest)
anthropic:claude-sonnet-4-5     # Balanced
anthropic:claude-haiku-4-5      # Fast and affordable
anthropic:claude-opus-4-5       # Previous gen (most capable)
anthropic:claude-opus-4-1       # Previous gen
anthropic:claude-sonnet-4       # Previous gen
anthropic:claude-opus-4         # Previous gen
anthropic:claude-3-7-sonnet     # Legacy
anthropic:claude-3-5-sonnet     # Legacy
anthropic:claude-3-5-haiku      # Legacy
anthropic:claude-3-opus         # Legacy
anthropic:claude-3-sonnet       # Legacy
anthropic:claude-3-haiku        # Legacy
```

## Google Gemini

```
google:gemini-2.5-pro           # Most capable
google:gemini-2.5-flash         # Fast
google:gemini-2.5-flash-lite    # Cheapest 2.5
google:gemini-2.0-flash         # Previous gen
google:gemini-2.0-flash-lite    # Previous gen (lite)
google:gemini-3-flash            # Fast (3.x gen)
google:gemini-3.1-pro            # Most capable (3.x gen)
google:gemini-3.1-flash-lite     # Cheapest (3.x gen)
google:gemini-3-pro-preview     # Next gen (preview)
google:gemini-3-flash-preview   # Next gen fast (preview)
```

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

## Model Parameters

All model parameters are configurable on `AgentConfig` (agent-level defaults) and overridable per-call via `AskOptions`. Precedence: `AskOptions` > `AgentConfig` > internal defaults.

```typescript
const creative = agent({
  model: 'openai:gpt-4o',
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
  model: 'openai:gpt-4o',
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

The `effort` parameter provides a unified way to control reasoning depth across all providers. Values: `'none'` | `'low'` | `'medium'` | `'high'` | `'max'`.

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

| Provider | `'none'` | `'low'` | `'medium'` | `'high'` | `'max'` | `thinkingBudget: N` |
|----------|----------|---------|-----------|----------|---------|---------------------|
| **OpenAI** (o-series) | `'minimal'`⁑ | `reasoning_effort: 'low'` | `reasoning_effort: 'medium'` | `reasoning_effort: 'high'` | capped to `'high'`⁂ | nearest effort level* |
| **OpenAI** (GPT-5.x pre-5.1) | `'minimal'`⁑ | `reasoning_effort: 'low'` | `reasoning_effort: 'medium'` | `reasoning_effort: 'high'` | capped to `'high'`⁂ | nearest effort level* |
| **OpenAI** (GPT-5.1+) | `reasoning_effort: 'none'` | `reasoning_effort: 'low'` | `reasoning_effort: 'medium'` | `reasoning_effort: 'high'` | capped to `'high'`⁂ | nearest effort level* |
| **OpenAI** (GPT-5.2+) | `reasoning_effort: 'none'` | `reasoning_effort: 'low'` | `reasoning_effort: 'medium'` | `reasoning_effort: 'high'` | `reasoning_effort: 'xhigh'` | nearest effort level* |
| **OpenAI Responses** | same clamping as above | `reasoning.effort: 'low'` | `reasoning.effort: 'medium'` | `reasoning.effort: 'high'` | same clamping | nearest effort level* |
| **Anthropic** (4.6) | disabled | adaptive + `effort: 'low'` | adaptive + `effort: 'medium'` | adaptive + `effort: 'high'` | adaptive + `effort: 'max'`† | manual `budget_tokens` |
| **Anthropic** (4.5) | disabled | `output_config.effort: 'low'` | `output_config.effort: 'medium'` | `output_config.effort: 'high'` | capped to `'high'` | manual `budget_tokens` |
| **Anthropic** (older) | disabled | `budget_tokens: 1024` | `budget_tokens: 5000` | `budget_tokens: 10000` | `budget_tokens: 30000` | exact budget |
| **Gemini** (3.x) | model minimum‡ | `thinkingLevel: 'low'` | `thinkingLevel: 'medium'` | `thinkingLevel: 'high'` | `thinkingLevel: 'high'` | nearest `thinkingLevel` |
| **Gemini** (2.x) | `thinkingBudget: 0` | `thinkingBudget: 1024` | `thinkingBudget: 5000` | `thinkingBudget: 10000` | `thinkingBudget: 24576`§ | exact budget |

† Anthropic `effort: 'max'` only supported on Opus 4.6. On Sonnet 4.6 and Opus 4.5, capped to `'high'`.

⁑ OpenAI pre-gpt-5.1 models (o-series, gpt-5, gpt-5-mini, gpt-5-nano) do not support `reasoning_effort: 'none'`. Axl clamps to `'minimal'` — the lowest supported value.

⁂ `reasoning_effort: 'xhigh'` is only supported on models after gpt-5.1-codex-max (gpt-5.2+). On earlier models, `effort: 'max'` is clamped to `'high'`. Additionally, `gpt-5-pro` only supports `'high'` — all effort values are clamped to `'high'`.

‡ Gemini 3.x cannot fully disable thinking. `effort: 'none'` maps to the model's minimum: `'minimal'` for most models, `'low'` for 3.1 Pro (which doesn't support `'minimal'`).

§ Gemini 2.5 Pro supports up to 32768; other 2.5 models cap at 24576.

\* OpenAI doesn't support explicit token budgets. `thinkingBudget` is mapped to nearest effort: ≤1024 → `low`, ≤8192 → `medium`, >8192 → `high`.

#### Provider-specific behavior

- **OpenAI o-series** (o1/o3/o4-mini): Uses `developer` role instead of `system`, strips temperature, sends `reasoning_effort`. `effort: 'none'` sends `reasoning_effort: 'minimal'` (o-series doesn't support `'none'`). `effort: 'max'` sends `'high'` (o-series doesn't support `'xhigh'`).
- **OpenAI GPT-5.x**: Supports `reasoning_effort` like o-series, strips temperature when reasoning active. Uses `system` role (not `developer`). Supports parallel tool calls. Model-specific constraints: `gpt-5-pro` only supports `'high'`; `gpt-5.1+` supports `'none'`; `gpt-5.2+` supports `'xhigh'`.
- **OpenAI Responses API**: Same effort mapping via `reasoning: { effort }`. `includeThoughts: true` enables reasoning summaries (`reasoning: { summary: 'detailed' }`). Reasoning context is automatically round-tripped via `providerMetadata.openaiReasoningItems`.
- **Anthropic 4.6** (Opus 4.6, Sonnet 4.6): `effort` enables adaptive thinking (`thinking: { type: "adaptive" }` + `output_config: { effort }`). Temperature stripped when thinking active. `thinkingBudget: 0` + `effort` sends only `output_config.effort` (no thinking block, temperature allowed).
- **Anthropic 4.5** (Opus 4.5): Supports `output_config.effort` but not adaptive thinking. Temperature passes through.
- **Anthropic older**: Falls back to manual thinking (`budget_tokens`). No `effort` support.
- **Anthropic + maxTokens**: Auto-bumps `max_tokens` when thinking budget exceeds it (`budget + 1024`).
- **Gemini 3.x** (gemini-3-*, gemini-3.1-*): Uses `thinkingLevel` string enum. **Cannot fully disable thinking** — `effort: 'none'` maps to the model's minimum level (`'minimal'` for most models, `'low'` for 3.1 Pro). Axl emits a one-time console warning when this happens. `thinkingBudget: N` maps to nearest level (≤1024→low, ≤5000→medium, >5000→high).
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
  model: 'openai:gpt-4o',
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
  model: 'openai:gpt-4o',
  system: 'Generate markdown sections.',
  stop: ['\n---', '\n## '],  // stop at section breaks
});
```

**Provider support:** The `openai-responses` provider (`openai-responses:*`) does not support stop sequences — the OpenAI Responses API has no `stop` parameter. Axl silently ignores it for this provider. All other built-in providers (OpenAI Chat Completions, Anthropic, Google Gemini) support stop sequences.

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
const runtime = new AxlRuntime();
runtime.registerProvider('my-provider', new MyProvider());
// Now use: 'my-provider:model-name'
```
