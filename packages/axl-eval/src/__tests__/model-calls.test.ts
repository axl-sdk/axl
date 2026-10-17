import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AxlError,
  AxlRuntime,
  RequestCaptureChannel,
  foldJournal,
  modelCallRecordSchema,
  type ChatMessage,
  type ChatOptions,
  type FoldedOperationRecord,
  type ModelCallRecord,
  type Provider,
} from '@axlsdk/axl';
import {
  defineEval,
  evalCompare,
  llmScorer,
  loadModelCalls,
  modelCallDataset,
  recordedModelCall,
  replayModelCall,
  rescore,
  runEval,
  scorer,
  type ModelCallInput,
  type ModelCallOutput,
} from '../index.js';

const capture = {
  fidelity: 'runtime_request',
  redacted: false,
  truncated: false,
  continuityCaptured: true,
  omitted: [],
} as const;
function record(
  options: {
    id?: string;
    kind?: 'chat' | 'stream';
    content?: string;
    responseFormat?: unknown;
    messages?: unknown[];
    tools?: unknown[];
    model?: string;
    provider?: string;
    outcome?: 'ok' | 'error';
    cost?: number;
  } = {},
): ModelCallRecord {
  const id = options.id ?? 'call';
  const kind = options.kind ?? 'chat';
  const provider = options.provider ?? 'fixture';
  const model = options.model ?? 'm';
  const common = {
    v: 1,
    kind,
    operationId: id,
    provider,
    model,
    transportAttempts: 1,
    captured: { ...capture, omitted: [] },
  };
  const start = {
    ...common,
    phase: 'start',
    request: {
      messages: options.messages ?? [{ role: 'user', content: 'prompt' }],
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
      options: { model },
    },
  };
  const end = {
    ...common,
    phase: 'end',
    ...(options.outcome === 'error'
      ? { error: { message: 'old failure' } }
      : {
          response: {
            content: options.content ?? 'recorded answer',
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            cost: options.cost ?? 0.01,
          },
        }),
  };
  const folded = foldJournal([start, end])[0];
  if (folded.kind === 'external') throw new Error('fixture should be a model call');
  return folded;
}
function externalRecord(): FoldedOperationRecord {
  const base = {
    v: 1,
    kind: 'external',
    operationId: 'external',
    name: 'vendor',
    transportAttempts: 1,
    captured: { fidelity: 'runtime_request', redacted: false, truncated: false, omitted: [] },
  };
  return foldJournal([
    { ...base, phase: 'start' },
    { ...base, phase: 'end', outcomeStatus: 'ok' },
  ])[0];
}
function input(recorded: ModelCallRecord): ModelCallInput {
  return {
    ...(recorded.request ? { request: recorded.request } : {}),
    ids: recorded.ids,
    attributes: recorded.attributes,
    recorded,
  };
}

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temporaryFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'axl-model-calls-'));
  tempDirs.push(dir);
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}

class RecordingProvider implements Provider {
  readonly name: string;
  readonly calls: Array<{
    kind: 'chat' | 'stream';
    messages: ChatMessage[];
    options: ChatOptions;
  }> = [];
  constructor(
    name = 'fixture',
    private readonly reply = 'fresh answer',
    private readonly charge = 0.03,
  ) {
    this.name = name;
  }
  async chat(messages: ChatMessage[], options: ChatOptions) {
    this.calls.push({ kind: 'chat', messages, options });
    return {
      content: this.reply,
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      cost: this.charge,
    };
  }
  async *stream(messages: ChatMessage[], options: ChatOptions) {
    this.calls.push({ kind: 'stream', messages, options });
    yield { type: 'text_delta' as const, content: 'fresh ' };
    yield { type: 'text_delta' as const, content: 'stream' };
    yield {
      type: 'done' as const,
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      cost: this.charge,
    };
  }
}
function runtimeWith(provider: RecordingProvider, key = provider.name): AxlRuntime {
  const runtime = new AxlRuntime({ defaultProvider: key, trace: { enabled: false } });
  runtime.registerProvider(key, provider);
  return runtime;
}

describe('model-call eval helpers', () => {
  it('replays a request emitted by the real capture channel with strict/origin and text parts intact', async () => {
    const producer = new RecordingProvider('fixture', '{"old":true}');
    const producingRuntime = runtimeWith(producer);
    const lines: unknown[] = [];
    const channel = new RequestCaptureChannel({
      sink: {
        append: async (line) => {
          lines.push(JSON.parse(line));
        },
      },
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system', origin: 'runtime' },
      {
        role: 'assistant',
        content: 'earlier',
        agent: 'writer',
        providerMetadata: { signed: 'opaque' },
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'A' },
          { type: 'text', text: '😀' },
          { type: 'text', text: 'B' },
        ],
      },
    ];
    const options: ChatOptions = {
      model: 'm',
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'find',
            parameters: { type: 'object' },
            strict: false,
          },
        },
      ],
      responseFormat: { type: 'json_object' },
      stop: ['END'],
      promptCache: true,
      effort: 'low',
    };
    await producingRuntime.trackOutcome(
      () => producingRuntime.resolveProvider('fixture:m').provider.chat(messages, options),
      { capture: channel },
    );
    await channel.close();
    const [captured] = foldJournal(lines);
    expect(captured.kind).toBe('chat');
    if (captured.kind === 'external') throw new Error('expected model call');
    expect(captured.captured.replayable).toBe(true);
    expect(captured.request?.messages[0].origin).toBe('runtime');
    expect(captured.request?.messages[1].agent).toBe('writer');
    expect(captured.request?.tools?.[0].strict).toBe(false);
    const consumer = new RecordingProvider('fixture', '{"fresh":true}');
    const replayRuntime = runtimeWith(consumer);
    expect((await replayModelCall()(input(captured), replayRuntime)).output).toEqual({
      content: '{"fresh":true}',
      json: { fresh: true },
    });
    expect(consumer.calls).toHaveLength(1);
    expect(consumer.calls[0].messages).toEqual(producer.calls[0].messages);
    for (const key of [
      'model',
      'tools',
      'responseFormat',
      'stop',
      'promptCache',
      'effort',
    ] as const)
      expect(consumer.calls[0].options[key]).toEqual(producer.calls[0].options[key]);
  });

  it('loads genuine 0.25.3 journals, v2 JSONL/arrays and in-memory mixed kinds', async () => {
    const legacy = fileURLToPath(
      new URL(
        '../../../axl/src/__tests__/fixtures/model-call-record/axl-0253.jsonl',
        import.meta.url,
      ),
    );
    const old = await loadModelCalls(legacy);
    expect(old.map((item) => item.outcome.status)).toEqual([
      'ok',
      'error',
      'consumer_closed',
      'unfinished',
    ]);
    expect(old[0].captured.replayable).toBe(false);
    expect(old[0]).not.toHaveProperty('startedAt');
    const model = record();
    const external = externalRecord();
    const jsonl = await temporaryFile(
      'records.jsonl',
      `${JSON.stringify(model)}\n\n${JSON.stringify(external)}\n`,
    );
    expect((await loadModelCalls(jsonl)).map((item) => item.kind)).toEqual(['chat', 'external']);
    const array = await temporaryFile('records.json', JSON.stringify([model, external]));
    expect((await loadModelCalls(array)).map((item) => item.id)).toEqual(['call', 'external']);
    expect((await loadModelCalls([model, external])).map((item) => item.kind)).toEqual([
      'chat',
      'external',
    ]);
    const v1Model = {
      v: 1,
      kind: 'chat',
      operationId: 'm1',
      provider: 'fixture',
      model: 'm',
      transportAttempts: 1,
      captured: { ...capture, omitted: [] },
    };
    const v1External = {
      v: 1,
      kind: 'external',
      operationId: 'e1',
      name: 'vendor',
      transportAttempts: 1,
      captured: { fidelity: 'runtime_request', redacted: false, truncated: false, omitted: [] },
    };
    expect(
      (
        await loadModelCalls([
          {
            ...v1Model,
            phase: 'start',
            request: { messages: [{ role: 'user', content: 'hi' }], options: { model: 'm' } },
          },
          { ...v1External, phase: 'start' },
          { ...v1Model, phase: 'end', response: { content: 'done' } },
          { ...v1External, phase: 'end', outcomeStatus: 'ok' },
        ])
      ).map((item) => item.kind),
    ).toEqual(['chat', 'external']);
  });

  it('validates every in-memory slot without invoking caller methods or accessors', async () => {
    const overridden = [record(), { ...record({ id: 'invalid' }), v: 3 }] as unknown[];
    let mapCalls = 0;
    Object.defineProperty(overridden, 'map', {
      value() {
        mapCalls++;
        return [];
      },
    });
    await expect(loadModelCalls(overridden)).rejects.toMatchObject({
      code: 'INVALID_MODEL_CALL_SOURCE',
      message: expect.stringMatching(/item 2/),
    });
    expect(mapCalls).toBe(0);

    let stringifyCalls = 0;
    const strangeVersion = [
      {
        v: {
          toString() {
            stringifyCalls++;
            throw new Error('should not stringify');
          },
        },
      },
    ];
    await expect(loadModelCalls(strangeVersion)).rejects.toMatchObject({
      code: 'INVALID_MODEL_CALL_SOURCE',
      message: expect.stringMatching(/item 1/),
    });
    expect(stringifyCalls).toBe(0);

    const accessor = [record()] as unknown[];
    let getterCalls = 0;
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get() {
        getterCalls++;
        throw new Error('should not run');
      },
    });
    await expect(loadModelCalls(accessor)).rejects.toMatchObject({
      code: 'INVALID_MODEL_CALL_SOURCE',
      message: expect.stringMatching(/item 1/),
    });
    expect(getterCalls).toBe(0);

    await expect(loadModelCalls(new Array(1))).rejects.toMatchObject({
      code: 'INVALID_MODEL_CALL_SOURCE',
      message: expect.stringMatching(/item 1/),
    });

    let datasetGetterCalls = 0;
    const datasetAccessor = [record()] as FoldedOperationRecord[];
    Object.defineProperty(datasetAccessor, '0', {
      enumerable: true,
      get() {
        datasetGetterCalls++;
        return record();
      },
    });
    expect(() => modelCallDataset(datasetAccessor)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_MODEL_CALL_SOURCE',
        message: expect.stringMatching(/record 1/),
      }),
    );
    expect(datasetGetterCalls).toBe(0);
    expect(() => modelCallDataset(new Array(1))).toThrowError(
      expect.objectContaining({ code: 'INVALID_MODEL_CALL_SOURCE' }),
    );
  });

  it('reports physical line numbers after blank separators and rejects malformed or mixed codecs', async () => {
    const model = record();
    for (const [body, expected] of [
      [`${JSON.stringify(model)}\n\n{broken}\n`, /line 3/],
      [`${JSON.stringify(model)}\n\n${JSON.stringify({ ...model, v: 3 })}\n`, /line 3/],
      [
        `${JSON.stringify(model)}\n\n${JSON.stringify({ ...model, id: 'second', captured: { ...model.captured, replayable: true, redacted: true } })}\n`,
        /line 3/,
      ],
      [
        `${JSON.stringify(model)}\n\n${JSON.stringify({ v: 1, phase: 'start', operationId: 'old', kind: 'chat', provider: 'fixture', model: 'm', transportAttempts: 1, captured: { ...capture, omitted: [] } })}\n`,
        /line 3.*mix v1/,
      ],
    ] as const) {
      const file = await temporaryFile('invalid.jsonl', body);
      await expect(loadModelCalls(file)).rejects.toMatchObject({
        name: 'AxlError',
        message: expect.stringMatching(expected),
      });
    }
    const malformed = await temporaryFile(
      'v1.jsonl',
      `${JSON.stringify({ v: 1, phase: 'start', operationId: 'x', kind: 'chat', provider: 'p', model: 'm', transportAttempts: 1, captured: { ...capture, omitted: [] } })}\n\n${JSON.stringify({ v: 1, phase: 'end', operationId: 'x', kind: 'chat', provider: 'other', model: 'm', transportAttempts: 1, captured: { ...capture, omitted: [] }, response: { content: 'x' } })}\n`,
    );
    await expect(loadModelCalls(malformed)).rejects.toThrow(/line 3/);
    const overlappingIds = await temporaryFile(
      'overlap.jsonl',
      [
        {
          v: 1,
          phase: 'start',
          operationId: 'op_1',
          kind: 'chat',
          provider: 'p',
          model: 'm',
          transportAttempts: 1,
          captured: { ...capture, omitted: [] },
        },
        {
          v: 1,
          phase: 'end',
          operationId: 'op_1',
          kind: 'chat',
          provider: 'p',
          model: 'm',
          transportAttempts: 1,
          termination: 'unknown terminal',
          captured: { ...capture, omitted: [] },
        },
        {
          v: 1,
          phase: 'start',
          operationId: 'op_10',
          kind: 'chat',
          provider: 'p',
          model: 'm',
          transportAttempts: 1,
          captured: { ...capture, omitted: [] },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    await expect(loadModelCalls(overlappingIds)).rejects.toThrow(/line 2/);
  });

  it('rejects external records unless explicitly filtered, and attaches typed annotations', async () => {
    const model = record();
    const external = externalRecord();
    expect(() => modelCallDataset([model, external])).toThrow(AxlError);
    const ds = modelCallDataset([model, external], {
      filter: (item) => item.kind !== 'external',
      annotate: () => ({ expected: 'recorded answer' }),
    });
    const items = await ds.getItems();
    expect(ds.name).toBe('model-calls');
    expect(items).toHaveLength(1);
    expect(items[0].input).toMatchObject({
      recorded: { id: 'call' },
      request: { options: { model: 'm' } },
    });
    expect(items[0].annotations).toEqual({ expected: 'recorded answer' });
  });

  it('uses ordinary runEval, rescore and compare without historical billing', async () => {
    const generation = record({ content: 'recorded answer', cost: 0.25 });
    const ds = modelCallDataset([generation], {
      annotate: () => ({ expected: 'recorded answer' }),
    });
    const quality = scorer<ModelCallOutput, ModelCallInput, { expected: string }>({
      name: 'quality',
      description: 'exact recorded output',
      score: (output, _input, annotation) => (output.content === annotation?.expected ? 1 : 0),
    });
    const evalConfig = defineEval({ workflow: 'recorded', dataset: ds, scorers: [quality] });
    const judgeProvider = new RecordingProvider('judge', '{"score":0.75,"reasoning":"okay"}', 0.02);
    const runtime = runtimeWith(judgeProvider, 'judge');
    const original = await runEval(evalConfig, recordedModelCall(), runtime);
    expect(original.items[0].output).toEqual({ content: 'recorded answer' });
    expect(original.summary.scorers.quality.mean).toBe(1);
    expect(original.accounting?.knownCost).toBe(0);
    expect(judgeProvider.calls).toHaveLength(0);
    const judge = llmScorer({
      name: 'quality',
      description: 'fresh judge',
      model: 'judge:m',
      system: 'Rate',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });
    const rescored = await rescore(original, [judge], runtime);
    expect(judgeProvider.calls).toHaveLength(1);
    expect(rescored.accounting?.scope).toBe('rescore');
    expect(rescored.accounting?.knownCost).toBe(0.02);
    expect(rescored.accounting?.source?.generation.knownCost).toBe(0);
    expect(() => evalCompare(original, rescored)).not.toThrow();
  });

  it('rescores a recorded tool-call turn with its tool calls and response identity', async () => {
    const base = record({ responseFormat: { type: 'json_object' } });
    if (base.outcome.status !== 'ok' || !('response' in base.outcome)) throw new Error('fixture');
    const toolTurn: ModelCallRecord = modelCallRecordSchema.parse({
      ...base,
      outcome: {
        status: 'ok',
        response: {
          content: '',
          thinking: 'look it up',
          tool_calls: [
            { id: 't1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } },
          ],
          finishReason: 'tool_calls',
          rawFinishReason: 'tool_use',
          responseId: 'msg_1',
          responseModel: 'm-2026',
          providerMetadata: { thinking: { signature: 'opaque' } },
        },
      },
    });
    // Opaque continuity data is replay input, not scorable output.
    expect((await recordedModelCall()(input(toolTurn))).output).toEqual({
      content: '',
      thinking: 'look it up',
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } },
      ],
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_use',
      responseId: 'msg_1',
      responseModel: 'm-2026',
    });
  });

  it('returns text or parsed JSON without reconstructing the original Zod validator', async () => {
    const executor = recordedModelCall();
    const text = record({ content: 'plain' });
    expect((await executor(input(text))).output).toEqual({ content: 'plain' });
    const jsonRecord = record({
      content: '{"value":"string"}',
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          schema: { type: 'object', properties: { value: { type: 'number' } } },
        },
      },
    });
    expect((await executor(input(jsonRecord))).output).toEqual({
      content: '{"value":"string"}',
      json: { value: 'string' },
    });
    const { request: _request, ...withoutRequest } = text;
    void _request;
    const stub: ModelCallRecord = modelCallRecordSchema.parse({
      ...withoutRequest,
      captured: { ...text.captured, replayable: false, truncated: true, omitted: ['record'] },
    });
    expect((await executor(input(stub))).output).toEqual({ content: 'plain' });
    for (const unavailable of [
      { ...text, captured: { ...text.captured, redacted: true, replayable: false } },
      {
        ...text,
        outcome: { status: 'ok', payloadOmitted: true },
        captured: { ...text.captured, truncated: true, replayable: false },
      },
      record({ outcome: 'error' }),
    ])
      await expect(executor(input(unavailable as ModelCallRecord))).rejects.toBeInstanceOf(
        AxlError,
      );
    const badJson = record({ content: 'broken', responseFormat: { type: 'json_object' } });
    await expect(executor(input(badJson))).rejects.toMatchObject({
      code: 'INVALID_MODEL_CALL_JSON',
    });
  });

  it('replays full history, text part boundaries, strict tools and runtime origin once with fresh accounting', async () => {
    const original = record({
      cost: 0.25,
      messages: [
        { role: 'system', content: 'system', origin: 'runtime' },
        {
          role: 'assistant',
          content: 'prior',
          agent: 'writer',
          providerMetadata: { thinking: { signature: 'signed' } },
          tool_calls: [
            { id: 'tool1', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' } },
          ],
        },
        { role: 'tool', content: 'result', tool_call_id: 'tool1' },
        {
          role: 'user',
          content: 'A😀B',
          input: {
            parts: [
              { type: 'text', characters: 1 },
              { type: 'text', characters: 2 },
              { type: 'text', characters: 1 },
            ],
          },
        },
      ],
      tools: [
        { name: 'lookup', description: 'find', parameters: { type: 'object' }, strict: false },
      ],
      responseFormat: { type: 'json_object' },
      content: '{"answer":"old"}',
    });
    expect(original.captured.replayable).toBe(true);
    const provider = new RecordingProvider('fixture', '{"answer":"fresh"}', 0.03);
    const runtime = runtimeWith(provider);
    const ds = modelCallDataset([original]);
    const config = defineEval({ workflow: 'replay', dataset: ds, scorers: [] });
    const result = await runEval(config, replayModelCall(), runtime);
    expect(result.items[0].output).toEqual({
      content: '{"answer":"fresh"}',
      json: { answer: 'fresh' },
    });
    expect(result.accounting?.knownCost).toBe(0.03);
    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0];
    expect(call.kind).toBe('chat');
    expect(call.messages).toEqual([
      { role: 'system', content: 'system', origin: 'runtime' },
      {
        role: 'assistant',
        content: 'prior',
        agent: 'writer',
        providerMetadata: { thinking: { signature: 'signed' } },
        tool_calls: [
          { id: 'tool1', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' } },
        ],
      },
      { role: 'tool', content: 'result', tool_call_id: 'tool1' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'A' },
          { type: 'text', text: '😀' },
          { type: 'text', text: 'B' },
        ],
      },
    ]);
    expect(call.options).toMatchObject({
      model: 'm',
      responseFormat: { type: 'json_object' },
      tools: [{ function: { name: 'lookup', description: 'find', strict: false } }],
    });
    expect(call.options).not.toHaveProperty('providerOptions');
  });

  it('replays stream mode, explicit model override, and non-ok originals without running tools', async () => {
    const stream = record({
      kind: 'stream',
      outcome: 'error',
      messages: [{ role: 'user', content: 'go' }],
    });
    const originalProvider = new RecordingProvider('fixture');
    const overrideProvider = new RecordingProvider('other');
    const runtime = runtimeWith(originalProvider);
    runtime.registerProvider('other', overrideProvider);
    const executor = replayModelCall({ model: 'other:new' });
    expect((await executor(input(stream), runtime)).output).toEqual({ content: 'fresh stream' });
    expect(overrideProvider.calls).toHaveLength(1);
    expect(overrideProvider.calls[0]).toMatchObject({ kind: 'stream', options: { model: 'new' } });
    expect(originalProvider.calls).toHaveLength(0);
    const invalidOverride = replayModelCall({ model: 'bare' });
    await expect(invalidOverride(input(stream), runtime)).rejects.toMatchObject({
      code: 'MODEL_CALL_MODEL_UNRESOLVED',
    });
  });

  it('requires an explicit URI when a captured custom provider name is not its registry alias', async () => {
    const captured = record({ provider: 'custom-adapter', model: 'm' });
    const provider = new RecordingProvider('custom-adapter');
    const runtime = runtimeWith(provider, 'registered-alias');
    await expect(replayModelCall()(input(captured), runtime)).rejects.toMatchObject({
      code: 'MODEL_CALL_MODEL_UNRESOLVED',
    });
    expect(provider.calls).toHaveLength(0);
    expect(
      (await replayModelCall({ model: 'registered-alias:m' })(input(captured), runtime)).output,
    ).toEqual({ content: 'fresh answer' });
    expect(provider.calls).toHaveLength(1);
  });

  it('preserves the captured option model verbatim when no override is requested', async () => {
    const captured = record({ model: 'fixture:m' });
    const provider = new RecordingProvider();
    const runtime = runtimeWith(provider);
    await replayModelCall()(input(captured), runtime);
    expect(provider.calls[0].options.model).toBe('fixture:m');
  });

  it('resolves native model names containing colons through the captured provider', async () => {
    const captured = record({ provider: 'custom', model: 'namespace:model' });
    const provider = new RecordingProvider('custom');
    const runtime = runtimeWith(provider);
    expect((await replayModelCall()(input(captured), runtime)).output).toEqual({
      content: 'fresh answer',
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].options.model).toBe('namespace:model');
  });

  it('stops on terminal stream done and returns the streamed tool call and response metadata', async () => {
    const captured = record({ kind: 'stream', responseFormat: { type: 'json_object' } });
    let closed = false;
    const provider: Provider = {
      name: 'fixture',
      async chat() {
        return { content: '' };
      },
      async *stream() {
        try {
          yield { type: 'thinking_delta' as const, content: 'need data' };
          yield { type: 'tool_call_delta' as const, id: 't', name: 'lookup', arguments: '{"q"' };
          yield { type: 'tool_call_delta' as const, id: 't', arguments: ':1}' };
          yield {
            type: 'done' as const,
            finishReason: 'tool_calls' as const,
            rawFinishReason: 'tool_use',
            responseId: 'resp_1',
            responseModel: 'm-2026',
          };
          await new Promise<never>(() => {});
        } finally {
          closed = true;
        }
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'fixture', trace: { enabled: false } });
    runtime.registerProvider('fixture', provider);
    // A JSON-format turn that answers with a tool call has no text to parse.
    expect((await replayModelCall()(input(captured), runtime)).output).toEqual({
      content: '',
      thinking: 'need data',
      tool_calls: [
        { id: 't', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } },
      ],
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_use',
      responseId: 'resp_1',
      responseModel: 'm-2026',
    });
    expect(closed).toBe(true);
  });

  it('rejects a replay stream that ends without a terminal done chunk', async () => {
    const captured = record({ kind: 'stream' });
    const provider: Provider = {
      name: 'fixture',
      async chat() {
        return { content: '' };
      },
      async *stream() {
        yield { type: 'text_delta', content: 'partial' };
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'fixture', trace: { enabled: false } });
    runtime.registerProvider('fixture', provider);
    await expect(replayModelCall()(input(captured), runtime)).rejects.toMatchObject({
      code: 'MODEL_CALL_STREAM_INCOMPLETE',
    });
  });

  it('returns the tool call of a tool-call-only replay without executing the tool', async () => {
    const captured = record();
    let calls = 0;
    const provider: Provider = {
      name: 'fixture',
      async chat() {
        calls++;
        return {
          content: '',
          tool_calls: [
            { id: 't', type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
          finishReason: 'tool_calls',
          responseId: 'chat_1',
          cost: 0.01,
        };
      },
      async *stream() {
        yield { type: 'done' };
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'fixture', trace: { enabled: false } });
    runtime.registerProvider('fixture', provider);
    expect((await replayModelCall()(input(captured), runtime)).output).toEqual({
      content: '',
      tool_calls: [{ id: 't', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      finishReason: 'tool_calls',
      responseId: 'chat_1',
    });
    expect(calls).toBe(1);
  });

  it('rejects invalid replay requests before provider dispatch', async () => {
    const good = record();
    const provider = new RecordingProvider();
    const runtime = runtimeWith(provider);
    const { request: _request, ...rest } = good;
    void _request;
    const variants = [
      { ...good, captured: { ...good.captured, redacted: true, replayable: false } },
      { ...good, captured: { ...good.captured, truncated: true, replayable: false } },
      { ...good, captured: { ...good.captured, replayable: false, continuityCaptured: undefined } },
      { ...rest, captured: { ...good.captured, replayable: false } },
      {
        ...good,
        request: { ...good.request, providerOptionKeys: ['token'] },
        captured: { ...good.captured, replayable: false, omitted: ['providerOptionValues'] },
      },
      {
        ...good,
        request: {
          ...good.request,
          options: {
            model: 'm',
            toolChoice: { type: 'function', function: { name: 'safe', extra: 'unsafe' } },
          },
        },
      },
      {
        ...good,
        request: {
          ...good.request,
          messages: [
            {
              role: 'user',
              content: null,
              input: {
                parts: [{ type: 'image', source: 'url', locator: 'https://example.com/image.png' }],
              },
            },
          ],
        },
        captured: { ...good.captured, replayable: false, omitted: ['media'] },
      },
    ];
    for (const variant of variants)
      await expect(
        replayModelCall()(input(variant as ModelCallRecord), runtime),
      ).rejects.toBeInstanceOf(AxlError);
    expect(provider.calls).toHaveLength(0);
    await expect(replayModelCall()(input(good))).rejects.toMatchObject({
      code: 'MODEL_CALL_RUNTIME_REQUIRED',
    });
    const legacy = await loadModelCalls(
      fileURLToPath(
        new URL(
          '../../../axl/src/__tests__/fixtures/model-call-record/axl-0253.jsonl',
          import.meta.url,
        ),
      ),
    );
    if (legacy[0].kind === 'external') throw new Error('expected model call');
    await expect(replayModelCall()(input(legacy[0]), runtime)).rejects.toBeInstanceOf(AxlError);
    expect(provider.calls).toHaveLength(0);
  });
});
