import type { ChatMessage, ProviderResponse, ToolCallMessage } from '../types.js';
import type { ChatOptions, StreamChunk } from '../providers/types.js';
import type { SpanAttributes } from './types.js';

/**
 * OTel GenAI semantic conventions (Development), pinned to
 * https://github.com/open-telemetry/semantic-conventions-genai/commit/f3c6d0c9bb66ebd474668a3a0be25c61226f02c2
 * dated 2026-10-14. Shapes: model/gen-ai/gen-ai-{input,output}-messages.json.
 * Keep convention churn in this module; axl.* attributes are a separate contract.
 */
export const GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES = 16 * 1024;
/** Opted-in content attributes left off for size or serializability, so absence is never silent. */
export const GEN_AI_CONTENT_OMITTED_ATTRIBUTE = 'axl.gen_ai.content_omitted';

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  openai: 'openai',
  'openai-responses': 'openai',
  anthropic: 'anthropic',
  google: 'gcp.gen_ai',
  xai: 'x_ai',
  azure: 'azure.ai.openai',
  bedrock: 'aws.bedrock',
};

// These native adapters send system messages in a separate top-level API field.
// Chat Completions and its compatible profiles keep system in the message list.
const SEPARATE_SYSTEM_INSTRUCTIONS = new Set(['anthropic', 'google', 'openai-responses']);

export function genAiProviderName(providerId: string): string {
  return PROVIDER_NAMES[providerId] ?? providerId;
}

export type InferenceStart = {
  providerId: string;
  options: ChatOptions;
  stream: boolean;
  sessionId?: string;
  /** The actual provider-native level. Omit when a provider does not report it. */
  effectiveReasoningLevel?: string;
  messages?: readonly ChatMessage[];
  captureContent?: boolean;
  redact?: boolean;
};

export function genAiInferenceStart(input: InferenceStart): {
  name: string;
  attributes: SpanAttributes;
} {
  const { options } = input;
  const attributes: SpanAttributes = {
    'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': genAiProviderName(input.providerId),
    'gen_ai.request.model': options.model,
    'gen_ai.request.stream': input.stream,
  };
  if (input.sessionId) attributes['gen_ai.conversation.id'] = input.sessionId;
  if (
    options.responseFormat?.type === 'json_object' ||
    options.responseFormat?.type === 'json_schema'
  ) {
    attributes['gen_ai.output.type'] = 'json';
  }
  if (options.temperature !== undefined)
    attributes['gen_ai.request.temperature'] = options.temperature;
  if (options.maxTokens !== undefined) attributes['gen_ai.request.max_tokens'] = options.maxTokens;
  if (!input.redact && options.stop?.length) {
    const stop = JSON.stringify(options.stop);
    if (new TextEncoder().encode(stop).byteLength <= GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES) {
      attributes['gen_ai.request.stop_sequences'] = [...options.stop];
    }
  }
  if (input.effectiveReasoningLevel) {
    attributes['gen_ai.request.reasoning.level'] = input.effectiveReasoningLevel;
  }
  if (input.captureContent && !input.redact) {
    const omitted: string[] = [];
    if (input.messages) {
      const separateSystem = SEPARATE_SYSTEM_INSTRUCTIONS.has(input.providerId);
      const history = separateSystem
        ? input.messages.filter((message) => message.role !== 'system')
        : input.messages;
      setJsonContent(attributes, omitted, 'gen_ai.input.messages', toGenAiInputMessages(history));
      if (separateSystem) {
        const system = input.messages.filter((message) => message.role === 'system');
        // Native adapters differ on rich system parts; publish only known text
        // instructions, never an invented rendering or raw continuity data.
        if (system.length && system.every((message) => typeof message.content === 'string')) {
          setJsonContent(
            attributes,
            omitted,
            'gen_ai.system_instructions',
            system.map((message) => ({ type: 'text', content: message.content })),
          );
        }
      }
    }
    if (options.tools?.length) {
      setJsonContent(
        attributes,
        omitted,
        'gen_ai.tool.definitions',
        options.tools.map((tool) => ({
          type: 'function',
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      );
    }
    if (omitted.length) attributes[GEN_AI_CONTENT_OMITTED_ATTRIBUTE] = omitted;
  }
  return { name: `chat ${options.model}`, attributes };
}

export type InferenceEnd = {
  response?: Partial<
    Pick<
      ProviderResponse,
      | 'content'
      | 'thinking_content'
      | 'tool_calls'
      | 'finishReason'
      | 'responseId'
      | 'responseModel'
      | 'usage'
    >
  >;
  /** Request issuance to first stream chunk, in milliseconds. Do not substitute first content token timing. */
  firstChunkMs?: number;
  /** A low-cardinality error code or class name, never an error message. */
  errorType?: string;
  captureContent?: boolean;
  redact?: boolean;
  /** Content exceeded the per-attribute bound while streaming. */
  omitContent?: boolean;
};

export function genAiInferenceEnd(input: InferenceEnd): SpanAttributes {
  const attributes: SpanAttributes = {};
  const { response } = input;
  if (response?.responseId) attributes['gen_ai.response.id'] = response.responseId;
  if (response?.responseModel) attributes['gen_ai.response.model'] = response.responseModel;
  if (response?.finishReason)
    attributes['gen_ai.response.finish_reasons'] = [response.finishReason];
  if (input.firstChunkMs !== undefined) {
    attributes['gen_ai.response.time_to_first_chunk'] = input.firstChunkMs / 1000;
  }
  const usage = response?.usage;
  if (usage) {
    attributes['gen_ai.usage.input_tokens'] = usage.prompt_tokens;
    attributes['gen_ai.usage.output_tokens'] = usage.completion_tokens;
    if (usage.cached_tokens !== undefined) {
      attributes['gen_ai.usage.cache_read.input_tokens'] = usage.cached_tokens;
    }
    if (usage.cache_write_tokens !== undefined) {
      attributes['gen_ai.usage.cache_write.input_tokens'] = usage.cache_write_tokens;
    }
    if (usage.reasoning_tokens !== undefined) {
      attributes['gen_ai.usage.reasoning.output_tokens'] = usage.reasoning_tokens;
    }
  }
  if (input.errorType) {
    // Error messages may contain prompts. Accept only a short code/class token.
    attributes['error.type'] = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(input.errorType)
      ? input.errorType
      : 'error';
  }
  if (input.captureContent && !input.redact && input.omitContent) {
    attributes[GEN_AI_CONTENT_OMITTED_ATTRIBUTE] = ['gen_ai.output.messages'];
  } else if (input.captureContent && !input.redact && response) {
    const parts: Array<Record<string, unknown>> = [];
    if (response.content) parts.push({ type: 'text', content: response.content });
    if (response.thinking_content)
      parts.push({ type: 'reasoning', content: response.thinking_content });
    if (response.tool_calls) parts.push(...response.tool_calls.map(toToolCallPart));
    const omitted: string[] = [];
    if (parts.length)
      setJsonContent(attributes, omitted, 'gen_ai.output.messages', [{ role: 'assistant', parts }]);
    if (omitted.length) attributes[GEN_AI_CONTENT_OMITTED_ATTRIBUTE] = omitted;
  }
  return attributes;
}

/** Bounded projection of streamed output for the optional content attribute. */
export class GenAiStreamContent {
  private text = '';
  private reasoning = '';
  private readonly calls = new Map<string, { id: string; name: string; arguments: string }>();
  private size = 0;
  private overflow = false;

  observe(chunk: StreamChunk): void {
    if (this.overflow || chunk.type === 'done') return;
    if (chunk.type === 'text_delta') {
      if (this.reserve(chunk.content)) this.text += chunk.content;
    } else if (chunk.type === 'thinking_delta') {
      if (this.reserve(chunk.content)) this.reasoning += chunk.content;
    } else if (chunk.type === 'tool_call_delta') {
      if (!this.reserve(chunk.id + (chunk.name ?? '') + (chunk.arguments ?? ''))) return;
      const call = this.calls.get(chunk.id) ?? { id: chunk.id, name: '', arguments: '' };
      if (chunk.name) call.name = chunk.name;
      if (chunk.arguments) call.arguments += chunk.arguments;
      this.calls.set(chunk.id, call);
    }
  }

  snapshot(): {
    response: InferenceEnd['response'];
    omitContent: boolean;
  } {
    return {
      response: {
        ...(this.text ? { content: this.text } : {}),
        ...(this.reasoning ? { thinking_content: this.reasoning } : {}),
        ...(this.calls.size
          ? {
              tool_calls: [...this.calls.values()].map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      },
      omitContent: this.overflow,
    };
  }

  private reserve(value: string): boolean {
    const bytes =
      value.length > GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES
        ? GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES + 1
        : new TextEncoder().encode(value).byteLength;
    if (this.size + bytes > GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES) {
      this.overflow = true;
      this.text = '';
      this.reasoning = '';
      this.calls.clear();
      return false;
    }
    this.size += bytes;
    return true;
  }
}

function toToolCallPart(call: ToolCallMessage): Record<string, unknown> {
  let args: unknown = call.function.arguments;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    // A provider may return unfinished JSON arguments on an aborted stream.
  }
  return { type: 'tool_call', id: call.id, name: call.function.name, arguments: args };
}

function toGenAiInputMessages(messages: readonly ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const parts: Array<Record<string, unknown>> = [];
    if (typeof message.content === 'string') {
      if (message.role === 'tool') {
        parts.push({
          type: 'tool_call_response',
          id: message.tool_call_id,
          response: message.content,
        });
      } else {
        parts.push({ type: 'text', content: message.content });
      }
    } else {
      // Rich media may contain credential-bearing URLs or provider file handles.
      // Until there is an explicit safe projection, export only text parts.
      const textParts = message.content.filter((part) => part.type === 'text');
      if (message.role === 'tool') {
        parts.push({
          type: 'tool_call_response',
          id: message.tool_call_id,
          response: textParts.map((part) => part.text).join(''),
        });
      } else {
        for (const part of textParts) parts.push({ type: 'text', content: part.text });
      }
    }
    if (message.tool_calls) parts.push(...message.tool_calls.map(toToolCallPart));
    return {
      role: message.role,
      parts,
      ...(message.name ? { name: message.name } : {}),
    };
  });
}

function setJsonContent(
  attributes: SpanAttributes,
  omitted: string[],
  key: string,
  value: unknown,
): void {
  try {
    const json = JSON.stringify(value);
    // Omit an oversized attribute whole: slicing the string would break JSON
    // and slicing a message could break the upstream message/part schema.
    if (json && new TextEncoder().encode(json).byteLength <= GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES) {
      attributes[key] = json;
      return;
    }
  } catch {
    // Caller-supplied tool schemas can be cyclic. Telemetry must not fail calls.
  }
  omitted.push(key);
}
