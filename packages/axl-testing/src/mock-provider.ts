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
  /** Per-call optional chunk arrays, set by `sequence()` / `chunked()` so
   *  `stream()` can yield one `text_delta` per chunk. Per-call indexed
   *  alongside the response sequence. */
  private chunkSequence?: Array<string[] | undefined>;

  private constructor(
    private responseFn: (
      messages: ChatMessage[],
      callIndex: number,
    ) => ProviderResponse | Promise<ProviderResponse>,
  ) {}

  get calls() {
    return this._calls;
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    this._calls.push({ messages, options });
    return await this.responseFn(messages, this._calls.length - 1);
  }

  async *stream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const callIndex = this._calls.length;
    const response = await this.chat(messages, options);
    const chunks = this.chunkSequence?.[callIndex];
    if (chunks && chunks.length > 0) {
      // Sanity guard — if a caller passes chunks AND content, they MUST
      // match. Otherwise tests pass while the real prod content silently
      // diverges from what the streaming path observes.
      const joined = chunks.join('');
      if (joined !== response.content) {
        throw new Error(
          `MockProvider.stream: chunks.join('') !== content. ` +
            `chunks="${joined}" content="${response.content}"`,
        );
      }
      for (const chunk of chunks) {
        yield { type: 'text_delta', content: chunk };
      }
    } else if (response.content) {
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
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      cost?: number;
      /** When set, `stream()` yields one `text_delta` per entry instead
       *  of one big delta with the full content. Use to exercise
       *  partial-JSON parsing, structural-boundary throttling, and
       *  cross-attempt token retention in tests. Must satisfy
       *  `chunks.join('') === content`. */
      chunks?: string[];
    }>,
  ): MockProvider {
    const provider = new MockProvider((_messages, callIndex) => {
      if (callIndex >= responses.length) {
        throw new Error(
          `MockProvider.sequence: no response for call index ${callIndex}. Only ${responses.length} responses defined.`,
        );
      }
      const resp = responses[callIndex];
      return {
        content: resp.content,
        tool_calls: resp.tool_calls,
        providerMetadata: resp.providerMetadata,
        usage: resp.usage ?? { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: resp.cost ?? 0,
      };
    });
    provider.chunkSequence = responses.map((r) => r.chunks);
    return provider;
  }

  /**
   * Convenience: build a `sequence()` from plain content strings, splitting
   * each one into fixed-size chunks for the streaming path. Default
   * `chunkSize` is 4 chars (≈1 token).
   */
  static chunked(contents: string[], chunkSize = 4): MockProvider {
    const responses = contents.map((content) => {
      const chunks: string[] = [];
      for (let i = 0; i < content.length; i += chunkSize) {
        chunks.push(content.slice(i, i + chunkSize));
      }
      return { content, chunks };
    });
    return MockProvider.sequence(responses);
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
    ) =>
      | {
          content: string;
          tool_calls?: ToolCallMessage[];
          providerMetadata?: Record<string, unknown>;
          usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          cost?: number;
        }
      | Promise<{
          content: string;
          tool_calls?: ToolCallMessage[];
          providerMetadata?: Record<string, unknown>;
          usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          cost?: number;
        }>,
  ): MockProvider {
    return new MockProvider(async (messages, callIndex) => {
      const result = await handler(messages, callIndex);
      return {
        ...result,
        usage: result.usage ?? { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: result.cost ?? 0,
      };
    });
  }
}
