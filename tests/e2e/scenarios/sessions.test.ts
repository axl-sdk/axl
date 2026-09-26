import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent, workflow, type ModelInput } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createTestRuntime } from '../helpers/setup.js';

describe('Sessions E2E', () => {
  it('deduplicates only the current matching input across fresh handles and rich requests', async () => {
    const provider = MockProvider.fn((_messages, callIndex) => ({ content: `reply-${callIndex}` }));
    const { runtime } = createTestRuntime(provider);
    const a = agent({ name: 'dedup-agent', model: 'mock:test' });
    runtime.register(
      workflow({
        name: 'dedup-wf',
        input: z.any(),
        handler: (ctx) => ctx.ask(a, ctx.input as ModelInput),
      }),
    );

    await runtime.session('dedup-default').send('dedup-wf', 'same');
    await runtime.session('dedup-default').send('dedup-wf', 'same');
    expect(provider.calls[0]?.messages).toEqual([{ role: 'user', content: 'same' }]);
    expect(provider.calls[1]?.messages.filter((message) => message.role === 'user')).toEqual([
      { role: 'user', content: 'same' },
      { role: 'user', content: 'same' },
    ]);

    await runtime.session('dedup-disabled', { deduplicateInput: false }).send('dedup-wf', 'legacy');
    expect(provider.calls[2]?.messages).toEqual([
      { role: 'user', content: 'legacy' },
      { role: 'user', content: 'legacy' },
    ]);

    const rich = [
      { type: 'text', text: 'inspect' },
      {
        type: 'image',
        source: { type: 'base64', data: 'AQID', mediaType: 'image/png' },
      },
    ] as const;
    const richSession = runtime.session('dedup-rich');
    await richSession.send('dedup-wf', rich);
    expect(provider.calls[3]?.messages).toEqual([{ role: 'user', content: rich }]);
    expect((await richSession.history())[0]).toEqual({
      role: 'user',
      content: 'inspect\n[image image/png]',
    });
    await runtime.shutdown();
  });

  it('multi-turn: session.send() preserves conversation history', async () => {
    const provider = MockProvider.fn((_msgs, callIndex) => ({
      content: callIndex === 0 ? 'response-1' : 'response-2',
    }));
    const { runtime } = createTestRuntime(provider);
    const a = agent({ name: 'session-agent', model: 'mock:test', system: 'You are helpful.' });
    const wf = workflow({
      name: 'session-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const session = runtime.session('test-session-1');
    const r1 = await session.send('session-wf', { message: 'turn 1' });
    expect(r1).toBe('response-1');

    const r2 = await session.send('session-wf', { message: 'turn 2' });
    expect(r2).toBe('response-2');
  });

  it('session.history() contains user + assistant messages for each turn', async () => {
    const provider = MockProvider.sequence([
      { content: 'first response' },
      { content: 'second response' },
    ]);
    const { runtime } = createTestRuntime(provider);
    const a = agent({ name: 'hist-agent', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'hist-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const session = runtime.session('test-session-2');
    await session.send('hist-wf', { message: 'hello' });
    await session.send('hist-wf', { message: 'world' });

    const history = await session.history();
    expect(history.length).toBe(4); // 2 user + 2 assistant
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('assistant');
    expect(history[2].role).toBe('user');
    expect(history[3].role).toBe('assistant');
  });

  it('session with maxMessages trims history correctly', async () => {
    let callCount = 0;
    const provider = MockProvider.fn(() => {
      callCount++;
      return { content: `reply-${callCount}` };
    });
    const { runtime } = createTestRuntime(provider);
    const a = agent({ name: 'trim-agent', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'trim-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const session = runtime.session('test-session-3', { history: { maxMessages: 2 } });
    await session.send('trim-wf', { message: 'msg-1' });
    await session.send('trim-wf', { message: 'msg-2' });
    await session.send('trim-wf', { message: 'msg-3' });

    const history = await session.history();
    // After 3 sends with maxMessages=2: trim keeps last 2, then add user+assistant = 4
    expect(history.length).toBe(4);
    // Session stores object inputs as JSON strings, text outputs as-is
    const contents = history.map((m) => m.content);
    // Oldest messages from turn 1 should be gone
    expect(contents.some((c) => c.includes('msg-1'))).toBe(false);
    expect(contents).not.toContain('reply-1');
    // Most recent messages should be present
    expect(contents.some((c) => c.includes('msg-3'))).toBe(true);
    expect(contents).toContain('reply-3');
  });

  it('passes a stored maxMessages summary to an agent without maxContext', async () => {
    const provider = MockProvider.fn((messages) => ({
      content: String(messages[0]?.content).startsWith('Summarize the following conversation')
        ? 'The user chose blue.'
        : 'reply',
    }));
    const { runtime } = createTestRuntime(provider);
    const a = agent({ name: 'summary-agent', model: 'mock:test' });
    runtime.register(
      workflow({
        name: 'summary-wf',
        input: z.string(),
        handler: (ctx) => ctx.ask(a, ctx.input),
      }),
    );

    const session = runtime.session('summary-session', {
      history: { maxMessages: 2, summarize: true, summaryModel: 'mock:test' },
    });
    await session.send('summary-wf', 'first');
    await session.send('summary-wf', 'second');
    await session.send('summary-wf', 'third');

    expect(
      provider.calls.some(
        (call) =>
          call.messages[0]?.content === 'Summary of earlier conversation:\nThe user chose blue.',
      ),
    ).toBe(true);
    await runtime.shutdown();
  });

  it('session.end() then session.send() throws', async () => {
    const { runtime } = createTestRuntime();
    const a = agent({ name: 'end-agent', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'end-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const session = runtime.session('test-session-4');
    await session.end();

    await expect(session.send('end-wf', { message: 'hello' })).rejects.toThrow(
      'Session has been ended',
    );
  });
});
