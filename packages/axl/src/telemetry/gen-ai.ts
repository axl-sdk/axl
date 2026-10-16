import type { ChatMessage, ProviderResponse, ToolCallMessage } from '../types.js';
import type { ChatOptions } from '../providers/types.js';
import type { SpanAttributes } from './types.js';

/**
 * OTel GenAI semantic conventions (Development), pinned to
 * https://github.com/open-telemetry/semantic-conventions-genai/commit/f3c6d0c9bb66ebd474668a3a0be25c61226f02c2
 * dated 2026-10-14. Shapes: model/gen-ai/gen-ai-{input,output}-messages.json.
 * Keep convention churn in this module; axl.* attributes are a separate contract.
 */
export const GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES = 16 * 1024;

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  openai: 'openai',
  'openai-responses': 'openai',
  anthropic: 'anthropic',
  google: 'gcp.gen_ai',
  azure: 'azure.ai.openai',
  bedrock: 'aws.bedrock',
};

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
    if (input.messages)
      setJsonContent(attributes, 'gen_ai.input.messages', toGenAiInputMessages(input.messages));
    if (options.tools?.length) {
      setJsonContent(
        attributes,
        'gen_ai.tool.definitions',
        options.tools.map((tool) => ({
          type: 'function',
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      );
    }
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
  if (input.captureContent && !input.redact && response) {
    const parts: Array<Record<string, unknown>> = [];
    if (response.content) parts.push({ type: 'text', content: response.content });
    if (response.thinking_content)
      parts.push({ type: 'reasoning', content: response.thinking_content });
    if (response.tool_calls) parts.push(...response.tool_calls.map(toToolCallPart));
    if (parts.length)
      setJsonContent(attributes, 'gen_ai.output.messages', [{ role: 'assistant', parts }]);
  }
  return attributes;
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

function setJsonContent(attributes: SpanAttributes, key: string, value: unknown): void {
  try {
    const json = JSON.stringify(value);
    // Omit an oversized attribute whole: slicing the string would break JSON
    // and slicing a message could break the upstream message/part schema.
    if (json && new TextEncoder().encode(json).byteLength <= GEN_AI_CONTENT_ATTRIBUTE_MAX_BYTES) {
      attributes[key] = json;
    }
  } catch {
    // Caller-supplied tool schemas can be cyclic. Telemetry must not fail calls.
  }
}
