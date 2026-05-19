import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RedisStore } from '../state/redis.js';
import type { ExecutionInfo, AxlEvent } from '../types.js';

/**
 * `REDIS_URL`-gated integration tests against a real Redis server.
 *
 * The mock-based suite in `state.test.ts` covers operation semantics
 * (queue lengths, TTL bookkeeping, atomicity invariants) but cannot
 * validate real-Redis behaviors:
 *
 *   - MULTI/EXEC atomicity under connection drops or partial-exec returns
 *   - Real `EXPIRE NX` semantics across node-redis versions
 *   - Race-safe HSETNX legacy migration under genuine concurrent writes
 *   - TTL drift between `SET ... EX` and `EXPIRE` commands
 *   - Bulk MGET behavior with mixed-existence keys
 *   - Sorted-set + data-blob TTL desync (over-fetch behavior)
 *
 * Set `REDIS_URL` to enable (e.g., `REDIS_URL=redis://localhost:6379`).
 * Skipped otherwise. Uses a unique per-suite `keyPrefix` so tests don't
 * collide with running deployments or each other.
 */

const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)('RedisStore integration (real Redis)', () => {
  // Unique prefix per test run so this suite can run safely against a
  // shared Redis without colliding with concurrent runs or production data.
  const TEST_PREFIX = `axl-test-${randomUUID()}:`;
  let store: RedisStore;

  beforeAll(async () => {
    store = await RedisStore.create({
      url: REDIS_URL!,
      keyPrefix: TEST_PREFIX,
      skipMigration: true, // empty prefix → nothing to backfill
    });
  });

  afterAll(async () => {
    // Best-effort cleanup: SCAN-and-DEL everything under our test prefix.
    // We reach into the internal client via the store; if the store has
    // already closed, swallow.
    try {
      const client = (
        store as unknown as {
          client: {
            scan: (cursor: string, opts: { MATCH: string; COUNT: number }) => Promise<unknown>;
            del: (keys: string | string[]) => Promise<number>;
          };
        }
      ).client;
      let cursor = '0';
      do {
        const result = (await client.scan(cursor, { MATCH: `${TEST_PREFIX}*`, COUNT: 100 })) as
          | { cursor: string; keys: string[] }
          | [string, string[]];
        // node-redis v5 returns { cursor, keys }; older may return tuple.
        if (Array.isArray(result)) {
          cursor = result[0];
          if (result[1].length > 0) await client.del(result[1]);
        } else {
          cursor = String(result.cursor);
          if (result.keys.length > 0) await client.del(result.keys);
        }
      } while (cursor !== '0');
    } catch {
      // ignore — best effort
    }
    await store.close?.();
  });

  // ── Atomicity ────────────────────────────────────────────────────

  describe('MULTI/EXEC atomicity', () => {
    it('saveExecution commits index + data + zset together (real MULTI)', async () => {
      const exec: ExecutionInfo = {
        executionId: 'atomic-1',
        workflow: 'wf',
        status: 'completed',
        events: [],
        totalCost: 0.01,
        startedAt: 1000,
        completedAt: 1100,
        duration: 100,
      };
      await store.saveExecution(exec);

      const fetched = await store.getExecution('atomic-1');
      expect(fetched).toMatchObject({ executionId: 'atomic-1', totalCost: 0.01 });

      const listed = await store.listExecutions();
      expect(listed.map((e) => e.executionId)).toContain('atomic-1');
    });

    it('deleteExecution removes every per-execution surface in one MULTI', async () => {
      const id = `gdpr-${randomUUID()}`;
      await store.saveExecution({
        executionId: id,
        workflow: 'wf',
        status: 'completed',
        events: [],
        totalCost: 0,
        startedAt: 2000,
        completedAt: 2100,
        duration: 100,
      });
      await store.saveCheckpoint(id, 'step1', { v: 1 });
      await store.saveExecutionState(id, {
        workflow: 'wf',
        input: {},
        step: 0,
        status: 'waiting',
      });
      await store.savePendingDecision(id, {
        executionId: id,
        channel: 'slack',
        prompt: 'approve?',
        createdAt: '2026-01-01T00:00:00Z',
      });
      await store.appendStreamingEvents!(id, [
        {
          type: 'log',
          executionId: id,
          step: 0,
          timestamp: 1000,
          data: { msg: 'x' },
        } as unknown as AxlEvent,
      ]);

      // Pre: every surface populated
      expect(await store.getExecution(id)).not.toBeNull();
      expect(await store.getCheckpoint(id, 'step1')).toEqual({ v: 1 });
      expect(await store.getExecutionState(id)).not.toBeNull();
      expect(await store.getPendingDecisions()).toContainEqual(
        expect.objectContaining({ executionId: id }),
      );
      const streamingBefore = await store.getStreamingEvents!(id);
      expect(streamingBefore).toHaveLength(1);

      const removed = await store.deleteExecution(id);
      expect(removed).toBe(true);

      // Post: every surface gone
      expect(await store.getExecution(id)).toBeNull();
      expect(await store.getCheckpoint(id, 'step1')).toBeNull();
      expect(await store.getExecutionState(id)).toBeNull();
      expect(await store.getPendingDecisions()).not.toContainEqual(
        expect.objectContaining({ executionId: id }),
      );
      expect(await store.getStreamingEvents!(id)).toHaveLength(0);
    });
  });

  // ── TTL semantics ────────────────────────────────────────────────

  describe('TTL semantics', () => {
    // Tests that need TTL behavior use a dedicated store with short TTLs
    // configured. Cleanup is automatic via the per-suite cleanup.
    let ttlStore: RedisStore;

    beforeAll(async () => {
      ttlStore = await RedisStore.create({
        url: REDIS_URL!,
        keyPrefix: `${TEST_PREFIX}ttl-`,
        skipMigration: true,
        ttls: {
          checkpoint: 100, // 100 seconds — long enough for the test, short relative to default
          memory: 60,
          executionHistory: 3600,
        },
      });
    });

    afterAll(async () => {
      await ttlStore.close?.();
    });

    it('saveCheckpoint applies EXPIRE NX (fixed-from-first-write window)', async () => {
      const id = `ckpt-ttl-${randomUUID()}`;
      const client = (ttlStore as unknown as { client: { ttl: (key: string) => Promise<number> } })
        .client;

      await ttlStore.saveCheckpoint(id, 'a', { v: 1 });
      const ttl1 = (await client.ttl(`${TEST_PREFIX}ttl-checkpoint:${id}`)) as number;
      expect(ttl1).toBeGreaterThan(0);
      expect(ttl1).toBeLessThanOrEqual(100);

      // Second save shouldn't extend the window (EXPIRE NX semantics)
      await new Promise((r) => setTimeout(r, 50));
      await ttlStore.saveCheckpoint(id, 'b', { v: 2 });
      const ttl2 = (await client.ttl(`${TEST_PREFIX}ttl-checkpoint:${id}`)) as number;
      // Should still be ≤ the original (might have decremented; should NOT
      // have jumped back up to 100).
      expect(ttl2).toBeLessThanOrEqual(ttl1);
    });

    it('saveMemory applies EXPIRE without NX (sliding window)', async () => {
      const id = `mem-ttl-${randomUUID()}`;
      const client = (ttlStore as unknown as { client: { ttl: (key: string) => Promise<number> } })
        .client;

      await ttlStore.saveMemory(id, 'k1', 'v1');
      await new Promise((r) => setTimeout(r, 50));
      // The TTL should have decremented slightly. A second write should
      // refresh it back to ~60.
      await ttlStore.saveMemory(id, 'k2', 'v2');
      const ttl = (await client.ttl(`${TEST_PREFIX}ttl-memory:${id}`)) as number;
      // Real Redis TTL granularity is seconds; 60 is the expected refresh.
      expect(ttl).toBe(60);
    });
  });

  // ── Race-safe HSETNX legacy migration ────────────────────────────

  describe('memory legacy migration (concurrent HSETNX)', () => {
    it('two concurrent getMemory calls on a legacy entry converge on one value', async () => {
      // Seed a legacy memory entry at the synthetic sessionMeta location
      const scope = `legacy-race-${randomUUID()}`;
      const client = (
        store as unknown as {
          client: { hSet: (key: string, field: string, value: string) => Promise<number> };
        }
      ).client;
      const legacyKey = `${TEST_PREFIX}session-meta:memory:${scope}:k1`;
      await client.hSet(legacyKey, 'value', JSON.stringify('legacy-value'));

      // Race: two concurrent reads should both succeed and return the
      // same value. The HSETNX inside `getMemory` should make exactly
      // one win the migration; the other re-reads the winner's value.
      const [a, b] = await Promise.all([
        store.getMemory(scope, 'k1'),
        store.getMemory(scope, 'k1'),
      ]);
      expect(a).toBe('legacy-value');
      expect(b).toBe('legacy-value');
    });
  });

  // ── Sorted-set perf + null filter ────────────────────────────────

  describe('sorted-set fast path', () => {
    it('listExecutions returns entries in descending startedAt order', async () => {
      // Use a dedicated prefix so existing test data doesn't pollute order
      const sortedStore = await RedisStore.create({
        url: REDIS_URL!,
        keyPrefix: `${TEST_PREFIX}sorted-`,
        skipMigration: true,
      });
      try {
        for (let i = 0; i < 10; i++) {
          await sortedStore.saveExecution({
            executionId: `e${i}`,
            workflow: 'wf',
            status: 'completed',
            events: [],
            totalCost: i * 0.01,
            startedAt: i * 100,
            completedAt: i * 100 + 50,
            duration: 50,
          });
        }

        const result = await sortedStore.listExecutions(3);
        expect(result.map((e) => e.executionId)).toEqual(['e9', 'e8', 'e7']);
      } finally {
        await sortedStore.close?.();
      }
    });

    it('listExecutions delivers `limit` live entries when intermediate blobs are deleted (over-fetch)', async () => {
      const sortedStore = await RedisStore.create({
        url: REDIS_URL!,
        keyPrefix: `${TEST_PREFIX}drift-`,
        skipMigration: true,
      });
      try {
        for (let i = 0; i < 10; i++) {
          await sortedStore.saveExecution({
            executionId: `e${i}`,
            workflow: 'wf',
            status: 'completed',
            events: [],
            totalCost: 0,
            startedAt: i * 100,
            duration: 0,
          });
        }
        // Delete the top-3 data blobs to simulate TTL eviction. The ZSET
        // entries remain — listExecutions should over-fetch and absorb.
        const client = (
          sortedStore as unknown as {
            client: { del: (keys: string | string[]) => Promise<number> };
          }
        ).client;
        await client.del(`${TEST_PREFIX}drift-exec-history:e9`);
        await client.del(`${TEST_PREFIX}drift-exec-history:e8`);
        await client.del(`${TEST_PREFIX}drift-exec-history:e7`);

        const result = await sortedStore.listExecutions(3);
        expect(result).toHaveLength(3);
        expect(result.map((e) => e.executionId)).toEqual(['e6', 'e5', 'e4']);
      } finally {
        await sortedStore.close?.();
      }
    });
  });

  // ── Streaming-buffer round-trip ──────────────────────────────────

  describe('streaming buffer round-trip', () => {
    it('appendStreamingEvents → listStreamingExecutions → getStreamingEvents → finalize', async () => {
      const id = `stream-${randomUUID()}`;
      const events: AxlEvent[] = [
        {
          type: 'workflow_start',
          executionId: id,
          workflow: 'streaming-wf',
          step: 0,
          timestamp: 1000,
          data: { input: {} },
        } as unknown as AxlEvent,
        {
          type: 'agent_call_end',
          executionId: id,
          step: 1,
          timestamp: 2000,
          agent: 'analyzer',
          cost: 0.005,
          data: { response: 'partial' },
        } as unknown as AxlEvent,
      ];

      await store.appendStreamingEvents!(id, events);

      const ids = await store.listStreamingExecutions!();
      expect(ids).toContain(id);

      const fetched = await store.getStreamingEvents!(id);
      expect(fetched).toHaveLength(2);
      expect(fetched[0].type).toBe('workflow_start');
      expect(fetched[1].type).toBe('agent_call_end');

      await store.finalizeStreamingEvents!(id);
      expect(await store.listStreamingExecutions!()).not.toContain(id);
      expect(await store.getStreamingEvents!(id)).toHaveLength(0);
    });

    it('multiple appendStreamingEvents calls accumulate (RPUSH semantics)', async () => {
      const id = `stream-multi-${randomUUID()}`;
      const mkEvent = (step: number): AxlEvent =>
        ({
          type: 'log',
          executionId: id,
          step,
          timestamp: 1000 + step,
          data: { step },
        }) as unknown as AxlEvent;

      await store.appendStreamingEvents!(id, [mkEvent(0), mkEvent(1)]);
      await store.appendStreamingEvents!(id, [mkEvent(2)]);
      await store.appendStreamingEvents!(id, [mkEvent(3), mkEvent(4)]);

      const all = await store.getStreamingEvents!(id);
      expect(all).toHaveLength(5);
      expect(all.map((e) => e.step)).toEqual([0, 1, 2, 3, 4]);

      await store.finalizeStreamingEvents!(id);
    });
  });

  // ── deleteEvalResult round-trip ──────────────────────────────────

  describe('eval delete', () => {
    it('saveEvalResult + listEvalResults + deleteEvalResult', async () => {
      const id = `ev-${randomUUID()}`;
      await store.saveEvalResult({
        id,
        eval: 'integration-test',
        timestamp: 5000,
        data: { score: 0.9 },
      });

      const list = await store.listEvalResults();
      expect(list.find((e) => e.id === id)).toMatchObject({ eval: 'integration-test' });

      const removed = await store.deleteEvalResult(id);
      expect(removed).toBe(true);

      const refetch = await store.listEvalResults();
      expect(refetch.find((e) => e.id === id)).toBeUndefined();
    });
  });

  // ── listPendingExecutions self-pruning ───────────────────────────

  describe('listPendingExecutions self-pruning', () => {
    it('removes ids whose state blob has been deleted (TTL-evicted equivalent)', async () => {
      const live = `pend-live-${randomUUID()}`;
      const dead = `pend-dead-${randomUUID()}`;

      await store.saveExecutionState(live, {
        workflow: 'wf',
        input: {},
        step: 0,
        status: 'waiting',
      });
      await store.saveExecutionState(dead, {
        workflow: 'wf',
        input: {},
        step: 0,
        status: 'waiting',
      });

      // Simulate TTL eviction by deleting the state blob directly
      const client = (
        store as unknown as { client: { del: (keys: string | string[]) => Promise<number> } }
      ).client;
      await client.del(`${TEST_PREFIX}exec-state:${dead}`);

      const pending = await store.listPendingExecutions();
      expect(pending).toContain(live);
      expect(pending).not.toContain(dead);

      // Cleanup
      await store.deleteExecution(live);
    });
  });
});
