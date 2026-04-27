import type { Dataset } from './dataset.js';
import type { Scorer } from './scorer.js';
import type { AxlEvent } from '@axlsdk/axl';

export type EvalConfig = {
  workflow: string;
  dataset: Dataset<unknown, unknown>;
  scorers: Scorer<unknown, unknown, unknown>[];
  concurrency?: number;
  budget?: string;
  metadata?: Record<string, unknown>;
};

export type EvalResult = {
  id: string;
  /**
   * Definitional dataset name. An eval is tied to exactly one dataset —
   * `evalCompare` enforces this. Execution details (models, workflows,
   * tokens) live in `metadata`.
   */
  dataset: string;
  /**
   * Aggregate execution metadata. Populated by the runner from trace events
   * and per-item metadata. Common keys:
   * - `models: string[]` + `modelCounts: Record<string, number>`
   * - `workflows: string[]` + `workflowCounts: Record<string, number>` —
   *   workflow names observed during execution (trace-derived). Parallel
   *   to `models`. Replaces the legacy top-level `workflow` field; readers
   *   that need a single "primary" workflow should use `workflows[0]`.
   * - `scorerTypes: Record<string, 'llm' | 'deterministic'>`
   * - `runGroupId?: string`, `runIndex?: number` for multi-run groups
   */
  metadata: Record<string, unknown>;
  timestamp: string;
  totalCost: number;
  duration: number;
  items: EvalItem[];
  summary: EvalSummary;
};

export type ScorerDetail = {
  score: number | null;
  metadata?: Record<string, unknown>;
  duration?: number;
  cost?: number;
};

export type EvalItem = {
  input: unknown;
  annotations?: unknown;
  output: unknown;
  error?: string;
  scorerErrors?: string[];
  scores: Record<string, number | null>;
  duration?: number;
  cost?: number;
  scorerCost?: number;
  scoreDetails?: Record<string, ScorerDetail>;
  /** Execution metadata forwarded from the runtime (models, tokens, agentCalls, etc). */
  metadata?: Record<string, unknown>;
  /** Trace events captured during this item's execution. Only populated when
   *  `runEval` was called with `{ captureTraces: true }`. Verbose-mode
   *  `agent_call_start.data.messages` snapshots are stripped to keep memory bounded;
   *  subscribe to `runtime.on('trace', ...)` directly if you need those. */
  traces?: AxlEvent[];
};

export type EvalSummary = {
  count: number;
  failures: number;
  scorers: Record<
    string,
    {
      mean: number;
      min: number;
      max: number;
      p50: number;
      p95: number;
    }
  >;
  timing?: {
    mean: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
  };
};

export type EvalComparison = {
  baseline: { id: string; metadata: Record<string, unknown> };
  candidate: { id: string; metadata: Record<string, unknown> };
  scorers: Record<
    string,
    {
      baselineMean: number;
      candidateMean: number;
      delta: number;
      deltaPercent: number;
      ci?: { lower: number; upper: number };
      significant?: boolean;
      pRegression?: number;
      pImprovement?: number;
      /** Number of paired item differences used for CI computation. */
      n?: number;
    }
  >;
  timing?: {
    baselineMean: number;
    candidateMean: number;
    delta: number;
    deltaPercent: number;
  };
  cost?: {
    baselineTotal: number;
    candidateTotal: number;
    delta: number;
    deltaPercent: number;
  };
  regressions: EvalRegression[];
  improvements: EvalImprovement[];
  summary: string;
};

export type EvalRegression = {
  itemIndex: number;
  input: unknown;
  scorer: string;
  baselineScore: number;
  candidateScore: number;
  delta: number;
};

export type EvalImprovement = EvalRegression;

export type EvalCompareOptions = {
  /** Global threshold or per-scorer map. Default: auto-calibrate from scorerTypes metadata. */
  thresholds?: Record<string, number> | number;
};

// ── Progress & cancellation ──────────────────────────────────────

/**
 * Emitted by `runEval` at two points:
 *
 * - `'item_done'` — after each dataset item is fully processed (executed +
 *   scored). Emitted for every item regardless of outcome: success, workflow
 *   error, scorer error, cancelled (via `signal`), or budget exhaustion.
 * - `'run_done'` — once after all items have finished and the final summary
 *   has been computed. Includes total item count and failure count so
 *   consumers can show a completion toast without waiting for the full result.
 *
 * Consumers should narrow on `type` — the shape is a discriminated union.
 */
export type EvalProgressEvent =
  | { type: 'item_done'; itemIndex: number; totalItems: number }
  | { type: 'run_done'; totalItems: number; failures: number };

/** Optional runtime behavior for `runEval()`. */
export type RunEvalOptions = {
  /** Called after each dataset item completes (execution + scoring). */
  onProgress?: (event: EvalProgressEvent) => void;
  /** Abort signal — checked before starting each item. */
  signal?: AbortSignal;
  /**
   * Capture per-item `AxlEvent[]` from the runtime and store them on
   * `EvalItem.traces`. Off by default because traces multiply memory with
   * dataset size × turns × agents. When on, the runner wraps the user-provided
   * `executeWorkflow` with `runtime.trackExecution({ captureTraces: true })`,
   * so any `runtime.execute()` / `ctx.ask()` activity inside the callback is
   * captured and scoped to the current item.
   *
   * Note: verbose-mode `agent_call_start.data.messages` snapshots are stripped from
   * captured traces to keep memory bounded — if you need the full verbose
   * payload, subscribe to `runtime.on('trace', ...)` directly.
   */
  captureTraces?: boolean;
};
