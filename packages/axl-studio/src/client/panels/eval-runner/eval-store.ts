import { useSyncExternalStore } from 'react';
import { wsClient } from '../../lib/ws';
import { startEvalRun as apiStartEvalRun, cancelEvalRun as apiCancelEvalRun } from '../../lib/api';

// ── Types ──────────────────────────────────────────────────────────

export type EvalProgress = {
  completedItems: number;
  totalItems: number;
  completedRuns: number;
  totalRuns: number;
};

/**
 * Done-event notification from the server.
 *
 * The server used to broadcast the full `EvalResult` here, but real-world
 * results (12 items × several scorers × per-item metadata) easily exceed
 * the 64KB WS frame budget, hit `truncateIfOversized`, and made the
 * client render a blank screen. We now broadcast a tiny pointer and the
 * panel fetches the full payload from `/api/evals/history` on adoption.
 *
 * `runGroupId` is populated for multi-run eval executions so the panel
 * can rebuild the `_multiRun` aggregate view from sibling history entries.
 */
export type EvalDoneInfo = {
  evalResultId: string;
  runGroupId?: string;
};

export type EvalExecState = {
  status: 'idle' | 'running' | 'done' | 'error';
  evalRunId: string | null;
  evalName: string | null;
  runCount: number;
  startedAt: number | null;
  progress: EvalProgress | null;
  /** Pointer to the completed eval result in history. Null until status === 'done'. */
  done: EvalDoneInfo | null;
  error: string | null;
};

// ── Module-level store ─────────────────────────────────────────────

const IDLE: EvalExecState = {
  status: 'idle',
  evalRunId: null,
  evalName: null,
  runCount: 1,
  startedAt: null,
  progress: null,
  done: null,
  error: null,
};

/**
 * How long to wait without any WS event before assuming the server is gone.
 * Resets on every incoming event (item_done, run_done, etc.). If the timer
 * fires, the store transitions to error so the UI isn't stuck forever.
 *
 * 5 minutes is generous — even a large eval with LLM scorers should produce
 * at least one item_done within this window. The user can always cancel
 * manually before the timeout fires.
 */
const STALE_TIMEOUT_MS = 5 * 60 * 1000;

let state: EvalExecState = IDLE;
const listeners = new Set<() => void>();
let unsubscribeWs: (() => void) | null = null;
let staleTimer: ReturnType<typeof setTimeout> | null = null;

function setState(next: EvalExecState) {
  state = next;
  for (const l of listeners) l();
}

function getSnapshot(): EvalExecState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function cleanup() {
  if (unsubscribeWs) {
    unsubscribeWs();
    unsubscribeWs = null;
  }
  if (staleTimer) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }
}

/** Reset the stale-run watchdog. Called on every incoming WS event. */
function resetStaleTimer() {
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = setTimeout(() => {
    if (state.status === 'running') {
      setState({
        ...state,
        status: 'error',
        error:
          'Lost contact with the server — no progress received. The eval may still be running; check the History tab.',
      });
      cleanup();
    }
  }, STALE_TIMEOUT_MS);
}

// ── React hook ─────────────────────────────────────────────────────

/** Subscribe to eval execution state. Survives route changes. */
export function useEvalExecution(): EvalExecState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// ── Actions ────────────────────────────────────────────────────────

/** Start a streaming eval run. Returns when the server acknowledges (not when eval completes). */
export async function startEvalRun(evalName: string, runCount: number): Promise<void> {
  // Guard: if an eval is already running, cancel it first so we don't
  // orphan a server-side run with no client-side listener.
  if (state.status === 'running' && state.evalRunId) {
    try {
      await apiCancelEvalRun(state.evalRunId);
    } catch {
      // Best effort — server may have already completed
    }
  }

  cleanup();

  setState({
    ...IDLE,
    status: 'running',
    evalName,
    runCount,
    startedAt: Date.now(),
  });

  // If the server rejects the request (network, 4xx, etc.), the previous
  // code left the store stuck in `running` with no evalRunId. Guard against
  // that by catching and transitioning to an error state so the UI can recover.
  let evalRunId: string;
  try {
    const ack = await apiStartEvalRun(evalName, { runs: runCount });
    evalRunId = ack.evalRunId;
  } catch (err) {
    setState({
      ...IDLE,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  setState({ ...state, evalRunId });

  // Start the watchdog — if no WS event arrives within STALE_TIMEOUT_MS,
  // assume the server is unreachable and transition to error.
  resetStaleTimer();

  // Subscribe to progress events from the server
  unsubscribeWs = wsClient.subscribe(`eval:${evalRunId}`, (data: unknown) => {
    const event = data as Record<string, unknown>;

    // Every event resets the stale-run watchdog
    resetStaleTimer();

    switch (event.type) {
      case 'item_done': {
        const itemIndex = event.itemIndex as number;
        const totalItems = event.totalItems as number;
        const run = typeof event.run === 'number' ? (event.run as number) : 1;
        const totalRuns = typeof event.totalRuns === 'number' ? (event.totalRuns as number) : 1;
        setState({
          ...state,
          progress: {
            completedItems: itemIndex + 1,
            totalItems,
            // During multi-run, run_done increments completedRuns.
            // item_done tracks within the current run.
            completedRuns: run - 1,
            totalRuns,
          },
        });
        break;
      }

      case 'run_done': {
        const run = event.run as number;
        const totalRuns = event.totalRuns as number;
        setState({
          ...state,
          progress: {
            completedItems: 0,
            totalItems: state.progress?.totalItems ?? 0,
            completedRuns: run,
            totalRuns,
          },
        });
        break;
      }

      case 'done': {
        const evalResultId = typeof event.evalResultId === 'string' ? event.evalResultId : null;
        const runGroupId = typeof event.runGroupId === 'string' ? event.runGroupId : undefined;
        // Defensive: if the server somehow skipped the id field, fall
        // through to error state so the UI isn't left hanging.
        if (!evalResultId) {
          setState({
            ...state,
            status: 'error',
            error: 'Eval completed without a result id — cannot adopt from history.',
          });
        } else {
          setState({
            ...state,
            status: 'done',
            done: runGroupId ? { evalResultId, runGroupId } : { evalResultId },
          });
        }
        cleanup();
        break;
      }

      case 'error':
        setState({ ...state, status: 'error', error: event.message as string });
        cleanup();
        break;
    }
  });
}

/** Cancel the active streaming eval run. */
export async function cancelEvalRun(): Promise<void> {
  if (state.evalRunId) {
    try {
      await apiCancelEvalRun(state.evalRunId);
    } catch {
      // Best effort — server may have already completed
    }
  }
  setState({ ...state, status: 'error', error: 'Cancelled' });
  cleanup();
}

/** Reset to idle. Call after adopting the result into local panel state. */
export function clearEvalRun(): void {
  setState(IDLE);
  cleanup();
}
