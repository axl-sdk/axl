/**
 * Runtime execution history: read-through listing, tie-safe paging, the
 * in-flight-save and recent-runs structures, and per-id crash recovery
 * (execution-history-retention plan §4.3; test matrix P3-01..P3-23,
 * AC3.1–AC3.5, AC3.7, E1, E8, E11, E12).
 *
 * Paging is exercised against every way a store can list: the built-in
 * stores, a store that declares `historyPaging` and honors the cursor, and a
 * store that ignores the cursor without declaring it (the fallback path).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { AxlError } from '../errors.js';
import { MemoryStore } from '../state/memory.js';
import { SQLiteStore } from '../state/sqlite.js';
import { compareExecutionsNewestFirst } from '../state/retention.js';
import type { ExecutionCursor, StateStore } from '../state/types.js';
import type { AxlEvent, HistoricalExecutionInfo } from '../types.js';
import { createRedisStoreWithMockClient } from './redis-mock-client.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeExec(
  id: string,
  startedAt: number,
  overrides?: Partial<HistoricalExecutionInfo>,
): HistoricalExecutionInfo {
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
    ...overrides,
  } as HistoricalExecutionInfo;
}

/**
 * Fixture T: one run before and one after a group of seven runs that all
 * started in the same millisecond. Pages of three cut the tie group twice.
 */
const TIE_FIXTURE = [
  makeExec('hi', 2_500),
  ...['t-a', 't-b', 't-c', 't-d', 't-e', 't-f', 't-g'].map((id) => makeExec(id, 2_000)),
  makeExec('lo', 1_000),
];
const TIE_PAGES = [
  ['hi', 't-g', 't-f'],
  ['t-e', 't-d', 't-c'],
  ['t-b', 't-a', 'lo'],
];

type Internals = {
  executions: Map<string, unknown>;
  pendingSaves: Map<string, { snapshot: HistoricalExecutionInfo; settled: Promise<void> }>;
  recentRuns: { size: number } | undefined;
};

function internals(runtime: AxlRuntime): Internals {
  return runtime as unknown as Internals;
}

async function settleSaves(runtime: AxlRuntime): Promise<void> {
  await Promise.all([...internals(runtime).pendingSaves.values()].map((p) => p.settled));
}

function ids(execs: HistoricalExecutionInfo[]): string[] {
  return execs.map((e) => e.executionId);
}

function cursorAfter(page: HistoricalExecutionInfo[]): ExecutionCursor {
  const last = page[page.length - 1];
  return { startedAt: last.startedAt, executionId: last.executionId };
}

/** Collect every page of `limit` until an empty page; fails on a runaway loop. */
async function collectPages(runtime: AxlRuntime, limit: number): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: ExecutionCursor | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await runtime.getExecutions({ limit, ...(cursor ? { cursor } : {}) });
    pages.push(ids(page));
    if (page.length === 0) return pages;
    cursor = cursorAfter(page);
  }
  throw new Error('paging did not terminate');
}

function registerQuickWorkflow(runtime: AxlRuntime): void {
  runtime.register(
    workflow({ name: 'wf', input: z.object({}).strict(), handler: async () => 'done' }),
  );
}

/** Run `wf` once and return its execution id. */
async function runOnce(runtime: AxlRuntime): Promise<string> {
  let executionId: string | undefined;
  const listener = (event: AxlEvent) => {
    executionId ??= event.executionId;
  };
  runtime.on('trace', listener);
  try {
    await runtime.execute('wf', {});
  } finally {
    runtime.off('trace', listener);
  }
  return executionId!;
}

// ── Test stores ──────────────────────────────────────────────────────────

/** The non-history StateStore surface, delegated to a MemoryStore. */
function baseStore(inner: MemoryStore): StateStore {
  return {
    saveCheckpoint: (id, name, data) => inner.saveCheckpoint(id, name, data),
    getCheckpoint: (id, name) => inner.getCheckpoint(id, name),
    deleteCheckpoints: (id) => inner.deleteCheckpoints(id),
    saveSession: (id, history) => inner.saveSession(id, history),
    getSession: (id) => inner.getSession(id),
    deleteSession: (id) => inner.deleteSession(id),
    saveSessionMeta: (id, key, value) => inner.saveSessionMeta(id, key, value),
    getSessionMeta: (id, key) => inner.getSessionMeta(id, key),
    savePendingDecision: (id, decision) => inner.savePendingDecision(id, decision),
    getPendingDecisions: () => inner.getPendingDecisions(),
    resolveDecision: (id, result) => inner.resolveDecision(id, result),
    saveExecutionState: (id, state) => inner.saveExecutionState(id, state),
    getExecutionState: (id) => inner.getExecutionState(id),
    listPendingExecutions: () => inner.listPendingExecutions(),
  };
}

/** Everything `inner` holds, newest first, regardless of what it supports. */
async function allRows(inner: MemoryStore): Promise<HistoricalExecutionInfo[]> {
  return [...(await inner.listExecutions())].sort(compareExecutionsNewestFirst);
}

type ListCall = { limit: number | undefined; cursor: ExecutionCursor | undefined; args: number };

/**
 * A custom store that declares `historyPaging` and honors the cursor.
 * `extra` makes it return that many rows beyond the requested limit.
 */
function makePagingStore(options?: { extra?: number; canFetch?: boolean }) {
  const inner = new MemoryStore();
  const listCalls: ListCall[] = [];
  const store: StateStore = {
    ...baseStore(inner),
    historyPaging: true,
    saveExecution: (e) => inner.saveExecution(e),
    ...(options?.canFetch === false
      ? {}
      : { getExecution: (id: string) => inner.getExecution(id) }),
    deleteExecution: (id) => inner.deleteExecution(id),
    async listExecutions(limit?: number, opts?: { cursor?: ExecutionCursor }) {
      listCalls.push({ limit, cursor: opts?.cursor, args: arguments.length });
      const cursor = opts?.cursor;
      const after = (await allRows(inner)).filter(
        (e) => cursor === undefined || compareExecutionsNewestFirst(e, cursor) > 0,
      );
      return limit === undefined ? after : after.slice(0, limit + (options?.extra ?? 0));
    },
  };
  return { store, inner, listCalls };
}

/** A custom store whose `listExecutions` ignores the cursor and does not say so. */
function makeCursorIgnoringStore(options?: { canFetch?: boolean }) {
  const inner = new MemoryStore();
  const listCalls: ListCall[] = [];
  const store: StateStore = {
    ...baseStore(inner),
    saveExecution: (e) => inner.saveExecution(e),
    ...(options?.canFetch === false
      ? {}
      : { getExecution: (id: string) => inner.getExecution(id) }),
    deleteExecution: (id) => inner.deleteExecution(id),
    async listExecutions(limit?: number, opts?: { cursor?: ExecutionCursor }) {
      listCalls.push({ limit, cursor: opts?.cursor, args: arguments.length });
      const rows = await allRows(inner);
      return limit === undefined ? rows : rows.slice(0, limit);
    },
  };
  return { store, inner, listCalls };
}

/** A custom store that can save (and optionally fetch) but cannot list. */
function makeNonListingStore(options?: { canFetch?: boolean }) {
  const inner = new MemoryStore();
  const store: StateStore = {
    ...baseStore(inner),
    saveExecution: (e) => inner.saveExecution(e),
    deleteExecution: (id) => inner.deleteExecution(id),
    ...(options?.canFetch ? { getExecution: (id: string) => inner.getExecution(id) } : {}),
  };
  return { store, inner };
}

/** A MemoryStore whose execution saves wait until the test releases them. */
class HeldSaveStore extends MemoryStore {
  saveCalls: string[] = [];
  private gates: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  override saveExecution(execution: HistoricalExecutionInfo): Promise<void> {
    this.saveCalls.push(execution.executionId);
    return new Promise<void>((resolve, reject) => this.gates.push({ resolve, reject })).then(() =>
      super.saveExecution(execution),
    );
  }

  get heldSaves(): number {
    return this.gates.length;
  }

  releaseSaves(): void {
    for (const gate of this.gates.splice(0)) gate.resolve();
  }

  failSaves(): void {
    for (const gate of this.gates.splice(0)) gate.reject(new Error('store unavailable'));
  }
}

// ── Built-in store harnesses ─────────────────────────────────────────────

const tmpDirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type ListingHarness = {
  name: string;
  make(): { store: StateStore; seed(e: HistoricalExecutionInfo): Promise<void> };
};

const listingHarnesses: ListingHarness[] = [
  {
    name: 'MemoryStore',
    make() {
      const store = new MemoryStore();
      return { store, seed: (e) => store.saveExecution(e) };
    },
  },
  {
    name: 'SQLiteStore',
    make() {
      const dir = mkdtempSync(join(tmpdir(), 'axl-history-'));
      tmpDirs.push(dir);
      const store = new SQLiteStore(join(dir, 'state.db'));
      closers.push(() => store.close());
      return { store, seed: (e) => store.saveExecution(e) };
    },
  },
  {
    name: 'RedisStore (mock client)',
    make() {
      const { store } = createRedisStoreWithMockClient('axl:');
      return { store, seed: (e) => store.saveExecution(e) };
    },
  },
  {
    name: 'paging custom store (historyPaging: true)',
    make() {
      const { store, inner } = makePagingStore();
      return { store, seed: (e) => inner.saveExecution(e) };
    },
  },
  {
    name: 'cursor-ignoring custom store (fallback)',
    make() {
      const { store, inner } = makeCursorIgnoringStore();
      return { store, seed: (e) => inner.saveExecution(e) };
    },
  },
];

// ═════════════════════════════════════════════════════════════════════════
// Paging (AC3.2, AC3.3, E12)
// ═════════════════════════════════════════════════════════════════════════

describe.each(listingHarnesses)('$name — tie-safe paging through the runtime', (harness) => {
  async function seeded() {
    const { store, seed } = harness.make();
    for (const exec of TIE_FIXTURE) await seed(exec);
    return new AxlRuntime({ state: { store } });
  }

  it('P3-02 visits every run exactly once across a tie group cut by page boundaries', async () => {
    const runtime = await seeded();
    expect(await collectPages(runtime, 3)).toEqual([...TIE_PAGES, []]);
  });

  it('P3-01 lists everything, newest first, with no options', async () => {
    const runtime = await seeded();
    expect(ids(await runtime.getExecutions())).toEqual(TIE_PAGES.flat());
  });

  it('P3-03 a run saved between pages does not shift the next page', async () => {
    const { store, seed } = harness.make();
    for (const exec of TIE_FIXTURE) await seed(exec);
    const runtime = new AxlRuntime({ state: { store } });
    const first = await runtime.getExecutions({ limit: 3 });
    await seed(makeExec('new', 3_000));
    const second = await runtime.getExecutions({ limit: 3, cursor: cursorAfter(first) });
    expect(ids(second)).toEqual(TIE_PAGES[1]);
  });

  it('P3-04 deleting the cursor item between pages does not shift the next page', async () => {
    const runtime = await seeded();
    const first = await runtime.getExecutions({ limit: 3 });
    expect(await runtime.deleteExecution('t-f')).toBe(true);
    const second = await runtime.getExecutions({ limit: 3, cursor: cursorAfter(first) });
    expect(ids(second)).toEqual(TIE_PAGES[1]);
  });

  it('P3-22 a cursor without a limit returns everything after it', async () => {
    const runtime = await seeded();
    const [, , third] = await runtime.getExecutions({ limit: 3 });
    // The previous page's last item itself is accepted as the cursor.
    expect(ids(await runtime.getExecutions({ cursor: third }))).toEqual(TIE_PAGES.flat().slice(3));
  });
});

describe('expiry between pages (E3)', () => {
  it('P3-05 a record that expires after page 1 is skipped and the cursor still advances', async () => {
    let now = 1_000_000;
    const store = new MemoryStore({ ttls: { executionHistory: 60 }, now: () => now });
    // t-e is saved 30 s before the rest, so it alone expires at +61 s.
    await store.saveExecution(TIE_FIXTURE.find((e) => e.executionId === 't-e')!);
    now += 30_000;
    for (const exec of TIE_FIXTURE) {
      if (exec.executionId !== 't-e') await store.saveExecution(exec);
    }
    const runtime = new AxlRuntime({ state: { store } });

    const first = await runtime.getExecutions({ limit: 3 });
    expect(ids(first)).toEqual(TIE_PAGES[0]);
    now = 1_000_000 + 61_000;

    const second = await runtime.getExecutions({ limit: 3, cursor: cursorAfter(first) });
    expect(ids(second)).toEqual(['t-d', 't-c', 't-b']);
    expect(second.every((e) => e && typeof e.executionId === 'string')).toBe(true);
    const third = await runtime.getExecutions({ limit: 3, cursor: cursorAfter(second) });
    expect(ids(third)).toEqual(['t-a', 'lo']);
    expect(await runtime.getExecutions({ limit: 3, cursor: cursorAfter(third) })).toEqual([]);
  });
});

describe('store paging capability', () => {
  it('P3-07 hands a declaring store the cursor and a bounded limit', async () => {
    const { store, inner, listCalls } = makePagingStore();
    for (const exec of TIE_FIXTURE) await inner.saveExecution(exec);
    const runtime = new AxlRuntime({ state: { store } });

    const first = await runtime.getExecutions({ limit: 3 });
    const cursor = cursorAfter(first);
    await runtime.getExecutions({ limit: 3, cursor });

    expect(listCalls).toHaveLength(2);
    for (const call of listCalls) {
      expect(call.limit).toBeGreaterThanOrEqual(3);
      expect(call.limit).toBeLessThan(TIE_FIXTURE.length);
    }
    expect(listCalls[1].cursor).toEqual(cursor);
  });

  it('P3-06 never hands the cursor to a store that did not declare paging (AC3.3)', async () => {
    const { store, inner, listCalls } = makeCursorIgnoringStore();
    for (const exec of TIE_FIXTURE) await inner.saveExecution(exec);
    const runtime = new AxlRuntime({ state: { store } });

    expect(await collectPages(runtime, 3)).toEqual([...TIE_PAGES, []]);
    expect(listCalls.length).toBeGreaterThan(0);
    for (const call of listCalls) {
      expect(call).toEqual({ limit: undefined, cursor: undefined, args: 0 });
    }
  });

  it('P3-23 truncates a store that returns more than asked, and the next cursor still lines up', async () => {
    const { store, inner } = makePagingStore({ extra: 2 });
    for (const exec of TIE_FIXTURE) await inner.saveExecution(exec);
    const runtime = new AxlRuntime({ state: { store } });

    expect(await collectPages(runtime, 3)).toEqual([...TIE_PAGES, []]);
  });

  it('P3-20 normalizes legacy v1 rows on the paged path', async () => {
    const { store, inner } = makePagingStore();
    const legacy = {
      executionId: 'legacy',
      workflow: 'wf',
      status: 'completed',
      events: [{ executionId: 'legacy', step: 0, type: 'log', timestamp: 1, data: {} }],
      totalCost: 0,
      startedAt: 1_500,
      completedAt: 1_500,
      duration: 0,
    } as unknown as HistoricalExecutionInfo;
    await inner.saveExecution(legacy);
    await inner.saveExecution(makeExec('newer', 2_000));
    const runtime = new AxlRuntime({ state: { store } });

    const page = await runtime.getExecutions({
      limit: 1,
      cursor: cursorAfter([makeExec('newer', 2_000)]),
    });
    expect(ids(page)).toEqual(['legacy']);
    expect(page[0].eventSchemaVersion).toBe(1);
  });
});

describe('getExecutions() option validation (MQ7)', () => {
  const runtime = new AxlRuntime();

  it.each([0, -1, 1.5, Number.NaN, '3', null])('P3-21 rejects limit %s', async (limit) => {
    await expect(
      runtime.getExecutions({ limit } as unknown as { limit: number }),
    ).rejects.toMatchObject({ name: 'AxlError', code: 'INVALID_ARGUMENT' });
  });

  it.each([
    null,
    'cursor',
    { executionId: 'x' },
    { startedAt: '1', executionId: 'x' },
    { startedAt: Number.NaN, executionId: 'x' },
    { startedAt: 1, executionId: 7 },
  ])('rejects malformed cursor %j', async (cursor) => {
    await expect(
      runtime.getExecutions({ cursor } as unknown as { cursor: ExecutionCursor }),
    ).rejects.toBeInstanceOf(AxlError);
  });

  it('rejects non-object options', async () => {
    await expect(runtime.getExecutions(5 as unknown as { limit: number })).rejects.toBeInstanceOf(
      AxlError,
    );
  });

  it('treats limit: Infinity as no limit', async () => {
    const store = new MemoryStore();
    for (const exec of TIE_FIXTURE) await store.saveExecution(exec);
    const withStore = new AxlRuntime({ state: { store } });
    expect(ids(await withStore.getExecutions({ limit: Infinity }))).toEqual(TIE_PAGES.flat());
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Merging in-process runs with the store page
// ═════════════════════════════════════════════════════════════════════════

describe('merging running runs and in-flight saves with the store page', () => {
  it('P3-08 interleaves an active run and a pending save at page boundaries, live data winning', async () => {
    const store = new HeldSaveStore();
    const runtime = new AxlRuntime({ state: { store } });
    registerQuickWorkflow(runtime);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.register(
      workflow({ name: 'held', input: z.object({}).strict(), handler: async () => gate }),
    );

    // P: finished, save held. A: still running.
    const pendingId = await runOnce(runtime);
    const pending = (await runtime.getExecution(pendingId))!;
    let activeId: string | undefined;
    const onTrace = (e: AxlEvent) => {
      if (e.executionId !== pendingId) activeId ??= e.executionId;
    };
    runtime.on('trace', onTrace);
    const running = runtime.execute('held', {});
    await vi.waitFor(() => expect(activeId).toBeDefined());
    const active = (await runtime.getExecution(activeId!))!;
    expect(active.status).toBe('running');

    // Store rows newer than both, older than both, and stale copies of both.
    // `store.saveExecution` is held, so seed through MemoryStore's own save.
    const seed = (e: HistoricalExecutionInfo) => MemoryStore.prototype.saveExecution.call(store, e);
    const top = Math.max(active.startedAt, pending.startedAt);
    const bottom = Math.min(active.startedAt, pending.startedAt);
    await seed(makeExec('x1', top + 2_000));
    await seed(makeExec('x2', top + 1_000));
    await seed(makeExec('y1', bottom - 1_000));
    await seed(makeExec('y2', bottom - 2_000));
    await seed({
      ...pending,
      status: 'failed',
      error: 'stale store copy',
    } as HistoricalExecutionInfo);
    await seed({
      ...active,
      status: 'failed',
      error: 'stale store copy',
    } as HistoricalExecutionInfo);

    const expected = [
      makeExec('x1', top + 2_000),
      makeExec('x2', top + 1_000),
      active,
      pending,
      makeExec('y1', bottom - 1_000),
      makeExec('y2', bottom - 2_000),
    ]
      .sort(compareExecutionsNewestFirst)
      .map((e) => e.executionId);

    const page1 = await runtime.getExecutions({ limit: 2 });
    const page2 = await runtime.getExecutions({ limit: 2, cursor: cursorAfter(page1) });
    // The held save lands between pages.
    store.releaseSaves();
    await settleSaves(runtime);
    const page3 = await runtime.getExecutions({ limit: 2, cursor: cursorAfter(page2) });
    const page4 = await runtime.getExecutions({ limit: 2, cursor: cursorAfter(page3) });

    expect([...ids(page1), ...ids(page2), ...ids(page3)]).toEqual(expected);
    expect(page4).toEqual([]);
    const listed = [...page1, ...page2, ...page3];
    expect(listed.find((e) => e.executionId === activeId)!.status).toBe('running');
    const pendingListed = [...page1, ...page2].find((e) => e.executionId === pendingId);
    if (pendingListed) expect(pendingListed.status).toBe('completed');

    // Once the save landed, the store copy is the real one: listed once.
    const all = await runtime.getExecutions();
    expect(ids(all).filter((id) => id === pendingId)).toHaveLength(1);
    expect(all.find((e) => e.executionId === pendingId)!.status).toBe('completed');
    expect(all.find((e) => e.executionId === activeId)!.status).toBe('running');

    release();
    await running;
    runtime.off('trace', onTrace);
    store.releaseSaves();
    await settleSaves(runtime);
  });

  it('keeps the page full when an in-process run hides an older store copy (over-fetch)', async () => {
    // The store still holds an earlier record for an id whose re-run is in
    // flight with a different start time. That stale row must not take a
    // slot on the page.
    const { store, inner } = makePagingStore();
    const runtime = new AxlRuntime({ state: { store } });

    const runId = 'rerun';
    const pendingSaves = internals(runtime).pendingSaves;
    pendingSaves.set(runId, { snapshot: makeExec(runId, 1_000), settled: new Promise(() => {}) });
    await inner.saveExecution(makeExec(runId, 5_000, { status: 'failed' }));
    await inner.saveExecution(makeExec('y1', 4_000));
    await inner.saveExecution(makeExec('y2', 3_000));
    await inner.saveExecution(makeExec('y3', 2_000));

    expect(ids(await runtime.getExecutions({ limit: 3 }))).toEqual(['y1', 'y2', 'y3']);
    expect(ids(await runtime.getExecutions())).toEqual(['y1', 'y2', 'y3', runId]);
    pendingSaves.delete(runId);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Read-through across instances (AC3.1, E2, FR4)
// ═════════════════════════════════════════════════════════════════════════

describe('by-id reads on a store that lists but cannot fetch (MQ1 revised)', () => {
  it('fetches any listed run, including one finished on another instance', async () => {
    const { store, inner } = makeCursorIgnoringStore({ canFetch: false });
    const a = new AxlRuntime({ state: { store, recentExecutionsCacheSize: 1 } });
    const b = new AxlRuntime({ state: { store, recentExecutionsCacheSize: 1 } });
    registerQuickWorkflow(a);
    const runIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      runIds.push(await runOnce(a));
      await settleSaves(a);
    }

    // No recent-runs cache for a store that saves and lists.
    expect(internals(a).recentRuns).toBeUndefined();
    for (const id of runIds) {
      // Beyond any LRU bound on A, and never seen by B.
      expect((await a.getExecution(id))?.executionId).toBe(id);
      expect((await b.getExecution(id))?.executionId).toBe(id);
    }
    expect(ids(await b.getExecutions()).sort()).toEqual([...runIds].sort());

    // A delete on either instance is seen by the other's next read.
    await inner.deleteExecution(runIds[0]);
    expect(await a.getExecution(runIds[0])).toBeUndefined();
    expect(await b.deleteExecution(runIds[1])).toBe(true);
    expect(await a.getExecution(runIds[1])).toBeUndefined();
  });

  it('scans a paging store page by page with the cursor', async () => {
    const { store, inner, listCalls } = makePagingStore({ canFetch: false });
    for (let i = 0; i < 250; i++) {
      await inner.saveExecution(makeExec(`r-${String(i).padStart(3, '0')}`, 10_000 + i));
    }
    const runtime = new AxlRuntime({ state: { store } });

    // The oldest run is on the third page.
    expect((await runtime.getExecution('r-000'))?.executionId).toBe('r-000');
    expect(listCalls).toHaveLength(3);
    expect(listCalls.map((c) => c.limit)).toEqual([100, 100, 100]);
    expect(listCalls[0].cursor).toBeUndefined();
    expect(listCalls[1].cursor).toEqual({ startedAt: 10_150, executionId: 'r-150' });
    expect(listCalls[2].cursor).toEqual({ startedAt: 10_050, executionId: 'r-050' });

    // A newer run stops at the first page; an unknown id ends at an empty page.
    listCalls.length = 0;
    expect((await runtime.getExecution('r-249'))?.executionId).toBe('r-249');
    expect(listCalls).toHaveLength(1);
    listCalls.length = 0;
    expect(await runtime.getExecution('missing')).toBeUndefined();
    expect(listCalls).toHaveLength(4);
  });

  it('normalizes a legacy row found by the scan', async () => {
    const { store, inner } = makeCursorIgnoringStore({ canFetch: false });
    await inner.saveExecution({
      executionId: 'legacy',
      workflow: 'wf',
      status: 'completed',
      events: [{ executionId: 'legacy', step: 0, type: 'log', timestamp: 1, data: {} }],
      totalCost: 0,
      startedAt: 1,
      completedAt: 1,
      duration: 0,
    } as unknown as HistoricalExecutionInfo);
    const runtime = new AxlRuntime({ state: { store } });
    expect((await runtime.getExecution('legacy'))?.eventSchemaVersion).toBe(1);
  });
});

describe('runtimes sharing one store (AC3.1)', () => {
  it('P3-13 lists runs finished on the other instance and drops runs deleted on either', async () => {
    const store = new MemoryStore();
    const a = new AxlRuntime({ state: { store } });
    const b = new AxlRuntime({ state: { store } });
    registerQuickWorkflow(a);
    registerQuickWorkflow(b);

    // B lists first, so any list-once caching would freeze its view here.
    expect(await b.getExecutions()).toEqual([]);

    const fromA = await runOnce(a);
    await settleSaves(a);
    expect(ids(await b.getExecutions())).toEqual([fromA]);
    expect((await b.getExecution(fromA))?.status).toBe('completed');

    expect(await b.deleteExecution(fromA)).toBe(true);
    expect(await a.getExecutions()).toEqual([]);
    expect(await a.getExecution(fromA)).toBeUndefined();

    const fromB = await runOnce(b);
    await settleSaves(b);
    expect(ids(await a.getExecutions())).toEqual([fromB]);
    expect(await a.deleteExecution(fromB)).toBe(true);
    expect(await b.getExecutions()).toEqual([]);
    expect(await b.getExecution(fromB)).toBeUndefined();
  });

  it('P3-14 stops returning a run once it expires in the store, without a restart', async () => {
    let now = 1_000_000;
    const store = new MemoryStore({ ttls: { executionHistory: 60 }, now: () => now });
    const runtime = new AxlRuntime({ state: { store } });
    registerQuickWorkflow(runtime);
    const id = await runOnce(runtime);
    await settleSaves(runtime);
    expect(ids(await runtime.getExecutions())).toEqual([id]);

    now += 61_000;
    expect(await runtime.getExecution(id)).toBeUndefined();
    expect(await runtime.getExecutions()).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Bounded in-process structures (AC3.4, AC3.5, E1, E6, FR9)
// ═════════════════════════════════════════════════════════════════════════

describe('what the runtime holds in process', () => {
  it('P3-11 after 10 000 runs on a listing store, holds only running runs and in-flight saves (AC3.4)', async () => {
    const runtime = new AxlRuntime({ state: { store: new MemoryStore() } });
    registerQuickWorkflow(runtime);
    for (let i = 0; i < 10_000; i++) await runtime.execute('wf', {});
    await settleSaves(runtime);

    const inner = internals(runtime);
    expect(inner.executions.size).toBe(0);
    expect(inner.pendingSaves.size).toBe(0);
    expect(inner.recentRuns).toBeUndefined();
    expect('historicalExecutions' in runtime).toBe(false);
    // No collection on the runtime grows with history.
    for (const [key, value] of Object.entries(runtime)) {
      if (key === 'stateStore') continue;
      const size =
        value instanceof Map || value instanceof Set
          ? value.size
          : Array.isArray(value)
            ? value.length
            : 0;
      expect(size, `runtime.${key}`).toBeLessThan(100);
    }
    expect((await runtime.getExecutions({ limit: 5 })).length).toBe(5);
    expect((await runtime.getExecutions()).length).toBe(10_000);
  }, 60_000);

  it('P3-09 a run is readable while its save is held, with the cache off (E1, AC3.5)', async () => {
    const store = new HeldSaveStore();
    const runtime = new AxlRuntime({ state: { store, recentExecutionsCacheSize: 0 } });
    registerQuickWorkflow(runtime);
    const id = await runOnce(runtime);
    expect(store.heldSaves).toBe(1);

    expect((await runtime.getExecution(id))?.status).toBe('completed');
    expect(ids(await runtime.getExecutions())).toEqual([id]);
    expect(internals(runtime).pendingSaves.size).toBe(1);

    store.releaseSaves();
    await settleSaves(runtime);
    expect(internals(runtime).pendingSaves.size).toBe(0);
    expect(internals(runtime).recentRuns).toBeUndefined();
    expect((await runtime.getExecution(id))?.status).toBe('completed');
    expect(ids(await runtime.getExecutions())).toEqual([id]);
  });

  it('P3-10 a failed save leaves the in-flight map and the run is as visible as the store makes it (MQ6)', async () => {
    const store = new HeldSaveStore();
    const runtime = new AxlRuntime({ state: { store } });
    registerQuickWorkflow(runtime);
    const id = await runOnce(runtime);

    store.failSaves();
    await settleSaves(runtime);
    expect(internals(runtime).pendingSaves.size).toBe(0);
    expect(await runtime.getExecution(id)).toBeUndefined();
    expect(await runtime.getExecutions()).toEqual([]);
  });

  it('P3-12 a store that cannot list or fetch is served by a bounded recent-runs cache (E6)', async () => {
    const { store } = makeNonListingStore();
    const runtime = new AxlRuntime({ state: { store, recentExecutionsCacheSize: 3 } });
    registerQuickWorkflow(runtime);
    const runIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      runIds.push(await runOnce(runtime));
      await settleSaves(runtime);
      expect(internals(runtime).recentRuns!.size).toBeLessThanOrEqual(3);
    }

    expect(ids(await runtime.getExecutions()).sort()).toEqual(runIds.slice(2).sort());
    expect(await runtime.getExecution(runIds[0])).toBeUndefined();
    expect((await runtime.getExecution(runIds[4]))?.executionId).toBe(runIds[4]);
    expect(internals(runtime).recentRuns!.size).toBe(3);
  });

  it('P3-12 a store that can fetch but not list uses the cache only for listing (MQ1)', async () => {
    const { store, inner } = makeNonListingStore({ canFetch: true });
    const runtime = new AxlRuntime({ state: { store, recentExecutionsCacheSize: 2 } });
    registerQuickWorkflow(runtime);
    const runIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      runIds.push(await runOnce(runtime));
      await settleSaves(runtime);
    }

    expect(ids(await runtime.getExecutions()).sort()).toEqual(runIds.slice(1).sort());
    // By-id reads go to the store, which still has the evicted run.
    expect((await runtime.getExecution(runIds[0]))?.executionId).toBe(runIds[0]);
    // A delete made directly in the store is seen by the next read.
    await inner.deleteExecution(runIds[2]);
    expect(await runtime.getExecution(runIds[2])).toBeUndefined();
  });

  it('P3-12 with the cache off, a non-listing store shows a run only while its save is in flight', async () => {
    const inner = new HeldSaveStore();
    const store: StateStore = {
      ...baseStore(inner),
      saveExecution: (e) => inner.saveExecution(e),
    };
    const runtime = new AxlRuntime({ state: { store, recentExecutionsCacheSize: 0 } });
    registerQuickWorkflow(runtime);
    const id = await runOnce(runtime);

    expect((await runtime.getExecution(id))?.executionId).toBe(id);
    expect(ids(await runtime.getExecutions())).toEqual([id]);
    inner.releaseSaves();
    await settleSaves(runtime);
    expect(internals(runtime).recentRuns).toBeUndefined();
    expect(await runtime.getExecution(id)).toBeUndefined();
    expect(await runtime.getExecutions()).toEqual([]);
  });

  it('P3-17 deleting a run evicts it from the recent-runs cache', async () => {
    const { store } = makeNonListingStore();
    const runtime = new AxlRuntime({ state: { store } });
    registerQuickWorkflow(runtime);
    const id = await runOnce(runtime);
    await settleSaves(runtime);
    expect(internals(runtime).recentRuns!.size).toBe(1);

    expect(await runtime.deleteExecution(id)).toBe(true);
    expect(internals(runtime).recentRuns!.size).toBe(0);
    expect(await runtime.getExecution(id)).toBeUndefined();
    expect(await runtime.getExecutions()).toEqual([]);
  });

  it.each([-1, 1.5, Number.NaN, Infinity, '3'])(
    'rejects state.recentExecutionsCacheSize %s',
    (size) => {
      expect(
        () =>
          new AxlRuntime({
            state: { recentExecutionsCacheSize: size as unknown as number },
          }),
      ).toThrow(expect.objectContaining({ name: 'AxlError', code: 'INVALID_CONFIG' }));
    },
  );
});

// ═════════════════════════════════════════════════════════════════════════
// Crash recovery (AC3.7, E8, E11)
// ═════════════════════════════════════════════════════════════════════════

function bufferEvents(id: string, startedAt: number): AxlEvent[] {
  return [
    {
      executionId: id,
      step: 0,
      type: 'workflow_start',
      workflow: 'crashed',
      timestamp: startedAt,
      data: { input: {} },
    } as unknown as AxlEvent,
  ];
}

describe('recoverIncompleteStreams() checks each run against the store', () => {
  it('P3-18 skips a run whose final record exists, without listing history (AC3.7)', async () => {
    const store = new MemoryStore();
    await store.appendStreamingEvents('s1', bufferEvents('s1', 1_000));
    await store.appendStreamingEvents('s2', bufferEvents('s2', 2_000));
    await store.saveExecution(makeExec('s1', 1_000));
    const listSpy = vi.spyOn(store, 'listExecutions');
    const getSpy = vi.spyOn(store, 'getExecution');
    const saveSpy = vi.spyOn(store, 'saveExecution');
    const runtime = new AxlRuntime({ state: { store, persist: 'streaming' } });

    const recovered = await runtime.recoverIncompleteStreams();

    expect(ids(recovered)).toEqual(['s2']);
    expect(listSpy).not.toHaveBeenCalled();
    expect(getSpy.mock.calls.map(([id]) => id).sort()).toEqual(['s1', 's2']);
    expect(saveSpy.mock.calls.map(([e]) => e.executionId)).toEqual(['s2']);
    expect((await store.getExecution('s1'))?.status).toBe('completed');
    expect(await store.listStreamingExecutions()).toEqual([]);

    // P3-19: idempotent.
    expect(await runtime.recoverIncompleteStreams()).toEqual([]);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('a delete issued while recovery is saving that run waits for the save (E11)', async () => {
    const store = new HeldSaveStore();
    await store.appendStreamingEvents('s1', bufferEvents('s1', 1_000));
    const runtime = new AxlRuntime({ state: { store, persist: 'streaming' } });

    const recovery = runtime.recoverIncompleteStreams();
    await vi.waitFor(() => expect(store.heldSaves).toBe(1));
    // Visible while its save is in flight.
    expect(ids(await runtime.getExecutions())).toEqual(['s1']);

    let deleted = false;
    const deletion = runtime.deleteExecution('s1').then((removed) => {
      deleted = true;
      return removed;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleted).toBe(false);

    store.releaseSaves();
    expect(ids(await recovery)).toEqual(['s1']);
    expect(await deletion).toBe(true);
    expect(await store.getExecution('s1')).toBeNull();
    expect(await runtime.getExecution('s1')).toBeUndefined();
  });

  it('a delete issued after recovery read the buffer, before it saved, waits for recovery (E11)', async () => {
    const store = new MemoryStore();
    await store.appendStreamingEvents('s1', bufferEvents('s1', 1_000));
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const realRead = store.getStreamingEvents.bind(store);
    const readSpy = vi.spyOn(store, 'getStreamingEvents').mockImplementation(async (id) => {
      const events = await realRead(id);
      await readGate;
      return events;
    });
    const runtime = new AxlRuntime({ state: { store, persist: 'streaming' } });

    const recovery = runtime.recoverIncompleteStreams();
    await vi.waitFor(() => expect(readSpy).toHaveBeenCalled());
    let deleted = false;
    const deletion = runtime.deleteExecution('s1').then((removed) => {
      deleted = true;
      return removed;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleted).toBe(false);

    releaseRead();
    expect(ids(await recovery)).toEqual(['s1']);
    expect(await deletion).toBe(true);
    expect(await store.getExecution('s1')).toBeNull();
    expect(await runtime.getExecutions()).toEqual([]);
  });

  it('skips a run whose delete is already in progress', async () => {
    const store = new MemoryStore();
    await store.appendStreamingEvents('s1', bufferEvents('s1', 1_000));
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const realDelete = store.deleteExecution.bind(store);
    vi.spyOn(store, 'deleteExecution').mockImplementation(async (id) => {
      await deleteGate;
      return realDelete(id);
    });
    const saveSpy = vi.spyOn(store, 'saveExecution');
    const runtime = new AxlRuntime({ state: { store, persist: 'streaming' } });

    const deletion = runtime.deleteExecution('s1');
    await vi.waitFor(() => expect(store.deleteExecution).toHaveBeenCalled());
    expect(await runtime.recoverIncompleteStreams()).toEqual([]);
    expect(saveSpy).not.toHaveBeenCalled();

    releaseDelete();
    expect(await deletion).toBe(true);
    expect(await store.getExecution('s1')).toBeNull();
    expect(await store.listStreamingExecutions()).toEqual([]);
  });
});
