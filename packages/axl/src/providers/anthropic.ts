import type {
  Provider,
  ChatOptions,
  ChatMessage,
  ProviderResponse,
  StreamChunk,
  ToolDefinition,
  ToolCallMessage,
} from './types.js';
import { resolveThinkingOptions } from './types.js';
import { fetchWithRetry } from './retry.js';

const ANTHROPIC_API_VERSION = '2023-06-01';

// ---------------------------------------------------------------------------
// Approximate per-token pricing (USD) for common Anthropic models.
// Format: [inputCostPerToken, outputCostPerToken]
// These are rough estimates for budget tracking; not guaranteed to be exact.
// ---------------------------------------------------------------------------

const ANTHROPIC_PRICING: Record<string, [number, number]> = {
  'claude-opus-4-6': [5e-6, 25e-6],
  'claude-sonnet-4-6': [3e-6, 15e-6],
  'claude-opus-4-5': [5e-6, 25e-6],
  'claude-opus-4-1': [15e-6, 75e-6],
  'claude-sonnet-4-5': [3e-6, 15e-6],
  'claude-haiku-4-5': [1e-6, 5e-6],
  'claude-sonnet-4': [3e-6, 15e-6],
  'claude-opus-4': [15e-6, 75e-6],
  'claude-3-7-sonnet': [3e-6, 15e-6],
  'claude-3-5-sonnet': [3e-6, 15e-6],
  'claude-3-5-haiku': [0.8e-6, 4e-6],
  'claude-3-opus': [15e-6, 75e-6],
  'claude-3-sonnet': [3e-6, 15e-6],
  'claude-3-haiku': [0.25e-6, 1.25e-6],
};

/** Pre-sorted keys (longest first) for prefix matching versioned model names. */
const ANTHROPIC_PRICING_KEYS_BY_LENGTH = Object.keys(ANTHROPIC_PRICING).sort(
  (a, b) => b.length - a.length,
);

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
    for (const key of ANTHROPIC_PRICING_KEYS_BY_LENGTH) {
      if (model.startsWith(key)) {
        pricing = ANTHROPIC_PRICING[key];
        break;
      }
    }
  }
  if (!pricing) return 0;

  const [inputRate, outputRate] = pricing;
  const cacheRead = cacheReadTokens ?? 0;
  const cacheWrite = cacheWriteTokens ?? 0;
  // Anthropic cache reads cost 10% of base input rate (uniform across all models).
  // Cache writes cost 125% for the default 5-minute TTL, or 200% for the 1-hour TTL.
  // The API response does not distinguish between TTLs in cache_creation_input_tokens,
  // so we conservatively assume 5-minute writes (1.25x) for all cache creation tokens.
  const inputCost =
    (inputTokens - cacheRead - cacheWrite) * inputRate +
    cacheRead * inputRate * 0.1 +
    cacheWrite * inputRate * 1.25;
  return inputCost + outputTokens * outputRate;
}

/** Default thinking budget tokens for each effort level (manual mode fallback). */
const THINKING_BUDGETS: Record<string, number> = {
  low: 1024,
  medium: 5000,
  high: 10000,
  // 30000 (not 32000) to stay under the 32K max_tokens limit on Opus 4/4.1.
  // With auto-bump (+1024), max_tokens becomes 31024 which fits all models.
  max: 30000,
};

/**
 * Check if a model supports Anthropic's adaptive thinking mode.
 * Adaptive thinking is supported on Claude Opus 4.6 and Sonnet 4.6.
 */
function supportsAdaptiveThinking(model: string): boolean {
  return model.startsWith('claude-opus-4-6') || model.startsWith('claude-sonnet-4-6');
}

/**
 * Check if a model supports effort: 'max' in adaptive thinking mode.
 * Only Opus 4.6 supports max effort. Sonnet 4.6 supports adaptive mode
 * but not the 'max' effort level.
 */
function supportsMaxEffort(model: string): boolean {
  return model.startsWith('claude-opus-4-6');
}

/** Models that support output_config.effort (Opus 4.6, Sonnet 4.6, Opus 4.5). */
function supportsEffort(model: string): boolean {
  return (
    model.startsWith('claude-opus-4-6') ||
    model.startsWith('claude-sonnet-4-6') ||
    model.startsWith('claude-opus-4-5')
  );
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

    yield* this.parseSSEStream(res.body, options.model);
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

    if (options.stop) {
      body.stop_sequences = options.stop;
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => this.mapToolDefinition(t));
    }

    if (options.toolChoice !== undefined) {
      body.tool_choice = this.mapToolChoice(options.toolChoice);
    }

    // Build thinking/effort config
    const { thinkingBudget, thinkingDisabled, activeEffort, hasBudgetOverride } =
      resolveThinkingOptions(options);
    let resolvedEffort = activeEffort;
    if (resolvedEffort === 'max' && !supportsMaxEffort(options.model)) {
      resolvedEffort = 'high';
    }

    if (hasBudgetOverride) {
      // Explicit budget → manual mode (precise override), regardless of model
      body.thinking = { type: 'enabled', budget_tokens: thinkingBudget! };
      const currentMax = body.max_tokens as number;
      if (currentMax < thinkingBudget! + 1024) {
        body.max_tokens = thinkingBudget! + 1024;
      }
      // If effort also set on a model that supports it, send output_config alongside
      if (resolvedEffort && supportsEffort(options.model)) {
        body.output_config = { effort: resolvedEffort };
      }
    } else if (thinkingDisabled) {
      // effort: 'none' or thinkingBudget: 0 → no thinking block
      // thinkingBudget: 0 + effort → standalone effort (Anthropic optimization)
      if (resolvedEffort && supportsEffort(options.model)) {
        body.output_config = { effort: resolvedEffort };
      }
    } else if (resolvedEffort && supportsAdaptiveThinking(options.model)) {
      // 4.6 models (default): adaptive thinking + effort (recommended combo)
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort: resolvedEffort };
    } else if (resolvedEffort && supportsEffort(options.model)) {
      // Opus 4.5: supports effort but not adaptive thinking → effort only
      body.output_config = { effort: resolvedEffort };
    } else if (resolvedEffort) {
      // Older models: no effort support → map effort to thinking budget as fallback
      const budget = THINKING_BUDGETS[resolvedEffort] ?? 5000;
      body.thinking = { type: 'enabled', budget_tokens: budget };
      const currentMax = body.max_tokens as number;
      if (currentMax < budget + 1024) {
        body.max_tokens = budget + 1024;
      }
    }
    // No effort, no budget → no thinking, no effort sent

    // Anthropic rejects temperature when thinking is enabled.
    // Strip when any thinking block is present in the built body.
    if (options.temperature !== undefined && !body.thinking) {
      body.temperature = options.temperature;
    }

    // Anthropic doesn't have a native JSON mode like OpenAI's json_object.
    // Instead, we append a system-level instruction requesting valid JSON output.
    if (options.responseFormat && options.responseFormat.type !== 'text') {
      const jsonInstruction =
        'You must respond with valid JSON only. No markdown fences, no extra text.';
      body.system = body.system ? `${body.system}\n\n${jsonInstruction}` : jsonInstruction;
    }

    if (options.providerOptions) {
      Object.assign(body, options.providerOptions);
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

  /**
   * Map Axl's ToolChoice to Anthropic's tool_choice format.
   *
   * Axl (OpenAI format)          → Anthropic format
   * 'auto'                       → { type: 'auto' }
   * 'none'                       → { type: 'none' }
   * 'required'                   → { type: 'any' }
   * { type:'function', function: { name } } → { type: 'tool', name }
   */
  private mapToolChoice(choice: NonNullable<ChatOptions['toolChoice']>): Record<string, unknown> {
    if (typeof choice === 'string') {
      if (choice === 'required') return { type: 'any' };
      return { type: choice };
    }
    // Specific function: { type: 'function', function: { name } } → { type: 'tool', name }
    return { type: 'tool', name: choice.function.name };
  }

  // ---------------------------------------------------------------------------
  // Internal: response parsing
  // ---------------------------------------------------------------------------

  private parseResponse(json: AnthropicMessageResponse): ProviderResponse {
    let content = '';
    let thinkingContent = '';
    const toolCalls: ToolCallMessage[] = [];

    for (const block of json.content) {
      if (block.type === 'thinking') {
        thinkingContent += block.thinking;
      } else if (block.type === 'text') {
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
      thinking_content: thinkingContent || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      cost,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal: SSE stream parsing
  // ---------------------------------------------------------------------------

  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
    model: string,
  ): AsyncGenerator<StreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Track current content block type being streamed
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
    let cacheWrite = 0;

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
              if (delta?.type === 'thinking_delta' && delta.thinking) {
                yield { type: 'thinking_delta', content: delta.thinking };
              } else if (delta?.type === 'text_delta' && delta.text) {
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
              // Reset block tracking
              currentToolId = '';
              currentToolName = '';
              break;
            }

            case 'message_start': {
              // message_start arrives first in the SSE stream with input token counts
              if (event.message?.usage) {
                const cacheRead = event.message.usage.cache_read_input_tokens ?? 0;
                cacheWrite = event.message.usage.cache_creation_input_tokens ?? 0;
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
              yield {
                type: 'done',
                usage,
                cost: usage
                  ? estimateAnthropicCost(
                      model,
                      usage.prompt_tokens,
                      usage.completion_tokens,
                      usage.cached_tokens,
                      cacheWrite,
                    )
                  : undefined,
              };
              return;
            }
          }
        }
      }

      // If we exit without a message_stop, still emit done
      yield {
        type: 'done',
        usage,
        cost: usage
          ? estimateAnthropicCost(
              model,
              usage.prompt_tokens,
              usage.completion_tokens,
              usage.cached_tokens,
              cacheWrite,
            )
          : undefined,
      };
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
    | { type: 'thinking'; thinking: string }
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
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
    type?: 'text' | 'thinking' | 'tool_use';
    id?: string;
    name?: string;
    text?: string;
  };
  delta?: {
    type?: 'text_delta' | 'thinking_delta' | 'input_json_delta';
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
  usage?: {
    output_tokens?: number;
  };
};
