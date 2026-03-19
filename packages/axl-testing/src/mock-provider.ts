import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type {
  ChatMessage,
  ChatOptions,
  ToolCallMessage,
  ProviderResponse,
  StreamChunk,
  Provider,
} from '@axlsdk/axl';

function randomAlphanumeric(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function generateFromSchema(schema: unknown): unknown {
  if (schema instanceof z.ZodString) return randomAlphanumeric(8 + Math.floor(Math.random() * 13));
  if (schema instanceof z.ZodNumber) {
    const min = Number.isFinite(schema.minValue) ? schema.minValue! : 0;
    const max = Number.isFinite(schema.maxValue) ? schema.maxValue! : 100;
    return min + Math.random() * (max - min);
  }
  if (schema instanceof z.ZodBoolean) return Math.random() < 0.5;
  if (schema instanceof z.ZodArray) {
    const count = 1 + Math.floor(Math.random() * 3);
    return Array.from({ length: count }, () => generateFromSchema(schema.element));
  }
  if (schema instanceof z.ZodObject) {
    const obj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.shape)) obj[key] = generateFromSchema(value);
    return obj;
  }
  if (schema instanceof z.ZodOptional) {
    if (Math.random() < 0.5) return undefined;
    return generateFromSchema(schema.unwrap());
  }
  if (schema instanceof z.ZodDefault) return schema.parse(undefined);
  if (schema instanceof z.ZodEnum) {
    const values = schema.options;
    return values.length > 0 ? values[Math.floor(Math.random() * values.length)] : '';
  }
  if (schema instanceof z.ZodLiteral) return [...schema.values][0];
  if (schema instanceof z.ZodNullable) return null;
  if (schema instanceof z.ZodUnion) {
    const options = schema.options;
    return generateFromSchema(options[Math.floor(Math.random() * options.length)]);
  }
  return {};
}

export class MockProvider implements Provider {
  readonly name = 'mock';
  private _calls: { messages: ChatMessage[]; options: ChatOptions }[] = [];

  private constructor(
    private responseFn: (messages: ChatMessage[], callIndex: number) => ProviderResponse,
  ) {}

  get calls() {
    return this._calls;
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    this._calls.push({ messages, options });
    return this.responseFn(messages, this._calls.length - 1);
  }

  async *stream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const response = await this.chat(messages, options);
    if (response.content) {
      yield { type: 'text_delta', content: response.content };
    }
    if (response.tool_calls) {
      for (const tc of response.tool_calls) {
        yield {
          type: 'tool_call_delta',
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        };
      }
    }
    yield { type: 'done', usage: response.usage, providerMetadata: response.providerMetadata };
  }

  static sequence(
    responses: Array<{
      content: string;
      tool_calls?: ToolCallMessage[];
      providerMetadata?: Record<string, unknown>;
    }>,
  ): MockProvider {
    return new MockProvider((_messages, callIndex) => {
      if (callIndex >= responses.length) {
        throw new Error(
          `MockProvider.sequence: no response for call index ${callIndex}. Only ${responses.length} responses defined.`,
        );
      }
      return {
        content: responses[callIndex].content,
        tool_calls: responses[callIndex].tool_calls,
        providerMetadata: responses[callIndex].providerMetadata,
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: 0,
      };
    });
  }

  static echo(): MockProvider {
    return new MockProvider((messages) => {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      return {
        content: lastUser?.content ?? '',
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: 0,
      };
    });
  }

  static json(schema: unknown): MockProvider {
    return new MockProvider(() => ({
      content: JSON.stringify(generateFromSchema(schema)),
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      cost: 0,
    }));
  }

  static replay(source: string | ProviderResponse[]): MockProvider {
    const data =
      typeof source === 'string'
        ? (JSON.parse(readFileSync(source, 'utf-8')) as ProviderResponse[])
        : source;
    return new MockProvider((_messages, callIndex) => {
      if (callIndex >= data.length) {
        throw new Error(`MockProvider.replay: no recorded response for call index ${callIndex}`);
      }
      return data[callIndex];
    });
  }

  static fn(
    handler: (
      messages: ChatMessage[],
      callIndex: number,
    ) => {
      content: string;
      tool_calls?: ToolCallMessage[];
      providerMetadata?: Record<string, unknown>;
    },
  ): MockProvider {
    return new MockProvider((messages, callIndex) => ({
      ...handler(messages, callIndex),
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      cost: 0,
    }));
  }
}
