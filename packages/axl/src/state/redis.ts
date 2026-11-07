import { createHash } from 'node:crypto';
import type {
  AxlEvent,
  ChatMessage,
  HistoricalAxlEvent,
  HistoricalExecutionInfo,
  HumanDecision,
} from '../types.js';
import type {
  StateStore,
  SessionUpdate,
  PendingDecision,
  ExecutionState,
  EvalHistoryEntry,
  ExecutionCursor,
  HistoryRetentionCursor,
  HistoryRetentionOptions,
  HistoryRetentionResult,
} from './types.js';
import { AxlError } from '../errors.js';
import { normalizePersistedSessionHistory } from '../input.js';
import { updateSessionThroughOverrides } from './session-update.js';
import { getExecutionEventSchemaVersion, normalizeStoredExecution } from '../event-schema.js';
import { warnDiagnosticOnce } from '../schema-diagnostics.js';
import {
  PRUNE_BATCH,
  executionLastSavedAt,
  resolveHistoryRetentionOptions,
  retentionForUntimedRecord,
  warnExecutionRetentionUnset,
} from './retention.js';

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
  set(
    key: string,
    value: string,
    options?: { EX?: number; PX?: number; XX?: boolean; KEEPTTL?: boolean },
  ): Promise<string | null>;
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
  // PTTL reports a key's remaining TTL in ms: -1 = no TTL, -2 = no such key.
  // Used by getEvalRetention to derive an eval artifact's absolute expiry from
  // the server-side TTL that actually governs the history row.
  pTTL(key: string): Promise<number>;
  del(key: string | string[]): Promise<number>;
  sAdd(key: string, member: string | string[]): Promise<number>;
  sRem(key: string, member: string | string[]): Promise<number>;
  sCard(key: string): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  sScan(
    key: string,
    cursor: string,
    options?: { COUNT?: number },
  ): Promise<{ cursor: string; members: string[] }>;
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
  // Same range as zRange, with each member's score. Listing pages by
  // (score, member), so it needs the score of every member it reads,
  // including members whose data blob is already gone.
  zRangeWithScores(
    key: string,
    start: number | string,
    stop: number | string,
    options?: {
      BY?: 'SCORE' | 'LEX';
      REV?: boolean;
      LIMIT?: { offset: number; count: number };
    },
  ): Promise<Array<{ value: string; score: number }>>;
  // multi() opens a transaction. Queued commands execute atomically on
  // exec() — a crash mid-MULTI leaves none of the queued writes applied,
  // which is what we want for the multi-key writes (saveSession,
  // saveExecution, etc.) that previously could half-commit on failure.
  multi(): RedisMulti;
  // EVAL runs a Lua script atomically. Only PRUNE_HISTORY_INDEX_SCRIPT uses
  // it; every key the script touches is passed in `keys`.
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  // Sent when `responseTimeoutMs` is set, and by `close()`. Any reply, even an
  // error, shows the server is answering.
  ping(): Promise<unknown>;
  // node-redis reports its socket state here. Optional because a caller may inject a minimal client
  // shim that does not expose it.
  readonly isOpen?: boolean;
  // True only while connected and past the handshake. `isOpen && !isReady`
  // means node-redis is reconnecting. Optional for the same reason as isOpen.
  readonly isReady?: boolean;
  destroy?(): void;
  unref?(): void;
}

/** Client options {@link RedisStore.create} passes to node-redis. */
interface RedisClientOptions {
  url?: string;
  disableOfflineQueue: boolean;
  socket: {
    reconnectStrategy: (retries: number) => number | false;
    socketTimeout?: number;
  };
}

/** The node-redis client surface only `create()` needs, on top of {@link RedisClient}. */
interface ConnectableRedisClient extends RedisClient {
  connect(): Promise<unknown>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'connect' | 'ready', listener: () => void): unknown;
}

// Chainable transaction builder returned by `client.multi()`. Queues
// commands client-side; sends them in a single MULTI/EXEC round-trip
// when `.exec()` is awaited. Same surface as node-redis v5's `RedisMulti`,
// scoped to commands we actually use.
interface RedisMulti {
  set(key: string, value: string, options?: { EX?: number; PX?: number }): RedisMulti;
  del(key: string | string[]): RedisMulti;
  sAdd(key: string, member: string | string[]): RedisMulti;
  sRem(key: string, member: string | string[]): RedisMulti;
  hSet(key: string, field: string, value: string): RedisMulti;
  hDel(key: string, field: string | string[]): RedisMulti;
  expire(key: string, seconds: number, mode?: 'NX' | 'XX' | 'GT' | 'LT'): RedisMulti;
  // `condition: 'NX'` only adds members that are not there yet (ZADD NX);
  // the reply is the number of members added.
  zAdd(
    key: string,
    member: { score: number; value: string },
    options?: { condition?: 'NX' | 'XX' },
  ): RedisMulti;
  zRem(key: string, member: string | string[]): RedisMulti;
  // PEXPIREAT sets an absolute expiry in epoch ms. With `mode: 'NX'` it only
  // applies to a key with no TTL; a timestamp in the past deletes the key
  // (still subject to NX). Reply 1 if applied, 0 if not. Redis 7.0+ for NX.
  pExpireAt(key: string, msTimestamp: number, mode?: 'NX' | 'XX' | 'GT' | 'LT'): RedisMulti;
  rPush(key: string, values: string | string[]): RedisMulti;
  // exec() returns the per-command results in queued order. We don't
  // type-narrow individual results because the callers that need a result
  // (e.g. deleteEvalResult) cast at the call site.
  exec(): Promise<unknown[]>;
}

/**
 * A change in a {@link RedisStore}'s connection, passed to
 * {@link RedisStoreOptions.onConnectionEvent}.
 *
 * - `error`: the connection was lost or a reconnect attempt failed. Arrives
 *   once per attempt while Redis is down.
 * - `reconnected`: the store is connected again and commands work.
 */
export type RedisConnectionEvent = { type: 'error'; error: Error } | { type: 'reconnected' };

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
   * Called when the connection is lost, a reconnect attempt fails, or the
   * connection comes back, for routing to a logger, metrics, or a health check.
   * Replaces the default logging of one line per outage and one on recovery.
   *
   * Not called for a failed `create()`, whose rejection reports the failure,
   * or after `close()`. A callback that throws or rejects is reported with
   * `console.error` and otherwise ignored.
   */
  onConnectionEvent?: (event: RedisConnectionEvent) => void;
  /**
   * Reconnect when Redis stops answering, in milliseconds. Off by default.
   *
   * The store sends a `PING` about every third of this time. If one goes
   * unanswered for this long, it drops the connection and reconnects: calls in
   * flight reject, and calls made until it reconnects reject with
   * `REDIS_UNAVAILABLE`. `create()` also rejects if Redis hasn't finished
   * connecting within this time.
   *
   * It's a limit on the whole connection, not on one command, because replies
   * come back in order. Set it above your slowest expected command, or a large
   * save or busy server looks like a stall. A call that rejects this way may
   * still have been applied by Redis.
   */
  responseTimeoutMs?: number;
  /**
   * Set to `false` so that `create()` returns right away and the store connects
   * in the background, retrying until Redis is available. Calls reject with
   * `REDIS_UNAVAILABLE` until then. Defaults to `true`, where `create()` rejects
   * if Redis is unavailable, which surfaces bad configuration at startup.
   *
   * Requires {@link responseTimeoutMs}, so that a server that accepts the
   * connection but never answers can't leave it connecting forever. Nothing
   * rejects if the configuration is wrong: failed attempts go to
   * {@link onConnectionEvent}, and `isConnected` stays `false`. The startup
   * backfill runs after the first connection instead of during `create()`.
   */
  waitForConnection?: boolean;
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
   * - **Fixed from the first write**: `checkpoint`, `streamingEvents`
   *   (`EXPIRE ... NX`) and `evalHistory` (a re-save re-applies the remaining
   *   `PTTL`; `updateEvalResult` uses `KEEPTTL`). Later writes never extend
   *   the window, and an eval row that exists without a TTL stays untimed.
   * - **Restarted on every save**: `executionState`, `executionHistory`
   *   (`SET ... EX`). An execution record is kept for the full window after
   *   its last save, which is normally when the run finished.
   *
   * `executionHistory` and `evalHistory` have the same meaning as the
   * `ttls` option of `MemoryStore` and `SQLiteStore` (see `HistoryTtls`).
   * With neither `executionHistory` (any value, `null` included) nor
   * {@link defaultTtl} set, `create()` warns once per process that
   * execution history is kept forever.
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

type HistoryKind = 'execution' | 'eval';

/**
 * The keys behind one kind of history (executions or eval results):
 *
 * - `ids`: legacy id set, kept for the slow listing path and backfill.
 * - `time`: sorted set scored by `startedAt` / `timestamp`; drives listing.
 * - `expiry`: sorted set scored by the record's expiry (epoch ms). Only timed
 *   records are in it. The prune reads it to find index entries whose record
 *   may have expired.
 */
type HistoryIndex = {
  kind: HistoryKind;
  label: string;
  ids: string;
  time: string;
  expiry: string;
  dataKey(id: string): string;
  /** When the record in a blob was last saved, as far as it shows, or `null`. */
  lastSavedAtOf(raw: string): number | null;
};

/**
 * Index cleanup for one kind of history, run with EVAL so each id is checked
 * and updated atomically with respect to saves and deletes.
 *
 * KEYS: `[ids, time, expiry, dataKey(id_1), …, dataKey(id_n)]`.
 * ARGV: `[nowMs, id_1, …, id_n]`. For each id, by its blob's PTTL:
 *
 * - `-2` (blob gone): remove the id from all three index keys.
 * - `-1` (live, no TTL): remove it from the expiry set only.
 * - otherwise (live, timed): re-score its expiry entry to now + PTTL.
 *
 * It never adds to the id set or the time sorted set and never writes a
 * blob, so a missing blob is the only reason an id leaves the listing and a
 * deleted record cannot be indexed again. Returns how many ids it removed.
 *
 * Exported for tests only; not part of the public API.
 */
export const PRUNE_HISTORY_INDEX_SCRIPT = `
local now = tonumber(ARGV[1])
local removed = 0
for i = 2, #ARGV do
  local id = ARGV[i]
  local pttl = redis.call('PTTL', KEYS[i + 2])
  if pttl == -2 then
    redis.call('SREM', KEYS[1], id)
    redis.call('ZREM', KEYS[2], id)
    redis.call('ZREM', KEYS[3], id)
    removed = removed + 1
  elseif pttl == -1 then
    redis.call('ZREM', KEYS[3], id)
  else
    redis.call('ZADD', KEYS[3], string.format('%d', now + pttl), id)
  end
end
return removed
`;

/**
 * Removes ids from the listing set when their session is gone, and the
 * session's metadata with them. `ttls.session` and `ttls.sessionMeta` are
 * independent, so metadata can outlive its session, and once the id is gone
 * nothing could find that metadata to delete it. The script decides by what
 * exists when it runs, so a session saved just before it is kept.
 *
 * KEYS: the id set, then each id's session key and metadata key.
 * ARGV: the ids. Returns the ids it removed.
 *
 * Exported for tests only; not part of the public API.
 */
export const PRUNE_SESSION_IDS_SCRIPT = `
local removed = {}
for i, id in ipairs(ARGV) do
  if redis.call('EXISTS', KEYS[i * 2]) == 0 then
    redis.call('SREM', KEYS[1], id)
    redis.call('DEL', KEYS[i * 2 + 1])
    removed[#removed + 1] = id
  end
end
return removed
`;

/** Session ids checked per script run, and how many one save asks SSCAN for. */
const SESSION_ID_BATCH = 100;
const SESSION_SWEEP_COUNT = 50;

/**
 * Write a session only if it's unchanged since it was read, by comparing the
 * SHA-1 of the stored value. Hashing what's stored needs no version key or new
 * format, so a write from an older instance during a rolling deploy counts as
 * a change too.
 *
 * KEYS: `[session, sessionIds]`. ARGV: `[expectedSha1 or '' if absent, next,
 * ttlSeconds or '', sessionId]`. Returns 1 if written, 0 if the session changed.
 *
 * Exported for tests only; not part of the public API.
 */
export const UPDATE_SESSION_SCRIPT = `
local stored = redis.call('GET', KEYS[1])
local actual = stored and redis.sha1hex(stored) or ''
if actual ~= ARGV[1] then
  return 0
end
if ARGV[3] ~= '' then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
else
  redis.call('SET', KEYS[1], ARGV[2])
end
redis.call('SADD', KEYS[2], ARGV[4])
return 1
`;

/** How many writes `updateSession` tries before reporting a conflict. */
const UPDATE_SESSION_ATTEMPTS = 10;

/** A position in a history sorted set: score, then member. */
type HistoryPosition = { score: number; id: string };

/**
 * Redis orders members that share a score by their bytes. The listing walk
 * compares member ids the same way, so its cursor matches the server's order
 * exactly, including for non-ASCII ids.
 */
function compareMembers(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Newest first: score descending, then member descending. */
function compareNewestFirst(a: HistoryPosition, b: HistoryPosition): number {
  if (a.score !== b.score) return b.score - a.score;
  return compareMembers(b.id, a.id);
}

/**
 * Warn once per process when a `RedisStore` keeps execution history forever
 * because neither `ttls.executionHistory` (any value, `null` included) nor
 * `defaultTtl` was set. Called by `RedisStore.create()`.
 *
 * @internal Exported for tests; not on the public barrel.
 */
export function warnIfRedisExecutionRetentionUnset(opts: RedisStoreOptions): void {
  if (opts.ttls?.executionHistory === undefined && typeof opts.defaultTtl !== 'number') {
    warnExecutionRetentionUnset('RedisStore');
  }
}

/** How long `close()` waits for commands already sent to be answered. */
const CLOSE_TIMEOUT_MS = 2000;

/** Matches node-redis's default backoff: exponential, capped at 2 s, with up to 200 ms of jitter. */
function reconnectDelayMs(retries: number): number {
  return Math.min(2 ** retries * 50, 2000) + Math.floor(Math.random() * 200);
}

/** Close a client's socket now, rejecting any commands still waiting for an answer. */
function abandonConnection(client: RedisClient): void {
  try {
    client.destroy?.();
  } catch {
    // Another close got there first, and the socket is already closed.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where connection events go. A throw from here would escape into node-redis's
 * socket handler and become the uncaught exception this exists to prevent, so
 * a host callback is contained against both throwing and rejecting.
 */
function connectionEventReporter(
  client: RedisClient,
  onConnectionEvent: RedisStoreOptions['onConnectionEvent'],
): (event: RedisConnectionEvent) => void {
  if (onConnectionEvent) {
    const reportFailure = (error: unknown) =>
      console.error(`[axl] RedisStore: onConnectionEvent failed: ${errorMessage(error)}`);
    return (event) => {
      try {
        Promise.resolve(onConnectionEvent(event) as unknown).catch(reportFailure);
      } catch (error) {
        reportFailure(error);
      }
    };
  }
  let outageLogged = false;
  return (event) => {
    if (event.type === 'reconnected') {
      outageLogged = false;
      console.warn('[axl] RedisStore: reconnected to Redis.');
    } else if (!outageLogged) {
      // An error on a healthy connection has no matching recovery to reset the flag.
      outageLogged = client.isReady === false;
      console.warn(
        `[axl] RedisStore: Redis connection lost (${event.error.message}). Store calls fail ` +
          'until it reconnects, which happens automatically.',
      );
    }
  };
}

/** A deadline timer this much late means the event loop was blocked, not Redis. */
const LOOP_STALL_TOLERANCE_MS = 100;
/**
 * Extra time a late deadline waits, once, so a reply held up by the blocked loop
 * can be read. Only once: on a loop that stays busy every timer is late, and
 * waiting again each time would never detect a stalled server.
 */
const LOOP_STALL_GRACE_MS = 1000;

/**
 * Reconnect `client` when a `PING` goes unanswered for `timeoutMs`. Returns a
 * function that stops watching.
 *
 * This is a deadline on a reply rather than node-redis's `socketTimeout`, which
 * is an idle timer that every write resets: an instance that keeps sending
 * commands to a stalled server would never trip it. `commandOptions.timeout`
 * doesn't help either, because node-redis drops it once a command is written.
 *
 * Only a ready client is reset. A reconnect in progress has a retry loop that
 * a second `connect()` would run alongside, and `socketTimeout` already bounds
 * its handshake.
 */
function watchResponses(
  client: ConnectableRedisClient,
  timeoutMs: number,
  reportConnectionEvent: (event: RedisConnectionEvent) => void,
): () => void {
  const checkEveryMs = timeoutMs / 3;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = (run: () => void, delayMs: number) => {
    timer = setTimeout(run, delayMs);
    timer.unref?.();
  };

  const check = () => {
    if (client.isReady === false) {
      schedule(check, checkEveryMs);
      return;
    }
    let settled = false;
    const onReply = () => {
      if (settled || stopped) return;
      settled = true;
      clearTimeout(timer);
      schedule(check, checkEveryMs);
    };
    const expireAfter = (delayMs: number, mayWaitForBlockedLoop: boolean) => {
      const dueAt = Date.now() + delayMs;
      schedule(() => {
        if (settled || stopped) return;
        if (mayWaitForBlockedLoop && Date.now() - dueAt > LOOP_STALL_TOLERANCE_MS) {
          expireAfter(LOOP_STALL_GRACE_MS, false);
          return;
        }
        reset();
      }, delayMs);
    };
    const reset = () => {
      settled = true;
      // Dropped since the check began: its own retry loop is already running.
      if (client.isReady === false) {
        schedule(check, checkEveryMs);
        return;
      }
      // Rejects every command in flight, transactions included.
      client.destroy?.();
      // Retries by itself, so this settles only on success or close().
      client.connect().catch(() => {});
      reportConnectionEvent({
        type: 'error',
        error: new Error(`Redis did not answer within ${timeoutMs}ms; reconnecting.`),
      });
      schedule(check, checkEveryMs);
    };
    client.ping().then(onReply, onReply);
    expireAfter(timeoutMs, true);
  };

  schedule(check, checkEveryMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * Reject when `connecting` hasn't finished within `timeoutMs`: a server can
 * accept the connection and then never answer the handshake.
 */
async function connectWithin(connecting: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connecting,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AxlError(
                'REDIS_UNAVAILABLE',
                `RedisStore: Redis did not finish connecting within ${timeoutMs}ms.`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create and connect a client whose connection problems can't reach the host
 * process as uncaught exceptions. Returns it with the function that stops its
 * response watch.
 */
async function connectClient(
  createClient: (clientOpts: RedisClientOptions) => ConnectableRedisClient,
  opts: RedisStoreOptions,
): Promise<{ client: ConnectableRedisClient; stopResponseWatch?: () => void }> {
  // A failed first connection must reject `create()` rather than retry
  // forever, so hosts see bad config at startup. Only reconnect after the
  // connection has worked once, unless the host asked to connect in the background.
  const inBackground = opts.waitForConnection === false;
  let established = inBackground;
  let everFailed = false;
  const responseTimeoutMs = opts.responseTimeoutMs;
  const client = createClient({
    ...(opts.url ? { url: opts.url } : {}),
    // A command accepted just before a drop rejects instead of waiting for
    // the reconnect.
    disableOfflineQueue: true,
    socket: {
      reconnectStrategy: (retries) => (established ? reconnectDelayMs(retries) : false),
      // Bounds a reconnect's handshake, where the response watch doesn't run.
      // Twice the timeout so that on an open connection the watch acts first:
      // this timer fires after any long event-loop block, which the watch allows for.
      ...(responseTimeoutMs !== undefined ? { socketTimeout: responseTimeoutMs * 2 } : {}),
    },
  });
  // node-redis reports a closed socket as an `error` event. With no listener,
  // Node throws it as an uncaught exception and the host process exits.
  const reportConnectionEvent = connectionEventReporter(client, opts.onConnectionEvent);
  client.on('error', (error) => {
    if (!established || client.isOpen === false) return;
    everFailed = true;
    reportConnectionEvent({
      type: 'error',
      error: error instanceof Error ? error : new Error(String(error)),
    });
  });
  // A reconnect attempt already mid-connect survives `destroy()`: node-redis
  // keeps going once the TCP connect finishes, and offers no way to close that
  // socket. Unreferencing it here keeps it from holding the process open; it
  // stays connected to Redis, idle, until the process exits.
  client.on('connect', () => {
    if (client.isOpen === false) client.unref?.();
  });
  client.on('ready', () => {
    if (!established) {
      established = true;
    } else if (client.isOpen !== false && (!inBackground || everFailed)) {
      reportConnectionEvent({ type: 'reconnected' });
    }
  });
  if (inBackground) {
    // Retries by itself, so this settles only on success or close().
    client.connect().catch(() => {});
    return {
      client,
      stopResponseWatch: watchResponses(client, responseTimeoutMs!, reportConnectionEvent),
    };
  }
  if (responseTimeoutMs === undefined) {
    await client.connect();
    return { client };
  }
  try {
    await connectWithin(client.connect(), responseTimeoutMs);
  } catch (error) {
    abandonConnection(client);
    throw error;
  }
  return {
    client,
    stopResponseWatch: watchResponses(client, responseTimeoutMs, reportConnectionEvent),
  };
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
  /** Set when `close()` starts, while the connection is still open. */
  private closing = false;
  /** Where the next save's check of listed sessions picks up. */
  private sessionSweepCursor = '0';
  /** Overlapping saves would all check the same page, so only one checks at a time. */
  private sessionSweepRunning = false;

  private constructor(
    private connection: RedisClient,
    private keyPrefix: string,
    private ttls: ResolvedTtls,
  ) {}

  /**
   * Whether the store can send commands right now, for a health check or for
   * telling an outage from other failures when a call rejects. `false` while
   * reconnecting and after `close()`.
   */
  get isConnected(): boolean {
    return !this.closing && this.connection.isOpen !== false && this.connection.isReady !== false;
  }

  /**
   * The client for sending a command, failing immediately while disconnected.
   *
   * Every command goes through here because node-redis's `disableOfflineQueue`
   * rejects single commands but not `multi().exec()`, which would wait for a
   * reconnect attempt to fail or succeed. Nothing may `await` between
   * `client.multi()` and `.exec()`, or a transaction could get past this check.
   *
   * A closed store isn't "unavailable": it falls through to node-redis's own
   * "The client is closed" rejection.
   */
  private get client(): RedisClient {
    // Same rejection as after `close()` finishes. A command sent now could
    // apply in Redis and still be rejected when the socket closes.
    if (this.closing) throw new Error('The client is closed');
    if (this.connection.isOpen !== false && this.connection.isReady === false) {
      throw new AxlError(
        'REDIS_UNAVAILABLE',
        'RedisStore: not connected to Redis, so the command was not sent. ' +
          'The store reconnects automatically; retry once Redis is back.',
      );
    }
    return this.connection;
  }

  /**
   * History kinds with a prune running in this process. A save skips its
   * prune while another one of the same kind is in flight: the running one
   * already covers the oldest expired entries. Created lazily so the
   * instance needs no constructor state.
   */
  private prunesInFlight?: Set<HistoryKind>;

  /** Stops the `responseTimeoutMs` health checks; unset when the option is off. */
  private stopResponseWatch?: () => void;

  /**
   * Supports `listExecutions(limit, { cursor })`. A getter rather than a
   * field so it lives on the prototype.
   */
  get historyPaging(): boolean {
    return true;
  }

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

    const responseTimeoutMs = opts.responseTimeoutMs;
    if (
      responseTimeoutMs !== undefined &&
      !(Number.isFinite(responseTimeoutMs) && responseTimeoutMs > 0)
    ) {
      throw new Error(
        `RedisStore: responseTimeoutMs must be a positive number of milliseconds, got ${responseTimeoutMs}.`,
      );
    }
    if (opts.waitForConnection === false && responseTimeoutMs === undefined) {
      throw new Error(
        'RedisStore: waitForConnection: false requires responseTimeoutMs, so a server that ' +
          'accepts the connection but never answers cannot leave it connecting forever.',
      );
    }

    let createClient: (clientOpts: RedisClientOptions) => ConnectableRedisClient;
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

    const { client, stopResponseWatch } = await connectClient(createClient, opts);

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
    store.stopResponseWatch = stopResponseWatch;
    warnIfRedisExecutionRetentionUnset(opts);

    if (opts.waitForConnection === false) {
      if (!opts.skipMigration) store.backfillOnceConnected(client);
      return store;
    }

    // Lazy backfill of the new sorted-set indexes for installs upgrading
    // from pre-ZSET versions. Cheap when there's nothing to do (two ZCARD
    // calls); typically a few seconds for installs with sub-10k entries.
    // Users at six-figure counts opt out via `skipMigration: true`.
    if (!opts.skipMigration) {
      try {
        await store.backfillExecutionIndex();
        await store.backfillEvalIndex();
      } catch (error) {
        // The caller never gets the store, so nothing else could stop the
        // client reconnecting forever.
        stopResponseWatch?.();
        abandonConnection(client);
        throw error;
      }
    }

    return store;
  }

  /**
   * Run the startup backfill when a connection becomes ready, until it succeeds.
   * Nothing is waiting on it, and listings work without it, so a failure is
   * reported and the next connection tries again.
   */
  private backfillOnceConnected(client: ConnectableRedisClient): void {
    let state: 'waiting' | 'running' | 'done' = 'waiting';
    client.on('ready', () => {
      if (state !== 'waiting') return;
      state = 'running';
      this.backfillExecutionIndex()
        .then(() => this.backfillEvalIndex())
        .then(
          () => {
            state = 'done';
          },
          (err: unknown) => {
            state = 'waiting';
            // A lost connection is already reported, and the next one retries.
            if (client.isReady === false || client.isOpen === false) return;
            console.warn(
              '[axl] RedisStore: the startup index backfill failed ' +
                `(${errorMessage(err)}). Listings stay correct meanwhile.`,
            );
          },
        );
    });
  }

  /**
   * Backfill the execution-history sorted-set from the legacy ID set.
   * Idempotent — runs only if the ZSET is missing entries the SET has.
   * Safe to call manually if you constructed the store with
   * `skipMigration: true`.
   */
  async backfillExecutionIndex(): Promise<void> {
    await this.backfillHistoryIndex(this.historyIndex('execution'), (raw) => {
      const exec = JSON.parse(raw) as HistoricalExecutionInfo;
      return typeof exec.startedAt === 'number'
        ? { score: exec.startedAt, value: exec.executionId }
        : null;
    });
  }

  /** Backfill the eval-history sorted-set. Symmetric to `backfillExecutionIndex`. */
  async backfillEvalIndex(): Promise<void> {
    await this.backfillHistoryIndex(this.historyIndex('eval'), (raw) => {
      const entry = JSON.parse(raw) as EvalHistoryEntry;
      return typeof entry.timestamp === 'number'
        ? { score: entry.timestamp, value: entry.id }
        : null;
    });
  }

  /**
   * Shared implementation for both backfill paths. Reads SET members,
   * batch-MGETs their data blobs in chunks, and ZADDs each into the new
   * sorted-set inside a single MULTI per chunk.
   *
   * Ids with no data blob are removed from the id set. Left there, the set stays
   * larger than the sorted set, so every startup repeats this walk and listing
   * stays on its slow path.
   */
  private async backfillHistoryIndex(
    index: HistoryIndex,
    scoreOf: (raw: string) => { score: number; value: string } | null,
  ): Promise<void> {
    const setKey = index.ids;
    const zsetKey = index.time;
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
    const missing: string[] = [];

    for (let i = 0; i < allIds.length; i += CHUNK_SIZE) {
      const chunk = allIds.slice(i, i + CHUNK_SIZE);
      const dataKeys = chunk.map((id) => index.dataKey(id));
      const raws = await this.client.mGet(dataKeys);

      const tx = this.client.multi();
      let queuedInChunk = 0;
      for (let j = 0; j < chunk.length; j++) {
        const raw = raws[j];
        if (raw == null) {
          // SET has the ID but no data blob — partial state from a
          // pre-MULTI/EXEC release. The reader's null-guard catches this too.
          skipped++;
          missing.push(chunk[j]);
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

    // The script checks each blob again, so an id saved since the read stays.
    if (missing.length > 0) {
      await this.runPruneScript(index, missing).catch((err: unknown) =>
        this.warnPruneFailed(index, err),
      );
    }

    if (migrated > 0 || skipped > 0) {
      console.log(
        `[axl] RedisStore: backfilled ${migrated} ${index.label} entries into sorted-set index` +
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

  // The legacy id set and the sorted set below always change together (save,
  // delete, prune), so the slow-path guard `ZCARD >= SCARD` in
  // `listHistoryByZset` and backfill stays meaningful.
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

  /** Keys and blob parsing for one kind of history. See {@link HistoryIndex}. */
  private historyIndex(kind: HistoryKind): HistoryIndex {
    if (kind === 'execution') {
      return {
        kind,
        label: 'execution-history',
        ids: this.execHistorySetKey(),
        time: this.execHistoryZsetKey(),
        expiry: `${this.keyPrefix}exec-history-exp`,
        dataKey: (id) => this.execHistoryKey(id),
        lastSavedAtOf: (raw) => {
          const record = JSON.parse(raw) as HistoricalExecutionInfo;
          return typeof record.startedAt === 'number' ? executionLastSavedAt(record) : null;
        },
      };
    }
    return {
      kind,
      label: 'eval-history',
      ids: this.evalHistorySetKey(),
      time: this.evalHistoryZsetKey(),
      expiry: `${this.keyPrefix}eval-history-exp`,
      dataKey: (id) => this.evalHistoryKey(id),
      // Eval retention counts from the first write, which is the row's timestamp.
      lastSavedAtOf: (raw) => {
        const timestamp = (JSON.parse(raw) as EvalHistoryEntry).timestamp;
        return typeof timestamp === 'number' ? timestamp : null;
      },
    };
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
      .set(
        this.sessionKey(sessionId),
        JSON.stringify(normalizePersistedSessionHistory(history)),
        setOptions,
      )
      .sAdd(this.sessionIdsKey(), sessionId)
      .exec();
    await this.sweepSessionIds();
  }

  async updateSession(sessionId: string, update: SessionUpdate): Promise<void> {
    if (
      this.saveSession !== RedisStore.prototype.saveSession ||
      this.getSession !== RedisStore.prototype.getSession
    ) {
      return updateSessionThroughOverrides(this, 'RedisStore', sessionId, update);
    }
    const key = this.sessionKey(sessionId);
    const ttl = this.ttlFor('session');
    for (let attempt = 0; attempt < UPDATE_SESSION_ATTEMPTS; attempt++) {
      const raw = await this.client.get(key);
      const next = update(raw ? (JSON.parse(raw) as ChatMessage[]) : null);
      if (next === null) return;
      let written: unknown;
      try {
        written = await this.client.eval(UPDATE_SESSION_SCRIPT, {
          keys: [key, this.sessionIdsKey()],
          arguments: [
            raw === null ? '' : createHash('sha1').update(raw).digest('hex'),
            JSON.stringify(normalizePersistedSessionHistory(next)),
            ttl === undefined ? '' : String(ttl),
            sessionId,
          ],
        });
      } catch (err) {
        if (!errorMessage(err).includes('NOPERM')) throw err;
        warnDiagnosticOnce(
          'redis_update_session_denied',
          'RedisStore: saving a session turn safely runs a Lua script, which this Redis user ' +
            'may not run, so it was saved without that protection. Overlapping turns from ' +
            'different instances can overwrite each other until the user may run EVAL.',
          undefined,
          'docs/api-reference.md#concurrency-and-races',
        );
        await this.saveSession(sessionId, next);
        return;
      }
      if (Number(written) === 1) {
        await this.sweepSessionIds();
        return;
      }
      const backoffMs = Math.min(20 * 2 ** attempt, 200);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * backoffMs));
    }
    throw new AxlError(
      'SESSION_CONFLICT',
      `RedisStore: gave up saving session "${sessionId}" after ${UPDATE_SESSION_ATTEMPTS} ` +
        'conflicting writes from other instances.',
    );
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
      this.connection.sRem(this.pendingExecSetKey(), dead).catch((err: unknown) => {
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
      this.connection.expire(this.memoryKey(scope), ttl).catch((err: unknown) => {
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

  async saveExecution(execution: HistoricalExecutionInfo): Promise<void> {
    // Atomic: index-set membership + data blob + sorted-set score commit
    // together. Before MULTI/EXEC, a crash between writes left
    // `listExecutions` returning IDs whose data was absent — graceful skip
    // covered it but at the cost of an N+1 fetch per read. Post-#4 the ZSET
    // gives us O(log N) score-ordered reads with one MGET; the SET is kept
    // as a fallback for installs that constructed with `skipMigration: true`.
    //
    // TTL semantics: the window restarts on every save (`SET ... EX`). Index
    // members cannot carry a TTL, so a timed record is also written to the
    // expiry sorted set, scored by when it expires; the prune that follows
    // every save uses it to remove index entries whose record has aged out.
    // An untimed save takes the id out of the expiry set, so a record that
    // stops being timed is never pruned.
    const ttl = this.ttlFor('executionHistory');
    const setOptions = ttl !== undefined ? { EX: ttl } : undefined;
    const index = this.historyIndex('execution');
    const id = execution.executionId;
    const storedExecution = normalizeStoredExecution({
      ...execution,
      eventSchemaVersion: getExecutionEventSchemaVersion(execution),
    } as HistoricalExecutionInfo);
    const tx = this.client
      .multi()
      .sAdd(index.ids, id)
      .set(index.dataKey(id), JSON.stringify(storedExecution), setOptions)
      .zAdd(index.time, { score: execution.startedAt, value: id });
    if (ttl !== undefined) tx.zAdd(index.expiry, { score: Date.now() + ttl * 1000, value: id });
    else tx.zRem(index.expiry, id);
    await tx.exec();
    await this.pruneHistoryAfterSave(index);
  }

  async getExecution(executionId: string): Promise<HistoricalExecutionInfo | null> {
    const raw = await this.client.get(this.execHistoryKey(executionId));
    return raw ? normalizeStoredExecution(JSON.parse(raw) as HistoricalExecutionInfo) : null;
  }

  async listExecutions(
    limit?: number,
    options?: { cursor?: ExecutionCursor },
  ): Promise<HistoricalExecutionInfo[]> {
    const cursor = options?.cursor;
    const executions = await this.listHistoryByZset<HistoricalExecutionInfo>(
      this.historyIndex('execution'),
      (e) => ({ score: e.startedAt, id: e.executionId }),
      limit,
      cursor !== undefined ? { score: cursor.startedAt, id: cursor.executionId } : undefined,
    );
    return executions.map(normalizeStoredExecution);
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
    // Any positive mutation means the execution existed on at least one
    // surface. This matters for fail-closed pending decisions that may have
    // no canonical history blob yet: deleting the decision is still a
    // successful total deletion and must return true.
    const index = this.historyIndex('execution');
    const results = await this.client
      .multi()
      .sRem(index.ids, executionId)
      .del(index.dataKey(executionId))
      .zRem(index.time, executionId)
      .zRem(index.expiry, executionId)
      .del(this.checkpointKey(executionId))
      .del(this.executionStateKey(executionId))
      .sRem(this.pendingExecSetKey(), executionId)
      .del(this.streamingEventsKey(executionId))
      .sRem(this.streamingIdsKey(), executionId)
      .hDel(this.decisionsKey(), executionId)
      .exec();
    return results.some((result) => typeof result === 'number' && result > 0);
  }

  // ── Eval History ────────────────────────────────────────────────────

  /**
   * Write an eval history row.
   *
   * **Re-saving an existing eval result never extends its retention.** Only a
   * genuinely new key gets the configured window; an existing one keeps the
   * time it had left. A result is re-saved by corrections that have nothing to
   * do with the operator's retention policy — the diagnostics sweep rewriting a
   * row whose artifact it just reclaimed, a commit failure downgrading one —
   * and a plain `SET ... EX` would renew a full window on every one of them,
   * silently keeping item inputs, outputs and scores alive indefinitely on a
   * server that corrects rows often enough.
   *
   * The remaining window is read with `PTTL` and re-applied as `PX` rather than
   * using `KEEPTTL`. Both need an existence check the SET cannot share a
   * transaction with, so both race a key expiring in between — but the failure
   * modes differ, and only one is safe: `KEEPTTL` on a key that expired in the
   * gap recreates it with NO expiry at all, an immortal row holding exactly the
   * data retention exists to age out. Every `PX` branch leaves a bounded
   * lifetime, so the race costs at most one window's length, never the window
   * itself. It also carries no Redis version floor, where `KEEPTTL` needs 6.0.
   *
   * As with `saveExecution`, a timed row is also scored in the expiry sorted
   * set (by the expiry it carries, so a re-save keeps its score), an untimed
   * one is taken out of it, and a bounded prune follows the save.
   */
  async saveEvalResult(entry: EvalHistoryEntry): Promise<void> {
    const ttl = this.ttlFor('evalHistory');
    const index = this.historyIndex('eval');
    const key = index.dataKey(entry.id);
    let setOptions: { EX: number } | { PX: number } | undefined;
    let expiresAt: number | undefined;
    if (ttl !== undefined) {
      // -2 no such key, -1 the key exists with no TTL, otherwise ms remaining.
      const remaining = await this.client.pTTL(key);
      // -1 is a DELIBERATELY untimed row: an operator ran PERSIST, or the row
      // predates `ttls.evalHistory`. Stamping the configured window on it would
      // shorten its retention from forever to finite, which is the same
      // violation as extending one, pointed the other way.
      if (remaining === -2) {
        setOptions = { EX: ttl };
        expiresAt = Date.now() + ttl * 1000;
      } else if (remaining > 0) {
        setOptions = { PX: remaining };
        expiresAt = Date.now() + remaining;
      }
    }
    const tx = this.client
      .multi()
      .sAdd(index.ids, entry.id)
      .set(key, JSON.stringify(entry), setOptions)
      .zAdd(index.time, { score: entry.timestamp, value: entry.id });
    if (expiresAt !== undefined) tx.zAdd(index.expiry, { score: expiresAt, value: entry.id });
    else tx.zRem(index.expiry, entry.id);
    await tx.exec();
    await this.pruneHistoryAfterSave(index);
  }

  /**
   * Update-only write: see `StateStore.updateEvalResult`.
   *
   * One `SET key value XX KEEPTTL`, which is atomic and therefore has no
   * check-then-write window at all: `XX` refuses a key that is not there, so a
   * delete or an expiry racing the correction wins, and `KEEPTTL` leaves the
   * remaining lifetime untouched, so the correction carries no retention
   * decision of its own.
   *
   * **Requires Redis 6.0 or newer** (`KEEPTTL`). An older server rejects the
   * option with a syntax error, which is translated into a
   * `REDIS_VERSION_UNSUPPORTED` {@link AxlError} naming the floor — a
   * misconfiguration, not a failed write, and the one thing in `RedisStore`
   * that needs 6.0. Silently resetting the retention window instead is the one
   * outcome this write exists to rule out.
   *
   * The index members are deliberately not re-added: the row already exists, so
   * they are already there, and writing them for a key that vanished is exactly
   * the resurrection this avoids.
   */
  async updateEvalResult(entry: EvalHistoryEntry): Promise<boolean> {
    let result: string | null;
    try {
      result = await this.client.set(this.evalHistoryKey(entry.id), JSON.stringify(entry), {
        XX: true,
        KEEPTTL: true,
      });
    } catch (err) {
      // Redis reports an unknown SET option as a plain syntax error, so the
      // version floor is what a syntax error on THIS command means. Raising a
      // distinct code keeps the runtime from reading a misconfigured server as
      // an ordinary failed write and retrying it forever.
      if (!/syntax error/i.test((err as Error | undefined)?.message ?? '')) throw err;
      throw new AxlError(
        'REDIS_VERSION_UNSUPPORTED',
        'RedisStore.updateEvalResult requires Redis 6.0 or newer: this server rejected ' +
          '`SET key value XX KEEPTTL`. Eval history corrections cannot be persisted ' +
          'retention-neutrally against it.',
      );
    }
    return result !== null;
  }

  async listEvalResults(limit?: number): Promise<EvalHistoryEntry[]> {
    return this.listHistoryByZset<EvalHistoryEntry>(
      this.historyIndex('eval'),
      (e) => ({ score: e.timestamp, id: e.id }),
      limit,
    );
  }

  async deleteEvalResult(id: string): Promise<boolean> {
    // Atomic: index-set removal + data deletion + sorted-set removal commit
    // together. del()'s return is the "did it exist" signal — destructured
    // out of the exec() result so reordering the chain doesn't break the
    // boolean.
    const index = this.historyIndex('eval');
    const [, deletedCount] = await this.client
      .multi()
      .sRem(index.ids, id)
      .del(index.dataKey(id))
      .zRem(index.time, id)
      .zRem(index.expiry, id)
      .exec();
    const deleted = typeof deletedCount === 'number' ? deletedCount : 0;
    return deleted > 0;
  }

  /**
   * Existence + absolute expiry for one eval history row.
   *
   * `PTTL` is the authority here rather than the configured `ttls.evalHistory`:
   * the row may have been written under a different configuration, re-saved, or
   * had its TTL cleared out of band, and an artifact swept on a stale
   * assumption is deleted diagnostic evidence the user still owns.
   *
   * Redis expires the row server-side without telling anyone, so the absolute
   * `expiresAt` returned here is mirrored onto the artifact manifest and the
   * physical bytes are reclaimed by the next sweep (or by startup reconciliation
   * if the process was down when the key aged out) — eventual, not synchronous.
   */
  async getEvalRetention(id: string): Promise<{ exists: boolean; expiresAt?: number }> {
    const ttl = await this.client.pTTL(this.evalHistoryKey(id));
    if (ttl === -2) return { exists: false };
    if (typeof ttl !== 'number' || ttl < 0) return { exists: true };
    return { exists: true, expiresAt: Date.now() + ttl };
  }

  /**
   * Shared list-by-sorted-set implementation, newest first by
   * `(score DESC, member DESC)`, starting strictly after `cursor` when given.
   *
   * Fast path (the time sorted set is at least as large as the id set): walk
   * the sorted set in chunks and MGET each chunk's blobs. Index entries whose
   * blob is gone (expired, or deleted before the prune caught up) are skipped,
   * and the walk keeps reading until it has `limit` live records or the set
   * runs out, however many dead entries are in the way. Each chunk restarts
   * at the last member read, by score and member, rather than at an offset,
   * so entries added or removed meanwhile cannot shift the walk.
   *
   * Slow path (the time sorted set is behind the id set: backfill has not
   * run): read every id with GET, then sort and apply the cursor in process.
   */
  private async listHistoryByZset<T>(
    index: HistoryIndex,
    positionOf: (entry: T) => HistoryPosition,
    limit?: number,
    cursor?: HistoryPosition,
  ): Promise<T[]> {
    // Cheap probe: if the SET is empty, both indexes are empty and there's
    // nothing to list.
    const setSize = await this.client.sCard(index.ids);
    if (setSize === 0) return [];

    const zsetSize = await this.client.zCard(index.time);
    const max = limit ? limit : undefined;

    if (zsetSize < setSize) {
      // Slow path (legacy SET): read via SET + N×GET so users aren't blocked
      // on the data they have.
      const ids = await this.client.sMembers(index.ids);
      const entries: T[] = [];
      for (const id of ids) {
        const raw = await this.client.get(index.dataKey(id));
        if (raw == null) continue;
        try {
          entries.push(JSON.parse(raw) as T);
        } catch {
          // skip malformed
        }
      }
      const ordered = entries
        .filter((e) => cursor === undefined || compareNewestFirst(cursor, positionOf(e)) < 0)
        .sort((a, b) => compareNewestFirst(positionOf(a), positionOf(b)));
      return max !== undefined ? ordered.slice(0, max) : ordered;
    }

    const results: T[] = [];
    const seen = new Set<string>();
    // Results start strictly after `bound`: the cursor, then the last record
    // returned.
    let bound = cursor;
    // Reads cover the members scored at most `rangeMax`, newest first.
    let rangeMax: number | '+inf' = cursor !== undefined ? cursor.score : '+inf';
    // The last member read and its position in that range. The next read
    // starts at the anchor itself (`LIMIT offset`), so members already read
    // are never transferred again, however many share one score. If the
    // anchor is not where it was (entries removed or added meanwhile), the
    // read is repeated from the start of the range.
    let anchor: { id: string; score: number; pos: number } | undefined;
    // Doubles while reads return nothing new (a long run of members at or
    // before the cursor), so skipping them takes few round trips.
    let grow = 1;
    const read = (offset: number, count: number | undefined) =>
      // ZRANGE BY SCORE REV: start is the highest score, stop the lowest.
      this.client.zRangeWithScores(index.time, rangeMax, '-inf', {
        BY: 'SCORE',
        REV: true,
        ...(count !== undefined ? { LIMIT: { offset, count } } : {}),
      });
    for (;;) {
      const remaining = max !== undefined ? max - results.length : undefined;
      // Read a little more than needed: a few index entries may be dead.
      const want =
        remaining !== undefined ? Math.max(remaining * 2, remaining + 5) * grow : undefined;
      let offset = 0;
      let count = want;
      let members: Array<{ value: string; score: number }>;
      if (anchor !== undefined && want !== undefined) {
        offset = anchor.pos;
        count = want + 1;
        members = await read(offset, count);
        if (members[0]?.value !== anchor.id) {
          offset = 0;
          count = anchor.pos + 1 + want;
          members = await read(offset, count);
        }
      } else {
        members = await read(offset, count);
      }
      const fresh = members.filter(
        (m) =>
          !seen.has(m.value) &&
          (bound === undefined || compareNewestFirst(bound, { score: m.score, id: m.value }) < 0),
      );
      if (fresh.length > 0) {
        const raws = await this.client.mGet(fresh.map((m) => index.dataKey(m.value)));
        for (let i = 0; i < fresh.length; i++) {
          seen.add(fresh[i].value);
          const raw = raws[i];
          // Null: the record expired or was deleted; its index entry waits
          // for the prune. Parse failures are skipped too.
          if (raw == null) continue;
          try {
            results.push(JSON.parse(raw) as T);
          } catch {
            continue;
          }
          if (max !== undefined && results.length >= max) return results;
        }
        const lastFresh = fresh[fresh.length - 1];
        bound = { score: lastFresh.score, id: lastFresh.value };
        grow = 1;
      } else {
        grow *= 2;
      }
      // A short read means the set is exhausted.
      if (count === undefined || members.length < count) return results;
      const last = members[members.length - 1];
      if (last.score === rangeMax) {
        anchor = { id: last.value, score: last.score, pos: offset + members.length - 1 };
      } else {
        // The range moves down to the last member's score. Every member at
        // that score that sorts before it was in this read.
        rangeMax = last.score;
        const before = members.filter((m) => m.score === last.score).length - 1;
        anchor = { id: last.value, score: last.score, pos: before };
      }
    }
  }

  // ── History index cleanup ──────────────────────────────────────────────
  //
  // Index members cannot carry a TTL, so when a history record expires its
  // entries in the id set and the time sorted set stay behind. Every history
  // save runs one bounded prune of its kind: it reads up to PRUNE_BATCH ids
  // whose expiry has passed from the expiry sorted set, then runs
  // PRUNE_HISTORY_INDEX_SCRIPT over them. The script checks each record's blob
  // and updates the indexes in one atomic step, so a save or delete landing
  // between the read and the script cannot be undone by it: a record saved
  // again is seen live and stays listed, and a deleted one is already gone.
  // The script only removes index entries and re-scores expiry entries; it
  // never adds a listing entry or writes a blob, so it cannot bring back
  // deleted data. Several instances pruning at once is safe.

  /**
   * Run one prune of `index`'s kind after a save. A prune failure does not
   * fail the save, whose MULTI already committed the record: it is reported
   * once per process and the next save of that kind tries again. That also
   * covers a Redis user whose ACL denies `EVAL`.
   */
  private async pruneHistoryAfterSave(index: HistoryIndex): Promise<void> {
    const inFlight = (this.prunesInFlight ??= new Set());
    if (inFlight.has(index.kind)) return;
    inFlight.add(index.kind);
    try {
      await this.pruneHistory(index);
    } catch (err) {
      this.warnPruneFailed(index, err);
    } finally {
      inFlight.delete(index.kind);
    }
  }

  private warnPruneFailed(index: HistoryIndex, err: unknown): void {
    // A lost connection or a closing store isn't the permission problem this
    // warning explains, and spending the one-time warning on it would hide a
    // real one later.
    if (!this.isConnected) return;
    warnDiagnosticOnce(
      `redis_history_prune_failed\0${index.kind}`,
      `RedisStore: removing expired ${index.label} index entries failed ` +
        `(${err instanceof Error ? err.message : String(err)}). The cleanup is tried ` +
        'again later, and listings stay correct meanwhile. The cleanup runs a Lua script, ' +
        'so the Redis user needs permission to run EVAL.',
      undefined,
      'docs/api-reference.md#redisstore-options',
    );
  }

  private async pruneHistory(index: HistoryIndex): Promise<void> {
    const candidates = await this.client.zRange(index.expiry, '-inf', Date.now(), {
      BY: 'SCORE',
      LIMIT: { offset: 0, count: PRUNE_BATCH },
    });
    if (candidates.length > 0) await this.runPruneScript(index, candidates);
  }

  /**
   * Run {@link PRUNE_HISTORY_INDEX_SCRIPT} over `ids`, at most PRUNE_BATCH
   * per call so one script never blocks the server for long.
   */
  private async runPruneScript(index: HistoryIndex, ids: string[]): Promise<void> {
    for (let start = 0; start < ids.length; start += PRUNE_BATCH) {
      const chunk = ids.slice(start, start + PRUNE_BATCH);
      await this.client.eval(PRUNE_HISTORY_INDEX_SCRIPT, {
        keys: [index.ids, index.time, index.expiry, ...chunk.map((id) => index.dataKey(id))],
        arguments: [String(Date.now()), ...chunk],
      });
    }
  }

  // ── History maintenance ────────────────────────────────────────────────

  /**
   * See `StateStore.applyHistoryRetention`. One call:
   *
   * 1. On the first call of a walk (no cursor), backfills the time sorted
   *    set from the id set if it is behind (see `backfillExecutionIndex`).
   * 2. Reads the next `batchSize` ids from the time sorted set, oldest first
   *    by `(score, member)`, strictly after the cursor. The read restarts at
   *    the cursor's position by value, never by offset.
   * 3. MGETs their blobs and reads each live blob's PTTL.
   * 4. In one MULTI, for each live blob:
   *    - a TTL (`PTTL > 0`): `ZADD NX` to the expiry set at now + PTTL. A
   *      record already in the expiry set keeps its entry (`indexed` counts
   *      only new entries).
   *    - no TTL (`-1`), with a retention configured: `PEXPIREAT … NX` at last
   *      save + retention. `NX` applies only to a key that still has no TTL,
   *      so a record re-saved meanwhile keeps the fresh window its save gave
   *      it. A window that has already passed uses a timestamp in the past,
   *      which makes Redis delete the key, again only if it is still untimed.
   * 5. Adds each newly armed record to the expiry set (`ZADD NX`).
   * 6. Runs the prune script (`PRUNE_HISTORY_INDEX_SCRIPT`) over ids whose
   *    blob is gone and ids just deleted in step 4. It checks each blob
   *    atomically, so a record re-saved at any point stays listed and a
   *    deleted one is never re-indexed.
   *
   * Blobs are never written. A record deleted while the call runs can leave
   * an entry in the expiry set only; the next prune removes it.
   */
  async applyHistoryRetention(options: HistoryRetentionOptions): Promise<HistoryRetentionResult> {
    const { kind, batchSize, cursor } = resolveHistoryRetentionOptions('RedisStore', options);
    const index = this.historyIndex(kind === 'executions' ? 'execution' : 'eval');
    const ttl = this.ttlFor(kind === 'executions' ? 'executionHistory' : 'evalHistory');

    if (cursor === undefined) {
      if (kind === 'executions') await this.backfillExecutionIndex();
      else await this.backfillEvalIndex();
    }

    const positions = await this.readRetentionBatch(index, cursor, batchSize + 1);
    const batch = positions.slice(0, batchSize);
    const result: HistoryRetentionResult = {
      expired: 0,
      armed: 0,
      indexed: 0,
      deadIndexEntries: 0,
      cursor:
        positions.length > batchSize
          ? { time: batch[batch.length - 1].score, id: batch[batch.length - 1].value }
          : null,
    };
    if (batch.length === 0) return result;

    const ids = batch.map((m) => m.value);
    const raws = await this.client.mGet(ids.map((id) => index.dataKey(id)));
    const dead = ids.filter((_, i) => raws[i] == null);
    const present = ids.flatMap((id, i) => {
      const raw = raws[i];
      return raw == null ? [] : [{ id, raw }];
    });
    const pttls = await Promise.all(present.map((r) => this.client.pTTL(index.dataKey(r.id))));

    const now = Date.now();
    const tx = this.client.multi();
    const queued: Array<
      | { action: 'index'; id: string }
      | { action: 'arm'; id: string; expiresAt: number }
      | { action: 'expire'; id: string }
    > = [];
    for (let i = 0; i < present.length; i++) {
      const { id, raw } = present[i];
      const pttl = pttls[i];
      if (pttl === -2) {
        // Gone since the MGET: removed below like any other missing blob.
        dead.push(id);
      } else if (pttl > 0) {
        tx.zAdd(index.expiry, { score: now + pttl, value: id }, { condition: 'NX' });
        queued.push({ action: 'index', id });
      } else if (pttl === -1 && ttl !== undefined) {
        let lastSavedAt: number | null;
        try {
          lastSavedAt = index.lastSavedAtOf(raw);
        } catch {
          lastSavedAt = null;
        }
        // A blob without a usable time is left alone, as listing skips it.
        if (lastSavedAt === null) continue;
        const decision = retentionForUntimedRecord(lastSavedAt, ttl, now);
        if (decision.expired) {
          // Any timestamp in the past deletes the key; NX still requires
          // that it has no TTL.
          tx.pExpireAt(index.dataKey(id), 1, 'NX');
          queued.push({ action: 'expire', id });
        } else {
          tx.pExpireAt(index.dataKey(id), decision.expiresAt, 'NX');
          queued.push({ action: 'arm', id, expiresAt: decision.expiresAt });
        }
      }
    }

    const expiredIds: string[] = [];
    const armed: Array<{ id: string; expiresAt: number }> = [];
    if (queued.length > 0) {
      const replies = await tx.exec();
      for (let i = 0; i < queued.length; i++) {
        if (Number(replies[i]) !== 1) continue;
        const entry = queued[i];
        if (entry.action === 'index') result.indexed++;
        else if (entry.action === 'expire') expiredIds.push(entry.id);
        else armed.push(entry);
      }
    }
    if (armed.length > 0) {
      const indexTx = this.client.multi();
      for (const { id, expiresAt } of armed) {
        indexTx.zAdd(index.expiry, { score: expiresAt, value: id }, { condition: 'NX' });
      }
      await indexTx.exec();
    }
    result.armed = armed.length;
    result.expired = expiredIds.length;
    result.deadIndexEntries = dead.length;
    if (dead.length > 0 || expiredIds.length > 0) {
      await this.runPruneScript(index, [...dead, ...expiredIds]);
    }
    return result;
  }

  /**
   * Up to `count` members of the time sorted set strictly after `cursor`,
   * oldest first by `(score, member)`. The members sharing the cursor's score
   * are read in full and filtered by member; the rest start just above that
   * score. Neither read uses an offset, so entries removed or added
   * meanwhile cannot shift the walk.
   */
  private async readRetentionBatch(
    index: HistoryIndex,
    cursor: HistoryRetentionCursor | undefined,
    count: number,
  ): Promise<Array<{ value: string; score: number }>> {
    if (cursor === undefined) {
      return this.client.zRangeWithScores(index.time, '-inf', '+inf', {
        BY: 'SCORE',
        LIMIT: { offset: 0, count },
      });
    }
    const ties = (
      await this.client.zRangeWithScores(index.time, cursor.time, cursor.time, { BY: 'SCORE' })
    ).filter((m) => compareMembers(m.value, cursor.id) > 0);
    if (ties.length >= count) return ties.slice(0, count);
    const rest = await this.client.zRangeWithScores(index.time, `(${cursor.time}`, '+inf', {
      BY: 'SCORE',
      LIMIT: { offset: 0, count: count - ties.length },
    });
    return [...ties, ...rest];
  }

  // ── Sessions (Studio introspection) ────────────────────────────────────

  async listSessions(): Promise<string[]> {
    // Redis has no way to list keys by pattern without scanning the keyspace,
    // so we maintain a set of session IDs alongside the session data. SSCAN
    // keeps a large set from blocking the server the way SMEMBERS would.
    const live = new Set<string>();
    let cursor = '0';
    do {
      const page = await this.client.sScan(this.sessionIdsKey(), cursor, {
        COUNT: SESSION_ID_BATCH,
      });
      cursor = page.cursor;
      const removed = new Set(await this.pruneSessionIds(page.members));
      for (const id of page.members) if (!removed.has(id)) live.add(id);
    } while (cursor !== '0');
    return [...live];
  }

  /**
   * Check a few listed sessions after a save, so ids of expired sessions go
   * away for apps that never list. Sessions without a TTL don't expire, so
   * there's nothing to do. The save has already succeeded, so failing here
   * can't fail it.
   */
  private async sweepSessionIds(): Promise<void> {
    if (this.ttlFor('session') === undefined || this.sessionSweepRunning) return;
    this.sessionSweepRunning = true;
    try {
      const page = await this.client.sScan(this.sessionIdsKey(), this.sessionSweepCursor, {
        COUNT: SESSION_SWEEP_COUNT,
      });
      this.sessionSweepCursor = page.cursor;
      await this.pruneSessionIds(page.members);
    } catch (err) {
      this.warnSessionPruneFailed(err);
    } finally {
      this.sessionSweepRunning = false;
    }
  }

  /** Returns the ids removed. Without permission to run the script, removes none and warns. */
  private async pruneSessionIds(ids: string[]): Promise<string[]> {
    const removed: string[] = [];
    // SSCAN returns a small set whole, whatever COUNT asks for.
    for (let start = 0; start < ids.length; start += SESSION_ID_BATCH) {
      const batch = ids.slice(start, start + SESSION_ID_BATCH);
      try {
        const result = await this.client.eval(PRUNE_SESSION_IDS_SCRIPT, {
          keys: [
            this.sessionIdsKey(),
            ...batch.flatMap((id) => [this.sessionKey(id), this.sessionMetaKey(id)]),
          ],
          arguments: batch,
        });
        removed.push(...(result as string[]));
      } catch (err) {
        if (!errorMessage(err).includes('NOPERM')) throw err;
        this.warnSessionPruneFailed(err);
        return removed;
      }
    }
    return removed;
  }

  private warnSessionPruneFailed(err: unknown): void {
    // A lost connection or a closing store isn't the permission problem this warning explains.
    if (!this.isConnected) return;
    warnDiagnosticOnce(
      'redis_session_ids_prune_failed',
      `RedisStore: removing expired session ids failed (${errorMessage(err)}), so ` +
        'listSessions can return sessions that have expired. The cleanup runs a Lua script, ' +
        'so the Redis user needs permission to run EVAL.',
      undefined,
      'docs/api-reference.md#redisstore-options',
    );
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

  async getStreamingEvents(executionId: string): Promise<HistoricalAxlEvent[]> {
    const raws = await this.client.lRange(this.streamingEventsKey(executionId), 0, -1);
    if (raws.length === 0) return [];
    return raws.map((raw, index) => {
      try {
        return JSON.parse(raw) as HistoricalAxlEvent;
      } catch (error) {
        throw new Error(`Streaming buffer ${executionId} contains invalid JSON at index ${index}`, {
          cause: error,
        });
      }
    });
  }

  /**
   * Close the Redis connection.
   *
   * Idempotent: `runtime.shutdown()` closes the state store it was handed, so
   * a caller that also closes its own store is doing the ordinary thing and
   * must not get a rejected promise for it. `MemoryStore.close()` and
   * better-sqlite3's `close()` are both no-ops the second time; node-redis
   * instead rejects with "The client is closed", so absorb that here.
   *
   * Bounded, so a shutdown can't hang on Redis. Replies arrive in order, so a
   * reply to this PING means every earlier command has finished.
   *
   * Not `quit()`: it marks the client closed before the server answers, and
   * `destroy()` then throws without touching the socket, so a stalled server's
   * socket could never be closed. There's no other public way to close it. A
   * closed socket is all Redis needs to clean up, so nothing is lost.
   */
  async close(): Promise<void> {
    this.closing = true;
    this.stopResponseWatch?.();
    if (this.connection.isOpen === false) return;
    if (this.connection.isReady !== false) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.connection.ping(),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('PING timed out')), CLOSE_TIMEOUT_MS);
          }),
        ]);
      } catch {
        // Stalled or disconnected. Waiting commands are rejected below.
      } finally {
        clearTimeout(timer);
      }
    }
    abandonConnection(this.connection);
  }

  async deleteCheckpoints(executionId: string): Promise<void> {
    await this.client.del(this.checkpointKey(executionId));
  }
}
