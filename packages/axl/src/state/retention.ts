import type { HistoricalExecutionInfo } from '../types.js';
import type {
  HistoryRetentionCursor,
  HistoryRetentionKind,
  HistoryRetentionOptions,
  HistoryTtls,
} from './types.js';
import { AxlError } from '../errors.js';

/**
 * Maximum number of expired history rows one save physically removes.
 *
 * Built-in stores never run timers: they are passive objects that may be
 * shared across runtimes, and a timer would have to be stopped at shutdown.
 * Instead every `saveExecution` / `saveEvalResult` removes up to this many
 * expired rows of its own kind, so cleanup keeps pace with writes while each
 * save does a bounded amount of extra work. Reads filter expired rows
 * independently, so a row awaiting cleanup is never returned.
 *
 * @internal Exported for tests.
 */
export const PRUNE_BATCH = 100;

/** Per-category retention in seconds, or `null` for "never expires". */
export type ResolvedHistoryTtls = {
  executionHistory: number | null;
  evalHistory: number | null;
};

function resolveTtl(storeName: string, category: keyof HistoryTtls, value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number') {
    throw new AxlError(
      'INVALID_CONFIG',
      `${storeName}: ttls.${category} must be a positive number of seconds or null; got ${typeof value}`,
    );
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new AxlError(
      'INVALID_CONFIG',
      `${storeName}: ttls.${category} must be a positive number of seconds or null; got ${value}`,
    );
  }
  return value;
}

/**
 * Validate and resolve a store's `ttls` option. Invalid values are rejected
 * at construction rather than ignored: a retention that quietly does nothing
 * keeps data the operator asked to delete.
 */
export function resolveHistoryTtls(
  storeName: string,
  ttls: HistoryTtls | undefined,
): ResolvedHistoryTtls {
  if (ttls !== undefined && (ttls === null || typeof ttls !== 'object')) {
    throw new AxlError(
      'INVALID_CONFIG',
      `${storeName}: ttls must be an object; got ${ttls === null ? 'null' : typeof ttls}`,
    );
  }
  return {
    executionHistory: resolveTtl(storeName, 'executionHistory', ttls?.executionHistory),
    evalHistory: resolveTtl(storeName, 'evalHistory', ttls?.evalHistory),
  };
}

/** Absolute expiry (epoch ms) for a record written at `now`, or `null`. */
export function expiryFrom(now: number, ttlSeconds: number | null): number | null {
  return ttlSeconds === null ? null : now + Math.round(ttlSeconds * 1000);
}

/** A record is expired once the clock reaches its expiry. */
export function isExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && now >= expiresAt;
}

/** Records examined per `applyHistoryRetention` call when `batchSize` is omitted. */
export const DEFAULT_RETENTION_BATCH_SIZE = 500;

export type ResolvedHistoryRetentionOptions = {
  kind: HistoryRetentionKind;
  batchSize: number;
  cursor: HistoryRetentionCursor | undefined;
};

/**
 * Validate `applyHistoryRetention` options. This is a maintenance call that
 * deletes records, so a malformed argument is rejected rather than guessed at.
 */
export function resolveHistoryRetentionOptions(
  storeName: string,
  options: HistoryRetentionOptions,
): ResolvedHistoryRetentionOptions {
  const method = `${storeName}.applyHistoryRetention()`;
  if (options === null || typeof options !== 'object') {
    throw new AxlError('INVALID_ARGUMENT', `${method} options must be an object`);
  }
  const { kind, batchSize, cursor } = options as {
    kind?: unknown;
    batchSize?: unknown;
    cursor?: unknown;
  };
  if (kind !== 'executions' && kind !== 'evals') {
    throw new AxlError(
      'INVALID_ARGUMENT',
      `${method} kind must be 'executions' or 'evals'; got ${String(kind)}`,
    );
  }
  if (
    batchSize !== undefined &&
    !(typeof batchSize === 'number' && Number.isSafeInteger(batchSize) && batchSize > 0)
  ) {
    throw new AxlError(
      'INVALID_ARGUMENT',
      `${method} batchSize must be a positive integer; got ${String(batchSize)}`,
    );
  }
  let parsedCursor: HistoryRetentionCursor | undefined;
  if (cursor !== undefined && cursor !== null) {
    const candidate = cursor as Partial<HistoryRetentionCursor>;
    if (
      typeof candidate !== 'object' ||
      typeof candidate.time !== 'number' ||
      !Number.isFinite(candidate.time) ||
      typeof candidate.id !== 'string'
    ) {
      throw new AxlError(
        'INVALID_ARGUMENT',
        `${method} cursor must be the { time, id } cursor returned by the previous call`,
      );
    }
    parsedCursor = { time: candidate.time, id: candidate.id };
  }
  return {
    kind,
    batchSize: (batchSize as number | undefined) ?? DEFAULT_RETENTION_BATCH_SIZE,
    cursor: parsedCursor,
  };
}

/**
 * What `applyHistoryRetention` does with a record that has no expiry, under a
 * retention of `ttlSeconds`: the record's window counts from its last save,
 * exactly as if it had been saved with the retention configured. A window
 * that has already passed means the record is deleted now.
 */
export function retentionForUntimedRecord(
  lastSavedAt: number,
  ttlSeconds: number,
  now: number,
): { expired: true } | { expired: false; expiresAt: number } {
  const expiresAt = lastSavedAt + Math.round(ttlSeconds * 1000);
  return isExpired(expiresAt, now) ? { expired: true } : { expired: false, expiresAt };
}

/**
 * When an execution record was last saved, as far as the record shows. Runs
 * are saved once, when they finish, so that is `completedAt`; records without
 * one fall back to `startedAt`.
 */
export function executionLastSavedAt(record: {
  startedAt: number;
  completedAt?: number | null;
}): number {
  return typeof record.completedAt === 'number' && Number.isFinite(record.completedAt)
    ? record.completedAt
    : record.startedAt;
}

/**
 * Listing order for execution history: `startedAt` descending, then
 * `executionId` descending. The id tie-break makes the order total, so runs
 * that started in the same millisecond keep a stable position across calls.
 */
export function compareExecutionsNewestFirst(
  a: Pick<HistoricalExecutionInfo, 'startedAt' | 'executionId'>,
  b: Pick<HistoricalExecutionInfo, 'startedAt' | 'executionId'>,
): number {
  if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt;
  return compareCodePoints(b.executionId, a.executionId);
}

/**
 * The `applyHistoryRetention` walk order: `time` ascending, then `id` by code
 * point ascending. The exact reverse of the listing order.
 */
export function compareRetentionPositions(
  a: HistoryRetentionCursor,
  b: HistoryRetentionCursor,
): number {
  if (a.time !== b.time) return a.time - b.time;
  return compareCodePoints(a.id, b.id);
}

/**
 * Compare strings by Unicode code point, which is the byte order Redis (sorted-set
 * members with equal scores) and SQLite (BINARY collation over UTF-8) use. Plain
 * `<` compares UTF-16 code units and disagrees with them when a surrogate pair is
 * compared against a character in U+E000–U+FFFF, which would make in-process
 * cursor filtering disagree with the store's tie order.
 */
function compareCodePoints(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return codePointRank(x) - codePointRank(y);
  }
  return a.length - b.length;
}

/** Map a UTF-16 code unit so that surrogates sort above U+E000–U+FFFF. */
function codePointRank(unit: number): number {
  if (unit >= 0xe000) return unit - 0x800;
  if (unit >= 0xd800) return unit + 0x2000;
  return unit;
}
