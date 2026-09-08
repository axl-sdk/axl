import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import type { WorkflowContext } from '../context.js';
import type { ModelInput } from '../input.js';
import { AxlRuntime } from '../runtime.js';
import type { SessionOptions } from '../session.js';
import { MemoryStore } from '../state/memory.js';
import { tool } from '../tool.js';
import type { AxlEvent, ChatMessage } from '../types.js';
import { workflow } from '../workflow.js';
import { MockProvider } from '../../../axl-testing/src/mock-provider.js';

type HarnessOptions = {
  handler?: (ctx: WorkflowContext<unknown>, chat: ReturnType<typeof agent>) => Promise<unknown>;
  session?: SessionOptions;
  trace?: 'full';
};

function makeHarness(options: HarnessOptions = {}) {
  const provider = MockProvider.fn((_messages, callIndex) => ({
    content: `reply-${callIndex}`,
  }));
  const store = new MemoryStore();
  const runtime = new AxlRuntime({
    defaultProvider: 'mock',
    state: { store },
    ...(options.trace ? { trace: { level: options.trace } } : {}),
  });
  runtime.registerProvider('mock', provider);
  const chat = agent({ name: 'chat', model: 'mock:test' });
  runtime.register(
    workflow({
      name: 'chat-workflow',
      input: z.any(),
      handler: options.handler
        ? (ctx) => options.handler!(ctx, chat)
        : (ctx) => ctx.ask(chat, ctx.input as ModelInput),
    }),
  );
  return {
    runtime,
    provider,
    store,
    session: runtime.session('dedup', options.session),
  };
}

async function finishStream(
  stream: Awaited<ReturnType<ReturnType<typeof makeHarness>['session']['stream']>>,
) {
  await stream.promise;
}

function userMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role === 'user');
}

describe('Session current-input deduplication', () => {
  it.each(['replace', 'content', 'role'] as const)(
    'preserves a current history entry after application %s changes',
    async (change) => {
      let changed: ChatMessage | undefined;
      const { runtime, provider, session } = makeHarness({
        handler: async (ctx, chat) => {
          const history = ctx.metadata.sessionHistory as ChatMessage[];
          if (change === 'replace') history[0] = { ...history[0]! };
          if (change === 'content') history[0]!.content = 'edited';
          if (change === 'role') history[0]!.role = 'assistant';
          changed = { ...history[0]! };
          return ctx.ask(chat, 'hello');
        },
      });
      await session.send('chat-workflow', 'hello');
      expect(provider.calls[0]!.messages).toEqual([changed, { role: 'user', content: 'hello' }]);
      await runtime.shutdown();
    },
  );

  it.each(['execution', 'stream-construction'] as const)(
    'clears provenance when %s fails before an assistant reply',
    async (failure) => {
      let retained: ChatMessage[] = [];
      const { runtime, provider, session } = makeHarness({
        handler: async (ctx) => {
          retained = ctx.metadata.sessionHistory as ChatMessage[];
          throw new Error('planned failure');
        },
      });
      if (failure === 'execution') {
        await expect(session.send('chat-workflow', 'hello')).rejects.toThrow('planned failure');
      } else {
        const spy = vi.spyOn(runtime, 'stream').mockImplementation((_name, _input, options) => {
          retained = options!.metadata!.sessionHistory as ChatMessage[];
          throw new Error('planned failure');
        });
        await expect(session.stream('chat-workflow', 'hello')).rejects.toThrow('planned failure');
        spy.mockRestore();
      }
      expect(retained).toEqual([{ role: 'user', content: 'hello' }]);
      await runtime
        .createContext({ sessionHistory: retained })
        .ask(agent({ model: 'mock:test' }), 'hello');
      expect(provider.calls[0]!.messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'hello' },
      ]);
      await runtime.shutdown();
    },
  );

  it.each(['bytes', 'order'] as const)(
    'does not merge rich inputs with different %s',
    async (change) => {
      const original: ModelInput = [
        {
          type: 'audio',
          source: { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'audio/wav' },
        },
        { type: 'text', text: 'listen' },
      ];
      const different: ModelInput =
        change === 'order'
          ? [...original].reverse()
          : [
              {
                type: 'audio',
                source: { type: 'bytes', data: new Uint8Array([3, 2, 1]), mediaType: 'audio/wav' },
              },
              original[1]!,
            ];
      const { runtime, provider, session } = makeHarness({
        handler: (ctx, chat) => ctx.ask(chat, different),
      });
      await session.send('chat-workflow', original);
      expect(provider.calls[0]!.messages).toEqual([
        { role: 'user', content: '[audio audio/wav]\nlisten' },
        { role: 'user', content: different },
      ]);
      await runtime.shutdown();
    },
  );

  it('sends the current session input once and persists one canonical exchange', async () => {
    const { runtime, provider, session } = makeHarness();
    await session.send('chat-workflow', 'hello');

    expect(provider.calls[0]?.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(await session.history()).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'reply-0', agent: 'chat' },
    ]);
    await runtime.shutdown();
  });

  it('applies the same request-local deduplication to session.stream()', async () => {
    const { runtime, provider, session } = makeHarness();
    await finishStream(await session.stream('chat-workflow', 'stream me'));

    expect(provider.calls[0]?.messages).toEqual([{ role: 'user', content: 'stream me' }]);
    expect(await session.history()).toEqual([
      { role: 'user', content: 'stream me' },
      { role: 'assistant', content: 'reply-0', agent: 'chat' },
    ]);
    await runtime.shutdown();
  });

  it.each(['send', 'stream'] as const)(
    'keeps the legacy duplicate provider request for %s when explicitly disabled',
    async (mode) => {
      const { runtime, provider, session } = makeHarness({
        session: { deduplicateInput: false },
      });
      if (mode === 'send') await session.send('chat-workflow', 'legacy');
      else await finishStream(await session.stream('chat-workflow', 'legacy'));

      expect(provider.calls[0]?.messages).toEqual([
        { role: 'user', content: 'legacy' },
        { role: 'user', content: 'legacy' },
      ]);
      expect(await session.history()).toHaveLength(2);
      await runtime.shutdown();
    },
  );

  it.each([
    ['case', 'Hello', 'hello'],
    ['whitespace', 'hello', 'hello '],
  ])('does not merge %s-distinct inputs', async (_label, sessionInput, askInput) => {
    const { runtime, provider, session } = makeHarness({
      handler: (ctx, chat) => ctx.ask(chat, askInput),
    });
    await session.send('chat-workflow', sessionInput);

    expect(userMessages(provider.calls[0]!.messages).map((message) => message.content)).toEqual([
      sessionInput,
      askInput,
    ]);
    await runtime.shutdown();
  });

  it('preserves an equal second ask after the first assistant reply', async () => {
    const { runtime, provider, session } = makeHarness({
      handler: async (ctx, chat) => {
        await ctx.ask(chat, ctx.input as ModelInput);
        return ctx.ask(chat, ctx.input as ModelInput);
      },
    });
    await session.send('chat-workflow', 'repeat');

    expect(provider.calls[0]?.messages).toEqual([{ role: 'user', content: 'repeat' }]);
    expect(provider.calls[1]?.messages).toEqual([
      { role: 'user', content: 'repeat' },
      { role: 'assistant', content: 'reply-0', agent: 'chat' },
      { role: 'user', content: 'repeat' },
    ]);
    await runtime.shutdown();
  });

  it('preserves a later distinct ask after the current session input', async () => {
    const { runtime, provider, session } = makeHarness({
      handler: async (ctx, chat) => {
        await ctx.ask(chat, ctx.input as ModelInput);
        return ctx.ask(chat, 'follow up');
      },
    });
    await session.send('chat-workflow', 'first');

    expect(provider.calls[1]?.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply-0', agent: 'chat' },
      { role: 'user', content: 'follow up' },
    ]);
    await runtime.shutdown();
  });

  it('keeps equal inputs from two session turns as distinct history', async () => {
    const { runtime, provider, session } = makeHarness();
    await session.send('chat-workflow', 'same');
    await session.send('chat-workflow', 'same');

    expect(userMessages(provider.calls[1]!.messages)).toEqual([
      { role: 'user', content: 'same' },
      { role: 'user', content: 'same' },
    ]);
    expect(await session.history()).toEqual([
      { role: 'user', content: 'same' },
      { role: 'assistant', content: 'reply-0', agent: 'chat' },
      { role: 'user', content: 'same' },
      { role: 'assistant', content: 'reply-1', agent: 'chat' },
    ]);
    await runtime.shutdown();
  });

  it('sends ordered rich input once, owns bytes, and persists only its safe projection', async () => {
    const events: AxlEvent[] = [];
    const { runtime, provider, session } = makeHarness({
      trace: 'full',
      handler: async (ctx, chat) => {
        const input = ctx.input as ModelInput;
        const pending = ctx.ask(chat, input);
        if (typeof input !== 'string') {
          const audio = input.find((part) => part.type === 'audio');
          if (audio?.source.type === 'bytes') audio.source.data.fill(9);
        }
        return pending;
      },
    });
    runtime.on('trace', (event) => events.push(event));
    const audioBytes = new Uint8Array([1, 2, 3]);
    const input = [
      { type: 'text', text: 'first' },
      {
        type: 'image',
        source: { type: 'base64', data: 'AQID', mediaType: 'image/png' },
      },
      {
        type: 'audio',
        source: { type: 'bytes', data: audioBytes, mediaType: 'audio/wav' },
      },
      { type: 'text', text: 'last' },
    ] as const;
    await session.send('chat-workflow', input);

    const sent = provider.calls[0]!.messages;
    expect(sent).toHaveLength(1);
    const sentParts = sent[0]!.content as Exclude<ModelInput, string>;
    expect(sentParts.map((part) => part.type)).toEqual(['text', 'image', 'audio', 'text']);
    expect(sentParts[0]).toEqual({ type: 'text', text: 'first' });
    expect(sentParts[1]).toEqual(input[1]);
    expect(sentParts[3]).toEqual({ type: 'text', text: 'last' });
    const sentAudio = sentParts[2];
    expect(sentAudio?.type).toBe('audio');
    if (sentAudio?.type === 'audio' && sentAudio.source.type === 'bytes') {
      expect([...sentAudio.source.data]).toEqual([1, 2, 3]);
    }
    expect((await session.history())[0]).toEqual({
      role: 'user',
      content: 'first\n[image image/png]\n[audio audio/wav]\nlast',
    });
    expect(JSON.stringify(await session.history())).not.toContain('AQID');
    const modelFacingEvents = events.filter(
      (event) => event.type === 'ask_start' || event.type.startsWith('agent_call_'),
    );
    expect(JSON.stringify(modelFacingEvents)).not.toContain('AQID');
    const start = events.find((event) => event.type === 'agent_call_start');
    expect(start?.data.messages).toHaveLength(1);
    expect(start?.data.messageInputs).toHaveLength(1);
    await runtime.shutdown();
  });

  it('does not match rich inputs that share a safe text summary but differ in media', async () => {
    const second = [
      {
        type: 'image',
        source: { type: 'base64', data: 'BAUG', mediaType: 'image/png' },
      },
    ] as const;
    const { runtime, provider, session } = makeHarness({
      handler: (ctx, chat) => ctx.ask(chat, second),
    });
    await session.send('chat-workflow', [
      {
        type: 'image',
        source: { type: 'base64', data: 'AQID', mediaType: 'image/png' },
      },
    ]);

    expect(provider.calls[0]?.messages).toEqual([
      { role: 'user', content: '[image image/png]' },
      { role: 'user', content: second },
    ]);
    await runtime.shutdown();
  });

  it('matches application objects only when the ask is their exact serialized JSON', async () => {
    const { runtime, provider, session } = makeHarness({
      handler: (ctx, chat) => ctx.ask(chat, JSON.stringify(ctx.input)),
    });
    await session.send('chat-workflow', { question: 'hello' });

    expect(provider.calls[0]?.messages).toEqual([
      { role: 'user', content: '{"question":"hello"}' },
    ]);
    await runtime.shutdown();
  });

  it('preserves schema guidance and tool definitions while removing only the duplicate turn', async () => {
    const noop = tool({
      name: 'noop',
      description: 'Do nothing',
      input: z.object({}),
      handler: () => 'ok',
    });
    const provider = MockProvider.fn(() => ({ content: '{"answer":"ok"}' }));
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const chat = agent({ name: 'structured', model: 'mock:test', tools: [noop] });
    runtime.register(
      workflow({
        name: 'structured-workflow',
        input: z.string(),
        handler: (ctx) => ctx.ask(chat, ctx.input, { schema: z.object({ answer: z.string() }) }),
      }),
    );

    await runtime.session('schema').send('structured-workflow', 'answer this');
    const call = provider.calls[0]!;
    expect(call.messages).toHaveLength(1);
    const content = String(call.messages[0]?.content);
    expect(
      content.startsWith('answer this\n\nRespond with valid JSON matching this schema:\n'),
    ).toBe(true);
    expect(content.match(/Respond with valid JSON matching this schema:/g)).toHaveLength(1);
    expect(call.options.tools?.map((definition) => definition.function.name)).toEqual(['noop']);
    await runtime.shutdown();
  });

  it('does not apply session provenance to manual history', async () => {
    const provider = MockProvider.fn(() => ({ content: 'reply' }));
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const chat = agent({ model: 'mock:test' });
    const ctx = runtime.createContext({
      sessionHistory: [{ role: 'user', content: 'manual' }],
    });

    await ctx.ask(chat, 'manual');
    expect(provider.calls[0]?.messages).toEqual([
      { role: 'user', content: 'manual' },
      { role: 'user', content: 'manual' },
    ]);
    await runtime.shutdown();
  });

  it('keeps child-context history isolated from the parent session marker', async () => {
    const { runtime, provider, session } = makeHarness({
      handler: (ctx, chat) => ctx.createChildContext().ask(chat, ctx.input as ModelInput),
    });
    await session.send('chat-workflow', 'child');

    expect(provider.calls[0]?.messages).toEqual([{ role: 'user', content: 'child' }]);
    await runtime.shutdown();
  });

  it('gives concurrent first asks independent history snapshots with one current user each', async () => {
    const { runtime, provider, session } = makeHarness({
      handler: async (ctx, chat) => {
        const [first] = await Promise.all([
          ctx.ask(chat, ctx.input as ModelInput),
          ctx.ask(chat, ctx.input as ModelInput),
        ]);
        return first;
      },
    });
    await session.send('chat-workflow', 'parallel');

    expect(provider.calls).toHaveLength(2);
    for (const call of provider.calls) {
      expect(call.messages).toEqual([{ role: 'user', content: 'parallel' }]);
    }
    await runtime.shutdown();
  });
});
