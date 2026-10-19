/**
 * RedisStore history index cleanup (plan FR5, AC2.1–AC2.4, E4, E5, E7; test
 * matrix P2-03..P2-16).
 *
 * Runs on the shared mock client. The mock does not expire keys on its own,
 * so a record "expires" when a test deletes its blob and gives its expiry
 * entry a past score. Competing writers are a second RedisStore over the same
 * client, the way two processes share one Redis. Interleavings are driven by
 * the gated client (`redis-gated-client.ts`): no timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PRUNE_BATCH } from '../state/retention.js';
import type { RedisStore } from '../state/redis.js';
import type { HistoricalExecutionInfo } from '../types.js';
import { __resetDiagnosticWarnings } from '../schema-diagnostics.js';
import {
  createRedisStoreOverClient,
  createRedisStoreWithMockClient,
  type MockTtlConfig,
} from './redis-mock-client.js';
import { gateRedisClient } from './redis-gated-client.js';

const IDS = 'axl:exec-history-ids';
const TIME = 'axl:exec-history-z';
const EXPIRY = 'axl:exec-history-exp';
const blobKey = (id: string) => `axl:exec-history:${id}`;

function makeExec(id: string, startedAt: number): HistoricalExecutionInfo {
  return {
    executionId: id,
    workflow: 'wf',
    status: 'completed',
    eventSchemaVersion: 2,
    events: [],
    totalCost: 0,
    startedAt,
    completedAt: startedAt,
    duration: 0,
  } as HistoricalExecutionInfo;
}

/**
 * One mock Redis, a gated store S1 (the pruner under test) and an ungated
 * store S2 (the competing process), both with execution retention unless
 * overridden.
 */
function setup(options?: { s1?: MockTtlConfig; s2?: MockTtlConfig }) {
  const s1Ttls = options?.s1 ?? { executionHistory: 60, evalHistory: 60 };
  const mock = createRedisStoreWithMockClient('axl:', s1Ttls);
  const gate = gateRedisClient(mock.mockClient);
  const s1 = createRedisStoreOverClient(gate.client, 'axl:', s1Ttls);
  const s2 = createRedisStoreOverClient(
    mock.mockClient,
    'axl:',
    options?.s2 ?? { executionHistory: 60, evalHistory: 60 },
  );
  const members = (key: string) => [...(mock.setData.get(key) ?? [])].sort();
  const zmembers = (key: string) => [...(mock.zsetData.get(key)?.keys() ?? [])].sort();
  const score = (key: string, id: string) => mock.zsetData.get(key)?.get(id);

  /** Index an execution whose record has already expired: no blob, past expiry. */
  function plantDead(id: string, startedAt = 1, expiryKey = EXPIRY, kind = 'exec') {
    const ids = kind === 'exec' ? IDS : 'axl:eval-history-ids';
    const time = kind === 'exec' ? TIME : 'axl:eval-history-z';
    if (!mock.setData.has(ids)) mock.setData.set(ids, new Set());
    mock.setData.get(ids)!.add(id);
    for (const [key, s] of [
      [time, startedAt],
      [expiryKey, 1],
    ] as const) {
      if (!mock.zsetData.has(key)) mock.zsetData.set(key, new Map());
      mock.zsetData.get(key)!.set(id, s);
    }
  }

  /** The record behind an index entry expired: drop its blob, backdate its expiry. */
  function expire(id: string) {
    mock.data.delete(blobKey(id));
    mock.ttls.delete(blobKey(id));
    mock.zsetData.get(EXPIRY)?.set(id, 1);
  }

  /**
   * The execution indexes agree with the blobs: the id set and the time sorted
   * set hold the same ids; every live record is in both; every timed live
   * record is in the expiry set and no untimed one is.
   */
  function expectConsistent() {
    expect(zmembers(TIME)).toEqual(members(IDS));
    const live = [...mock.data.keys()]
      .filter((k) => k.startsWith('axl:exec-history:'))
      .map((k) => k.slice('axl:exec-history:'.length));
    for (const id of live) {
      expect(members(IDS)).toContain(id);
      if (mock.ttls.has(blobKey(id))) expect(zmembers(EXPIRY)).toContain(id);
      else expect(zmembers(EXPIRY)).not.toContain(id);
    }
  }

  return {
    mock,
    gate,
    s1,
    s2,
    members,
    zmembers,
    score,
    plantDead,
    expire,
    expectConsistent,
  };
}

async function listed(store: RedisStore): Promise<string[]> {
  return (await store.listExecutions()).map((e) => e.executionId);
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  __resetDiagnosticWarnings();
  delete process.env.AXL_DIAGNOSTICS_SILENT;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe('RedisStore expiry index', () => {
  it('P2-03 a timed save writes the expiry entry in the same MULTI as the record', async () => {
    const t = setup();
    const before = Date.now();
    await t.s1.saveExecution(makeExec('e1', 1000));
    const after = Date.now();
    const saveMulti = t.mock.mockClient.multi.mock.results[0].value as {
      _queueLength(): number;
    };
    // sAdd ids + set blob + zAdd time + zAdd expiry
    expect(saveMulti._queueLength()).toBe(4);
    expect(t.score(TIME, 'e1')).toBe(1000);
    const expiry = t.score(EXPIRY, 'e1')!;
    expect(expiry).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiry).toBeLessThanOrEqual(after + 60_000);
  });

  it('E7 untimed records never enter the expiry set and are never pruned', async () => {
    const t = setup({ s1: { executionHistory: null }, s2: { executionHistory: null } });
    await t.s1.saveExecution(makeExec('u1', 1000));
    await t.s1.saveExecution(makeExec('u2', 2000));
    expect(t.zmembers(EXPIRY)).toEqual([]);
    expect(t.gate.steps).not.toContain('mget-1');
    expect(await listed(t.s1)).toEqual(['u2', 'u1']);
  });

  it('an untimed re-save of a timed record takes it out of the expiry set', async () => {
    const t = setup({ s1: { executionHistory: 60 }, s2: { executionHistory: null } });
    await t.s1.saveExecution(makeExec('x', 1000));
    expect(t.zmembers(EXPIRY)).toEqual(['x']);
    await t.s2.saveExecution(makeExec('x', 1000));
    expect(t.zmembers(EXPIRY)).toEqual([]);
    // Even with its old expiry long past, the untimed record stays listed.
    await t.s1.saveExecution(makeExec('y', 2000));
    expect(await listed(t.s1)).toEqual(['y', 'x']);
  });

  it('eval rows: a new timed row is scored by its expiry; a re-save keeps the expiry it carries', async () => {
    const t = setup();
    const before = Date.now();
    await t.s1.saveEvalResult({ id: 'v1', eval: 'e', timestamp: 5, data: {} });
    const first = t.score('axl:eval-history-exp', 'v1')!;
    expect(first).toBeGreaterThanOrEqual(before + 60_000);
    // 10 s are left on the row: the re-save keeps that, not a fresh 60 s.
    t.mock.ttls.set('axl:eval-history:v1', 10);
    const resave = Date.now();
    await t.s1.saveEvalResult({ id: 'v1', eval: 'e', timestamp: 5, data: { n: 2 } });
    const second = t.score('axl:eval-history-exp', 'v1')!;
    expect(second).toBeGreaterThanOrEqual(resave + 10_000);
    expect(second).toBeLessThan(resave + 60_000);
  });

  it('eval rows: a re-save of a row that exists untimed takes it out of the expiry set', async () => {
    const t = setup();
    await t.s1.saveEvalResult({ id: 'v1', eval: 'e', timestamp: 5, data: {} });
    t.mock.ttls.delete('axl:eval-history:v1'); // PERSIST
    await t.s1.saveEvalResult({ id: 'v1', eval: 'e', timestamp: 5, data: {} });
    expect(t.zmembers('axl:eval-history-exp')).toEqual([]);
  });

  it('P2-12 delete removes the expiry entry in the same MULTI', async () => {
    const t = setup();
    await t.s1.saveExecution(makeExec('d1', 1000));
    await t.s1.saveEvalResult({ id: 'v1', eval: 'e', timestamp: 5, data: {} });
    const multisBefore = t.mock.mockClient.multi.mock.calls.length;
    await t.s1.deleteExecution('d1');
    await t.s1.deleteEvalResult('v1');
    expect(t.mock.mockClient.multi.mock.calls.length).toBe(multisBefore + 2);
    expect(t.zmembers(EXPIRY)).toEqual([]);
    expect(t.zmembers('axl:eval-history-exp')).toEqual([]);
  });
});

describe('RedisStore prune on save', () => {
  it('P2-04 / AC2.1 removes only dead ids, PRUNE_BATCH per save, from all three indexes', async () => {
    const t = setup();
    const dead = Array.from({ length: 2 * PRUNE_BATCH + 1 }, (_, i) => `dead-${i}`);
    for (const id of dead) t.plantDead(id);
    // A live record whose expiry entry is in the past (its TTL was changed
    // behind the store's back): never removed from the listing indexes.
    t.plantDead('re', 50);
    t.mock.data.set(blobKey('re'), JSON.stringify(makeExec('re', 50)));
    t.mock.ttls.set(blobKey('re'), 30);

    await t.s1.saveExecution(makeExec('n1', 10_000));
    const remaining = dead.filter((id) => t.members(IDS).includes(id));
    expect(remaining).toHaveLength(dead.length - PRUNE_BATCH);
    for (const key of [TIME, EXPIRY]) {
      expect(t.zmembers(key).filter((id) => id.startsWith('dead-'))).toHaveLength(
        dead.length - PRUNE_BATCH,
      );
    }
    expect(t.members(IDS)).toContain('re');
    expect(t.zmembers(TIME)).toContain('re');
    expect(t.zmembers(EXPIRY)).toContain('re');

    // ⌈N / PRUNE_BATCH⌉ saves clear N expired records.
    await t.s1.saveExecution(makeExec('n2', 10_001));
    await t.s1.saveExecution(makeExec('n3', 10_002));
    expect(t.members(IDS).filter((id) => id.startsWith('dead-'))).toEqual([]);
    expect(t.zmembers(EXPIRY).filter((id) => id.startsWith('dead-'))).toEqual([]);
    expect(await listed(t.s1)).toEqual(['n3', 'n2', 'n1', 're']);
    expect(t.gate.steps.filter((s) => s === 'eval-prune')).toHaveLength(3);
    t.expectConsistent();
  });

  it('a live entry with a stale expiry score is re-scored from its TTL, not removed', async () => {
    const t = setup();
    t.plantDead('timed', 50);
    t.mock.data.set(blobKey('timed'), JSON.stringify(makeExec('timed', 50)));
    t.mock.ttls.set(blobKey('timed'), 30);
    t.plantDead('untimed', 40);
    t.mock.data.set(blobKey('untimed'), JSON.stringify(makeExec('untimed', 40)));
    const before = Date.now();
    await t.s1.saveExecution(makeExec('n1', 10_000));
    const after = Date.now();
    // Timed: re-scored to now + PTTL. Untimed: out of the expiry set only.
    expect(t.score(EXPIRY, 'timed')).toBeGreaterThanOrEqual(before + 30_000);
    expect(t.score(EXPIRY, 'timed')).toBeLessThanOrEqual(after + 30_000);
    expect(t.zmembers(EXPIRY)).not.toContain('untimed');
    for (const id of ['timed', 'untimed']) {
      expect(t.members(IDS)).toContain(id);
      expect(t.zmembers(TIME)).toContain(id);
    }
    expect(await listed(t.s1)).toEqual(['n1', 'timed', 'untimed']);
    t.expectConsistent();
  });

  it('never adds a listing entry: a live record missing from the listing stays out of it', async () => {
    const t = setup();
    // Only an expiry entry and a live blob: the listing indexes do not hold it.
    t.mock.zsetData.set(EXPIRY, new Map([['ghost', 1]]));
    t.mock.data.set(blobKey('ghost'), JSON.stringify(makeExec('ghost', 5)));
    t.mock.ttls.set(blobKey('ghost'), 30);
    await t.s1.saveExecution(makeExec('n1', 10_000));
    expect(t.members(IDS)).toEqual(['n1']);
    expect(t.zmembers(TIME)).toEqual(['n1']);
    expect(t.score(EXPIRY, 'ghost')).toBeGreaterThan(Date.now());
  });

  it('P2-13 eval history is pruned the same way', async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) t.plantDead(`ev-${i}`, i, 'axl:eval-history-exp', 'eval');
    await t.s1.saveEvalResult({ id: 'live', eval: 'e', timestamp: 100, data: {} });
    expect(t.members('axl:eval-history-ids')).toEqual(['live']);
    expect(t.zmembers('axl:eval-history-z')).toEqual(['live']);
    expect(t.zmembers('axl:eval-history-exp')).toEqual(['live']);
  });

  it('P2-16 one prune is one bounded read of the expiry set and one script run', async () => {
    const t = setup();
    for (let i = 0; i < 2 * PRUNE_BATCH; i++) t.plantDead(`dead-${i}`);
    t.mock.mockClient.zRange.mockClear();
    t.mock.mockClient.mGet.mockClear();
    t.mock.mockClient.eval.mockClear();
    t.mock.mockClient.multi.mockClear();
    await t.s1.saveExecution(makeExec('n1', 10_000));
    const expiryReads = t.mock.mockClient.zRange.mock.calls.filter(([key]) => key === EXPIRY);
    expect(expiryReads).toHaveLength(1);
    expect(expiryReads[0][3]).toMatchObject({ LIMIT: { offset: 0, count: PRUNE_BATCH } });
    expect(t.mock.mockClient.eval).toHaveBeenCalledTimes(1);
    const [, { keys, arguments: args }] = t.mock.mockClient.eval.mock.calls[0];
    expect(args).toHaveLength(1 + PRUNE_BATCH);
    // The three index keys, then one blob key per id, in the same order.
    expect(keys).toEqual([IDS, TIME, EXPIRY, ...args.slice(1).map(blobKey)]);
    expect(t.mock.mockClient.mGet).not.toHaveBeenCalled();
    // The save's own MULTI is the only one.
    expect(t.mock.mockClient.multi).toHaveBeenCalledTimes(1);
  });

  it('a save skips its prune while another prune of the same kind is running in this process', async () => {
    const t = setup();
    t.plantDead('dead');
    const paused = t.gate.pauseAt('zrange-expiry');
    const first = t.s1.saveExecution(makeExec('a', 1));
    await paused;
    await t.s1.saveExecution(makeExec('b', 2));
    expect(t.gate.steps.filter((s) => s === 'zrange-expiry')).toHaveLength(1);
    t.gate.release('zrange-expiry');
    await first;
    expect(t.members(IDS)).toEqual(['a', 'b']);
  });

  it('a prune failure does not fail the save; it warns once and the next save retries', async () => {
    const t = setup();
    t.plantDead('dead');
    t.gate.failAt('zrange-expiry');
    await expect(t.s1.saveExecution(makeExec('a', 1))).resolves.toBeUndefined();
    expect(await listed(t.s1)).toEqual(['a']);
    expect(t.members(IDS)).toContain('dead');
    t.gate.failAt('zrange-expiry');
    await t.s1.saveExecution(makeExec('b', 2));
    const warnings = warnSpy.mock.calls.filter(([m]) => String(m).includes('index entries'));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toContain('ECONNRESET');

    await t.s1.saveExecution(makeExec('c', 3));
    expect(t.members(IDS)).not.toContain('dead');
    t.expectConsistent();
  });

  it('a server that denies EVAL (ACL) never fails a save; it warns once per kind', async () => {
    const t = setup();
    t.plantDead('dead');
    t.plantDead('ev-dead', 1, 'axl:eval-history-exp', 'eval');
    const noperm = () => new Error("NOPERM User axl has no permissions to run the 'eval' command");
    for (const id of ['a', 'b', 'c']) {
      t.gate.failAt('eval-prune', noperm());
      await expect(t.s1.saveExecution(makeExec(id, 1))).resolves.toBeUndefined();
    }
    t.gate.failAt('eval-prune', noperm());
    await expect(
      t.s1.saveEvalResult({ id: 'v', eval: 'e', timestamp: 1, data: {} }),
    ).resolves.toBeUndefined();

    expect(await listed(t.s1)).toEqual(['c', 'b', 'a']);
    const warnings = warnSpy.mock.calls
      .map(([m]) => String(m))
      .filter((m) => m.includes('index entries'));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('execution-history');
    expect(warnings[1]).toContain('eval-history');
    for (const w of warnings) {
      expect(w).toContain('NOPERM');
      expect(w).toContain('EVAL');
    }
    // Nothing was cleaned up, and nothing else changed.
    expect(t.members(IDS)).toContain('dead');
  });

  it('P2-11 concurrent pruners on two instances converge', async () => {
    const t = setup();
    for (let i = 0; i < 2 * PRUNE_BATCH; i++) t.plantDead(`dead-${i}`);
    await Promise.all([t.s1.saveExecution(makeExec('a', 1)), t.s2.saveExecution(makeExec('b', 2))]);
    await Promise.all([t.s1.saveExecution(makeExec('c', 3)), t.s2.saveExecution(makeExec('d', 4))]);
    expect(t.members(IDS)).toEqual(['a', 'b', 'c', 'd']);
    expect(t.zmembers(EXPIRY)).toEqual(['a', 'b', 'c', 'd']);
    t.expectConsistent();
  });
});

describe('RedisStore prune interleavings (AC2.3, AC2.4)', () => {
  /** S1 saves `y`; its prune pauses at the script with `x` among its candidates. */
  async function pruneThatPausesAtScript(t: ReturnType<typeof setup>) {
    t.plantDead('x', 7);
    const paused = t.gate.pauseAt('eval-prune');
    const save = t.s1.saveExecution(makeExec('y', 10_000));
    await paused;
    return { save };
  }

  it('P2-05 / P2-09 a re-save between the read and the script stays listed (E5)', async () => {
    const t = setup();
    const { save } = await pruneThatPausesAtScript(t);
    const beforeResave = Date.now();
    await t.s2.saveExecution(makeExec('x', 123));
    t.gate.release('eval-prune');
    await save;
    const after = Date.now();

    expect(await listed(t.s1)).toEqual(['y', 'x']);
    expect(t.members(IDS)).toContain('x');
    expect(t.score(TIME, 'x')).toBe(123);
    const expiry = t.score(EXPIRY, 'x')!;
    expect(expiry).toBeGreaterThanOrEqual(beforeResave + 60_000 - 1000);
    expect(expiry).toBeLessThanOrEqual(after + 60_000);
    t.expectConsistent();
  });

  it('P2-08 an untimed re-save between the read and the script stays listed, out of the expiry set', async () => {
    const t = setup({ s2: { executionHistory: null } });
    const { save } = await pruneThatPausesAtScript(t);
    await t.s2.saveExecution(makeExec('x', 123));
    t.gate.release('eval-prune');
    await save;

    expect(t.members(IDS)).toContain('x');
    expect(t.score(TIME, 'x')).toBe(123);
    expect(t.zmembers(EXPIRY)).not.toContain('x');
    await t.s1.saveExecution(makeExec('z', 20_000));
    expect(await listed(t.s1)).toEqual(['z', 'y', 'x']);
    t.expectConsistent();
  });

  it('P2-06 a delete between the read and the script leaves nothing indexed', async () => {
    const t = setup();
    // x is live (re-saved) when the prune reads it, deleted before the script.
    const { save } = await pruneThatPausesAtScript(t);
    await t.s2.saveExecution(makeExec('x', 123));
    expect(await t.s2.deleteExecution('x')).toBe(true);
    t.gate.release('eval-prune');
    await save;

    expect(t.mock.data.has(blobKey('x'))).toBe(false);
    expect(t.members(IDS)).not.toContain('x');
    for (const key of [TIME, EXPIRY]) expect(t.zmembers(key)).not.toContain('x');
    expect(await listed(t.s1)).toEqual(['y']);
    t.expectConsistent();
  });

  describe('P2-10 an interrupted prune leaves the indexes consistent and the next one completes (E4)', () => {
    for (const step of ['zrange-expiry', 'eval-prune'] as const) {
      it(`interrupted at ${step}`, async () => {
        const t = setup();
        await t.s1.saveExecution(makeExec('live', 500));
        for (let i = 0; i < 3; i++) t.plantDead(`dead-${i}`);
        t.gate.failAt(step);
        await expect(t.s1.saveExecution(makeExec('y', 10_000))).resolves.toBeUndefined();
        expect(t.gate.steps.at(-1)).toBe(step);
        t.expectConsistent();
        expect(await listed(t.s1)).toEqual(['y', 'live']);

        await t.s1.saveExecution(makeExec('z', 20_000));
        expect(t.members(IDS)).toEqual(['live', 'y', 'z']);
        expect(t.zmembers(EXPIRY)).toEqual(['live', 'y', 'z']);
        expect(await listed(t.s1)).toEqual(['z', 'y', 'live']);
        t.expectConsistent();
      });
    }
  });
});

describe('RedisStore listing walk over a large tie group (m1)', () => {
  const G = 300; // several times any read window used below

  function seedTieGroup() {
    const { store, mockClient, data } = createRedisStoreWithMockClient();
    return { store, mockClient, data };
  }

  /** Members transferred by every ZRANGE WITHSCORES call so far. */
  async function transferred(mockClient: ReturnType<typeof seedTieGroup>['mockClient']) {
    let total = 0;
    for (const r of mockClient.zRangeWithScores.mock.results) {
      total += ((await r.value) as unknown[]).length;
    }
    return total;
  }

  it('reads each member of a long dead tie group about once in one call', async () => {
    const { store, mockClient, data } = seedTieGroup();
    // G dead runs share one startedAt and sort ahead of three live ones.
    for (let i = 0; i < G; i++) {
      const id = `z-${String(i).padStart(4, '0')}`;
      await store.saveExecution(makeExec(id, 1000));
      data.delete(blobKey(id));
    }
    for (const id of ['a-1', 'a-2', 'a-3']) await store.saveExecution(makeExec(id, 1000));
    mockClient.zRangeWithScores.mockClear();
    expect((await store.listExecutions(2)).map((e) => e.executionId)).toEqual(['a-3', 'a-2']);
    // Re-reading the window from the start of the score every time would
    // transfer on the order of G² / window members.
    expect(await transferred(mockClient)).toBeLessThanOrEqual(2 * G);
  });

  it('a walk whose anchor moved (entries removed mid-call) re-reads and skips nothing', async () => {
    const { store, mockClient, data, zsetData, setData } = createRedisStoreWithMockClient();
    // Exactly one read window (limit 3 reads 11) of dead entries ahead of the live ones.
    for (let i = 0; i < 11; i++) {
      const id = `z-${String(i).padStart(4, '0')}`;
      await store.saveExecution(makeExec(id, 1000));
      data.delete(blobKey(id));
    }
    for (const id of ['a-1', 'a-2', 'a-3']) await store.saveExecution(makeExec(id, 1000));
    // After the first read, another instance's prune removes the dead
    // entries already read: an offset-only walk would now skip live ones.
    const real = mockClient.zRangeWithScores.getMockImplementation()!;
    let calls = 0;
    mockClient.zRangeWithScores.mockImplementation(async (...args) => {
      const result = await real(...args);
      if (++calls === 1) {
        for (const m of result) {
          zsetData.get(TIME)!.delete(m.value);
          setData.get(IDS)!.delete(m.value);
        }
      }
      return result;
    });
    expect((await store.listExecutions(3)).map((e) => e.executionId)).toEqual([
      'a-3',
      'a-2',
      'a-1',
    ]);
  });

  it('pages through a tie group several times the window, each run once', async () => {
    const { store, mockClient } = seedTieGroup();
    const ids = Array.from({ length: G }, (_, i) => `t-${String(i).padStart(4, '0')}`);
    for (const id of ids) await store.saveExecution(makeExec(id, 1000));
    await store.saveExecution(makeExec('older', 999));
    mockClient.zRangeWithScores.mockClear();

    const seen: string[] = [];
    let cursor: { startedAt: number; executionId: string } | undefined;
    for (let guard = 0; guard < 1000; guard++) {
      const page = await store.listExecutions(25, cursor ? { cursor } : undefined);
      if (page.length === 0) break;
      seen.push(...page.map((e) => e.executionId));
      const last = page[page.length - 1];
      cursor = { startedAt: last.startedAt, executionId: last.executionId };
    }
    expect(seen).toEqual([...ids.reverse(), 'older']);
  });
});

describe('RedisStore listing slow path with a cursor', () => {
  it('orders and applies the cursor in process while the sorted set is behind', async () => {
    const { store, data, setData } = createRedisStoreWithMockClient();
    const ids = ['t-c', 'lo', 't-a', 'hi', 't-b'];
    setData.set(IDS, new Set(ids));
    for (const id of ids) {
      const startedAt = id === 'hi' ? 2000 : id === 'lo' ? 500 : 1000;
      data.set(blobKey(id), JSON.stringify(makeExec(id, startedAt)));
    }
    expect((await store.listExecutions()).map((e) => e.executionId)).toEqual([
      'hi',
      't-c',
      't-b',
      't-a',
      'lo',
    ]);
    const page = await store.listExecutions(2, {
      cursor: { startedAt: 1000, executionId: 't-c' },
    });
    expect(page.map((e) => e.executionId)).toEqual(['t-b', 't-a']);
  });
});
