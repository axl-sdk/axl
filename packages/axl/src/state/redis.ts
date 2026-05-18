import type { ChatMessage, ExecutionInfo, HumanDecision } from '../types.js';
import type { StateStore, PendingDecision, ExecutionState, EvalHistoryEntry } from './types.js';

// Minimal interface for the node-redis client methods we use.
// Avoids a hard compile-time dependency on the redis package.
interface RedisClient {
  hSet(key: string, field: string, value: string): Promise<number>;
  // hSetNX is the atomic "set field iff absent" primitive (HSETNX).
  // Used by `getMemory` to migrate legacy data forward without clobbering a
  // concurrent fresh write. Returns 1 if the field was set, 0 if it already
  // existed.
  hSetNX(key: string, field: string, value: string): Promise<number | boolean>;
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

/** Options accepted by {@link RedisStore.create}. */
export interface RedisStoreOptions {
  /** Redis connection URL (e.g. `redis://localhost:6379`). Defaults to `redis://localhost:6379`. */
  url?: string;
  /**
   * Prefix prepended to every Redis key written by this store. Defaults to
   * `'axl:'`. Useful when multiple Axl deployments share a Redis cluster
   * (e.g. `'axl:prod:'` vs `'axl:staging:'`) or when coexisting with other
   * applications' keys.
   *
   * The prefix is concatenated as-given — no normalization. If you want a
   * trailing colon, include it. Whitespace and unusual characters are
   * accepted as-is. Only the empty string is rejected, to prevent accidental
   * collisions with non-Axl keys.
   */
  keyPrefix?: string;
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
  private constructor(
    private client: RedisClient,
    private keyPrefix: string,
  ) {}

  /**
   * Create a connected RedisStore instance.
   *
   * Accepts either a URL string (back-compat) or a {@link RedisStoreOptions}
   * object. The object form is required to set a custom `keyPrefix`.
   *
   * @example
   * ```ts
   * // Default prefix 'axl:'
   * const store = await RedisStore.create('redis://localhost:6379');
   *
   * // Custom prefix for shared-cluster deployments
   * const store = await RedisStore.create({
   *   url: 'redis://localhost:6379',
   *   keyPrefix: 'axl:prod:',
   * });
   * ```
   */
  static async create(options?: string | RedisStoreOptions): Promise<RedisStore> {
    const opts: RedisStoreOptions =
      typeof options === 'string' ? { url: options } : (options ?? {});
    const keyPrefix = opts.keyPrefix ?? 'axl:';
    // Reject empty string — guarding against accidental collisions with
    // unrelated keys in a shared cluster. `undefined` gets the default.
    if (keyPrefix === '') {
      throw new Error(
        'RedisStore: keyPrefix cannot be empty string. Omit it for the default "axl:" prefix.',
      );
    }

    let createClient: (clientOpts?: { url?: string }) => RedisClient & { connect(): Promise<void> };
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

    const client = opts.url ? createClient({ url: opts.url }) : createClient();
    await client.connect();
    return new RedisStore(client, keyPrefix);
  }

  // ── Key helpers ──────────────────────────────────────────────────────

  private checkpointKey(executionId: string): string {
    return `${this.keyPrefix}checkpoint:${executionId}`;
  }

  private sessionKey(sessionId: string): string {
    return `${this.keyPrefix}session:${sessionId}`;
  }

  private sessionMetaKey(sessionId: string): string {
    return `${this.keyPrefix}session-meta:${sessionId}`;
  }

  private sessionIdsKey(): string {
    return `${this.keyPrefix}session-ids`;
  }

  private decisionsKey(): string {
    return `${this.keyPrefix}decisions`;
  }

  private executionStateKey(executionId: string): string {
    return `${this.keyPrefix}exec-state:${executionId}`;
  }

  private pendingExecSetKey(): string {
    return `${this.keyPrefix}pending-executions`;
  }

  private execHistoryKey(executionId: string): string {
    return `${this.keyPrefix}exec-history:${executionId}`;
  }

  private execHistorySetKey(): string {
    return `${this.keyPrefix}exec-history-ids`;
  }

  private evalHistoryKey(id: string): string {
    return `${this.keyPrefix}eval-history:${id}`;
  }

  private evalHistorySetKey(): string {
    return `${this.keyPrefix}eval-history-ids`;
  }

  private memoryKey(scope: string): string {
    return `${this.keyPrefix}memory:${scope}`;
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
    await this.client.sAdd(this.sessionIdsKey(), sessionId);
  }

  async getSession(sessionId: string): Promise<ChatMessage[]> {
    const raw = await this.client.get(this.sessionKey(sessionId));
    return raw ? JSON.parse(raw) : [];
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.client.del(this.sessionKey(sessionId));
    await this.client.del(this.sessionMetaKey(sessionId));
    await this.client.sRem(this.sessionIdsKey(), sessionId);
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

  // ── Memory ──────────────────────────────────────────────────────────
  //
  // Layout: `{prefix}memory:{scope}` is a hash. Fields are user-supplied
  // keys; values are JSON-serialized. Hash-per-scope keeps related entries
  // together (good cohesion for TTL eviction once #3 lands) and bounds the
  // keyspace to O(scopes) instead of O(scopes × keys).
  //
  // Pre-this-patch, RedisStore had no memory methods, so MemoryManager fell
  // back to writing memory at synthetic sessionMeta keys
  // (`{prefix}session-meta:memory:{scope}:{key}` hash field `value`). To
  // preserve user data on upgrade, `getMemory` checks the legacy location on
  // miss and migrates forward; `deleteMemory` also cleans the legacy entry.
  // No legacy support on `getAllMemory` — that method didn't exist before,
  // so no user can depend on it returning legacy data.

  async saveMemory(scope: string, key: string, value: unknown): Promise<void> {
    await this.client.hSet(this.memoryKey(scope), key, JSON.stringify(value));
  }

  async getMemory(scope: string, key: string): Promise<unknown | null> {
    const raw = await this.client.hGet(this.memoryKey(scope), key);
    if (raw != null) return JSON.parse(raw);

    // Legacy fallback: pre-patch data lives at the sessionMeta location.
    // NOTE: the legacy key construction `memory:{scope}:{key}` is internally
    // ambiguous if `scope` or `key` contain colons, but the new path
    // (`memoryKey(scope)` as hash key, `key` as field name) is collision-free
    // because field names and key names are stored in separate namespaces.
    const legacyRaw = await this.client.hGet(
      this.sessionMetaKey(`memory:${scope}:${key}`),
      'value',
    );
    if (legacyRaw == null) return null;

    // Race-safe migrate-forward. HSETNX is atomic and only writes if the
    // new field is still absent — so a concurrent `saveMemory` from another
    // process can't be clobbered by our migration of the legacy value.
    //
    // If HSETNX no-ops (returns 0/false), some other writer beat us to the
    // canonical location between our primary-read and our migration-write.
    // Return THEIR value, not the (now-stale) legacy value, or we'd hand
    // the caller stale data to act on.
    const inserted = await this.client.hSetNX(this.memoryKey(scope), key, legacyRaw);
    if (inserted === 0 || inserted === false) {
      const winner = await this.client.hGet(this.memoryKey(scope), key);
      if (winner != null) return JSON.parse(winner);
      // HSETNX said the field exists, but a follow-up hGet says it doesn't.
      // This can only happen if a concurrent `deleteMemory` raced between
      // HSETNX and the re-read — in which case "deleted" is the freshest
      // truth and we should return null, not the legacy value.
      return null;
    }
    return JSON.parse(legacyRaw);
  }

  async getAllMemory(scope: string): Promise<Array<{ key: string; value: unknown }>> {
    const all = await this.client.hGetAll(this.memoryKey(scope));
    if (!all) return [];
    return Object.entries(all).map(([key, raw]) => ({ key, value: JSON.parse(raw) }));
  }

  async deleteMemory(scope: string, key: string): Promise<void> {
    await this.client.hDel(this.memoryKey(scope), key);
    // Also clean the legacy location so a re-read can't resurrect a value
    // the caller asked to forget.
    await this.client.hDel(this.sessionMetaKey(`memory:${scope}:${key}`), 'value');
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
    return this.client.sMembers(this.sessionIdsKey());
  }

  /** Close the Redis connection. */
  async close(): Promise<void> {
    await this.client.quit();
  }

  async deleteCheckpoints(executionId: string): Promise<void> {
    await this.client.del(this.checkpointKey(executionId));
  }
}
