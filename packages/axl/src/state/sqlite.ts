import type {
  ChatMessage,
  HistoricalAxlEvent,
  HistoricalExecutionInfo,
  HumanDecision,
} from '../types.js';
import { getExecutionEventSchemaVersion, normalizeStoredExecution } from '../event-schema.js';
import type {
  StateStore,
  PendingDecision,
  ExecutionState,
  EvalHistoryEntry,
  ExecutionCursor,
  HistoryTtls,
} from './types.js';
import { normalizePersistedSessionHistory } from '../input.js';
import { AxlError } from '../errors.js';
import {
  PRUNE_BATCH,
  expiryFrom,
  resolveHistoryTtls,
  type ResolvedHistoryTtls,
} from './retention.js';

/** Options for {@link SQLiteStore}. */
export type SQLiteStoreOptions = {
  /**
   * History retention in seconds. A positive number expires a record that
   * many seconds after it is saved; `null` or unset keeps it. See
   * {@link HistoryTtls} for how each category's window is counted.
   */
  ttls?: HistoryTtls;
  /** Clock in epoch milliseconds, used for retention. Defaults to `Date.now`. */
  now?: () => number;
};

/** SQL predicate for "this history row has not expired" (bind `now`). */
const LIVE = '(expires_at IS NULL OR expires_at > ?)';

// Lazy-loaded better-sqlite3 types
type Database = import('better-sqlite3').Database;
type DatabaseConstructor = typeof import('better-sqlite3');

/** Safely parse JSON, returning null on corrupt data instead of crashing. */
function safeJsonParse(data: string): unknown | null {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

type ExecutionHistoryRow = {
  execution_id: string;
  workflow: string;
  status: string;
  total_cost: number;
  started_at: number;
  completed_at: number | null;
  duration: number;
  error: string | null;
  events: string;
  metadata: string | null;
  event_schema_version: number | null;
  observation: string | null;
};

function rowToExecutionInfo(row: ExecutionHistoryRow): HistoricalExecutionInfo {
  const info = {
    executionId: row.execution_id,
    workflow: row.workflow,
    status: row.status as HistoricalExecutionInfo['status'],
    totalCost: row.total_cost,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    duration: row.duration,
    events: (safeJsonParse(row.events) as HistoricalAxlEvent[]) ?? [],
    ...(row.event_schema_version != null ? { eventSchemaVersion: row.event_schema_version } : {}),
  } as HistoricalExecutionInfo;
  if (row.error != null) info.error = row.error;
  // `metadata` is optional on the type so only attach when present —
  // keeps `.toEqual()` round-trip checks tight (no spurious `undefined`
  // keys) and matches `MemoryStore`'s `structuredClone` semantics.
  if (row.metadata != null) {
    const parsed = safeJsonParse(row.metadata);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      info.metadata = parsed as Record<string, unknown>;
    }
  }
  if (row.observation != null) {
    const parsed = safeJsonParse(row.observation);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      info.observation = parsed as HistoricalExecutionInfo['observation'];
    }
  }
  return normalizeStoredExecution(info);
}

/**
 * SQLite-backed StateStore using better-sqlite3.
 *
 * Zero-config, file-based persistence suitable for single-process production.
 * Uses prepared statements for all operations.
 *
 * Requires `better-sqlite3` as a peer dependency. If not installed,
 * the constructor throws a clear error message.
 */
export class SQLiteStore implements StateStore {
  private db: Database;
  private readonly ttls: ResolvedHistoryTtls;
  private readonly now: () => number;

  constructor(filePath: string, options?: SQLiteStoreOptions) {
    // Validate options before touching the file, so a bad config never
    // migrates or creates a database.
    this.ttls = resolveHistoryTtls('SQLiteStore', options?.ttls);
    if (options?.now !== undefined && typeof options.now !== 'function') {
      throw new AxlError(
        'INVALID_CONFIG',
        'SQLiteStore: now must be a function returning epoch milliseconds',
      );
    }
    this.now = options?.now ?? (() => Date.now());
    let BetterSqlite3: DatabaseConstructor;
    try {
      BetterSqlite3 = require('better-sqlite3');
    } catch {
      throw new Error(
        'better-sqlite3 is required for SQLiteStore. Install it with: npm install better-sqlite3',
      );
    }

    this.db = new BetterSqlite3(filePath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
    this.initTables();
  }

  /**
   * Idempotent schema migration. Tracks version via `PRAGMA user_version`
   * so reopens skip applied steps. Wrapped in `BEGIN IMMEDIATE` so
   * concurrent `SQLiteStore` constructors serialize at the file level
   * and rollback on failure leaves the DB in a clean pre-migration
   * state.
   *
   * Migration history:
   * - v1 (spec/16): rename `execution_history.steps` → `events`. The
   *   JS-level `ExecutionInfo.steps` was renamed to `.events` in PR 1
   *   commit 1; this brings the on-disk schema in line.
   * - v2 (named checkpoints): rename `checkpoints.step` (INTEGER) →
   *   `checkpoints.name` (TEXT). The runtime now requires
   *   `ctx.checkpoint(name, fn)` so the per-context numeric counter is
   *   gone — names are caller-supplied stable identifiers. Existing
   *   numeric step values become stringified names ("0", "1", …) to
   *   preserve replay continuity for in-flight executions across the
   *   upgrade boundary.
   * - v3 (ExecutionInfo.metadata): add `execution_history.metadata`
   *   column (TEXT, nullable, JSON-serialized) so caller-supplied
   *   `ExecuteOptions.metadata` round-trips through history. Existing
   *   rows get `NULL`, deserialized as `metadata: undefined`.
   * - v4 (event schema): add `execution_history.event_schema_version`.
   *   Existing rows remain `NULL`, the documented v1 sentinel.
   * - v5 (observation completeness): add `execution_history.observation`.
   *   Existing rows remain `NULL`, meaning they predate the contract.
   * - v6 (history retention): add nullable `expires_at` (epoch ms) to
   *   `execution_history` and `eval_history`. Existing rows remain `NULL`
   *   (never expire), so an upgrade deletes nothing. The single-column
   *   `started_at` index is replaced by `(started_at, execution_id)`, which
   *   serves the tie-safe listing order.
   *
   * Applied BEFORE `initTables()` so the subsequent `CREATE TABLE
   * IF NOT EXISTS` runs against the post-migration column name. Fresh
   * installs just create the table with `events` directly and bump
   * `user_version` to the current version.
   *
   * TOCTOU guard (review B-3): the initial `user_version` read is
   * informational only — a concurrent process can complete the
   * migration between that read and our `BEGIN IMMEDIATE`. We
   * re-read `user_version` inside the transaction and short-circuit
   * if it's already at target, so the non-idempotent half (writes
   * that went beyond a simple ALTER) never double-applies under a
   * race. The current v0→v1 step IS idempotent via the column-
   * presence check, but future migrations may not be, and the
   * transactional re-read costs nothing.
   */
  private migrate(): void {
    const TARGET_VERSION = 6;
    const current = this.db.pragma('user_version', { simple: true }) as number;
    if (current >= TARGET_VERSION) return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read under the write lock — a concurrent constructor may
      // have completed the migration between our pragma read above
      // and our lock acquisition. Short-circuit to avoid re-applying.
      const committed = this.db.pragma('user_version', { simple: true }) as number;
      if (committed >= TARGET_VERSION) {
        this.db.exec('COMMIT');
        return;
      }
      // v0 → v1: rename `steps` column on `execution_history` if present.
      // `table_info()` is safe even if the table doesn't exist (returns []).
      if (committed < 1) {
        const cols = this.db.pragma('table_info(execution_history)') as Array<{ name: string }>;
        if (cols.some((c) => c.name === 'steps') && !cols.some((c) => c.name === 'events')) {
          this.db.exec('ALTER TABLE execution_history RENAME COLUMN steps TO events');
        }
      }
      // v1 → v2: rename `checkpoints.step` (INTEGER) → `checkpoints.name`
      // (TEXT). SQLite columns are dynamically typed so existing integer
      // values continue to work; ALTER TABLE just updates the column name
      // (and type hint) so new schemas match. NOTE: legacy auto-checkpoint
      // rows ("0", "1", …) are *structurally* preserved but become
      // unreachable — the new runtime composes auto-checkpoint names like
      // `__auto/<agent>/ask/<n>`, which never match the legacy integer
      // strings. In-flight executions resumed under v2 will re-execute
      // side effects (no replay match). Drain or cancel running
      // executions before upgrading. User-named checkpoints (only
      // possible on the new API) are unaffected.
      if (committed < 2) {
        const cols = this.db.pragma('table_info(checkpoints)') as Array<{ name: string }>;
        if (cols.some((c) => c.name === 'step') && !cols.some((c) => c.name === 'name')) {
          this.db.exec('ALTER TABLE checkpoints RENAME COLUMN step TO name');
        }
      }
      // v2 → v3: add `execution_history.metadata` (TEXT, nullable) so
      // `ExecutionInfo.metadata` round-trips through history. Idempotent —
      // skips the ALTER when the column is already present (e.g., fresh
      // installs that hit the new CREATE TABLE in `initTables` first, or
      // a partial earlier migration).
      if (committed < 3) {
        const cols = this.db.pragma('table_info(execution_history)') as Array<{ name: string }>;
        if (cols.length > 0 && !cols.some((c) => c.name === 'metadata')) {
          this.db.exec('ALTER TABLE execution_history ADD COLUMN metadata TEXT');
        }
      }
      if (committed < 4) {
        const cols = this.db.pragma('table_info(execution_history)') as Array<{ name: string }>;
        if (cols.length > 0 && !cols.some((c) => c.name === 'event_schema_version')) {
          this.db.exec('ALTER TABLE execution_history ADD COLUMN event_schema_version INTEGER');
        }
      }
      if (committed < 5) {
        const cols = this.db.pragma('table_info(execution_history)') as Array<{ name: string }>;
        if (cols.length > 0 && !cols.some((c) => c.name === 'observation')) {
          this.db.exec('ALTER TABLE execution_history ADD COLUMN observation TEXT');
        }
      }
      if (committed < 6) {
        for (const table of ['execution_history', 'eval_history']) {
          const cols = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
          if (cols.length > 0 && !cols.some((c) => c.name === 'expires_at')) {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN expires_at INTEGER`);
          }
        }
        this.db.exec('DROP INDEX IF EXISTS idx_exec_history_started');
      }
      this.db.pragma(`user_version = ${TARGET_VERSION}`);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        execution_id TEXT NOT NULL,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (execution_id, name)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        history TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decisions (
        execution_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        prompt TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_state (
        execution_id TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        input TEXT NOT NULL,
        step INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (session_id, key)
      );

      CREATE TABLE IF NOT EXISTS memory (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (scope, key)
      );

      CREATE TABLE IF NOT EXISTS execution_history (
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
        event_schema_version INTEGER,
        observation TEXT,
        expires_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS eval_history (
        id TEXT PRIMARY KEY,
        eval_name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        data TEXT NOT NULL,
        expires_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_exec_history_started_id
        ON execution_history (started_at DESC, execution_id DESC);
      CREATE INDEX IF NOT EXISTS idx_exec_history_expires ON execution_history (expires_at);
      CREATE INDEX IF NOT EXISTS idx_eval_history_timestamp ON eval_history (timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_eval_history_expires ON eval_history (expires_at);

      -- Superseded by idx_exec_history_started_id in v6. Dropped here as well as in
      -- migrate(): a pre-v6 process reopening a v6 file re-creates it, and
      -- migrate() never runs again once user_version is 6.
      DROP INDEX IF EXISTS idx_exec_history_started;
    `);
  }

  // ── Checkpoints ────────────────────────────────────────────────────────

  async saveCheckpoint(executionId: string, name: string, data: unknown): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO checkpoints (execution_id, name, data) VALUES (?, ?, ?)',
    );
    stmt.run(executionId, name, JSON.stringify(data));
  }

  async getCheckpoint(executionId: string, name: string): Promise<unknown | null> {
    const stmt = this.db.prepare(
      'SELECT data FROM checkpoints WHERE execution_id = ? AND name = ?',
    );
    const row = stmt.get(executionId, name) as { data: string } | undefined;
    return row ? safeJsonParse(row.data) : null;
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  async saveSession(sessionId: string, history: ChatMessage[]): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO sessions (session_id, history) VALUES (?, ?)',
    );
    stmt.run(sessionId, JSON.stringify(normalizePersistedSessionHistory(history)));
  }

  async getSession(sessionId: string): Promise<ChatMessage[]> {
    const stmt = this.db.prepare('SELECT history FROM sessions WHERE session_id = ?');
    const row = stmt.get(sessionId) as { history: string } | undefined;
    return row ? ((safeJsonParse(row.history) as ChatMessage[]) ?? []) : [];
  }

  async deleteSession(sessionId: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE session_id = ?');
    stmt.run(sessionId);
    const metaStmt = this.db.prepare('DELETE FROM session_meta WHERE session_id = ?');
    metaStmt.run(sessionId);
  }

  async saveSessionMeta(sessionId: string, key: string, value: unknown): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO session_meta (session_id, key, value) VALUES (?, ?, ?)',
    );
    stmt.run(sessionId, key, JSON.stringify(value));
  }

  async getSessionMeta(sessionId: string, key: string): Promise<unknown | null> {
    const stmt = this.db.prepare('SELECT value FROM session_meta WHERE session_id = ? AND key = ?');
    const row = stmt.get(sessionId, key) as { value: string } | undefined;
    return row ? safeJsonParse(row.value) : null;
  }

  // ── Pending Decisions ──────────────────────────────────────────────────

  async savePendingDecision(executionId: string, decision: PendingDecision): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO decisions (execution_id, channel, prompt, metadata, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    stmt.run(
      executionId,
      decision.channel,
      decision.prompt,
      decision.metadata ? JSON.stringify(decision.metadata) : null,
      decision.createdAt,
    );
  }

  async getPendingDecisions(): Promise<PendingDecision[]> {
    const stmt = this.db.prepare('SELECT * FROM decisions');
    const rows = stmt.all() as Array<{
      execution_id: string;
      channel: string;
      prompt: string;
      metadata: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      executionId: row.execution_id,
      channel: row.channel,
      prompt: row.prompt,
      metadata: row.metadata
        ? (safeJsonParse(row.metadata) as Record<string, unknown> | undefined)
        : undefined,
      createdAt: row.created_at,
    }));
  }

  async resolveDecision(executionId: string, _result: HumanDecision): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM decisions WHERE execution_id = ?');
    stmt.run(executionId);
  }

  // ── Legacy application-managed execution state ────────────────────────

  async saveExecutionState(executionId: string, state: ExecutionState): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO execution_state (execution_id, workflow, input, step, status, metadata) VALUES (?, ?, ?, ?, ?, ?)',
    );
    stmt.run(
      executionId,
      state.workflow,
      JSON.stringify(state.input),
      state.step,
      state.status,
      state.metadata ? JSON.stringify(state.metadata) : null,
    );
  }

  async getExecutionState(executionId: string): Promise<ExecutionState | null> {
    const stmt = this.db.prepare('SELECT * FROM execution_state WHERE execution_id = ?');
    const row = stmt.get(executionId) as
      | {
          execution_id: string;
          workflow: string;
          input: string;
          step: number;
          status: string;
          metadata: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      workflow: row.workflow,
      input: safeJsonParse(row.input),
      step: row.step,
      status: row.status as 'waiting' | 'running',
      metadata: row.metadata
        ? (safeJsonParse(row.metadata) as Record<string, unknown> | undefined)
        : undefined,
    };
  }

  async listPendingExecutions(): Promise<string[]> {
    const stmt = this.db.prepare(
      "SELECT execution_id FROM execution_state WHERE status = 'waiting'",
    );
    const rows = stmt.all() as Array<{ execution_id: string }>;
    return rows.map((r) => r.execution_id);
  }

  // ── Execution History ────────────────────────────────────────────────────

  async saveExecution(execution: HistoricalExecutionInfo): Promise<void> {
    const normalized = normalizeStoredExecution({
      ...execution,
      eventSchemaVersion: getExecutionEventSchemaVersion(execution),
    } as HistoricalExecutionInfo);
    const now = this.now();
    // The window counts from the last save: every save writes a fresh expiry.
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT OR REPLACE INTO execution_history (execution_id, workflow, status, total_cost, started_at, completed_at, duration, error, events, metadata, event_schema_version, observation, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          normalized.executionId,
          normalized.workflow,
          normalized.status,
          normalized.totalCost,
          normalized.startedAt,
          normalized.completedAt ?? null,
          normalized.duration,
          normalized.error ?? null,
          JSON.stringify(normalized.events),
          normalized.metadata !== undefined ? JSON.stringify(normalized.metadata) : null,
          normalized.eventSchemaVersion,
          normalized.observation !== undefined ? JSON.stringify(normalized.observation) : null,
          expiryFrom(now, this.ttls.executionHistory),
        );
      this.pruneExpiredExecutions(now);
    })();
  }

  /**
   * Remove up to `PRUNE_BATCH` expired execution-history rows, together with
   * each run's leftover checkpoints and saved execution state, inside the
   * caller's transaction. Pending decisions are not touched. The runtime
   * never writes execution state, and a run is only saved to history once it
   * has finished, so nothing still running depends on what is removed here.
   */
  private pruneExpiredExecutions(now: number): void {
    const ids = (
      this.db
        .prepare(
          'SELECT execution_id FROM execution_history WHERE expires_at <= ? ORDER BY expires_at LIMIT ?',
        )
        .all(now, PRUNE_BATCH) as Array<{ execution_id: string }>
    ).map((row) => row.execution_id);
    if (ids.length === 0) return;
    const idList = JSON.stringify(ids);
    for (const table of ['execution_history', 'checkpoints', 'execution_state']) {
      this.db
        .prepare(`DELETE FROM ${table} WHERE execution_id IN (SELECT value FROM json_each(?))`)
        .run(idList);
    }
  }

  /** Remove up to `PRUNE_BATCH` expired eval-history rows (caller's transaction). */
  private pruneExpiredEvals(now: number): void {
    this.db
      .prepare(
        'DELETE FROM eval_history WHERE rowid IN (SELECT rowid FROM eval_history WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)',
      )
      .run(now, PRUNE_BATCH);
  }

  async getExecution(executionId: string): Promise<HistoricalExecutionInfo | null> {
    const row = this.db
      .prepare(`SELECT * FROM execution_history WHERE execution_id = ? AND ${LIVE}`)
      .get(executionId, this.now()) as ExecutionHistoryRow | undefined;
    return row ? rowToExecutionInfo(row) : null;
  }

  /** Supports `listExecutions(limit, { cursor })`. */
  readonly historyPaging = true;

  async listExecutions(
    limit?: number,
    options?: { cursor?: ExecutionCursor },
  ): Promise<HistoricalExecutionInfo[]> {
    const cursor = options?.cursor;
    const params: Array<number | string> = [this.now()];
    let sql = `SELECT * FROM execution_history WHERE ${LIVE}`;
    if (cursor !== undefined) {
      // Strictly after the cursor in (started_at DESC, execution_id DESC)
      // order; served by the (started_at, execution_id) index.
      sql += ' AND (started_at < ? OR (started_at = ? AND execution_id < ?))';
      params.push(cursor.startedAt, cursor.startedAt, cursor.executionId);
    }
    sql += ' ORDER BY started_at DESC, execution_id DESC';
    if (limit) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    const rows = this.db.prepare(sql).all(...params) as ExecutionHistoryRow[];
    return rows.map(rowToExecutionInfo);
  }

  async deleteExecution(executionId: string): Promise<boolean> {
    // Sweep every per-execution side-table inside a transaction so the
    // delete is total. Without this, a GDPR-style "scrub this run" call
    // leaves PII reachable via lingering checkpoints / suspended state /
    // pending decisions. SQLite has no streaming-events table (streaming
    // durability is a RedisStore-only feature), so the buffer-side cleanup
    // is a no-op here.
    const tx = this.db.transaction(() => {
      const historyResult = this.db
        .prepare('DELETE FROM execution_history WHERE execution_id = ?')
        .run(executionId);
      const checkpointsResult = this.db
        .prepare('DELETE FROM checkpoints WHERE execution_id = ?')
        .run(executionId);
      const stateResult = this.db
        .prepare('DELETE FROM execution_state WHERE execution_id = ?')
        .run(executionId);
      const decisionsResult = this.db
        .prepare('DELETE FROM decisions WHERE execution_id = ?')
        .run(executionId);
      return (
        historyResult.changes +
          checkpointsResult.changes +
          stateResult.changes +
          decisionsResult.changes >
        0
      );
    });
    return tx();
  }

  // ── Eval History ────────────────────────────────────────────────────────

  /**
   * Write an eval history row. Retention counts from the row's first write:
   * re-saving a live row keeps its `expires_at` (including none, for a row
   * written without retention). A row that has already expired is replaced
   * as a new one.
   */
  async saveEvalResult(entry: EvalHistoryEntry): Promise<void> {
    const now = this.now();
    this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT expires_at FROM eval_history WHERE id = ? AND ${LIVE}`)
        .get(entry.id, now) as { expires_at: number | null } | undefined;
      const expiresAt = existing ? existing.expires_at : expiryFrom(now, this.ttls.evalHistory);
      this.db
        .prepare(
          'INSERT OR REPLACE INTO eval_history (id, eval_name, timestamp, data, expires_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(entry.id, entry.eval, entry.timestamp, JSON.stringify(entry.data), expiresAt);
      this.pruneExpiredEvals(now);
    })();
  }

  /**
   * Update-only write: see `StateStore.updateEvalResult`. `UPDATE ... WHERE id`
   * touches nothing when the row is gone or expired, where `INSERT OR REPLACE`
   * would resurrect it. `expires_at` is left as it was.
   */
  async updateEvalResult(entry: EvalHistoryEntry): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE eval_history SET eval_name = ?, timestamp = ?, data = ? WHERE id = ? AND ${LIVE}`,
      )
      .run(entry.eval, entry.timestamp, JSON.stringify(entry.data), entry.id, this.now());
    return result.changes > 0;
  }

  async listEvalResults(limit?: number): Promise<EvalHistoryEntry[]> {
    const base = `SELECT * FROM eval_history WHERE ${LIVE} ORDER BY timestamp DESC`;
    const now = this.now();
    const rows = (
      limit ? this.db.prepare(`${base} LIMIT ?`).all(now, limit) : this.db.prepare(base).all(now)
    ) as Array<{
      id: string;
      eval_name: string;
      timestamp: number;
      data: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      eval: r.eval_name,
      timestamp: r.timestamp,
      data: safeJsonParse(r.data),
    }));
  }

  async deleteEvalResult(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM eval_history WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** Existence plus the expiry stored at the row's first write, if any. */
  async getEvalRetention(id: string): Promise<{ exists: boolean; expiresAt?: number }> {
    const row = this.db
      .prepare(`SELECT expires_at FROM eval_history WHERE id = ? AND ${LIVE}`)
      .get(id, this.now()) as { expires_at: number | null } | undefined;
    if (!row) return { exists: false };
    return row.expires_at === null ? { exists: true } : { exists: true, expiresAt: row.expires_at };
  }

  // ── Sessions (Studio introspection) ────────────────────────────────────

  async listSessions(): Promise<string[]> {
    const rows = this.db.prepare('SELECT session_id FROM sessions').all() as Array<{
      session_id: string;
    }>;
    return rows.map((r) => r.session_id);
  }

  // ── Memory ────────────────────────────────────────────────────────────

  async saveMemory(scope: string, key: string, value: unknown): Promise<void> {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO memory (scope, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))",
      )
      .run(scope, key, JSON.stringify(value));
  }

  async getMemory(scope: string, key: string): Promise<unknown | null> {
    const row = this.db
      .prepare('SELECT value FROM memory WHERE scope = ? AND key = ?')
      .get(scope, key) as { value: string } | undefined;
    return row ? safeJsonParse(row.value) : null;
  }

  async getAllMemory(scope: string): Promise<Array<{ key: string; value: unknown }>> {
    const rows = this.db
      .prepare('SELECT key, value FROM memory WHERE scope = ?')
      .all(scope) as Array<{ key: string; value: string }>;
    return rows.map((r) => ({ key: r.key, value: safeJsonParse(r.value) }));
  }

  async deleteMemory(scope: string, key: string): Promise<void> {
    this.db.prepare('DELETE FROM memory WHERE scope = ? AND key = ?').run(scope, key);
  }

  /** Close the database connection. */
  async close(): Promise<void> {
    this.db.close();
  }

  async deleteCheckpoints(executionId: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM checkpoints WHERE execution_id = ?');
    stmt.run(executionId);
  }
}
