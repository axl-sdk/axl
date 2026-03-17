import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../state/memory.js';
import { SQLiteStore } from '../state/sqlite.js';
import { RedisStore } from '../state/redis.js';

// Clean up the MemoryStore temp file between tests to prevent state leaking
const AWAIT_HUMAN_TEMP_FILE = join(tmpdir(), 'axl-memory-store', 'await-human-state.json');

describe('MemoryStore', () => {
  beforeEach(() => {
    try {
      if (existsSync(AWAIT_HUMAN_TEMP_FILE)) unlinkSync(AWAIT_HUMAN_TEMP_FILE);
    } catch {
      /* ignore */
    }
  });
  // ── Checkpoints ────────────────────────────────────────────────────────

  describe('checkpoints', () => {
    it('save and load a checkpoint', async () => {
      const store = new MemoryStore();
      await store.saveCheckpoint('exec-1', 0, { progress: 'step 0' });

      const loaded = await store.getCheckpoint('exec-1', 0);
      expect(loaded).toEqual({ progress: 'step 0' });
    });

    it('returns null for non-existent checkpoint', async () => {
      const store = new MemoryStore();
      const result = await store.getCheckpoint('nonexistent', 0);
      expect(result).toBeNull();
    });

    it('returns null for non-existent step', async () => {
      const store = new MemoryStore();
      await store.saveCheckpoint('exec-1', 0, 'data');
      const result = await store.getCheckpoint('exec-1', 99);
      expect(result).toBeNull();
    });

    it('save multiple checkpoints for same execution', async () => {
      const store = new MemoryStore();
      await store.saveCheckpoint('exec-1', 0, { step: 0 });
      await store.saveCheckpoint('exec-1', 1, { step: 1 });
      await store.saveCheckpoint('exec-1', 2, { step: 2 });

      expect(await store.getCheckpoint('exec-1', 0)).toEqual({ step: 0 });
      expect(await store.getCheckpoint('exec-1', 1)).toEqual({ step: 1 });
      expect(await store.getCheckpoint('exec-1', 2)).toEqual({ step: 2 });
    });

    it('overwrites checkpoint for same step', async () => {
      const store = new MemoryStore();
      await store.saveCheckpoint('exec-1', 0, 'original');
      await store.saveCheckpoint('exec-1', 0, 'updated');

      expect(await store.getCheckpoint('exec-1', 0)).toBe('updated');
    });

    it('getLatestCheckpoint returns latest step', async () => {
      const store = new MemoryStore();
      await store.saveCheckpoint('exec-1', 0, 'first');
      await store.saveCheckpoint('exec-1', 5, 'middle');
      await store.saveCheckpoint('exec-1', 3, 'third');

      const latest = await store.getLatestCheckpoint('exec-1');
      expect(latest).toEqual({ step: 5, data: 'middle' });
    });

    it('getLatestCheckpoint returns null for unknown execution', async () => {
      const store = new MemoryStore();
      const latest = await store.getLatestCheckpoint('unknown');
      expect(latest).toBeNull();
    });

    it('stores deep copies (mutations do not affect stored data)', async () => {
      const store = new MemoryStore();
      const data = { items: [1, 2, 3] };
      await store.saveCheckpoint('exec-1', 0, data);

      // Mutate original
      data.items.push(4);

      const loaded = await store.getCheckpoint('exec-1', 0);
      expect(loaded).toEqual({ items: [1, 2, 3] });
    });
  });

  // ── deleteCheckpoints ──────────────────────────────────────────────────

  describe('deleteCheckpoints', () => {
    it('removes all checkpoints for a given executionId', async () => {
      const store = new MemoryStore();
      await store.saveCheckpoint('exec-1', 0, { step: 0 });
      await store.saveCheckpoint('exec-1', 1, { step: 1 });
      await store.saveCheckpoint('exec-2', 0, { step: 0 });

      await store.deleteCheckpoints('exec-1');

      expect(await store.getCheckpoint('exec-1', 0)).toBeNull();
      expect(await store.getCheckpoint('exec-1', 1)).toBeNull();
      // Other execution's checkpoints should be unaffected
      expect(await store.getCheckpoint('exec-2', 0)).toEqual({ step: 0 });
    });

    it('is a no-op for unknown executionId', async () => {
      const store = new MemoryStore();
      await expect(store.deleteCheckpoints('nonexistent')).resolves.toBeUndefined();
    });
  });

  // ── Sessions ───────────────────────────────────────────────────────────

  describe('sessions', () => {
    it('save and get a session', async () => {
      const store = new MemoryStore();
      const history = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there!' },
      ];
      await store.saveSession('session-1', history);

      const loaded = await store.getSession('session-1');
      expect(loaded).toEqual(history);
    });

    it('returns empty array for unknown session', async () => {
      const store = new MemoryStore();
      const result = await store.getSession('unknown');
      expect(result).toEqual([]);
    });

    it('delete removes a session', async () => {
      const store = new MemoryStore();
      await store.saveSession('session-1', [{ role: 'user', content: 'hi' }]);
      await store.deleteSession('session-1');

      const result = await store.getSession('session-1');
      expect(result).toEqual([]);
    });

    it('overwriting a session replaces it', async () => {
      const store = new MemoryStore();
      await store.saveSession('session-1', [{ role: 'user', content: 'first' }]);
      await store.saveSession('session-1', [{ role: 'user', content: 'second' }]);

      const loaded = await store.getSession('session-1');
      expect(loaded).toEqual([{ role: 'user', content: 'second' }]);
    });

    it('stores deep copies (mutations do not affect stored data)', async () => {
      const store = new MemoryStore();
      const history = [{ role: 'user' as const, content: 'hello' }];
      await store.saveSession('session-1', history);

      // Mutate original
      history.push({ role: 'assistant' as const, content: 'hi' });

      const loaded = await store.getSession('session-1');
      expect(loaded).toHaveLength(1);
    });
  });

  // ── Pending Decisions ──────────────────────────────────────────────────

  describe('pending decisions', () => {
    it('save and get pending decisions', async () => {
      const store = new MemoryStore();
      await store.savePendingDecision('exec-1', {
        executionId: 'exec-1',
        channel: 'slack',
        prompt: 'Approve deploy?',
        createdAt: '2024-01-01T00:00:00Z',
      });

      const decisions = await store.getPendingDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].executionId).toBe('exec-1');
      expect(decisions[0].channel).toBe('slack');
      expect(decisions[0].prompt).toBe('Approve deploy?');
    });

    it('returns empty array when no pending decisions', async () => {
      const store = new MemoryStore();
      const decisions = await store.getPendingDecisions();
      expect(decisions).toEqual([]);
    });

    it('resolve removes a pending decision', async () => {
      const store = new MemoryStore();
      await store.savePendingDecision('exec-1', {
        executionId: 'exec-1',
        channel: 'slack',
        prompt: 'Approve?',
        createdAt: '2024-01-01T00:00:00Z',
      });

      await store.resolveDecision('exec-1', { approved: true, data: 'yes' });

      const decisions = await store.getPendingDecisions();
      expect(decisions).toEqual([]);
    });

    it('saving multiple pending decisions', async () => {
      const store = new MemoryStore();
      await store.savePendingDecision('exec-1', {
        executionId: 'exec-1',
        channel: 'slack',
        prompt: 'First decision?',
        createdAt: '2024-01-01T00:00:00Z',
      });
      await store.savePendingDecision('exec-2', {
        executionId: 'exec-2',
        channel: 'email',
        prompt: 'Second decision?',
        createdAt: '2024-01-01T01:00:00Z',
      });

      const decisions = await store.getPendingDecisions();
      expect(decisions).toHaveLength(2);
    });

    it('resolving one decision does not affect others', async () => {
      const store = new MemoryStore();
      await store.savePendingDecision('exec-1', {
        executionId: 'exec-1',
        channel: 'slack',
        prompt: 'First?',
        createdAt: '2024-01-01T00:00:00Z',
      });
      await store.savePendingDecision('exec-2', {
        executionId: 'exec-2',
        channel: 'email',
        prompt: 'Second?',
        createdAt: '2024-01-01T01:00:00Z',
      });

      await store.resolveDecision('exec-1', { approved: false, reason: 'denied' });

      const decisions = await store.getPendingDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].executionId).toBe('exec-2');
    });

    it('save overwrites decision for same executionId', async () => {
      const store = new MemoryStore();
      await store.savePendingDecision('exec-1', {
        executionId: 'exec-1',
        channel: 'slack',
        prompt: 'Original?',
        createdAt: '2024-01-01T00:00:00Z',
      });
      await store.savePendingDecision('exec-1', {
        executionId: 'exec-1',
        channel: 'email',
        prompt: 'Updated?',
        createdAt: '2024-01-01T01:00:00Z',
      });

      const decisions = await store.getPendingDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].prompt).toBe('Updated?');
      expect(decisions[0].channel).toBe('email');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// SQLiteStore
// ═════════════════════════════════════════════════════════════════════════

describe('SQLiteStore', () => {
  const dbFiles: string[] = [];

  function createStore(): SQLiteStore {
    const dbPath = join(tmpdir(), `axl-test-${randomUUID()}.db`);
    dbFiles.push(dbPath);
    return new SQLiteStore(dbPath);
  }

  afterEach(() => {
    for (const f of dbFiles) {
      try {
        unlinkSync(f);
      } catch {
        /* empty */
      }
      try {
        unlinkSync(f + '-wal');
      } catch {
        /* empty */
      }
      try {
        unlinkSync(f + '-shm');
      } catch {
        /* empty */
      }
    }
    dbFiles.length = 0;
  });

  // ── Checkpoints ────────────────────────────────────────────────────────

  describe('checkpoints', () => {
    it('save and load a checkpoint', async () => {
      const store = createStore();
      await store.saveCheckpoint('exec-1', 0, { progress: 'step 0' });

      const loaded = await store.getCheckpoint('exec-1', 0);
      expect(loaded).toEqual({ progress: 'step 0' });
      store.close();
    });

    it('returns null for non-existent checkpoint', async () => {
      const store = createStore();
      const result = await store.getCheckpoint('nonexistent', 0);
      expect(result).toBeNull();
      store.close();
    });

    it('save multiple checkpoints for same execution', async () => {
      const store = createStore();
      await store.saveCheckpoint('exec-1', 0, { step: 0 });
      await store.saveCheckpoint('exec-1', 1, { step: 1 });
      await store.saveCheckpoint('exec-1', 2, { step: 2 });

      expect(await store.getCheckpoint('exec-1', 0)).toEqual({ step: 0 });
      expect(await store.getCheckpoint('exec-1', 1)).toEqual({ step: 1 });
      expect(await store.getCheckpoint('exec-1', 2)).toEqual({ step: 2 });
      store.close();
    });

    it('overwrites checkpoint for same step', async () => {
      const store = createStore();
      await store.saveCheckpoint('exec-1', 0, 'original');
      await store.saveCheckpoint('exec-1', 0, 'updated');

      expect(await store.getCheckpoint('exec-1', 0)).toBe('updated');
      store.close();
    });

    it('getLatestCheckpoint returns latest step', async () => {
      const store = createStore();
      await store.saveCheckpoint('exec-1', 0, 'first');
      await store.saveCheckpoint('exec-1', 5, 'middle');
      await store.saveCheckpoint('exec-1', 3, 'third');

      const latest = await store.getLatestCheckpoint('exec-1');
      expect(latest).toEqual({ step: 5, data: 'middle' });
      store.close();
    });

    it('getLatestCheckpoint returns null for unknown execution', async () => {
      const store = createStore();
      const latest = await store.getLatestCheckpoint('unknown');
      expect(latest).toBeNull();
      store.close();
    });
  });

  // ── deleteCheckpoints ──────────────────────────────────────────────────

  describe('deleteCheckpoints', () => {
    it('removes all checkpoints for a given executionId', async () => {
      const store = createStore();
      await store.saveCheckpoint('exec-1', 0, { step: 0 });
      await store.saveCheckpoint('exec-1', 1, { step: 1 });
      await store.saveCheckpoint('exec-2', 0, { step: 0 });

      await store.deleteCheckpoints('exec-1');

      expect(await store.getCheckpoint('exec-1', 0)).toBeNull();
      expect(await store.getCheckpoint('exec-1', 1)).toBeNull();
      expect(await store.getCheckpoint('exec-2', 0)).toEqual({ step: 0 });
      await store.close();
    });
  });

  // ── Sessions ───────────────────────────────────────────────────────────

  describe('sessions', () => {
    it('save and get a session', async () => {
      const store = createStore();
      const history = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there!' },
      ];
      await store.saveSession('session-1', history);

      const loaded = await store.getSession('session-1');
      expect(loaded).toEqual(history);
      store.close();
    });

    it('returns empty array for unknown session', async () => {
      const store = createStore();
      const result = await store.getSession('unknown');
      expect(result).toEqual([]);
      store.close();
    });

    it('delete removes a session', async () => {
      const store = createStore();
      await store.saveSession('session-1', [{ role: 'user', content: 'hi' }]);
      await store.deleteSession('session-1');

      const result = await store.getSession('session-1');
      expect(result).toEqual([]);
      store.close();
    });
  });

  // ── Pending Decisions ──────────────────────────────────────────────────

  describe('pending decisions', () => {
    it('save and get pending decisions', async () => {
      const store = createStore();
      await store.savePendingDecision('exec-1', {
        executionId: 'exec-1',
        channel: 'slack',
        prompt: 'Approve deploy?',
        createdAt: '2024-01-01T00:00:00Z',
      });

      const decisions = await store.getPendingDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].executionId).toBe('exec-1');
      expect(decisions[0].channel).toBe('slack');
      store.close();
    });

    it('resolve removes a pending decision', async () => {
      const store = createStore();
      await store.savePendingDecision('exec-1', {
        executionId: 'exec-1',
        channel: 'slack',
        prompt: 'Approve?',
        createdAt: '2024-01-01T00:00:00Z',
      });

      await store.resolveDecision('exec-1', { approved: true, data: 'yes' });

      const decisions = await store.getPendingDecisions();
      expect(decisions).toEqual([]);
      store.close();
    });
  });

  // ── Execution State ────────────────────────────────────────────────────

  describe('execution state', () => {
    it('save and load execution state', async () => {
      const store = createStore();
      await store.saveExecutionState('exec-1', {
        workflow: 'my-workflow',
        input: { foo: 'bar' },
        step: 3,
        status: 'waiting',
      });

      const state = await store.getExecutionState('exec-1');
      expect(state).toEqual({
        workflow: 'my-workflow',
        input: { foo: 'bar' },
        step: 3,
        status: 'waiting',
        metadata: undefined,
      });
      store.close();
    });

    it('returns null for unknown execution state', async () => {
      const store = createStore();
      const state = await store.getExecutionState('unknown');
      expect(state).toBeNull();
      store.close();
    });

    it('listPendingExecutions returns waiting executions', async () => {
      const store = createStore();
      await store.saveExecutionState('exec-1', {
        workflow: 'wf',
        input: 'a',
        step: 0,
        status: 'waiting',
      });
      await store.saveExecutionState('exec-2', {
        workflow: 'wf',
        input: 'b',
        step: 0,
        status: 'running',
      });
      await store.saveExecutionState('exec-3', {
        workflow: 'wf',
        input: 'c',
        step: 0,
        status: 'waiting',
      });

      const pending = await store.listPendingExecutions();
      expect(pending).toHaveLength(2);
      expect(pending).toContain('exec-1');
      expect(pending).toContain('exec-3');
      store.close();
    });
  });

  // ── Persistence across instances ──────────────────────────────────────

  describe('persistence', () => {
    it('data survives closing and reopening', async () => {
      const dbPath = join(tmpdir(), `axl-test-persist-${randomUUID()}.db`);
      dbFiles.push(dbPath);

      // Write data with one instance
      const store1 = new SQLiteStore(dbPath);
      await store1.saveCheckpoint('exec-1', 0, { key: 'value' });
      await store1.saveSession('sess-1', [{ role: 'user', content: 'hello' }]);
      await store1.savePendingDecision('exec-2', {
        executionId: 'exec-2',
        channel: 'slack',
        prompt: 'Approve?',
        createdAt: '2024-01-01T00:00:00Z',
      });
      store1.close();

      // Read data with a new instance
      const store2 = new SQLiteStore(dbPath);
      expect(await store2.getCheckpoint('exec-1', 0)).toEqual({ key: 'value' });
      expect(await store2.getSession('sess-1')).toEqual([{ role: 'user', content: 'hello' }]);
      const decisions = await store2.getPendingDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].executionId).toBe('exec-2');
      store2.close();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// RedisStore (mocked client)
// ═════════════════════════════════════════════════════════════════════════

describe('RedisStore', () => {
  /**
   * Create a RedisStore with a mock in-memory client, bypassing the
   * private constructor via Object.create and injecting a mock client.
   */
  function createRedisStoreWithMockClient() {
    const data = new Map<string, string>();
    const hashData = new Map<string, Map<string, string>>();

    const setData = new Map<string, Set<string>>();

    const mockClient = {
      hSet: vi.fn(async (key: string, field: string, value: string) => {
        if (!hashData.has(key)) hashData.set(key, new Map());
        hashData.get(key)!.set(field, value);
        return 1;
      }),
      // node-redis returns undefined (not null) for missing hash fields
      hGet: vi.fn(async (key: string, field: string): Promise<string | undefined> => {
        return hashData.get(key)?.get(field);
      }),
      hGetAll: vi.fn(async (key: string) => {
        const map = hashData.get(key);
        if (!map || map.size === 0) return {};
        return Object.fromEntries(map.entries());
      }),
      hDel: vi.fn(async (key: string, field: string | string[]) => {
        const map = hashData.get(key);
        if (!map) return 0;
        const fields = Array.isArray(field) ? field : [field];
        let count = 0;
        for (const f of fields) {
          if (map.delete(f)) count++;
        }
        return count;
      }),
      set: vi.fn(async (key: string, value: string) => {
        data.set(key, value);
        return 'OK';
      }),
      get: vi.fn(async (key: string) => {
        return data.get(key) ?? null;
      }),
      del: vi.fn(async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        let count = 0;
        for (const k of keys) {
          if (data.delete(k)) count++;
          if (hashData.delete(k)) count++;
        }
        return count;
      }),
      sAdd: vi.fn(async (key: string, member: string | string[]) => {
        if (!setData.has(key)) setData.set(key, new Set());
        const members = Array.isArray(member) ? member : [member];
        let count = 0;
        for (const m of members) {
          if (!setData.get(key)!.has(m)) {
            setData.get(key)!.add(m);
            count++;
          }
        }
        return count;
      }),
      sRem: vi.fn(async (key: string, member: string | string[]) => {
        const set = setData.get(key);
        if (!set) return 0;
        const members = Array.isArray(member) ? member : [member];
        let count = 0;
        for (const m of members) {
          if (set.delete(m)) count++;
        }
        return count;
      }),
      sMembers: vi.fn(async (key: string) => {
        return [...(setData.get(key) ?? [])];
      }),
      quit: vi.fn(async () => undefined),
    };

    // Bypass the private constructor and inject the mock client
    const store = Object.create(RedisStore.prototype) as RedisStore;
    (store as any).client = mockClient;

    return { store, mockClient };
  }

  describe('deleteCheckpoints', () => {
    it('calls del with the correct checkpoint key', async () => {
      const { store, mockClient } = createRedisStoreWithMockClient();

      // Save some checkpoints first
      await store.saveCheckpoint('exec-1', 0, { step: 0 });
      await store.saveCheckpoint('exec-1', 1, { step: 1 });

      // Verify they exist
      const cp0 = await store.getCheckpoint('exec-1', 0);
      expect(cp0).toEqual({ step: 0 });

      // Delete all checkpoints for exec-1
      await store.deleteCheckpoints('exec-1');

      // Verify del was called with the checkpoint key
      expect(mockClient.del).toHaveBeenCalledWith('axl:checkpoint:exec-1');
    });

    it('does not affect other execution checkpoints', async () => {
      const { store } = createRedisStoreWithMockClient();

      await store.saveCheckpoint('exec-1', 0, { step: 0 });
      await store.saveCheckpoint('exec-2', 0, { step: 0 });

      await store.deleteCheckpoints('exec-1');

      // exec-1 checkpoints deleted
      expect(await store.getCheckpoint('exec-1', 0)).toBeNull();
      // exec-2 checkpoints still exist
      expect(await store.getCheckpoint('exec-2', 0)).toEqual({ step: 0 });
    });
  });

  describe('close', () => {
    it('calls quit on the redis client', async () => {
      const { store, mockClient } = createRedisStoreWithMockClient();

      await store.close();

      expect(mockClient.quit).toHaveBeenCalledOnce();
    });
  });

  describe('checkpoints', () => {
    it('save and load a checkpoint', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveCheckpoint('exec-1', 0, { progress: 'step 0' });

      const loaded = await store.getCheckpoint('exec-1', 0);
      expect(loaded).toEqual({ progress: 'step 0' });
    });

    it('returns null for non-existent checkpoint', async () => {
      const { store } = createRedisStoreWithMockClient();
      expect(await store.getCheckpoint('nonexistent', 0)).toBeNull();
    });

    it('handles undefined from hGet (node-redis returns undefined for missing fields)', async () => {
      // node-redis returns undefined (not null) for missing hash fields.
      // The store must normalize this to null — verified here to guard against regressions.
      const { store, mockClient } = createRedisStoreWithMockClient();
      mockClient.hGet.mockResolvedValueOnce(undefined);

      expect(await store.getCheckpoint('exec-1', 99)).toBeNull();
    });

    it('save multiple checkpoints and get latest', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveCheckpoint('exec-1', 0, 'first');
      await store.saveCheckpoint('exec-1', 5, 'latest');
      await store.saveCheckpoint('exec-1', 3, 'middle');

      const latest = await store.getLatestCheckpoint('exec-1');
      expect(latest).toEqual({ step: 5, data: 'latest' });
    });

    it('getLatestCheckpoint returns null for unknown execution', async () => {
      const { store } = createRedisStoreWithMockClient();
      expect(await store.getLatestCheckpoint('unknown')).toBeNull();
    });
  });

  describe('sessions', () => {
    it('save and get a session', async () => {
      const { store } = createRedisStoreWithMockClient();
      const history = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi!' },
      ];
      await store.saveSession('session-1', history);
      expect(await store.getSession('session-1')).toEqual(history);
    });

    it('returns empty array for unknown session', async () => {
      const { store } = createRedisStoreWithMockClient();
      expect(await store.getSession('unknown')).toEqual([]);
    });

    it('deleteSession removes session and session-ids set entry', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveSession('session-1', [{ role: 'user', content: 'hi' }]);
      await store.deleteSession('session-1');

      expect(await store.getSession('session-1')).toEqual([]);
      expect(await store.listSessions()).not.toContain('session-1');
    });

    it('listSessions tracks saved sessions', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveSession('session-1', []);
      await store.saveSession('session-2', []);

      const sessions = await store.listSessions();
      expect(sessions).toContain('session-1');
      expect(sessions).toContain('session-2');
    });
  });

  describe('session metadata', () => {
    it('save and get session meta', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveSessionMeta('session-1', 'agentName', 'support-bot');

      const val = await store.getSessionMeta('session-1', 'agentName');
      expect(val).toBe('support-bot');
    });

    it('returns null for missing meta key', async () => {
      const { store } = createRedisStoreWithMockClient();
      expect(await store.getSessionMeta('session-1', 'missing')).toBeNull();
    });

    it('handles undefined from hGet for missing meta (node-redis behavior)', async () => {
      const { store, mockClient } = createRedisStoreWithMockClient();
      mockClient.hGet.mockResolvedValueOnce(undefined);

      expect(await store.getSessionMeta('session-1', 'key')).toBeNull();
    });
  });

  describe('pending decisions', () => {
    it('save and get pending decisions', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.savePendingDecision('exec-1', {
        executionId: 'exec-1',
        channel: 'slack',
        prompt: 'Approve?',
        createdAt: '2024-01-01T00:00:00Z',
      });

      const decisions = await store.getPendingDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].executionId).toBe('exec-1');
    });

    it('returns empty array when no pending decisions', async () => {
      const { store } = createRedisStoreWithMockClient();
      expect(await store.getPendingDecisions()).toEqual([]);
    });

    it('resolveDecision removes the decision', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.savePendingDecision('exec-1', {
        executionId: 'exec-1',
        channel: 'slack',
        prompt: 'Approve?',
        createdAt: '2024-01-01T00:00:00Z',
      });

      await store.resolveDecision('exec-1', { approved: true });
      expect(await store.getPendingDecisions()).toEqual([]);
    });
  });

  describe('execution state', () => {
    it('save and load execution state', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveExecutionState('exec-1', {
        workflow: 'my-workflow',
        input: { foo: 'bar' },
        step: 2,
        status: 'waiting',
      });

      const state = await store.getExecutionState('exec-1');
      expect(state).toEqual({
        workflow: 'my-workflow',
        input: { foo: 'bar' },
        step: 2,
        status: 'waiting',
      });
    });

    it('returns null for unknown execution', async () => {
      const { store } = createRedisStoreWithMockClient();
      expect(await store.getExecutionState('unknown')).toBeNull();
    });

    it('waiting status adds to pending set', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveExecutionState('exec-1', {
        workflow: 'wf',
        input: null,
        step: 0,
        status: 'waiting',
      });

      const pending = await store.listPendingExecutions();
      expect(pending).toContain('exec-1');
    });

    it('non-waiting status removes from pending set', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveExecutionState('exec-1', {
        workflow: 'wf',
        input: null,
        step: 0,
        status: 'waiting',
      });
      await store.saveExecutionState('exec-1', {
        workflow: 'wf',
        input: null,
        step: 0,
        status: 'running',
      });

      expect(await store.listPendingExecutions()).not.toContain('exec-1');
    });

    it('listPendingExecutions returns only waiting executions', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveExecutionState('exec-1', {
        workflow: 'wf',
        input: null,
        step: 0,
        status: 'waiting',
      });
      await store.saveExecutionState('exec-2', {
        workflow: 'wf',
        input: null,
        step: 0,
        status: 'running',
      });
      await store.saveExecutionState('exec-3', {
        workflow: 'wf',
        input: null,
        step: 0,
        status: 'waiting',
      });

      const pending = await store.listPendingExecutions();
      expect(pending).toContain('exec-1');
      expect(pending).not.toContain('exec-2');
      expect(pending).toContain('exec-3');
    });
  });

  describe('RedisStore.create() error handling', () => {
    it('throws a clear error when the redis package is not installed', async () => {
      const originalRequire = (globalThis as any).__originalRequire;
      // Simulate missing redis package by temporarily mocking the module system
      const mockRequire = (id: string) => {
        if (id === 'redis') throw new Error("Cannot find module 'redis'");
        return originalRequire?.(id);
      };
      const savedRequire = (global as any).require;
      (global as any).require = mockRequire;
      try {
        await expect(RedisStore.create()).rejects.toThrow('redis is required for RedisStore');
      } finally {
        if (savedRequire !== undefined) (global as any).require = savedRequire;
        else delete (global as any).require;
      }
    });
  });
});
