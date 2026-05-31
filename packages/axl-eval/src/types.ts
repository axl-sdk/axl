import type { Dataset } from './dataset.js';
import type { Scorer } from './scorer.js';
import type { AxlEvent } from '@axlsdk/axl';

export type EvalConfig = {
  workflow: string;
  dataset: Dataset<unknown, unknown>;
  scorers: Scorer<unknown, unknown, unknown>[];
  /** Item-level worker-pool size (how many dataset items run in parallel). Default 5. */
  concurrency?: number;
  /**
   * Per-item scorer fan-out — how many of an item's scorers run concurrently.
   * Default 5 (matches `concurrency`; scorers are parallel-by-default). The
   * worst-case number of concurrent scorer calls is `concurrency × scorerConcurrency`,
   * so lower `concurrency` if a rate-limited judge model needs a tighter ceiling.
   */
  scorerConcurrency?: number;
  budget?: string;
  /**
   * Opt-in source-side trust gate. When set (0–1), `runEval` flags the run as
   * `summary.degraded` if any scorer's failure rate exceeds tolerance, and the
   * CLI exits non-zero. Enforcement is **type-aware**: deterministic scorers
   * tolerate ZERO failures (a deterministic scorer that throws is a bug, not
   * noise), while LLM scorers use this rate (a flaky judge / rate-limit storm).
   *
   * Failure rate = `failed / (scored + failed)` per scorer, where `scored` is
   * the number of items that produced a valid numeric score and `failed` is the
   * number whose scorer ran and threw / returned out-of-range. `0` means "any
   * LLM failure degrades the run". Invalid values (non-finite, <0, >1) are
   * ignored with a `console.warn`.
   *
   * Distinct from the gate-side `--max-scorer-error-rate` compare flag: this one
   * fires at run/produce time (catch a thinned sample before it's saved), the
   * other at consume/gate time (refuse to certify a thinned baseline/candidate).
   */
  failOnScorerErrorRate?: number;
  metadata?: Record<string, unknown>;
};

/**
 * One scorer whose failure rate tripped `EvalConfig.failOnScorerErrorRate`.
 * Surfaced on `EvalSummary.degraded` so consumers (CLI exit code, Studio
 * banner) can refuse to trust the mean without re-deriving the rate.
 */
export type DegradedScorer = {
  scorer: string;
  /** Observed failure rate `failed / (scored + failed)` (0 when nothing ran). */
  rate: number;
  /** The tolerance that was exceeded (0 for deterministic scorers). */
  limit: number;
  type: 'llm' | 'deterministic';
  /** Items that produced a valid numeric score. */
  scored: number;
  /** Items whose scorer ran and failed (threw / out-of-range). */
  failed: number;
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
   * - `droppedAnnotationKeys?: string[]` — annotation key paths the dataset
   *   schema stripped (present only when non-empty). Mirrors the dataset's
   *   `console.warn`; lets any consumer surface the same signal.
   * - `scorerFiltered?: boolean` + `scorersRun?: string[]` — set when the CLI
   *   `--scorers` flag ran a subset of scorers. A guard so a filtered run isn't
   *   silently used as a full baseline (`compare` warns / refuses to gate on it).
   *   Distinct from the multi-run "partial" concept (see {@link EvalComparisonPartial}).
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
  /**
   * `true` when the scorer's `applies` predicate returned `false` for this item,
   * so the scorer was deliberately skipped (NOT run). Distinct from a `null`
   * score WITH a `duration` (ran-and-failed) and from a `null` score with
   * neither field (skipped by cancellation). A skipped item is excluded from the
   * mean AND from the failure-rate denominator — see `scorerCounts`.
   */
  skipped?: boolean;
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
      /**
       * Number of items that produced a valid numeric score — the sample size
       * the `mean` actually covers. Optional so pre-existing artifacts (and
       * hand-rolled summaries) stay valid; absent ⇒ recompute from `items`.
       * Named `scored` (NOT `n`) to avoid collision with
       * `EvalComparison.scorers[].n` (paired-diff count).
       */
      scored?: number;
      /**
       * Number of items whose scorer RAN and failed (threw or returned
       * out-of-range). Distinct from items skipped by cancellation, which land
       * in neither bucket — so `scored + failed` is the honest "attempted"
       * denominator and may be `<` the eligible item count. A non-zero `failed`
       * means the `mean` was computed over a thinned sample.
       */
      failed?: number;
      /**
       * Number of items for which this scorer's `applies` predicate returned
       * `false` — deliberately skipped, NOT run. Counted in neither `scored` nor
       * `failed`, so it never inflates the failure rate. Optional so pre-existing
       * artifacts stay valid; absent ⇒ recompute from `items` (0 if no skips).
       */
      skipped?: number;
    }
  >;
  timing?: {
    mean: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
  };
  /**
   * Populated by `runEval` ONLY when `EvalConfig.failOnScorerErrorRate` is set
   * and one or more scorers exceeded tolerance. `runEval` never throws on this
   * — it returns the (still-useful) result with this flag set, and the CLI /
   * consumer decides whether to fail. Absent / empty ⇒ no degradation gate
   * tripped (either not configured or all scorers within tolerance).
   */
  degraded?: DegradedScorer[];
};

/**
 * Sample-size context for one side of a comparison.
 *
 * Set when the runs pooled for this side reflect fewer runs than the
 * original batch planned (`runs.length < runs[0].metadata.batchAttempted`).
 * Two causes are conflated under the same label:
 *   - The batch failed mid-way (e.g. 2 of 5 runs completed). `evalCompare`
 *     can't safely conclude statistical significance against a complete
 *     side without highlighting the smaller-N source.
 *   - The user deliberately picked a subset of completed runs from the
 *     comparison picker. Same wire-level signal; same warning is fair.
 *
 * Consumers (UI compare view) render this as `(partial: 2 of 5 runs)` so
 * the user doesn't mistake a smaller-N candidate for an apples-to-apples
 * comparison against a complete baseline.
 */
export type EvalComparisonPartial = {
  /** Number of runs actually included in this side's pool. */
  completed: number;
  /** Original planned run count (from `metadata.batchAttempted`). */
  attempted: number;
};

export type EvalComparison = {
  baseline: {
    id: string;
    metadata: Record<string, unknown>;
    partial?: EvalComparisonPartial;
    /**
     * Number of runs from this side actually included in mean / regression /
     * timing / cost calculations. When the user pools 5 baseline runs vs 2
     * candidate runs, both sides truncate to `min(5, 2) = 2` so the means
     * the UI displays are computed over the same sample as the paired
     * bootstrap CI. The discarded tail of runs is still in history for the
     * user to re-pool intentionally if they want a 5-vs-5 comparison.
     */
    runCount: number;
  };
  candidate: {
    id: string;
    metadata: Record<string, unknown>;
    partial?: EvalComparisonPartial;
    runCount: number;
  };
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
      /**
       * Per-side scorer success/failure counts over the SAME truncated pool the
       * means and CI are computed from (not a separately-recomputed raw set), so
       * a gate reads numbers consistent with what the table displays. Raw counts
       * (consumer divides) keep this truncation-consistent. A non-zero
       * `*Failed` means that side's mean rests on a thinned sample — the gate-side
       * `--max-scorer-error-rate` flag refuses to certify when it's over tolerance.
       */
      baselineScored?: number;
      baselineFailed?: number;
      candidateScored?: number;
      candidateFailed?: number;
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
