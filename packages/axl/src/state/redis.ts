import type { ChatMessage, HumanDecision } from '../types.js';
import type { StateStore, PendingDecision, ExecutionState } from './types.js';

// Minimal interface for the ioredis client methods we use.
// Avoids a hard compile-time dependency on the ioredis package.
interface RedisClient {
  hset(key: string, field: string, value: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  set(key: string, value: string): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  quit(): Promise<'OK'>;
}

/**
 * Redis-backed StateStore using ioredis.
 *
 * Designed for multi-process and sidecar deployments where
 * multiple runtime instances need shared state.
 *
 * Requires `ioredis` as a peer dependency. If not installed,
 * the constructor throws a clear error message.
 */
export class RedisStore implements StateStore {
  private client: RedisClient;

  constructor(url?: string) {
    let Redis: new (url?: string) => RedisClient;
    try {
      const mod = require('ioredis');
      Redis = mod.default ?? mod;
    } catch {
      throw new Error('ioredis is required for RedisStore. Install it with: npm install ioredis');
    }

    this.client = url ? new Redis(url) : new Redis();
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
    await this.client.hset(this.checkpointKey(executionId), String(step), JSON.stringify(data));
  }

  async getCheckpoint(executionId: string, step: number): Promise<unknown | null> {
    const raw = await this.client.hget(this.checkpointKey(executionId), String(step));
    return raw !== null ? JSON.parse(raw) : null;
  }

  async getLatestCheckpoint(executionId: string): Promise<{ step: number; data: unknown } | null> {
    const all = await this.client.hgetall(this.checkpointKey(executionId));
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
    await this.client.sadd('axl:session-ids', sessionId);
  }

  async getSession(sessionId: string): Promise<ChatMessage[]> {
    const raw = await this.client.get(this.sessionKey(sessionId));
    return raw ? JSON.parse(raw) : [];
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.client.del(this.sessionKey(sessionId));
    await this.client.del(this.sessionMetaKey(sessionId));
    await this.client.srem('axl:session-ids', sessionId);
  }

  async saveSessionMeta(sessionId: string, key: string, value: unknown): Promise<void> {
    await this.client.hset(this.sessionMetaKey(sessionId), key, JSON.stringify(value));
  }

  async getSessionMeta(sessionId: string, key: string): Promise<unknown | null> {
    const raw = await this.client.hget(this.sessionMetaKey(sessionId), key);
    return raw !== null ? JSON.parse(raw) : null;
  }

  // ── Pending Decisions ────────────────────────────────────────────────

  async savePendingDecision(executionId: string, decision: PendingDecision): Promise<void> {
    await this.client.hset(this.decisionsKey(), executionId, JSON.stringify(decision));
  }

  async getPendingDecisions(): Promise<PendingDecision[]> {
    const all = await this.client.hgetall(this.decisionsKey());
    if (!all) return [];
    return Object.values(all).map((raw) => JSON.parse(raw));
  }

  async resolveDecision(executionId: string, _result: HumanDecision): Promise<void> {
    await this.client.hdel(this.decisionsKey(), executionId);
  }

  // ── Execution State ──────────────────────────────────────────────────

  async saveExecutionState(executionId: string, state: ExecutionState): Promise<void> {
    await this.client.set(this.executionStateKey(executionId), JSON.stringify(state));

    if (state.status === 'waiting') {
      await this.client.sadd(this.pendingExecSetKey(), executionId);
    } else {
      await this.client.srem(this.pendingExecSetKey(), executionId);
    }
  }

  async getExecutionState(executionId: string): Promise<ExecutionState | null> {
    const raw = await this.client.get(this.executionStateKey(executionId));
    return raw ? JSON.parse(raw) : null;
  }

  async listPendingExecutions(): Promise<string[]> {
    return this.client.smembers(this.pendingExecSetKey());
  }

  // ── Sessions (Studio introspection) ────────────────────────────────────

  async listSessions(): Promise<string[]> {
    // Redis doesn't have a built-in way to list keys by pattern without SCAN,
    // so we maintain a set of session IDs alongside the session data.
    return this.client.smembers('axl:session-ids');
  }

  /** Close the Redis connection. */
  async close(): Promise<void> {
    await this.client.quit();
  }

  async deleteCheckpoints(executionId: string): Promise<void> {
    await this.client.del(this.checkpointKey(executionId));
  }
}
