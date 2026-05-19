import type { AxlEvent, ChatMessage, ExecutionInfo, HumanDecision } from '../types.js';
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
  // SET with optional `EX` (expiration in seconds). When `EX` is undefined,
  // the key has no TTL — same behavior as the pre-#3 single-arg form.
  set(key: string, value: string, options?: { EX?: number }): Promise<string | null>;
  // EXPIRE applies a TTL to an existing key (e.g. after `hSet`, since
  // node-redis has no `HSET ... EX` primitive). `mode: 'NX'` only sets the
  // TTL when none already exists — used for fixed-window semantics so a
  // re-save of a per-execution hash doesn't keep extending its window.
  // Omitting `mode` always (re)sets — used for sliding-window memory.
  expire(key: string, seconds: number, mode?: 'NX' | 'XX' | 'GT' | 'LT'): Promise<number | boolean>;
  get(key: string): Promise<string | null>;
  // mGet bulk-fetches values for an array of keys. Used by listExecutions /
  // listEvalResults after the sorted-set returns an ordered ID list.
  mGet(keys: string[]): Promise<Array<string | null>>;
  del(key: string | string[]): Promise<number>;
  sAdd(key: string, member: string | string[]): Promise<number>;
  sRem(key: string, member: string | string[]): Promise<number>;
  sCard(key: string): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  // List ops for streaming-event persistence. RPUSH appends batches of
  // JSON-serialized events to a per-execution list; LRANGE 0 -1 reads
  // them back on recovery. Used by appendStreamingEvents / getStreamingEvents.
  rPush(key: string, values: string | string[]): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  // Sorted-set ops drive the listExecutions / listEvalResults fast path.
  // zAdd adds a member with a score; zRange with BY:'SCORE' + REV:true is the
  // node-redis v5 form of "ZREVRANGEBYSCORE" (the dedicated method exists in
  // node-redis v4 but was removed in v5 in favor of the parameterized zRange);
  // zCard counts; zRem deletes.
  zAdd(key: string, member: { score: number; value: string }): Promise<number>;
  zCard(key: string): Promise<number>;
  zRem(key: string, member: string | string[]): Promise<number>;
  zRange(
    key: string,
    start: number | string,
    stop: number | string,
    options?: {
      BY?: 'SCORE' | 'LEX';
      REV?: boolean;
      LIMIT?: { offset: number; count: number };
    },
  ): Promise<string[]>;
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
  set(key: string, value: string, options?: { EX?: number }): RedisMulti;
  del(key: string | string[]): RedisMulti;
  sAdd(key: string, member: string | string[]): RedisMulti;
  sRem(key: string, member: string | string[]): RedisMulti;
  hSet(key: string, field: string, value: string): RedisMulti;
  hDel(key: string, field: string | string[]): RedisMulti;
  expire(key: string, seconds: number, mode?: 'NX' | 'XX' | 'GT' | 'LT'): RedisMulti;
  zAdd(key: string, member: { score: number; value: string }): RedisMulti;
  zRem(key: string, member: string | string[]): RedisMulti;
  rPush(key: string, values: string | string[]): RedisMulti;
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
   *
   * Operator note: Redis SCAN/KEYS patterns interpret `*`, `?`, and `[`/`]`
   * as glob meta-characters. If your prefix contains any of these, the
   * runtime accepts it (literal SET/HSET/etc. don't use globs and round-
   * trip cleanly), but operators trying to clean up with
   * `redis-cli SCAN 0 MATCH '<prefix>*'` will need to escape them. Stick
   * to alphanumerics, hyphens, underscores, and colons for the best
   * operator experience.
   */
  keyPrefix?: string;
  /**
   * Skip the lazy backfill of legacy execution / eval-history entries into
   * the sorted-set indexes during `RedisStore.create()`. Default `false`
   * (backfill runs on startup, one MULTI per 500-entry chunk plus two
   * probes — cheap when there's nothing to do).
   *
   * Set to `true` for installs at six-figure execution counts where the
   * startup cost is unacceptable. Until you call `backfillExecutionIndex()` /
   * `backfillEvalIndex()` manually (e.g. during a maintenance window),
   * `listExecutions` / `listEvalResults` fall back to the legacy
   * SET + N×GET + JS-sort read path — correct but slow at scale.
   */
  skipMigration?: boolean;
  /**
   * Default TTL in **seconds** applied to every storage category that has
   * a TTL-capable storage shape. Omitted by default — keys never expire,
   * matching pre-#3 behavior.
   *
   * Per-category overrides via {@link ttls} take precedence. Set a category
   * to `null` in {@link ttls} to opt that category out of the default.
   *
   * Strongly recommended in production: without a TTL every save accumulates
   * forever and your Redis instance will eventually OOM.
   *
   * @example
   * ```ts
   * await RedisStore.create({
   *   url: 'redis://localhost:6379',
   *   defaultTtl: 60 * 60 * 24 * 30, // 30 days
   * });
   * ```
   */
  defaultTtl?: number;
  /**
   * Per-category TTL overrides in **seconds**. Use to assign different
   * lifetimes per category (e.g. short-lived checkpoints, long-lived eval
   * history). Set a category to `null` to explicitly disable TTL for it
   * even when {@link defaultTtl} is set. Omitting a category means it falls
   * back to {@link defaultTtl} (or no TTL if neither is set).
   *
   * `pendingDecision` is intentionally NOT in this map — pending decisions
   * are stored as fields of a shared hash (`axl:decisions`), so a TTL on
   * that key would expire ALL pending decisions at once, which is almost
   * never what you want. Resolve decisions individually via
   * `resolveDecision()` instead.
   *
   * Window semantics:
   * - **Sliding window** (write-only refresh): `memory`, `session`,
   *   `sessionMeta`. Every write resets the TTL, so active *writers* keep
   *   their data and inactive ones forget. Reads do NOT refresh the TTL —
   *   a read-only workload (e.g. agent recalling memories without writing
   *   new ones) eventually ages out. If you need read-activity to count
   *   as "active," issue a no-op `ctx.remember` against a sentinel key
   *   per session turn.
   * - **Fixed window**: `checkpoint`, `executionState`, `executionHistory`,
   *   `evalHistory`. The TTL is set on the first write and isn't extended
   *   on subsequent writes (via `EXPIRE ... NX`). Designed for runtime-
   *   controlled lifecycles like executions, where the data should age
   *   out on a schedule from creation.
   */
  ttls?: {
    session?: number | null;
    sessionMeta?: number | null;
    checkpoint?: number | null;
    executionState?: number | null;
    executionHistory?: number | null;
    evalHistory?: number | null;
    memory?: number | null;
    /**
     * TTL for the `state.persist: 'streaming'` per-execution event buffer
     * (`exec-events:{id}` list). Safety net for the scenario where the
     * operator forgets to wire `runtime.recoverIncompleteStreams()` into
     * startup — without this TTL, orphaned buffers from crashed
     * processes accumulate indefinitely. Default `null` (no TTL —
     * matches pre-streaming-mode behavior; explicit opt-in for the
     * safety net so recovery isn't surprised by buffers that aged out).
     *
     * **MUST be longer than your recovery cadence.** If you restart
     * processes every 12h and the buffer TTL is 1h, any crash whose
     * recovery hasn't fired within the hour loses its events to TTL
     * eviction. Recommended floor: 24× your max time-between-restarts.
     */
    streamingEvents?: number | null;
  };
}

type TtlCategory =
  | 'session'
  | 'sessionMeta'
  | 'checkpoint'
  | 'executionState'
  | 'executionHistory'
  | 'evalHistory'
  | 'memory'
  | 'streamingEvents';

/** Resolved per-category TTL (seconds), or `null` for "no TTL". */
type ResolvedTtls = Record<TtlCategory, number | null>;

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
    private ttls: ResolvedTtls,
  ) {}

  /**
   * Resolve the TTL for a given storage category. Returns `undefined` when
   * no TTL applies (category is `null` in resolved config, the value is
   * non-positive — Redis EXPIRE 0 immediately deletes, which is almost
   * never intended — or the value is non-finite).
   *
   * Non-finite values (`NaN`, `±Infinity`) defensively map to `undefined`
   * rather than being passed to Redis, where they'd surface as a wire-level
   * protocol error at the worst possible time (first write under load).
   */
  private ttlFor(category: TtlCategory): number | undefined {
    const resolved = this.ttls[category];
    if (resolved === null) return undefined;
    if (!Number.isFinite(resolved) || resolved <= 0) return undefined;
    // Use a positive integer — Redis EXPIRE / SET EX take seconds as ints.
    return Math.floor(resolved);
  }

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

    // Resolve effective per-category TTL: per-category override beats
    // defaultTtl beats "no TTL". `null` in overrides means explicit opt-out
    // (no TTL for this category, even when defaultTtl is set).
    const resolveCategory = (override: number | null | undefined): number | null => {
      if (override === null) return null;
      if (typeof override === 'number') return override;
      // No override — fall back to defaultTtl. `null` here means no TTL
      // (defaultTtl unset).
      return typeof opts.defaultTtl === 'number' ? opts.defaultTtl : null;
    };
    // `streamingEvents` is the one category that does NOT fall back to
    // `defaultTtl` — operators must explicitly opt in. Auto-applying a
    // 30-day default would silently TTL-evict crashed-run buffers before
    // recovery had a chance to run; explicit opt-in keeps the safety
    // net under the operator's control.
    const resolveStreamingEvents = (override: number | null | undefined): number | null => {
      if (override === null || override === undefined) return null;
      if (typeof override === 'number') return override;
      return null;
    };
    const effectiveTtls = {
      session: resolveCategory(opts.ttls?.session),
      sessionMeta: resolveCategory(opts.ttls?.sessionMeta),
      checkpoint: resolveCategory(opts.ttls?.checkpoint),
      executionState: resolveCategory(opts.ttls?.executionState),
      executionHistory: resolveCategory(opts.ttls?.executionHistory),
      evalHistory: resolveCategory(opts.ttls?.evalHistory),
      memory: resolveCategory(opts.ttls?.memory),
      streamingEvents: resolveStreamingEvents(opts.ttls?.streamingEvents),
    };

    const store = new RedisStore(client, keyPrefix, effectiveTtls);

    // Lazy backfill of the new sorted-set indexes for installs upgrading
    // from pre-ZSET versions. Cheap when there's nothing to do (two ZCARD
    // calls); typically a few seconds for installs with sub-10k entries.
    // Users at six-figure counts opt out via `skipMigration: true`.
    if (!opts.skipMigration) {
      await store.backfillExecutionIndex();
      await store.backfillEvalIndex();
    }

    return store;
  }

  /**
   * Backfill the execution-history sorted-set from the legacy ID set.
   * Idempotent — runs only if the ZSET is missing entries the SET has.
   * Safe to call manually if you constructed the store with
   * `skipMigration: true`.
   */
  async backfillExecutionIndex(): Promise<void> {
    await this.backfillHistoryIndex(
      this.execHistorySetKey(),
      this.execHistoryZsetKey(),
      (id) => this.execHistoryKey(id),
      (raw) => {
        const exec = JSON.parse(raw) as ExecutionInfo;
        return typeof exec.startedAt === 'number'
          ? { score: exec.startedAt, value: exec.executionId }
          : null;
      },
      'execution-history',
    );
  }

  /** Backfill the eval-history sorted-set. Symmetric to `backfillExecutionIndex`. */
  async backfillEvalIndex(): Promise<void> {
    await this.backfillHistoryIndex(
      this.evalHistorySetKey(),
      this.evalHistoryZsetKey(),
      (id) => this.evalHistoryKey(id),
      (raw) => {
        const entry = JSON.parse(raw) as EvalHistoryEntry;
        return typeof entry.timestamp === 'number'
          ? { score: entry.timestamp, value: entry.id }
          : null;
      },
      'eval-history',
    );
  }

  /**
   * Shared implementation for both backfill paths. Reads SET members,
   * batch-MGETs their data blobs in chunks, and ZADDs each into the new
   * sorted-set inside a single MULTI per chunk.
   */
  private async backfillHistoryIndex(
    setKey: string,
    zsetKey: string,
    dataKey: (id: string) => string,
    scoreOf: (raw: string) => { score: number; value: string } | null,
    label: string,
  ): Promise<void> {
    const [setSize, zsetSize] = await Promise.all([
      this.client.sCard(setKey),
      this.client.zCard(zsetKey),
    ]);

    // ZSET has at least as many entries as the SET — backfill already done
    // (or the SET is empty and there's nothing to do). Bail.
    if (zsetSize >= setSize) return;

    const allIds = await this.client.sMembers(setKey);
    if (allIds.length === 0) return;

    const CHUNK_SIZE = 500;
    let migrated = 0;
    let skipped = 0;

    for (let i = 0; i < allIds.length; i += CHUNK_SIZE) {
      const chunk = allIds.slice(i, i + CHUNK_SIZE);
      const dataKeys = chunk.map((id) => dataKey(id));
      const raws = await this.client.mGet(dataKeys);

      const tx = this.client.multi();
      let queuedInChunk = 0;
      for (let j = 0; j < chunk.length; j++) {
        const raw = raws[j];
        if (raw == null) {
          // SET has the ID but no data blob — partial state from a
          // pre-MULTI/EXEC release. Skip; the reader's null-guard catches
          // this too.
          skipped++;
          continue;
        }
        try {
          const entry = scoreOf(raw);
          if (entry == null) {
            skipped++;
            continue;
          }
          tx.zAdd(zsetKey, entry);
          queuedInChunk++;
          migrated++;
        } catch {
          // Malformed JSON — skip and move on.
          skipped++;
        }
      }

      if (queuedInChunk > 0) await tx.exec();
    }

    if (migrated > 0 || skipped > 0) {
      console.log(
        `[axl] RedisStore: backfilled ${migrated} ${label} entries into sorted-set index` +
          (skipped > 0 ? ` (${skipped} skipped — missing or malformed)` : ''),
      );
    }
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

  // NOTE for future implementer of #3 (TTL config): when the executionHistory
  // and evalHistory data blobs gain TTLs, eviction MUST be driven by
  // ZREMRANGEBYSCORE on the ZSET below — NOT by SREM on these legacy ID sets.
  // The slow-path fallback (`listHistoryByZset`) reads from the SET when
  // `zsetCard < setCard`, so SET-based eviction would race with the fallback
  // and surface dead IDs whose data has been TTL'd away. ZSET eviction +
  // dual-write `SREM` is the clean path; doc the assumption then.
  private execHistorySetKey(): string {
    return `${this.keyPrefix}exec-history-ids`;
  }

  /**
   * Sorted-set index for execution history, scored by `startedAt`. Drives
   * the O(log N) `listExecutions` fast path; the legacy SET above is kept
   * as a fallback for users running with `skipMigration: true` before
   * they've called `backfillExecutionIndex()` manually.
   */
  private execHistoryZsetKey(): string {
    return `${this.keyPrefix}exec-history-z`;
  }

  private evalHistoryKey(id: string): string {
    return `${this.keyPrefix}eval-history:${id}`;
  }

  private evalHistorySetKey(): string {
    return `${this.keyPrefix}eval-history-ids`;
  }

  /** Sorted-set index for eval history, scored by `timestamp`. See above. */
  private evalHistoryZsetKey(): string {
    return `${this.keyPrefix}eval-history-z`;
  }

  private memoryKey(scope: string): string {
    return `${this.keyPrefix}memory:${scope}`;
  }

  // ── Streaming event buffer (for `state.persist: 'streaming'`) ─────────
  // Layout:
  //   `{prefix}exec-events:{id}` — a Redis list. Events are RPUSH'd as
  //     JSON-serialized AxlEvent objects, in batches. The runtime LRANGEs
  //     the whole list on recovery and deletes it via `finalizeStreamingEvents`
  //     once the canonical `executionHistory` blob has been written at
  //     terminal exit.
  //   `{prefix}streaming-exec-ids` — a Redis set tracking which executions
  //     have an active streaming buffer. Used by `listStreamingExecutions`
  //     to find runs whose process died mid-flight (no corresponding
  //     `executionHistory` blob).

  private streamingEventsKey(executionId: string): string {
    return `${this.keyPrefix}exec-events:${executionId}`;
  }

  private streamingIdsKey(): string {
    return `${this.keyPrefix}streaming-exec-ids`;
  }

  // ── Checkpoints ──────────────────────────────────────────────────────

  async saveCheckpoint(executionId: string, name: string, data: unknown): Promise<void> {
    const ttl = this.ttlFor('checkpoint');
    if (ttl === undefined) {
      await this.client.hSet(this.checkpointKey(executionId), name, JSON.stringify(data));
      return;
    }
    // Fixed window: set TTL only when the hash is new (`EXPIRE NX`), so
    // multiple `saveCheckpoint` calls for the same execution don't keep
    // extending the window. The hash itself ages out together with all
    // checkpoints belonging to that execution — which matches the
    // natural lifecycle (checkpoints belong to a specific run).
    await this.client
      .multi()
      .hSet(this.checkpointKey(executionId), name, JSON.stringify(data))
      .expire(this.checkpointKey(executionId), ttl, 'NX')
      .exec();
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
    //
    // TTL semantics: sliding window via `SET ... EX` — re-saving the session
    // refreshes the TTL each turn. Deliberate deviation from the "fixed
    // window" treatment in the original spec proposal: sessions ARE
    // user-activity-driven (each `Session.send()` is fresh interaction), so
    // an active chat should not time out mid-conversation. The "fixed window
    // from creation" mental model breaks for live chat — and a stale TTL
    // from a session that was created an hour ago but is still being used
    // every minute would be the wrong behavior. `memory` uses the same
    // semantics (sliding) for the same reason; sessions just happen to use
    // SET storage instead of a hash.
    const ttl = this.ttlFor('session');
    const setOptions = ttl !== undefined ? { EX: ttl } : undefined;
    await this.client
      .multi()
      .set(this.sessionKey(sessionId), JSON.stringify(history), setOptions)
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
    const ttl = this.ttlFor('sessionMeta');
    if (ttl === undefined) {
      await this.client.hSet(this.sessionMetaKey(sessionId), key, JSON.stringify(value));
      return;
    }
    // Sliding window: every write refreshes the TTL. SessionMeta entries
    // (handoff records, summary caches) belong to a session and must age
    // out together with it — the session itself uses sliding TTL on
    // `session`, so meta needs the same semantics or an actively-used
    // session would see handoff history evict while the conversation
    // stays alive. Previously used `EXPIRE ... NX` (fixed-from-first-
    // write), which produced exactly that drift.
    await this.client
      .multi()
      .hSet(this.sessionMetaKey(sessionId), key, JSON.stringify(value))
      .expire(this.sessionMetaKey(sessionId), ttl)
      .exec();
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
    //
    // TTL semantics: fixed window via `SET ... EX`. SET-with-EX always
    // refreshes the TTL on overwrite (no NX option here), which is correct
    // for execution state — each status transition should reset the
    // lifetime so a long-suspended workflow doesn't disappear mid-flight.
    const ttl = this.ttlFor('executionState');
    const setOptions = ttl !== undefined ? { EX: ttl } : undefined;
    const tx = this.client
      .multi()
      .set(this.executionStateKey(executionId), JSON.stringify(state), setOptions);
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
    const ids = await this.client.sMembers(this.pendingExecSetKey());
    if (ids.length === 0) return ids;
    // Prune stale ids whose state blob TTL'd away. Without this, the
    // pending-set bloats indefinitely against a TTL'd executionState
    // category — every awaitHuman-flow workflow that ages out without a
    // resolve() leaves its id behind. Bulk MGET, filter, fire SREM.
    const keys = ids.map((id) => this.executionStateKey(id));
    const raws = await this.client.mGet(keys);
    const live: string[] = [];
    const dead: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (raws[i] != null) {
        live.push(ids[i]);
      } else {
        dead.push(ids[i]);
      }
    }
    if (dead.length > 0) {
      // Fire-and-forget — listing must not block on cleanup. Pass the
      // array so node-redis batches it into one SREM round-trip.
      this.client.sRem(this.pendingExecSetKey(), dead).catch((err: unknown) => {
        console.error(
          `[axl] RedisStore: failed to prune ${dead.length} stale pending-exec ids: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      });
    }
    return live;
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
    const ttl = this.ttlFor('memory');
    if (ttl === undefined) {
      await this.client.hSet(this.memoryKey(scope), key, JSON.stringify(value));
      return;
    }
    // Sliding window: every write refreshes the TTL (no `NX` mode). Memory
    // is the only category that uses sliding — per-user memory should track
    // user activity, not creation time. Active users keep their memory;
    // inactive users forget after the configured idle period.
    await this.client
      .multi()
      .hSet(this.memoryKey(scope), key, JSON.stringify(value))
      .expire(this.memoryKey(scope), ttl)
      .exec();
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
    // Migrated successfully. If memory has a TTL configured, apply it so
    // the migrated entry participates in the same sliding-window eviction
    // as native saveMemory writes. Without this, a legacy entry would be
    // immortal until another saveMemory call against the same scope hit
    // the migration timing perfectly. Fire-and-forget — the user's value
    // is already authoritative; an EXPIRE failure is logged but not
    // surfaced.
    const ttl = this.ttlFor('memory');
    if (ttl !== undefined) {
      this.client.expire(this.memoryKey(scope), ttl).catch((err: unknown) => {
        console.error(
          `[axl] RedisStore: failed to set TTL on migrated memory key ${this.memoryKey(scope)}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      });
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
    // Atomic: index-set membership + data blob + sorted-set score commit
    // together. Before MULTI/EXEC, a crash between writes left
    // `listExecutions` returning IDs whose data was absent — graceful skip
    // covered it but at the cost of an N+1 fetch per read. Post-#4 the ZSET
    // gives us O(log N) score-ordered reads with one MGET; the SET is kept
    // as a fallback for installs that constructed with `skipMigration: true`.
    //
    // TTL semantics: fixed window via `SET ... EX` on the data blob. Index
    // entries (legacy SET + ZSET) intentionally have NO TTL — they're
    // small (just IDs) and eventually-consistent: when the data blob ages
    // out, mGet returns null and the reader filters it. Periodic cleanup
    // (manual `ZREMRANGEBYSCORE` + `SREM`) can prune index bloat, but
    // listExecutions stays correct regardless.
    const ttl = this.ttlFor('executionHistory');
    const setOptions = ttl !== undefined ? { EX: ttl } : undefined;
    await this.client
      .multi()
      .sAdd(this.execHistorySetKey(), execution.executionId)
      .set(this.execHistoryKey(execution.executionId), JSON.stringify(execution), setOptions)
      .zAdd(this.execHistoryZsetKey(), {
        score: execution.startedAt,
        value: execution.executionId,
      })
      .exec();
  }

  async getExecution(executionId: string): Promise<ExecutionInfo | null> {
    const raw = await this.client.get(this.execHistoryKey(executionId));
    return raw ? JSON.parse(raw) : null;
  }

  async listExecutions(limit?: number): Promise<ExecutionInfo[]> {
    return this.listHistoryByZset(
      this.execHistorySetKey(),
      this.execHistoryZsetKey(),
      (id) => this.execHistoryKey(id),
      (a, b) => b.startedAt - a.startedAt,
      limit,
    );
  }

  async deleteExecution(executionId: string): Promise<boolean> {
    // Atomic: data blob + index entries + EVERY per-execution side-key
    // removed together. Without the side-key sweep, a GDPR delete leaves
    // PII reachable via:
    //   - checkpoint:{id} (may contain step inputs/outputs)
    //   - exec-state:{id} (suspended-state snapshot)
    //   - exec-events:{id} + streaming-exec-ids membership (the streaming
    //     buffer; recoverIncompleteStreams could resurrect it as a new
    //     ExecutionInfo on next process start)
    //   - decisions hash field for this id (a pending `awaitHuman` decision
    //     — the workflow may have been mid-flight when the operator
    //     deleted; the resolver-side cleanup happens in `runtime.deleteExecution`)
    //
    // del()'s return is the "did it exist" signal for the canonical row —
    // second result in the exec() array (sRem queued first, del second).
    // Symmetric to deleteEvalResult on the index side.
    const [, deletedCount] = await this.client
      .multi()
      .sRem(this.execHistorySetKey(), executionId)
      .del(this.execHistoryKey(executionId))
      .zRem(this.execHistoryZsetKey(), executionId)
      .del(this.checkpointKey(executionId))
      .del(this.executionStateKey(executionId))
      .sRem(this.pendingExecSetKey(), executionId)
      .del(this.streamingEventsKey(executionId))
      .sRem(this.streamingIdsKey(), executionId)
      .hDel(this.decisionsKey(), executionId)
      .exec();
    const deleted = typeof deletedCount === 'number' ? deletedCount : 0;
    return deleted > 0;
  }

  // ── Eval History ────────────────────────────────────────────────────

  async saveEvalResult(entry: EvalHistoryEntry): Promise<void> {
    // Atomic, same partial-write concern as saveExecution; also writes the
    // sorted-set entry scored by timestamp for the listEvalResults fast path.
    // TTL semantics identical to saveExecution — data blob is fixed-window;
    // index entries have no TTL and age out lazily.
    const ttl = this.ttlFor('evalHistory');
    const setOptions = ttl !== undefined ? { EX: ttl } : undefined;
    await this.client
      .multi()
      .sAdd(this.evalHistorySetKey(), entry.id)
      .set(this.evalHistoryKey(entry.id), JSON.stringify(entry), setOptions)
      .zAdd(this.evalHistoryZsetKey(), { score: entry.timestamp, value: entry.id })
      .exec();
  }

  async listEvalResults(limit?: number): Promise<EvalHistoryEntry[]> {
    return this.listHistoryByZset(
      this.evalHistorySetKey(),
      this.evalHistoryZsetKey(),
      (id) => this.evalHistoryKey(id),
      (a, b) => b.timestamp - a.timestamp,
      limit,
    );
  }

  async deleteEvalResult(id: string): Promise<boolean> {
    // Atomic: index-set removal + data deletion + sorted-set removal commit
    // together. del()'s return is the "did it exist" signal — destructured
    // out of the exec() result so reordering the chain doesn't break the
    // boolean.
    const [, deletedCount] = await this.client
      .multi()
      .sRem(this.evalHistorySetKey(), id)
      .del(this.evalHistoryKey(id))
      .zRem(this.evalHistoryZsetKey(), id)
      .exec();
    const deleted = typeof deletedCount === 'number' ? deletedCount : 0;
    return deleted > 0;
  }

  /**
   * Shared list-by-sorted-set implementation. Uses ZREVRANGEBYSCORE +
   * MGET when the ZSET is populated (post-migration). Falls back to the
   * legacy SET + N×GET + JS-sort path when the ZSET is empty or smaller
   * than the SET (covers users that constructed with `skipMigration: true`
   * before calling backfill).
   */
  private async listHistoryByZset<T>(
    setKey: string,
    zsetKey: string,
    dataKey: (id: string) => string,
    sortCmp: (a: T, b: T) => number,
    limit?: number,
  ): Promise<T[]> {
    // Cheap probe: if the SET is empty, both indexes are empty and there's
    // nothing to list.
    const setSize = await this.client.sCard(setKey);
    if (setSize === 0) return [];

    const zsetSize = await this.client.zCard(zsetKey);

    // Fast path: ZSET has caught up with the SET (post-migration or only
    // ever had post-#4 writes). Use ZREVRANGEBYSCORE for ordered IDs, then
    // bulk MGET for the data.
    if (zsetSize >= setSize) {
      // Over-fetch when a limit is requested: TTL can evict data blobs
      // independent of ZSET entries, so MGET may return nulls. Without
      // over-fetch, a caller asking for `limit=10` while 3 entries have
      // been TTL'd between ZREVRANGEBYSCORE and MGET would silently get 7.
      // 2x with a +5 floor handles a reasonable amount of drift; if more
      // than half the requested entries are dead pointers, the slow-path
      // null-filter still applies and the caller gets best-effort up to
      // `limit`.
      const fetchCount = limit !== undefined ? Math.max(limit * 2, limit + 5) : undefined;
      // ZRANGE with BY:'SCORE' + REV:true is the node-redis v5 form of
      // "ZREVRANGEBYSCORE" (the dedicated method was removed in v5 in favor
      // of the parameterized zRange). With REV:true the start/stop args are
      // interpreted in descending order — pass `'+inf'` as start, `'-inf'`
      // as stop to walk from the highest score downward.
      const ids = await this.client.zRange(zsetKey, '+inf', '-inf', {
        BY: 'SCORE',
        REV: true,
        ...(fetchCount !== undefined ? { LIMIT: { offset: 0, count: fetchCount } } : {}),
      });
      if (ids.length === 0) return [];
      const keys = ids.map(dataKey);
      const raws = await this.client.mGet(keys);
      // Filter nulls (data dropped by TTL after the ZSET was queried) AND
      // parse failures. JSON.parse can throw — guard each row.
      const entries: T[] = [];
      for (const raw of raws) {
        if (raw == null) continue;
        try {
          entries.push(JSON.parse(raw) as T);
        } catch {
          // Malformed JSON; skip silently. Same posture as the SET path.
        }
        if (limit !== undefined && entries.length >= limit) break;
      }
      return entries;
    }

    // Slow path (legacy SET): the ZSET is behind the SET — either
    // backfill hasn't run yet (skipMigration: true) or it errored partway.
    // Read via SET + N×GET so users aren't blocked on the data they have.
    const ids = await this.client.sMembers(setKey);
    if (ids.length === 0) return [];
    const entries: T[] = [];
    for (const id of ids) {
      const raw = await this.client.get(dataKey(id));
      if (raw == null) continue;
      try {
        entries.push(JSON.parse(raw) as T);
      } catch {
        // skip malformed
      }
    }
    entries.sort(sortCmp);
    return limit ? entries.slice(0, limit) : entries;
  }

  // ── Sessions (Studio introspection) ────────────────────────────────────

  async listSessions(): Promise<string[]> {
    // Redis doesn't have a built-in way to list keys by pattern without SCAN,
    // so we maintain a set of session IDs alongside the session data.
    return this.client.sMembers(this.sessionIdsKey());
  }

  // ── Streaming events (for state.persist: 'streaming') ──────────────────

  async appendStreamingEvents(executionId: string, events: AxlEvent[]): Promise<void> {
    if (events.length === 0) return;
    // Serialize once; RPUSH multiple values in a single round-trip.
    const serialized = events.map((e) => JSON.stringify(e));
    // Wrap RPUSH + SADD + (optional) EXPIRE in a MULTI so the streaming-
    // exec-ids set membership and the data list stay in sync. A crash
    // between would otherwise leave events orphaned (in the list but not
    // in the index, so listStreamingExecutions wouldn't find them on
    // recovery).
    //
    // Fixed-from-first-write TTL via `EXPIRE NX`. Safety net for the
    // scenario where an operator forgets to wire `recoverIncompleteStreams`
    // into startup — without a TTL, crashed-process buffers accumulate
    // forever. The window starts at first append so all events for a
    // single run share one lifetime (vs sliding which would extend
    // indefinitely for a long-running streaming workflow).
    const ttl = this.ttlFor('streamingEvents');
    const tx = this.client
      .multi()
      .rPush(this.streamingEventsKey(executionId), serialized)
      .sAdd(this.streamingIdsKey(), executionId);
    if (ttl !== undefined) {
      tx.expire(this.streamingEventsKey(executionId), ttl, 'NX');
    }
    await tx.exec();
  }

  async finalizeStreamingEvents(executionId: string): Promise<void> {
    // Atomic: drop the events list + un-register from the in-flight index
    // together. Called from the runtime's finally hook AFTER the canonical
    // `executionHistory` blob has been written — so this deletion just
    // releases the streaming buffer (which is no longer load-bearing).
    await this.client
      .multi()
      .del(this.streamingEventsKey(executionId))
      .sRem(this.streamingIdsKey(), executionId)
      .exec();
  }

  async listStreamingExecutions(): Promise<string[]> {
    return this.client.sMembers(this.streamingIdsKey());
  }

  async getStreamingEvents(executionId: string): Promise<AxlEvent[]> {
    const raws = await this.client.lRange(this.streamingEventsKey(executionId), 0, -1);
    if (raws.length === 0) return [];
    const events: AxlEvent[] = [];
    for (const raw of raws) {
      try {
        events.push(JSON.parse(raw) as AxlEvent);
      } catch {
        // Skip malformed entries — same posture as the listExecutions
        // slow-path fallback. A corrupt event shouldn't crash recovery.
      }
    }
    return events;
  }

  /** Close the Redis connection. */
  async close(): Promise<void> {
    await this.client.quit();
  }

  async deleteCheckpoints(executionId: string): Promise<void> {
    await this.client.del(this.checkpointKey(executionId));
  }
}
