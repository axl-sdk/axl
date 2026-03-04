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

Set `temperature` on the agent definition to control response randomness:

```typescript
const creative = agent({
  model: 'openai:gpt-4o',
  system: 'Write creative stories.',
  temperature: 0.9,   // higher = more creative (0.0–2.0)
});

const precise = agent({
  model: 'openai:gpt-4o',
  system: 'Extract structured data.',
  temperature: 0.1,   // lower = more deterministic
});
```

All provider calls use a `ChatOptions` object internally. Currently, `temperature` is the only parameter configurable from userland. Other fields (`maxTokens`, `reasoningEffort`, `toolChoice`, `stop`) exist on the `ChatOptions` type for custom provider implementations but are not yet exposed on `AgentConfig` or `AskOptions`.

| Parameter | Status | Description |
|-----------|--------|-------------|
| `temperature` | Configurable via `agent({ temperature })` | Controls randomness (0.0–2.0). Stripped automatically for reasoning models. |
| `maxTokens` | Hardcoded (4096) | Maximum completion tokens per call. |
| `reasoningEffort` | On `ChatOptions` type, not yet wired | `'low'` \| `'medium'` \| `'high'` for reasoning models (o1/o3/o4-mini). |
| `toolChoice` | On `ChatOptions` type, not yet wired | `'auto'` \| `'none'` \| `'required'` \| specific function. |
| `stop` | On `ChatOptions` type, not yet wired | Stop sequences. |

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
