/**
 * `applyHistoryRetention`: the explicit, resumable maintenance call that
 * brings records saved without a retention under the configured one and
 * repairs Redis listing indexes (plan FR13, AC6.1, AC6.2, E10, E13; test
 * matrix P5-01..P5-11).
 *
 * Records written "before the upgrade" are seeded through a store with no
 * retention, then the same data is opened with one: SQLite reopens the file,
 * Redis builds a second store over the same mock client. MemoryStore cannot
 * hold such records (its retention is fixed at construction and its data
 * does not survive a restart), so it gets its own shape tests.
 *
 * The Date clock is faked: every store reads `Date.now()` here.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { MemoryStore } from '../state/memory.js';
import { SQLiteStore } from '../state/sqlite.js';
import { RedisStore } from '../state/redis.js';
import type {
  HistoryRetentionKind,
  HistoryRetentionResult,
  HistoryTtls,
  StateStore,
} from '../state/types.js';
import type { HistoricalExecutionInfo } from '../types.js';
import { AxlError } from '../errors.js';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { z } from 'zod';
import { createRedisStoreOverClient, createRedisStoreWithMockClient } from './redis-mock-client.js';
import { gateRedisClient } from './redis-gated-client.js';

const require_ = createRequire(import.meta.url);

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const TTL_S = 60;
const TTL_MS = TTL_S * 1000;

type Store = StateStore &
  Required<
    Pick<
      StateStore,
      | 'saveExecution'
      | 'getExecution'
      | 'listExecutions'
      | 'deleteExecution'
      | 'saveEvalResult'
      | 'listEvalResults'
      | 'getEvalRetention'
      | 'applyHistoryRetention'
    >
  >;

function makeExec(
  id: string,
  startedAt: number,
  completedAt: number | undefined = startedAt,
): HistoricalExecutionInfo {
  const exec = {
    executionId: id,
    workflow: 'wf',
    status: 'completed',
    eventSchemaVersion: 2,
    events: [],
    totalCost: 0,
    startedAt,
    duration: 0,
  } as unknown as HistoricalExecutionInfo;
  if (completedAt !== undefined) exec.completedAt = completedAt;
  return exec;
}

type Totals = Omit<HistoryRetentionResult, 'cursor'> & { calls: number };

/** Loop `applyHistoryRetention` until its cursor is null. */
async function runToCompletion(
  store: Store,
  kind: HistoryRetentionKind,
  batchSize?: number,
): Promise<Totals> {
  const totals: Totals = { expired: 0, armed: 0, indexed: 0, deadIndexEntries: 0, calls: 0 };
  let cursor: HistoryRetentionResult['cursor'] = null;
  do {
    const r = await store.applyHistoryRetention({ kind, batchSize, cursor });
    totals.expired += r.expired;
    totals.armed += r.armed;
    totals.indexed += r.indexed;
    totals.deadIndexEntries += r.deadIndexEntries;
    totals.calls++;
    cursor = r.cursor;
    if (totals.calls > 1000) throw new Error('maintenance did not finish');
  } while (cursor !== null);
  return totals;
}

const ZERO = { expired: 0, armed: 0, indexed: 0, deadIndexEntries: 0 };

const tmpDirs: string[] = [];
const closers: Array<() => unknown> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A store holding "pre-upgrade" history: seed it through `legacy` (no
 * retention), then `reopen` the same data with a retention.
 */
type LegacyHarness = {
  name: string;
  legacy: Store;
  reopen(ttls?: HistoryTtls): Store;
  /**
   * The record's absolute expiry in ms, `null` if it has none, `undefined` if
   * the record is gone.
   */
  expiryOf(kind: HistoryRetentionKind, id: string): number | null | undefined;
  /** Whether the run still has checkpoints, or `null` where expiry leaves them to their own TTL. */
  hasCheckpoints(id: string): boolean | null;
};

type HarnessFactory = { name: string; make(): LegacyHarness };

const sqliteFactory: HarnessFactory = {
  name: 'SQLiteStore',
  make() {
    const dir = mkdtempSync(join(tmpdir(), 'axl-maintenance-'));
    tmpDirs.push(dir);
    const path = join(dir, 'state.db');
    const legacy = new SQLiteStore(path);
    closers.push(() => legacy.close());
    const Database = require_('better-sqlite3');
    let reader: { prepare(sql: string): { get(...a: unknown[]): unknown }; close(): void } | null =
      null;
    const read = () => {
      if (!reader) {
        reader = new Database(path, { readonly: true });
        closers.push(() => reader!.close());
      }
      return reader!;
    };
    return {
      name: 'SQLiteStore',
      legacy: legacy as unknown as Store,
      reopen(ttls) {
        const store = new SQLiteStore(path, { ttls });
        closers.push(() => store.close());
        return store as unknown as Store;
      },
      expiryOf(kind, id) {
        const row = read()
          .prepare(
            kind === 'executions'
              ? 'SELECT expires_at FROM execution_history WHERE execution_id = ?'
              : 'SELECT expires_at FROM eval_history WHERE id = ?',
          )
          .get(id) as { expires_at: number | null } | undefined;
        return row === undefined ? undefined : row.expires_at;
      },
      hasCheckpoints(id) {
        const row = read()
          .prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE execution_id = ?')
          .get(id) as { n: number };
        return row.n > 0;
      },
    };
  },
};

const redisFactory: HarnessFactory = {
  name: 'RedisStore (mock client)',
  make() {
    const mock = createRedisStoreWithMockClient('axl:');
    const dataKey = (kind: HistoryRetentionKind, id: string) =>
      kind === 'executions' ? `axl:exec-history:${id}` : `axl:eval-history:${id}`;
    return {
      name: 'RedisStore (mock client)',
      legacy: mock.store as unknown as Store,
      reopen(ttls) {
        return createRedisStoreOverClient(mock.mockClient, 'axl:', {
          executionHistory: ttls?.executionHistory ?? null,
          evalHistory: ttls?.evalHistory ?? null,
        }) as unknown as Store;
      },
      expiryOf(kind, id) {
        const key = dataKey(kind, id);
        if (!mock.data.has(key)) return undefined;
        const seconds = mock.ttls.get(key);
        return seconds === undefined ? null : Math.round(Date.now() + seconds * 1000);
      },
      hasCheckpoints: () => null,
    };
  },
};

async function listedIds(store: Store): Promise<string[]> {
  return (await store.listExecutions()).map((e) => e.executionId);
}

describe.each([sqliteFactory, redisFactory])(
  '$name — applyHistoryRetention on pre-upgrade records',
  (factory) => {
    it('P5-01 an upgrade and normal operation leave untimed records alone (AC6.1, E10)', async () => {
      const h = factory.make();
      await h.legacy.saveExecution(makeExec('L1', T0 - 2 * HOUR));
      await h.legacy.saveEvalResult({ id: 'V1', eval: 'e', timestamp: T0 - 2 * HOUR, data: {} });
      const store = h.reopen({ executionHistory: TTL_S, evalHistory: TTL_S });
      for (let i = 0; i < 50; i++) {
        vi.setSystemTime(T0 + i * TTL_MS);
        await store.saveExecution(makeExec(`n-${i}`, T0 + i * TTL_MS));
        await store.saveEvalResult({ id: `v-${i}`, eval: 'e', timestamp: T0 + i, data: {} });
        await store.listExecutions(5);
      }
      vi.setSystemTime(T0 + 10 * 365 * 24 * HOUR);
      await store.saveExecution(makeExec('late', T0 + 10 * 365 * 24 * HOUR));

      expect(await store.getExecution('L1')).not.toBeNull();
      expect(h.expiryOf('executions', 'L1')).toBeNull();
      expect((await store.getEvalRetention('V1')).exists).toBe(true);
      expect(h.expiryOf('evals', 'V1')).toBeNull();
    });

    it('P5-02 arms from the last save and deletes records already past the window', async () => {
      const h = factory.make();
      // L1 finished 30 s ago, L2 120 s ago; both started an hour before that.
      await h.legacy.saveExecution(makeExec('L1', T0 - HOUR, T0 - 30_000));
      await h.legacy.saveCheckpoint('L2', 'cp', { step: 1 });
      await h.legacy.saveExecution(makeExec('L2', T0 - HOUR - 1, T0 - 120_000));
      // No completedAt: the window counts from startedAt (A1).
      await h.legacy.saveExecution(makeExec('L3', T0 - 10_000, undefined));
      const store = h.reopen({ executionHistory: TTL_S });

      const totals = await runToCompletion(store, 'executions');

      expect(totals).toMatchObject({ armed: 2, expired: 1, deadIndexEntries: 0 });
      expect(h.expiryOf('executions', 'L1')).toBe(T0 - 30_000 + TTL_MS);
      expect(h.expiryOf('executions', 'L3')).toBe(T0 - 10_000 + TTL_MS);
      expect(h.expiryOf('executions', 'L2')).toBeUndefined();
      expect(await store.getExecution('L2')).toBeNull();
      expect(await listedIds(store)).toEqual(['L3', 'L1']);
      if (h.hasCheckpoints('L2') !== null) expect(h.hasCheckpoints('L2')).toBe(false);
    });

    it('expires a record exactly at the end of its window and arms one 1 ms short of it', async () => {
      const h = factory.make();
      await h.legacy.saveExecution(makeExec('at-boundary', T0 - HOUR, T0 - TTL_MS));
      await h.legacy.saveExecution(makeExec('just-inside', T0 - HOUR, T0 - TTL_MS + 1));
      const store = h.reopen({ executionHistory: TTL_S });

      const totals = await runToCompletion(store, 'executions');

      expect(totals).toMatchObject({ expired: 1, armed: 1 });
      expect(h.expiryOf('executions', 'at-boundary')).toBeUndefined();
      expect(h.expiryOf('executions', 'just-inside')).toBe(T0 + 1);
    });

    it('P5-05 resumes from its cursor across startedAt ties and deletions in the first batch (E13)', async () => {
      const h = factory.make();
      // 25 untimed records, oldest first: 3 already past the window (removed
      // by the first batch), then 2 more, then a 10-record startedAt tie
      // group that straddles the batch boundaries, then 10 more.
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(`old-${i}`);
        await h.legacy.saveExecution(makeExec(`old-${i}`, T0 - 10 * HOUR + i, T0 - 5 * HOUR));
      }
      for (let i = 0; i < 2; i++) {
        ids.push(`pre-${i}`);
        await h.legacy.saveExecution(makeExec(`pre-${i}`, T0 - HOUR + i, T0 - 1000));
      }
      for (const letter of 'abcdefghij') {
        ids.push(`tie-${letter}`);
        await h.legacy.saveExecution(makeExec(`tie-${letter}`, T0 - HOUR + 100, T0 - 1000));
      }
      for (let i = 0; i < 10; i++) {
        ids.push(`post-${i}`);
        await h.legacy.saveExecution(makeExec(`post-${i}`, T0 - HOUR + 200 + i, T0 - 1000));
      }
      const store = h.reopen({ executionHistory: TTL_S });
      // Three records saved under the retention: already timed, untouched.
      for (let i = 0; i < 3; i++) await store.saveExecution(makeExec(`timed-${i}`, T0 + i));

      const first = await store.applyHistoryRetention({ kind: 'executions', batchSize: 7 });
      expect(first).toMatchObject({ expired: 3, armed: 4 });

      // Interrupted here; a later process resumes from the stored cursor.
      const resumed = JSON.parse(JSON.stringify(first.cursor));
      const totals = { expired: first.expired, armed: first.armed, calls: 1 };
      let cursor = resumed;
      while (cursor !== null) {
        const r = await store.applyHistoryRetention({ kind: 'executions', batchSize: 7, cursor });
        totals.expired += r.expired;
        totals.armed += r.armed;
        totals.calls++;
        cursor = r.cursor;
      }

      expect(totals.expired + totals.armed).toBe(25);
      expect(totals.expired).toBe(3);
      // 28 records, 7 per call, the deleted three behind the cursor do not
      // shift it: 4 calls.
      expect(totals.calls).toBe(4);
      for (const id of ids.slice(3)) {
        expect(h.expiryOf('executions', id)).toBe(T0 - 1000 + TTL_MS);
      }
      for (let i = 0; i < 3; i++) {
        expect(h.expiryOf('executions', `timed-${i}`)).toBe(T0 + TTL_MS);
      }
      // The cursor is a position, (startedAt, id), not an offset.
      expect(first.cursor).toEqual({ time: T0 - HOUR + 100, id: 'tie-b' });

      // P5-06: a second full run changes nothing.
      const again = await runToCompletion(store, 'executions', 7);
      expect(again).toMatchObject(ZERO);
      for (const id of ids.slice(3)) {
        expect(h.expiryOf('executions', id)).toBe(T0 - 1000 + TTL_MS);
      }
    });

    it('P5-11 a cursor whose record was deleted still resumes in place', async () => {
      const h = factory.make();
      for (const id of ['a', 'b', 'c', 'd']) {
        await h.legacy.saveExecution(makeExec(id, T0 - HOUR, T0 - 1000));
      }
      const store = h.reopen({ executionHistory: TTL_S });
      const first = await store.applyHistoryRetention({ kind: 'executions', batchSize: 2 });
      expect(first.cursor).toEqual({ time: T0 - HOUR, id: 'b' });
      await store.deleteExecution('b');
      await store.deleteExecution('a');

      const rest = await store.applyHistoryRetention({
        kind: 'executions',
        batchSize: 2,
        cursor: first.cursor,
      });

      expect(rest).toMatchObject({ armed: 2, cursor: null });
      expect(h.expiryOf('executions', 'c')).toBe(T0 - 1000 + TTL_MS);
      expect(h.expiryOf('executions', 'd')).toBe(T0 - 1000 + TTL_MS);
    });

    it('P5-07 with no retention (unset or null) nothing is armed or expired', async () => {
      for (const ttls of [undefined, { executionHistory: null, evalHistory: null }]) {
        const h = factory.make();
        await h.legacy.saveExecution(makeExec('ancient', 0, 0));
        await h.legacy.saveEvalResult({ id: 'V', eval: 'e', timestamp: 0, data: {} });
        const store = h.reopen(ttls);

        expect(await runToCompletion(store, 'executions')).toMatchObject(ZERO);
        expect(await runToCompletion(store, 'evals')).toMatchObject(ZERO);
        expect(h.expiryOf('executions', 'ancient')).toBeNull();
        expect(h.expiryOf('evals', 'V')).toBeNull();
      }
    });

    it('P5-08 applies eval retention from the row timestamp, independently of executions', async () => {
      const h = factory.make();
      await h.legacy.saveEvalResult({
        id: 'V-old',
        eval: 'e',
        timestamp: T0 - 2 * TTL_MS,
        data: {},
      });
      await h.legacy.saveEvalResult({ id: 'V-new', eval: 'e', timestamp: T0 - 1000, data: {} });
      await h.legacy.saveExecution(makeExec('L', T0 - HOUR, T0 - HOUR));
      const store = h.reopen({ executionHistory: TTL_S, evalHistory: TTL_S });

      const totals = await runToCompletion(store, 'evals');

      expect(totals).toMatchObject({ expired: 1, armed: 1 });
      expect(await store.getEvalRetention('V-old')).toEqual({ exists: false });
      expect(await store.getEvalRetention('V-new')).toEqual({
        exists: true,
        expiresAt: T0 - 1000 + TTL_MS,
      });
      expect((await store.listEvalResults()).map((e) => e.id)).toEqual(['V-new']);
      // The execution kind was not touched.
      expect(h.expiryOf('executions', 'L')).toBeNull();
    });

    it('P5-10 is never run by construction, saves, lists or the runtime', async () => {
      const h = factory.make();
      await h.legacy.saveExecution(makeExec('L', 0, 0));
      const spy = vi.spyOn(
        (factory === sqliteFactory ? SQLiteStore : RedisStore).prototype,
        'applyHistoryRetention',
      );
      const store = h.reopen({ executionHistory: TTL_S });
      const runtime = new AxlRuntime({ state: { store } });
      runtime.register(workflow({ name: 'wf', input: z.object({}), handler: async () => 'ok' }));
      await runtime.execute('wf', {});
      await runtime.getExecutions();
      await runtime.getExecutions({ limit: 1 });
      await runtime.shutdown();

      expect(spy).not.toHaveBeenCalled();
      expect(h.expiryOf('executions', 'L')).toBeNull();
    });

    it('rejects invalid options with AxlError before touching anything', async () => {
      const h = factory.make();
      await h.legacy.saveExecution(makeExec('L', 0, 0));
      const store = h.reopen({ executionHistory: TTL_S });
      const bad: unknown[] = [
        { kind: 'execution' },
        { kind: 'executions', batchSize: 0 },
        { kind: 'executions', batchSize: -1 },
        { kind: 'executions', batchSize: 1.5 },
        { kind: 'executions', batchSize: '5' },
        { kind: 'executions', cursor: { startedAt: 1, executionId: 'x' } },
        { kind: 'executions', cursor: { time: Number.NaN, id: 'x' } },
        null,
      ];
      for (const options of bad) {
        await expect(
          store.applyHistoryRetention(options as Parameters<Store['applyHistoryRetention']>[0]),
        ).rejects.toMatchObject({ name: 'AxlError', code: 'INVALID_ARGUMENT' });
      }
      expect(h.expiryOf('executions', 'L')).toBeNull();
      await expect(store.applyHistoryRetention({ kind: 'executions' })).resolves.toMatchObject({
        expired: 1,
      });
    });
  },
);

describe('MemoryStore applyHistoryRetention', () => {
  it('finds nothing to do: every record was saved under the current retention', async () => {
    const store = new MemoryStore({ ttls: { executionHistory: TTL_S, evalHistory: TTL_S } });
    for (let i = 0; i < 5; i++) await store.saveExecution(makeExec(`e-${i}`, T0 - i, T0));
    await store.saveEvalResult({ id: 'v', eval: 'e', timestamp: T0, data: {} });

    expect(await runToCompletion(store as Store, 'executions', 2)).toMatchObject({
      ...ZERO,
      calls: 3,
    });
    expect(await runToCompletion(store as Store, 'evals')).toMatchObject({ ...ZERO, calls: 1 });
    expect(await store.listExecutions()).toHaveLength(5);
  });

  it('walks executions oldest first by (startedAt, executionId), resuming strictly after the cursor', async () => {
    const store = new MemoryStore();
    for (const [id, startedAt] of [
      ['b', 10],
      ['a', 10],
      ['c', 5],
      ['d', 20],
    ] as const) {
      await store.saveExecution(makeExec(id, startedAt));
    }
    const cursors: unknown[] = [];
    let cursor: HistoryRetentionResult['cursor'] = null;
    do {
      const r = await store.applyHistoryRetention({ kind: 'executions', batchSize: 1, cursor });
      cursors.push(r.cursor);
      cursor = r.cursor;
    } while (cursor !== null);
    expect(cursors).toEqual([
      { time: 5, id: 'c' },
      { time: 10, id: 'a' },
      { time: 10, id: 'b' },
      null,
    ]);
  });

  it('rejects invalid options with AxlError', async () => {
    const store = new MemoryStore();
    await expect(
      store.applyHistoryRetention({ kind: 'executions', batchSize: 0 }),
    ).rejects.toBeInstanceOf(AxlError);
  });
});

// ── RedisStore index repair ──────────────────────────────────────────────

describe('RedisStore applyHistoryRetention index repair', () => {
  const IDS = 'axl:exec-history-ids';
  const TIME = 'axl:exec-history-z';
  const EXPIRY = 'axl:exec-history-exp';
  const blob = (id: string) => `axl:exec-history:${id}`;

  function setup(ttls: { executionHistory?: number | null } = { executionHistory: TTL_S }) {
    const mock = createRedisStoreWithMockClient('axl:', {
      executionHistory: ttls.executionHistory ?? null,
    });
    const indexed = (key: string, id: string) =>
      key === IDS
        ? mock.setData.get(IDS)?.has(id) === true
        : mock.zsetData.get(key)?.has(id) === true;
    /** A record in both listing indexes with a blob (optionally timed) and no expiry entry. */
    const plant = (id: string, startedAt: number, ttlSeconds?: number) => {
      mock.data.set(blob(id), JSON.stringify(makeExec(id, startedAt, startedAt)));
      if (ttlSeconds !== undefined) mock.ttls.set(blob(id), ttlSeconds);
      if (!mock.setData.has(IDS)) mock.setData.set(IDS, new Set());
      mock.setData.get(IDS)!.add(id);
      if (!mock.zsetData.has(TIME)) mock.zsetData.set(TIME, new Map());
      mock.zsetData.get(TIME)!.set(id, startedAt);
    };
    return { ...mock, store: mock.store as unknown as Store, indexed, plant };
  }

  it('P5-03 indexes a record timed before the upgrade without changing its TTL', async () => {
    const r = setup();
    r.plant('T1', T0 - HOUR, 30);

    expect(await runToCompletion(r.store, 'executions')).toMatchObject({ indexed: 1, armed: 0 });

    expect(r.ttls.get(blob('T1'))).toBe(30);
    expect(r.zsetData.get(EXPIRY)!.get('T1')).toBe(T0 + 30_000);
    expect(await runToCompletion(r.store, 'executions')).toMatchObject(ZERO);
  });

  it('P5-04 removes index entries whose record is gone', async () => {
    const r = setup();
    r.plant('live', T0 - HOUR);
    r.ttls.set(blob('live'), 600);
    r.zsetData.set(EXPIRY, new Map([['live', T0 + 600_000]]));
    for (const id of ['d1', 'd2', 'd3']) {
      r.plant(id, T0 - 2 * HOUR);
      r.data.delete(blob(id));
    }

    expect(await runToCompletion(r.store, 'executions', 2)).toMatchObject({
      deadIndexEntries: 3,
      indexed: 0,
    });
    for (const id of ['d1', 'd2', 'd3']) {
      expect(r.indexed(IDS, id) || r.indexed(TIME, id)).toBe(false);
    }
    expect(await listedIds(r.store)).toEqual(['live']);
    expect(await runToCompletion(r.store, 'executions')).toMatchObject(ZERO);
  });

  it('P5-07 still repairs indexes with no retention configured', async () => {
    const r = setup({ executionHistory: null });
    r.plant('T1', T0 - HOUR, 30);
    r.plant('untimed', 0);
    r.plant('dead', T0);
    r.data.delete(blob('dead'));

    expect(await runToCompletion(r.store, 'executions')).toEqual({
      expired: 0,
      armed: 0,
      indexed: 1,
      deadIndexEntries: 1,
      calls: 1,
    });
    expect(r.ttls.has(blob('untimed'))).toBe(false);
  });

  it('expires and arms with PEXPIREAT NX and indexes armed records in the expiry set', async () => {
    const r = setup();
    r.plant('armed', T0 - HOUR);
    r.plant('expired', T0 - 2 * HOUR);
    // Last saved = completedAt: rewrite the blobs with explicit completion times.
    r.data.set(blob('armed'), JSON.stringify(makeExec('armed', T0 - HOUR, T0 - 1000)));
    r.data.set(blob('expired'), JSON.stringify(makeExec('expired', T0 - 2 * HOUR, T0 - TTL_MS)));

    expect(await runToCompletion(r.store, 'executions')).toMatchObject({ armed: 1, expired: 1 });

    expect(r.zsetData.get(EXPIRY)!.get('armed')).toBe(T0 - 1000 + TTL_MS);
    expect(r.ttls.get(blob('armed'))).toBe((TTL_MS - 1000) / 1000);
    expect(r.data.has(blob('expired'))).toBe(false);
    for (const key of [IDS, TIME, EXPIRY]) expect(r.indexed(key, 'expired')).toBe(false);
  });

  it('drains recheck batches left by crashed prunes', async () => {
    const r = setup();
    // A prune removed `Y` from the indexes, registered its batch and died
    // before re-checking; `Y` is live.
    r.data.set(blob('Y'), JSON.stringify(makeExec('Y', T0 - 1000)));
    r.setData.set('axl:exec-history-prune-recheck-tokens', new Set(['crashed']));
    r.setData.set('axl:exec-history-prune-recheck:crashed', new Set(['Y']));

    await runToCompletion(r.store, 'executions');

    expect(await listedIds(r.store)).toEqual(['Y']);
    expect(r.setData.get('axl:exec-history-prune-recheck-tokens')?.size ?? 0).toBe(0);
    expect(r.setData.has('axl:exec-history-prune-recheck:crashed')).toBe(false);
  });

  it('backfills the time index on the first call when it is behind the id set', async () => {
    const r = setup();
    r.plant('a', T0 - HOUR);
    r.data.set(blob('b'), JSON.stringify(makeExec('b', T0 - 2 * HOUR, T0 - 1000)));
    r.setData.get(IDS)!.add('b');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runToCompletion(r.store, 'executions')).toMatchObject({ armed: 1, expired: 1 });
    expect(r.zsetData.get(EXPIRY)!.get('b')).toBe(T0 - 1000 + TTL_MS);
  });

  it('a record re-saved before its removal stays listed', async () => {
    const r = setup();
    r.plant('Y', T0 - HOUR);
    r.data.delete(blob('Y'));
    const gated = gateRedisClient(r.mockClient);
    const maintainer = createRedisStoreOverClient(gated.client, 'axl:', {
      executionHistory: TTL_S,
    }) as unknown as Store;

    const atRemove = gated.pauseAt('remove-multi');
    const run = runToCompletion(maintainer, 'executions');
    await atRemove;
    await r.store.saveExecution(makeExec('Y', T0 - HOUR));
    gated.release('remove-multi');
    expect(await run).toMatchObject({ deadIndexEntries: 1 });

    expect(await listedIds(r.store)).toEqual(['Y']);
    expect(r.zsetData.get(EXPIRY)!.get('Y')).toBe(T0 + TTL_MS);
  });

  it('a record re-saved before it is armed or expired keeps the window its save gave it', async () => {
    const r = setup();
    r.plant('past', T0 - 2 * HOUR); // past the window: would be deleted
    r.plant('inside', T0 - 1000); // inside the window: would be armed
    const gated = gateRedisClient(r.mockClient);
    const maintainer = createRedisStoreOverClient(gated.client, 'axl:', {
      executionHistory: TTL_S,
    }) as unknown as Store;

    const atRetention = gated.pauseAt('retention-multi');
    const run = runToCompletion(maintainer, 'executions');
    await atRetention;
    vi.setSystemTime(T0 + 5000);
    await r.store.saveExecution(makeExec('past', T0 - 2 * HOUR));
    await r.store.saveExecution(makeExec('inside', T0 - 1000));
    gated.release('retention-multi');
    expect(await run).toMatchObject({ armed: 0, expired: 0 });

    for (const id of ['past', 'inside']) {
      expect(r.ttls.get(blob(id))).toBe(TTL_S);
      expect(r.zsetData.get(EXPIRY)!.get(id)).toBe(T0 + 5000 + TTL_MS);
    }
    expect(await listedIds(r.store)).toEqual(['inside', 'past']);
  });

  it('a record deleted during maintenance is never re-indexed or resurrected', async () => {
    const r = setup();
    r.plant('timed', T0 - HOUR, 30);
    r.plant('untimed', T0 - 1000);
    r.plant('dead', T0 - 2 * HOUR);
    r.data.delete(blob('dead'));
    const gated = gateRedisClient(r.mockClient);
    const maintainer = createRedisStoreOverClient(gated.client, 'axl:', {
      executionHistory: TTL_S,
    }) as unknown as Store;

    const atRetention = gated.pauseAt('retention-multi');
    const run = runToCompletion(maintainer, 'executions');
    await atRetention;
    await r.store.deleteExecution('timed');
    await r.store.deleteExecution('untimed');
    gated.release('retention-multi');
    await run;

    for (const id of ['timed', 'untimed', 'dead']) {
      expect(r.data.has(blob(id))).toBe(false);
      expect(r.indexed(IDS, id) || r.indexed(TIME, id)).toBe(false);
      expect(await r.store.getExecution(id)).toBeNull();
    }
    expect(await listedIds(r.store)).toEqual([]);
  });

  it('P5-09 an interrupted batch resumed from the previous cursor ends in the same state', async () => {
    const seed = (r: ReturnType<typeof setup>) => {
      for (let i = 0; i < 7; i++) r.plant(`u-${i}`, T0 - 1000 + i);
      r.plant('timed', T0 - HOUR + 10, 30);
    };
    const reference = setup();
    seed(reference);
    await runToCompletion(reference.store, 'executions', 4);

    const r = setup();
    seed(r);
    const gated = gateRedisClient(r.mockClient);
    const maintainer = createRedisStoreOverClient(gated.client, 'axl:', {
      executionHistory: TTL_S,
    }) as unknown as Store;
    const first = await maintainer.applyHistoryRetention({ kind: 'executions', batchSize: 4 });
    // The second batch arms its records, then the connection drops before
    // they are added to the expiry set.
    gated.failAt('rescore-multi');
    await expect(
      maintainer.applyHistoryRetention({ kind: 'executions', batchSize: 4, cursor: first.cursor }),
    ).rejects.toThrow(/ECONNRESET/);
    // Resume from the cursor the failed call was given.
    let cursor = first.cursor;
    while (cursor !== null) {
      cursor = (
        await maintainer.applyHistoryRetention({ kind: 'executions', batchSize: 4, cursor })
      ).cursor;
    }

    const snapshot = (x: ReturnType<typeof setup>) => ({
      ids: [...(x.setData.get(IDS) ?? [])].sort(),
      time: [...(x.zsetData.get(TIME) ?? new Map())].sort(),
      expiry: [...(x.zsetData.get(EXPIRY) ?? new Map())].sort(),
      ttls: [...x.ttls].sort(),
    });
    expect(snapshot(r)).toEqual(snapshot(reference));
  });
});
