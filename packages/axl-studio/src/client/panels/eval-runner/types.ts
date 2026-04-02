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

// ── Score color utilities ─────────────────────────────────────────

/** Color class for score badges — 3-tier (green/amber/red like Lighthouse). */
export function scoreColorClass(score: number): string {
  if (score >= 0.8)
    return 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300';
  if (score >= 0.5) return 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300';
  return 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300';
}

/** Fill color for score indicator bars. */
export function scoreBarColor(score: number): string {
  if (score >= 0.8) return 'bg-emerald-500 dark:bg-emerald-400';
  if (score >= 0.5) return 'bg-amber-500 dark:bg-amber-400';
  return 'bg-red-500 dark:bg-red-400';
}

/** Text color for score values. */
export function scoreTextColor(score: number): string {
  if (score >= 0.8) return 'text-emerald-600 dark:text-emerald-400';
  if (score >= 0.5) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

/** Subtle background tint for stat cards based on score. */
export function scoreBgTint(score: number): string {
  if (score >= 0.8) return 'bg-emerald-50/60 dark:bg-emerald-950/20';
  if (score >= 0.5) return 'bg-amber-50/60 dark:bg-amber-950/20';
  return 'bg-red-50/60 dark:bg-red-950/20';
}
