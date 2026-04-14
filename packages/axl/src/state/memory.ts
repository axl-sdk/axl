import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatMessage, ExecutionInfo, HumanDecision } from '../types.js';
import type { StateStore, PendingDecision, ExecutionState, EvalHistoryEntry } from './types.js';

/**
 * Path to the MemoryStore temp file for awaitHuman state.
 * Ensures awaitHuman state survives process restarts even
 * when using MemoryStore (spec requirement).
 *
 * NOTE: tmpdir() persistence is best-effort. Temp directories may be cleaned
 * by the OS at any time (e.g., on reboot or via periodic cleanup policies).
 * For durable awaitHuman persistence, use SQLite or Redis state stores.
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
 */
export class MemoryStore implements StateStore {
  private checkpoints = new Map<string, Map<number, unknown>>();
  private sessions = new Map<string, ChatMessage[]>();
  private sessionMeta = new Map<string, Map<string, unknown>>();
  private decisions = new Map<string, PendingDecision>();
  private executionStates = new Map<string, ExecutionState>();
  private memories = new Map<string, Map<string, unknown>>();
  private executionHistory = new Map<string, ExecutionInfo>();
  private evalHistory = new Map<string, EvalHistoryEntry>();

  constructor() {
    // Load any persisted awaitHuman state from previous process
    this.loadPersistedState();
  }

  async saveCheckpoint(executionId: string, step: number, data: unknown): Promise<void> {
    let steps = this.checkpoints.get(executionId);
    if (!steps) {
      steps = new Map();
      this.checkpoints.set(executionId, steps);
    }
    steps.set(step, structuredClone(data));
  }

  async getCheckpoint(executionId: string, step: number): Promise<unknown | null> {
    const steps = this.checkpoints.get(executionId);
    if (!steps) return null;
    const data = steps.get(step);
    return data !== undefined ? structuredClone(data) : null;
  }

  async getLatestCheckpoint(executionId: string): Promise<{ step: number; data: unknown } | null> {
    const steps = this.checkpoints.get(executionId);
    if (!steps || steps.size === 0) return null;
    let maxStep = -1;
    for (const step of steps.keys()) {
      if (step > maxStep) maxStep = step;
    }
    return { step: maxStep, data: structuredClone(steps.get(maxStep)) };
  }

  async saveSession(sessionId: string, history: ChatMessage[]): Promise<void> {
    this.sessions.set(sessionId, structuredClone(history));
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

  async saveExecution(execution: ExecutionInfo): Promise<void> {
    this.executionHistory.set(execution.executionId, structuredClone(execution));
  }

  async getExecution(executionId: string): Promise<ExecutionInfo | null> {
    const exec = this.executionHistory.get(executionId);
    return exec ? structuredClone(exec) : null;
  }

  async listExecutions(limit?: number): Promise<ExecutionInfo[]> {
    const sorted = [...this.executionHistory.values()].sort((a, b) => b.startedAt - a.startedAt);
    const result = limit ? sorted.slice(0, limit) : sorted;
    return result.map((e) => structuredClone(e));
  }

  // ── Eval History ──────────────────────────────────────────────────

  async saveEvalResult(entry: EvalHistoryEntry): Promise<void> {
    this.evalHistory.set(entry.id, structuredClone(entry));
  }

  async listEvalResults(limit?: number): Promise<EvalHistoryEntry[]> {
    const sorted = [...this.evalHistory.values()].sort((a, b) => b.timestamp - a.timestamp);
    const result = limit ? sorted.slice(0, limit) : sorted;
    return result.map((e) => structuredClone(e));
  }

  async deleteEvalResult(id: string): Promise<boolean> {
    return this.evalHistory.delete(id);
  }

  // ── Sessions (Studio introspection) ─────────────────────────────────

  async listSessions(): Promise<string[]> {
    return [...this.sessions.keys()];
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
