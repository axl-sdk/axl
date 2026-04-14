import type { ChatMessage, ExecutionInfo, HumanDecision } from '../types.js';
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
  steps: string;
};

function rowToExecutionInfo(row: ExecutionHistoryRow): ExecutionInfo {
  return {
    executionId: row.execution_id,
    workflow: row.workflow,
    status: row.status as ExecutionInfo['status'],
    totalCost: row.total_cost,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    duration: row.duration,
    error: row.error ?? undefined,
    steps: (safeJsonParse(row.steps) as ExecutionInfo['steps']) ?? [],
  };
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
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        execution_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (execution_id, step)
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
        steps TEXT NOT NULL
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

  async saveCheckpoint(executionId: string, step: number, data: unknown): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO checkpoints (execution_id, step, data) VALUES (?, ?, ?)',
    );
    stmt.run(executionId, step, JSON.stringify(data));
  }

  async getCheckpoint(executionId: string, step: number): Promise<unknown | null> {
    const stmt = this.db.prepare(
      'SELECT data FROM checkpoints WHERE execution_id = ? AND step = ?',
    );
    const row = stmt.get(executionId, step) as { data: string } | undefined;
    return row ? safeJsonParse(row.data) : null;
  }

  async getLatestCheckpoint(executionId: string): Promise<{ step: number; data: unknown } | null> {
    const stmt = this.db.prepare(
      'SELECT step, data FROM checkpoints WHERE execution_id = ? ORDER BY step DESC LIMIT 1',
    );
    const row = stmt.get(executionId) as { step: number; data: string } | undefined;
    return row ? { step: row.step, data: safeJsonParse(row.data) } : null;
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

  // ── Execution State (for awaitHuman suspend/resume) ────────────────────

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

  async saveExecution(execution: ExecutionInfo): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO execution_history (execution_id, workflow, status, total_cost, started_at, completed_at, duration, error, steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        execution.executionId,
        execution.workflow,
        execution.status,
        execution.totalCost,
        execution.startedAt,
        execution.completedAt ?? null,
        execution.duration,
        execution.error ?? null,
        JSON.stringify(execution.steps),
      );
  }

  async getExecution(executionId: string): Promise<ExecutionInfo | null> {
    const row = this.db
      .prepare('SELECT * FROM execution_history WHERE execution_id = ?')
      .get(executionId) as ExecutionHistoryRow | undefined;
    return row ? rowToExecutionInfo(row) : null;
  }

  async listExecutions(limit?: number): Promise<ExecutionInfo[]> {
    const sql = limit
      ? 'SELECT * FROM execution_history ORDER BY started_at DESC LIMIT ?'
      : 'SELECT * FROM execution_history ORDER BY started_at DESC';
    const rows = (
      limit ? this.db.prepare(sql).all(limit) : this.db.prepare(sql).all()
    ) as ExecutionHistoryRow[];
    return rows.map(rowToExecutionInfo);
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
