import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import type { WorkflowContextInit } from '../context.js';
import { InvalidModelInputError, UnsupportedModelInputError } from '../errors.js';
import { inputText, normalizeModelInput, type ModelInput } from '../input.js';
import { ProviderRegistry } from '../providers/registry.js';
import { redactEvent, REDACTED } from '../redaction.js';
import type { AxlEvent, ChatMessage } from '../types.js';
import type {
  ChatOptions,
  Provider,
  ProviderInputValidationRequest,
  ProviderResponse,
  StreamChunk,
} from '../providers/types.js';
import type { StateStore } from '../state/types.js';
import type { SpanManager } from '../telemetry/types.js';

class InputProvider implements Provider {
  readonly name = 'input';
  calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  validations: string[] = [];
  requests: ProviderInputValidationRequest[] = [];

  validateInput(request: ProviderInputValidationRequest): { effectiveModel: string } {
    this.validations.push(request.model);
    this.requests.push(request);
    return { effectiveModel: `${request.model}-effective` };
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    this.calls.push({ messages, options });
    return {
      content: '{"ok":true}',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  async *stream(): AsyncGenerator<StreamChunk> {
    yield { type: 'done', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  }
}

class SequencedInputProvider extends InputProvider {
  private index = 0;

  constructor(private readonly responses: Array<Partial<ProviderResponse>>) {
    super();
  }

  override async chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    this.calls.push({ messages, options });
    const response = this.responses[this.index++] ?? { content: 'done' };
    return {
      content: response.content ?? '',
      tool_calls: response.tool_calls,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
}

function context(
  provider: Provider,
  traces: AxlEvent[] = [],
  init: Partial<WorkflowContextInit> = {},
) {
  const registry = new ProviderRegistry();
  registry.registerInstance('input', provider);
  return new WorkflowContext({
    input: 'test',
    executionId: 'model-input-test',
    config: {},
    providerRegistry: registry,
    onTrace: (event) => traces.push(event),
    ...init,
  });
}

const image = [
  {
    type: 'image',
    label: 'receipt',
    source: { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
  },
  { type: 'text', text: 'Read this.' },
] as const satisfies Exclude<ModelInput, string>;

describe('ModelInput', () => {
  it('keeps legacy string projection byte-for-byte and validates rich source shapes', () => {
    expect(inputText('line one\nline two')).toBe('line one\nline two');
    expect(inputText(image)).toBe('Read this.');
    expect(() => normalizeModelInput([])).toThrow(InvalidModelInputError);
    expect(() =>
      normalizeModelInput([
        { type: 'image', source: { type: 'url', url: 'file:///secret' } },
      ] as never),
    ).toThrow(InvalidModelInputError);
  });

  it('preflights rich input before a call and dispatches its effective model', async () => {
    const provider = new InputProvider();
    const traces: AxlEvent[] = [];
    const result = await context(provider, traces).ask(
      agent({ model: 'input:vision', system: 'inspect' }),
      image,
      {
        schema: z.object({ ok: z.boolean() }),
      },
    );

    expect(result).toEqual({ ok: true });
    expect(provider.validations).toEqual(['vision']);
    expect(provider.calls[0].options.model).toBe('vision-effective');
    expect(provider.calls[0].messages.at(-1)?.content).toEqual([
      image[0],
      image[1],
      expect.objectContaining({ type: 'text' }),
    ]);
    const start = traces.find((event) => event.type === 'agent_call_start');
    const end = traces.find((event) => event.type === 'agent_call_end');
    expect(start?.model).toBe('input:vision-effective');
    expect(end?.model).toBe('input:vision-effective');
    expect(start?.data.input?.parts).toEqual([
      expect.objectContaining({ type: 'image', source: 'bytes', bytes: 3, label: 'receipt' }),
      { type: 'text', characters: 10 },
    ]);
  });

  it('keeps the exact legacy model URI for a string call across event and callback surfaces', async () => {
    const provider = new InputProvider();
    const traces: AxlEvent[] = [];
    let callbackModel: string | undefined;
    await context(provider, traces, {
      onAgentCallComplete: (call) => {
        callbackModel = call.model;
      },
    }).ask(agent({ model: 'input:legacy-style', system: 'inspect' }), 'plain text');
    expect(provider.calls[0].options.model).toBe('legacy-style');
    expect(traces.find((event) => event.type === 'agent_call_start')?.model).toBe(
      'input:legacy-style',
    );
    expect(traces.find((event) => event.type === 'agent_call_end')?.model).toBe(
      'input:legacy-style',
    );
    expect(callbackModel).toBe('input:legacy-style');
  });

  it('keeps full-trace rich history descriptor-only and redacts its locator/label', async () => {
    const provider = new InputProvider();
    const traces: AxlEvent[] = [];
    const history: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            label: 'private label',
            source: {
              type: 'url',
              url: 'https://example.test/private.png',
              mediaType: 'image/png',
            },
          },
        ],
      },
    ];
    await context(provider, traces, {
      config: { trace: { level: 'full' } },
      sessionHistory: history,
    }).ask(agent({ model: 'input:vision', system: 'inspect' }), 'continue');
    const start = traces.find((event) => event.type === 'agent_call_start')!;
    expect(JSON.stringify(start.data.messages)).not.toContain('private.png');
    expect(start.data.messageInputs).toEqual([
      expect.objectContaining({
        index: 1,
        input: expect.objectContaining({
          parts: [
            expect.objectContaining({
              locator: 'https://example.test/private.png',
              label: 'private label',
            }),
          ],
        }),
      }),
    ]);
    const redacted = redactEvent(start);
    const input = redacted.data.messageInputs?.[0].input.parts[0] as {
      locator?: string;
      label?: string;
    };
    expect(input.locator).toBe(REDACTED);
    expect(input.label).toBe(REDACTED);
  });

  it('fails closed for a text-only provider before guardrails or target dispatch', async () => {
    const provider: Provider = {
      name: 'text-only',
      chat: async () => ({ content: 'never' }),
      stream: async function* () {
        yield { type: 'done', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      },
    };
    const traces: AxlEvent[] = [];
    let guardrailCalls = 0;
    const a = agent({
      model: 'input:no-vision',
      system: 'inspect',
      guardrails: {
        input: () => {
          guardrailCalls++;
          return { block: false };
        },
      },
    });
    await expect(context(provider, traces).ask(a, image)).rejects.toBeInstanceOf(
      UnsupportedModelInputError,
    );
    expect(guardrailCalls).toBe(0);
    expect(traces.filter((event) => event.type === 'agent_call_start')).toHaveLength(0);
    expect(traces.filter((event) => event.type === 'ask_start')).toHaveLength(1);
    expect(traces.filter((event) => event.type === 'ask_end')).toHaveLength(1);
  });

  it('rejects malformed any input before checkpointing or emitting a descriptor', async () => {
    const provider = new InputProvider();
    const traces: AxlEvent[] = [];
    await expect(
      context(provider, traces).ask(agent({ model: 'input:vision', system: 'inspect' }), [
        null,
      ] as never),
    ).rejects.toBeInstanceOf(InvalidModelInputError);
    expect(traces).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('takes ownership before an asynchronous checkpoint can expose caller mutation', async () => {
    const provider = new InputProvider();
    let releaseCheckpoint: (() => void) | undefined;
    const store = {
      getCheckpoint: () =>
        new Promise<null>((resolve) => {
          releaseCheckpoint = () => resolve(null);
        }),
      saveCheckpoint: async () => {},
    } as StateStore;
    const mutable: ModelInput = [
      {
        type: 'image',
        label: 'original',
        source: { type: 'bytes', data: new Uint8Array([4, 5]), mediaType: 'image/png' },
      },
      { type: 'text', text: 'Inspect' },
    ];
    const pending = context(provider, [], { stateStore: store }).ask(
      agent({ model: 'input:vision', system: 'inspect' }),
      mutable,
    );
    await Promise.resolve();
    (mutable[0] as { label?: string }).label = 'changed';
    (mutable[0] as { source: { data: Uint8Array } }).source.data[0] = 99;
    releaseCheckpoint?.();
    await pending;
    const sent = provider.calls[0].messages.at(-1)?.content as Exclude<ModelInput, string>;
    expect(sent[0]).toMatchObject({ label: 'original' });
    expect((sent[0] as { source: { data: Uint8Array } }).source.data[0]).toBe(4);
  });

  it('preflights rich application history for a text ask before context work', async () => {
    const provider = new InputProvider();
    const history: ChatMessage[] = [{ role: 'user', content: image }];
    await context(provider, [], { sessionHistory: history }).ask(
      agent({ model: 'input:vision', system: 'inspect' }),
      'Summarize it',
    );
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].input).toBe('Summarize it');
    expect(provider.requests[0].history[0].content).toEqual(image);
  });

  it('rejects raw input container overrides before validator or dispatch', async () => {
    const provider = new InputProvider();
    await expect(
      context(provider).ask(agent({ model: 'input:vision', system: 'inspect' }), image, {
        providerOptions: { messages: [] },
      }),
    ).rejects.toBeInstanceOf(UnsupportedModelInputError);
    expect(provider.validations).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('rejects unsupported oversized rich history before summary or target calls', async () => {
    let calls = 0;
    const provider: Provider = {
      name: 'text-only',
      chat: async () => {
        calls++;
        return { content: 'never' };
      },
      stream: async function* () {
        yield { type: 'done', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      },
    };
    const traces: AxlEvent[] = [];
    await expect(
      context(provider, traces, { sessionHistory: [{ role: 'user', content: image }] }).ask(
        agent({ model: 'input:no-vision', system: 'inspect', maxContext: 1 }),
        'text only',
      ),
    ).rejects.toBeInstanceOf(UnsupportedModelInputError);
    expect(calls).toBe(0);
    expect(traces.filter((event) => event.type === 'agent_call_start')).toHaveLength(0);
    expect(traces.filter((event) => event.type === 'ask_start')).toHaveLength(1);
    expect(traces.filter((event) => event.type === 'ask_end')).toHaveLength(1);
  });

  it('marks rich history context contribution unmeasured and summarizes only safe placeholders', async () => {
    const provider = new InputProvider();
    const traces: AxlEvent[] = [];
    const base64 = 'c2Vuc2l0aXZl';
    await context(provider, traces, {
      sessionHistory: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              label: 'private',
              source: { type: 'base64', data: base64, mediaType: 'image/png' },
            },
            { type: 'text', text: 'x'.repeat(500) },
          ],
        },
      ],
    }).ask(agent({ model: 'input:vision', system: 'inspect', maxContext: 1 }), 'continue');
    const warnings = traces.filter((event) => event.type === 'log' && event.data?.warning);
    expect(warnings).toHaveLength(1);
    expect(provider.calls[0].messages[1].content).toContain('[image image/png]');
    expect(String(provider.calls[0].messages[1].content)).not.toContain(base64);
    expect(JSON.stringify(traces)).not.toContain(base64);
    expect(JSON.stringify(traces)).not.toContain('[object Object]');
  });

  it('preserves rich evidence once and appends a changed roundtrip handoff instruction', async () => {
    const provider = new SequencedInputProvider([
      {
        tool_calls: [
          {
            id: 'handoff',
            type: 'function',
            function: {
              name: 'handoff_to_target',
              arguments: '{"message":"Analyze only the totals"}',
            },
          },
        ],
      },
      { content: 'target result' },
      { content: 'source result' },
    ]);
    const target = agent({ name: 'target', model: 'input:vision', system: 'target' });
    const source = agent({
      name: 'source',
      model: 'input:vision',
      system: 'source',
      handoffs: [{ agent: target, mode: 'roundtrip' }],
    });
    await context(provider).ask(source, image);
    const targetInput = provider.calls[1].messages.find((message) => Array.isArray(message.content))
      ?.content as Exclude<ModelInput, string>;
    expect(targetInput.filter((part) => part.type === 'image')).toHaveLength(1);
    expect(targetInput.at(-1)).toEqual({ type: 'text', text: 'Analyze only the totals' });
  });

  it('keeps root handoff callback and span attribution on the source model', async () => {
    const provider = new SequencedInputProvider([
      {
        tool_calls: [
          {
            id: 'handoff',
            type: 'function',
            function: { name: 'handoff_to_target', arguments: '{}' },
          },
        ],
      },
      { content: 'target result' },
      { content: 'source result' },
    ]);
    const traces: AxlEvent[] = [];
    let callbackModel: string | undefined;
    const spans: Array<{ name: string; attributes: Record<string, string | number | boolean> }> =
      [];
    const spanManager: SpanManager = {
      async withSpanAsync(name, attributes, fn) {
        const record = { name, attributes: { ...attributes } };
        spans.push(record);
        return fn({
          setAttribute: (key, value) => {
            record.attributes[key] = value;
          },
          addEvent: () => {},
          setStatus: () => {},
          end: () => {},
        });
      },
      addEventToActiveSpan: () => {},
      shutdown: async () => {},
    };
    const target = agent({ name: 'target', model: 'input:target-uri', system: 'target' });
    const source = agent({
      name: 'source',
      model: 'input:source-uri',
      system: 'source',
      handoffs: [{ agent: target, mode: 'roundtrip' }],
    });
    await context(provider, traces, {
      spanManager,
      onAgentCallComplete: (call) => {
        callbackModel = call.model;
      },
    }).ask(source, 'route');
    expect(callbackModel).toBe('input:source-uri');
    expect(spans.find((span) => span.name === 'axl.agent.ask')?.attributes['axl.agent.model']).toBe(
      'input:source-uri',
    );
    const callStarts = traces.filter((event) => event.type === 'agent_call_start');
    expect(
      callStarts.filter((event) => event.agent === 'source').map((event) => event.model),
    ).toEqual(['input:source-uri', 'input:source-uri']);
    expect(
      callStarts.filter((event) => event.agent === 'target').map((event) => event.model),
    ).toEqual(['input:target-uri']);
  });

  it('routes text-only when requested but gives the selected delegate full evidence plus instruction', async () => {
    const provider = new SequencedInputProvider([
      {
        tool_calls: [
          {
            id: 'handoff',
            type: 'function',
            function: { name: 'handoff_to_worker', arguments: '{"message":"Check the receipt"}' },
          },
        ],
      },
      { content: 'worker result' },
    ]);
    const worker = agent({ name: 'worker', model: 'input:vision', system: 'worker' });
    const other = agent({ name: 'other', model: 'input:vision', system: 'other' });
    await context(provider).delegate([worker, other], image, { routerInput: 'text' });
    expect(provider.calls[0].messages.at(-1)?.content).toBe('Read this.');
    const targetInput = provider.calls[1].messages.find((message) => Array.isArray(message.content))
      ?.content as Exclude<ModelInput, string>;
    expect(targetInput.filter((part) => part.type === 'image')).toHaveLength(1);
    expect(targetInput.at(-1)).toEqual({ type: 'text', text: 'Check the receipt' });
  });

  it('retains one ordered image through schema, validate, and output-guardrail retries', async () => {
    const imageCount = (provider: InputProvider) =>
      provider.calls.map(
        (call) =>
          (
            call.messages.find((message) => Array.isArray(message.content))?.content as Exclude<
              ModelInput,
              string
            >
          ).filter((part) => part.type === 'image').length,
      );
    const schemaProvider = new SequencedInputProvider([
      { content: '{' },
      { content: '{"ok":true}' },
    ]);
    await context(schemaProvider).ask(agent({ model: 'input:vision', system: 'schema' }), image, {
      schema: z.object({ ok: z.boolean() }),
      retries: 1,
    });
    expect(imageCount(schemaProvider)).toEqual([1, 1]);

    const validateProvider = new SequencedInputProvider([
      { content: '{"ok":true}' },
      { content: '{"ok":true}' },
    ]);
    let validateAttempt = 0;
    await context(validateProvider).ask(
      agent({ model: 'input:vision', system: 'validate' }),
      image,
      {
        schema: z.object({ ok: z.boolean() }),
        validateRetries: 1,
        validate: () => ({ valid: ++validateAttempt > 1 }),
      },
    );
    expect(imageCount(validateProvider)).toEqual([1, 1]);

    const guardrailProvider = new SequencedInputProvider([{ content: 'bad' }, { content: 'good' }]);
    await context(guardrailProvider).ask(
      agent({
        model: 'input:vision',
        system: 'guardrail',
        guardrails: {
          output: (response) => ({ block: response === 'bad' }),
          maxRetries: 1,
          onBlock: 'retry',
        },
      }),
      image,
    );
    expect(imageCount(guardrailProvider)).toEqual([1, 1]);
  });

  it('isolates sibling-branch guardrail mutation from the runtime-owned image', async () => {
    const provider = new InputProvider();
    const mutating = agent({
      name: 'mutating',
      model: 'input:vision',
      system: 'mutating',
      guardrails: {
        input: (_text, ctx) => {
          (
            (ctx.input as Exclude<ModelInput, string>)[0] as { source: { data: Uint8Array } }
          ).source.data[0] = 77;
          return { block: false };
        },
      },
    });
    const sibling = agent({ name: 'sibling', model: 'input:vision', system: 'sibling' });
    const ctx = context(provider);
    await ctx.parallel([() => ctx.ask(mutating, image), () => ctx.ask(sibling, image)]);
    for (const call of provider.calls) {
      const sent = call.messages.at(-1)?.content as Exclude<ModelInput, string>;
      expect((sent[0] as { source: { data: Uint8Array } }).source.data[0]).toBe(1);
    }
  });

  it('protects the owned input from guardrail mutation and removes inline media from full traces', async () => {
    const provider = new InputProvider();
    const traces: AxlEvent[] = [];
    const a = agent({
      model: 'input:vision',
      system: 'inspect',
      guardrails: {
        input: (_text, guardrail) => {
          const parts = guardrail.input as Exclude<ModelInput, string>;
          (parts[0] as { label?: string }).label = 'mutated';
          ((parts[0] as { source: { data?: Uint8Array } }).source.data as Uint8Array)[0] = 99;
          return { block: false };
        },
      },
    });
    await context(provider, traces).ask(a, image);
    const sent = provider.calls[0].messages.at(-1)?.content as Exclude<ModelInput, string>;
    const sentImage = sent[0] as { type: 'image'; label?: string; source: { data: Uint8Array } };
    expect(sent[0]).toMatchObject({ type: 'image', label: 'receipt' });
    expect(sentImage.source.data[0]).toBe(1);
    expect(JSON.stringify(traces)).not.toContain('AQID');
    expect(JSON.stringify(traces)).not.toContain('"data":{"0":1,"1":2,"2":3}');
  });
});
