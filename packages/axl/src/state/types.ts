import type { AxlEvent, ChatMessage, ExecutionInfo, HumanDecision } from '../types.js';

/** A pending human decision awaiting resolution. */
export type PendingDecision = {
  executionId: string;
  channel: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

/** Persisted execution state for suspend/resume. */
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

  // Execution state persistence (for suspend/resume)
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
  saveExecution?(execution: ExecutionInfo): Promise<void>;
  /** Get a specific execution by ID from history. */
  getExecution?(executionId: string): Promise<ExecutionInfo | null>;
  /** List recent executions (most recent first). */
  listExecutions?(limit?: number): Promise<ExecutionInfo[]>;
  /**
   * Delete an execution from history by ID. Returns `true` if an entry was
   * deleted, `false` if the ID didn't exist. Used for GDPR right-to-be-
   * forgotten and operator-driven cleanup. Symmetric to `deleteEvalResult`.
   */
  deleteExecution?(executionId: string): Promise<boolean>;

  // Eval history
  /** Save an eval result to history. */
  saveEvalResult?(entry: EvalHistoryEntry): Promise<void>;
  /** List eval history entries (most recent first). */
  listEvalResults?(limit?: number): Promise<EvalHistoryEntry[]>;
  /** Delete an eval history entry by id. Returns true if an entry was deleted. */
  deleteEvalResult?(id: string): Promise<boolean>;

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
  getStreamingEvents?(executionId: string): Promise<AxlEvent[]>;

  // Lifecycle
  close?(): Promise<void>;
  deleteCheckpoints?(executionId: string): Promise<void>;
}

/** Persisted eval history entry. */
export type EvalHistoryEntry = {
  id: string;
  eval: string;
  timestamp: number;
  data: unknown;
};
