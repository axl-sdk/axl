import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { z } from 'zod';
import { AdmissionController } from '../accounting.js';
import { agent } from '../agent.js';
import { StallTimeoutError } from '../errors.js';
import { AxlRuntime } from '../runtime.js';
import { OpenAIProvider } from '../providers/openai.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import type { ChatOptions, Provider, StreamChunk } from '../providers/types.js';
import { createScopedProvider } from '../providers/scoped-provider.js';
import { OTelSpanManager } from '../telemetry/span-manager.js';
import type { SpanManager } from '../telemetry/types.js';
import { workflow } from '../workflow.js';
import { deferred } from './accounting-helpers.js';

describe('runtime GenAI inference spans', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager());
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    context.disable();
    trace.disable();
    await provider.shutdown();
  });

  function runtime(
    raw: Provider,
    options?: { captureContent?: boolean; redact?: boolean; maxContentAttributeBytes?: number },
  ): AxlRuntime {
    const result = new AxlRuntime({
      defaultProvider: raw.name,
      telemetry: {
        enabled: true,
        tracerProvider: provider,
        captureContent: options?.captureContent,
        ...(options?.maxContentAttributeBytes !== undefined
          ? { maxContentAttributeBytes: options.maxContentAttributeBytes }
          : {}),
      },
      trace: { redact: options?.redact },
    });
    result.registerProvider(raw.name, raw);
    return result;
  }

  it('uses a cached public facade after initialization and parents a direct call under the app span', async () => {
    const raw: Provider = {
      name: 'fixture',
      reportsRequestLifecycle: true,
      effortResolution: () => ({ requested: 'high', effective: 'medium', clamped: true }),
      async chat(_messages, options) {
        options.requestLifecycle?.onDispatch?.();
        options.requestLifecycle?.onRetry?.();
        options.requestLifecycle?.onDispatch?.();
        return {
          content: 'answer',
          finishReason: 'stop',
          responseId: 'response-1',
          responseModel: 'm-actual',
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cached_tokens: 2 },
        };
      },
      async *stream() {
        yield { type: 'done' };
      },
    };
    const axl = runtime(raw, { captureContent: true });
    const facade = axl.resolveProvider('fixture:m').provider;
    await axl.initializeTelemetry();
    const startSpan = vi.spyOn(OTelSpanManager.prototype, 'startSpan');
    await provider.getTracer('app').startActiveSpan('app', async (parent) => {
      await facade.chat([{ role: 'user', content: 'question' }], {
        model: 'm',
        effort: 'high',
        stop: ['stop'],
      });
      parent.end();
    });

    const spans = exporter.getFinishedSpans();
    const inference = spans.find((span) => span.name === 'chat m')!;
    const parent = spans.find((span) => span.name === 'app')!;
    expect(spans.filter((span) => span.name === 'chat m')).toHaveLength(1);
    expect(startSpan).toHaveBeenCalledTimes(1);
    expect(inference.kind).toBe(2);
    expect(inference.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(inference.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'fixture',
      'gen_ai.request.model': 'm',
      'gen_ai.request.stream': false,
      'gen_ai.request.reasoning.level': 'medium',
      'gen_ai.request.stop_sequences': ['stop'],
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.response.id': 'response-1',
      'gen_ai.response.model': 'm-actual',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 4,
      'gen_ai.usage.cache_read.input_tokens': 2,
    });
    expect(JSON.parse(inference.attributes['gen_ai.input.messages'] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'question' }] },
    ]);
    expect(JSON.parse(inference.attributes['gen_ai.output.messages'] as string)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'answer' }] },
    ]);
  });

  it('uses the actual OpenAI request body as the reasoning truth when providerOptions overrides effort', async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: 'resp-fixture',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const axl = runtime(new OpenAIProvider({ apiKey: 'test-key' }));
    await axl.initializeTelemetry();
    const facade = axl.resolveProvider('openai:gpt-5.6').provider;
    const messages = [{ role: 'user' as const, content: 'Reply ok' }];
    await facade.chat(messages, { model: 'gpt-5.6', effort: 'max', maxTokens: 32 });
    await facade.chat(messages, {
      model: 'gpt-5.6',
      effort: 'max',
      maxTokens: 32,
      providerOptions: { reasoning_effort: 'high' },
    });
    const bodies = fetch.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>,
    );
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['xhigh', 'high']);
    const spans = exporter.getFinishedSpans().filter((span) => span.name === 'chat gpt-5.6');
    expect(spans).toHaveLength(2);
    expect(spans[0].attributes['gen_ai.request.reasoning.level']).toBe('xhigh');
    expect(spans[1].attributes).not.toHaveProperty('gen_ai.request.reasoning.level');
  });

  it('exports system instructions separately only when the real API does', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const url = input instanceof Request ? input.url : String(input);
        return new Response(
          JSON.stringify(
            url.includes('/responses')
              ? { id: 'resp-1', model: 'gpt-4o', status: 'completed', output: [] }
              : {
                  id: 'chat-1',
                  model: 'gpt-4o',
                  choices: [
                    { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
                  ],
                },
          ),
        );
      }),
    );
    const messages = [
      { role: 'system' as const, content: 'Be concise' },
      { role: 'user' as const, content: 'Say ok' },
    ];
    const responsesRuntime = runtime(new OpenAIResponsesProvider({ apiKey: 'test-key' }), {
      captureContent: true,
    });
    await responsesRuntime.initializeTelemetry();
    await responsesRuntime
      .resolveProvider('openai-responses:gpt-4o')
      .provider.chat(messages, { model: 'gpt-4o' });
    const chatRuntime = runtime(new OpenAIProvider({ apiKey: 'test-key' }), {
      captureContent: true,
    });
    await chatRuntime.initializeTelemetry();
    await chatRuntime.resolveProvider('openai:gpt-4o').provider.chat(messages, { model: 'gpt-4o' });

    expect(bodies[0].instructions).toBe('Be concise');
    expect(JSON.stringify(bodies[0].input)).not.toContain('Be concise');
    expect((bodies[1].messages as Array<{ role: string }>)[0].role).toBe('system');
    const spans = exporter.getFinishedSpans().filter((span) => span.name === 'chat gpt-4o');
    expect(spans).toHaveLength(2);
    expect(JSON.parse(spans[0].attributes['gen_ai.system_instructions'] as string)).toEqual([
      { type: 'text', content: 'Be concise' },
    ]);
    expect(JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Say ok' }] },
    ]);
    expect(spans[1].attributes).not.toHaveProperty('gen_ai.system_instructions');
    expect(JSON.parse(spans[1].attributes['gen_ai.input.messages'] as string)).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'Be concise' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Say ok' }] },
    ]);
  });

  it('parents an inference span under the ask span without a capture scope', async () => {
    const raw: Provider = {
      name: 'ask-fixture',
      reportsRequestLifecycle: true,
      async chat(_messages, options) {
        options.requestLifecycle?.onDispatch?.();
        return { content: 'answer', cost: 0.01 };
      },
      async *stream() {
        yield { type: 'done' };
      },
    };
    const axl = runtime(raw);
    axl.register(
      workflow({
        name: 'ask',
        input: z.any(),
        handler: (ctx) =>
          ctx.ask(agent({ name: 'worker', model: 'ask-fixture:m', system: 'system' }), 'go'),
      }),
    );
    await axl.initializeTelemetry();
    expect(await axl.execute('ask', {})).toBe('answer');
    const spans = exporter.getFinishedSpans();
    const ask = spans.find((span) => span.name === 'axl.agent.ask')!;
    const inference = spans.find((span) => span.name === 'chat m')!;
    expect(spans.filter((span) => span.name === 'chat m')).toHaveLength(1);
    expect(inference.parentSpanContext?.spanId).toBe(ask.spanContext().spanId);
    expect(ask.attributes['gen_ai.operation.name']).toBe('invoke_agent');
    expect(ask.attributes['gen_ai.agent.name']).toBe('worker');
    expect(ask.attributes['axl.agent.name']).toBe('worker');
  });

  it('observes a runtime summary through the same cached facade', async () => {
    const raw: Provider = {
      name: 'summary',
      async chat() {
        return { content: 'short summary' };
      },
      async *stream() {
        yield { type: 'done' };
      },
    };
    const axl = runtime(raw);
    axl.resolveProvider('summary:m');
    await axl.initializeTelemetry();
    expect(
      await axl.summarizeMessages([{ role: 'user', content: 'long history' }], 'summary:m'),
    ).toBe('short summary');
    const spans = exporter.getFinishedSpans();
    expect(spans.filter((span) => span.name === 'chat m')).toHaveLength(1);
    expect(spans[0].attributes['gen_ai.request.max_tokens']).toBe(1024);
  });

  it('starts only on first stream iteration and ends once on done with streamed content', async () => {
    const raw: Provider = {
      name: 'stream-fixture',
      async chat() {
        return { content: 'unused' };
      },
      async *stream(_messages, options) {
        options.requestLifecycle?.onDispatch?.();
        yield { type: 'text_delta', content: 'partial' };
        yield {
          type: 'done',
          finishReason: 'stop',
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        };
      },
      reportsRequestLifecycle: true,
    };
    const axl = runtime(raw, { captureContent: true });
    await axl.initializeTelemetry();
    const facade = axl.resolveProvider('stream-fixture:m').provider;
    const uniterated = facade.stream([], { model: 'm' });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    await uniterated.return(undefined);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    const iterator = facade.stream([{ role: 'user', content: 'go' }], { model: 'm' });
    expect((await iterator.next()).value).toEqual({ type: 'text_delta', content: 'partial' });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect((await iterator.next()).value?.type).toBe('done');
    await iterator.return(undefined);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe(2);
    expect(spans[0].attributes['gen_ai.request.stream']).toBe(true);
    expect(spans[0].attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(spans[0].attributes['gen_ai.response.time_to_first_chunk']).toBeTypeOf('number');
    expect(JSON.parse(spans[0].attributes['gen_ai.output.messages'] as string)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'partial' }] },
    ]);
  });

  it('backdates a queued stream span to invocation and reports first-chunk seconds', async () => {
    let wallMs = 10_000;
    let monotonicMs = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wallMs);
    vi.spyOn(performance, 'now').mockImplementation(() => monotonicMs);
    const entered = deferred();
    const release = deferred();
    let recordedStartTime: number | undefined;
    const attributes: Record<string, unknown> = {};
    const manager: SpanManager = {
      async withSpanAsync(_name, _attributes, fn) {
        return fn({ setAttribute() {}, addEvent() {}, setStatus() {}, end() {} });
      },
      startSpan(_name, initial, options) {
        recordedStartTime = options?.startTime;
        Object.assign(attributes, initial);
        return {
          setAttribute(key, value) {
            attributes[key] = value;
          },
          addEvent() {},
          setStatus() {},
          end() {},
        };
      },
      addEventToActiveSpan() {},
      async shutdown() {},
    };
    const raw: Provider = {
      name: 'queued-stream',
      reportsRequestLifecycle: true,
      async chat() {
        return { content: 'unused' };
      },
      stream(_messages, options) {
        let step = 0;
        const iterator = {
          async next(): Promise<IteratorResult<StreamChunk>> {
            if (step++ === 0) {
              entered.resolve();
              await release.promise;
              options.requestLifecycle?.onDispatch?.();
              return { done: false, value: { type: 'text_delta', content: 'first' } };
            }
            return { done: false, value: { type: 'done', finishReason: 'stop' } };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
        return iterator as AsyncGenerator<StreamChunk>;
      },
    };
    const facade = createScopedProvider(raw, {
      getSpanManager: () => manager,
      captureContent: false,
      redact: false,
    });
    const iterator = facade.stream([], { model: 'm' });
    const first = iterator.next();
    await entered.promise;
    // Logical invocation was 500 ms before the provider reported dispatch.
    wallMs = 10_500;
    monotonicMs = 1_500;
    release.resolve();
    expect((await first).value?.type).toBe('text_delta');
    await iterator.next();
    expect(recordedStartTime).toBe(10_000);
    expect(attributes['gen_ai.response.time_to_first_chunk']).toBe(0.5);
    expect(attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it('closes a stream span promptly when return races a pending next', async () => {
    const entered = deferred();
    const release = deferred();
    const raw: Provider = {
      name: 'pending',
      reportsRequestLifecycle: true,
      async chat() {
        return { content: 'unused' };
      },
      stream(_messages, options) {
        let step = 0;
        const iterator = {
          async next(): Promise<IteratorResult<StreamChunk>> {
            if (step++ === 0) {
              options.requestLifecycle?.onDispatch?.();
              return { done: false, value: { type: 'text_delta', content: 'partial' } };
            }
            entered.resolve();
            await release.promise;
            return { done: true, value: undefined };
          },
          async return(): Promise<IteratorResult<StreamChunk>> {
            return { done: true, value: undefined };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
        return iterator as AsyncGenerator<StreamChunk>;
      },
    };
    const axl = runtime(raw, { captureContent: true });
    await axl.initializeTelemetry();
    const iterator = axl.resolveProvider('pending:m').provider.stream([], { model: 'm' });
    await iterator.next();
    const pending = iterator.next();
    await entered.promise;
    const closing = iterator.return(undefined);
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(exporter.getFinishedSpans()[0].status.code).toBe(0);
    expect(
      JSON.parse(exporter.getFinishedSpans()[0].attributes['gen_ai.output.messages'] as string),
    ).toEqual([{ role: 'assistant', parts: [{ type: 'text', content: 'partial' }] }]);
    release.resolve();
    await Promise.all([pending, closing]);
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it('closes a noncooperative stream span on the context stall path', async () => {
    const raw: Provider = {
      name: 'staller',
      reportsRequestLifecycle: true,
      async chat() {
        return { content: 'unused' };
      },
      stream(_messages, options) {
        let step = 0;
        const iterator = {
          async next(): Promise<IteratorResult<StreamChunk>> {
            if (step++ === 0) {
              options.requestLifecycle?.onDispatch?.();
              return { done: false, value: { type: 'text_delta', content: 'partial' } };
            }
            return new Promise<IteratorResult<StreamChunk>>(() => {});
          },
          async return(): Promise<IteratorResult<StreamChunk>> {
            return { done: true, value: undefined };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
        return iterator as AsyncGenerator<StreamChunk>;
      },
    };
    const axl = runtime(raw, { captureContent: true });
    axl.register(
      workflow({
        name: 'stall',
        input: z.any(),
        handler: (ctx) => {
          void ctx.events;
          return ctx.ask(agent({ name: 'staller', model: 'staller:m', system: 'system' }), 'go', {
            stallTimeout: '20ms',
          });
        },
      }),
    );
    await axl.initializeTelemetry();
    await expect(axl.execute('stall', {})).rejects.toBeInstanceOf(StallTimeoutError);
    const spans = exporter.getFinishedSpans().filter((span) => span.name === 'chat m');
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(2);
    expect(spans[0].attributes['error.type']).toBe('stalled');
    expect(JSON.parse(spans[0].attributes['gen_ai.output.messages'] as string)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'partial' }] },
    ]);
  });

  it('ends a dispatched stream once on abort and keeps its partial output', async () => {
    const raw: Provider = {
      name: 'aborter',
      reportsRequestLifecycle: true,
      async chat() {
        return { content: 'unused' };
      },
      async *stream(_messages, options) {
        options.requestLifecycle?.onDispatch?.();
        yield { type: 'text_delta', content: 'partial' };
        await new Promise<never>((_resolve, reject) => {
          if (options.signal?.aborted) return reject(options.signal.reason);
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    };
    const axl = runtime(raw, { captureContent: true });
    await axl.initializeTelemetry();
    const controller = new AbortController();
    const iterator = axl
      .resolveProvider('aborter:m')
      .provider.stream([], { model: 'm', signal: controller.signal });
    await iterator.next();
    const pending = iterator.next();
    controller.abort(new Error('private abort reason'));
    await expect(pending).rejects.toThrow('private abort reason');
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(2);
    expect(spans[0].attributes['error.type']).toBe('aborted');
    expect(JSON.stringify(spans[0].attributes)).not.toContain('private abort reason');
  });

  it('does not export an inference span for admission denial before dispatch', async () => {
    const raw: Provider = {
      name: 'denied',
      reportsRequestLifecycle: true,
      async chat(_messages, options: ChatOptions) {
        options.dispatchAdmission?.beforeDispatch(1);
        options.requestLifecycle?.onDispatch?.();
        return { content: 'impossible' };
      },
      async *stream() {
        yield { type: 'done' };
      },
    };
    const axl = runtime(raw);
    await axl.initializeTelemetry();
    const facade = axl.resolveProvider('denied:m').provider;
    const outcome = await axl.trackOutcome(() => facade.chat([], { model: 'm' }), {
      admission: new AdmissionController({ limit: 0 }),
    });
    expect(outcome.status).toBe('rejected');
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('does not create a span when admission closes while a call waits to dispatch', async () => {
    const entered = deferred();
    const release = deferred();
    const raw: Provider = {
      name: 'queue',
      reportsRequestLifecycle: true,
      async chat(messages, options) {
        if (messages[0]?.content === 'slow') {
          entered.resolve();
          await release.promise;
        }
        options.dispatchAdmission?.beforeDispatch(1);
        options.requestLifecycle?.onDispatch?.();
        return { content: 'ok', cost: 1 };
      },
      async *stream() {
        yield { type: 'done' };
      },
    };
    const axl = runtime(raw);
    await axl.initializeTelemetry();
    const facade = axl.resolveProvider('queue:m').provider;
    const outcome = await axl.trackOutcome(
      async () => {
        const slow = facade.chat([{ role: 'user', content: 'slow' }], { model: 'm' });
        await entered.promise;
        await facade.chat([{ role: 'user', content: 'fast' }], { model: 'm' });
        release.resolve();
        await expect(slow).rejects.toMatchObject({ name: 'AdmissionDeniedError' });
      },
      { admission: new AdmissionController({ limit: 1 }) },
    );
    expect(outcome.status).toBe('fulfilled');
    expect(outcome.accounting.operations.denied).toBe(1);
    expect(exporter.getFinishedSpans().filter((span) => span.name === 'chat m')).toHaveLength(1);
  });

  it('keeps provider result and accounting when span creation or export fails', async () => {
    const raw: Provider = {
      name: 'safe',
      async chat() {
        return { content: 'ok', cost: 0.25 };
      },
      async *stream() {
        yield { type: 'done' };
      },
    };
    const noops: SpanManager = {
      async withSpanAsync(_name, _attributes, fn) {
        return fn({ setAttribute() {}, addEvent() {}, setStatus() {}, end() {} });
      },
      addEventToActiveSpan() {},
      async shutdown() {},
    };
    const resolution = vi.fn(() => ({
      requested: 'high' as const,
      effective: 'high',
      clamped: false,
    }));
    raw.effortResolution = resolution;
    const legacyFacade = createScopedProvider(raw, {
      getSpanManager: () => noops,
      captureContent: true,
      redact: false,
    });
    expect((await legacyFacade.chat([], { model: 'm' })).content).toBe('ok');
    expect(resolution).not.toHaveBeenCalled();

    const broken: SpanManager = {
      ...noops,
      startSpan() {
        return {
          setAttribute() {
            throw new Error('export failed');
          },
          addEvent() {},
          setStatus() {
            throw new Error('status failed');
          },
          end() {
            throw new Error('end failed');
          },
        };
      },
    };
    const facade = createScopedProvider(raw, {
      getSpanManager: () => broken,
      captureContent: true,
      redact: false,
    });
    const axl = new AxlRuntime();
    const outcome = await axl.trackOutcome(() => facade.chat([], { model: 'm' }));
    expect(outcome.status).toBe('fulfilled');
    expect(outcome.accounting.knownCost).toBe(0.25);
    if (outcome.status === 'fulfilled') expect(outcome.value.content).toBe('ok');
  });

  it('applies the default 64 KiB and a configured content bound to chat and stream spans', async () => {
    const prompt = 'p'.repeat(32 * 1024);
    const answer = 'a'.repeat(32 * 1024);
    const raw: Provider = {
      name: 'sized',
      async chat() {
        return { content: answer };
      },
      async *stream() {
        yield { type: 'text_delta', content: answer };
        yield { type: 'done' };
      },
    };
    // 32 KiB of content fits the default but exceeded the former 16 KiB bound.
    const roomy = runtime(raw, { captureContent: true });
    await roomy.initializeTelemetry();
    await roomy.resolveProvider('sized:m').provider.chat([{ role: 'user', content: prompt }], {
      model: 'm',
    });
    const fits = exporter.getFinishedSpans()[0].attributes;
    expect(fits['gen_ai.input.messages']).toBeTypeOf('string');
    expect(fits['gen_ai.output.messages']).toBeTypeOf('string');
    expect(fits).not.toHaveProperty('axl.gen_ai.content_omitted');
    exporter.reset();

    const tight = runtime(raw, { captureContent: true, maxContentAttributeBytes: 1024 });
    await tight.initializeTelemetry();
    const facade = tight.resolveProvider('sized:m').provider;
    await facade.chat([{ role: 'user', content: prompt }], { model: 'm' });
    const chunks = facade.stream([{ role: 'user', content: 'go' }], { model: 'm' });
    while (!(await chunks.next()).done) {
      // Drain to the terminal done chunk so the stream span ends.
    }
    const [chat, stream] = exporter.getFinishedSpans().map((span) => span.attributes);
    expect(chat).not.toHaveProperty('gen_ai.input.messages');
    expect(chat['axl.gen_ai.content_omitted']).toEqual([
      'gen_ai.input.messages',
      'gen_ai.output.messages',
    ]);
    expect(stream['gen_ai.input.messages']).toBeTypeOf('string');
    expect(stream['axl.gen_ai.content_omitted']).toEqual(['gen_ai.output.messages']);
  });

  it('rejects an invalid content bound when the runtime is constructed', () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(
        () => new AxlRuntime({ telemetry: { enabled: true, maxContentAttributeBytes: invalid } }),
      ).toThrow(RangeError);
    }
  });

  it('keeps content and stop sequences private when trace redaction is on', async () => {
    const raw: Provider = {
      name: 'private',
      async chat() {
        return { content: 'response-secret', finishReason: 'stop' };
      },
      async *stream() {
        yield { type: 'done' };
      },
    };
    const axl = runtime(raw, { captureContent: true, redact: true });
    await axl.initializeTelemetry();
    await axl
      .resolveProvider('private:m')
      .provider.chat([{ role: 'user', content: 'prompt-secret' }], {
        model: 'm',
        stop: ['stop-secret'],
      });
    const attrs = exporter.getFinishedSpans()[0].attributes;
    expect(attrs).not.toHaveProperty('gen_ai.input.messages');
    expect(attrs).not.toHaveProperty('gen_ai.output.messages');
    expect(attrs).not.toHaveProperty('gen_ai.request.stop_sequences');
    expect(attrs['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });
});
