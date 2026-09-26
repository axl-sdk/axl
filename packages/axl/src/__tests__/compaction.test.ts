import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import type { ChatMessage, ChatOptions, Provider } from '../providers/types.js';

/** Records every request; answers summary requests and ordinary asks alike. */
function recordingProvider(name: string) {
  const calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  const provider: Provider = {
    name,
    async chat(messages, options) {
      calls.push({ messages: structuredClone(messages), options });
      return {
        content: `${name} reply ${calls.length}`,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 0,
      };
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('unused');
    },
  };
  return { provider, calls };
}

describe('one compaction request for both summarizers', () => {
  it('session retention and maxContext projection send the same summary request', async () => {
    const sessionSummarizer = recordingProvider('sessionsum');
    const askModel = recordingProvider('askmodel');
    const runtime = new AxlRuntime({ defaultProvider: 'askmodel' });
    runtime.registerProvider('sessionsum', sessionSummarizer.provider);
    runtime.registerProvider('askmodel', askModel.provider);

    const old = 'x'.repeat(400);
    const store = runtime.getStateStore();
    // Retention drops the first two turns; the ask projection then has to
    // summarize the retained ones because maxContext is small.
    await store.saveSessionMeta('compaction', 'summaryCache', 'Earlier: blue.');
    await store.saveSession('compaction', [
      { role: 'user', content: 'dropped question' },
      { role: 'assistant', content: 'dropped answer' },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `kept ${i}: ${old}`,
      })),
    ]);
    runtime.register(
      workflow({
        name: 'chat',
        input: z.any(),
        handler: (ctx) =>
          ctx.ask(agent({ name: 'compact', model: 'askmodel:m', maxContext: 3000 }), 'now'),
      }),
    );

    await runtime
      .session('compaction', {
        history: { maxMessages: 20, summarize: true, summaryModel: 'sessionsum:s' },
      })
      .send('chat', 'now');

    expect(sessionSummarizer.calls).toHaveLength(1);
    const retention = sessionSummarizer.calls[0];
    const projection = askModel.calls[0];
    // Same system instruction and output cap from both boundaries.
    expect(retention.messages[0]).toEqual(projection.messages[0]);
    expect(retention.messages[0].role).toBe('system');
    expect(retention.options.maxTokens).toBe(projection.options.maxTokens);
    // Same prompt rendering: a previous summary leads, then role-prefixed turns.
    expect(retention.messages[1].content).toBe(
      'Previous conversation summary: Earlier: blue.\nuser: dropped question\nassistant: dropped answer',
    );
    const projectionPrompt = String(projection.messages[1].content).split('\n');
    expect(projectionPrompt[0]).toBe('Previous conversation summary: sessionsum reply 1');
    expect(projectionPrompt[1]).toBe(`user: kept 0: ${old}`);
    // The projection's first call is a summary, not the ask itself.
    expect(askModel.calls[1].messages[0].content).toBe(
      'Summary of earlier conversation:\naskmodel reply 1',
    );
  });
});

describe('persisted ask summary through Session', () => {
  it('a later send reuses the boundary with no summary call and sends the whole tail', async () => {
    const model = recordingProvider('model');
    const runtime = new AxlRuntime({ defaultProvider: 'model' });
    runtime.registerProvider('model', model.provider);
    const store = runtime.getStateStore();
    await store.saveSession(
      'reuse',
      Array.from({ length: 24 }, (_, i) => ({
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `turn ${i}: ${'x'.repeat(400)}`,
      })),
    );
    runtime.register(
      workflow({
        name: 'chat',
        input: z.any(),
        handler: (ctx) =>
          ctx.ask(agent({ name: 'compact', model: 'model:m', maxContext: 3300 }), ctx.input),
      }),
    );
    const session = runtime.session('reuse');
    const isSummary = (call: (typeof model.calls)[number]) =>
      call.messages[0].content === model.calls[0].messages[0].content;

    await session.send('chat', 'first');
    expect(model.calls.filter(isSummary)).toHaveLength(1);
    const firstRequest = model.calls[1].messages;

    const before = model.calls.length;
    await session.send('chat', 'second');
    const later = model.calls.slice(before);

    expect(later.filter(isSummary)).toEqual([]);
    expect(later).toHaveLength(1);
    expect(later[0].messages.map((m) => m.content)).toEqual([
      ...firstRequest.map((m) => m.content),
      'model reply 2',
      'second',
    ]);
  });
});

describe('ask summary persistence boundaries', () => {
  const seedHistory = () =>
    Array.from({ length: 24 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${i}: ${'x'.repeat(400)}`,
    }));

  it('a persist: false session never writes askSummary metadata', async () => {
    const model = recordingProvider('model');
    const runtime = new AxlRuntime({ defaultProvider: 'model' });
    runtime.registerProvider('model', model.provider);
    const store = runtime.getStateStore();
    // The store holds prior turns (written while persistence was on), but this
    // session has opted out: the ask must not leave summary content at rest.
    await store.saveSession('ephemeral', seedHistory());
    runtime.register(
      workflow({
        name: 'chat',
        input: z.any(),
        handler: (ctx) =>
          ctx.ask(agent({ name: 'compact', model: 'model:m', maxContext: 3300 }), ctx.input),
      }),
    );
    const session = runtime.session('ephemeral', { persist: false });
    await session.send('chat', 'first');

    expect(model.calls.length).toBeGreaterThanOrEqual(2); // summary + ask
    expect(await store.getSessionMeta('ephemeral', 'askSummary:compact')).toBeNull();
  });

  it('a failed askSummary cache write is reported and does not fail the paid ask', async () => {
    const model = recordingProvider('model');
    const runtime = new AxlRuntime({ defaultProvider: 'model' });
    runtime.registerProvider('model', model.provider);
    const store = runtime.getStateStore();
    await store.saveSession('flaky', seedHistory());
    const originalSave = store.saveSessionMeta.bind(store);
    store.saveSessionMeta = async (id, key, value) => {
      if (key.startsWith('askSummary:')) throw new Error('meta store unavailable');
      return originalSave(id, key, value);
    };
    runtime.register(
      workflow({
        name: 'chat',
        input: z.any(),
        handler: (ctx) =>
          ctx.ask(agent({ name: 'compact', model: 'model:m', maxContext: 3300 }), ctx.input),
      }),
    );
    const warnings: string[] = [];
    runtime.on('trace', (event: { type: string; data?: { warning?: string } }) => {
      if (event.type === 'log' && event.data?.warning) warnings.push(event.data.warning);
    });

    const result = await runtime.session('flaky').send('chat', 'first');

    expect(result).toBe(`model reply ${model.calls.length}`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('askSummary:compact');
    expect(warnings[0]).toContain('meta store unavailable');
    // The in-memory boundary still served this execution's request.
    expect(
      model.calls[1].messages.some((m) =>
        String(m.content).startsWith('Summary of earlier conversation'),
      ),
    ).toBe(true);
  });
});
