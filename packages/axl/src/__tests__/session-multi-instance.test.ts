import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { AxlRuntime } from '../runtime.js';
import { MemoryStore } from '../state/memory.js';
import { RedisStore } from '../state/redis.js';
import { SQLiteStore } from '../state/sqlite.js';
import type { StateStore } from '../state/types.js';
import type { ChatMessage } from '../types.js';
import { workflow } from '../workflow.js';
import { MockProvider } from '../../../axl-testing/src/mock-provider.js';
import { createRedisStoreWithMockClient } from './redis-mock-client.js';

/**
 * Two `AxlRuntime`s sharing one store stand in for two app instances: each has
 * its own in-process session lock, so nothing but the store can keep their
 * saves from overwriting each other.
 */

type Gate = { open: () => void; opened: Promise<void> };
const makeGate = (): Gate => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

/** A workflow per input that replies once that input's gate opens. */
function twoInstances(store: StateStore) {
  const gates = new Map<string, Gate>();
  const started = new Map<string, Gate>();
  const gateFor = (map: Map<string, Gate>, key: string) => {
    if (!map.has(key)) map.set(key, makeGate());
    return map.get(key)!;
  };
  const chat = workflow({
    name: 'chat',
    input: z.string(),
    handler: async (ctx) => {
      gateFor(started, ctx.input).open();
      await gateFor(gates, ctx.input).opened;
      return `reply to ${ctx.input}`;
    },
  });
  const instance = () => {
    const runtime = new AxlRuntime({ state: { store } });
    runtime.register(chat);
    return runtime;
  };
  return {
    first: instance(),
    second: instance(),
    release: (input: string) => gateFor(gates, input).open(),
    untilStarted: (input: string) => gateFor(started, input).opened,
  };
}

const contents = (history: ChatMessage[]) => history.map((message) => message.content);

const tempDirs: string[] = [];
const stores: Array<[string, () => StateStore]> = [
  ['MemoryStore', () => new MemoryStore()],
  [
    'SQLiteStore',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'axl-session-'));
      tempDirs.push(dir);
      return new SQLiteStore(join(dir, 'state.db'));
    },
  ],
  ['RedisStore', () => createRedisStoreWithMockClient().store],
];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.each(stores)('overlapping session turns on %s', (_name, createStore) => {
  it('keeps both turns of overlapping send() calls, each one in one piece', async () => {
    const { first, second, release, untilStarted } = twoInstances(createStore());
    const a = first.session('chat').send('chat', 'A');
    await untilStarted('A');
    const b = second.session('chat').send('chat', 'B');
    await untilStarted('B');

    release('B');
    await b;
    release('A');
    await a;

    expect(contents(await first.session('chat').history())).toEqual([
      'B',
      'reply to B',
      'A',
      'reply to A',
    ]);
  });

  it('keeps both turns of overlapping stream() calls', async () => {
    const { first, second, release, untilStarted } = twoInstances(createStore());
    const a = await first.session('chat').stream('chat', 'A');
    await untilStarted('A');
    const b = await second.session('chat').stream('chat', 'B');
    await untilStarted('B');

    release('A');
    await a.promise;
    release('B');
    await b.promise;

    await vi.waitFor(async () => {
      expect(contents(await first.session('chat').history())).toEqual([
        'A',
        'reply to A',
        'B',
        'reply to B',
      ]);
    });
  });

  it('keeps earlier history when overlapping turns are merged', async () => {
    const { first, second, release, untilStarted } = twoInstances(createStore());
    release('before');
    await first.session('chat').send('chat', 'before');

    const a = first.session('chat').send('chat', 'A');
    await untilStarted('A');
    const b = second.session('chat').send('chat', 'B');
    await untilStarted('B');
    release('A');
    await a;
    release('B');
    await b;

    expect(contents(await second.session('chat').history())).toEqual([
      'before',
      'reply to before',
      'A',
      'reply to A',
      'B',
      'reply to B',
    ]);
  });

  it('tells you when turns overlapped, and stays quiet when they did not', async () => {
    const { first, second, release, untilStarted } = twoInstances(createStore());
    const merged = vi.fn();
    first.on('session_turns_merged', merged);
    second.on('session_turns_merged', merged);

    release('one');
    await first.session('chat').send('chat', 'one');
    release('two');
    await second.session('chat').send('chat', 'two');
    expect(merged).not.toHaveBeenCalled();

    const a = first.session('chat').send('chat', 'A');
    await untilStarted('A');
    const b = second.session('chat').send('chat', 'B');
    await untilStarted('B');
    release('A');
    await a;
    release('B');
    await b;
    expect(merged).toHaveBeenCalledTimes(1);
    expect(merged).toHaveBeenCalledWith({ sessionId: 'chat' });
  });

  it('does not bring back a session another instance ended during the turn', async () => {
    const { first, second, release, untilStarted } = twoInstances(createStore());
    release('before');
    await first.session('chat').send('chat', 'before');
    const discarded = vi.fn();
    first.on('session_turn_discarded', discarded);

    const turn = first.session('chat').send('chat', 'A');
    await untilStarted('A');
    await second.session('chat').end();
    release('A');

    await expect(turn).resolves.toBe('reply to A');
    expect(await second.session('chat').history()).toEqual([]);
    expect(discarded).toHaveBeenCalledWith({ sessionId: 'chat' });
  });

  it('saves the first turn of a new session', async () => {
    const { first, release } = twoInstances(createStore());
    const discarded = vi.fn();
    first.on('session_turn_discarded', discarded);
    release('A');
    await first.session('chat').send('chat', 'A');
    expect(contents(await first.session('chat').history())).toEqual(['A', 'reply to A']);
    expect(discarded).not.toHaveBeenCalled();
  });

  it('writes nothing for a session with persist: false', async () => {
    const { first, release } = twoInstances(createStore());
    release('A');
    await first.session('chat', { persist: false }).send('chat', 'A');
    expect(await first.session('chat').history()).toEqual([]);
  });
});

describe('merging with history limits', () => {
  function chatRuntime(store: StateStore, seen: ChatMessage[][]) {
    const provider = MockProvider.fn((messages) => {
      seen.push(messages);
      if (messages.some((m) => String(m.content).includes('Summarize'))) {
        return { content: 'a summary' };
      }
      return { content: 'answer' };
    });
    const runtime = new AxlRuntime({ defaultProvider: 'mock', state: { store } });
    runtime.registerProvider('mock', provider);
    runtime.register(
      workflow({
        name: 'chat',
        input: z.string(),
        handler: async (ctx) =>
          ctx.ask(agent({ name: 'a', model: 'mock:test', system: 'be brief' }), ctx.input),
      }),
    );
    return runtime;
  }

  it('sends the model no more than maxMessages on the turn after a merge', async () => {
    const store = new MemoryStore();
    const { first, second, release, untilStarted } = twoInstances(store);
    const options = { history: { maxMessages: 4 } };
    for (const input of ['one', 'two']) {
      release(input);
      await first.session('chat', options).send('chat', input);
    }
    const a = first.session('chat', options).send('chat', 'A');
    await untilStarted('A');
    const b = second.session('chat', options).send('chat', 'B');
    await untilStarted('B');
    release('A');
    await a;
    release('B');
    await b;

    const seen: ChatMessage[][] = [];
    await chatRuntime(store, seen).session('chat', options).send('chat', 'next');

    const sent = seen[0].filter((m) => m.role !== 'system');
    expect(sent.length).toBeLessThanOrEqual(5);
    expect(contents(await store.getSession('chat')).length).toBeLessThanOrEqual(6);
    expect(contents(await store.getSession('chat'))).toContain('B');
  });

  it('keeps the summary, which is the only record of messages already dropped', async () => {
    const store = new MemoryStore();
    await store.saveSessionMeta('chat', 'summaryCache', 'facts from dropped messages');
    const { first, second, release, untilStarted } = twoInstances(store);
    const a = first.session('chat').send('chat', 'A');
    await untilStarted('A');
    const b = second.session('chat').send('chat', 'B');
    await untilStarted('B');
    release('A');
    await a;
    release('B');
    await b;

    expect(await store.getSessionMeta('chat', 'summaryCache')).toBe('facts from dropped messages');
  });
});

describe('merging provider metadata', () => {
  it('removes Anthropic thinking from merged messages, whose signed history changed', async () => {
    const store = new MemoryStore();
    const thinking = { anthropicThinkingBlocks: [{ type: 'thinking', thinking: 'x' }], other: 1 };
    const gate = makeGate();
    const started = makeGate();
    const provider = MockProvider.fn(() => {
      started.open();
      return gate.opened.then(() => ({ content: 'answer', providerMetadata: thinking }));
    });
    const runtime = new AxlRuntime({ defaultProvider: 'mock', state: { store } });
    runtime.registerProvider('mock', provider);
    runtime.register(
      workflow({
        name: 'chat',
        input: z.string(),
        handler: async (ctx) =>
          ctx.ask(agent({ name: 'a', model: 'mock:test', system: 'be brief' }), ctx.input),
      }),
    );

    const turn = runtime.session('chat').send('chat', 'mine');
    await started.opened;
    await store.saveSession('chat', [{ role: 'user', content: 'from another instance' }]);
    gate.open();
    await turn;

    const history = await store.getSession('chat');
    expect(contents(history)[0]).toBe('from another instance');
    const reply = history.at(-1)!;
    expect(reply.content).toBe('answer');
    expect(reply.providerMetadata).toEqual({ other: 1 });
  });

  it('keeps Anthropic thinking when nothing overlapped', async () => {
    const store = new MemoryStore();
    const thinking = { anthropicThinkingBlocks: [{ type: 'thinking', thinking: 'x' }] };
    const provider = MockProvider.fn(() => ({ content: 'answer', providerMetadata: thinking }));
    const runtime = new AxlRuntime({ defaultProvider: 'mock', state: { store } });
    runtime.registerProvider('mock', provider);
    runtime.register(
      workflow({
        name: 'chat',
        input: z.string(),
        handler: async (ctx) =>
          ctx.ask(agent({ name: 'a', model: 'mock:test', system: 'be brief' }), ctx.input),
      }),
    );
    await runtime.session('chat').send('chat', 'mine');
    expect((await store.getSession('chat')).at(-1)!.providerMetadata).toEqual(thinking);
  });
});

describe('a custom store without updateSession', () => {
  it('keeps using saveSession', async () => {
    const inner = new MemoryStore();
    const store = new Proxy(inner, {
      get(target, key) {
        if (key === 'updateSession') return undefined;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as StateStore;
    const save = vi.spyOn(inner, 'saveSession');
    const { first, release } = twoInstances(store);
    release('A');
    await first.session('chat').send('chat', 'A');
    expect(save).toHaveBeenCalledTimes(1);
    expect(contents(await inner.getSession('chat'))).toEqual(['A', 'reply to A']);
  });
});

describe('MemoryStore subclasses', () => {
  it('still go through an overridden saveSession', async () => {
    const saved: string[] = [];
    class AuditedStore extends MemoryStore {
      override async saveSession(id: string, history: ChatMessage[]): Promise<void> {
        saved.push(id);
        await super.saveSession(id, history);
      }
    }
    const { first, release } = twoInstances(new AuditedStore());
    release('A');
    await first.session('chat').send('chat', 'A');
    expect(saved).toEqual(['chat']);
  });
});

describe('built-in stores whose session methods are overridden', () => {
  /** Add this to any store class: what it writes can't be read without its own getSession. */
  function encrypting<T extends new (...args: never[]) => StateStore>(Base: T) {
    return class extends Base {
      writes = 0;
      override async saveSession(id: string, history: ChatMessage[]): Promise<void> {
        this.writes++;
        const sealed = Buffer.from(JSON.stringify(history)).toString('base64');
        await super.saveSession(id, [{ role: 'user', content: sealed }]);
      }
      override async getSession(id: string): Promise<ChatMessage[]> {
        const [sealed] = await super.getSession(id);
        if (!sealed) return [];
        return JSON.parse(Buffer.from(String(sealed.content), 'base64').toString());
      }
    };
  }

  const sqliteStore = () => {
    const dir = mkdtempSync(join(tmpdir(), 'axl-session-'));
    tempDirs.push(dir);
    const Encrypting = encrypting(SQLiteStore as never) as unknown as new (
      path: string,
    ) => StateStore & {
      writes: number;
    };
    return new Encrypting(join(dir, 'state.db'));
  };
  const redisStore = () => {
    const { store } = createRedisStoreWithMockClient();
    const Encrypting = encrypting(RedisStore as never) as unknown as { prototype: object };
    Object.setPrototypeOf(store, Encrypting.prototype);
    return Object.assign(store, { writes: 0 });
  };

  it.each([
    ['SQLiteStore', sqliteStore],
    ['RedisStore', redisStore],
  ])('%s goes through the overrides, and says it has no protection', async (name, create) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = create();
    const { first, release } = twoInstances(store);
    for (const input of ['A', 'B']) {
      release(input);
      await first.session('chat').send('chat', input);
    }

    expect(store.writes).toBe(2);
    expect(contents(await store.getSession('chat'))).toEqual([
      'A',
      'reply to A',
      'B',
      'reply to B',
    ]);
    const warnings = warn.mock.calls.flat().join(' ');
    expect(warnings).toContain(name);
    expect(warnings).toContain('updateSession');
    warn.mockRestore();
  });
});

describe('a summary written during an overlap', () => {
  const options = { history: { maxMessages: 2, summarize: true, summaryModel: 'mock:summary' } };
  const seed: ChatMessage[] = ['1', '2', '3', '4', '5', '6'].map((content) => ({
    role: 'user',
    content,
  }));

  it('does not replace a newer summary when history changed while it was generated', async () => {
    const store = new MemoryStore();
    await store.saveSession('chat', seed);
    const { second, release } = twoInstances(store);
    const summarizing = makeGate();
    const finishSummary = makeGate();
    vi.spyOn(second, 'summarizeMessages').mockImplementation(async () => {
      summarizing.open();
      await finishSummary.opened;
      return 'older summary';
    });

    release('B');
    const turn = second.session('chat', options).send('chat', 'B');
    await summarizing.opened;
    // Another instance summarizes further and trims while this one is still working.
    await store.saveSessionMeta('chat', 'summaryCache', 'newer summary');
    await store.saveSession('chat', seed.slice(-2));
    finishSummary.open();
    await turn;

    expect(await store.getSessionMeta('chat', 'summaryCache')).toBe('newer summary');
    expect(contents(await store.getSession('chat'))).toEqual(['5', '6', 'B', 'reply to B']);
  });

  it('saves the summary when nothing else changed', async () => {
    const store = new MemoryStore();
    await store.saveSession('chat', seed);
    const { first, release } = twoInstances(store);
    vi.spyOn(first, 'summarizeMessages').mockResolvedValue('a summary');
    release('A');
    await first.session('chat', options).send('chat', 'A');
    expect(await store.getSessionMeta('chat', 'summaryCache')).toBe('a summary');
    expect(contents(await store.getSession('chat'))).toEqual(['5', '6', 'A', 'reply to A']);
  });
});

describe('a listener that throws', () => {
  it('does not fail a turn that was saved', async () => {
    const store = new MemoryStore();
    const { first, second, release, untilStarted } = twoInstances(store);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    second.on('session_turns_merged', () => {
      throw new Error('listener broke');
    });
    const failed = vi.fn();
    second.on('error', failed);

    const a = first.session('chat').send('chat', 'A');
    await untilStarted('A');
    const b = await second.session('chat').stream('chat', 'B');
    await untilStarted('B');
    release('A');
    await a;
    release('B');
    await b.promise;

    await vi.waitFor(async () => {
      expect(contents(await store.getSession('chat'))).toEqual([
        'A',
        'reply to A',
        'B',
        'reply to B',
      ]);
    });
    await vi.waitFor(() =>
      expect(consoleError.mock.calls.flat().join(' ')).toContain('listener broke'),
    );
    expect(failed).not.toHaveBeenCalled();

    const c = first.session('chat').send('chat', 'C');
    await untilStarted('C');
    const d = second.session('chat').send('chat', 'D');
    await untilStarted('D');
    release('C');
    await c;
    release('D');
    await expect(d).resolves.toBe('reply to D');
    consoleError.mockRestore();
  });
});

describe('RedisStore.updateSession', () => {
  const message = (content: string): ChatMessage => ({ role: 'user', content });

  it('recomputes on a conflicting write, and writes the result of the latest read', async () => {
    const { store, mockClient, data } = createRedisStoreWithMockClient();
    await store.saveSession('s', [message('base')]);
    const realEval = mockClient.eval.getMockImplementation()!;
    // Another instance writes between this update's read and its write.
    mockClient.eval.mockImplementationOnce(async (script, options) => {
      data.set('axl:session:s', JSON.stringify([message('base'), message('other')]));
      return realEval(script, options);
    });

    const seen: string[][] = [];
    await store.updateSession('s', (current) => {
      seen.push(contents(current!) as string[]);
      return [...current!, message('mine')];
    });

    expect(seen).toEqual([['base'], ['base', 'other']]);
    expect(contents(await store.getSession('s'))).toEqual(['base', 'other', 'mine']);
  });

  it('sees a missing session as null, and creates it only if it is still missing', async () => {
    const { store, mockClient, data } = createRedisStoreWithMockClient();
    const realEval = mockClient.eval.getMockImplementation()!;
    mockClient.eval.mockImplementationOnce(async (script, options) => {
      data.set('axl:session:s', JSON.stringify([message('other')]));
      return realEval(script, options);
    });
    const seen: unknown[] = [];
    await store.updateSession('s', (current) => {
      seen.push(current);
      return [...(current ?? []), message('mine')];
    });
    expect(seen[0]).toBeNull();
    expect(contents(await store.getSession('s'))).toEqual(['other', 'mine']);
  });

  it('writes nothing when the update returns null', async () => {
    const { store, mockClient } = createRedisStoreWithMockClient();
    await store.updateSession('s', () => null);
    expect(mockClient.eval).not.toHaveBeenCalled();
    expect(await store.listSessions()).toEqual([]);
  });

  it('adds the session to the listing and applies its retention', async () => {
    const { store, ttls } = createRedisStoreWithMockClient('axl:', { session: 60 });
    await store.updateSession('s', () => [message('mine')]);
    expect(await store.listSessions()).toEqual(['s']);
    expect(ttls.get('axl:session:s')).toBe(60);
  });

  it('gives up with SESSION_CONFLICT if it keeps losing', async () => {
    const { store, mockClient } = createRedisStoreWithMockClient();
    mockClient.eval.mockResolvedValue(0);
    await expect(store.updateSession('s', () => [message('mine')])).rejects.toMatchObject({
      code: 'SESSION_CONFLICT',
    });
  });

  it('falls back to a plain save and warns when EVAL is not permitted', async () => {
    const { store, mockClient } = createRedisStoreWithMockClient();
    mockClient.eval.mockRejectedValue(new Error('NOPERM this user has no permissions'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store.updateSession('s', () => [message('mine')]);
    expect(contents(await store.getSession('s'))).toEqual(['mine']);
    expect(warn.mock.calls.flat().join(' ')).toContain('EVAL');
    warn.mockRestore();
  });

  it('passes on other failures', async () => {
    const { store, mockClient } = createRedisStoreWithMockClient();
    mockClient.eval.mockRejectedValue(new Error('READONLY replica'));
    await expect(store.updateSession('s', () => [message('mine')])).rejects.toThrow('READONLY');
  });
});

/** The real script on a real server. Set `REDIS_URL` to run. */
describe.skipIf(!process.env.REDIS_URL)('overlapping session turns on real Redis', () => {
  const open = () =>
    RedisStore.create({
      url: process.env.REDIS_URL,
      keyPrefix: `axl-test-${randomUUID()}:`,
      skipMigration: true,
      ttls: { executionHistory: null, session: 60 },
    });

  it('keeps both turns, and a session ended during a turn stays ended', async () => {
    const store = await open();
    try {
      const { first, second, release, untilStarted } = twoInstances(store);
      const a = first.session('chat').send('chat', 'A');
      await untilStarted('A');
      const b = second.session('chat').send('chat', 'B');
      await untilStarted('B');
      release('A');
      await a;
      release('B');
      await b;
      expect(contents(await store.getSession('chat'))).toEqual([
        'A',
        'reply to A',
        'B',
        'reply to B',
      ]);

      const discarded = vi.fn();
      first.on('session_turn_discarded', discarded);
      const c = first.session('chat').send('chat', 'C');
      await untilStarted('C');
      await second.session('chat').end();
      release('C');
      await c;
      expect(await store.getSession('chat')).toEqual([]);
      expect(discarded).toHaveBeenCalledWith({ sessionId: 'chat' });
    } finally {
      await store.close();
    }
  });
});
