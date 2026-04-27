import type { ChatMessage, ExecutionInfo, HumanDecision } from '../types.js';
import type { StateStore, PendingDecision, ExecutionState, EvalHistoryEntry } from './types.js';

// Minimal interface for the node-redis client methods we use.
// Avoids a hard compile-time dependency on the redis package.
interface RedisClient {
  hSet(key: string, field: string, value: string): Promise<number>;
  hGet(key: string, field: string): Promise<string | null | undefined>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hDel(key: string, field: string | string[]): Promise<number>;
  set(key: string, value: string): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string | string[]): Promise<number>;
  sAdd(key: string, member: string | string[]): Promise<number>;
  sRem(key: string, member: string | string[]): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  quit(): Promise<void>;
}

/**
 * Redis-backed StateStore using the official `redis` (node-redis) client.
 *
 * Designed for multi-process and sidecar deployments where
 * multiple runtime instances need shared state.
 *
 * Requires `redis` as a peer dependency. Create instances via the
 * async `RedisStore.create()` factory, which connects before returning.
 */
export class RedisStore implements StateStore {
  private constructor(private client: RedisClient) {}

  /**
   * Create a connected RedisStore instance.
   *
   * @param url - Redis connection URL (e.g. `redis://localhost:6379`). Defaults to `redis://localhost:6379`.
   */
  static async create(url?: string): Promise<RedisStore> {
    let createClient: (opts?: { url?: string }) => RedisClient & { connect(): Promise<void> };
    try {
      const mod = require('redis');
      createClient = mod.createClient ?? mod.default?.createClient;
      if (typeof createClient !== 'function') {
        throw new Error(
          'redis package does not export createClient. Ensure you have redis ^5.0.0 installed: npm install redis',
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('createClient')) throw err;
      throw new Error('redis is required for RedisStore. Install it with: npm install redis');
    }

    const client = url ? createClient({ url }) : createClient();
    await client.connect();
    return new RedisStore(client);
  }

  // ── Key helpers ──────────────────────────────────────────────────────

  private checkpointKey(executionId: string): string {
    return `axl:checkpoint:${executionId}`;
  }

  private sessionKey(sessionId: string): string {
    return `axl:session:${sessionId}`;
  }

  private sessionMetaKey(sessionId: string): string {
    return `axl:session-meta:${sessionId}`;
  }

  private decisionsKey(): string {
    return 'axl:decisions';
  }

  private executionStateKey(executionId: string): string {
    return `axl:exec-state:${executionId}`;
  }

  private pendingExecSetKey(): string {
    return 'axl:pending-executions';
  }

  private execHistoryKey(executionId: string): string {
    return `axl:exec-history:${executionId}`;
  }

  private execHistorySetKey(): string {
    return 'axl:exec-history-ids';
  }

  private evalHistoryKey(id: string): string {
    return `axl:eval-history:${id}`;
  }

  private evalHistorySetKey(): string {
    return 'axl:eval-history-ids';
  }

  // ── Checkpoints ──────────────────────────────────────────────────────

  async saveCheckpoint(executionId: string, name: string, data: unknown): Promise<void> {
    await this.client.hSet(this.checkpointKey(executionId), name, JSON.stringify(data));
  }

  async getCheckpoint(executionId: string, name: string): Promise<unknown | null> {
    const raw = await this.client.hGet(this.checkpointKey(executionId), name);
    return raw != null ? JSON.parse(raw) : null;
  }

  // ── Sessions ─────────────────────────────────────────────────────────

  async saveSession(sessionId: string, history: ChatMessage[]): Promise<void> {
    await this.client.set(this.sessionKey(sessionId), JSON.stringify(history));
    await this.client.sAdd('axl:session-ids', sessionId);
  }

  async getSession(sessionId: string): Promise<ChatMessage[]> {
    const raw = await this.client.get(this.sessionKey(sessionId));
    return raw ? JSON.parse(raw) : [];
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.client.del(this.sessionKey(sessionId));
    await this.client.del(this.sessionMetaKey(sessionId));
    await this.client.sRem('axl:session-ids', sessionId);
  }

  async saveSessionMeta(sessionId: string, key: string, value: unknown): Promise<void> {
    await this.client.hSet(this.sessionMetaKey(sessionId), key, JSON.stringify(value));
  }

  async getSessionMeta(sessionId: string, key: string): Promise<unknown | null> {
    const raw = await this.client.hGet(this.sessionMetaKey(sessionId), key);
    return raw != null ? JSON.parse(raw) : null;
  }

  // ── Pending Decisions ────────────────────────────────────────────────

  async savePendingDecision(executionId: string, decision: PendingDecision): Promise<void> {
    await this.client.hSet(this.decisionsKey(), executionId, JSON.stringify(decision));
  }

  async getPendingDecisions(): Promise<PendingDecision[]> {
    const all = await this.client.hGetAll(this.decisionsKey());
    if (!all) return [];
    return Object.values(all).map((raw) => JSON.parse(raw));
  }

  async resolveDecision(executionId: string, _result: HumanDecision): Promise<void> {
    await this.client.hDel(this.decisionsKey(), executionId);
  }

  // ── Execution State ──────────────────────────────────────────────────

  async saveExecutionState(executionId: string, state: ExecutionState): Promise<void> {
    await this.client.set(this.executionStateKey(executionId), JSON.stringify(state));

    if (state.status === 'waiting') {
      await this.client.sAdd(this.pendingExecSetKey(), executionId);
    } else {
      await this.client.sRem(this.pendingExecSetKey(), executionId);
    }
  }

  async getExecutionState(executionId: string): Promise<ExecutionState | null> {
    const raw = await this.client.get(this.executionStateKey(executionId));
    return raw ? JSON.parse(raw) : null;
  }

  async listPendingExecutions(): Promise<string[]> {
    return this.client.sMembers(this.pendingExecSetKey());
  }

  // ── Execution History ────────────────────────────────────────────────

  async saveExecution(execution: ExecutionInfo): Promise<void> {
    // Write set membership first — if we crash between the two writes,
    // listExecutions gracefully skips IDs with missing values.
    await this.client.sAdd(this.execHistorySetKey(), execution.executionId);
    await this.client.set(this.execHistoryKey(execution.executionId), JSON.stringify(execution));
  }

  async getExecution(executionId: string): Promise<ExecutionInfo | null> {
    const raw = await this.client.get(this.execHistoryKey(executionId));
    return raw ? JSON.parse(raw) : null;
  }

  async listExecutions(limit?: number): Promise<ExecutionInfo[]> {
    const ids = await this.client.sMembers(this.execHistorySetKey());
    if (ids.length === 0) return [];

    const entries: ExecutionInfo[] = [];
    for (const id of ids) {
      const raw = await this.client.get(this.execHistoryKey(id));
      if (raw) entries.push(JSON.parse(raw));
    }
    entries.sort((a, b) => b.startedAt - a.startedAt);
    return limit ? entries.slice(0, limit) : entries;
  }

  // ── Eval History ────────────────────────────────────────────────────

  async saveEvalResult(entry: EvalHistoryEntry): Promise<void> {
    await this.client.sAdd(this.evalHistorySetKey(), entry.id);
    await this.client.set(this.evalHistoryKey(entry.id), JSON.stringify(entry));
  }

  async listEvalResults(limit?: number): Promise<EvalHistoryEntry[]> {
    const ids = await this.client.sMembers(this.evalHistorySetKey());
    if (ids.length === 0) return [];

    const entries: EvalHistoryEntry[] = [];
    for (const id of ids) {
      const raw = await this.client.get(this.evalHistoryKey(id));
      if (raw) entries.push(JSON.parse(raw));
    }
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return limit ? entries.slice(0, limit) : entries;
  }

  async deleteEvalResult(id: string): Promise<boolean> {
    // Remove from both the index set and the data key. del() returns the
    // number of keys actually deleted, which we use as the "existed" signal
    // so callers can distinguish "not found" from "deleted" without a
    // separate EXISTS round-trip.
    await this.client.sRem(this.evalHistorySetKey(), id);
    const deleted = await this.client.del(this.evalHistoryKey(id));
    return deleted > 0;
  }

  // ── Sessions (Studio introspection) ────────────────────────────────────

  async listSessions(): Promise<string[]> {
    // Redis doesn't have a built-in way to list keys by pattern without SCAN,
    // so we maintain a set of session IDs alongside the session data.
    return this.client.sMembers('axl:session-ids');
  }

  /** Close the Redis connection. */
  async close(): Promise<void> {
    await this.client.quit();
  }

  async deleteCheckpoints(executionId: string): Promise<void> {
    await this.client.del(this.checkpointKey(executionId));
  }
}
