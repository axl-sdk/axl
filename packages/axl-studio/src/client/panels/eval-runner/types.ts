// ── Types matching @axlsdk/eval's EvalResult shape ───────────────

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
};

export type ScorerStats = {
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
};

export type EvalResultData = {
  id: string;
  workflow: string;
  dataset: string;
  timestamp: string;
  totalCost: number;
  duration: number;
  items: EvalItem[];
  summary: {
    count: number;
    failures: number;
    scorers: Record<string, ScorerStats>;
    timing?: {
      mean: number;
      min: number;
      max: number;
      p50: number;
      p95: number;
    };
  };
};

export type ComparisonResult = {
  regressions?: Array<{
    itemIndex: number;
    scorer: string;
    delta: number;
    baselineScore: number;
    candidateScore: number;
    input?: unknown;
  }>;
  improvements?: Array<{
    itemIndex: number;
    scorer: string;
    delta: number;
    baselineScore: number;
    candidateScore: number;
    input?: unknown;
  }>;
  scorers?: Record<
    string,
    { baselineMean: number; candidateMean: number; delta: number; deltaPercent: number }
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
  summary?: string;
  [key: string]: unknown;
};

/** Color class for a score value. Green >= 0.8, amber >= 0.5, red < 0.5. */
export function scoreColorClass(score: number): string {
  if (score >= 0.8) return 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300';
  if (score >= 0.5) return 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300';
  return 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300';
}
