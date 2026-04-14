import type { Dataset } from './dataset.js';
import type { Scorer } from './scorer.js';

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
