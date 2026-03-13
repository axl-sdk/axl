import type { Provider, ChatOptions, ChatMessage, ProviderResponse, StreamChunk } from './types.js';
import {
  estimateOpenAICost,
  isOSeriesModel,
  supportsReasoningEffort,
  effortToReasoningEffort,
  budgetToReasoningEffort,
  clampReasoningEffort,
} from './openai.js';
import type { ReasoningEffort } from './openai.js';
import { resolveThinkingOptions } from './types.js';
import { fetchWithRetry } from './retry.js';

/**
 * OpenAI Responses API provider using raw fetch (no SDK dependency).
 *
 * Maps the standard Provider interface to OpenAI's Responses API (`POST /v1/responses`).
 * The Responses API is OpenAI's recommended path forward with better caching,
 * built-in tools, and native reasoning support.
 */
export class OpenAIResponsesProvider implements Provider {
  readonly name = 'openai-responses';
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
  // chat - non-streaming
  // ---------------------------------------------------------------------------

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    const body = this.buildRequestBody(messages, options, false);

    const res = await fetchWithRetry(`${this.baseUrl}/responses`, {
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

    const json = (await res.json()) as ResponsesAPIResponse;
    return this.parseResponse(json, options.model);
  }

  // ---------------------------------------------------------------------------
  // stream - SSE streaming
  // ---------------------------------------------------------------------------

  async *stream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const body = this.buildRequestBody(messages, options, true);

    const res = await fetchWithRetry(`${this.baseUrl}/responses`, {
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
      throw new Error('OpenAI Responses stream has no body');
    }

    yield* this.parseSSEStream(res.body, options.model);
  }

  // ---------------------------------------------------------------------------
  // Internal: build request body
  // ---------------------------------------------------------------------------

  private buildRequestBody(
    messages: ChatMessage[],
    options: ChatOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const oSeries = isOSeriesModel(options.model);
    const reasoningCapable = supportsReasoningEffort(options.model);
    const { thinkingBudget, includeThoughts, thinkingDisabled, activeEffort, hasBudgetOverride } =
      resolveThinkingOptions(options);

    // Compute effective reasoning effort for wire format
    let wireEffort: ReasoningEffort | undefined;
    if (reasoningCapable) {
      if (hasBudgetOverride) {
        // Explicit budget always takes precedence (consistent with Anthropic/Gemini)
        wireEffort = clampReasoningEffort(options.model, budgetToReasoningEffort(thinkingBudget!));
      } else if (!thinkingDisabled && activeEffort) {
        wireEffort = clampReasoningEffort(options.model, effortToReasoningEffort(activeEffort));
      } else if (thinkingDisabled) {
        // Disable reasoning: covers both effort='none' and thinkingBudget=0
        wireEffort = clampReasoningEffort(options.model, 'none');
      }
    }

    // Temperature: always strip for o-series; for GPT-5.x, strip only when reasoning active
    const stripTemp = oSeries || (reasoningCapable && wireEffort !== undefined);

    // Extract system messages → instructions
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: options.model,
      input: this.buildInput(nonSystemMessages),
      store: false,
      stream,
    };

    if (systemMessages.length > 0) {
      body.instructions = systemMessages.map((m) => m.content).join('\n');
    }

    if (options.maxTokens !== undefined) {
      body.max_output_tokens = options.maxTokens;
    }

    if (options.temperature !== undefined && !stripTemp) {
      body.temperature = options.temperature;
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: 'function' as const,
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
        ...(t.function.strict !== undefined ? { strict: t.function.strict } : {}),
      }));
    }

    if (options.toolChoice !== undefined) {
      if (typeof options.toolChoice === 'object' && 'function' in options.toolChoice) {
        body.tool_choice = { type: 'function', name: options.toolChoice.function.name };
      } else {
        body.tool_choice = options.toolChoice;
      }
    }

    // Build reasoning config for models that support it
    if (reasoningCapable && (wireEffort !== undefined || includeThoughts)) {
      const reasoning: Record<string, unknown> = {};
      if (wireEffort !== undefined) reasoning.effort = wireEffort;
      if (includeThoughts) reasoning.summary = 'detailed';
      if (Object.keys(reasoning).length > 0) body.reasoning = reasoning;
    }

    // Request encrypted reasoning content for round-tripping
    if (reasoningCapable) {
      body.include = ['reasoning.encrypted_content'];
    }

    if (options.responseFormat) {
      body.text = { format: this.mapResponseFormat(options.responseFormat) };
    }

    if (options.providerOptions) {
      Object.assign(body, options.providerOptions);
    }

    return body;
  }

  // ---------------------------------------------------------------------------
  // Internal: message → input mapping
  // ---------------------------------------------------------------------------

  private buildInput(messages: ChatMessage[]): ResponsesInputItem[] {
    const input: ResponsesInputItem[] = [];

    for (const msg of messages) {
      if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id ?? '',
          output: msg.content,
        });
      } else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        // Inject reasoning items from providerMetadata if present (round-trip)
        const reasoningItems = msg.providerMetadata?.openaiReasoningItems as
          | ResponsesInputItem[]
          | undefined;
        if (reasoningItems) {
          for (const item of reasoningItems) {
            input.push(item);
          }
        }

        if (msg.content) {
          input.push({ type: 'message', role: 'assistant', content: msg.content });
        }
        for (const tc of msg.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        // Inject reasoning items for assistant messages without tool calls too
        if (msg.role === 'assistant' && msg.providerMetadata?.openaiReasoningItems) {
          const reasoningItems = msg.providerMetadata.openaiReasoningItems as ResponsesInputItem[];
          for (const item of reasoningItems) {
            input.push(item);
          }
        }

        input.push({
          type: 'message',
          role: msg.role,
          content: msg.content,
        });
      }
    }

    return input;
  }

  // ---------------------------------------------------------------------------
  // Internal: map responseFormat to Responses API text.format
  // ---------------------------------------------------------------------------

  /**
   * The Responses API uses `text.format` instead of `response_format`.
   * For `json_schema`, the schema fields are flattened into the format object
   * rather than nested under a `json_schema` key.
   *
   * Chat Completions: `{ type: "json_schema", json_schema: { name, strict, schema } }`
   * Responses API:    `{ type: "json_schema", name, strict, schema }`
   */
  private mapResponseFormat(
    format: NonNullable<ChatOptions['responseFormat']>,
  ): Record<string, unknown> {
    if (format.type === 'json_schema' && 'json_schema' in format) {
      const { json_schema, ...rest } = format;
      return { ...rest, ...json_schema };
    }
    return format;
  }

  // ---------------------------------------------------------------------------
  // Internal: parse non-streaming response
  // ---------------------------------------------------------------------------

  private parseResponse(json: ResponsesAPIResponse, model: string): ProviderResponse {
    let content = '';
    let thinkingContent = '';
    const toolCalls: ProviderResponse['tool_calls'] = [];
    const reasoningItems: unknown[] = [];

    for (const item of json.output) {
      if (item.type === 'message') {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text') {
            content += part.text;
          }
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id,
          type: 'function',
          function: {
            name: item.name,
            arguments: item.arguments,
          },
        });
      } else if (item.type === 'reasoning') {
        // Capture reasoning items for round-tripping via providerMetadata
        reasoningItems.push(item);
        // Extract summary text if present
        if (item.summary) {
          for (const s of item.summary) {
            if (s.type === 'summary_text' && s.text) {
              thinkingContent += s.text;
            }
          }
        }
      }
    }

    const usage = json.usage
      ? {
          prompt_tokens: json.usage.input_tokens,
          completion_tokens: json.usage.output_tokens,
          total_tokens: json.usage.total_tokens,
          reasoning_tokens: json.usage.output_tokens_details?.reasoning_tokens,
          cached_tokens: json.usage.input_tokens_details?.cached_tokens,
        }
      : undefined;

    const cost = usage
      ? estimateOpenAICost(model, usage.prompt_tokens, usage.completion_tokens, usage.cached_tokens)
      : undefined;

    const providerMetadata =
      reasoningItems.length > 0 ? { openaiReasoningItems: reasoningItems } : undefined;

    return {
      content,
      thinking_content: thinkingContent || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      cost,
      providerMetadata,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal: parse SSE stream
  // ---------------------------------------------------------------------------

  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
    model: string,
  ): AsyncGenerator<StreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Track current function_call item for argument deltas
    const callIdMap = new Map<number, string>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let eventType = '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('event: ')) {
            eventType = trimmed.slice(7);
            continue;
          }

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            let data: ResponsesStreamEventData;
            try {
              data = JSON.parse(jsonStr) as ResponsesStreamEventData;
            } catch {
              continue;
            }

            const chunk = this.handleStreamEvent(eventType, data, model, callIdMap);
            if (chunk) {
              yield chunk;
              // If done, exit
              if (chunk.type === 'done') return;
            }

            eventType = '';
          }
        }
      }

      // Stream ended without a completed event
      yield { type: 'done' };
    } finally {
      reader.releaseLock();
    }
  }

  private handleStreamEvent(
    eventType: string,
    data: ResponsesStreamEventData,
    model: string,
    callIdMap: Map<number, string>,
  ): StreamChunk | null {
    switch (eventType) {
      case 'response.output_text.delta':
        return { type: 'text_delta', content: data.delta ?? '' };

      case 'response.reasoning_summary_text.delta':
        return { type: 'thinking_delta', content: data.delta ?? '' };

      case 'response.output_item.added':
        if (data.item?.type === 'function_call') {
          const callId = data.item.call_id ?? data.item.id ?? '';
          const outputIndex = data.output_index ?? 0;
          callIdMap.set(outputIndex, callId);
          return {
            type: 'tool_call_delta',
            id: callId,
            name: data.item.name,
          };
        }
        return null;

      case 'response.function_call_arguments.delta': {
        const outputIndex = data.output_index ?? 0;
        const callId = callIdMap.get(outputIndex) ?? '';
        return {
          type: 'tool_call_delta',
          id: callId,
          arguments: data.delta ?? '',
        };
      }

      case 'response.completed': {
        const response = data.response as ResponsesAPIResponse | undefined;
        const usage = response?.usage
          ? {
              prompt_tokens: response.usage.input_tokens,
              completion_tokens: response.usage.output_tokens,
              total_tokens: response.usage.total_tokens,
              reasoning_tokens: response.usage.output_tokens_details?.reasoning_tokens,
              cached_tokens: response.usage.input_tokens_details?.cached_tokens,
            }
          : undefined;

        // Capture reasoning items from completed response for providerMetadata
        const reasoningItems = response?.output?.filter((item) => item.type === 'reasoning') ?? [];
        const providerMetadata =
          reasoningItems.length > 0 ? { openaiReasoningItems: reasoningItems } : undefined;

        return { type: 'done', usage, providerMetadata };
      }

      case 'response.failed': {
        const errorMsg =
          data.response?.error?.message ??
          data.response?.status_details?.error?.message ??
          'Unknown error';
        throw new Error(`OpenAI Responses API error: ${errorMsg}`);
      }

      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: error handling
  // ---------------------------------------------------------------------------

  private extractErrorMessage(body: string, status: number): string {
    try {
      const json = JSON.parse(body) as { error?: { message?: string; type?: string } };
      if (json.error?.message) {
        return `OpenAI Responses API error (${status}): ${json.error.message}`;
      }
    } catch {
      // Not JSON, use raw body
    }
    return `OpenAI Responses API error (${status}): ${body}`;
  }
}

// ---------------------------------------------------------------------------
// Responses API types (internal)
// ---------------------------------------------------------------------------

/** Union of possible SSE event data payloads from the Responses API stream. */
type ResponsesStreamEventData = {
  delta?: string;
  output_index?: number;
  item?: { type: string; call_id?: string; id?: string; name?: string };
  response?: ResponsesAPIResponse & {
    error?: { message?: string };
    status_details?: { error?: { message?: string } };
  };
};

type ResponsesInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'reasoning'; id: string; encrypted_content: string; [key: string]: unknown };

type ResponsesAPIResponse = {
  id: string;
  output: Array<
    | {
        type: 'message';
        role: 'assistant';
        content?: Array<{ type: 'output_text'; text: string }>;
      }
    | {
        type: 'function_call';
        id: string;
        call_id: string;
        name: string;
        arguments: string;
      }
    | {
        type: 'reasoning';
        id: string;
        summary?: Array<{ type: 'summary_text'; text: string }>;
        encrypted_content?: string;
        [key: string]: unknown;
      }
  >;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
    input_tokens_details?: {
      cached_tokens?: number;
    };
  };
};
