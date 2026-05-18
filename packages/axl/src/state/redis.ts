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
  // multi() opens a transaction. Queued commands execute atomically on
  // exec() — a crash mid-MULTI leaves none of the queued writes applied,
  // which is what we want for the multi-key writes (saveSession,
  // saveExecution, etc.) that previously could half-commit on failure.
  multi(): RedisMulti;
  quit(): Promise<void>;
}

// Chainable transaction builder returned by `client.multi()`. Queues
// commands client-side; sends them in a single MULTI/EXEC round-trip
// when `.exec()` is awaited. Same surface as node-redis v5's `RedisMulti`,
// scoped to commands we actually use.
interface RedisMulti {
  set(key: string, value: string): RedisMulti;
  del(key: string | string[]): RedisMulti;
  sAdd(key: string, member: string | string[]): RedisMulti;
  sRem(key: string, member: string | string[]): RedisMulti;
  hDel(key: string, field: string | string[]): RedisMulti;
  // exec() returns the per-command results in queued order. We don't
  // type-narrow individual results because the callers that need a result
  // (e.g. deleteEvalResult) cast at the call site.
  exec(): Promise<unknown[]>;
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
    // Atomic: data blob + index-set membership commit together. A crash
    // between the writes would otherwise leave the session unreachable via
    // listSessions (data exists, index doesn't) or visible-but-empty (index
    // exists, data doesn't).
    await this.client
      .multi()
      .set(this.sessionKey(sessionId), JSON.stringify(history))
      .sAdd(this.sessionIdsKey(), sessionId)
      .exec();
  }

  async getSession(sessionId: string): Promise<ChatMessage[]> {
    const raw = await this.client.get(this.sessionKey(sessionId));
    return raw ? JSON.parse(raw) : [];
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Atomic: data + metadata + index-set entry removed together.
    await this.client
      .multi()
      .del(this.sessionKey(sessionId))
      .del(this.sessionMetaKey(sessionId))
      .sRem(this.sessionIdsKey(), sessionId)
      .exec();
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
    // Atomic: state blob + pending-set membership commit together. A crash
    // between writes would otherwise leave `listPendingExecutions()` and
    // `getExecutionState()` disagreeing on what's waiting.
    //
    // NOTE for future contributors: MULTI/EXEC is atomic, but it does NOT
    // serialize concurrent writers — two processes simultaneously calling
    // saveExecutionState(id, ...) will both commit their batches, with
    // last-write-wins on the state blob. If you ever add a read-modify-write
    // pattern here (e.g. "increment step iff state.status === 'running'"),
    // you'll need `WATCH` for true cross-process safety. The current writes
    // are full-replacement, so this isn't a concern today.
    const tx = this.client.multi().set(this.executionStateKey(executionId), JSON.stringify(state));
    if (state.status === 'waiting') {
      tx.sAdd(this.pendingExecSetKey(), executionId);
    } else {
      tx.sRem(this.pendingExecSetKey(), executionId);
    }
    await tx.exec();
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
    // Atomic: new + legacy locations cleaned together so a crash between
    // them can't leave a "forgotten" value live in only one place where
    // a subsequent migrate-on-read could resurrect it.
    await this.client
      .multi()
      .hDel(this.memoryKey(scope), key)
      .hDel(this.sessionMetaKey(`memory:${scope}:${key}`), 'value')
      .exec();
  }

  // ── Execution History ────────────────────────────────────────────────

  async saveExecution(execution: ExecutionInfo): Promise<void> {
    // Atomic: index-set membership + data blob commit together. Before
    // MULTI/EXEC was wired up, a crash between the two writes left
    // `listExecutions` returning IDs whose data was absent — and the
    // graceful-skip fallback in the reader was load-bearing. Now the
    // partial-write hazard is gone at the source.
    await this.client
      .multi()
      .sAdd(this.execHistorySetKey(), execution.executionId)
      .set(this.execHistoryKey(execution.executionId), JSON.stringify(execution))
      .exec();
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
    // Atomic, same partial-write concern as saveExecution.
    await this.client
      .multi()
      .sAdd(this.evalHistorySetKey(), entry.id)
      .set(this.evalHistoryKey(entry.id), JSON.stringify(entry))
      .exec();
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
    // Atomic: index-set removal + data deletion commit together. del()'s
    // return is the "did it exist" signal. Destructure to keep the
    // ordering self-documenting — survives a future reorder of the chain.
    const [, deletedCount] = await this.client
      .multi()
      .sRem(this.evalHistorySetKey(), id)
      .del(this.evalHistoryKey(id))
      .exec();
    const deleted = typeof deletedCount === 'number' ? deletedCount : 0;
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
