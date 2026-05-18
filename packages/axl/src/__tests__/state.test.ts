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
      await store.saveCheckpoint('exec-1', 'cp', { progress: 'step 0' });

      const loaded = await store.getCheckpoint('exec-1', 'cp');
      expect(loaded).toEqual({ progress: 'step 0' });
    });

    it('returns null for non-existent checkpoint', async () => {
      const store = new MemoryStore();
      const result = await store.getCheckpoint('nonexistent', 'cp');
      expect(result).toBeNull();
    });

    it('returns null for non-existent name', async () => {
      const store = new MemoryStore();
      await store.saveCheckpoint('exec-1', 'cp', 'data');
      const result = await store.getCheckpoint('exec-1', 'unknown');
      expect(result).toBeNull();
    });

    it('save multiple checkpoints for same execution', async () => {
      const store = new MemoryStore();
      await store.saveCheckpoint('exec-1', 'a', { step: 0 });
      await store.saveCheckpoint('exec-1', 'b', { step: 1 });
      await store.saveCheckpoint('exec-1', 'c', { step: 2 });

      expect(await store.getCheckpoint('exec-1', 'a')).toEqual({ step: 0 });
      expect(await store.getCheckpoint('exec-1', 'b')).toEqual({ step: 1 });
      expect(await store.getCheckpoint('exec-1', 'c')).toEqual({ step: 2 });
    });

    it('overwrites checkpoint for same name', async () => {
      const store = new MemoryStore();
      await store.saveCheckpoint('exec-1', 'cp', 'original');
      await store.saveCheckpoint('exec-1', 'cp', 'updated');

      expect(await store.getCheckpoint('exec-1', 'cp')).toBe('updated');
    });

    it('stores deep copies (mutations do not affect stored data)', async () => {
      const store = new MemoryStore();
      const data = { items: [1, 2, 3] };
      await store.saveCheckpoint('exec-1', 'cp', data);

      // Mutate original
      data.items.push(4);

      const loaded = await store.getCheckpoint('exec-1', 'cp');
      expect(loaded).toEqual({ items: [1, 2, 3] });
    });
  });

  // ── deleteCheckpoints ──────────────────────────────────────────────────

  describe('deleteCheckpoints', () => {
    it('removes all checkpoints for a given executionId', async () => {
      const store = new MemoryStore();
      await store.saveCheckpoint('exec-1', 'a', { step: 0 });
      await store.saveCheckpoint('exec-1', 'b', { step: 1 });
      await store.saveCheckpoint('exec-2', 'a', { step: 0 });

      await store.deleteCheckpoints('exec-1');

      expect(await store.getCheckpoint('exec-1', 'a')).toBeNull();
      expect(await store.getCheckpoint('exec-1', 'b')).toBeNull();
      // Other execution's checkpoints should be unaffected
      expect(await store.getCheckpoint('exec-2', 'a')).toEqual({ step: 0 });
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

  // ── Execution History ────────────────────────────────────────────────

  describe('execution history', () => {
    const makeExec = (id: string, startedAt: number): import('../types.js').ExecutionInfo => ({
      executionId: id,
      workflow: 'test-wf',
      status: 'completed',
      events: [{ executionId: id, step: 0, type: 'log', timestamp: startedAt, data: {} }],
      totalCost: 0.01,
      startedAt,
      completedAt: startedAt + 100,
      duration: 100,
    });

    it('saveExecution + getExecution round-trip', async () => {
      const store = new MemoryStore();
      const exec = makeExec('e1', 1000);
      await store.saveExecution(exec);

      const loaded = await store.getExecution('e1');
      expect(loaded).toEqual(exec);
    });

    it('getExecution returns null for unknown id', async () => {
      const store = new MemoryStore();
      expect(await store.getExecution('unknown')).toBeNull();
    });

    it('listExecutions returns sorted by startedAt descending', async () => {
      const store = new MemoryStore();
      await store.saveExecution(makeExec('e1', 1000));
      await store.saveExecution(makeExec('e2', 3000));
      await store.saveExecution(makeExec('e3', 2000));

      const list = await store.listExecutions();
      expect(list.map((e) => e.executionId)).toEqual(['e2', 'e3', 'e1']);
    });

    it('listExecutions respects limit', async () => {
      const store = new MemoryStore();
      await store.saveExecution(makeExec('e1', 1000));
      await store.saveExecution(makeExec('e2', 3000));
      await store.saveExecution(makeExec('e3', 2000));

      const list = await store.listExecutions(2);
      expect(list).toHaveLength(2);
      expect(list[0].executionId).toBe('e2');
    });

    it('stores deep copies', async () => {
      const store = new MemoryStore();
      const exec = makeExec('e1', 1000);
      await store.saveExecution(exec);
      exec.totalCost = 999;

      const loaded = await store.getExecution('e1');
      expect(loaded!.totalCost).toBe(0.01);
    });
  });

  // ── Eval History ──────────────────────────────────────────────────

  describe('eval history', () => {
    it('saveEvalResult + listEvalResults round-trip', async () => {
      const store = new MemoryStore();
      await store.saveEvalResult({ id: 'ev1', eval: 'test', timestamp: 1000, data: { score: 1 } });
      await store.saveEvalResult({
        id: 'ev2',
        eval: 'test',
        timestamp: 2000,
        data: { score: 0.5 },
      });

      const list = await store.listEvalResults();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('ev2'); // newest first
      expect(list[1].id).toBe('ev1');
    });

    it('listEvalResults respects limit', async () => {
      const store = new MemoryStore();
      await store.saveEvalResult({ id: 'ev1', eval: 'test', timestamp: 1000, data: {} });
      await store.saveEvalResult({ id: 'ev2', eval: 'test', timestamp: 2000, data: {} });

      const list = await store.listEvalResults(1);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('ev2');
    });

    it('deleteEvalResult removes the entry and returns true', async () => {
      const store = new MemoryStore();
      await store.saveEvalResult({ id: 'ev1', eval: 'test', timestamp: 1000, data: {} });
      await store.saveEvalResult({ id: 'ev2', eval: 'test', timestamp: 2000, data: {} });

      const deleted = await store.deleteEvalResult('ev1');
      expect(deleted).toBe(true);

      const list = await store.listEvalResults();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('ev2');
    });

    it('deleteEvalResult returns false for unknown id', async () => {
      const store = new MemoryStore();
      const deleted = await store.deleteEvalResult('does-not-exist');
      expect(deleted).toBe(false);
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
      await store.saveCheckpoint('exec-1', 'cp', { progress: 'step 0' });

      const loaded = await store.getCheckpoint('exec-1', 'cp');
      expect(loaded).toEqual({ progress: 'step 0' });
      store.close();
    });

    it('returns null for non-existent checkpoint', async () => {
      const store = createStore();
      const result = await store.getCheckpoint('nonexistent', 'cp');
      expect(result).toBeNull();
      store.close();
    });

    it('save multiple checkpoints for same execution', async () => {
      const store = createStore();
      await store.saveCheckpoint('exec-1', 'a', { step: 0 });
      await store.saveCheckpoint('exec-1', 'b', { step: 1 });
      await store.saveCheckpoint('exec-1', 'c', { step: 2 });

      expect(await store.getCheckpoint('exec-1', 'a')).toEqual({ step: 0 });
      expect(await store.getCheckpoint('exec-1', 'b')).toEqual({ step: 1 });
      expect(await store.getCheckpoint('exec-1', 'c')).toEqual({ step: 2 });
      store.close();
    });

    it('overwrites checkpoint for same name', async () => {
      const store = createStore();
      await store.saveCheckpoint('exec-1', 'cp', 'original');
      await store.saveCheckpoint('exec-1', 'cp', 'updated');

      expect(await store.getCheckpoint('exec-1', 'cp')).toBe('updated');
      store.close();
    });
  });

  // ── deleteCheckpoints ──────────────────────────────────────────────────

  describe('deleteCheckpoints', () => {
    it('removes all checkpoints for a given executionId', async () => {
      const store = createStore();
      await store.saveCheckpoint('exec-1', 'a', { step: 0 });
      await store.saveCheckpoint('exec-1', 'b', { step: 1 });
      await store.saveCheckpoint('exec-2', 'a', { step: 0 });

      await store.deleteCheckpoints('exec-1');

      expect(await store.getCheckpoint('exec-1', 'a')).toBeNull();
      expect(await store.getCheckpoint('exec-1', 'b')).toBeNull();
      expect(await store.getCheckpoint('exec-2', 'a')).toEqual({ step: 0 });
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
      await store1.saveCheckpoint('exec-1', 'cp', { key: 'value' });
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
      expect(await store2.getCheckpoint('exec-1', 'cp')).toEqual({ key: 'value' });
      expect(await store2.getSession('sess-1')).toEqual([{ role: 'user', content: 'hello' }]);
      const decisions = await store2.getPendingDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].executionId).toBe('exec-2');
      store2.close();
    });
  });

  // ── Execution History ────────────────────────────────────────────────

  describe('execution history', () => {
    const makeExec = (id: string, startedAt: number): import('../types.js').ExecutionInfo => ({
      executionId: id,
      workflow: 'test-wf',
      status: 'completed',
      events: [{ executionId: id, step: 0, type: 'log', timestamp: startedAt, data: {} }],
      totalCost: 0.01,
      startedAt,
      completedAt: startedAt + 100,
      duration: 100,
    });

    it('saveExecution + getExecution round-trip', async () => {
      const store = createStore();
      const exec = makeExec('e1', 1000);
      await store.saveExecution(exec);

      const loaded = await store.getExecution('e1');
      expect(loaded).toEqual(exec);
      store.close();
    });

    it('listExecutions returns sorted and respects limit', async () => {
      const store = createStore();
      await store.saveExecution(makeExec('e1', 1000));
      await store.saveExecution(makeExec('e2', 3000));
      await store.saveExecution(makeExec('e3', 2000));

      const all = await store.listExecutions();
      expect(all.map((e) => e.executionId)).toEqual(['e2', 'e3', 'e1']);

      const limited = await store.listExecutions(2);
      expect(limited).toHaveLength(2);
      store.close();
    });

    it('persists across instances', async () => {
      const dbPath = join(tmpdir(), `axl-test-exec-hist-${randomUUID()}.db`);
      dbFiles.push(dbPath);

      const store1 = new SQLiteStore(dbPath);
      await store1.saveExecution(makeExec('e1', 1000));
      store1.close();

      const store2 = new SQLiteStore(dbPath);
      const loaded = await store2.getExecution('e1');
      expect(loaded).toEqual(makeExec('e1', 1000));
      store2.close();
    });
  });

  // ── Eval History ──────────────────────────────────────────────────

  describe('eval history', () => {
    it('saveEvalResult + listEvalResults round-trip', async () => {
      const store = createStore();
      await store.saveEvalResult({ id: 'ev1', eval: 'test', timestamp: 1000, data: { score: 1 } });
      await store.saveEvalResult({
        id: 'ev2',
        eval: 'test',
        timestamp: 2000,
        data: { score: 0.5 },
      });

      const list = await store.listEvalResults();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('ev2');
      expect(list[1].data).toEqual({ score: 1 });
      store.close();
    });

    it('listEvalResults respects limit', async () => {
      const store = createStore();
      await store.saveEvalResult({ id: 'ev1', eval: 'test', timestamp: 1000, data: {} });
      await store.saveEvalResult({ id: 'ev2', eval: 'test', timestamp: 2000, data: {} });

      const list = await store.listEvalResults(1);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('ev2');
      store.close();
    });

    it('deleteEvalResult removes the row and returns true', async () => {
      const store = createStore();
      await store.saveEvalResult({ id: 'ev1', eval: 'test', timestamp: 1000, data: {} });
      await store.saveEvalResult({ id: 'ev2', eval: 'test', timestamp: 2000, data: {} });

      expect(await store.deleteEvalResult('ev1')).toBe(true);
      const list = await store.listEvalResults();
      expect(list.map((e) => e.id)).toEqual(['ev2']);
      store.close();
    });

    it('deleteEvalResult returns false for unknown id', async () => {
      const store = createStore();
      expect(await store.deleteEvalResult('does-not-exist')).toBe(false);
      store.close();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// RedisStore (mocked client)
// ═════════════════════════════════════════════════════════════════════════

describe('RedisStore', () => {
  /**
   * Build a chainable mock RedisMulti that queues commands and applies them
   * on `.exec()`. Mirrors node-redis v5's RedisMulti shape (set/del/sAdd/
   * sRem/hDel + exec) at the surface we use.
   *
   * Two callers reach this: the mock client's `multi()` builds one with
   * the shared backing Maps; tests that want to inspect the queue can
   * spy on the returned chain.
   */
  function createMockMulti(
    data: Map<string, string>,
    hashData: Map<string, Map<string, string>>,
    setData: Map<string, Set<string>>,
  ) {
    type QueuedOp = () => unknown;
    const queue: QueuedOp[] = [];
    const chain = {
      set(key: string, value: string) {
        queue.push(() => {
          data.set(key, value);
          return 'OK';
        });
        return chain;
      },
      del(key: string | string[]) {
        queue.push(() => {
          const keys = Array.isArray(key) ? key : [key];
          let count = 0;
          for (const k of keys) {
            if (data.delete(k)) count++;
            if (hashData.delete(k)) count++;
          }
          return count;
        });
        return chain;
      },
      sAdd(key: string, member: string | string[]) {
        queue.push(() => {
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
        });
        return chain;
      },
      sRem(key: string, member: string | string[]) {
        queue.push(() => {
          const set = setData.get(key);
          if (!set) return 0;
          const members = Array.isArray(member) ? member : [member];
          let count = 0;
          for (const m of members) {
            if (set.delete(m)) count++;
          }
          return count;
        });
        return chain;
      },
      hDel(key: string, field: string | string[]) {
        queue.push(() => {
          const map = hashData.get(key);
          if (!map) return 0;
          const fields = Array.isArray(field) ? field : [field];
          let count = 0;
          for (const f of fields) {
            if (map.delete(f)) count++;
          }
          return count;
        });
        return chain;
      },
      async exec(): Promise<unknown[]> {
        // Apply queued ops in order. A real Redis MULTI is atomic — we
        // don't simulate failure scenarios here, but the per-op results
        // match the node-redis return convention.
        return queue.map((op) => op());
      },
    };
    // Test-only inspection hook. Non-enumerable so it doesn't appear in
    // Object.keys/JSON.stringify and can't be mistaken for production API.
    Object.defineProperty(chain, '_queueLength', {
      enumerable: false,
      value: () => queue.length,
    });
    return chain as typeof chain & { _queueLength: () => number };
  }

  /**
   * Create a RedisStore with a mock in-memory client, bypassing the
   * private constructor via Object.create and injecting a mock client.
   *
   * @param keyPrefix - Override the default `'axl:'` prefix to exercise
   * the keyPrefix option without hitting a real Redis.
   */
  function createRedisStoreWithMockClient(keyPrefix = 'axl:') {
    const data = new Map<string, string>();
    const hashData = new Map<string, Map<string, string>>();

    const setData = new Map<string, Set<string>>();

    const mockClient = {
      hSet: vi.fn(async (key: string, field: string, value: string) => {
        if (!hashData.has(key)) hashData.set(key, new Map());
        hashData.get(key)!.set(field, value);
        return 1;
      }),
      // HSETNX semantics: set field only if it doesn't already exist.
      // Returns 1 (set) or 0 (already existed). Mirrors node-redis v5 behavior.
      hSetNX: vi.fn(async (key: string, field: string, value: string) => {
        if (!hashData.has(key)) hashData.set(key, new Map());
        const map = hashData.get(key)!;
        if (map.has(field)) return 0;
        map.set(field, value);
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
      // multi() returns a chain object. Queue commands; on .exec(), apply
      // them all atomically against the same backing Maps. Real Redis
      // MULTI/EXEC is all-or-nothing, but our mock isn't simulating that
      // — it just guarantees the queued ops run together without other
      // mock interleaving (which is what callers actually care about).
      multi: vi.fn(() => createMockMulti(data, hashData, setData)),
      quit: vi.fn(async () => undefined),
    };

    // Bypass the private constructor and inject the mock client
    const store = Object.create(RedisStore.prototype) as RedisStore;
    (store as any).client = mockClient;
    (store as any).keyPrefix = keyPrefix;

    return { store, mockClient, data, hashData, setData };
  }

  describe('keyPrefix', () => {
    it('uses the default "axl:" prefix when none is provided', async () => {
      const { store, mockClient } = createRedisStoreWithMockClient();
      await store.saveCheckpoint('exec-1', 'cp', { step: 0 });
      expect(mockClient.hSet).toHaveBeenCalledWith(
        'axl:checkpoint:exec-1',
        'cp',
        expect.any(String),
      );
    });

    it('composes a custom prefix into every key type', async () => {
      const { store, hashData, data, setData } = createRedisStoreWithMockClient('myapp:prod:');

      // Hit every key-producing path
      await store.saveCheckpoint('e1', 'cp', { x: 1 });
      await store.saveSession('s1', [{ role: 'user', content: 'hi' }]);
      await store.saveSessionMeta('s1', 'meta', 'v');
      await store.savePendingDecision('e1', {
        executionId: 'e1',
        channel: 'slack',
        prompt: '?',
        createdAt: '2024',
      });
      await store.saveExecutionState('e1', {
        workflow: 'w',
        input: null,
        step: 0,
        status: 'waiting',
      });
      await store.saveExecution({
        executionId: 'e1',
        workflow: 'w',
        status: 'completed',
        events: [],
        totalCost: 0,
        startedAt: 0,
        completedAt: 0,
        duration: 0,
      });
      await store.saveEvalResult({ id: 'ev1', eval: 't', timestamp: 0, data: {} });

      // Every recorded key must carry the custom prefix — none of the legacy 'axl:'
      const allKeys = [...hashData.keys(), ...data.keys(), ...setData.keys()];
      expect(allKeys.length).toBeGreaterThan(0);
      for (const k of allKeys) {
        expect(k.startsWith('myapp:prod:')).toBe(true);
        expect(k.startsWith('axl:')).toBe(false);
      }

      // Spot-check the expected fully-composed key names
      expect(hashData.has('myapp:prod:checkpoint:e1')).toBe(true);
      expect(data.has('myapp:prod:session:s1')).toBe(true);
      expect(hashData.has('myapp:prod:session-meta:s1')).toBe(true);
      expect(hashData.has('myapp:prod:decisions')).toBe(true);
      expect(data.has('myapp:prod:exec-state:e1')).toBe(true);
      expect(setData.has('myapp:prod:pending-executions')).toBe(true);
      expect(setData.has('myapp:prod:exec-history-ids')).toBe(true);
      expect(data.has('myapp:prod:exec-history:e1')).toBe(true);
      expect(setData.has('myapp:prod:eval-history-ids')).toBe(true);
      expect(data.has('myapp:prod:eval-history:ev1')).toBe(true);
      expect(setData.has('myapp:prod:session-ids')).toBe(true);
    });

    it('isolates data between two stores with different prefixes', async () => {
      // Two distinct stores backed by independent mock state — simulating two
      // tenants on the same physical Redis. They must not see each other's keys.
      const a = createRedisStoreWithMockClient('tenant-a:');
      const b = createRedisStoreWithMockClient('tenant-b:');

      await a.store.saveSession('sess-1', [{ role: 'user', content: 'a-secret' }]);
      await b.store.saveSession('sess-1', [{ role: 'user', content: 'b-secret' }]);

      expect((await a.store.getSession('sess-1'))[0].content).toBe('a-secret');
      expect((await b.store.getSession('sess-1'))[0].content).toBe('b-secret');

      // Independent listSessions
      expect(await a.store.listSessions()).toEqual(['sess-1']);
      expect(await b.store.listSessions()).toEqual(['sess-1']);
    });

    it('does not strip or alter custom prefix characters', async () => {
      // No normalization — what you pass is what gets composed.
      const { store, hashData } = createRedisStoreWithMockClient('NoColon');
      await store.saveCheckpoint('e1', 'cp', 1);
      // Result: 'NoColoncheckpoint:e1' — adjacent concatenation, no inserted separator.
      expect(hashData.has('NoColoncheckpoint:e1')).toBe(true);
    });

    it('rejects empty-string keyPrefix at factory level', async () => {
      // Empty prefix would collide with literally every Redis key in the cluster,
      // which is almost always a bug. Reject it explicitly so users get a clear
      // error at startup instead of debugging mysterious collisions later.
      await expect(RedisStore.create({ keyPrefix: '' })).rejects.toThrow(
        /keyPrefix cannot be empty/,
      );
    });

    it('falls back to default when keyPrefix is undefined (e.g. unset env var)', async () => {
      // A common user pattern is `keyPrefix: process.env.AXL_PREFIX` which is
      // `undefined` when the var is unset. That must resolve to the default
      // 'axl:' — not crash, not become empty-string. Tripwire so future
      // refactors of the `??` chain don't regress this.
      const { store, hashData } = createRedisStoreWithMockClient(); // helper default
      await store.saveCheckpoint('e1', 'cp', 1);
      expect(hashData.has('axl:checkpoint:e1')).toBe(true);
      // And explicitly via the options shape (mirroring the runtime path the env-var pattern produces)
      const opts: import('../state/redis.js').RedisStoreOptions = { keyPrefix: undefined };
      expect(opts.keyPrefix).toBeUndefined();
    });
  });

  describe('deleteCheckpoints', () => {
    it('calls del with the correct checkpoint key', async () => {
      const { store, mockClient } = createRedisStoreWithMockClient();

      // Save some checkpoints first
      await store.saveCheckpoint('exec-1', 'a', { step: 0 });
      await store.saveCheckpoint('exec-1', 'b', { step: 1 });

      // Verify they exist
      const cp0 = await store.getCheckpoint('exec-1', 'a');
      expect(cp0).toEqual({ step: 0 });

      // Delete all checkpoints for exec-1
      await store.deleteCheckpoints('exec-1');

      // Verify del was called with the checkpoint key
      expect(mockClient.del).toHaveBeenCalledWith('axl:checkpoint:exec-1');
    });

    it('does not affect other execution checkpoints', async () => {
      const { store } = createRedisStoreWithMockClient();

      await store.saveCheckpoint('exec-1', 'a', { step: 0 });
      await store.saveCheckpoint('exec-2', 'a', { step: 0 });

      await store.deleteCheckpoints('exec-1');

      // exec-1 checkpoints deleted
      expect(await store.getCheckpoint('exec-1', 'a')).toBeNull();
      // exec-2 checkpoints still exist
      expect(await store.getCheckpoint('exec-2', 'a')).toEqual({ step: 0 });
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
      await store.saveCheckpoint('exec-1', 'cp', { progress: 'step 0' });

      const loaded = await store.getCheckpoint('exec-1', 'cp');
      expect(loaded).toEqual({ progress: 'step 0' });
    });

    it('returns null for non-existent checkpoint', async () => {
      const { store } = createRedisStoreWithMockClient();
      expect(await store.getCheckpoint('nonexistent', 'cp')).toBeNull();
    });

    it('handles undefined from hGet (node-redis returns undefined for missing fields)', async () => {
      // node-redis returns undefined (not null) for missing hash fields.
      // The store must normalize this to null — verified here to guard against regressions.
      const { store, mockClient } = createRedisStoreWithMockClient();
      mockClient.hGet.mockResolvedValueOnce(undefined);

      expect(await store.getCheckpoint('exec-1', 'unknown')).toBeNull();
    });

    it('save multiple checkpoints with distinct names', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveCheckpoint('exec-1', 'a', 'first');
      await store.saveCheckpoint('exec-1', 'b', 'latest');
      await store.saveCheckpoint('exec-1', 'c', 'middle');

      expect(await store.getCheckpoint('exec-1', 'a')).toBe('first');
      expect(await store.getCheckpoint('exec-1', 'b')).toBe('latest');
      expect(await store.getCheckpoint('exec-1', 'c')).toBe('middle');
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

    it('round-trips ChatMessage.agent through JSON serialization', async () => {
      // Tripwire: future serialization changes (e.g., field whitelisting)
      // could silently drop the `agent` stamp from persisted history,
      // breaking multi-agent attribution for Redis-backed deployments.
      const { store } = createRedisStoreWithMockClient();
      const history = [
        { role: 'user' as const, content: 'q' },
        { role: 'assistant' as const, content: 'a1', agent: 'triage' },
        { role: 'assistant' as const, content: 'a2', agent: 'billing' },
      ];
      await store.saveSession('multi-agent', history);
      const restored = await store.getSession('multi-agent');
      expect(restored).toEqual(history);
      expect(restored[1].agent).toBe('triage');
      expect(restored[2].agent).toBe('billing');
      // user message has no agent — must remain undefined post round-trip
      expect(restored[0].agent).toBeUndefined();
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

  describe('eval history', () => {
    it('saveEvalResult + listEvalResults round-trip', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveEvalResult({ id: 'ev1', eval: 'test', timestamp: 1000, data: { score: 1 } });
      await store.saveEvalResult({
        id: 'ev2',
        eval: 'test',
        timestamp: 2000,
        data: { score: 0.5 },
      });

      const list = await store.listEvalResults();
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('ev2'); // newest first
      expect(list[1].data).toEqual({ score: 1 });
    });

    it('deleteEvalResult removes the entry and returns true', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveEvalResult({ id: 'ev1', eval: 'test', timestamp: 1000, data: {} });
      await store.saveEvalResult({ id: 'ev2', eval: 'test', timestamp: 2000, data: {} });

      expect(await store.deleteEvalResult('ev1')).toBe(true);
      const list = await store.listEvalResults();
      expect(list.map((e) => e.id)).toEqual(['ev2']);
    });

    it('deleteEvalResult returns false for unknown id', async () => {
      const { store } = createRedisStoreWithMockClient();
      expect(await store.deleteEvalResult('does-not-exist')).toBe(false);
    });
  });

  describe('atomicity (MULTI/EXEC)', () => {
    // These tests prove that multi-key writes go through a single multi()
    // chain — so a crash mid-operation can't leave the store in a partial
    // state. Each `it()` asserts both that multi() was called the right
    // number of times AND that the chain captured the expected number of
    // queued ops before exec().
    //
    // We instrument by replacing the mock's `multi` with a spy that wraps
    // the original implementation and records the chain returned, so we
    // can inspect `_queueLength()` after exec().

    function instrumentMulti(
      mockClient: ReturnType<typeof createRedisStoreWithMockClient>['mockClient'],
    ) {
      const chains: Array<
        ReturnType<typeof createRedisStoreWithMockClient>['mockClient']['multi'] extends (
          ...args: never
        ) => infer R
          ? R
          : never
      > = [];
      const original = mockClient.multi.getMockImplementation()!;
      mockClient.multi.mockImplementation(() => {
        const chain = original();
        chains.push(chain);
        return chain;
      });
      return chains;
    }

    it('saveSession queues data + sessionIds in one MULTI', async () => {
      const { store, mockClient } = createRedisStoreWithMockClient();
      const chains = instrumentMulti(mockClient);
      await store.saveSession('s1', [{ role: 'user', content: 'hi' }]);

      expect(mockClient.multi).toHaveBeenCalledTimes(1);
      expect(chains).toHaveLength(1);
      // Two ops queued: set + sAdd
      expect(chains[0]._queueLength()).toBe(2);
    });

    it('deleteSession queues data + meta + sessionIds in one MULTI', async () => {
      const { store, mockClient } = createRedisStoreWithMockClient();
      const chains = instrumentMulti(mockClient);
      await store.deleteSession('s1');

      expect(mockClient.multi).toHaveBeenCalledTimes(1);
      expect(chains[0]._queueLength()).toBe(3);
    });

    it('saveExecutionState queues blob + pending-set membership (waiting case)', async () => {
      const { store, mockClient, setData } = createRedisStoreWithMockClient();
      const chains = instrumentMulti(mockClient);
      await store.saveExecutionState('e1', {
        workflow: 'w',
        input: null,
        step: 0,
        status: 'waiting',
      });

      expect(chains[0]._queueLength()).toBe(2);
      // Pending set must have the entry after exec()
      expect(setData.get('axl:pending-executions')?.has('e1')).toBe(true);
    });

    it('saveExecutionState queues blob + pending-set REMOVAL (non-waiting case)', async () => {
      const { store, mockClient, setData } = createRedisStoreWithMockClient();
      // Pre-populate the pending set so we can verify removal
      setData.set('axl:pending-executions', new Set(['e1']));

      const chains = instrumentMulti(mockClient);
      await store.saveExecutionState('e1', {
        workflow: 'w',
        input: null,
        step: 0,
        status: 'running',
      });

      expect(chains[0]._queueLength()).toBe(2);
      expect(setData.get('axl:pending-executions')?.has('e1')).toBe(false);
    });

    it('saveExecution queues set membership + data in one MULTI', async () => {
      const { store, mockClient } = createRedisStoreWithMockClient();
      const chains = instrumentMulti(mockClient);
      await store.saveExecution({
        executionId: 'e1',
        workflow: 'w',
        status: 'completed',
        events: [],
        totalCost: 0,
        startedAt: 0,
        completedAt: 0,
        duration: 0,
      });

      expect(mockClient.multi).toHaveBeenCalledTimes(1);
      expect(chains[0]._queueLength()).toBe(2);
    });

    it('saveEvalResult queues set membership + data in one MULTI', async () => {
      const { store, mockClient } = createRedisStoreWithMockClient();
      const chains = instrumentMulti(mockClient);
      await store.saveEvalResult({ id: 'ev1', eval: 't', timestamp: 0, data: {} });

      expect(chains[0]._queueLength()).toBe(2);
    });

    it('deleteEvalResult queues sRem + del in one MULTI and reads del() for the boolean', async () => {
      const { store, mockClient } = createRedisStoreWithMockClient();
      await store.saveEvalResult({ id: 'ev1', eval: 't', timestamp: 0, data: {} });

      const chains = instrumentMulti(mockClient);
      const result = await store.deleteEvalResult('ev1');

      expect(chains[0]._queueLength()).toBe(2);
      expect(result).toBe(true);
    });

    it('deleteEvalResult returns false when the entry does not exist (still atomic)', async () => {
      const { store, mockClient } = createRedisStoreWithMockClient();
      const chains = instrumentMulti(mockClient);
      const result = await store.deleteEvalResult('does-not-exist');

      expect(chains[0]._queueLength()).toBe(2);
      expect(result).toBe(false);
    });

    it('deleteMemory queues new + legacy hDel in one MULTI', async () => {
      const { store, mockClient } = createRedisStoreWithMockClient();
      const chains = instrumentMulti(mockClient);
      await store.deleteMemory('session:s1', 'k');

      expect(chains[0]._queueLength()).toBe(2);
    });

    it('multi-key writes do NOT issue per-command client calls during MULTI', async () => {
      // Regression guard: if a refactor accidentally mixes plain client.set
      // alongside the multi() chain, the atomicity guarantee is silently
      // lost. Assert that the underlying single-op methods aren't called
      // during these write paths.
      const { store, mockClient } = createRedisStoreWithMockClient();

      mockClient.set.mockClear();
      mockClient.sAdd.mockClear();
      mockClient.del.mockClear();
      mockClient.sRem.mockClear();
      mockClient.hDel.mockClear();

      await store.saveSession('s1', [{ role: 'user', content: 'hi' }]);
      await store.saveExecution({
        executionId: 'e1',
        workflow: 'w',
        status: 'completed',
        events: [],
        totalCost: 0,
        startedAt: 0,
        completedAt: 0,
        duration: 0,
      });
      await store.saveEvalResult({ id: 'ev1', eval: 't', timestamp: 0, data: {} });
      await store.saveExecutionState('e1', {
        workflow: 'w',
        input: null,
        step: 0,
        status: 'waiting',
      });
      await store.deleteEvalResult('ev1');
      await store.deleteSession('s1');
      await store.deleteMemory('session:s1', 'k');

      // None of the single-op methods should have been called for these
      // multi-key writes — every command went through multi() / exec().
      expect(mockClient.set).not.toHaveBeenCalled();
      expect(mockClient.sAdd).not.toHaveBeenCalled();
      expect(mockClient.del).not.toHaveBeenCalled();
      expect(mockClient.sRem).not.toHaveBeenCalled();
      expect(mockClient.hDel).not.toHaveBeenCalled();
    });
  });

  describe('memory', () => {
    it('saveMemory + getMemory round-trip', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveMemory('session:s1', 'name', 'Alice');
      expect(await store.getMemory('session:s1', 'name')).toBe('Alice');
    });

    it('getMemory returns null for missing key', async () => {
      const { store } = createRedisStoreWithMockClient();
      expect(await store.getMemory('session:s1', 'nope')).toBeNull();
    });

    it('handles undefined from hGet (node-redis returns undefined for missing fields)', async () => {
      // Same tripwire as other hash-backed methods — `hGet` returning
      // undefined (not null) must normalize to null.
      const { store, mockClient } = createRedisStoreWithMockClient();
      mockClient.hGet.mockResolvedValueOnce(undefined); // primary miss
      mockClient.hGet.mockResolvedValueOnce(undefined); // legacy miss
      expect(await store.getMemory('global', 'absent')).toBeNull();
    });

    it('getAllMemory returns all entries in a scope', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveMemory('global', 'a', 1);
      await store.saveMemory('global', 'b', { nested: 'value' });
      await store.saveMemory('other-scope', 'c', 'isolated');

      const all = await store.getAllMemory('global');
      expect(all).toHaveLength(2);
      expect(all).toEqual(
        expect.arrayContaining([
          { key: 'a', value: 1 },
          { key: 'b', value: { nested: 'value' } },
        ]),
      );
      // Other scope must not bleed in
      expect(all.find((e) => e.key === 'c')).toBeUndefined();
    });

    it('getAllMemory returns empty array for unknown scope', async () => {
      const { store } = createRedisStoreWithMockClient();
      expect(await store.getAllMemory('nope')).toEqual([]);
    });

    it('saveMemory overwrites existing value', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveMemory('global', 'k', 'old');
      await store.saveMemory('global', 'k', 'new');
      expect(await store.getMemory('global', 'k')).toBe('new');
    });

    it('deleteMemory removes the entry', async () => {
      const { store } = createRedisStoreWithMockClient();
      await store.saveMemory('session:s1', 'k', 'v');
      await store.deleteMemory('session:s1', 'k');
      expect(await store.getMemory('session:s1', 'k')).toBeNull();
    });

    it('serializes complex values losslessly via JSON', async () => {
      const { store } = createRedisStoreWithMockClient();
      const complex = { arr: [1, 2, 3], nested: { foo: 'bar' }, n: 42, b: true, nil: null };
      await store.saveMemory('global', 'k', complex);
      expect(await store.getMemory('global', 'k')).toEqual(complex);
    });

    it('uses the configured keyPrefix in the memory hash key', async () => {
      // Tripwire: changes to memoryKey() must compose with the keyPrefix
      // option from patch #8. Custom-prefix users would otherwise lose
      // memory data on upgrade.
      const { store, hashData } = createRedisStoreWithMockClient('myapp:prod:');
      await store.saveMemory('session:s1', 'k', 'v');
      expect(hashData.has('myapp:prod:memory:session:s1')).toBe(true);
      // And NOT under the default prefix
      expect(hashData.has('axl:memory:session:s1')).toBe(false);
    });

    describe('legacy fallback (pre-patch sessionMeta data)', () => {
      // Pre-patch, ctx.remember() against RedisStore wrote via MemoryManager's
      // sessionMeta fallback: `{prefix}session-meta:memory:{scope}:{key}`
      // hash field `value`. After upgrade we must keep that data reachable.

      it('getMemory falls back to legacy sessionMeta location and migrates forward', async () => {
        const { store, hashData, mockClient } = createRedisStoreWithMockClient();

        // Plant legacy data the way pre-patch MemoryManager would have
        const legacyKey = 'axl:session-meta:memory:session:s1:my-key';
        hashData.set(legacyKey, new Map([['value', JSON.stringify('legacy-value')]]));

        // First read hits the legacy path
        expect(await store.getMemory('session:s1', 'my-key')).toBe('legacy-value');

        // Migrate-forward used HSETNX (race-safe)
        expect(mockClient.hSetNX).toHaveBeenCalledWith(
          'axl:memory:session:s1',
          'my-key',
          JSON.stringify('legacy-value'),
        );

        // Second read serves from the new location (no further hSetNX calls)
        mockClient.hSetNX.mockClear();
        expect(await store.getMemory('session:s1', 'my-key')).toBe('legacy-value');
        expect(mockClient.hSetNX).not.toHaveBeenCalled();
      });

      it('legacy migration does not clobber a concurrent fresh write (HSETNX is atomic)', async () => {
        // Simpler case: B's fresh write already exists when A starts reading.
        // A's primary hGet hits and returns fresh — no migration path entered.
        const { store, hashData } = createRedisStoreWithMockClient();

        const legacyKey = 'axl:session-meta:memory:session:s1:k';
        hashData.set(legacyKey, new Map([['value', JSON.stringify('legacy-value')]]));
        hashData.set('axl:memory:session:s1', new Map([['k', JSON.stringify('fresh-value')]]));

        expect(await store.getMemory('session:s1', 'k')).toBe('fresh-value');
      });

      it("returns the WINNING (fresh) value when B writes between A's primary read and migration write", async () => {
        // The harder race: A's primary hGet sees no data (B hasn't written yet),
        // A's legacy hGet returns legacy data, B's hSet lands BEFORE A's HSETNX,
        // A's HSETNX no-ops (returns 0). A must NOT return the stale legacy value
        // — it must re-read the canonical location and return B's fresh write.
        const { store, mockClient, hashData } = createRedisStoreWithMockClient();

        // Plant legacy data
        const legacyKey = 'axl:session-meta:memory:session:s1:k';
        hashData.set(legacyKey, new Map([['value', JSON.stringify('legacy')]]));

        // Hook: between A's primary-read (returns undefined) and A's HSETNX,
        // simulate process B's fresh write landing.
        const realHGet = mockClient.hGet.getMockImplementation()!;
        let primaryReadsSoFar = 0;
        mockClient.hGet.mockImplementation(async (key: string, field: string) => {
          if (key === 'axl:memory:session:s1' && field === 'k') {
            primaryReadsSoFar++;
            if (primaryReadsSoFar === 1) {
              // First read: primary is empty. Schedule B's write to happen
              // *before* A's eventual HSETNX runs.
              return undefined;
            }
          }
          return realHGet(key, field);
        });

        // Insert B's write right after A's first hGet returns undefined.
        // The mock's HSETNX checks `map.has(field)` synchronously, so we
        // populate the map BEFORE A reaches HSETNX. Easiest way: prime the
        // map directly in the mock helper before the call lands.
        const realHSetNX = mockClient.hSetNX.getMockImplementation()!;
        mockClient.hSetNX.mockImplementationOnce(
          async (key: string, field: string, value: string) => {
            // Simulate B's hSet landing right before our HSETNX
            if (!hashData.has(key)) hashData.set(key, new Map());
            hashData.get(key)!.set(field, JSON.stringify('fresh-from-B'));
            // Now run the real HSETNX — it'll see the field and no-op
            return realHSetNX(key, field, value);
          },
        );

        const result = await store.getMemory('session:s1', 'k');
        // Critical: must return 'fresh-from-B', NOT 'legacy'. Returning legacy
        // would be the bug — handing the caller stale data to act on.
        expect(result).toBe('fresh-from-B');

        // And HSETNX was called and no-op'd (proving we exercised the race path)
        expect(mockClient.hSetNX).toHaveBeenCalledTimes(1);
      });

      it('returns null when a concurrent delete races between HSETNX and re-read', async () => {
        // Edge of the edge: HSETNX no-ops (field exists), but then a deleteMemory
        // races in between — the canonical truth is "deleted" so we must NOT
        // resurrect the legacy value.
        const { store, mockClient, hashData } = createRedisStoreWithMockClient();

        const legacyKey = 'axl:session-meta:memory:session:s1:k';
        hashData.set(legacyKey, new Map([['value', JSON.stringify('legacy')]]));

        // Primary read returns undefined (no canonical data yet)
        const realHGet = mockClient.hGet.getMockImplementation()!;
        let primaryReads = 0;
        mockClient.hGet.mockImplementation(async (key: string, field: string) => {
          if (key === 'axl:memory:session:s1' && field === 'k') {
            primaryReads++;
            if (primaryReads === 1) return undefined; // primary miss
            if (primaryReads === 2) return undefined; // re-read after HSETNX no-op (delete won)
          }
          return realHGet(key, field);
        });

        // HSETNX no-ops because B's fresh write landed
        mockClient.hSetNX.mockResolvedValueOnce(0);

        const result = await store.getMemory('session:s1', 'k');
        expect(result).toBeNull(); // delete wins, no resurrection
      });

      it('mock HSETNX returns 0 when field already exists (sanity check)', async () => {
        // Direct test of the mock's HSETNX semantics so future test authors
        // can trust the underlying primitive.
        const { mockClient } = createRedisStoreWithMockClient();
        await mockClient.hSet('h', 'f', 'fresh');
        const result = await mockClient.hSetNX('h', 'f', 'would-clobber');
        expect(result).toBe(0);
        expect(await mockClient.hGet('h', 'f')).toBe('fresh'); // not clobbered
      });

      it('deleteMemory also cleans the legacy location so it cannot resurrect', async () => {
        const { store, hashData } = createRedisStoreWithMockClient();

        // Plant ONLY legacy data (no new entry)
        const legacyKey = 'axl:session-meta:memory:session:s1:k';
        hashData.set(legacyKey, new Map([['value', JSON.stringify('legacy')]]));

        // First read migrates it forward
        expect(await store.getMemory('session:s1', 'k')).toBe('legacy');

        // Delete should wipe both new AND legacy
        await store.deleteMemory('session:s1', 'k');

        // Even if the migration's new write somehow gets dropped (e.g., TTL
        // eviction), a subsequent read must NOT resurrect from legacy.
        hashData.delete('axl:memory:session:s1'); // simulate new entry dropped
        expect(await store.getMemory('session:s1', 'k')).toBeNull();
      });

      it('getAllMemory does NOT include legacy data', async () => {
        // Intentional: getAllMemory didn't exist pre-patch, so no caller
        // can depend on it returning legacy entries. Surface the new
        // location only; legacy entries become visible via getMemory's
        // migration path on direct lookup.
        const { store, hashData } = createRedisStoreWithMockClient();

        const legacyKey = 'axl:session-meta:memory:global:legacy-only';
        hashData.set(legacyKey, new Map([['value', JSON.stringify('hidden')]]));

        await store.saveMemory('global', 'visible', 'shown');

        const all = await store.getAllMemory('global');
        expect(all).toEqual([{ key: 'visible', value: 'shown' }]);
        // 'legacy-only' is NOT enumerated by design
      });

      it('legacy fallback honors custom keyPrefix', async () => {
        const { store, hashData } = createRedisStoreWithMockClient('tenant-a:');

        // Plant legacy data under the CUSTOM prefix
        const legacyKey = 'tenant-a:session-meta:memory:session:s1:k';
        hashData.set(legacyKey, new Map([['value', JSON.stringify('tenant-legacy')]]));

        expect(await store.getMemory('session:s1', 'k')).toBe('tenant-legacy');
      });
    });
  });
});
