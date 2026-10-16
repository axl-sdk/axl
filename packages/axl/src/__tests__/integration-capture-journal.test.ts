/**
 * Provider-gated journal evidence for model-call capture plan L1–L8.
 *
 * Eleven logical requests at most: two each for OpenAI Chat and Responses,
 * one Anthropic truncation, one Gemini tool call, one OpenAI 4xx, one
 * Anthropic aborted stream, and three Anthropic thinking/tool replay calls.
 * L7 shares the L1 chat request. Keep caps small and run only with an explicit
 * live-provider spend authorization.
 */
import { SpanKind } from '@opentelemetry/api';
import { loadModelCalls, modelCallDataset, replayModelCall } from '@axlsdk/eval';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { agent } from '../agent.js';
import { RequestCaptureChannel } from '../diagnostics/capture.js';
import type { CapturedRequestRecord } from '../diagnostics/capture.js';
import { AxlRuntime } from '../runtime.js';
import { tool } from '../tool.js';
import { workflow } from '../workflow.js';
import type { ChatMessage, StreamChunk } from '../providers/types.js';

const OPENAI_MODEL = 'gpt-4.1-nano';
const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const geminiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
const pong: ChatMessage[] = [{ role: 'user', content: 'Reply with the single word: pong' }];

function journal() {
  const lines: string[] = [];
  const channel = new RequestCaptureChannel({
    sink: {
      async append(line) {
        lines.push(line);
      },
    },
  });
  return {
    channel,
    async close(): Promise<CapturedRequestRecord[]> {
      const status = await channel.close();
      expect(status.status).toBe('complete');
      return lines.map((line) => JSON.parse(line) as CapturedRequestRecord);
    },
  };
}

function one(records: CapturedRequestRecord[], phase: 'start' | 'end') {
  const matching = records.filter((record) => record.phase === phase);
  expect(matching).toHaveLength(1);
  expect(matching[0].captured.truncated).toBe(false);
  return matching[0];
}

function expectPair(records: CapturedRequestRecord[], kind: 'chat' | 'stream') {
  expect(records).toHaveLength(2);
  const start = one(records, 'start');
  const end = one(records, 'end');
  expect(start.operationId).toBe(end.operationId);
  expect(start.kind).toBe(kind);
  expect(end.kind).toBe(kind);
  expect(start.purpose).toBe('direct');
  expect(end.purpose).toBe('direct');
  expect(start.request?.options.maxTokens).toBeGreaterThan(0);
  expect(end.durationMs).toBeGreaterThanOrEqual(0);
  return { start, end };
}

function expectWireIdentity(end: CapturedRequestRecord) {
  expect(end.response?.responseId).toMatch(/\S/);
  expect(end.response?.responseModel).toMatch(/\S/);
}

function runtimeFor(provider: string) {
  return new AxlRuntime({ defaultProvider: provider, trace: { enabled: false } });
}

async function captured(runtime: AxlRuntime, fn: () => Promise<unknown>) {
  const capture = journal();
  const outcome = await runtime.trackOutcome(fn, { capture: capture.channel });
  const records = await capture.close();
  return { outcome, records };
}

for (const providerId of ['openai', 'openai-responses'] as const) {
  describe.skipIf(!process.env.OPENAI_API_KEY)(`journal live — ${providerId}`, () => {
    it(`${providerId === 'openai' ? 'L1' : 'L2'}: chat and stream project normal wire metadata`, async () => {
      // L7 uses this L1 chat request, adding no provider call.
      const exporter = providerId === 'openai' ? new InMemorySpanExporter() : undefined;
      const tracerProvider = exporter
        ? new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
        : undefined;
      const runtime = new AxlRuntime({
        defaultProvider: providerId,
        trace: { enabled: false },
        ...(tracerProvider ? { telemetry: { enabled: true, tracerProvider } } : {}),
      });
      try {
        if (tracerProvider) await runtime.initializeTelemetry();
        const facade = runtime.resolveProvider(`${providerId}:${OPENAI_MODEL}`).provider;
        const chat = await captured(runtime, () =>
          facade.chat(pong, { model: OPENAI_MODEL, maxTokens: 32 }),
        );
        expect(chat.outcome.status).toBe('fulfilled');
        expect(chat.outcome.accounting.operations.total).toBe(1);
        const chatEnd = expectPair(chat.records, 'chat').end;
        expect(chatEnd.response?.finishReason).toBe('stop');
        expect(chatEnd.response?.rawFinishReason).toMatch(/\S/);
        expectWireIdentity(chatEnd);

        if (exporter) {
          const spans = exporter.getFinishedSpans();
          const inference = spans.filter((span) => span.name === `chat ${OPENAI_MODEL}`);
          expect(inference).toHaveLength(1);
          expect(inference[0].kind).toBe(SpanKind.CLIENT);
          expect(inference[0].attributes).toMatchObject({
            'gen_ai.operation.name': 'chat',
            'gen_ai.provider.name': 'openai',
            'gen_ai.request.model': OPENAI_MODEL,
            'gen_ai.request.stream': false,
            'gen_ai.request.max_tokens': 32,
            'gen_ai.response.id': chatEnd.response?.responseId,
            'gen_ai.response.model': chatEnd.response?.responseModel,
            'gen_ai.response.finish_reasons': ['stop'],
          });
          expect(inference[0].attributes['gen_ai.usage.input_tokens']).toBeGreaterThan(0);
          expect(inference[0].attributes['gen_ai.usage.output_tokens']).toBeGreaterThan(0);
          expect(inference[0].attributes).not.toHaveProperty('gen_ai.input.messages');
          expect(inference[0].attributes).not.toHaveProperty('gen_ai.output.messages');
        }

        const streamed = await captured(runtime, async () => {
          let done: Extract<StreamChunk, { type: 'done' }> | undefined;
          for await (const chunk of facade.stream(pong, { model: OPENAI_MODEL, maxTokens: 32 })) {
            if (chunk.type === 'done') done = chunk;
          }
          expect(done).toBeDefined();
          return done;
        });
        expect(streamed.outcome.status).toBe('fulfilled');
        expect(streamed.outcome.accounting.operations.total).toBe(1);
        const streamEnd = expectPair(streamed.records, 'stream').end;
        expect(streamEnd.response?.finishReason).toBe('stop');
        expect(streamEnd.response?.rawFinishReason).toMatch(/\S/);
        expectWireIdentity(streamEnd);
        if (streamed.outcome.status === 'fulfilled') {
          expect(streamEnd.response?.responseId).toBe(streamed.outcome.value?.responseId);
        }
      } finally {
        await runtime.shutdown();
        await tracerProvider?.shutdown();
      }
    });
  });
}

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('journal live — Anthropic', () => {
  it('L3: max_tokens truncation retains normalized and raw reasons', async () => {
    const runtime = runtimeFor('anthropic');
    const { provider } = runtime.resolveProvider(`anthropic:${ANTHROPIC_MODEL}`);
    const { outcome, records } = await captured(runtime, () =>
      provider.chat([{ role: 'user', content: 'Write a complete paragraph about rivers.' }], {
        model: ANTHROPIC_MODEL,
        maxTokens: 1,
      }),
    );
    expect(outcome.status).toBe('fulfilled');
    const end = expectPair(records, 'chat').end;
    expect(end.response?.finishReason).toBe('length');
    expect(end.response?.rawFinishReason).toBe('max_tokens');
    expectWireIdentity(end);
    await runtime.shutdown();
  });

  it('L6: a real abort after text leaves an aborted partial journal end', async () => {
    const runtime = runtimeFor('anthropic');
    const { provider } = runtime.resolveProvider(`anthropic:${ANTHROPIC_MODEL}`);
    const controller = new AbortController();
    const { outcome, records } = await captured(runtime, async () => {
      const iterator = provider.stream(
        [{ role: 'user', content: 'Write a long paragraph about a river, one word at a time.' }],
        { model: ANTHROPIC_MODEL, maxTokens: 128, signal: controller.signal },
      );
      let sawText = false;
      try {
        for (let i = 0; i < 256; i++) {
          const item = await iterator.next();
          if (item.done || item.value.type === 'done')
            throw new Error('stream completed before abort');
          if (item.value.type === 'text_delta' && item.value.content.length > 0) {
            sawText = true;
            controller.abort(new DOMException('capture probe cancelled', 'AbortError'));
            break;
          }
        }
        expect(sawText).toBe(true);
        // Consume until the aborted transport rejects. A success terminal tick
        // would make this test fail even if the journal guessed "aborted".
        for (let i = 0; i < 256; i++) {
          const item = await iterator.next();
          if (item.done || item.value.type === 'done') throw new Error('aborted stream completed');
        }
        throw new Error('aborted stream did not terminate');
      } finally {
        await iterator.return(undefined);
      }
    });
    expect(controller.signal.aborted).toBe(true);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.error).toMatchObject({ name: 'AbortError' });
    const end = expectPair(records, 'stream').end;
    expect(end.termination).toBe('aborted');
    expect(end.response).toBeUndefined();
    expect(end.partial?.content?.length).toBeGreaterThan(0);
    expect(end.error?.name).toBe('AbortError');
    expect(end.endedAt).toMatch(/^\d{4}-/);
    await runtime.shutdown();
  });

  it('L8: replay of captured turn two retains signed thinking and tool history', async () => {
    const runtime = runtimeFor('anthropic');
    const lookup = tool({
      name: 'lookup_code',
      description: 'Return the fixed code.',
      input: z.object({}),
      handler: async () => 'CODE-7',
    });
    const asker = agent({
      name: 'capture-replay',
      model: `anthropic:${ANTHROPIC_MODEL}`,
      system: 'Use lookup_code to get the code, then answer with the code.',
      tools: [lookup],
      maxTurns: 2,
      maxTokens: 1536,
      thinkingBudget: 1024,
      toolChoice: 'auto',
    });
    runtime.register(
      workflow({
        name: 'capture-replay',
        input: z.any(),
        handler: async (ctx) => ctx.ask(asker, 'Call lookup_code exactly once, then say the code.'),
      }),
    );
    const original = journal();
    const originalOutcome = await runtime.trackOutcome(
      () => runtime.execute('capture-replay', {}),
      {
        capture: original.channel,
      },
    );
    const originalRecords = await original.close();
    expect(originalOutcome.status).toBe('fulfilled');
    expect(originalOutcome.accounting.operations.byKind.chat).toBe(2);
    expect(originalOutcome.accounting.operations.byKind.tool).toBe(1);
    expect(originalRecords.filter((record) => record.phase === 'start')).toHaveLength(2);
    expect(originalRecords.filter((record) => record.phase === 'end')).toHaveLength(2);
    const starts = originalRecords.filter((record) => record.phase === 'start');
    const ends = originalRecords.filter((record) => record.phase === 'end');
    expect(starts.map((record) => record.turn)).toEqual([1, 2]);
    expect(starts.map((record) => record.purpose)).toEqual(['ask', 'ask']);
    expect(starts.map((record) => record.agent)).toEqual(['capture-replay', 'capture-replay']);
    expect(starts.map((record) => record.workflow)).toEqual(['capture-replay', 'capture-replay']);
    expect(ends[0].response?.tool_calls?.[0].function.name).toBe('lookup_code');
    const firstSigned = ends[0].response?.providerMetadata?.anthropicThinkingBlocks as
      | Array<{ type?: string; signature?: string }>
      | undefined;
    expect(firstSigned?.some((block) => block.type === 'thinking' && !!block.signature)).toBe(true);
    const turnTwo = starts[1];
    expect(turnTwo.captured.truncated).toBe(false);
    expect(turnTwo.request?.options).toMatchObject({
      model: ANTHROPIC_MODEL,
      maxTokens: 1536,
      thinkingBudget: 1024,
      toolChoice: 'auto',
    });
    const assistant = turnTwo.request?.messages.find((message) => message.role === 'assistant');
    const signed = assistant?.providerMetadata?.anthropicThinkingBlocks as
      | Array<{ type?: string; signature?: string }>
      | undefined;
    expect(signed?.some((block) => block.type === 'thinking' && !!block.signature)).toBe(true);
    expect(turnTwo.captured.continuityCaptured).toBe(true);
    expect(turnTwo.request?.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('CODE-7'),
      tool_call_id: expect.any(String),
    });
    expect(turnTwo.request?.tools?.[0].name).toBe('lookup_code');

    // Use the public production-to-eval path. It folds the journal, validates
    // replayability, and reconstructs only the captured second provider call.
    const folded = await loadModelCalls(originalRecords);
    const dataset = modelCallDataset(folded, { filter: (record) => record.ids.turn === 2 });
    const items = await dataset.getItems();
    expect(items).toHaveLength(1);
    expect(items[0].input.recorded.captured.replayable).toBe(true);
    expect(items[0].input.request?.messages).toEqual(turnTwo.request?.messages);
    const replay = await captured(runtime, () => replayModelCall()(items[0].input, runtime));
    expect(replay.outcome.status).toBe('fulfilled');
    expect(replay.outcome.accounting.operations.total).toBe(1);
    const { start: replayStart, end: replayEnd } = expectPair(replay.records, 'chat');
    expect(replayStart.request?.messages).toEqual(turnTwo.request?.messages);
    expect(replayStart.request?.tools).toEqual(turnTwo.request?.tools);
    expect(replayEnd.response?.responseId).toMatch(/\S/);
    await runtime.shutdown();
  }, 120_000);
});

describe.skipIf(!geminiKey)('journal live — Gemini', () => {
  it('L4: forced tool choice retains tool_calls and raw STOP', async () => {
    const runtime = runtimeFor('google');
    const { provider } = runtime.resolveProvider(`google:${GEMINI_MODEL}`);
    const { outcome, records } = await captured(runtime, () =>
      provider.chat([{ role: 'user', content: 'Find the weather in Boston.' }], {
        model: GEMINI_MODEL,
        maxTokens: 64,
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_weather',
              description: 'Look up weather for a city',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          },
        ],
        toolChoice: 'required',
      }),
    );
    expect(outcome.status).toBe('fulfilled');
    const { start, end } = expectPair(records, 'chat');
    expect(start.request?.tools?.[0].name).toBe('lookup_weather');
    expect(end.response?.tool_calls?.[0].function.name).toBe('lookup_weather');
    expect(end.response?.finishReason).toBe('tool_calls');
    expect(end.response?.rawFinishReason).toBe('STOP');
    expectWireIdentity(end);
    await runtime.shutdown();
  });
});

describe.skipIf(!process.env.OPENAI_API_KEY)('journal live — provider error', () => {
  it('L5: one bad wire parameter records a 4xx and reported request identity', async () => {
    const runtime = runtimeFor('openai');
    const { provider } = runtime.resolveProvider(`openai:${OPENAI_MODEL}`);
    const { outcome, records } = await captured(runtime, () =>
      provider.chat(pong, {
        model: OPENAI_MODEL,
        maxTokens: 16,
        // OpenAI validates temperature on the wire. The escape hatch merges
        // this after Axl's portable options, causing one deliberate 400.
        providerOptions: { temperature: -1 },
      }),
    );
    expect(outcome.status).toBe('rejected');
    expect(outcome.accounting.operations.total).toBe(1);
    const { start, end } = expectPair(records, 'chat');
    expect(start.request?.providerOptionKeys).toContain('temperature');
    expect(start.request?.options).not.toHaveProperty('temperature');
    expect(end.response).toBeUndefined();
    expect(end.error?.status).toBe(400);
    expect(end.error?.code).toBe('PROVIDER_ERROR');
    if (outcome.status === 'rejected') {
      const error = outcome.error as { status?: number; requestId?: string };
      expect(error.status).toBe(400);
      expect(end.error?.requestId).toBe(error.requestId);
      if (error.requestId !== undefined) expect(error.requestId).toMatch(/\S/);
    }
    await runtime.shutdown();
  });
});
