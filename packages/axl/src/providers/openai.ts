import type { Provider, ChatOptions, ChatMessage, ProviderResponse, StreamChunk } from './types.js';
import { fetchWithRetry } from './retry.js';

// ---------------------------------------------------------------------------
// Approximate per-token pricing (USD) for common OpenAI models.
// Format: [promptCostPerToken, completionCostPerToken]
// These are approximations for budget estimation, not billing.
// Actual pricing may differ; check OpenAI's pricing page for current rates.
// ---------------------------------------------------------------------------

export const OPENAI_PRICING: Record<string, [number, number]> = {
  'gpt-4o': [2.5e-6, 10e-6],
  'gpt-4o-mini': [0.15e-6, 0.6e-6],
  'gpt-4-turbo': [10e-6, 30e-6],
  'gpt-4': [30e-6, 60e-6],
  'gpt-3.5-turbo': [0.5e-6, 1.5e-6],
  'gpt-5': [1.25e-6, 10e-6],
  'gpt-5-mini': [0.25e-6, 2e-6],
  'gpt-5-nano': [0.05e-6, 0.4e-6],
  'gpt-5.1': [1.25e-6, 10e-6],
  'gpt-5.2': [1.75e-6, 14e-6],
  o1: [15e-6, 60e-6],
  'o1-mini': [3e-6, 12e-6],
  'o1-pro': [150e-6, 600e-6],
  o3: [10e-6, 40e-6],
  'o3-mini': [1.1e-6, 4.4e-6],
  'o3-pro': [20e-6, 80e-6],
  'o4-mini': [1.1e-6, 4.4e-6],
  'gpt-4.1': [2e-6, 8e-6],
  'gpt-4.1-mini': [0.4e-6, 1.6e-6],
  'gpt-4.1-nano': [0.1e-6, 0.4e-6],
};

// Pre-sorted keys for prefix matching (longest first so "gpt-5-mini" matches before "gpt-5")
const PRICING_KEYS_BY_LENGTH = Object.keys(OPENAI_PRICING).sort((a, b) => b.length - a.length);

export function estimateOpenAICost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens?: number,
): number {
  // Try exact match first, then longest-prefix match for versioned models (e.g. gpt-4o-2024-05-13)
  let pricing = OPENAI_PRICING[model];
  if (!pricing) {
    for (const key of PRICING_KEYS_BY_LENGTH) {
      if (model.startsWith(key)) {
        pricing = OPENAI_PRICING[key];
        break;
      }
    }
  }
  if (!pricing) return 0;

  const [inputRate, outputRate] = pricing;
  const cached = cachedTokens ?? 0;
  // OpenAI charges 50% of input rate for cached tokens
  const inputCost = (promptTokens - cached) * inputRate + cached * inputRate * 0.5;
  return inputCost + completionTokens * outputRate;
}

/** Returns true for reasoning models (o1, o3, o4-mini) that require special handling. */
export function isReasoningModel(model: string): boolean {
  return /^(o1|o3|o4-mini)/.test(model);
}

/**
 * OpenAI-compatible provider using raw fetch (no SDK dependency).
 *
 * Supports:
 * - Chat completions
 * - Tool calling
 * - Streaming via SSE
 * - Structured output via response_format (JSON mode / JSON schema)
 * - Reasoning models (o1/o3/o4-mini) with developer role and reasoning_effort
 */
export class OpenAIProvider implements Provider {
  readonly name = 'openai';
  private baseUrl: string;
  private apiKey: string;

  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (
      options.baseUrl ??
      process.env.OPENAI_BASE_URL ??
      'https://api.openai.com/v1'
    ).replace(/\/$/, '');

    if (!this.apiKey) {
      throw new Error('OpenAI API key is required. Set OPENAI_API_KEY or pass apiKey in options.');
    }
  }

  // ---------------------------------------------------------------------------
  // chat - non-streaming completion
  // ---------------------------------------------------------------------------

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    const body = this.buildRequestBody(messages, options, false);

    const res = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!res.ok) {
      const errorBody = await res.text();
      const message = this.extractErrorMessage(errorBody, res.status);
      throw new Error(message);
    }

    const json = (await res.json()) as OpenAIChatResponse;
    const choice = json.choices[0];

    const usage = json.usage
      ? {
          prompt_tokens: json.usage.prompt_tokens,
          completion_tokens: json.usage.completion_tokens,
          total_tokens: json.usage.total_tokens,
          reasoning_tokens: json.usage.completion_tokens_details?.reasoning_tokens,
          cached_tokens: json.usage.prompt_tokens_details?.cached_tokens,
        }
      : undefined;

    const cost = usage
      ? estimateOpenAICost(
          options.model,
          usage.prompt_tokens,
          usage.completion_tokens,
          usage.cached_tokens,
        )
      : undefined;

    return {
      content: choice.message.content ?? '',
      tool_calls: choice.message.tool_calls?.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
      usage,
      cost,
    };
  }

  // ---------------------------------------------------------------------------
  // stream - SSE streaming completion
  // ---------------------------------------------------------------------------

  async *stream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const body = this.buildRequestBody(messages, options, true);

    const res = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!res.ok) {
      const errorBody = await res.text();
      const message = this.extractErrorMessage(errorBody, res.status);
      throw new Error(message);
    }

    if (!res.body) {
      throw new Error('OpenAI stream response has no body');
    }

    yield* this.parseSSEStream(res.body);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private buildRequestBody(
    messages: ChatMessage[],
    options: ChatOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const reasoning = isReasoningModel(options.model);

    const body: Record<string, unknown> = {
      model: options.model,
      messages: messages.map((m) => this.formatMessage(m, reasoning)),
      stream,
    };

    // Reasoning models reject temperature; only pass for non-reasoning models
    if (options.temperature !== undefined && !reasoning) {
      body.temperature = options.temperature;
    }

    // Use max_completion_tokens instead of deprecated max_tokens
    if (options.maxTokens !== undefined) {
      body.max_completion_tokens = options.maxTokens;
    }

    if (options.stop) body.stop = options.stop;

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.parallel_tool_calls = true;
    }

    if (options.toolChoice !== undefined) {
      body.tool_choice = options.toolChoice;
    }

    if (options.responseFormat) {
      body.response_format = options.responseFormat;
    }

    if (options.reasoningEffort) {
      body.reasoning_effort = options.reasoningEffort;
    }

    if (stream) {
      body.stream_options = { include_usage: true };
    }

    return body;
  }

  /** Extract a human-readable message from an API error response body. */
  private extractErrorMessage(body: string, status: number): string {
    try {
      const json = JSON.parse(body) as { error?: { message?: string; type?: string } };
      if (json.error?.message) {
        return `OpenAI API error (${status}): ${json.error.message}`;
      }
    } catch {
      // Not JSON, use raw body
    }
    return `OpenAI API error (${status}): ${body}`;
  }

  private formatMessage(msg: ChatMessage, reasoning: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {
      role: msg.role === 'system' && reasoning ? 'developer' : msg.role,
      content: msg.content,
    };
    if (msg.name) out.name = msg.name;
    if (msg.tool_calls) out.tool_calls = msg.tool_calls;
    if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
    return out;
  }

  private async *parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usageData:
      | {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          reasoning_tokens?: number;
          cached_tokens?: number;
        }
      | undefined;

    // Map tool call index -> id, so we can associate streamed deltas that
    // arrive before the id field with the correct tool call once the id appears.
    const indexToId = new Map<number, string>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last potentially-incomplete line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed === 'data: [DONE]') {
            yield { type: 'done', usage: usageData };
            return;
          }

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            let parsed: OpenAIStreamChunk;
            try {
              parsed = JSON.parse(jsonStr) as OpenAIStreamChunk;
            } catch {
              continue; // Skip malformed JSON
            }

            // Capture usage from the final chunk if present
            if (parsed.usage) {
              usageData = {
                prompt_tokens: parsed.usage.prompt_tokens,
                completion_tokens: parsed.usage.completion_tokens,
                total_tokens: parsed.usage.total_tokens,
                reasoning_tokens: parsed.usage.completion_tokens_details?.reasoning_tokens,
                cached_tokens: parsed.usage.prompt_tokens_details?.cached_tokens,
              };
              continue;
            }

            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            // Text content
            if (delta.content) {
              yield { type: 'text_delta', content: delta.content };
            }

            // Tool call deltas
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                // Track id by index so subsequent deltas without an id
                // map to the correct tool call
                if (tc.id) {
                  indexToId.set(tc.index, tc.id);
                }
                const id = indexToId.get(tc.index) ?? `__pending_${tc.index}`;
                yield {
                  type: 'tool_call_delta',
                  id,
                  name: tc.function?.name,
                  arguments: tc.function?.arguments,
                };
              }
            }
          }
        }
      }

      // If we exit the loop without a [DONE], still emit done with whatever usage we have
      yield { type: 'done', usage: usageData };
    } finally {
      reader.releaseLock();
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI API response types (internal)
// ---------------------------------------------------------------------------

type OpenAIChatResponse = {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
};

type OpenAIStreamChunk = {
  choices?: Array<{
    delta: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
};
