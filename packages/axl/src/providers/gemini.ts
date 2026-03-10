import type {
  Provider,
  ChatOptions,
  ChatMessage,
  ProviderResponse,
  StreamChunk,
  ToolDefinition,
  ToolCallMessage,
  Thinking,
} from './types.js';
import { fetchWithRetry } from './retry.js';

// ---------------------------------------------------------------------------
// Approximate per-token pricing (USD) for common Gemini models.
// Format: [inputCostPerToken, outputCostPerToken]
// Uses standard context pricing (<=200k) as default.
// ---------------------------------------------------------------------------

const GEMINI_PRICING: Record<string, [number, number]> = {
  'gemini-2.5-pro': [1.25e-6, 10e-6],
  'gemini-2.5-flash': [0.3e-6, 2.5e-6],
  'gemini-2.5-flash-lite': [0.1e-6, 0.4e-6],
  'gemini-2.0-flash': [0.1e-6, 0.4e-6],
  'gemini-2.0-flash-lite': [0.1e-6, 0.4e-6],
  'gemini-3-pro-preview': [2e-6, 12e-6],
  'gemini-3-flash-preview': [0.5e-6, 3e-6],
};

function estimateGeminiCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens?: number,
): number {
  let pricing = GEMINI_PRICING[model];
  if (!pricing) {
    for (const [key, value] of Object.entries(GEMINI_PRICING)) {
      if (model.startsWith(key)) {
        pricing = value;
        break;
      }
    }
  }
  if (!pricing) return 0;

  const [inputRate, outputRate] = pricing;
  const cached = cachedTokens ?? 0;
  // Gemini charges 10% of input rate for cached tokens (90% discount)
  const inputCost = (inputTokens - cached) * inputRate + cached * inputRate * 0.1;
  return inputCost + outputTokens * outputRate;
}

/** Default thinking budget tokens for each Thinking level. */
const THINKING_BUDGETS: Record<string, number> = {
  low: 1024,
  medium: 5000,
  high: 10000,
  max: 24576,
};

/** Map unified Thinking to Gemini thinkingBudget. */
function thinkingToBudgetTokens(thinking: Thinking): number {
  if (typeof thinking === 'string') return THINKING_BUDGETS[thinking] ?? 5000;
  return thinking.budgetTokens;
}

/**
 * Google Gemini provider using raw fetch (no SDK dependency).
 *
 * Supports:
 * - Chat completions via generateContent
 * - Tool calling (functionCall / functionResponse)
 * - Streaming via SSE (streamGenerateContent)
 * - Structured output via responseMimeType / responseSchema
 *
 * Message mapping:
 * - "system" role messages are extracted into the top-level `system_instruction` param
 * - "assistant" role is mapped to "model" role
 * - "tool" role messages are mapped to user messages with functionResponse parts
 * - assistant messages with tool_calls are mapped to functionCall parts
 */
export class GeminiProvider implements Provider {
  readonly name = 'google';
  private baseUrl: string;
  private apiKey: string;
  private callCounter = 0;

  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    this.apiKey = options.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(
      /\/$/,
      '',
    );

    if (!this.apiKey) {
      throw new Error('Google API key is required. Set GOOGLE_API_KEY or pass apiKey in options.');
    }
  }

  // ---------------------------------------------------------------------------
  // chat - non-streaming completion
  // ---------------------------------------------------------------------------

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    const body = this.buildRequestBody(messages, options);

    const res = await fetchWithRetry(`${this.baseUrl}/models/${options.model}:generateContent`, {
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

    const json = (await res.json()) as GeminiResponse;
    return this.parseResponse(json, options.model);
  }

  // ---------------------------------------------------------------------------
  // stream - SSE streaming completion
  // ---------------------------------------------------------------------------

  async *stream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const body = this.buildRequestBody(messages, options);

    const res = await fetchWithRetry(
      `${this.baseUrl}/models/${options.model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );

    if (!res.ok) {
      const errorBody = await res.text();
      const message = this.extractErrorMessage(errorBody, res.status);
      throw new Error(message);
    }

    if (!res.body) {
      throw new Error('Gemini stream response has no body');
    }

    yield* this.parseSSEStream(res.body);
  }

  // ---------------------------------------------------------------------------
  // Internal: request building
  // ---------------------------------------------------------------------------

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey,
    };
  }

  private extractErrorMessage(body: string, status: number): string {
    try {
      const json = JSON.parse(body) as {
        error?: { message?: string; code?: number; status?: string };
      };
      if (json.error?.message) {
        return `Gemini API error (${status}): ${json.error.message}`;
      }
    } catch {
      // Not JSON, use raw body
    }
    return `Gemini API error (${status}): ${body}`;
  }

  private buildRequestBody(messages: ChatMessage[], options: ChatOptions): Record<string, unknown> {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const systemText = systemMessages.map((m) => m.content).join('\n\n');

    const body: Record<string, unknown> = {
      contents: this.mapMessages(nonSystemMessages),
    };

    if (systemText) {
      body.system_instruction = { parts: [{ text: systemText }] };
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: options.tools.map((t) => this.mapToolDefinition(t)),
        },
      ];
    }

    const generationConfig: Record<string, unknown> = {};

    if (options.temperature !== undefined) {
      generationConfig.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = options.maxTokens;
    }
    if (options.stop) {
      generationConfig.stopSequences = options.stop;
    }

    if (options.responseFormat && options.responseFormat.type !== 'text') {
      generationConfig.responseMimeType = 'application/json';
      if (
        options.responseFormat.type === 'json_schema' &&
        options.responseFormat.json_schema?.schema
      ) {
        generationConfig.responseSchema = options.responseFormat.json_schema.schema;
      }
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    // Map unified thinking to Gemini's thinkingConfig
    if (options.thinking) {
      generationConfig.thinkingConfig = {
        thinkingBudget: thinkingToBudgetTokens(options.thinking),
      };
      // Ensure generationConfig is included even if nothing else was set
      if (!body.generationConfig) {
        body.generationConfig = generationConfig;
      }
    }

    // Map toolChoice to Gemini's toolConfig.functionCallingConfig
    if (options.toolChoice !== undefined) {
      body.toolConfig = { functionCallingConfig: this.mapToolChoice(options.toolChoice) };
    }

    return body;
  }

  /**
   * Map OpenAI-format ChatMessages to Gemini content format.
   *
   * Key transformations:
   * - assistant role -> model role
   * - assistant messages with tool_calls -> model messages with functionCall parts
   * - tool messages -> user messages with functionResponse parts
   *
   * Two-pass approach: first build a tool_call_id -> function name mapping
   * from assistant messages, then use it when mapping tool result messages.
   */
  private mapMessages(messages: ChatMessage[]): GeminiContent[] {
    // Pass 1: build tool_call_id -> function name mapping
    const toolCallIdToName = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallIdToName.set(tc.id, tc.function.name);
        }
      }
    }

    // Pass 2: transform messages
    const result: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const parts: GeminiPart[] = [];

        if (msg.content) {
          parts.push({ text: msg.content });
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            let parsedArgs: Record<string, unknown>;
            try {
              parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            } catch {
              parsedArgs = {};
            }
            parts.push({
              functionCall: {
                name: tc.function.name,
                args: parsedArgs,
              },
            });
          }
        }

        if (parts.length > 0) {
          result.push({ role: 'model', parts });
        }
      } else if (msg.role === 'tool') {
        const functionName = toolCallIdToName.get(msg.tool_call_id!) ?? 'unknown';
        let responseData: unknown;
        try {
          responseData = JSON.parse(msg.content);
        } catch {
          responseData = { result: msg.content };
        }
        result.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: functionName,
                response: responseData as Record<string, unknown>,
              },
            },
          ],
        });
      } else if (msg.role === 'user') {
        result.push({ role: 'user', parts: [{ text: msg.content }] });
      }
      // system messages already handled at top level
    }

    // Merge consecutive same-role messages
    return this.mergeConsecutiveRoles(result);
  }

  /**
   * Merge consecutive messages with the same role into a single message.
   * Gemini requires alternating user/model turns.
   */
  private mergeConsecutiveRoles(messages: GeminiContent[]): GeminiContent[] {
    if (messages.length === 0) return messages;

    const merged: GeminiContent[] = [messages[0]];

    for (let i = 1; i < messages.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = messages[i];

      if (prev.role === curr.role) {
        prev.parts = [...prev.parts, ...curr.parts];
      } else {
        merged.push(curr);
      }
    }

    return merged;
  }

  /**
   * Map Axl's ToolChoice to Gemini's functionCallingConfig format.
   *
   * - 'auto'     → { mode: 'AUTO' }
   * - 'none'     → { mode: 'NONE' }
   * - 'required' → { mode: 'ANY' }
   * - { type: 'function', function: { name } } → { mode: 'ANY', allowedFunctionNames: [name] }
   */
  private mapToolChoice(choice: NonNullable<ChatOptions['toolChoice']>): Record<string, unknown> {
    if (typeof choice === 'string') {
      const modeMap: Record<string, string> = {
        auto: 'AUTO',
        none: 'NONE',
        required: 'ANY',
      };
      return { mode: modeMap[choice] ?? 'AUTO' };
    }
    // Specific function choice
    return { mode: 'ANY', allowedFunctionNames: [choice.function.name] };
  }

  private mapToolDefinition(tool: ToolDefinition): {
    name: string;
    description: string;
    parameters: unknown;
  } {
    return {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal: response parsing
  // ---------------------------------------------------------------------------

  private parseResponse(json: GeminiResponse, model: string): ProviderResponse {
    const candidate = json.candidates?.[0];
    let content = '';
    const toolCalls: ToolCallMessage[] = [];

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text) {
          content += part.text;
        } else if (part.functionCall) {
          toolCalls.push({
            id: `call_${this.callCounter++}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args),
            },
          });
        }
      }
    }

    const cachedTokens = json.usageMetadata?.cachedContentTokenCount;
    const usage = json.usageMetadata
      ? {
          prompt_tokens: json.usageMetadata.promptTokenCount ?? 0,
          completion_tokens: json.usageMetadata.candidatesTokenCount ?? 0,
          total_tokens: json.usageMetadata.totalTokenCount ?? 0,
          cached_tokens: cachedTokens && cachedTokens > 0 ? cachedTokens : undefined,
        }
      : undefined;

    const cost = usage
      ? estimateGeminiCost(model, usage.prompt_tokens, usage.completion_tokens, usage.cached_tokens)
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
          let chunk: GeminiResponse;
          try {
            chunk = JSON.parse(jsonStr) as GeminiResponse;
          } catch {
            continue;
          }

          // Extract usage from this chunk (accumulate from final chunk)
          if (chunk.usageMetadata) {
            const cached = chunk.usageMetadata.cachedContentTokenCount;
            usage = {
              prompt_tokens: chunk.usageMetadata.promptTokenCount ?? 0,
              completion_tokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
              total_tokens: chunk.usageMetadata.totalTokenCount ?? 0,
              cached_tokens: cached && cached > 0 ? cached : undefined,
            };
          }

          const candidate = chunk.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if (part.text) {
                yield { type: 'text_delta', content: part.text };
              } else if (part.functionCall) {
                // Gemini sends complete functionCall objects (not incremental deltas)
                yield {
                  type: 'tool_call_delta',
                  id: `call_${this.callCounter++}`,
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args),
                };
              }
            }
          }
        }
      }

      yield { type: 'done', usage };
    } finally {
      reader.releaseLock();
    }
  }
}

// ---------------------------------------------------------------------------
// Gemini API types (internal)
// ---------------------------------------------------------------------------

type GeminiPart =
  | { text: string; functionCall?: undefined; functionResponse?: undefined }
  | {
      functionCall: { name: string; args: Record<string, unknown> };
      text?: undefined;
      functionResponse?: undefined;
    }
  | {
      functionResponse: { name: string; response: Record<string, unknown> };
      text?: undefined;
      functionCall?: undefined;
    };

type GeminiContent = {
  role: 'user' | 'model';
  parts: GeminiPart[];
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      role: string;
      parts: Array<{
        text?: string;
        functionCall?: { name: string; args: Record<string, unknown> };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
};
