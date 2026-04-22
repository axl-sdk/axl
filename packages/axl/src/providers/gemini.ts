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

// ---------------------------------------------------------------------------
// Schema sanitization for Gemini's tool/responseSchema dialect.
//
// Gemini accepts a strict subset of OpenAPI 3.0 Schema Object — narrower
// than standard JSON Schema. Zod v4's `z.toJSONSchema()` emits Draft
// 2020-12 fields that Gemini rejects with a 400. Caught in the live
// integration test pass — every Zod-defined tool 400'd on first call.
//
//   Allowed:  type, format, description, nullable, enum, properties,
//             required, items, minItems, maxItems, minLength, maxLength,
//             minimum, maximum, pattern, anyOf, propertyOrdering, default,
//             title, minProperties, maxProperties, example, multipleOf
//   Rejected: additionalProperties, $schema, $ref, $defs, definitions,
//             not, allOf, oneOf, patternProperties, const,
//             unevaluatedProperties, unevaluatedItems
//
// Two fields get TRANSLATED rather than stripped because they're load-
// bearing for common Zod patterns:
//
//   `oneOf`  →  `anyOf`   — `z.discriminatedUnion()` produces `oneOf`.
//                            Naive stripping would erase the entire union
//                            shape and Gemini would have no schema for
//                            the field. The two are semantically identical
//                            for tool-use (the discriminator field already
//                            enforces mutual exclusion at the consumer
//                            site).
//
//   `const: x`  →  `enum: [x]`  — `z.literal('foo')` produces `const`.
//                            Naive stripping would lose the constraint
//                            entirely. `enum` with a single value is
//                            Gemini's supported equivalent. (If both
//                            `const` and `enum` are present, the explicit
//                            `enum` wins — we don't clobber.)
//
// `allOf` is stripped (rare in Zod output and merging it correctly is
// non-trivial — schema intersections that survive `allOf` removal will
// surface as a schema validation retry on our side, which is acceptable
// degradation). The function recurses through every value so an inner
// `additionalProperties: false` on a nested object also gets removed —
// the 400 fires at any depth.
//
// Loss without `additionalProperties: false`: the LLM has slightly less
// guidance about strict-mode schemas, so it may occasionally emit extra
// fields. Default Zod (`z.object`) silently strips them on parse, so the
// user sees clean data; `.strict()` schemas trigger our schema retry
// loop. Net cost: a handful of extra tokens, occasional retry. Not a
// correctness issue.
// ---------------------------------------------------------------------------

const GEMINI_DISALLOWED_SCHEMA_KEYS = new Set([
  'additionalProperties',
  '$schema',
  '$ref',
  '$defs',
  'definitions',
  'not',
  'allOf',
  'patternProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
]);

function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchemaForGemini(item));
  }
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (GEMINI_DISALLOWED_SCHEMA_KEYS.has(key)) continue;
    if (key === 'oneOf') {
      // Translate to anyOf — preserves z.discriminatedUnion's union shape.
      out.anyOf = sanitizeSchemaForGemini(value);
      continue;
    }
    if (key === 'const') {
      // Translate to enum with one element — preserves z.literal's
      // constraint. Skip if `enum` is also set so we don't clobber an
      // explicit enum the schema author already wrote.
      if (!('enum' in src)) out.enum = [value];
      continue;
    }
    out[key] = sanitizeSchemaForGemini(value);
  }
  return out;
}

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
  'gemini-3.1-pro-preview': [2e-6, 12e-6],
  'gemini-3.1-flash-lite-preview': [0.25e-6, 1.5e-6],
};

/** Pre-sorted keys (longest first) for prefix matching versioned model names. */
const GEMINI_PRICING_KEYS_BY_LENGTH = Object.keys(GEMINI_PRICING).sort(
  (a, b) => b.length - a.length,
);

function estimateGeminiCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens?: number,
): number {
  let pricing = GEMINI_PRICING[model];
  if (!pricing) {
    for (const key of GEMINI_PRICING_KEYS_BY_LENGTH) {
      if (model.startsWith(key)) {
        pricing = GEMINI_PRICING[key];
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

/** Default thinking budget tokens for each effort level (Gemini 2.x). */
const THINKING_BUDGETS: Record<string, number> = {
  low: 1024,
  medium: 5000,
  high: 10000,
  max: 24576,
};

/** Gemini 3.x thinkingLevel values mapped from unified effort levels. */
const THINKING_LEVELS: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high', // 3.x caps at 'high'
};

/** Check if a model is Gemini 3.x generation (uses thinkingLevel instead of thinkingBudget). */
function isGemini3x(model: string): boolean {
  return /^gemini-3[.-]/.test(model);
}

/**
 * Map thinkingBudget to Gemini thinkingLevel.
 *
 * Gemini 3.x uses `thinkingLevel` (string enum: 'low' | 'medium' | 'high').
 * Gemini 2.x uses `thinkingBudget` (integer token count).
 * Budget form `{ budgetTokens }` maps to nearest `thinkingLevel` on 3.x,
 * exact `thinkingBudget` on 2.x.
 */
function budgetToThinkingLevel(budgetTokens: number): string {
  if (budgetTokens <= 1024) return 'low';
  if (budgetTokens <= 5000) return 'medium';
  return 'high';
}

/** Get the minimum supported thinkingLevel for a 3.x model. */
function minThinkingLevel(model: string): string {
  // 3.1 Pro doesn't support 'minimal' — 'low' is the floor
  if (model.startsWith('gemini-3.1-pro')) return 'low';
  return 'minimal';
}

/** Warn once per model that effort: 'none' cannot fully disable thinking on Gemini 3.x. */
const _warned3xEffortNone = new Set<string>();
function warnGemini3xEffortNone(model: string): void {
  if (_warned3xEffortNone.has(model)) return;
  _warned3xEffortNone.add(model);
  console.warn(
    `[axl] effort: 'none' on Gemini 3.x (${model}) maps to the model's minimum thinking level ` +
      `('${minThinkingLevel(model)}'), not fully disabled. Gemini 3.x models cannot disable thinking entirely.`,
  );
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

    yield* this.parseSSEStream(res.body, options.model);
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
        generationConfig.responseSchema = sanitizeSchemaForGemini(
          options.responseFormat.json_schema.schema,
        );
      }
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    // Map effort/thinkingBudget/includeThoughts to Gemini's thinkingConfig
    const {
      effort,
      thinkingBudget,
      includeThoughts,
      thinkingDisabled,
      activeEffort,
      hasBudgetOverride,
    } = resolveThinkingOptions(options);

    if (thinkingDisabled) {
      // effort: 'none' or thinkingBudget: 0 → minimize thinking
      if (isGemini3x(options.model)) {
        if (effort === 'none') {
          warnGemini3xEffortNone(options.model);
        }
        generationConfig.thinkingConfig = { thinkingLevel: minThinkingLevel(options.model) };
      } else {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
      }
      if (!body.generationConfig) body.generationConfig = generationConfig;
    } else if (hasBudgetOverride) {
      // Explicit budget takes precedence over effort
      const config: Record<string, unknown> = {};
      if (isGemini3x(options.model)) {
        config.thinkingLevel = budgetToThinkingLevel(thinkingBudget!);
      } else {
        config.thinkingBudget = thinkingBudget!;
      }
      if (includeThoughts) config.includeThoughts = true;
      generationConfig.thinkingConfig = config;
      if (!body.generationConfig) body.generationConfig = generationConfig;
    } else if (activeEffort) {
      const config: Record<string, unknown> = {};
      if (isGemini3x(options.model)) {
        config.thinkingLevel = THINKING_LEVELS[activeEffort] ?? 'medium';
      } else {
        // 2.5 Pro supports a higher max budget (32768) than other 2.5 models (24576)
        if (activeEffort === 'max' && options.model.startsWith('gemini-2.5-pro')) {
          config.thinkingBudget = 32768;
        } else {
          config.thinkingBudget = THINKING_BUDGETS[activeEffort] ?? 5000;
        }
      }
      if (includeThoughts) config.includeThoughts = true;
      generationConfig.thinkingConfig = config;
      if (!body.generationConfig) body.generationConfig = generationConfig;
    } else if (includeThoughts) {
      generationConfig.thinkingConfig = { includeThoughts: true };
      if (!body.generationConfig) body.generationConfig = generationConfig;
    }
    // No effort, no budget, no includeThoughts → no thinkingConfig (provider defaults)

    // Map toolChoice to Gemini's toolConfig.functionCallingConfig
    if (options.toolChoice !== undefined) {
      body.toolConfig = { functionCallingConfig: this.mapToolChoice(options.toolChoice) };
    }

    if (options.providerOptions) {
      Object.assign(body, options.providerOptions);
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
        // If we have raw Gemini parts from a previous response, use them directly.
        // This preserves thoughtSignature and other opaque fields that Gemini requires
        // in subsequent turns for multi-turn reasoning context.
        const rawParts = msg.providerMetadata?.geminiParts as GeminiPart[] | undefined;
        if (rawParts && rawParts.length > 0) {
          result.push({ role: 'model', parts: rawParts });
        } else {
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
      parameters: sanitizeSchemaForGemini(tool.function.parameters),
    };
  }

  // ---------------------------------------------------------------------------
  // Internal: response parsing
  // ---------------------------------------------------------------------------

  private parseResponse(json: GeminiResponse, model: string): ProviderResponse {
    const candidate = json.candidates?.[0];
    let content = '';
    let thinkingContent = '';
    const toolCalls: ToolCallMessage[] = [];

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.thought && part.text) {
          thinkingContent += part.text;
        } else if (part.text) {
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
    const reasoningTokens = json.usageMetadata?.thoughtsTokenCount;
    const usage = json.usageMetadata
      ? {
          prompt_tokens: json.usageMetadata.promptTokenCount ?? 0,
          completion_tokens: json.usageMetadata.candidatesTokenCount ?? 0,
          total_tokens: json.usageMetadata.totalTokenCount ?? 0,
          cached_tokens: cachedTokens && cachedTokens > 0 ? cachedTokens : undefined,
          reasoning_tokens: reasoningTokens && reasoningTokens > 0 ? reasoningTokens : undefined,
        }
      : undefined;

    const cost = usage
      ? estimateGeminiCost(model, usage.prompt_tokens, usage.completion_tokens, usage.cached_tokens)
      : undefined;

    // Attach raw Gemini parts as providerMetadata so they can be sent back
    // verbatim in subsequent turns, preserving thoughtSignature and other opaque fields.
    const rawParts = candidate?.content?.parts;
    const providerMetadata = rawParts ? { geminiParts: rawParts } : undefined;

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
  // Internal: SSE stream parsing
  // ---------------------------------------------------------------------------

  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
    model: string,
  ): AsyncGenerator<StreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage:
      | {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          cached_tokens?: number;
          reasoning_tokens?: number;
        }
      | undefined;
    // Accumulate raw parts across stream chunks for providerMetadata round-tripping
    const accumulatedParts: Array<Record<string, unknown>> = [];

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
            const reasoning = chunk.usageMetadata.thoughtsTokenCount;
            usage = {
              prompt_tokens: chunk.usageMetadata.promptTokenCount ?? 0,
              completion_tokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
              total_tokens: chunk.usageMetadata.totalTokenCount ?? 0,
              cached_tokens: cached && cached > 0 ? cached : undefined,
              reasoning_tokens: reasoning && reasoning > 0 ? reasoning : undefined,
            };
          }

          const candidate = chunk.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              // Accumulate raw parts for providerMetadata
              accumulatedParts.push(part);

              if (part.thought && part.text) {
                yield { type: 'thinking_delta', content: part.text };
              } else if (part.text) {
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

      const providerMetadata =
        accumulatedParts.length > 0 ? { geminiParts: accumulatedParts } : undefined;
      yield {
        type: 'done',
        usage,
        cost: usage
          ? estimateGeminiCost(
              model,
              usage.prompt_tokens,
              usage.completion_tokens,
              usage.cached_tokens,
            )
          : undefined,
        providerMetadata,
      };
    } finally {
      reader.releaseLock();
    }
  }
}

// ---------------------------------------------------------------------------
// Gemini API types (internal)
// ---------------------------------------------------------------------------

/**
 * Gemini part type for request building.
 *
 * Uses an index signature to allow opaque provider fields (e.g. thoughtSignature)
 * to round-trip through conversation history without being stripped.
 */
type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  [key: string]: unknown;
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
        thought?: boolean;
        functionCall?: { name: string; args: Record<string, unknown> };
        [key: string]: unknown;
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
};
