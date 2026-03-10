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

Reasoning model support (o1/o3/o4-mini): uses `developer` role instead of `system`, strips `temperature`, supports `reasoningEffort` option.

## OpenAI — Responses API

```
openai-responses:gpt-4o
openai-responses:o3
```

Same models as Chat Completions, with better prompt caching and native reasoning support. Shares the `openai` provider config by default.

## Anthropic

```
anthropic:claude-opus-4-6       # Most capable
anthropic:claude-sonnet-4-5     # Balanced
anthropic:claude-haiku-4-5      # Fast and affordable
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
  model: 'anthropic:claude-sonnet-4-5',
  system: 'Solve complex problems step by step.',
  thinking: 'high',   // works across all providers
});

const precise = agent({
  model: 'openai:gpt-4o',
  system: 'Extract structured data.',
  temperature: 0.1,   // lower = more deterministic
  toolChoice: 'required',
});

// Per-call overrides
const answer = await ctx.ask(creative, prompt, { temperature: 0.2, maxTokens: 2048 });
const solution = await ctx.ask(reasoner, problem, { thinking: 'low' });
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `temperature` | provider default | Controls randomness (0.0–2.0). Stripped automatically for reasoning models. |
| `maxTokens` | `4096` | Maximum completion tokens per call. |
| `thinking` | — | Thinking/reasoning level — works across all providers (see below). |
| `reasoningEffort` | — | OpenAI-specific reasoning effort escape hatch. Prefer `thinking`. |
| `toolChoice` | — | Controls whether and how the model uses tools (see below). |
| `stop` | — | Stop sequences — generation stops when any sequence is encountered (see below). |

### `thinking`

The `thinking` parameter provides a unified way to control extended thinking / reasoning across all providers. You don't need to know the provider-specific API — just set the level and Axl handles the rest.

**Simple form** — portable across all providers:

```typescript
const reasoner = agent({
  model: 'anthropic:claude-sonnet-4-5',
  system: 'Solve complex math problems.',
  thinking: 'high',   // 'low' | 'medium' | 'high' | 'max'
});

// Per-call override
const answer = await ctx.ask(reasoner, problem, { thinking: 'low' });
```

**Budget form** — explicit control over thinking tokens:

```typescript
const answer = await ctx.ask(reasoner, problem, {
  thinking: { budgetTokens: 8000 },
});
```

#### How `thinking` maps to each provider

| Provider | `'low'` | `'medium'` | `'high'` | `'max'` | `{ budgetTokens: N }` |
|----------|---------|-----------|----------|---------|----------------------|
| **OpenAI** (o1/o3/o4-mini) | `reasoning_effort: 'low'` | `reasoning_effort: 'medium'` | `reasoning_effort: 'high'` | `reasoning_effort: 'xhigh'` | nearest effort level* |
| **OpenAI Responses** | `reasoning.effort: 'low'` | `reasoning.effort: 'medium'` | `reasoning.effort: 'high'` | `reasoning.effort: 'xhigh'` | nearest effort level* |
| **Anthropic** (4.6) | adaptive + `effort: 'low'` | adaptive + `effort: 'medium'` | adaptive + `effort: 'high'` | adaptive + `effort: 'max'`† | manual `budget_tokens` |
| **Anthropic** (older) | `thinking.budget_tokens: 1024` | `thinking.budget_tokens: 5000` | `thinking.budget_tokens: 10000` | `thinking.budget_tokens: 30000` | exact budget |
| **Gemini** (2.5+) | `thinkingConfig.thinkingBudget: 1024` | `thinkingConfig.thinkingBudget: 5000` | `thinkingConfig.thinkingBudget: 10000` | `thinkingConfig.thinkingBudget: 24576` | exact budget |

† Anthropic `effort: 'max'` is only supported on Opus 4.6. On Sonnet 4.6, `thinking: 'max'` automatically falls back to manual mode with `budget_tokens: 30000`. The budget values for `'max'` (30000 for Anthropic, 24576 for Gemini) are sensible defaults, not hard provider limits. For the absolute maximum your model supports, use `{ budgetTokens: N }` with the model's actual limit.

\* OpenAI does not support explicit token budgets for reasoning. The budget form `{ budgetTokens: N }` is mapped to the nearest effort level: ≤1024 → `low`, ≤8192 → `medium`, >8192 → `high`. Note: budget form never maps to `'xhigh'` — use `thinking: 'max'` explicitly for maximum reasoning effort. For precise token budget control, use Anthropic or Gemini.

#### Provider-specific behavior

- **Non-reasoning OpenAI models** (gpt-4o, gpt-4.1, etc.): `thinking` is silently ignored. It only applies to reasoning models (o1/o3/o4-mini).
- **Anthropic 4.6 models** (Opus 4.6, Sonnet 4.6): String levels use adaptive thinking mode (`thinking: { type: "adaptive" }` + `output_config: { effort }`), which lets Claude dynamically allocate thinking depth. `'max'` is natively supported in adaptive mode (Opus 4.6 only). Budget form `{ budgetTokens: N }` falls back to manual mode with explicit `budget_tokens` for precise control. Adaptive mode also automatically enables interleaved thinking (thinking between tool calls).
- **Anthropic older models** (Sonnet 4.5, Opus 4.5, Haiku 4.5, etc.): Always use manual mode (`thinking: { type: "enabled", budget_tokens: N }`).
- **Anthropic + `temperature`**: Anthropic rejects `temperature` when extended thinking is enabled. Axl automatically strips `temperature` when `thinking` is set (same pattern as OpenAI stripping temperature for reasoning models).
- **Anthropic + `maxTokens`**: Anthropic requires `max_tokens ≥ budget_tokens`. When your `maxTokens` (default: 4096) is too low for the thinking budget, Axl auto-bumps it to `budget_tokens + 1024`. For example, `thinking: 'high'` (budget 10000) with default `maxTokens` results in `max_tokens: 11024` being sent to the API.

#### `reasoningEffort` (advanced)

`reasoningEffort` is an OpenAI-specific escape hatch that supports all 6 granular values: `'none'` \| `'minimal'` \| `'low'` \| `'medium'` \| `'high'` \| `'xhigh'`. It only works with OpenAI reasoning models (o1/o3/o4-mini). If both `thinking` and `reasoningEffort` are set, `thinking` takes precedence.

### Provider Support Matrix

| Parameter | OpenAI Chat | OpenAI Responses | Anthropic | Google Gemini |
|-----------|:-----------:|:----------------:|:---------:|:-------------:|
| `temperature` | ✅ (stripped for reasoning models) | ✅ (stripped for reasoning models) | ✅ (stripped when `thinking` set) | ✅ |
| `maxTokens` | ✅ | ✅ | ✅ | ✅ |
| `thinking` | ✅ reasoning models only | ✅ reasoning models only | ✅ | ✅ |
| `reasoningEffort` | ✅ all 6 values | ✅ all 6 values | ❌ | ❌ |
| `toolChoice` | ✅ | ✅ | ✅ | ✅ |
| `stop` | ✅ | ❌ silently ignored | ✅ | ✅ |

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
