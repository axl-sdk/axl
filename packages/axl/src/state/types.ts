import type { ChatMessage, HumanDecision } from '../types.js';

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
  // Checkpoints
  saveCheckpoint(executionId: string, step: number, data: unknown): Promise<void>;
  getCheckpoint(executionId: string, step: number): Promise<unknown | null>;
  getLatestCheckpoint(executionId: string): Promise<{ step: number; data: unknown } | null>;

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

  // Sessions (Studio introspection)
  /** List all session IDs (used by Studio session browser). */
  listSessions?(): Promise<string[]>;

  // Lifecycle
  close?(): Promise<void>;
  deleteCheckpoints?(executionId: string): Promise<void>;
}
