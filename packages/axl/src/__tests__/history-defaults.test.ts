/**
 * History defaults (execution-history-retention plan P6; test matrix
 * P6-01..P6-08 and the P6-03 warning sub-matrix; AC1.1 default case, AC1.2,
 * AC1.6, AC3.8).
 *
 * - The in-memory store keeps the newest 1 000 runs by default.
 * - No built-in store applies a timed default.
 * - SQLite and Redis warn once per process per store kind while execution
 *   retention is unset.
 * - An unpaged `getExecutions()` returning more than 1 000 runs warns once.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { MemoryStore } from '../state/memory.js';
import { SQLiteStore } from '../state/sqlite.js';
import { warnIfRedisExecutionRetentionUnset, type RedisStoreOptions } from '../state/redis.js';
import type { HistoryTtls, StateStore } from '../state/types.js';
import type { AxlEvent, HistoricalExecutionInfo } from '../types.js';
import { __resetSchemaDiagnosticWarnings, withDiagnosticsSilenced } from '../schema-diagnostics.js';
import { createRedisStoreWithMockClient } from './redis-mock-client.js';

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

/** `run-0000`, `run-0001`, …: ids and start times both ascend, so index 0 is oldest. */
function runId(i: number): string {
  return `run-${String(i).padStart(4, '0')}`;
}

async function seed(store: StateStore, count: number, from = 0): Promise<void> {
  for (let i = from; i < from + count; i++)
    await store.saveExecution!(makeExec(runId(i), 1_000 + i));
}

const RETENTION_WARNING = 'keeps execution history forever';
const LISTING_WARNING = 'without a limit returned';

let warn: ReturnType<typeof vi.spyOn>;
const tmpDirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  __resetSchemaDiagnosticWarnings();
  vi.unstubAllEnvs();
  vi.stubEnv('AXL_DIAGNOSTICS_SILENT', '');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  warn.mockRestore();
  vi.unstubAllEnvs();
  __resetSchemaDiagnosticWarnings();
  for (const close of closers.splice(0)) await close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function warningsContaining(text: string): string[] {
  return warn.mock.calls.map((args) => String(args[0])).filter((m) => m.includes(text));
}

function openSqlite(ttls?: HistoryTtls, now?: () => number): SQLiteStore {
  const dir = mkdtempSync(join(tmpdir(), 'axl-defaults-'));
  tmpDirs.push(dir);
  const store = new SQLiteStore(join(dir, 'state.db'), {
    ...(ttls !== undefined ? { ttls } : {}),
    ...(now ? { now } : {}),
  });
  closers.push(() => store.close());
  return store;
}

// ═════════════════════════════════════════════════════════════════════════
// Memory default bound (AC1.2, FR6)
// ═════════════════════════════════════════════════════════════════════════

describe('MemoryStore keeps the newest 1 000 runs by default (AC1.2)', () => {
  it('P6-01 evicts the oldest run, and its side data, on the 1 001st save', async () => {
    const store = new MemoryStore();
    await store.saveCheckpoint(runId(0), 'step', { x: 1 });
    await store.saveExecutionState(runId(0), {
      workflow: 'wf',
      input: {},
      status: 'failed',
    } as unknown as Parameters<MemoryStore['saveExecutionState']>[1]);
    await seed(store, 1_000);
    expect(await store.listExecutions()).toHaveLength(1_000);

    await seed(store, 1, 1_000);
    const listed = await store.listExecutions();
    expect(listed).toHaveLength(1_000);
    expect(listed[0].executionId).toBe(runId(1_000));
    expect(listed.at(-1)!.executionId).toBe(runId(1));
    expect(await store.getExecution(runId(0))).toBeNull();
    expect(await store.getCheckpoint(runId(0), 'step')).toBeNull();
    expect(await store.getExecutionState(runId(0))).toBeNull();
  });

  it('P6-01 keeps everything with maxExecutions: Infinity', async () => {
    const store = new MemoryStore({ maxExecutions: Infinity });
    await seed(store, 1_001);
    expect(await store.listExecutions()).toHaveLength(1_001);
  });

  it('P6-01 bounds the store the runtime builds, and takes state.memory.maxExecutions', async () => {
    const byDefault = new AxlRuntime().getStateStore();
    await seed(byDefault, 1_001);
    expect(await byDefault.listExecutions!()).toHaveLength(1_000);

    const configured = new AxlRuntime({ state: { memory: { maxExecutions: 5 } } }).getStateStore();
    await seed(configured, 7);
    expect((await configured.listExecutions!()).map((e) => e.executionId)).toEqual(
      [6, 5, 4, 3, 2].map(runId),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════
// No timed default (AC1.1)
// ═════════════════════════════════════════════════════════════════════════

describe('no built-in store expires history by default (AC1.1)', () => {
  const TEN_YEARS_MS = 10 * 365 * 86_400_000;

  it('P6-02 MemoryStore and SQLiteStore keep a run after ten years', async () => {
    let now = 1_000_000;
    const memory = new MemoryStore({ now: () => now });
    const sqlite = openSqlite(undefined, () => now);
    await memory.saveExecution(makeExec('m', 1));
    await sqlite.saveExecution(makeExec('s', 1));
    now += TEN_YEARS_MS;
    expect(await memory.getExecution('m')).not.toBeNull();
    expect(await sqlite.getExecution('s')).not.toBeNull();
  });

  it('P6-02 RedisStore writes the record without a TTL', async () => {
    const { store, ttls } = createRedisStoreWithMockClient('axl:');
    await store.saveExecution(makeExec('r', 1));
    expect(ttls.has('axl:exec-history:r')).toBe(false);
    expect(await store.getExecution('r')).not.toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Retention warning (AC1.6, FR1)
// ═════════════════════════════════════════════════════════════════════════

type WarningCase = {
  name: string;
  sqlite?: HistoryTtls | 'unset';
  redis?: RedisStoreOptions;
  silentEnv?: boolean;
  twice?: boolean;
  expected: number;
};

/** P6-03 sub-matrix. `sqlite`/`redis` say which store kinds to construct. */
const WARNING_MATRIX: WarningCase[] = [
  { name: 'SQLite, ttls unset', sqlite: 'unset', expected: 1 },
  { name: 'SQLite, ttls: {} (no executionHistory key)', sqlite: {}, expected: 1 },
  { name: 'SQLite, executionHistory: null', sqlite: { executionHistory: null }, expected: 0 },
  { name: 'SQLite, executionHistory: 3600', sqlite: { executionHistory: 3600 }, expected: 0 },
  {
    name: 'SQLite, unset + AXL_DIAGNOSTICS_SILENT',
    sqlite: 'unset',
    silentEnv: true,
    expected: 0,
  },
  { name: 'SQLite, unset, two stores', sqlite: 'unset', twice: true, expected: 1 },
  {
    name: 'SQLite, evalHistory only (execution unset) still warns',
    sqlite: { evalHistory: 3600 },
    expected: 1,
  },
  {
    name: 'SQLite, executionHistory set, eval unset',
    sqlite: { executionHistory: 3600 },
    expected: 0,
  },
  { name: 'Redis, ttls unset', redis: {}, expected: 1 },
  {
    name: 'Redis, executionHistory: null',
    redis: { ttls: { executionHistory: null } },
    expected: 0,
  },
  {
    name: 'Redis, executionHistory: 3600',
    redis: { ttls: { executionHistory: 3600 } },
    expected: 0,
  },
  { name: 'Redis, defaultTtl, ttls unset', redis: { defaultTtl: 3600 }, expected: 0 },
  { name: 'Redis, unset + AXL_DIAGNOSTICS_SILENT', redis: {}, silentEnv: true, expected: 0 },
  { name: 'Redis, unset, two stores', redis: {}, twice: true, expected: 1 },
  {
    name: 'Redis, evalHistory only (execution unset) still warns',
    redis: { ttls: { evalHistory: 3600 } },
    expected: 1,
  },
  {
    name: 'Redis, executionHistory set, eval unset',
    redis: { ttls: { executionHistory: 3600 } },
    expected: 0,
  },
  { name: 'one SQLite + one Redis, both unset', sqlite: 'unset', redis: {}, expected: 2 },
];

describe('one-time warning while execution retention is unset (AC1.6)', () => {
  it.each(WARNING_MATRIX)('P6-03 $name → $expected', (c) => {
    if (c.silentEnv) vi.stubEnv('AXL_DIAGNOSTICS_SILENT', 'true');
    const times = c.twice ? 2 : 1;
    for (let i = 0; i < times; i++) {
      if (c.sqlite !== undefined) openSqlite(c.sqlite === 'unset' ? undefined : c.sqlite);
      // RedisStore.create() calls this right after construction; create()
      // itself is covered against a real server in redis-integration.test.ts.
      if (c.redis !== undefined) warnIfRedisExecutionRetentionUnset(c.redis);
    }
    expect(warningsContaining(RETENTION_WARNING)).toHaveLength(c.expected);
  });

  it('P6-03 MemoryStore and custom stores never warn', () => {
    new MemoryStore();
    new AxlRuntime();
    const custom: StateStore = new MemoryStore() as StateStore;
    new AxlRuntime({ state: { store: custom } });
    expect(warningsContaining(RETENTION_WARNING)).toHaveLength(0);
  });

  it('P6-04 warns at construction, before any save, with guidance and the docs link', () => {
    openSqlite();
    const [message] = warningsContaining(RETENTION_WARNING);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(message.startsWith('[axl] SQLiteStore keeps execution history forever')).toBe(true);
    expect(message).toContain('ttls.executionHistory');
    expect(message).toContain('null');
    expect(message).toContain(
      'docs/migration/execution-history-retention.md#silencing-the-retention-warning',
    );
  });

  it('the runtime-built SQLite store warns the same way', () => {
    const dir = mkdtempSync(join(tmpdir(), 'axl-defaults-'));
    tmpDirs.push(dir);
    const runtime = new AxlRuntime({
      state: { store: 'sqlite', sqlite: { path: join(dir, 'state.db') } },
    });
    closers.push(() => runtime.shutdown());
    expect(warningsContaining(RETENTION_WARNING)).toHaveLength(1);
  });

  it('P6-09 diagnostics.silent silences the runtime-built SQLite store, and only for that construction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'axl-defaults-'));
    tmpDirs.push(dir);
    const silenced = new AxlRuntime({
      state: { store: 'sqlite', sqlite: { path: join(dir, 'silent.db') } },
      diagnostics: { silent: true },
    });
    closers.push(() => silenced.shutdown());
    expect(warningsContaining(RETENTION_WARNING)).toHaveLength(0);

    // The scope ends with the construction: a later store still warns.
    const loud = new AxlRuntime({
      state: { store: 'sqlite', sqlite: { path: join(dir, 'loud.db') } },
      diagnostics: { silent: false },
    });
    closers.push(() => loud.shutdown());
    expect(warningsContaining(RETENTION_WARNING)).toHaveLength(1);
  });

  it('withDiagnosticsSilenced restores warnings when its callback throws', () => {
    expect(() =>
      withDiagnosticsSilenced(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    openSqlite();
    expect(warningsContaining(RETENTION_WARNING)).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Large unpaged listing (AC3.8)
// ═════════════════════════════════════════════════════════════════════════

function registerHeldWorkflow(runtime: AxlRuntime): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.register(workflow({ name: 'held', input: z.object({}).strict(), handler: () => gate }));
  return { release };
}

describe('large unpaged listing warning (AC3.8)', () => {
  it('P6-05 1 000 runs is quiet; 1 001 warns once; a limit is always quiet', async () => {
    const store = new MemoryStore({ maxExecutions: Infinity });
    const runtime = new AxlRuntime({ state: { store } });
    await seed(store, 1_000);
    expect(await runtime.getExecutions()).toHaveLength(1_000);
    expect(warningsContaining(LISTING_WARNING)).toHaveLength(0);

    await seed(store, 1, 1_000);
    // A limit stays quiet, however large, including Infinity.
    expect(await runtime.getExecutions({ limit: 5_000 })).toHaveLength(1_001);
    expect(await runtime.getExecutions({ limit: Infinity })).toHaveLength(1_001);
    expect(warningsContaining(LISTING_WARNING)).toHaveLength(0);

    expect(await runtime.getExecutions()).toHaveLength(1_001);
    expect(await runtime.getExecutions()).toHaveLength(1_001);
    const warnings = warningsContaining(LISTING_WARNING);
    expect(warnings).toHaveLength(1);
    // P6-08: the warning says how to page.
    expect(warnings[0]).toMatch(/^\[axl\] /);
    expect(warnings[0]).toContain('1001 runs');
    expect(warnings[0]).toContain('limit');
    expect(warnings[0]).toContain('cursor');
    expect(warnings[0]).toContain('docs/migration/execution-history-retention.md');
  });

  it('P6-05 diagnostics.silent keeps it quiet', async () => {
    const store = new MemoryStore({ maxExecutions: Infinity });
    const runtime = new AxlRuntime({ state: { store }, diagnostics: { silent: true } });
    await seed(store, 1_001);
    expect(await runtime.getExecutions()).toHaveLength(1_001);
    expect(warningsContaining(LISTING_WARNING)).toHaveLength(0);
  });

  it('P6-06 counts the merged result: 1 000 stored + 1 running warns', async () => {
    const store = new MemoryStore({ maxExecutions: Infinity });
    const runtime = new AxlRuntime({ state: { store } });
    const { release } = registerHeldWorkflow(runtime);
    await seed(store, 1_000);
    let activeId: string | undefined;
    runtime.on('trace', (e: AxlEvent) => {
      activeId ??= e.executionId;
    });
    const running = runtime.execute('held', {});
    await vi.waitFor(() => expect(activeId).toBeDefined());

    expect(await runtime.getExecutions()).toHaveLength(1_001);
    expect(warningsContaining(LISTING_WARNING)).toHaveLength(1);
    release();
    await running;
  });

  it('P6-07 internal reads of a large history never warn', async () => {
    const store = new MemoryStore({ maxExecutions: Infinity });
    await seed(store, 1_001);
    await store.appendStreamingEvents('crashed', [
      {
        executionId: 'crashed',
        step: 0,
        type: 'workflow_start',
        workflow: 'wf',
        timestamp: 5,
        data: { input: {} },
      } as unknown as AxlEvent,
    ]);
    const runtime = new AxlRuntime({ state: { store, persist: 'streaming' } });

    expect(await runtime.recoverIncompleteStreams()).toHaveLength(1);
    expect(await runtime.getExecution(runId(0))).toBeDefined();
    expect(await runtime.getExecution('missing')).toBeUndefined();
    expect(await runtime.deleteExecution(runId(1))).toBe(true);
    // Studio's aggregators and list route always pass a limit.
    expect(await runtime.getExecutions({ limit: 2_000 })).toHaveLength(1_001);
    expect(warningsContaining(LISTING_WARNING)).toHaveLength(0);
  });
});
