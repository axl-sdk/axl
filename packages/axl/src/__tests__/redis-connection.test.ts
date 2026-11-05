import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { AxlRuntime } from '../runtime.js';
import { agent } from '../agent.js';
import { workflow } from '../workflow.js';
import { RedisStore } from '../state/redis.js';
import type { RedisConnectionEvent } from '../state/redis.js';
import { startFakeRedis, isHandshakeCommand, type FakeRedis } from './redis-fake-server.js';

/**
 * Real node-redis against an in-process fake server, so that the client's own
 * connection handling runs in the default test suite. The mock client used
 * elsewhere can't reach these paths.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(5);
  }
}

const isApplicationCommand = (command: string[]) => !isHandshakeCommand(command);

/** Open TCP sockets holding the process open. The fake server's own are unref'd. */
const socketsHoldingProcess = () =>
  process.getActiveResourcesInfo().filter((resource) => resource === 'TCPSocketWrap').length;

describe('RedisStore connection handling', () => {
  let fake: FakeRedis;
  let stores: RedisStore[];
  const uncaught = vi.fn();
  const unhandled = vi.fn();
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  const open = async (extra?: { onConnectionEvent?: (event: RedisConnectionEvent) => void }) => {
    const store = await RedisStore.create({
      url: fake.url,
      skipMigration: true,
      ttls: { executionHistory: null },
      ...extra,
    });
    stores.push(store);
    return store;
  };
  const isReady = (store: RedisStore) =>
    (store as unknown as { connection: { isReady: boolean } }).connection.isReady;
  const connectionLogs = () =>
    warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('[axl] RedisStore'));

  beforeEach(async () => {
    fake = await startFakeRedis();
    stores = [];
    uncaught.mockClear();
    unhandled.mockClear();
    process.on('uncaughtException', uncaught);
    process.on('unhandledRejection', unhandled);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    fake.hold = () => false;
    await Promise.allSettled(stores.map((store) => store.close()));
    await fake.stop().catch(() => {});
    await sleep(0);
    process.off('uncaughtException', uncaught);
    process.off('unhandledRejection', unhandled);
    vi.restoreAllMocks();
    expect(uncaught).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  });

  describe('a dropped connection', () => {
    it('does not raise an uncaught exception while idle, and the store recovers', async () => {
      const store = await open();

      fake.dropConnections();
      await sleep(50);
      expect(uncaught).not.toHaveBeenCalled();

      await waitUntil(() => isReady(store));
      await store.saveSession('s1', [{ role: 'user', content: 'hi' }]);
      expect(await store.getSession('s1')).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('does not raise an uncaught exception with commands awaiting replies', async () => {
      const store = await open();
      fake.hold = isApplicationCommand;
      const read = store.getSession('s1');
      const write = store.saveSession('s1', [{ role: 'user', content: 'hi' }]);
      await fake.waitForCommand((command) => command[0] === 'GET');

      fake.dropConnections();

      await expect(read).rejects.toThrow('Socket closed unexpectedly');
      await expect(write).rejects.toThrow('Socket closed unexpectedly');
      expect(uncaught).not.toHaveBeenCalled();
    });

    it('recovers after the server stops and comes back on the same port', async () => {
      const store = await open();

      await fake.stop();
      await sleep(150);
      expect(uncaught).not.toHaveBeenCalled();
      await fake.start();
      await waitUntil(() => isReady(store));

      await store.saveSession('s1', [{ role: 'user', content: 'back' }]);
      expect(await store.getSession('s1')).toEqual([{ role: 'user', content: 'back' }]);
    });
  });

  describe('commands while disconnected', () => {
    const disconnect = async (store: RedisStore) => {
      await fake.stop();
      await waitUntil(() => !isReady(store));
    };
    const unavailable = { name: 'AxlError', code: 'REDIS_UNAVAILABLE' };

    it('rejects a single command immediately', async () => {
      const store = await open();
      await disconnect(store);

      await expect(store.getSession('s1')).rejects.toMatchObject(unavailable);
    });

    it('rejects a transaction immediately, and never sends it after recovery', async () => {
      const store = await open();
      await disconnect(store);

      const start = Date.now();
      await expect(
        store.saveSession('lost', [{ role: 'user', content: 'hi' }]),
      ).rejects.toMatchObject(unavailable);
      expect(Date.now() - start).toBeLessThan(500);

      await fake.start();
      await waitUntil(() => isReady(store));
      await sleep(50);
      expect(fake.commands.some((command) => command.includes('axl:session:lost'))).toBe(false);
      expect(await store.getSession('lost')).toEqual([]);
    });

    it.each<[string, (store: RedisStore) => Promise<unknown>]>([
      ['hash read', (store) => store.getPendingDecisions()],
      ['list write', (store) => store.appendStreamingEvents!('e1', [{} as never])],
      ['sorted-set read', (store) => store.listExecutions!(10)],
      ['eval-backed maintenance', (store) => store.applyHistoryRetention!({ kind: 'executions' })],
    ])('rejects a %s immediately', async (_label, call) => {
      const store = await open();
      await disconnect(store);

      await expect(call(store)).rejects.toMatchObject(unavailable);
    });

    it('rejects commands awaiting replies once, without re-sending them', async () => {
      const store = await open();
      fake.hold = isApplicationCommand;
      const read = store.getSession('once');
      const write = store.saveSession('once', [{ role: 'user', content: 'hi' }]);
      await fake.waitForCommand((command) => command[0] === 'EXEC');
      const sentCount = (name: string) =>
        fake.commands.filter(
          (command) => command[0] === name && command.includes('axl:session:once'),
        ).length;
      const before = { get: sentCount('GET'), set: sentCount('SET') };

      fake.hold = () => false;
      fake.dropConnections();
      await expect(read).rejects.toThrow('Socket closed unexpectedly');
      await expect(write).rejects.toThrow('Socket closed unexpectedly');
      await waitUntil(() => isReady(store));
      await sleep(50);

      expect({ get: sentCount('GET'), set: sentCount('SET') }).toEqual(before);
    });

    it('keeps the "client is closed" rejection on a closed store', async () => {
      const store = await open();
      await store.close();

      await expect(store.getSession('s1')).rejects.toThrow('The client is closed');
      await expect(store.getSession('s1')).rejects.not.toMatchObject(unavailable);
    });

    it('does not spend the EVAL permission warning on a lost connection', async () => {
      const store = await RedisStore.create({
        url: fake.url,
        skipMigration: true,
        ttls: { executionHistory: 60 },
      });
      stores.push(store);
      fake.hold = (command) => command[0] === 'ZRANGE';
      const saved = store.saveExecution!({
        executionId: 'e1',
        workflow: 'w',
        status: 'completed',
        events: [],
        totalCost: 0,
        startedAt: Date.now(),
      } as never);
      await fake.waitForCommand((command) => command[0] === 'ZRANGE');

      fake.dropConnections();
      await saved;
      await sleep(10);

      expect(warn.mock.calls.flat().join(' ')).not.toContain('EVAL');
    });
  });

  describe('close()', () => {
    it('resolves while disconnected, stops retrying, and is idempotent', async () => {
      const store = await open();
      await fake.stop();
      await waitUntil(() => !isReady(store));

      const start = Date.now();
      await store.close();
      expect(Date.now() - start).toBeLessThan(100);
      await store.close();

      await fake.start();
      await sleep(50); // a retry already scheduled wakes, sees the store closed, and stops
      const after = fake.connectionCount();
      await sleep(2500);
      expect(fake.connectionCount()).toBe(after);
    });

    it('resolves when the connection drops before QUIT is answered', async () => {
      const store = await open();
      fake.hold = (command) => command[0] === 'QUIT';
      const closing = store.close();
      await fake.waitForCommand((command) => command[0] === 'QUIT');

      fake.dropConnections();

      await expect(closing).resolves.toBeUndefined();
    });

    it('resolves when the server never answers QUIT', async () => {
      const store = await open();
      fake.hold = (command) => command[0] === 'QUIT';

      const start = Date.now();
      await store.close();

      expect(Date.now() - start).toBeLessThan(2500);
    });

    it('resolves and reports nothing further when a reconnect is mid-handshake', async () => {
      const onConnectionEvent = vi.fn();
      const store = await open({ onConnectionEvent });
      const seen = fake.commands.length;
      fake.hold = isHandshakeCommand;
      fake.dropConnections();
      await waitUntil(() => fake.commands.length > seen);
      onConnectionEvent.mockClear();

      await store.close();
      fake.hold = () => false;
      await sleep(100);

      expect(onConnectionEvent).not.toHaveBeenCalled();
    });

    it('lets queued commands finish on a healthy connection', async () => {
      const store = await open();
      await store.saveSession('s1', [{ role: 'user', content: 'hi' }]);

      const read = store.getSession('s1');
      await store.close();

      await expect(read).resolves.toEqual([{ role: 'user', content: 'hi' }]);
      expect(fake.commands.at(-1)?.[0]).toBe('QUIT');
    });
  });

  describe('isConnected', () => {
    it('follows the connection through an outage and close()', async () => {
      const store = await open();
      expect(store.isConnected).toBe(true);

      await fake.stop();
      await waitUntil(() => !store.isConnected);
      await fake.start();
      await waitUntil(() => store.isConnected);

      await store.close();
      expect(store.isConnected).toBe(false);
    });
  });

  describe('create()', () => {
    it('rejects promptly when nothing is listening, and stops trying', async () => {
      await fake.stop();
      const before = fake.connectionCount();

      const start = Date.now();
      await expect(RedisStore.create({ url: fake.url, skipMigration: true })).rejects.toThrow(
        'ECONNREFUSED',
      );
      expect(Date.now() - start).toBeLessThan(1000);

      await fake.start();
      await sleep(400);
      expect(fake.connectionCount()).toBe(before);
    });

    it('rejects when the server fails the handshake, and stops trying', async () => {
      const rejecting = await startFakeRedis({ auth: 'reject' });
      try {
        await expect(
          RedisStore.create({
            url: `redis://:secret@127.0.0.1:${rejecting.port}`,
            skipMigration: true,
          }),
        ).rejects.toThrow('WRONGPASS');
        const after = rejecting.connectionCount();
        await sleep(400);
        expect(rejecting.connectionCount()).toBe(after);
      } finally {
        await rejecting.stop();
      }
    });

    it('rejects when the connection drops during startup work, and stops trying', async () => {
      const socketsBefore = socketsHoldingProcess();
      fake.hold = isApplicationCommand;
      const creating = RedisStore.create({ url: fake.url, ttls: { executionHistory: null } });
      await fake.waitForCommand(isApplicationCommand);

      fake.dropConnections();

      await expect(creating).rejects.toThrow('Socket closed unexpectedly');
      // A reconnect may already have been underway when the drop was seen. Past
      // that one, nothing retries.
      await sleep(100);
      const after = fake.connectionCount();
      await sleep(400);
      expect(fake.connectionCount()).toBe(after);
      expect(socketsHoldingProcess()).toBeLessThanOrEqual(socketsBefore);
    });

    it('does not report a failed create() through the callback or the log', async () => {
      await fake.stop();
      const onConnectionEvent = vi.fn();

      await expect(
        RedisStore.create({ url: fake.url, skipMigration: true, onConnectionEvent }),
      ).rejects.toThrow('ECONNREFUSED');

      expect(onConnectionEvent).not.toHaveBeenCalled();
      expect(connectionLogs()).toEqual([]);
    });
  });

  describe('observing the connection', () => {
    it('logs one line per outage and one on recovery by default, without credentials', async () => {
      const secured = await startFakeRedis();
      try {
        const store = await RedisStore.create({
          url: `redis://:s3cret@127.0.0.1:${secured.port}`,
          skipMigration: true,
          ttls: { executionHistory: null },
        });
        stores.push(store);

        await secured.stop();
        await sleep(500); // several failed reconnect attempts
        expect(connectionLogs()).toHaveLength(1);
        expect(connectionLogs()[0]).toMatch(/Redis connection lost/);

        await secured.start();
        await waitUntil(() => isReady(store));
        await waitUntil(() => connectionLogs().length === 2);
        expect(connectionLogs()[1]).toMatch(/reconnected/);
        expect(connectionLogs().join('\n')).not.toContain('s3cret');

        // A second outage is reported again.
        secured.dropConnections();
        await waitUntil(() => connectionLogs().length >= 3);
      } finally {
        await stores.pop()?.close();
        await secured.stop().catch(() => {});
      }
    });

    it('delivers every error and the recovery to the callback, instead of logging', async () => {
      const events: RedisConnectionEvent[] = [];
      const store = await open({ onConnectionEvent: (event) => events.push(event) });

      await fake.stop();
      await sleep(300);
      await fake.start();
      await waitUntil(() => isReady(store));
      await waitUntil(() => events.at(-1)?.type === 'reconnected');

      const errors = events.filter((event) => event.type === 'error');
      expect(errors.length).toBeGreaterThan(1);
      expect(errors.every((event) => event.type === 'error' && event.error instanceof Error)).toBe(
        true,
      );
      expect(events.filter((event) => event.type === 'reconnected')).toHaveLength(1);
      expect(connectionLogs()).toEqual([]);
    });

    it('contains a callback that throws', async () => {
      const store = await open({
        onConnectionEvent: () => {
          throw new Error('callback broke');
        },
      });

      fake.dropConnections();
      await waitUntil(() => isReady(store));
      await sleep(0);

      expect(uncaught).not.toHaveBeenCalled();
      expect(error.mock.calls.flat().join(' ')).toContain('callback broke');
    });

    it('contains a callback that returns a rejected promise', async () => {
      const store = await open({
        onConnectionEvent: async () => {
          throw new Error('async callback broke');
        },
      });

      fake.dropConnections();
      await waitUntil(() => isReady(store));
      await sleep(10);

      expect(unhandled).not.toHaveBeenCalled();
      expect(error.mock.calls.flat().join(' ')).toContain('async callback broke');
    });
  });

  describe('the runtime during an outage', () => {
    const unavailable = { code: 'REDIS_UNAVAILABLE' };
    const provider = {
      name: 'test',
      chat: async () => ({
        content: 'done',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 0,
      }),
      async *stream() {
        yield { type: 'text_delta' as const, content: 'done' };
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
    };
    const assistant = agent({ name: 'assistant', model: 'test:m', system: 's' });
    const input = z.object({ q: z.string() });

    /**
     * A runtime on the store, with one workflow that runs `before`, signals
     * `running`, waits for `release`, then runs `body`.
     */
    const setup = async <T>(
      body: (ctx: never, earlier: unknown) => Promise<T>,
      before: (ctx: never) => Promise<unknown> = async () => undefined,
    ) => {
      const store = await open();
      const runtime = new AxlRuntime({ state: { store } });
      runtime.registerProvider('test', provider as never);
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let started!: () => void;
      const running = new Promise<void>((resolve) => (started = resolve));
      runtime.register(
        workflow({
          name: 'wf',
          input,
          handler: async (ctx) => {
            const earlier = await before(ctx as never);
            started();
            await released;
            return body(ctx as never, earlier);
          },
        }),
      );
      const disconnect = async () => {
        await fake.stop();
        await waitUntil(() => !isReady(store));
      };
      return { store, runtime, release, running, disconnect };
    };
    const errorLogs = () => error.mock.calls.flat().map(String).join('\n');

    it('returns the result of a workflow that finishes, and logs the lost history', async () => {
      const { runtime, release, running, disconnect } = await setup(async () => 'result');
      const execution = runtime.execute('wf', { q: 'hi' });
      await running;

      await disconnect();
      release();

      await expect(execution).resolves.toBe('result');
      await waitUntil(() => errorLogs().includes('execution history'));
      expect(errorLogs()).toContain('not connected to Redis');
    });

    it('fails a workflow whose checkpoint needs the store', async () => {
      const { runtime, release, running, disconnect } = await setup((ctx: any) =>
        ctx.checkpoint('step', async () => 1),
      );
      const execution = runtime.execute('wf', { q: 'hi' });
      await running;

      await disconnect();
      release();

      await expect(execution).rejects.toMatchObject(unavailable);
    });

    it('fails a workflow awaiting approval with the outage error', async () => {
      const { runtime, release, running, disconnect } = await setup((ctx: any) =>
        ctx.awaitHuman({ channel: 'ops', prompt: 'approve?' }),
      );
      const execution = runtime.execute('wf', { q: 'hi' });
      await running;

      await disconnect();
      release();

      await expect(execution).rejects.toMatchObject(unavailable);
    });

    it('keeps a paid model answer when Redis drops during the call', async () => {
      const { runtime, disconnect } = await setup(async () => undefined);
      let finishModelCall!: () => void;
      const modelCall = new Promise<void>((resolve) => (finishModelCall = resolve));
      let inModelCall!: () => void;
      const modelStarted = new Promise<void>((resolve) => (inModelCall = resolve));
      const chat = provider.chat;
      vi.spyOn(provider, 'chat').mockImplementation(async () => {
        inModelCall();
        await modelCall;
        return chat();
      });
      runtime.register(
        workflow({ name: 'asks', input, handler: (ctx) => ctx.ask(assistant, 'hi') }),
      );
      const execution = runtime.execute('asks', { q: 'hi' });
      await modelStarted;
      await disconnect();
      finishModelCall();

      await expect(execution).resolves.toBe('done');
      expect(errorLogs()).toContain('Failed to save checkpoint');
    });

    it('still fails an explicit ctx.checkpoint whose result could not be saved', async () => {
      const during: { disconnect?: () => Promise<void> } = {};
      const { runtime, release, running, disconnect } = await setup((ctx: any) =>
        ctx.checkpoint('step', async () => {
          await during.disconnect!();
          return 1;
        }),
      );
      during.disconnect = disconnect;
      const execution = runtime.execute('wf', { q: 'hi' });
      await running;

      release();

      await expect(execution).rejects.toMatchObject(unavailable);
    });

    it('fails ctx.ask before calling the model, so no spend is lost', async () => {
      const chat = vi.spyOn(provider, 'chat');
      const { runtime, release, running, disconnect } = await setup((ctx: any) =>
        ctx.ask(assistant, 'hi'),
      );
      const execution = runtime.execute('wf', { q: 'hi' });
      await running;

      await disconnect();
      release();

      await expect(execution).rejects.toMatchObject(unavailable);
      expect(chat).not.toHaveBeenCalled();
    });

    it('rejects session.send immediately, before calling the workflow', async () => {
      const { runtime, disconnect, release } = await setup(async () => 'result');
      release();
      await disconnect();

      await expect(runtime.session('s1').send('wf', { q: 'hi' })).rejects.toMatchObject(
        unavailable,
      );
    });

    it('delivers a session.stream result and logs the lost turn with no listener', async () => {
      const { runtime, release, running, disconnect } = await setup(
        async (_ctx, answer) => answer,
        (ctx: any) => ctx.ask(assistant, 'hi'),
      );
      const stream = await runtime.session('s1').stream('wf', { q: 'hi' });
      await running;

      await disconnect();
      release();

      await expect(stream.promise).resolves.toBe('done');
      await waitUntil(() => errorLogs().includes('session history'));
    });

    it('emits the lost session.stream turn to a runtime error listener instead', async () => {
      const { runtime, release, running, disconnect } = await setup(
        async (_ctx, answer) => answer,
        (ctx: any) => ctx.ask(assistant, 'hi'),
      );
      const onError = vi.fn();
      runtime.on('error', onError);
      const stream = await runtime.session('s1').stream('wf', { q: 'hi' });
      await running;

      await disconnect();
      release();
      await stream.promise;

      await waitUntil(() => onError.mock.calls.length > 0);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'session_history_save_failed', sessionId: 's1' }),
      );
      expect(errorLogs()).not.toContain('session history');
    });

    it('shuts down in bounded time while disconnected', async () => {
      const { runtime, release, disconnect } = await setup(async () => 'result');
      release();
      await disconnect();

      const start = Date.now();
      await runtime.shutdown();

      expect(Date.now() - start).toBeLessThan(500);
    });
  });
});
