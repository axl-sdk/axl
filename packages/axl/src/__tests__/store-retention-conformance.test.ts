/**
 * History retention conformance across the built-in stores (plan AC1.3,
 * AC1.5, E7, E9; test matrix P1-01..P1-18).
 *
 * One body per behavior runs against Memory, SQLite and Redis (mock client).
 * Memory and SQLite take an injected clock, so expiry is asserted by moving
 * time. The Redis mock does not simulate expiry, so for Redis the same body
 * asserts the TTL written on the record instead; real Redis expiry is covered
 * in `redis-integration.test.ts`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { MemoryStore } from '../state/memory.js';
import { SQLiteStore } from '../state/sqlite.js';
import { PRUNE_BATCH } from '../state/retention.js';
import type { HistoryTtls, StateStore } from '../state/types.js';
import type { HistoricalExecutionInfo } from '../types.js';
import { AxlError } from '../errors.js';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { createRedisStoreWithMockClient } from './redis-mock-client.js';

const require_ = createRequire(import.meta.url);

const TEN_YEARS_MS = 10 * 365 * 86_400_000;

function makeExec(
  id: string,
  startedAt: number,
  options?: { completedAt?: number; status?: 'completed' | 'failed' },
): HistoricalExecutionInfo {
  const completedAt = options?.completedAt ?? startedAt;
  return {
    executionId: id,
    workflow: 'wf',
    status: options?.status ?? 'completed',
    eventSchemaVersion: 2,
    events: [],
    totalCost: 0,
    startedAt,
    completedAt,
    duration: completedAt - startedAt,
  } as HistoricalExecutionInfo;
}

type HistoryStore = Required<
  Pick<
    StateStore,
    | 'saveExecution'
    | 'getExecution'
    | 'listExecutions'
    | 'saveEvalResult'
    | 'updateEvalResult'
    | 'listEvalResults'
    | 'getEvalRetention'
  >
> &
  StateStore;

type Harness = {
  store: HistoryStore;
  /** Move the injected clock (Memory/SQLite). `null` for Redis. */
  setTime: ((ms: number) => void) | null;
  /** Seconds of TTL written on an execution record (Redis only). */
  execTtl(id: string): number | undefined;
  /** Seconds of TTL written on an eval row (Redis only). */
  evalTtl(id: string): number | undefined;
  /** Simulate the server dropping an expired execution record (Redis only). */
  dropExecution(id: string): void;
};

type HarnessFactory = { name: string; make(ttls?: HistoryTtls, start?: number): Harness };

const tmpDirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'axl-retention-'));
  tmpDirs.push(dir);
  return join(dir, 'state.db');
}

const memoryHarness: HarnessFactory = {
  name: 'MemoryStore',
  make(ttls, start = 1_000_000) {
    let t = start;
    const store = new MemoryStore({ ttls, now: () => t }) as unknown as HistoryStore;
    return {
      store,
      setTime: (ms) => {
        t = ms;
      },
      execTtl: () => undefined,
      evalTtl: () => undefined,
      dropExecution: () => undefined,
    };
  },
};

const sqliteHarness: HarnessFactory = {
  name: 'SQLiteStore',
  make(ttls, start = 1_000_000) {
    let t = start;
    const sqlite = new SQLiteStore(tmpDbPath(), { ttls, now: () => t });
    closers.push(() => sqlite.close());
    return {
      store: sqlite as unknown as HistoryStore,
      setTime: (ms) => {
        t = ms;
      },
      execTtl: () => undefined,
      evalTtl: () => undefined,
      dropExecution: () => undefined,
    };
  },
};

const redisHarness: HarnessFactory = {
  name: 'RedisStore (mock client)',
  make(ttls) {
    const {
      store,
      ttls: ttlMap,
      data,
    } = createRedisStoreWithMockClient('axl:', {
      executionHistory: ttls?.executionHistory ?? null,
      evalHistory: ttls?.evalHistory ?? null,
    });
    return {
      store: store as unknown as HistoryStore,
      setTime: null,
      execTtl: (id) => ttlMap.get(`axl:exec-history:${id}`),
      evalTtl: (id) => ttlMap.get(`axl:eval-history:${id}`),
      dropExecution: (id) => {
        data.delete(`axl:exec-history:${id}`);
      },
    };
  },
};

async function listedIds(store: HistoryStore, limit?: number): Promise<string[]> {
  return (await store.listExecutions(limit)).map((e) => e.executionId);
}

/** Visible through both read paths, or through neither. */
async function expectExecVisible(store: HistoryStore, id: string, visible: boolean) {
  if (visible) {
    expect(await store.getExecution(id)).not.toBeNull();
    expect(await listedIds(store)).toContain(id);
  } else {
    expect(await store.getExecution(id)).toBeNull();
    expect(await listedIds(store)).not.toContain(id);
  }
}

async function expectEvalVisible(store: HistoryStore, id: string, visible: boolean) {
  expect((await store.listEvalResults()).some((e) => e.id === id)).toBe(visible);
  expect((await store.getEvalRetention(id)).exists).toBe(visible);
}

describe.each([memoryHarness, sqliteHarness, redisHarness])(
  '$name — history retention conformance (AC1.3)',
  (factory) => {
    it('P1-01 an execution expires exactly at save + ttl (boundary is expired)', async () => {
      const h = factory.make({ executionHistory: 60 }, 10_000);
      await h.store.saveExecution(makeExec('e1', 10_000));
      if (!h.setTime) {
        expect(h.execTtl('e1')).toBe(60);
        return;
      }
      h.setTime(69_999);
      await expectExecVisible(h.store, 'e1', true);
      h.setTime(70_000);
      await expectExecVisible(h.store, 'e1', false);
    });

    it('P1-02 an explicit null keeps records forever (E7)', async () => {
      const h = factory.make({ executionHistory: null, evalHistory: null });
      await h.store.saveExecution(makeExec('e1', 1));
      await h.store.saveEvalResult({ id: 'v1', eval: 'e', timestamp: 1, data: {} });
      if (!h.setTime) {
        expect(h.execTtl('e1')).toBeUndefined();
        expect(h.evalTtl('v1')).toBeUndefined();
        return;
      }
      h.setTime(1_000_000 + TEN_YEARS_MS);
      await expectExecVisible(h.store, 'e1', true);
      await expectEvalVisible(h.store, 'v1', true);
    });

    it('P1-03 unset retention never expires anything', async () => {
      const h = factory.make();
      await h.store.saveExecution(makeExec('e1', 1));
      await h.store.saveEvalResult({ id: 'v1', eval: 'e', timestamp: 1, data: {} });
      if (!h.setTime) {
        expect(h.execTtl('e1')).toBeUndefined();
        expect(h.evalTtl('v1')).toBeUndefined();
        return;
      }
      h.setTime(1_000_000 + TEN_YEARS_MS);
      await expectExecVisible(h.store, 'e1', true);
      await expectEvalVisible(h.store, 'v1', true);
    });

    it('P1-04 re-saving an execution restarts its window', async () => {
      const h = factory.make({ executionHistory: 60 }, 0);
      await h.store.saveExecution(makeExec('e1', 0));
      if (!h.setTime) {
        h.dropExecution('e1'); // the first window's record is gone…
        await h.store.saveExecution(makeExec('e1', 0));
        expect(h.execTtl('e1')).toBe(60); // …and the re-save is timed afresh
        await expectExecVisible(h.store, 'e1', true);
        return;
      }
      h.setTime(50_000);
      await h.store.saveExecution(makeExec('e1', 0));
      h.setTime(70_000);
      await expectExecVisible(h.store, 'e1', true);
      h.setTime(110_000);
      await expectExecVisible(h.store, 'e1', false);
    });

    it('P1-05 a long run is kept for the full window after it finishes (E9)', async () => {
      const t = 10_000_000;
      const h = factory.make({ executionHistory: 60 }, t);
      await h.store.saveExecution(makeExec('long', t - 3_600_000, { completedAt: t }));
      if (!h.setTime) {
        expect(h.execTtl('long')).toBe(60);
        return;
      }
      h.setTime(t + 59_000);
      await expectExecVisible(h.store, 'long', true);
    });

    it('P1-06 a limited listing skips expired records before applying the limit', async () => {
      const h = factory.make({ executionHistory: 60 }, 0);
      // Listing order: live-new (3000), expired-mid (2000), live-old (1000).
      await h.store.saveExecution(makeExec('expired-mid', 2000));
      if (h.setTime) h.setTime(30_000);
      await h.store.saveExecution(makeExec('live-new', 3000));
      await h.store.saveExecution(makeExec('live-old', 1000));
      if (h.setTime) h.setTime(60_000);
      else h.dropExecution('expired-mid');
      expect(await listedIds(h.store, 2)).toEqual(['live-new', 'live-old']);
    });

    it('P1-07 expiry is computed and checked on the injected clock', async () => {
      if (!factory.make().setTime) return; // Redis has no injectable clock
      const h = factory.make({ executionHistory: 60, evalHistory: 60 }, 1_000);
      await h.store.saveExecution(makeExec('e1', 1_000));
      await h.store.saveEvalResult({ id: 'v1', eval: 'e', timestamp: 1, data: {} });
      // Date.now() is far past 61_000: reading on the wall clock would hide it.
      await expectExecVisible(h.store, 'e1', true);
      expect(await h.store.getEvalRetention('v1')).toEqual({ exists: true, expiresAt: 61_000 });
      // Writing on the wall clock would keep it visible here.
      h.setTime!(61_000);
      await expectExecVisible(h.store, 'e1', false);
      await expectEvalVisible(h.store, 'v1', false);
    });

    it('P1-08 eval history has no retention by default', async () => {
      const h = factory.make({ executionHistory: 60 });
      await h.store.saveEvalResult({ id: 'v1', eval: 'e', timestamp: 1, data: {} });
      expect(await h.store.getEvalRetention('v1')).toEqual({ exists: true });
      if (!h.setTime) {
        expect(h.evalTtl('v1')).toBeUndefined();
        return;
      }
      h.setTime(1_000_000 + TEN_YEARS_MS);
      await expectEvalVisible(h.store, 'v1', true);
    });

    it('P1-10 the eval window counts from the first write; re-save and update keep it', async () => {
      const h = factory.make({ evalHistory: 60 }, 0);
      await h.store.saveEvalResult({ id: 'v1', eval: 'e', timestamp: 1, data: { n: 1 } });
      if (!h.setTime) {
        await h.store.saveEvalResult({ id: 'v1', eval: 'e', timestamp: 1, data: { n: 2 } });
        expect(
          await h.store.updateEvalResult({ id: 'v1', eval: 'e', timestamp: 1, data: {} }),
        ).toBe(true);
        expect(h.evalTtl('v1')).toBe(60);
        return;
      }
      h.setTime(50_000);
      expect(
        await h.store.updateEvalResult({ id: 'v1', eval: 'e', timestamp: 1, data: { n: 2 } }),
      ).toBe(true);
      await h.store.saveEvalResult({ id: 'v1', eval: 'e', timestamp: 1, data: { n: 3 } });
      expect(await h.store.getEvalRetention('v1')).toEqual({ exists: true, expiresAt: 60_000 });
      expect((await h.store.listEvalResults())[0].data).toEqual({ n: 3 });
      h.setTime(60_000);
      await expectEvalVisible(h.store, 'v1', false);
      // An expired row is gone: a correction must not resurrect it.
      expect(await h.store.updateEvalResult({ id: 'v1', eval: 'e', timestamp: 1, data: {} })).toBe(
        false,
      );
      // A save after expiry starts a new row with a new window.
      await h.store.saveEvalResult({ id: 'v1', eval: 'e', timestamp: 1, data: {} });
      expect(await h.store.getEvalRetention('v1')).toEqual({ exists: true, expiresAt: 120_000 });
    });

    it('P1-11 execution and eval retention are independent', async () => {
      const a = factory.make({ executionHistory: 60, evalHistory: null }, 0);
      const b = factory.make({ executionHistory: null, evalHistory: 60 }, 0);
      for (const h of [a, b]) {
        await h.store.saveExecution(makeExec('e1', 0));
        await h.store.saveEvalResult({ id: 'v1', eval: 'e', timestamp: 0, data: {} });
      }
      if (!a.setTime) {
        expect([a.execTtl('e1'), a.evalTtl('v1')]).toEqual([60, undefined]);
        expect([b.execTtl('e1'), b.evalTtl('v1')]).toEqual([undefined, 60]);
        return;
      }
      a.setTime(60_000);
      b.setTime!(60_000);
      await expectExecVisible(a.store, 'e1', false);
      await expectEvalVisible(a.store, 'v1', true);
      await expectExecVisible(b.store, 'e1', true);
      await expectEvalVisible(b.store, 'v1', false);
    });
  },
);

/** Tie fixture T: seven runs at one startedAt between a newer and an older one. */
const TIE_FIXTURE_ORDER = ['hi', 't-g', 't-f', 't-e', 't-d', 't-c', 't-b', 't-a', 'lo'];

async function saveTieFixture(store: HistoryStore): Promise<void> {
  // Saved in a scrambled order, so neither insertion nor id order can pass for
  // listing order.
  for (const id of ['t-c', 'lo', 't-a', 't-g', 'hi', 't-e', 't-b', 't-f', 't-d']) {
    const startedAt = id === 'hi' ? 2000 : id === 'lo' ? 500 : 1000;
    await store.saveExecution(makeExec(id, startedAt));
  }
}

function cursorOf(e: HistoricalExecutionInfo) {
  return { startedAt: e.startedAt, executionId: e.executionId };
}

/** Page through the whole history with `limit`, returning each page's ids. */
async function pageAll(store: HistoryStore, limit: number): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: { startedAt: number; executionId: string } | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = await store.listExecutions(limit, cursor ? { cursor } : undefined);
    pages.push(page.map((e) => e.executionId));
    if (page.length === 0) return pages;
    cursor = cursorOf(page[page.length - 1]);
  }
  throw new Error('paging did not terminate');
}

describe.each([memoryHarness, sqliteHarness, redisHarness])(
  '$name — history paging by cursor (E12, AC2.2)',
  (factory) => {
    it('declares historyPaging', () => {
      expect(factory.make().store.historyPaging).toBe(true);
    });

    it('P3-02 (store level) pages through a startedAt tie group, each run exactly once', async () => {
      const h = factory.make();
      await saveTieFixture(h.store);
      expect(await pageAll(h.store, 3)).toEqual([
        ['hi', 't-g', 't-f'],
        ['t-e', 't-d', 't-c'],
        ['t-b', 't-a', 'lo'],
        [],
      ]);
      // Page boundaries that fall mid-group at other offsets.
      expect((await pageAll(h.store, 2)).flat()).toEqual(TIE_FIXTURE_ORDER);
      expect((await pageAll(h.store, 4)).flat()).toEqual(TIE_FIXTURE_ORDER);
    });

    it('a cursor at the very last item returns an empty page', async () => {
      const h = factory.make();
      await saveTieFixture(h.store);
      const cursor = { startedAt: 500, executionId: 'lo' };
      expect(await h.store.listExecutions(3, { cursor })).toEqual([]);
      expect(await h.store.listExecutions(undefined, { cursor })).toEqual([]);
    });

    it('without a limit, returns everything strictly after the cursor', async () => {
      const h = factory.make();
      await saveTieFixture(h.store);
      const page = await h.store.listExecutions(undefined, {
        cursor: { startedAt: 1000, executionId: 't-d' },
      });
      expect(page.map((e) => e.executionId)).toEqual(['t-c', 't-b', 't-a', 'lo']);
    });

    it('P3-04 (store level) a cursor whose run was deleted still resumes in place', async () => {
      const h = factory.make();
      await saveTieFixture(h.store);
      const [, , tf] = await h.store.listExecutions(3);
      expect(tf.executionId).toBe('t-f');
      await h.store.deleteExecution!('t-f');
      const page = await h.store.listExecutions(3, { cursor: cursorOf(tf) });
      expect(page.map((e) => e.executionId)).toEqual(['t-e', 't-d', 't-c']);
    });

    it('P2-14 returns exactly `limit` live records when expired ones are interleaved', async () => {
      const h = factory.make({ executionHistory: 60 }, 0);
      // live-i at startedAt 10i + 5, dead-i at 10i: interleaved in listing order.
      for (let i = 0; i < 5; i++) await h.store.saveExecution(makeExec(`dead-${i}`, 10 * i));
      if (h.setTime) h.setTime(30_000);
      for (let i = 0; i < 5; i++) await h.store.saveExecution(makeExec(`live-${i}`, 10 * i + 5));
      if (h.setTime) h.setTime(60_000);
      else for (let i = 0; i < 5; i++) h.dropExecution(`dead-${i}`);

      const page = await h.store.listExecutions(5);
      expect(page.map((e) => e.executionId)).toEqual([
        'live-4',
        'live-3',
        'live-2',
        'live-1',
        'live-0',
      ]);
      const after = await h.store.listExecutions(5, { cursor: cursorOf(page[2]) });
      expect(after.map((e) => e.executionId)).toEqual(['live-1', 'live-0']);
    });

    it('fills a page past a long run of expired records and ties', async () => {
      const h = factory.make({ executionHistory: 60 }, 0);
      // 30 expired runs share one startedAt with 2 live ones, newest of all.
      for (let i = 0; i < 30; i++) {
        await h.store.saveExecution(makeExec(`d-${String(i).padStart(2, '0')}`, 1000));
      }
      if (h.setTime) h.setTime(30_000);
      await h.store.saveExecution(makeExec('a-live', 1000)); // sorts after every d-*
      await h.store.saveExecution(makeExec('older', 900));
      await h.store.saveExecution(makeExec('oldest', 800));
      if (h.setTime) h.setTime(60_000);
      else for (let i = 0; i < 30; i++) h.dropExecution(`d-${String(i).padStart(2, '0')}`);

      expect(await listedIds(h.store, 2)).toEqual(['a-live', 'older']);
      expect((await pageAll(h.store, 1)).flat()).toEqual(['a-live', 'older', 'oldest']);
    });
  },
);

describe.each([memoryHarness, sqliteHarness])('$name — listing order and cleanup', (factory) => {
  it('lists newest first and breaks startedAt ties by executionId descending', async () => {
    const h = factory.make();
    // Tie fixture T, saved in a scrambled order.
    for (const id of ['t-c', 'lo', 't-a', 't-g', 'hi', 't-e', 't-b', 't-f', 't-d']) {
      const startedAt = id === 'hi' ? 2000 : id === 'lo' ? 500 : 1000;
      await h.store.saveExecution(makeExec(id, startedAt));
    }
    const expected = ['hi', 't-g', 't-f', 't-e', 't-d', 't-c', 't-b', 't-a', 'lo'];
    expect(await listedIds(h.store)).toEqual(expected);
    expect(await listedIds(h.store, 4)).toEqual(expected.slice(0, 4));
  });

  it('P1-13 an expired failed run leaves no checkpoints or saved state behind (AC1.5)', async () => {
    const h = factory.make({ executionHistory: 60 }, 0);
    await h.store.saveCheckpoint('f1', 'cp', { step: 1 });
    await h.store.saveExecutionState('f1', {
      workflow: 'wf',
      input: {},
      step: 1,
      status: 'waiting',
    });
    await h.store.savePendingDecision('f1', {
      executionId: 'f1',
      channel: 'c',
      prompt: 'p',
      createdAt: new Date(0).toISOString(),
    });
    await h.store.saveExecution(makeExec('f1', 0, { status: 'failed' }));
    // Another run, saved later, whose side data must survive.
    h.setTime!(30_000);
    await h.store.saveCheckpoint('keep', 'cp', { step: 1 });
    await h.store.saveExecution(makeExec('keep', 30_000));

    h.setTime!(60_000);
    await h.store.saveExecution(makeExec('trigger', 60_000));

    expect(await h.store.getCheckpoint('f1', 'cp')).toBeNull();
    expect(await h.store.getExecutionState('f1')).toBeNull();
    expect(await h.store.listPendingExecutions()).not.toContain('f1');
    expect(await h.store.getCheckpoint('keep', 'cp')).toEqual({ step: 1 });
    // Pending decisions are outside history retention.
    expect((await h.store.getPendingDecisions()).map((d) => d.executionId)).toContain('f1');
    await h.store.resolveDecision('f1', { approved: false });
  });

  it('removes at most PRUNE_BATCH expired records per save', async () => {
    const h = factory.make({ executionHistory: 60, evalHistory: 60 }, 0);
    const extra = 5;
    for (let i = 0; i < PRUNE_BATCH + extra; i++) {
      await h.store.saveExecution(makeExec(`old-${i}`, i));
      await h.store.saveEvalResult({ id: `old-${i}`, eval: 'e', timestamp: i, data: {} });
    }
    h.setTime!(60_000);
    await h.store.saveExecution(makeExec('new-1', 60_000));
    await h.store.saveEvalResult({ id: 'new-1', eval: 'e', timestamp: 60_000, data: {} });
    expect(physicalCounts(h.store)).toEqual({ executions: extra + 1, evals: extra + 1 });
    // Nothing expired is visible while it waits for cleanup.
    expect(await listedIds(h.store)).toEqual(['new-1']);
    expect((await h.store.listEvalResults()).map((e) => e.id)).toEqual(['new-1']);

    await h.store.saveExecution(makeExec('new-2', 60_000));
    await h.store.saveEvalResult({ id: 'new-2', eval: 'e', timestamp: 60_000, data: {} });
    expect(physicalCounts(h.store)).toEqual({ executions: 2, evals: 2 });
  });

  it('P1-17 rejects invalid retention values at construction', () => {
    for (const bad of [0, -1, Number.NaN, Infinity, '60']) {
      for (const category of ['executionHistory', 'evalHistory'] as const) {
        expect(() => factory.make({ [category]: bad } as unknown as HistoryTtls)).toThrow(AxlError);
      }
    }
  });
});

/** Rows physically present, expired or not (white-box: cleanup is physical). */
function physicalCounts(store: HistoryStore): { executions: number; evals: number } {
  if (store instanceof MemoryStore) {
    const internals = store as unknown as {
      executionHistory: Map<string, unknown>;
      evalHistory: Map<string, unknown>;
    };
    return {
      executions: internals.executionHistory.size,
      evals: internals.evalHistory.size,
    };
  }
  const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { executions: count('execution_history'), evals: count('eval_history') };
}

describe('MemoryStore maxExecutions', () => {
  it('P1-12 evicts the oldest by listing order, never by insertion order', async () => {
    const store = new MemoryStore({ maxExecutions: 3 });
    await store.saveExecution(makeExec('b', 2000)); // A
    await store.saveExecution(makeExec('B', 1000));
    await store.saveExecution(makeExec('C', 3000));
    await store.saveExecution(makeExec('a', 2000)); // D, ties with A
    expect(await listedIds(store as unknown as HistoryStore)).toEqual(['C', 'b', 'a']);
    // The newcomer is itself the oldest, so it is the one evicted.
    await store.saveExecution(makeExec('E', 500));
    expect(await listedIds(store as unknown as HistoryStore)).toEqual(['C', 'b', 'a']);
  });

  it('evicts within a startedAt tie group by lowest executionId first', async () => {
    const store = new MemoryStore({ maxExecutions: 3 });
    for (const id of ['t-c', 't-a', 't-d', 't-b']) await store.saveExecution(makeExec(id, 1000));
    expect(await listedIds(store as unknown as HistoryStore)).toEqual(['t-d', 't-c', 't-b']);
  });

  it('re-saving a record with a new startedAt moves it in eviction order', async () => {
    const store = new MemoryStore({ maxExecutions: 2 });
    await store.saveExecution(makeExec('x', 1000));
    await store.saveExecution(makeExec('y', 2000));
    await store.saveExecution(makeExec('x', 3000));
    await store.saveExecution(makeExec('z', 2500));
    expect(await listedIds(store as unknown as HistoryStore)).toEqual(['x', 'z']);
  });

  it('P1-18 an evicted run takes its checkpoints and saved state with it', async () => {
    const store = new MemoryStore({ maxExecutions: 1 });
    await store.saveCheckpoint('A', 'cp', 1);
    await store.saveExecutionState('A', { workflow: 'wf', input: {}, step: 0, status: 'running' });
    await store.saveExecution(makeExec('A', 1000, { status: 'failed' }));
    await store.saveExecution(makeExec('B', 2000));
    expect(await store.getCheckpoint('A', 'cp')).toBeNull();
    expect(await store.getExecutionState('A')).toBeNull();
    expect(await store.getExecution('A')).toBeNull();
  });

  it('P1-17 rejects an invalid maxExecutions with AxlError', () => {
    for (const bad of [0, -1, Number.NaN, 1.5, '3']) {
      expect(() => new MemoryStore({ maxExecutions: bad as number })).toThrow(AxlError);
    }
    expect(() => new MemoryStore({ maxExecutions: Infinity })).not.toThrow();
  });
});

describe('P1-15 runtime state config reaches the stores it builds', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function runThree(runtime: AxlRuntime): Promise<void> {
    runtime.register(
      workflow({ name: 'wf', input: z.object({}).strict(), handler: async () => 'done' }),
    );
    for (let i = 0; i < 3; i++) await runtime.execute('wf', {});
  }

  it('state.memory: maxExecutions bounds and ttls expire the runtime-built MemoryStore', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const runtime = new AxlRuntime({
      state: { store: 'memory', memory: { ttls: { executionHistory: 1 }, maxExecutions: 2 } },
    });
    await runThree(runtime);
    const store = runtime.getStateStore();
    await vi.waitFor(async () => expect(await store.listExecutions!()).toHaveLength(2));
    vi.setSystemTime(1_002_000);
    expect(await store.listExecutions!()).toHaveLength(0);
    await runtime.shutdown();
  });

  it('state.sqlite.ttls expires the runtime-built SQLiteStore', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const path = tmpDbPath();
    const runtime = new AxlRuntime({
      state: { store: 'sqlite', sqlite: { path, ttls: { executionHistory: 1 } } },
    });
    await runThree(runtime);
    const store = runtime.getStateStore();
    await vi.waitFor(async () => expect(await store.listExecutions!()).toHaveLength(3));
    vi.setSystemTime(1_002_000);
    expect(await store.listExecutions!()).toHaveLength(0);
    await runtime.shutdown();
    // The rows themselves are untouched until a later save cleans them up.
    const Database = require_('better-sqlite3');
    const db = new Database(path, { readonly: true });
    try {
      const rows = db.prepare('SELECT expires_at FROM execution_history').all() as Array<{
        expires_at: number;
      }>;
      expect(rows.every((r) => r.expires_at > 1_000_000 && r.expires_at <= 1_001_000 + 1)).toBe(
        true,
      );
    } finally {
      db.close();
    }
  });

  it('rejects invalid state.memory options when the runtime is constructed', () => {
    expect(
      () => new AxlRuntime({ state: { store: 'memory', memory: { maxExecutions: 0 } } }),
    ).toThrow(AxlError);
  });
});
