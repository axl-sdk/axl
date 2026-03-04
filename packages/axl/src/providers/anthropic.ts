import type {
  Provider,
  ChatOptions,
  ChatMessage,
  ProviderResponse,
  StreamChunk,
  ToolDefinition,
  ToolCallMessage,
} from './types.js';
import { fetchWithRetry } from './retry.js';

const ANTHROPIC_API_VERSION = '2023-06-01';

// ---------------------------------------------------------------------------
// Approximate per-token pricing (USD) for common Anthropic models.
// Format: [inputCostPerToken, outputCostPerToken]
// These are rough estimates for budget tracking; not guaranteed to be exact.
// ---------------------------------------------------------------------------

const ANTHROPIC_PRICING: Record<string, [number, number]> = {
  'claude-opus-4-6': [15e-6, 75e-6],
  'claude-sonnet-4-5': [3e-6, 15e-6],
  'claude-haiku-4-5': [0.8e-6, 4e-6],
  'claude-sonnet-4': [3e-6, 15e-6],
  'claude-opus-4': [15e-6, 75e-6],
  'claude-3-7-sonnet': [3e-6, 15e-6],
  'claude-3-5-sonnet': [3e-6, 15e-6],
  'claude-3-5-haiku': [0.8e-6, 4e-6],
  'claude-3-opus': [15e-6, 75e-6],
  'claude-3-sonnet': [3e-6, 15e-6],
  'claude-3-haiku': [0.25e-6, 1.25e-6],
};

function estimateAnthropicCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens?: number,
  cacheWriteTokens?: number,
): number {
  // Try exact match first, then prefix match for versioned models
  let pricing = ANTHROPIC_PRICING[model];
  if (!pricing) {
    for (const [key, value] of Object.entries(ANTHROPIC_PRICING)) {
      if (model.startsWith(key)) {
        pricing = value;
        break;
      }
    }
  }
  if (!pricing) return 0;

  const [inputRate, outputRate] = pricing;
  const cacheRead = cacheReadTokens ?? 0;
  const cacheWrite = cacheWriteTokens ?? 0;
  // Anthropic cache reads cost 10% of base input rate, writes cost 125%
  const inputCost =
    (inputTokens - cacheRead - cacheWrite) * inputRate +
    cacheRead * inputRate * 0.1 +
    cacheWrite * inputRate * 1.25;
  return inputCost + outputTokens * outputRate;
}

/**
 * Anthropic provider using raw fetch (no SDK dependency).
 *
 * Supports:
 * - Chat completions via /v1/messages
 * - Tool calling (tool_use / tool_result content blocks)
 * - Streaming via SSE
 *
 * Message mapping:
 * - "system" role messages are extracted and sent as the top-level `system` param
 * - "tool" role messages are mapped to user messages with tool_result content blocks
 * - "assistant" messages with tool_calls are mapped to tool_use content blocks
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private baseUrl: string;
  private apiKey: string;
  private currentModel?: string;

  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');

    if (!this.apiKey) {
      throw new Error(
        'Anthropic API key is required. Set ANTHROPIC_API_KEY or pass apiKey in options.',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // chat - non-streaming completion
  // ---------------------------------------------------------------------------

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    this.currentModel = options.model;
    const body = this.buildRequestBody(messages, options, false);

    const res = await fetchWithRetry(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!res.ok) {
      const errorBody = await res.text();
      const message = this.extractErrorMessage(errorBody, res.status);
      throw new Error(message);
    }

    const json = (await res.json()) as AnthropicMessageResponse;
    return this.parseResponse(json);
  }

  // ---------------------------------------------------------------------------
  // stream - SSE streaming completion
  // ---------------------------------------------------------------------------

  async *stream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const body = this.buildRequestBody(messages, options, true);

    const res = await fetchWithRetry(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!res.ok) {
      const errorBody = await res.text();
      const message = this.extractErrorMessage(errorBody, res.status);
      throw new Error(message);
    }

    if (!res.body) {
      throw new Error('Anthropic stream response has no body');
    }

    yield* this.parseSSEStream(res.body);
  }

  // ---------------------------------------------------------------------------
  // Internal: request building
  // ---------------------------------------------------------------------------

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    };
  }

  /** Extract a human-readable message from an API error response body. */
  private extractErrorMessage(body: string, status: number): string {
    try {
      const json = JSON.parse(body) as { error?: { message?: string; type?: string } };
      if (json.error?.message) {
        return `Anthropic API error (${status}): ${json.error.message}`;
      }
    } catch {
      // Not JSON, use raw body
    }
    return `Anthropic API error (${status}): ${body}`;
  }

  private buildRequestBody(
    messages: ChatMessage[],
    options: ChatOptions,
    stream: boolean,
  ): Record<string, unknown> {
    // Extract system messages into a single system parameter
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const systemText = systemMessages.map((m) => m.content).join('\n\n');

    const body: Record<string, unknown> = {
      model: options.model,
      messages: this.mapMessages(nonSystemMessages),
      max_tokens: options.maxTokens ?? 4096,
      stream,
    };

    if (systemText) {
      body.system = systemText;
    }

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    if (options.stop) {
      body.stop_sequences = options.stop;
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => this.mapToolDefinition(t));
    }

    // Anthropic doesn't have a native JSON mode like OpenAI's json_object.
    // Instead, we append a system-level instruction requesting valid JSON output.
    if (options.responseFormat && options.responseFormat.type !== 'text') {
      const jsonInstruction =
        'You must respond with valid JSON only. No markdown fences, no extra text.';
      body.system = body.system ? `${body.system}\n\n${jsonInstruction}` : jsonInstruction;
    }

    return body;
  }

  /**
   * Map OpenAI-format ChatMessages to Anthropic message format.
   *
   * Key transformations:
   * - assistant messages with tool_calls -> assistant with tool_use content blocks
   * - tool messages (tool results) -> user messages with tool_result content blocks
   */
  private mapMessages(messages: ChatMessage[]): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Assistant message with tool calls
          const content: AnthropicContentBlock[] = [];

          // Include text content if present
          if (msg.content) {
            content.push({ type: 'text', text: msg.content });
          }

          // Map each tool call to a tool_use block
          for (const tc of msg.tool_calls) {
            let parsedArgs: unknown;
            try {
              parsedArgs = JSON.parse(tc.function.arguments);
            } catch {
              parsedArgs = {};
            }
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: parsedArgs,
            });
          }

          result.push({ role: 'assistant', content });
        } else {
          result.push({ role: 'assistant', content: msg.content });
        }
      } else if (msg.role === 'tool') {
        // Tool result messages become user messages with tool_result content blocks.
        // Anthropic requires tool results in a user-role message.
        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id!,
              content: msg.content,
            },
          ],
        });
      } else if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      }
      // system messages already handled at top level
    }

    // Anthropic requires alternating user/assistant turns.
    // Merge consecutive same-role messages if necessary.
    return this.mergeConsecutiveRoles(result);
  }

  /**
   * Merge consecutive messages with the same role into a single message.
   * This handles cases where multiple tool_result blocks need to be in one user message.
   */
  private mergeConsecutiveRoles(messages: AnthropicMessage[]): AnthropicMessage[] {
    if (messages.length === 0) return messages;

    const merged: AnthropicMessage[] = [messages[0]];

    for (let i = 1; i < messages.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = messages[i];

      if (prev.role === curr.role) {
        // Merge: convert both to content-block arrays and concatenate
        const prevBlocks = this.toContentBlocks(prev.content);
        const currBlocks = this.toContentBlocks(curr.content);
        prev.content = [...prevBlocks, ...currBlocks];
      } else {
        merged.push(curr);
      }
    }

    return merged;
  }

  private toContentBlocks(content: string | AnthropicContentBlock[]): AnthropicContentBlock[] {
    if (typeof content === 'string') {
      return [{ type: 'text', text: content }];
    }
    return content;
  }

  /**
   * Map an OpenAI-format ToolDefinition to Anthropic's tool format.
   */
  private mapToolDefinition(tool: ToolDefinition): AnthropicToolDef {
    return {
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters as Record<string, unknown>,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal: response parsing
  // ---------------------------------------------------------------------------

  private parseResponse(json: AnthropicMessageResponse): ProviderResponse {
    let content = '';
    const toolCalls: ToolCallMessage[] = [];

    for (const block of json.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    const cacheRead = json.usage?.cache_read_input_tokens ?? 0;
    const cacheWrite = json.usage?.cache_creation_input_tokens ?? 0;
    // Anthropic's input_tokens excludes cached tokens; total prompt is the sum of all three
    const totalInput = (json.usage?.input_tokens ?? 0) + cacheRead + cacheWrite;

    const usage = json.usage
      ? {
          prompt_tokens: totalInput,
          completion_tokens: json.usage.output_tokens,
          total_tokens: totalInput + json.usage.output_tokens,
          cached_tokens: cacheRead > 0 ? cacheRead : undefined,
        }
      : undefined;

    const cost = json.usage
      ? estimateAnthropicCost(
          this.currentModel ?? '',
          totalInput,
          json.usage.output_tokens,
          cacheRead,
          cacheWrite,
        )
      : undefined;

    return {
      content,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      cost,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal: SSE stream parsing
  // ---------------------------------------------------------------------------

  private async *parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Track current tool_use block being streamed
    let currentToolId = '';
    let currentToolName = '';
    let usage:
      | {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          cached_tokens?: number;
        }
      | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (!trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.slice(6);
          let event: AnthropicStreamEvent;
          try {
            event = JSON.parse(jsonStr) as AnthropicStreamEvent;
          } catch {
            continue;
          }

          switch (event.type) {
            case 'content_block_start': {
              const block = event.content_block;
              if (block?.type === 'tool_use') {
                currentToolId = block.id ?? '';
                currentToolName = block.name ?? '';
                // Emit the start of a tool call
                yield {
                  type: 'tool_call_delta',
                  id: currentToolId,
                  name: currentToolName,
                  arguments: '',
                };
              }
              break;
            }

            case 'content_block_delta': {
              const delta = event.delta;
              if (delta?.type === 'text_delta' && delta.text) {
                yield { type: 'text_delta', content: delta.text };
              } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
                yield {
                  type: 'tool_call_delta',
                  id: currentToolId,
                  arguments: delta.partial_json,
                };
              }
              break;
            }

            case 'content_block_stop': {
              // Reset tool tracking
              currentToolId = '';
              currentToolName = '';
              break;
            }

            case 'message_start': {
              // message_start arrives first in the SSE stream with input token counts
              if (event.message?.usage) {
                const cacheRead = event.message.usage.cache_read_input_tokens ?? 0;
                const cacheWrite = event.message.usage.cache_creation_input_tokens ?? 0;
                const inputTokens =
                  (event.message.usage.input_tokens ?? 0) + cacheRead + cacheWrite;
                usage = {
                  prompt_tokens: inputTokens,
                  completion_tokens: 0,
                  total_tokens: inputTokens,
                  cached_tokens: cacheRead > 0 ? cacheRead : undefined,
                };
              }
              break;
            }

            case 'message_delta': {
              // message_delta arrives near the end with output token counts
              if (event.usage) {
                const outputTokens = event.usage.output_tokens ?? 0;
                if (usage) {
                  usage.completion_tokens = outputTokens;
                  usage.total_tokens = usage.prompt_tokens + outputTokens;
                } else {
                  usage = {
                    prompt_tokens: 0,
                    completion_tokens: outputTokens,
                    total_tokens: outputTokens,
                  };
                }
              }
              break;
            }

            case 'message_stop': {
              // Finalize usage totals
              if (usage) {
                usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
              }
              yield { type: 'done', usage };
              return;
            }
          }
        }
      }

      // If we exit without a message_stop, still emit done
      yield { type: 'done', usage };
    } finally {
      reader.releaseLock();
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic API types (internal)
// ---------------------------------------------------------------------------

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

type AnthropicToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

type AnthropicMessageResponse = {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<
    { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

type AnthropicStreamEvent = {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop'
    | 'ping';
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content_block?: {
    type?: 'text' | 'tool_use';
    id?: string;
    name?: string;
    text?: string;
  };
  delta?: {
    type?: 'text_delta' | 'input_json_delta';
    text?: string;
    partial_json?: string;
  };
  usage?: {
    output_tokens?: number;
  };
};
