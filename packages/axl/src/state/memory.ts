import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ChatMessage,
  HistoricalAxlEvent,
  HistoricalExecutionInfo,
  HumanDecision,
} from '../types.js';
import type {
  StateStore,
  PendingDecision,
  ExecutionState,
  EvalHistoryEntry,
  HistoryTtls,
} from './types.js';
import { getExecutionEventSchemaVersion, normalizeStoredExecution } from '../event-schema.js';
import { normalizePersistedSessionHistory } from '../input.js';
import { AxlError } from '../errors.js';
import {
  PRUNE_BATCH,
  compareExecutionsNewestFirst,
  expiryFrom,
  isExpired,
  resolveHistoryTtls,
  type ResolvedHistoryTtls,
} from './retention.js';

/** Options for {@link MemoryStore}. */
export type MemoryStoreOptions = {
  /**
   * History retention in seconds. A positive number expires a record that
   * many seconds after it is saved; `null` or unset keeps it. See
   * {@link HistoryTtls} for how each category's window is counted.
   */
  ttls?: HistoryTtls;
  /**
   * Maximum number of execution-history records kept. When a save goes over
   * the limit, the oldest records in listing order (earliest `startedAt`,
   * then lowest `executionId`) are removed. A positive integer or `Infinity`;
   * unset means no limit.
   */
  maxExecutions?: number;
  /** Clock in epoch milliseconds, used for retention. Defaults to `Date.now`. */
  now?: () => number;
};

type StoredExecution = { record: HistoricalExecutionInfo; expiresAt: number | null };
type StoredEval = { entry: EvalHistoryEntry; expiresAt: number | null };
type ExecutionOrderKey = { startedAt: number; executionId: string };

/** Oldest-first comparator: the reverse of the newest-first listing order. */
function compareOldestFirst(a: ExecutionOrderKey, b: ExecutionOrderKey): number {
  return compareExecutionsNewestFirst(b, a);
}

function resolveMaxExecutions(value: unknown): number {
  if (value === undefined || value === Infinity) return Infinity;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new AxlError(
      'INVALID_CONFIG',
      `MemoryStore: maxExecutions must be a positive integer or Infinity; got ${typeof value === 'number' ? value : typeof value}`,
    );
  }
  return value;
}

/**
 * Path to the MemoryStore temp file for awaitHuman state.
 * Keeps orphaned pending requests visible after process loss even when using
 * MemoryStore. It does not preserve the in-process workflow continuation.
 *
 * NOTE: tmpdir() persistence is best-effort. Temp directories may be cleaned
 * by the OS at any time (e.g., on reboot or via periodic cleanup policies).
 * For durable request visibility, use SQLite or Redis state stores. Durable
 * approval execution remains application-managed.
 */
const AWAIT_HUMAN_TEMP_DIR = join(tmpdir(), 'axl-memory-store');
const AWAIT_HUMAN_TEMP_FILE = join(AWAIT_HUMAN_TEMP_DIR, 'await-human-state.json');

type PersistedAwaitHumanState = {
  decisions: Record<string, PendingDecision>;
  executionStates: Record<string, ExecutionState>;
};

/**
 * In-memory implementation of StateStore.
 * Fast for development and testing, but lost on process restart.
 *
 * Exception: awaitHuman state (pending decisions + execution states with
 * status "waiting") is persisted to a temporary file so it survives restarts.
 * This is the one exception to "memory means ephemeral" — because a human
 * could take hours to respond, and losing that state is unacceptable.
 *
 * History can be bounded by time (`ttls`) and by count (`maxExecutions`).
 * Expired records are never returned and are physically removed, a bounded
 * batch at a time, on later saves of the same kind.
 */
export class MemoryStore implements StateStore {
  private checkpoints = new Map<string, Map<string, unknown>>();
  private sessions = new Map<string, ChatMessage[]>();
  private sessionMeta = new Map<string, Map<string, unknown>>();
  private decisions = new Map<string, PendingDecision>();
  private executionStates = new Map<string, ExecutionState>();
  private memories = new Map<string, Map<string, unknown>>();
  /**
   * Iteration order is last-save order: a save deletes and re-inserts its key.
   * With one retention per store and a clock that does not run backwards, that
   * is also expiry order, which lets the prune stop at the first live record.
   */
  private executionHistory = new Map<string, StoredExecution>();
  /** Every key in `executionHistory`, sorted oldest first in listing order. */
  private executionOrder: ExecutionOrderKey[] = [];
  /**
   * Iteration order is first-write order (a re-save keeps the key's position
   * and its expiry), which is also expiry order for the same reason as above.
   */
  private evalHistory = new Map<string, StoredEval>();
  private readonly ttls: ResolvedHistoryTtls;
  private readonly maxExecutions: number;
  private readonly now: () => number;

  constructor(options?: MemoryStoreOptions) {
    this.ttls = resolveHistoryTtls('MemoryStore', options?.ttls);
    this.maxExecutions = resolveMaxExecutions(options?.maxExecutions);
    if (options?.now !== undefined && typeof options.now !== 'function') {
      throw new AxlError(
        'INVALID_CONFIG',
        'MemoryStore: now must be a function returning epoch milliseconds',
      );
    }
    this.now = options?.now ?? (() => Date.now());
    // Load any persisted awaitHuman state from previous process
    this.loadPersistedState();
  }

  async saveCheckpoint(executionId: string, name: string, data: unknown): Promise<void> {
    let entries = this.checkpoints.get(executionId);
    if (!entries) {
      entries = new Map();
      this.checkpoints.set(executionId, entries);
    }
    entries.set(name, structuredClone(data));
  }

  async getCheckpoint(executionId: string, name: string): Promise<unknown | null> {
    const entries = this.checkpoints.get(executionId);
    if (!entries) return null;
    const data = entries.get(name);
    return data !== undefined ? structuredClone(data) : null;
  }

  async saveSession(sessionId: string, history: ChatMessage[]): Promise<void> {
    this.sessions.set(sessionId, structuredClone(normalizePersistedSessionHistory(history)));
  }

  async getSession(sessionId: string): Promise<ChatMessage[]> {
    const history = this.sessions.get(sessionId);
    return history ? structuredClone(history) : [];
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.sessionMeta.delete(sessionId);
  }

  async saveSessionMeta(sessionId: string, key: string, value: unknown): Promise<void> {
    let meta = this.sessionMeta.get(sessionId);
    if (!meta) {
      meta = new Map();
      this.sessionMeta.set(sessionId, meta);
    }
    meta.set(key, structuredClone(value));
  }

  async getSessionMeta(sessionId: string, key: string): Promise<unknown | null> {
    const meta = this.sessionMeta.get(sessionId);
    if (!meta) return null;
    const value = meta.get(key);
    return value !== undefined ? structuredClone(value) : null;
  }

  async savePendingDecision(executionId: string, decision: PendingDecision): Promise<void> {
    this.decisions.set(executionId, structuredClone(decision));
    this.persistAwaitHumanState();
  }

  async getPendingDecisions(): Promise<PendingDecision[]> {
    return [...this.decisions.values()].map((d) => structuredClone(d));
  }

  async resolveDecision(executionId: string, _result: HumanDecision): Promise<void> {
    this.decisions.delete(executionId);
    this.persistAwaitHumanState();
  }

  // ── Execution State ──────────────────────────────────────────────────

  async saveExecutionState(executionId: string, state: ExecutionState): Promise<void> {
    this.executionStates.set(executionId, structuredClone(state));
    // Persist waiting states to temp file
    if (state.status === 'waiting') {
      this.persistAwaitHumanState();
    }
  }

  async getExecutionState(executionId: string): Promise<ExecutionState | null> {
    const state = this.executionStates.get(executionId);
    return state ? structuredClone(state) : null;
  }

  async listPendingExecutions(): Promise<string[]> {
    const pending: string[] = [];
    for (const [id, state] of this.executionStates) {
      if (state.status === 'waiting') pending.push(id);
    }
    return pending;
  }

  // ── Memory ──────────────────────────────────────────────────────

  async saveMemory(scope: string, key: string, value: unknown): Promise<void> {
    let scopeMap = this.memories.get(scope);
    if (!scopeMap) {
      scopeMap = new Map();
      this.memories.set(scope, scopeMap);
    }
    scopeMap.set(key, structuredClone(value));
  }

  async getMemory(scope: string, key: string): Promise<unknown | null> {
    const val = this.memories.get(scope)?.get(key);
    return val !== undefined ? structuredClone(val) : null;
  }

  async getAllMemory(scope: string): Promise<Array<{ key: string; value: unknown }>> {
    const scopeMap = this.memories.get(scope);
    if (!scopeMap) return [];
    return Array.from(scopeMap.entries()).map(([key, value]) => ({
      key,
      value: structuredClone(value),
    }));
  }

  async deleteMemory(scope: string, key: string): Promise<void> {
    this.memories.get(scope)?.delete(key);
  }

  // ── Execution History ──────────────────────────────────────────────

  async saveExecution(execution: HistoricalExecutionInfo): Promise<void> {
    const now = this.now();
    const normalized = structuredClone(
      normalizeStoredExecution({
        ...execution,
        eventSchemaVersion: getExecutionEventSchemaVersion(execution),
      } as HistoricalExecutionInfo),
    );
    // Delete before re-inserting so Map order stays last-save order, and the
    // listing index never holds a stale `startedAt` for this id.
    this.removeExecutionRecord(normalized.executionId);
    this.executionHistory.set(normalized.executionId, {
      record: normalized,
      expiresAt: expiryFrom(now, this.ttls.executionHistory),
    });
    this.insertExecutionOrder(normalized);
    this.pruneExpiredExecutions(now);
    this.evictOverflowExecutions();
  }

  async getExecution(executionId: string): Promise<HistoricalExecutionInfo | null> {
    const stored = this.executionHistory.get(executionId);
    if (!stored || isExpired(stored.expiresAt, this.now())) return null;
    return normalizeStoredExecution(structuredClone(stored.record));
  }

  async listExecutions(limit?: number): Promise<HistoricalExecutionInfo[]> {
    const now = this.now();
    const max = limit ? limit : Infinity;
    const result: HistoricalExecutionInfo[] = [];
    // Walk the sorted index newest first; expired records are skipped before
    // the limit is applied, so a page is filled with live records.
    for (let i = this.executionOrder.length - 1; i >= 0 && result.length < max; i--) {
      const stored = this.executionHistory.get(this.executionOrder[i].executionId)!;
      if (isExpired(stored.expiresAt, now)) continue;
      result.push(normalizeStoredExecution(structuredClone(stored.record)));
    }
    return result;
  }

  async deleteExecution(executionId: string): Promise<boolean> {
    // Sweep every per-execution surface so a delete is total — checkpoints,
    // suspended state, streaming buffer, AND any pending awaitHuman
    // decision belonging to this execution. Otherwise a GDPR-style "scrub
    // this run" call leaves PII reachable via the remaining keys (e.g.
    // recoverIncompleteStreams could resurrect the streaming buffer into
    // a new ExecutionInfo, or `runtime.getPendingDecisions()` would still
    // surface the row).
    const removedHistory = this.removeExecutionRecord(executionId);
    const removedCheckpoints = this.checkpoints.delete(executionId);
    const removedState = this.executionStates.delete(executionId);
    const removedStreaming = this.streamingEvents.delete(executionId);
    const removedDecision = this.decisions.delete(executionId);
    if (removedDecision) {
      this.persistAwaitHumanState();
    }
    return (
      removedHistory || removedCheckpoints || removedState || removedStreaming || removedDecision
    );
  }

  // ── Eval History ──────────────────────────────────────────────────

  /**
   * Write an eval history row. Retention counts from the row's first write:
   * re-saving a live row keeps its expiry (and its position in expiry order).
   * A row that has already expired is replaced as a new one.
   */
  async saveEvalResult(entry: EvalHistoryEntry): Promise<void> {
    const now = this.now();
    const existing = this.evalHistory.get(entry.id);
    if (existing && !isExpired(existing.expiresAt, now)) {
      // Map.set on an existing key keeps its iteration position.
      this.evalHistory.set(entry.id, {
        entry: structuredClone(entry),
        expiresAt: existing.expiresAt,
      });
    } else {
      this.evalHistory.delete(entry.id);
      this.evalHistory.set(entry.id, {
        entry: structuredClone(entry),
        expiresAt: expiryFrom(now, this.ttls.evalHistory),
      });
    }
    this.pruneExpiredEvals(now);
  }

  /** Update-only write: see `StateStore.updateEvalResult`. Never changes retention. */
  async updateEvalResult(entry: EvalHistoryEntry): Promise<boolean> {
    const existing = this.evalHistory.get(entry.id);
    if (!existing || isExpired(existing.expiresAt, this.now())) return false;
    this.evalHistory.set(entry.id, {
      entry: structuredClone(entry),
      expiresAt: existing.expiresAt,
    });
    return true;
  }

  async listEvalResults(limit?: number): Promise<EvalHistoryEntry[]> {
    const now = this.now();
    const sorted = [...this.evalHistory.values()]
      .filter((stored) => !isExpired(stored.expiresAt, now))
      .map((stored) => stored.entry)
      .sort((a, b) => b.timestamp - a.timestamp);
    const result = limit ? sorted.slice(0, limit) : sorted;
    return result.map((e) => structuredClone(e));
  }

  async deleteEvalResult(id: string): Promise<boolean> {
    return this.evalHistory.delete(id);
  }

  /** Existence plus the expiry stored at the row's first write, if any. */
  async getEvalRetention(id: string): Promise<{ exists: boolean; expiresAt?: number }> {
    const stored = this.evalHistory.get(id);
    if (!stored || isExpired(stored.expiresAt, this.now())) return { exists: false };
    return stored.expiresAt === null
      ? { exists: true }
      : { exists: true, expiresAt: stored.expiresAt };
  }

  // ── History retention internals ───────────────────────────────────

  /** Index of the first order key not older than `key` (binary search). */
  private executionOrderLowerBound(key: ExecutionOrderKey): number {
    let lo = 0;
    let hi = this.executionOrder.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareOldestFirst(this.executionOrder[mid], key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private insertExecutionOrder(record: HistoricalExecutionInfo): void {
    const key = { startedAt: record.startedAt, executionId: record.executionId };
    this.executionOrder.splice(this.executionOrderLowerBound(key), 0, key);
  }

  /** Remove a history record and its listing-index key. Returns whether one existed. */
  private removeExecutionRecord(executionId: string): boolean {
    const stored = this.executionHistory.get(executionId);
    if (!stored) return false;
    this.executionHistory.delete(executionId);
    const index = this.executionOrderLowerBound(stored.record);
    if (this.executionOrder[index]?.executionId === executionId) {
      this.executionOrder.splice(index, 1);
    }
    return true;
  }

  /**
   * A run leaving history through retention (expiry or `maxExecutions`) takes
   * its leftover per-run data with it: checkpoints (kept today when a run
   * fails), saved execution state and any streaming buffer. Pending decisions
   * are not touched. The runtime never writes execution state, and a run is
   * only saved to history once it has finished, so nothing still running
   * depends on what is removed here.
   */
  private expireExecutionRecord(executionId: string): void {
    this.removeExecutionRecord(executionId);
    this.checkpoints.delete(executionId);
    const state = this.executionStates.get(executionId);
    this.executionStates.delete(executionId);
    this.streamingEvents.delete(executionId);
    // A removed waiting state must also leave the awaitHuman temp file.
    if (state?.status === 'waiting') this.persistAwaitHumanState();
  }

  /**
   * Remove up to `PRUNE_BATCH` expired execution records, oldest save first.
   * Stops at the first live record: Map order is last-save order, which is
   * expiry order while the clock moves forward. If the clock steps back, a
   * few expired records wait for a later save; reads still filter them.
   */
  private pruneExpiredExecutions(now: number): void {
    if (this.ttls.executionHistory === null) return;
    let removed = 0;
    for (const [id, stored] of this.executionHistory) {
      if (removed >= PRUNE_BATCH || !isExpired(stored.expiresAt, now)) break;
      this.expireExecutionRecord(id);
      removed++;
    }
  }

  /** Evict the oldest records in listing order until the count bound holds. */
  private evictOverflowExecutions(): void {
    while (this.executionHistory.size > this.maxExecutions) {
      this.expireExecutionRecord(this.executionOrder[0].executionId);
    }
  }

  /** Remove up to `PRUNE_BATCH` expired eval rows, oldest first write first. */
  private pruneExpiredEvals(now: number): void {
    if (this.ttls.evalHistory === null) return;
    let removed = 0;
    for (const [id, stored] of this.evalHistory) {
      if (removed >= PRUNE_BATCH || !isExpired(stored.expiresAt, now)) break;
      this.evalHistory.delete(id);
      removed++;
    }
  }

  // ── Sessions (Studio introspection) ─────────────────────────────────

  async listSessions(): Promise<string[]> {
    return [...this.sessions.keys()];
  }

  // ── Streaming events (for state.persist: 'streaming') ────────────────
  //
  // MemoryStore's raison d'être is in-process / ephemeral. We implement
  // the streaming methods so tests and dev workflows behave correctly,
  // but on a process crash these buffers are lost — same as the rest of
  // MemoryStore's state. For real crash-survival, use RedisStore or
  // SQLiteStore.

  private streamingEvents = new Map<string, HistoricalAxlEvent[]>();

  async appendStreamingEvents(
    executionId: string,
    events: import('../types.js').AxlEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    const existing = this.streamingEvents.get(executionId) ?? [];
    existing.push(...events.map((e) => structuredClone(e)));
    this.streamingEvents.set(executionId, existing);
  }

  async finalizeStreamingEvents(executionId: string): Promise<void> {
    this.streamingEvents.delete(executionId);
  }

  async listStreamingExecutions(): Promise<string[]> {
    return [...this.streamingEvents.keys()];
  }

  async getStreamingEvents(executionId: string): Promise<HistoricalAxlEvent[]> {
    const events = this.streamingEvents.get(executionId) ?? [];
    return events.map((e) => structuredClone(e));
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async close(): Promise<void> {}

  async deleteCheckpoints(executionId: string): Promise<void> {
    this.checkpoints.delete(executionId);
  }

  // ── Temp File Persistence (awaitHuman only) ────────────────────────

  private persistAwaitHumanState(): void {
    try {
      const state: PersistedAwaitHumanState = {
        decisions: Object.fromEntries(this.decisions),
        executionStates: {},
      };

      // Only persist execution states that are in 'waiting' status
      for (const [id, execState] of this.executionStates) {
        if (execState.status === 'waiting') {
          state.executionStates[id] = execState;
        }
      }

      // Only write if there's something to persist
      if (
        Object.keys(state.decisions).length === 0 &&
        Object.keys(state.executionStates).length === 0
      ) {
        // Clean up temp file if nothing to persist
        try {
          unlinkSync(AWAIT_HUMAN_TEMP_FILE);
        } catch {
          /* ignore */
        }
        return;
      }

      mkdirSync(AWAIT_HUMAN_TEMP_DIR, { recursive: true });
      writeFileSync(AWAIT_HUMAN_TEMP_FILE, JSON.stringify(state), 'utf-8');
    } catch {
      // Best-effort persistence — don't crash if temp file write fails
    }
  }

  private loadPersistedState(): void {
    try {
      if (!existsSync(AWAIT_HUMAN_TEMP_FILE)) return;

      const raw = readFileSync(AWAIT_HUMAN_TEMP_FILE, 'utf-8');
      const state = JSON.parse(raw) as PersistedAwaitHumanState;

      for (const [id, decision] of Object.entries(state.decisions)) {
        this.decisions.set(id, decision);
      }
      for (const [id, execState] of Object.entries(state.executionStates)) {
        this.executionStates.set(id, execState);
      }

      // Clean up the temp file after loading
      unlinkSync(AWAIT_HUMAN_TEMP_FILE);
    } catch {
      // Best-effort load — ignore errors
    }
  }
}
