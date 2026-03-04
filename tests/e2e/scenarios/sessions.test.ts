import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent, workflow } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createTestRuntime } from '../helpers/setup.js';

describe('Sessions E2E', () => {
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
