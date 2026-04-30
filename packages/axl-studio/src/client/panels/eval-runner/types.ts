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
  /** Per-item trace events (populated when runEval was called with `captureTraces: true`). */
  traces?: unknown[];
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
  /**
   * Unique workflow names observed across all runs in the group, ordered by
   * first appearance. Mirrors the server's `MultiRunSummary.workflows`.
   * Most groups are homogeneous (one workflow); custom callbacks can produce
   * heterogeneous groups with multiple.
   */
  workflows?: string[];
  scorers: Record<string, { mean: number; std: number; min: number; max: number }>;
  timing?: { mean: number; std: number };
};

export type EvalResultData = {
  id: string;
  dataset: string;
  /**
   * Execution metadata. Workflow names live here as `metadata.workflows: string[]`
   * and `metadata.workflowCounts: Record<string, number>`. The legacy top-level
   * `workflow: string` field was removed in 0.14.x — readers that need a single
   * primary workflow call `getResultWorkflows(result)[0]`, which also handles
   * pre-0.14 imported CLI artifacts via a fallback.
   */
  metadata?: Record<string, unknown>;
  /**
   * Legacy top-level workflow field from pre-0.14 CLI artifacts. Optional and
   * readers should prefer `getResultWorkflows()` — this is only kept on the
   * client type so that old JSON files imported via "Import result..." still
   * deserialize without type errors.
   */
  workflow?: string;
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
    /**
     * Set when the multi-run batch did not complete the planned number of
     * runs (e.g. run 3 of 5 threw). The aggregate is honest — computed over
     * `allRuns.length` actual runs — but the partial flag tells the UI to
     * render a distinct badge so a partial batch can't visually impersonate
     * a complete one.
     */
    partial?: boolean;
    /** How many runs actually completed (= allRuns.length). */
    batchCompleted?: number;
    /** How many runs were planned. */
    batchAttempted?: number;
    /** Redacted message from the run that failed, if any. */
    batchFailure?: string;
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

/**
 * Sample-size context for one side of a comparison. Mirrors
 * `EvalComparisonPartial` from `@axlsdk/eval`. Set when the runs pooled
 * for this side reflect fewer runs than the original batch planned —
 * either because the batch failed mid-way, or the user picked a subset
 * from the comparison picker. Surfaced as a "(partial: 2 of 5 runs)"
 * caption so the user doesn't mistake a smaller-N candidate for an
 * apples-to-apples comparison.
 */
export type ComparisonPartial = {
  completed: number;
  attempted: number;
};

export type ComparisonResult = {
  /**
   * Baseline-side identifier and per-side metadata. `partial` is set when
   * the pooled run count is less than the original batch's planned count.
   * `runCount` is the number of runs actually used in mean / regression /
   * timing / cost computation — `evalCompare` truncates both sides to
   * `min(baseline.length, candidate.length)` so means and the paired
   * bootstrap CI use the same sample. Optional for backward compat with
   * pre-fix server responses; treat absence as "matches the pooled length."
   */
  baseline?: {
    id: string;
    metadata?: Record<string, unknown>;
    partial?: ComparisonPartial;
    runCount?: number;
  };
  candidate?: {
    id: string;
    metadata?: Record<string, unknown>;
    partial?: ComparisonPartial;
    runCount?: number;
  };
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

// ── Multi-run aggregate builders ──────────────────────────────────

/**
 * Build an `EvalResultData` enriched with `_multiRun` from a set of per-run
 * entries that share a `runGroupId`. Mirrors the server-side `aggregateRuns()`
 * logic exactly so a locally-rebuilt aggregate renders identically to one
 * built by the server.
 *
 * Used by:
 *   - The History tab's `onSelectGroup` callback (adopt a historical group)
 *   - The Run tab's done-event handler (adopt a freshly-completed run group)
 *
 * Returns `null` if `allRuns` is empty (nothing to aggregate).
 */
export function buildMultiRunResult(allRuns: EvalResultData[]): EvalResultData | null {
  if (allRuns.length === 0) return null;
  const first = allRuns[0];
  const scorerNames = Object.keys(first.summary?.scorers ?? {});
  const aggScorers: Record<string, { mean: number; std: number; min: number; max: number }> = {};
  for (const name of scorerNames) {
    const means = allRuns.map((r) => r.summary?.scorers?.[name]?.mean ?? 0);
    const mean = means.reduce((a, b) => a + b, 0) / means.length;
    const std =
      means.length > 1
        ? Math.sqrt(means.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (means.length - 1))
        : 0;
    aggScorers[name] = {
      mean: Math.round(mean * 1000) / 1000,
      std: Math.round(std * 1000) / 1000,
      min: Math.round(Math.min(...means) * 1000) / 1000,
      max: Math.round(Math.max(...means) * 1000) / 1000,
    };
  }
  // Union workflows across all runs, first-seen first. Heterogeneous groups
  // (custom callbacks mixing workflows) preserve insertion order.
  const seenWorkflows = new Set<string>();
  const aggWorkflows: string[] = [];
  for (const run of allRuns) {
    const list = run.metadata?.workflows;
    if (Array.isArray(list)) {
      for (const w of list) {
        if (typeof w === 'string' && !seenWorkflows.has(w)) {
          seenWorkflows.add(w);
          aggWorkflows.push(w);
        }
      }
    }
  }
  const aggregate: MultiRunAggregate = {
    runGroupId: (first.metadata?.runGroupId as string) ?? '',
    runCount: allRuns.length,
    workflows: aggWorkflows.length > 0 ? aggWorkflows : undefined,
    scorers: aggScorers,
  };
  // Derive partial-batch state from `metadata.batchAttempted` (stamped on
  // each persisted run by the server's run endpoint) when fewer runs are
  // present than were planned. Server-rendered freshly-completed groups
  // already include explicit `_multiRun.partial`; we recompute it here for
  // groups adopted from history (the persisted shape doesn't carry the
  // top-level `_multiRun.partial`, only the per-run `metadata.batchAttempted`).
  //
  // Walk every run for the first finite value rather than trusting
  // `first.metadata` — runs persisted before `batchAttempted` was stamped
  // (legacy data, manually-imported artifacts, or future code paths) may
  // appear at index 0 with no batch metadata while siblings carry it.
  // Mirrors how `batchFailure` is walked below.
  let batchAttempted: number | undefined;
  for (const run of allRuns) {
    const v = run.metadata?.batchAttempted;
    if (typeof v === 'number' && Number.isFinite(v)) {
      batchAttempted = v;
      break;
    }
  }
  const partial = batchAttempted !== undefined && allRuns.length < batchAttempted;
  // Persisted runs from a partial CLI/Studio batch may carry the failure
  // message on per-run metadata. Lift it onto the aggregate so the panel
  // banner can render "Stopped after: ..." for groups loaded from history.
  // Any run in the group will do — they all share the same failure
  // message in our partial-batch-preservation model.
  const batchFailure = partial
    ? allRuns
        .map((r) => r.metadata?.batchFailure)
        .find((m): m is string => typeof m === 'string' && m.length > 0)
    : undefined;
  return {
    ...first,
    _multiRun: {
      aggregate,
      allRuns,
      ...(partial && {
        partial: true,
        batchCompleted: allRuns.length,
        batchAttempted,
        ...(batchFailure ? { batchFailure } : {}),
      }),
    },
  };
}

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

/**
 * Extract workflow names from an EvalResultData's aggregate metadata.
 *
 * Resolution order (most authoritative first):
 *   1. `_multiRun.aggregate.workflows` — server-side union across every run
 *      in the group. This is the only source that's correct for heterogeneous
 *      multi-run groups; the spread `currentResult` in aggregate view only
 *      carries the *first* run's metadata.
 *   2. `metadata.workflows` — trace-derived, parallel to `metadata.models`.
 *   3. Legacy top-level `result.workflow` for pre-0.14 imported CLI artifacts.
 *
 * Returns `[]` when nothing is available.
 */
export function getResultWorkflows(result: EvalResultData): string[] {
  // Multi-run aggregate union wins — handles heterogeneous groups correctly.
  const fromAggregate = result._multiRun?.aggregate.workflows;
  if (Array.isArray(fromAggregate) && fromAggregate.length > 0) {
    const list = fromAggregate.filter((w): w is string => typeof w === 'string');
    if (list.length > 0) return list;
  }
  const fromMeta = result.metadata?.workflows;
  if (Array.isArray(fromMeta)) {
    const list = (fromMeta as unknown[]).filter((w): w is string => typeof w === 'string');
    if (list.length > 0) return list;
  }
  // Legacy fallback: single-string workflow field on the result.
  const legacy = (result as { workflow?: unknown }).workflow;
  if (typeof legacy === 'string' && legacy) return [legacy];
  return [];
}

/** Extract per-workflow call counts from result metadata. */
export function getResultWorkflowCounts(result: EvalResultData): Record<string, number> | null {
  const wc = result.metadata?.workflowCounts;
  if (!wc || typeof wc !== 'object') return null;
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(wc as Record<string, unknown>)) {
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
