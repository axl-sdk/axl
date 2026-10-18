import type { HistoricalExecutionInfo } from '../types.js';
import type { HistoryTtls } from './types.js';
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
  return a.executionId < b.executionId ? 1 : a.executionId > b.executionId ? -1 : 0;
}
