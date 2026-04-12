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
  metadata?: Record<string, unknown>;
};

export type ScorerStats = {
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
};

export type MultiRunAggregate = {
  runGroupId: string;
  runCount: number;
  scorers: Record<string, { mean: number; std: number; min: number; max: number }>;
  timing?: { mean: number; std: number };
};

export type EvalResultData = {
  id: string;
  workflow: string;
  dataset: string;
  metadata?: Record<string, unknown>;
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
  _multiRun?: {
    aggregate: MultiRunAggregate;
    allRuns: EvalResultData[];
  };
};

export type ComparisonRegressionItem = {
  itemIndex: number;
  scorer: string;
  delta: number;
  baselineScore: number;
  candidateScore: number;
  input?: unknown;
};

export type ComparisonScorerEntry = {
  baselineMean: number;
  candidateMean: number;
  delta: number;
  deltaPercent: number;
  ci?: { lower: number; upper: number };
  significant?: boolean;
  pRegression?: number;
  pImprovement?: number;
  n?: number;
};

export type ComparisonResult = {
  regressions: ComparisonRegressionItem[];
  improvements: ComparisonRegressionItem[];
  scorers: Record<string, ComparisonScorerEntry>;
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
  summary: string;
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

// ── Metadata helpers ─────────────────────────────────────────────

/** Extract model URIs from an EvalItem's execution metadata. */
export function getItemModels(item: EvalItem): string[] {
  if (!Array.isArray(item.metadata?.models)) return [];
  return (item.metadata.models as unknown[]).filter((m): m is string => typeof m === 'string');
}

/** Extract model URIs from an EvalResultData's aggregate metadata (sorted by usage, most-used first). */
export function getResultModels(result: EvalResultData): string[] {
  if (!Array.isArray(result.metadata?.models)) return [];
  return (result.metadata.models as unknown[]).filter((m): m is string => typeof m === 'string');
}

/** Extract per-model LLM call counts from result metadata. */
export function getResultModelCounts(result: EvalResultData): Record<string, number> | null {
  const mc = result.metadata?.modelCounts;
  if (!mc || typeof mc !== 'object') return null;
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(mc as Record<string, unknown>)) {
    if (typeof v === 'number') counts[k] = v;
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

/** Strip provider prefix from model URI: "anthropic:claude-sonnet-4-6" → "claude-sonnet-4-6". */
export function formatModelName(uri: string): string {
  const idx = uri.indexOf(':');
  return idx >= 0 ? uri.slice(idx + 1) : uri;
}

/** Token counts from execution metadata. */
export type TokenCounts = { input: number; output: number; reasoning: number };

/** Extract token counts from an EvalItem's execution metadata. */
export function getItemTokens(item: EvalItem): TokenCounts | null {
  const t = item.metadata?.tokens;
  if (!t || typeof t !== 'object') return null;
  const tokens = t as Record<string, unknown>;
  if (typeof tokens.input !== 'number') return null;
  return {
    input: tokens.input,
    output: typeof tokens.output === 'number' ? tokens.output : 0,
    reasoning: typeof tokens.reasoning === 'number' ? tokens.reasoning : 0,
  };
}

/** Extract agent call count from an EvalItem's execution metadata. */
export function getItemAgentCalls(item: EvalItem): number {
  const n = item.metadata?.agentCalls;
  return typeof n === 'number' ? n : 0;
}

/** Aggregate token counts across all items in a result. */
export function getResultTokens(result: EvalResultData): TokenCounts {
  const totals: TokenCounts = { input: 0, output: 0, reasoning: 0 };
  for (const item of result.items) {
    const t = getItemTokens(item);
    if (t) {
      totals.input += t.input;
      totals.output += t.output;
      totals.reasoning += t.reasoning;
    }
  }
  return totals;
}

// ── Group aggregation helpers (for multi-run groups) ─────────

/** Aggregate per-model call counts across multiple results (e.g., runs in a group). */
export function aggregateGroupModelCounts(entries: Array<{ data: unknown }>): [string, number][] {
  const groupCounts = new Map<string, number>();
  for (const e of entries) {
    const data = e.data as EvalResultData;
    const counts = getResultModelCounts(data);
    if (counts) {
      for (const [m, n] of Object.entries(counts))
        groupCounts.set(m, (groupCounts.get(m) ?? 0) + n);
    } else {
      for (const m of getResultModels(data)) groupCounts.set(m, (groupCounts.get(m) ?? 0) + 1);
    }
  }
  return [...groupCounts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Aggregate token counts across multiple results. */
export function aggregateGroupTokens(results: EvalResultData[]): TokenCounts {
  const totals: TokenCounts = { input: 0, output: 0, reasoning: 0 };
  for (const r of results) {
    const t = getResultTokens(r);
    totals.input += t.input;
    totals.output += t.output;
    totals.reasoning += t.reasoning;
  }
  return totals;
}

/** Aggregate total cost across multiple results. */
export function aggregateGroupCost(results: EvalResultData[]): number {
  return results.reduce((sum, r) => sum + r.totalCost, 0);
}
