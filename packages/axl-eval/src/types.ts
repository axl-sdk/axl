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
  workflow: string;
  dataset: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  totalCost: number;
  duration: number;
  items: EvalItem[];
  summary: EvalSummary;
};

export type EvalItem = {
  input: unknown;
  annotations?: unknown;
  output: unknown;
  error?: string;
  errors?: string[];
  scores: Record<string, number>;
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
    }
  >;
  regressions: EvalRegression[];
  improvements: EvalImprovement[];
  summary: string;
};

export type EvalRegression = {
  input: unknown;
  scorer: string;
  baselineScore: number;
  candidateScore: number;
  delta: number;
};

export type EvalImprovement = EvalRegression;
