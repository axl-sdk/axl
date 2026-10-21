import type {
  AxlEvent,
  ChatMessage,
  HistoricalAxlEvent,
  HistoricalExecutionInfo,
  HumanDecision,
} from '../types.js';

/** A pending human decision awaiting resolution. */
export type PendingDecision = {
  executionId: string;
  channel: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

/** Legacy application-managed execution state. Axl does not automatically
 * resume workflow continuations from this record. */
export type ExecutionState = {
  workflow: string;
  input: unknown;
  step: number;
  status: 'waiting' | 'running';
  metadata?: Record<string, unknown>;
};

/**
 * Pluggable state persistence interface.
 *
 * Built-in implementations: MemoryStore (testing), SQLiteStore (file-based),
 * Redis (production).
 */
export interface StateStore {
  // Checkpoints — keyed by caller-supplied stable name (per `ctx.checkpoint(name, fn)`).
  // Names are scoped to a single execution and must be unique within it; the
  // runtime does not enforce uniqueness, so callers using the same name twice
  // get last-write-wins behavior (intentional for loop iterations using
  // composed names like `iter-${i}`).
  saveCheckpoint(executionId: string, name: string, data: unknown): Promise<void>;
  getCheckpoint(executionId: string, name: string): Promise<unknown | null>;

  // Sessions
  saveSession(sessionId: string, history: ChatMessage[]): Promise<void>;
  getSession(sessionId: string): Promise<ChatMessage[]>;
  deleteSession(sessionId: string): Promise<void>;

  // Session metadata (e.g., cached context summaries)
  saveSessionMeta(sessionId: string, key: string, value: unknown): Promise<void>;
  getSessionMeta(sessionId: string, key: string): Promise<unknown | null>;

  // Human-in-the-loop decisions
  savePendingDecision(executionId: string, decision: PendingDecision): Promise<void>;
  getPendingDecisions(): Promise<PendingDecision[]>;
  resolveDecision(executionId: string, result: HumanDecision): Promise<void>;

  // Legacy application-managed execution-state persistence. Retained for
  // custom-store compatibility; the runtime does not automatically resume it.
  saveExecutionState(executionId: string, state: ExecutionState): Promise<void>;
  getExecutionState(executionId: string): Promise<ExecutionState | null>;
  listPendingExecutions(): Promise<string[]>;

  // Memory
  /** Save a memory entry (key-value). */
  saveMemory?(scope: string, key: string, value: unknown): Promise<void>;
  /** Get a memory entry by key. */
  getMemory?(scope: string, key: string): Promise<unknown | null>;
  /** Get all memory entries for a scope. */
  getAllMemory?(scope: string): Promise<Array<{ key: string; value: unknown }>>;
  /** Delete a memory entry by key. */
  deleteMemory?(scope: string, key: string): Promise<void>;

  // Execution history
  /** Save a completed/failed execution to history. */
  saveExecution?(execution: HistoricalExecutionInfo): Promise<void>;
  /** Get a specific execution by ID from history. */
  getExecution?(executionId: string): Promise<HistoricalExecutionInfo | null>;
  /**
   * List recent executions, most recent first. The built-in stores order by
   * `startedAt` descending and break ties by `executionId` descending, so the
   * order is total and stable across calls.
   *
   * `options.cursor` asks for the page that starts strictly after that
   * position in the same order. The runtime passes it only when the store
   * sets {@link StateStore.historyPaging}; other stores are listed in full and
   * paged in process.
   */
  listExecutions?(
    limit?: number,
    options?: { cursor?: ExecutionCursor },
  ): Promise<HistoricalExecutionInfo[]>;
  /**
   * Set to `true` when `listExecutions` honors `options.cursor` with the
   * `(startedAt DESC, executionId DESC)` order. The built-in stores set it.
   * Leave it unset if your store ignores the cursor: the runtime then lists
   * everything and pages in process, which is correct but reads the whole
   * history on every page.
   */
  readonly historyPaging?: boolean;
  /**
   * Delete an execution from history by ID. Returns `true` if an entry was
   * deleted, `false` if the ID didn't exist. Used for GDPR right-to-be-
   * forgotten and operator-driven cleanup. Symmetric to `deleteEvalResult`.
   *
   * **Custom store implementors:** This delete must be **total** —
   * sweep every per-execution surface your store maintains. The runtime's
   * `runtime.deleteExecution` does NOT call separate `deleteCheckpoints` /
   * `deleteExecutionState` / `finalizeStreamingEvents` after this; one
   * call should clean EVERYTHING owned by the executionId. The built-in
   * stores remove:
   *   - the canonical execution-history row and its indexes,
   *   - all checkpoints for the id,
   *   - the suspended-state row + its pending-set membership,
   *   - the streaming-event buffer + its in-flight-ids membership,
   *   - any pending awaitHuman decision row.
   * Skipping any of these leaks PII through `recoverIncompleteStreams()`
   * or `getPendingDecisions()`, breaking the GDPR delete contract.
   *
   * For multi-table SQL stores: wrap the deletes in a transaction. For
   * Redis-style stores: use MULTI/EXEC. Idempotency is required —
   * deleting an unknown id returns `false` without throwing.
   */
  deleteExecution?(executionId: string): Promise<boolean>;

  // Eval history
  /** Save an eval result to history. Creates the row, or replaces it. */
  saveEvalResult?(entry: EvalHistoryEntry): Promise<void>;
  /**
   * Replace an eval history row that ALREADY EXISTS, leaving its retention
   * exactly as it was. Returns `true` iff a row was there and was updated;
   * **never creates one**.
   *
   * This is how the runtime writes a CORRECTION — a diagnostics sweep rewriting
   * a row whose artifact it just reclaimed, a commit failure downgrading one.
   * Such a write has no business creating anything: the row may have been
   * deleted (a right-to-be-forgotten request) or expired between the moment the
   * correction was computed and the moment it lands, and `saveEvalResult` would
   * bring it back — permanently on a store with no expiry. Checking first and
   * then saving does not close that window; only the store can, so the
   * condition lives here.
   *
   * Implement it conditionally and atomically: `SET ... XX KEEPTTL` on Redis,
   * `UPDATE ... WHERE id = ?` on SQL, a presence check on an in-process map.
   * A store that does not implement it gets no correction written at all.
   */
  updateEvalResult?(entry: EvalHistoryEntry): Promise<boolean>;
  /** List eval history entries (most recent first). */
  listEvalResults?(limit?: number): Promise<EvalHistoryEntry[]>;
  /** Delete an eval history entry by id. Returns true if an entry was deleted. */
  deleteEvalResult?(id: string): Promise<boolean>;
  /**
   * Retention capability: does this eval history row still exist, and when does
   * the store itself expire it?
   *
   * Diagnostic artifacts (opt-in captured requests) live OUTSIDE the state store
   * — typically on a filesystem — and their lifetime must follow the history row
   * that owns them. A store with server-side expiry (Redis `PTTL`) cannot notify
   * that filesystem when a key ages out, so the runtime mirrors the absolute
   * `expiresAt` onto the artifact manifest at commit time and sweeps expired
   * bytes on a timer and at startup. Physical deletion is therefore EVENTUAL,
   * not synchronous with the store's expiry.
   *
   * Built-ins implement it. `MemoryStore` and `SQLiteStore` report the
   * absolute expiry they stored when `ttls.evalHistory` was configured at the
   * row's first write, and no `expiresAt` otherwise; `RedisStore` reports
   * existence and any live TTL. An expired row reports `{ exists: false }`.
   * A custom store WITHOUT this method cannot host managed artifact capture —
   * `AxlRuntime` rejects that configuration when it is constructed rather than
   * after a run has spent money.
   */
  getEvalRetention?(id: string): Promise<{ exists: boolean; expiresAt?: number }>;

  // History maintenance
  /**
   * Apply the store's configured history retention to records that were
   * saved without one (for example before an upgrade, or before a retention
   * was set), and repair the store's listing indexes. Processes one batch and
   * returns the cursor to continue from; call again with that cursor until it
   * is `null`. Axl never calls this itself: run it when you choose to.
   *
   * For each record in the batch that has no expiry, and only when a
   * retention is configured for `options.kind`:
   * - a record whose window has already passed is deleted, with the same
   *   per-run data a normal expiry removes;
   * - any other record gets the expiry it would have had: the retention
   *   counted from its last save (`completedAt` for executions, falling back
   *   to `startedAt`; `timestamp` for eval rows).
   *
   * Records that already have an expiry keep it. With no retention
   * configured for the kind (unset or `null`), nothing is expired or armed.
   *
   * The walk is oldest first, by `(startedAt, executionId)` for executions
   * and `(timestamp, id)` for eval rows, and the cursor is a position in that
   * order rather than an offset, so records removed behind it (by this call,
   * a concurrent delete or an expiry) never cause a record to be skipped.
   * Running it to completion twice changes nothing the second time.
   *
   * **Custom store implementors:** custom stores own their retention and may
   * implement this with the same contract, or leave it out. Built-ins:
   * - `MemoryStore` and `SQLiteStore` act on their rows directly; they keep
   *   no separate index, so `indexed` and `deadIndexEntries` are always `0`.
   * - `RedisStore` also adds records that already carry a TTL to its expiry
   *   index (`indexed`) and removes index entries whose record is gone
   *   (`deadIndexEntries`).
   */
  applyHistoryRetention?(options: HistoryRetentionOptions): Promise<HistoryRetentionResult>;

  // Sessions (Studio introspection)
  /** List all session IDs (used by Studio session browser). */
  listSessions?(): Promise<string[]>;

  // Streaming trace persistence (for `state.persist: 'streaming'`)
  //
  // These methods power the "in-flight durability" path: events are batched
  // and appended to a transient streaming buffer throughout the run, then
  // finalized (the buffer dropped) once the canonical `executionHistory`
  // blob lands at terminal exit. If the process crashes mid-run, the
  // streaming buffer is the only surviving record — `listStreamingExecutions`
  // + `getStreamingEvents` let the next process reconstruct a partial
  // `ExecutionInfo` via `runtime.recoverIncompleteStreams()`.
  //
  // All four methods are OPTIONAL. Stores that don't implement them treat
  // `state.persist: 'streaming'` as a soft no-op (no streaming durability,
  // but the workflow still runs normally). Coverage in built-ins:
  //   - RedisStore: implements all four with crash-survival (the intended
  //     production use case).
  //   - MemoryStore: implements all four with in-process Map storage —
  //     good for tests; lost on crash like the rest of MemoryStore state.
  //   - SQLiteStore: does NOT implement streaming methods. Single-process
  //     file storage gets less value from crash-survival, and the
  //     workflow's terminal `saveExecution` already gives full durability.
  //     Configuring `state.persist: 'streaming'` against SQLite emits a
  //     one-shot warning at runtime startup and falls back to terminal
  //     semantics.

  /**
   * Append a batch of events to the streaming buffer for an execution.
   * Should be idempotent w.r.t. the executionId being new vs existing
   * (first call also registers the id in the "in-flight" index used by
   * `listStreamingExecutions`).
   */
  appendStreamingEvents?(executionId: string, events: AxlEvent[]): Promise<void>;
  /**
   * Finalize a streaming execution — delete its buffer + un-register it
   * from the in-flight index. Called by the runtime after the canonical
   * `executionHistory` blob has been written, so the streaming buffer
   * is no longer the source of truth for this execution.
   */
  finalizeStreamingEvents?(executionId: string): Promise<void>;
  /**
   * List execution IDs that have a streaming buffer but no corresponding
   * completed `executionHistory` — i.e., runs whose process died mid-flight.
   * The runtime calls this from `recoverIncompleteStreams()`.
   */
  listStreamingExecutions?(): Promise<string[]>;
  /**
   * Read the events accumulated in the streaming buffer for an execution.
   * Returns `[]` if no buffer exists.
   */
  getStreamingEvents?(executionId: string): Promise<HistoricalAxlEvent[]>;

  // Lifecycle
  close?(): Promise<void>;
  deleteCheckpoints?(executionId: string): Promise<void>;
}

/**
 * Position in execution history, used to fetch the next page. Pages are
 * ordered by `startedAt` descending, then `executionId` descending; a cursor
 * built from the last item of one page returns the items strictly after it.
 */
export type ExecutionCursor = {
  startedAt: number;
  executionId: string;
};

/**
 * History retention, in **seconds**, shared by the built-in stores
 * (`MemoryStore`, `SQLiteStore`, and the matching categories of
 * `RedisStore`'s `ttls`).
 *
 * - A positive number expires the record that many seconds after it is saved.
 * - `null` or unset keeps it forever.
 *
 * Windows differ per category:
 * - `executionHistory` counts from the record's **last** save; saving the same
 *   execution again restarts the window.
 * - `evalHistory` counts from the row's **first** write. Saving the same eval
 *   id again keeps the expiry it already had, and `updateEvalResult` never
 *   changes it.
 *
 * Retention applies to records saved while it is configured; rows written
 * before keep whatever expiry they had until you run
 * {@link StateStore.applyHistoryRetention}. Custom stores own their retention.
 */
export type HistoryTtls = {
  executionHistory?: number | null;
  evalHistory?: number | null;
};

/** Which history {@link StateStore.applyHistoryRetention} processes. */
export type HistoryRetentionKind = 'executions' | 'evals';

/**
 * Where {@link StateStore.applyHistoryRetention} continues from: the last
 * record of the previous batch, oldest-first. `time` is `startedAt` for
 * executions and `timestamp` for eval rows. Pass it back unchanged; it is
 * plain JSON, so it can be stored between runs.
 */
export type HistoryRetentionCursor = {
  time: number;
  id: string;
};

/** Options for {@link StateStore.applyHistoryRetention}. */
export type HistoryRetentionOptions = {
  kind: HistoryRetentionKind;
  /** Records examined per call. A positive integer; defaults to 500. */
  batchSize?: number;
  /** The `cursor` returned by the previous call. Omit or pass `null` to start. */
  cursor?: HistoryRetentionCursor | null;
};

/** What one {@link StateStore.applyHistoryRetention} call did. */
export type HistoryRetentionResult = {
  /** Records with no expiry whose window had already passed, now deleted. */
  expired: number;
  /** Records with no expiry that now have one. */
  armed: number;
  /** Records that already had an expiry, newly added to the store's expiry index (Redis). */
  indexed: number;
  /** Index entries whose record no longer exists, now removed (Redis). */
  deadIndexEntries: number;
  /** Pass to the next call, or `null` when the walk is finished. */
  cursor: HistoryRetentionCursor | null;
};

/** Persisted eval history entry. */
export type EvalHistoryEntry = {
  id: string;
  eval: string;
  timestamp: number;
  data: unknown;
};
