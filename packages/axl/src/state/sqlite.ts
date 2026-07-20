import type {
  ChatMessage,
  HistoricalAxlEvent,
  HistoricalExecutionInfo,
  HumanDecision,
} from '../types.js';
import { getExecutionEventSchemaVersion, normalizeStoredExecution } from '../event-schema.js';
import type { StateStore, PendingDecision, ExecutionState, EvalHistoryEntry } from './types.js';

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

  constructor(filePath: string) {
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
    const TARGET_VERSION = 5;
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
        observation TEXT
      );

      CREATE TABLE IF NOT EXISTS eval_history (
        id TEXT PRIMARY KEY,
        eval_name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_exec_history_started ON execution_history (started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_eval_history_timestamp ON eval_history (timestamp DESC);
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
    stmt.run(sessionId, JSON.stringify(history));
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
    this.db
      .prepare(
        'INSERT OR REPLACE INTO execution_history (execution_id, workflow, status, total_cost, started_at, completed_at, duration, error, events, metadata, event_schema_version, observation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
      );
  }

  async getExecution(executionId: string): Promise<HistoricalExecutionInfo | null> {
    const row = this.db
      .prepare('SELECT * FROM execution_history WHERE execution_id = ?')
      .get(executionId) as ExecutionHistoryRow | undefined;
    return row ? rowToExecutionInfo(row) : null;
  }

  async listExecutions(limit?: number): Promise<HistoricalExecutionInfo[]> {
    const sql = limit
      ? 'SELECT * FROM execution_history ORDER BY started_at DESC LIMIT ?'
      : 'SELECT * FROM execution_history ORDER BY started_at DESC';
    const rows = (
      limit ? this.db.prepare(sql).all(limit) : this.db.prepare(sql).all()
    ) as ExecutionHistoryRow[];
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

  async saveEvalResult(entry: EvalHistoryEntry): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO eval_history (id, eval_name, timestamp, data) VALUES (?, ?, ?, ?)',
      )
      .run(entry.id, entry.eval, entry.timestamp, JSON.stringify(entry.data));
  }

  async listEvalResults(limit?: number): Promise<EvalHistoryEntry[]> {
    const sql = limit
      ? 'SELECT * FROM eval_history ORDER BY timestamp DESC LIMIT ?'
      : 'SELECT * FROM eval_history ORDER BY timestamp DESC';
    const rows = (limit ? this.db.prepare(sql).all(limit) : this.db.prepare(sql).all()) as Array<{
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
