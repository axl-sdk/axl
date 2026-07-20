import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { SQLiteStore } from '../state/sqlite.js';
import type { ExecutionInfo } from '../types.js';

const require_ = createRequire(import.meta.url);

/**
 * Migration tests for the SQLiteStore schema:
 * - v0 → v1: `execution_history.steps` → `events` (spec/16).
 * - v1 → v2: `checkpoints.step` (INTEGER) → `checkpoints.name` (TEXT).
 * - v2 → v3: add `execution_history.metadata` (TEXT, nullable) so
 *            `ExecutionInfo.metadata` round-trips through history.
 * - v3 → v4: add `execution_history.event_schema_version` (INTEGER,
 *            nullable); missing remains the v1 sentinel.
 * - v4 → v5: add `execution_history.observation` (TEXT, nullable).
 * The SQLiteStore constructor runs `migrate()` before `initTables()` and
 * tracks version via PRAGMA `user_version`. Idempotent, transactional,
 * rolls back on failure.
 */
describe('SQLiteStore — schema migration v0 → v5', () => {
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

  it('fresh install: creates versioned execution history and sets user_version=5', () => {
    const path = makeTmpFile();
    const store = new SQLiteStore(path);
    const Database = require_('better-sqlite3');
    const db = new Database(path, { readonly: true });
    try {
      const cols = db.pragma('table_info(execution_history)') as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('events');
      expect(names).not.toContain('steps');
      expect(names).toContain('metadata');
      expect(names).toContain('event_schema_version');
      expect(names).toContain('observation');
      expect(db.pragma('user_version', { simple: true })).toBe(5);
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

    // Reopen — version stays at TARGET_VERSION, table still has `events`.
    new SQLiteStore(path);
    const db = new Database(path, { readonly: true });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(5);
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
      expect(db.pragma('user_version', { simple: true })).toBe(5);
      const cols = db.pragma('table_info(execution_history)') as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain('events');
    } finally {
      db.close();
    }
  });

  it('v1 → v2: renames checkpoints.step → name and stringified rows round-trip', async () => {
    const path = makeTmpFile();
    const Database = require_('better-sqlite3');

    // Pre-seed a v1 DB by hand: execution_history with `events` (post-v0→v1)
    // and the OLD checkpoints schema with INTEGER `step`. user_version=1.
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
        events TEXT NOT NULL
      );
      CREATE TABLE checkpoints (
        execution_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (execution_id, step)
      );
      PRAGMA user_version = 1;
    `);
    seed
      .prepare('INSERT INTO checkpoints (execution_id, step, data) VALUES (?, ?, ?)')
      .run('exec-legacy', 0, JSON.stringify({ legacy: true }));
    seed.close();

    // Re-open via SQLiteStore — runs v1→v2 migration.
    const store = new SQLiteStore(path);

    // Verify column rename + version bump.
    const db = new Database(path, { readonly: true });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(5);
      const cols = db.pragma('table_info(checkpoints)') as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('name');
      expect(names).not.toContain('step');
    } finally {
      db.close();
    }

    // Stringified-integer reads MUST round-trip — SQLite is dynamically
    // typed so the stored INTEGER 0 returns under name === '0'.
    const got = await store.getCheckpoint('exec-legacy', '0');
    expect(got).toEqual({ legacy: true });

    // The new code never writes that name (auto-checkpoints use
    // __auto/<agent>/ask/<n>), so legacy rows are stranded — but the
    // raw lookup must still return them when explicitly addressed.
  });

  it('v2 → v3: adds execution_history.metadata column and preserves existing rows', async () => {
    const path = makeTmpFile();
    const Database = require_('better-sqlite3');

    // Pre-seed a v2 DB by hand: post-v0→v1→v2 schema (events column,
    // renamed checkpoints.name), and user_version=2. Critically, the
    // execution_history table is missing the `metadata` column that v3
    // adds.
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
        events TEXT NOT NULL
      );
      CREATE TABLE checkpoints (
        execution_id TEXT NOT NULL,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (execution_id, name)
      );
      PRAGMA user_version = 2;
    `);
    seed
      .prepare('INSERT INTO execution_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('exec-v2', 'wf', 'completed', 0.1, 1000, 2000, 1000, null, JSON.stringify([]));
    seed.close();

    // Re-open via SQLiteStore — runs v2→v3 migration (ALTER TABLE ADD COLUMN).
    const store = new SQLiteStore(path);

    const db = new Database(path, { readonly: true });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(5);
      const cols = db.pragma('table_info(execution_history)') as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain('metadata');
    } finally {
      db.close();
    }

    // Existing row's metadata is NULL (not set on the v2 row), and
    // deserializes as `undefined` on the resulting ExecutionInfo (no
    // metadata key present).
    const got = await store.getExecution!('exec-v2');
    expect(got).toBeDefined();
    expect(got!.metadata).toBeUndefined();
    expect('metadata' in (got as object)).toBe(false);

    // New writes can populate metadata; round-trip works after migration.
    await store.saveExecution!({
      executionId: 'exec-v3',
      workflow: 'wf',
      status: 'completed',
      events: [],
      totalCost: 0,
      startedAt: 3000,
      duration: 0,
      metadata: { userId: 'u1' },
    });
    const got2 = await store.getExecution!('exec-v3');
    expect(got2!.metadata).toEqual({ userId: 'u1' });
  });

  it('v3 → v4: adds event schema carrier without rewriting legacy events', async () => {
    const path = makeTmpFile();
    const Database = require_('better-sqlite3');
    const legacyEvents = [
      {
        type: 'tool_denied',
        executionId: 'exec-v3',
        step: 1,
        timestamp: 1000,
        tool: 'missing',
        data: {},
      },
    ];
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
        events TEXT NOT NULL,
        metadata TEXT
      );
      PRAGMA user_version = 3;
    `);
    seed
      .prepare('INSERT INTO execution_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'exec-v3',
        'wf',
        'completed',
        0,
        1000,
        1000,
        0,
        null,
        JSON.stringify(legacyEvents),
        null,
      );
    seed.close();

    const store = new SQLiteStore(path);
    const db = new Database(path, { readonly: true });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(5);
      const row = db
        .prepare(
          'SELECT events, event_schema_version FROM execution_history WHERE execution_id = ?',
        )
        .get('exec-v3') as { events: string; event_schema_version: number | null };
      expect(row.event_schema_version).toBeNull();
      expect(row.events).toBe(JSON.stringify(legacyEvents));
    } finally {
      db.close();
    }

    const got = await store.getExecution!('exec-v3');
    expect(got?.eventSchemaVersion).toBe(1);
    expect(got?.events).toEqual(legacyEvents);
  });

  it('v4 → v5: adds observation without reclassifying existing rows', async () => {
    const path = makeTmpFile();
    const Database = require_('better-sqlite3');
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
        events TEXT NOT NULL,
        metadata TEXT,
        event_schema_version INTEGER
      );
      PRAGMA user_version = 4;
    `);
    seed
      .prepare('INSERT INTO execution_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('exec-v4', 'wf', 'completed', 0, 1000, 1000, 0, null, '[]', null, 2);
    seed.close();

    const store = new SQLiteStore(path);
    const db = new Database(path, { readonly: true });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(5);
      const cols = db.pragma('table_info(execution_history)') as Array<{ name: string }>;
      expect(cols.map((column) => column.name)).toContain('observation');
    } finally {
      db.close();
    }

    const got = await store.getExecution!('exec-v4');
    expect(got?.eventSchemaVersion).toBe(2);
    expect(got?.observation).toBeUndefined();
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
    expect(got!.eventSchemaVersion).toBe(1);
  });
});
