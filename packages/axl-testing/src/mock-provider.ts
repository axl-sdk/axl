import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type {
  CallTiming,
  ChatMessage,
  ChatOptions,
  InputContentPart,
  InputMediaSource,
  ModelInput,
  ToolCallMessage,
  ProviderResponse,
  StreamChunk,
  Provider,
  ProviderInputValidationRequest,
  ProviderInputValidationResult,
  EffortResolution,
} from '@axlsdk/axl';
import { inputText, UnsupportedModelInputError } from '@axlsdk/axl';

function cloneValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return value.slice();
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function cloneModelInput(input: ModelInput): ModelInput {
  if (typeof input === 'string') return input;
  return input.map((part): InputContentPart => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    const { source } = part;
    switch (source.type) {
      case 'bytes':
        return {
          type: 'image',
          source: { type: 'bytes', data: source.data.slice(), mediaType: source.mediaType },
          ...(part.label ? { label: part.label } : {}),
        };
      case 'url':
        return {
          type: 'image',
          source: {
            type: 'url',
            url: source.url,
            ...(source.mediaType ? { mediaType: source.mediaType } : {}),
          },
          ...(part.label ? { label: part.label } : {}),
        };
      case 'base64':
        return {
          type: 'image',
          source: { type: 'base64', data: source.data, mediaType: source.mediaType },
          ...(part.label ? { label: part.label } : {}),
        };
      case 'provider-file':
        return {
          type: 'image',
          source: {
            type: 'provider-file',
            provider: source.provider,
            reference: source.reference,
            ...(source.mediaType ? { mediaType: source.mediaType } : {}),
          },
          ...(part.label ? { label: part.label } : {}),
        };
    }
  });
}

function cloneMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: cloneModelInput(message.content),
    ...(message.tool_calls
      ? {
          tool_calls: message.tool_calls.map((toolCall) => ({
            ...toolCall,
            function: { ...toolCall.function },
          })),
        }
      : {}),
    ...(message.providerMetadata
      ? { providerMetadata: cloneValue(message.providerMetadata) as Record<string, unknown> }
      : {}),
  }));
}

function cloneOptions(options: ChatOptions): ChatOptions {
  return {
    ...options,
    ...(options.tools
      ? {
          tools: options.tools.map((tool) => ({
            ...tool,
            function: { ...tool.function, parameters: cloneValue(tool.function.parameters) },
          })),
        }
      : {}),
    ...(options.providerOptions
      ? { providerOptions: cloneValue(options.providerOptions) as Record<string, unknown> }
      : {}),
  };
}

function richParts(input: ModelInput): readonly InputContentPart[] {
  return typeof input === 'string' ? [] : input;
}

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
  /** Optional ms delay between successive chunks during `stream()`. Useful
   *  for dev fixtures that need to demonstrate streaming UX visually
   *  (without a delay, mock chunks fire synchronously and complete in
   *  microseconds — invisible to a human watching). Default 0 keeps
   *  every existing test fast.
   *
   *  Set via `provider.chunkDelayMs = 50` after construction. Not part of
   *  any factory's surface to keep the test API minimal. */
  chunkDelayMs = 0;

  /** How this mock reports the unified `effort` it was asked for. Undefined (the
   *  default) means the mock implements no `effortResolution` at all, so the
   *  runtime emits no `provider_diagnostic`. Set it with
   *  {@link MockProvider.withEffortResolution} to drive the clamp-reporting path. */
  effortResolution?: (
    options: Pick<
      ChatOptions,
      'model' | 'effort' | 'thinkingBudget' | 'includeThoughts' | 'providerOptions'
    >,
  ) => EffortResolution | undefined;

  /**
   * Make this mock report an effort clamp, so a test can exercise the runtime's
   * `provider_diagnostic` path without a real adapter. Pass a fixed
   * {@link EffortResolution} or a function of the request knobs.
   *
   * ```ts
   * const provider = MockProvider.echo().withEffortResolution({
   *   requested: 'none',
   *   effective: 'minimal',
   *   clamped: true,
   *   cause: 'this model cannot disable thinking',
   * });
   * ```
   */
  withEffortResolution(
    resolution:
      | EffortResolution
      | undefined
      | ((
          options: Pick<
            ChatOptions,
            'model' | 'effort' | 'thinkingBudget' | 'includeThoughts' | 'providerOptions'
          >,
        ) => EffortResolution | undefined),
  ): this {
    this.effortResolution = typeof resolution === 'function' ? resolution : () => resolution;
    return this;
  }

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
    // Each consumer gets independent ownership: a handler can inspect or mutate
    // its copy without changing the durable assertion record (including bytes).
    const recordedMessages = cloneMessages(messages);
    this._calls.push({ messages: recordedMessages, options: cloneOptions(options) });
    return await this.responseFn(cloneMessages(messages), this._calls.length - 1);
  }

  inputCapabilities(_model: string): { image: { sources: readonly InputMediaSource['type'][] } } {
    return { image: { sources: ['url', 'bytes', 'base64', 'provider-file'] } };
  }

  validateInput(request: ProviderInputValidationRequest): ProviderInputValidationResult {
    const effectiveModel =
      typeof request.providerOptions?.model === 'string'
        ? request.providerOptions.model
        : request.model;
    const fail = (source?: string, feature?: string): never => {
      throw new UnsupportedModelInputError({
        provider: this.name,
        model: effectiveModel || request.model,
        modality: 'image',
        ...(source ? { source } : {}),
        ...(feature ? { feature } : {}),
      });
    };

    if (request.providerOptions && 'input' in request.providerOptions) {
      fail(undefined, 'raw input-container providerOptions');
    }
    for (const message of request.history) {
      if (typeof message.content === 'string') continue;
      if (message.role !== 'user') fail(undefined, 'rich non-user history');
      for (const part of richParts(message.content)) {
        if (
          part.type === 'image' &&
          part.source.type === 'provider-file' &&
          part.source.provider !== this.name
        ) {
          fail('provider-file');
        }
      }
    }
    for (const part of richParts(request.input)) {
      if (
        part.type === 'image' &&
        part.source.type === 'provider-file' &&
        part.source.provider !== this.name
      ) {
        fail('provider-file');
      }
    }
    return { effectiveModel };
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
      for (let i = 0; i < chunks.length; i++) {
        yield { type: 'text_delta', content: chunks[i] };
        if (this.chunkDelayMs > 0 && i < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, this.chunkDelayMs));
        }
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
    yield {
      type: 'done',
      usage: response.usage,
      // Forwarded like `chat()` does. Without it a streamed mock ask reported no
      // cost at all, so `ctx.budget` and every cost assertion silently saw zero
      // on the streaming path while the same fixture priced correctly on the
      // non-streaming one — a mock that disagrees with itself between paths.
      cost: response.cost,
      providerMetadata: response.providerMetadata,
      // Conditional spread, not `timing: response.timing` — a mock response with
      // no timing must produce a `done` chunk with NO `timing` key at all, so a
      // consumer's `'timing' in chunk` check reads the same as a real adapter's.
      ...(response.timing ? { timing: response.timing } : {}),
    };
  }

  static sequence(
    responses: Array<{
      content: string;
      tool_calls?: ToolCallMessage[];
      providerMetadata?: Record<string, unknown>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      cost?: number;
      /** Deterministic provider-call timing, surfaced on `ProviderResponse.timing`
       *  and on the streamed terminal `done` chunk. Lets a test drive
       *  `agent_call_end.timing`, the `TimeoutError` breakdown, and the eval
       *  per-model rollup without real clocks or a real transport. Omit it and
       *  the mock behaves exactly like an uninstrumented custom provider. */
      timing?: CallTiming;
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
        // Copied, not shared: the caller keeps ownership of the fixture, so a
        // consumer that mutates the returned block cannot corrupt a later call's
        // expectation (same rule the message/options clones follow).
        ...(resp.timing ? { timing: { ...resp.timing } } : {}),
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
        content: lastUser ? inputText(lastUser.content) : '',
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
          /** Per-call timing — see the `timing` note on {@link MockProvider.sequence}. */
          timing?: CallTiming;
        }
      | Promise<{
          content: string;
          tool_calls?: ToolCallMessage[];
          providerMetadata?: Record<string, unknown>;
          usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          cost?: number;
          /** Per-call timing — see the `timing` note on {@link MockProvider.sequence}. */
          timing?: CallTiming;
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
