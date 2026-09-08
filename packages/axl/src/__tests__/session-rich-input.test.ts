import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { InvalidModelInputError } from '../errors.js';
import { AxlRuntime } from '../runtime.js';
import { MemoryStore } from '../state/memory.js';
import type { ChatMessage } from '../types.js';
import { workflow } from '../workflow.js';
import { MockProvider } from '../../../axl-testing/src/mock-provider.js';

/**
 * A `Session` records the workflow input as the persisted `user` turn. Media is
 * per-call evidence, never session state (docs/multimodal-input.md), so a rich
 * `ModelInput` must be recorded through the context-safe projection — never as
 * JSON carrying inline base64 that later turns would re-send as text.
 */
function makeRuntime() {
  const sent: ChatMessage[][] = [];
  const provider = MockProvider.fn((messages) => {
    sent.push(messages.map((message) => ({ ...message })));
    return { content: 'reply' };
  });
  const store = new MemoryStore();
  const runtime = new AxlRuntime({ defaultProvider: 'mock', state: { store } });
  runtime.registerProvider('mock', provider);
  const chat = agent({ name: 'chat', model: 'mock:test' });
  runtime.register(
    workflow({
      name: 'wf',
      input: z.any(),
      handler: async (ctx) => ctx.ask(chat, ctx.input as never),
    }),
  );
  return { runtime, store, sent };
}

const BASE64 = 'UklGRlNFTlRJTkVM';

describe('Session with rich ModelInput', () => {
  it.each([
    ['audio', { type: 'base64', data: BASE64, mediaType: 'audio/wav' }, '[audio audio/wav]'],
    ['image', { type: 'base64', data: BASE64, mediaType: 'image/png' }, '[image image/png]'],
  ] as const)(
    'persists a %s input as its text projection and never re-sends the media',
    async (type, source, marker) => {
      const { runtime, store, sent } = makeRuntime();
      const session = runtime.session('s1');
      await session.send('wf', [
        { type: 'text', text: 'what is this' },
        { type, source },
      ]);
      await session.send('wf', 'how many speakers?');

      const persisted = await store.getSession('s1');
      expect(persisted[0]).toEqual({ role: 'user', content: `what is this\n${marker}` });
      expect(JSON.stringify(persisted)).not.toContain(BASE64);

      // The first turn still carried the media itself; the second carries the
      // projection in history and no media part anywhere.
      expect(sent[0].some((message) => typeof message.content !== 'string')).toBe(true);
      expect(sent[1].every((message) => typeof message.content === 'string')).toBe(true);
      expect(JSON.stringify(sent[1])).not.toContain(BASE64);
      await runtime.shutdown();
    },
  );

  it('fails loudly on a malformed part before the workflow runs', async () => {
    const { runtime, sent } = makeRuntime();
    const session = runtime.session('s2');
    await expect(
      session.send('wf', [{ type: 'audio', source: { type: 'url', url: 'https://x.test/a.mp3' } }]),
    ).rejects.toBeInstanceOf(InvalidModelInputError);
    expect(sent).toHaveLength(0);
    await runtime.shutdown();
  });

  it('still records an application object input as JSON', async () => {
    const { runtime, store } = makeRuntime();
    runtime.register(
      workflow({
        name: 'obj',
        input: z.object({ question: z.string() }),
        handler: async (ctx) => ctx.ask(agent({ model: 'mock:test' }), ctx.input.question),
      }),
    );
    const session = runtime.session('s3');
    await session.send('obj', { question: 'hi' });
    expect((await store.getSession('s3'))[0]).toEqual({
      role: 'user',
      content: '{"question":"hi"}',
    });
    await runtime.shutdown();
  });
});
