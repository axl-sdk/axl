import type { ChatMessage, HumanDecision } from '../types.js';
import type { StateStore, PendingDecision, ExecutionState } from './types.js';

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

  // ── Checkpoints ──────────────────────────────────────────────────────

  async saveCheckpoint(executionId: string, step: number, data: unknown): Promise<void> {
    await this.client.hSet(this.checkpointKey(executionId), String(step), JSON.stringify(data));
  }

  async getCheckpoint(executionId: string, step: number): Promise<unknown | null> {
    const raw = await this.client.hGet(this.checkpointKey(executionId), String(step));
    return raw != null ? JSON.parse(raw) : null;
  }

  async getLatestCheckpoint(executionId: string): Promise<{ step: number; data: unknown } | null> {
    const all = await this.client.hGetAll(this.checkpointKey(executionId));
    if (!all || Object.keys(all).length === 0) return null;

    let maxStep = -1;
    let maxData: unknown = null;
    for (const [stepStr, raw] of Object.entries(all)) {
      const step = Number(stepStr);
      if (step > maxStep) {
        maxStep = step;
        maxData = JSON.parse(raw);
      }
    }

    return { step: maxStep, data: maxData };
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
