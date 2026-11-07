import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisStore } from '../state/redis.js';
import type { ChatMessage } from '../types.js';
import { createRedisStoreWithMockClient } from './redis-mock-client.js';

/** Session keys expire by TTL, but the id set that lists them can't expire one member. */
const history: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const idsKey = 'axl:session-ids';
const expire = (data: Map<string, string>, id: string) => data.delete(`axl:session:${id}`);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RedisStore session listing', () => {
  it('leaves out sessions that expired, and removes their ids', async () => {
    const { store, data, setData } = createRedisStoreWithMockClient();
    await store.saveSession('live', history);
    await store.saveSession('expired', history);
    expire(data, 'expired');

    expect(await store.listSessions()).toEqual(['live']);
    expect(setData.get(idsKey)).toEqual(new Set(['live']));
  });

  it('removes metadata left by an expired session, since nothing could find it later', async () => {
    const { store, data } = createRedisStoreWithMockClient();
    await store.saveSession('live', history);
    await store.saveSession('expired', history);
    await store.saveSessionMeta('live', 'summaryCache', 'kept');
    await store.saveSessionMeta('expired', 'summaryCache', 'private');
    expire(data, 'expired');

    await store.listSessions();

    expect(await store.getSessionMeta('expired', 'summaryCache')).toBeNull();
    expect(await store.getSessionMeta('live', 'summaryCache')).toBe('kept');
  });

  it('handles more sessions than one cleanup batch', async () => {
    const { store, data } = createRedisStoreWithMockClient();
    const ids = Array.from({ length: 1201 }, (_, i) => `s${i}`);
    for (const id of ids) await store.saveSession(id, history);
    for (const id of ids.slice(0, 1200)) expire(data, id);

    expect(await store.listSessions()).toEqual(['s1200']);
  });

  it('never removes a session saved just as it was being checked', async () => {
    const { store, mockClient } = createRedisStoreWithMockClient();
    await store.saveSession('s', history);
    const realEval = mockClient.eval.getMockImplementation()!;
    // The script decides by what exists when it runs, not by an earlier read.
    mockClient.eval.mockImplementationOnce(async (script, options) => {
      await store.saveSession('s', history);
      return realEval(script, options);
    });
    expect(await store.listSessions()).toEqual(['s']);
  });

  it('still lists sessions when the cleanup is not permitted, and warns', async () => {
    const { store, data, mockClient } = createRedisStoreWithMockClient();
    await store.saveSession('expired', history);
    expire(data, 'expired');
    mockClient.eval.mockRejectedValue(new Error('NOPERM this user has no permissions'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await store.listSessions()).toEqual(['expired']);
    expect(warn.mock.calls.flat().join(' ')).toContain('EVAL');
  });
});

describe('RedisStore session id cleanup on save', () => {
  it('removes expired ids as sessions are saved, without anyone listing them', async () => {
    const { store, data, setData } = createRedisStoreWithMockClient('axl:', { session: 60 });
    const ids = Array.from({ length: 120 }, (_, i) => `old${i}`);
    for (const id of ids) await store.saveSession(id, history);
    for (const id of ids) expire(data, id);

    for (let save = 0; save < 10; save++) await store.saveSession('active', history);

    expect(setData.get(idsKey)).toEqual(new Set(['active']));
  });

  it('runs for saves through updateSession too', async () => {
    const { store, data, setData } = createRedisStoreWithMockClient('axl:', { session: 60 });
    await store.saveSession('old', history);
    expire(data, 'old');
    await store.updateSession('active', () => history);
    expect(setData.get(idsKey)).toEqual(new Set(['active']));
  });

  it('does a bounded amount of work on each save', async () => {
    const { store, mockClient } = createRedisStoreWithMockClient('axl:', { session: 60 });
    for (let i = 0; i < 300; i++) await store.saveSession(`s${i}`, history);
    mockClient.sScan.mockClear();
    mockClient.eval.mockClear();

    await store.saveSession('one-more', history);

    expect(mockClient.sScan).toHaveBeenCalledTimes(1);
    expect(mockClient.eval).toHaveBeenCalledTimes(1);
    expect(mockClient.eval.mock.calls[0][1].arguments.length).toBeLessThanOrEqual(100);
  });

  it('does no extra work when sessions have no TTL, since nothing expires', async () => {
    const { store, mockClient } = createRedisStoreWithMockClient();
    await store.saveSession('s', history);
    expect(mockClient.sScan).not.toHaveBeenCalled();
  });

  it('skips the check while another save is already doing one', async () => {
    const { store, mockClient } = createRedisStoreWithMockClient('axl:', { session: 60 });
    const realScan = mockClient.sScan.getMockImplementation()!;
    let finishScan = () => {};
    const scanFinished = new Promise<void>((resolve) => (finishScan = resolve));
    mockClient.sScan.mockImplementationOnce(async (key, cursor, options) => {
      await scanFinished;
      return realScan(key, cursor, options);
    });

    const slow = store.saveSession('a', history);
    await vi.waitFor(() => expect(mockClient.sScan).toHaveBeenCalledTimes(1));
    await store.saveSession('b', history);
    expect(mockClient.sScan).toHaveBeenCalledTimes(1);

    finishScan();
    await slow;
    await store.saveSession('c', history);
    expect(mockClient.sScan).toHaveBeenCalledTimes(2);
  });

  it('does not fail a save when the check loses its connection', async () => {
    const { store, mockClient } = createRedisStoreWithMockClient('axl:', { session: 60 });
    mockClient.sScan.mockRejectedValueOnce(new Error('Socket closed unexpectedly'));
    await expect(store.saveSession('s', history)).resolves.toBeUndefined();
    expect(await store.getSession('s')).toEqual(history);
  });

  it('does not fail a save when the cleanup fails', async () => {
    const { store, mockClient } = createRedisStoreWithMockClient('axl:', { session: 60 });
    await store.saveSession('first', history);
    mockClient.eval.mockRejectedValue(new Error('NOPERM this user has no permissions'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(store.saveSession('second', history)).resolves.toBeUndefined();
    expect(await store.getSession('second')).toEqual(history);
    warn.mockRestore();
  });
});

/** The real script and SSCAN on a real server. Set `REDIS_URL` to run. */
describe.skipIf(!process.env.REDIS_URL)('session ids on real Redis', () => {
  it('forgets a session after it expires', async () => {
    const store = await RedisStore.create({
      url: process.env.REDIS_URL,
      keyPrefix: `axl-test-${randomUUID()}:`,
      skipMigration: true,
      ttls: { executionHistory: null, session: 1 },
    });
    try {
      await store.saveSession('user-1:a', history);
      expect(await store.listSessions()).toEqual(['user-1:a']);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await store.saveSession('user-2:b', history);
      expect(await store.listSessions()).toEqual(['user-2:b']);
    } finally {
      await store.close();
    }
  });
});
