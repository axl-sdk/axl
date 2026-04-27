import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { SQLiteStore } from '../state/sqlite.js';
import type { ExecutionInfo } from '../types.js';

const require_ = createRequire(import.meta.url);

/**
 * Migration tests for the spec/16 schema bump:
 * `execution_history.steps` → `events`. The SQLiteStore constructor runs
 * `migrate()` before `initTables()` and tracks version via PRAGMA
 * `user_version`. Idempotent, transactional, rolls back on failure.
 */
describe('SQLiteStore — schema migration v0 → v1', () => {
  const tmps: string[] = [];

  afterEach(() => {
    for (const dir of tmps) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    tmps.length = 0;
  });

  function makeTmpFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'axl-sqlite-mig-'));
    tmps.push(dir);
    return join(dir, 'state.sqlite');
  }

  it('fresh install: creates table with `events` column and sets user_version=1', () => {
    const path = makeTmpFile();
    const store = new SQLiteStore(path);
    const Database = require_('better-sqlite3');
    const db = new Database(path, { readonly: true });
    try {
      const cols = db.pragma('table_info(execution_history)') as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('events');
      expect(names).not.toContain('steps');
      expect(db.pragma('user_version', { simple: true })).toBe(2);
    } finally {
      db.close();
      void store; // silence unused-locals
    }
  });

  it('old-schema round-trip: migrates `steps` column → `events` and preserves data', async () => {
    const path = makeTmpFile();
    const Database = require_('better-sqlite3');

    // Pre-seed an old-shape DB: build the v0 schema by hand and insert a row.
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE execution_history (
        execution_id TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        status TEXT NOT NULL,
        total_cost REAL NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        duration INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        steps TEXT NOT NULL
      );
    `);
    const events = [
      {
        type: 'workflow_start',
        executionId: 'exec-old',
        step: 0,
        timestamp: 1000,
        workflow: 'wf',
        data: { input: { x: 1 } },
      },
    ];
    seed
      .prepare('INSERT INTO execution_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('exec-old', 'wf', 'completed', 0.1, 1000, 2000, 1000, null, JSON.stringify(events));
    seed.close();

    // Re-open via SQLiteStore — migration runs on construction.
    const store = new SQLiteStore(path);
    const got = await store.getExecution!('exec-old');
    expect(got).toBeDefined();
    expect(got!.executionId).toBe('exec-old');
    expect(got!.events).toHaveLength(1);
    expect(got!.events[0].type).toBe('workflow_start');
  });

  it('idempotent reopen: no ALTER runs on already-migrated DB', () => {
    const path = makeTmpFile();
    const Database = require_('better-sqlite3');
    new SQLiteStore(path); // First open: applies v0 → v1 (or fresh install).

    // Reopen — version stays 1, table still has `events`.
    new SQLiteStore(path);
    const db = new Database(path, { readonly: true });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(2);
      const cols = db.pragma('table_info(execution_history)') as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('events');
      expect(names).not.toContain('steps');
    } finally {
      db.close();
    }
  });

  it('concurrent open: BEGIN IMMEDIATE serializes; both succeed cleanly', async () => {
    const path = makeTmpFile();
    const Database = require_('better-sqlite3');

    // Pre-seed v0 schema
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE execution_history (
        execution_id TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        status TEXT NOT NULL,
        total_cost REAL NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        duration INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        steps TEXT NOT NULL
      );
    `);
    seed.close();

    // Two SQLiteStore constructors race. better-sqlite3 is synchronous, so
    // the "concurrency" here is effectively sequential — but the
    // BEGIN IMMEDIATE + user_version idempotency is what we're verifying:
    // the second construction must not double-apply the ALTER.
    const stores = await Promise.all([
      Promise.resolve().then(() => new SQLiteStore(path)),
      Promise.resolve().then(() => new SQLiteStore(path)),
    ]);
    expect(stores).toHaveLength(2);

    const db = new Database(path, { readonly: true });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(2);
      const cols = db.pragma('table_info(execution_history)') as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain('events');
    } finally {
      db.close();
    }
  });

  it('round-trip: saveExecution writes via new column name; getExecution reads back', async () => {
    const path = makeTmpFile();
    const store = new SQLiteStore(path);
    const exec: ExecutionInfo = {
      executionId: 'exec-new',
      workflow: 'wf-new',
      status: 'completed',
      events: [
        {
          type: 'workflow_start',
          executionId: 'exec-new',
          step: 0,
          timestamp: 1000,
          workflow: 'wf-new',
          data: { input: 'q' },
        } as ExecutionInfo['events'][number],
      ],
      totalCost: 0.5,
      startedAt: 1000,
      completedAt: 2000,
      duration: 1000,
    };
    await store.saveExecution!(exec);
    const got = await store.getExecution!('exec-new');
    expect(got).toBeDefined();
    expect(got!.events).toHaveLength(1);
    expect(got!.events[0].type).toBe('workflow_start');
    expect(got!.totalCost).toBe(0.5);
  });
});
