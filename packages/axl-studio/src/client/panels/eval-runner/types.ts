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
  /** Items that produced a valid numeric score (the sample size `mean` covers).
   *  Optional — absent on pre-0.18.0 artifacts; fall back to recomputing from items. */
  scored?: number;
  /** Items whose scorer ran and failed (threw / out-of-range). A non-zero value
   *  means `mean` rests on a thinned sample. */
  failed?: number;
};

/**
 * One scorer whose failure rate tripped `EvalConfig.failOnScorerErrorRate`.
 * Client-side mirror of `@axlsdk/eval`'s `DegradedScorer` (the client mirrors
 * server types rather than importing them across the package boundary).
 * Surfaced on `EvalSummary.degraded`; the panel renders `DegradedScorersBanner`
 * so a thinned/untrustworthy mean can't masquerade as a clean run.
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
  /**
   * Client-only extension (absent on the server `DegradedScorer` shape): how
   * many runs in a multi-run group flagged this scorer as degraded. Populated
   * by `buildMultiRunResult` when it unions per-run degradation onto the
   * aggregate so the banner can say "(in N runs)". Absent on single-run
   * results, where it carries no suffix.
   */
  runsAffected?: number;
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
  scorers: Record<
    string,
    { mean: number; std: number; min: number; max: number; scored?: number; failed?: number }
  >;
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
    /**
     * Scorers whose failure rate exceeded tolerance. Populated by `runEval`
     * ONLY when `EvalConfig.failOnScorerErrorRate` was set and a scorer
     * tripped it. Surfaced as `DegradedScorersBanner` via `getResultDegraded`.
     */
    degraded?: DegradedScorer[];
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
  const aggScorers: MultiRunAggregate['scorers'] = {};
  for (const name of scorerNames) {
    // Mean-of-means must exclude runs where this scorer scored ZERO items: an
    // empty sample yields `computeStats([]).mean === 0`, which would drag the
    // aggregate toward 0 even though the summed `scored`/`failed` already report
    // the thinning. We can only tell a zero-sample run apart when `scored` is
    // present (≥0.18.0) — when it's absent (pre-0.18.0) we keep the run to
    // preserve the old behavior. If EVERY run scored nothing (subset empty),
    // fall back to all-runs means so we never divide by zero.
    const contributing = allRuns.filter((r) => {
      const sc = r.summary?.scorers?.[name]?.scored;
      return sc == null || sc > 0;
    });
    const meanSource = contributing.length > 0 ? contributing : allRuns;
    const means = meanSource.map((r) => r.summary?.scorers?.[name]?.mean ?? 0);
    const mean = means.reduce((a, b) => a + b, 0) / means.length;
    const std =
      means.length > 1
        ? Math.sqrt(means.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (means.length - 1))
        : 0;
    // Sum per-run sample sizes (parallel to the server's aggregateRuns) so the
    // multi-run view can surface the same thinned-sample signal. Summed over ALL
    // runs — these describe the whole group, including the thinned ones excluded
    // from the mean above. Read with `?? 0` — pre-0.18.0 runs predate these.
    const scored = allRuns.reduce((s, r) => s + (r.summary?.scorers?.[name]?.scored ?? 0), 0);
    const failed = allRuns.reduce((s, r) => s + (r.summary?.scorers?.[name]?.failed ?? 0), 0);
    aggScorers[name] = {
      mean: Math.round(mean * 1000) / 1000,
      std: Math.round(std * 1000) / 1000,
      min: Math.round(Math.min(...means) * 1000) / 1000,
      max: Math.round(Math.max(...means) * 1000) / 1000,
      scored,
      failed,
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
  // Union scorer degradation across ALL runs. `summary.degraded` is run-level:
  // the failure-rate gate (`EvalConfig.failOnScorerErrorRate`) can trip on run
  // 3 while run[0] is clean. Spreading `...first` would surface only run[0]'s
  // degradation, hiding the fact that the aggregate "Mean ± std" is the
  // contaminated number. We merge by scorer name, keeping the entry with the
  // higher `rate` (a scorer can degrade in several runs), and count how many
  // runs flagged it (`runsAffected`) so the banner can say "(in N runs)".
  const aggDegraded = unionDegraded(allRuns);
  return {
    ...first,
    summary: {
      ...first.summary,
      ...(aggDegraded.length > 0 ? { degraded: aggDegraded } : {}),
    },
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

/**
 * Union the per-run `summary.degraded` lists across a multi-run group into a
 * single list. Merges by scorer name, keeping the entry with the higher `rate`
 * (worst observed) and stamping `runsAffected` with the count of runs that
 * flagged that scorer. Returns `[]` when no run degraded. Defensive — reads
 * each run through `getResultDegraded` so malformed entries are dropped.
 */
function unionDegraded(allRuns: EvalResultData[]): DegradedScorer[] {
  const byScorer = new Map<string, DegradedScorer & { runsAffected: number }>();
  for (const run of allRuns) {
    for (const d of getResultDegraded(run)) {
      const existing = byScorer.get(d.scorer);
      if (!existing) {
        byScorer.set(d.scorer, { ...d, runsAffected: 1 });
      } else {
        // Keep the worst (higher rate); always bump the affected-run count.
        const worse = d.rate > existing.rate ? d : existing;
        byScorer.set(d.scorer, { ...worse, runsAffected: existing.runsAffected + 1 });
      }
    }
  }
  return [...byScorer.values()];
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

/**
 * The single client-side discriminator for one scorer's per-item outcomes.
 * Walks `items` once and classifies each by the same rule the server uses:
 *   - a non-null score is a surviving sample (collected into `scores`),
 *   - a `null` score WITH a recorded `scoreDetails.duration` ran-and-failed
 *     (counted into `failed`),
 *   - a `null` score WITHOUT a recorded duration was skipped by cancellation
 *     (counts as neither),
 *   - items with a top-level `error` are excluded entirely.
 *
 * Returns both the surviving `scores[]` (for the strip chart) and the `failed`
 * count so callers never re-implement the discriminator. `getScorerSampleCounts`
 * and `ScoreDistribution` both read through this.
 */
export function collectScorerScores(
  items: EvalItem[],
  name: string,
): { scores: number[]; failed: number } {
  const scores: number[] = [];
  let failed = 0;
  for (const i of items) {
    if (i.error) continue;
    const score = i.scores[name];
    if (score != null) scores.push(score);
    else if (i.scoreDetails?.[name]?.duration != null) failed++;
  }
  return { scores, failed };
}

/**
 * Resolve a scorer's `scored`/`failed` sample counts. Prefers the summary
 * fields (authoritative, set by the runner ≥0.18.0) and falls back to
 * recomputing from `items` for pre-0.18.0 artifacts — via the shared
 * `collectScorerScores` discriminator. `items` is omitted for multi-run
 * aggregates that carry no items, where the summed fields are authoritative.
 */
export function getScorerSampleCounts(
  stats: { scored?: number; failed?: number },
  name: string,
  items?: EvalItem[],
): { scored: number; failed: number } {
  if (stats.scored != null && stats.failed != null) {
    return { scored: stats.scored, failed: stats.failed };
  }
  if (items) {
    const { scores, failed } = collectScorerScores(items, name);
    return { scored: scores.length, failed };
  }
  return { scored: stats.scored ?? 0, failed: stats.failed ?? 0 };
}

/** Extract model URIs from an EvalResultData's aggregate metadata (sorted by usage, most-used first). */
export function getResultModels(result: EvalResultData): string[] {
  if (!Array.isArray(result.metadata?.models)) return [];
  return (result.metadata.models as unknown[]).filter((m): m is string => typeof m === 'string');
}

/**
 * Annotation key paths the dataset schema dropped (stripped before reaching
 * scorers). Surfaced by the eval runner into `metadata.droppedAnnotationKeys`.
 * Dataset-level, so it's identical across runs in a multi-run group — reading
 * the representative result's metadata is sufficient. Returns `[]` when none.
 */
export function getResultDroppedAnnotationKeys(result: EvalResultData): string[] {
  const dropped = result.metadata?.droppedAnnotationKeys;
  if (!Array.isArray(dropped)) return [];
  return (dropped as unknown[]).filter((k): k is string => typeof k === 'string');
}

/**
 * Scorer names run when the eval was invoked with `--scorers` to filter to a
 * subset (`metadata.scorerFiltered === true`). Surfaced by the eval CLI into
 * `metadata.scorersRun`. Run-level, so it's identical across runs in a
 * multi-run group — reading the representative result's metadata is sufficient,
 * mirroring `getResultDroppedAnnotationKeys`. Returns `[]` when the run was not
 * scorer-filtered (i.e. a full-coverage run) or when metadata is absent.
 */
export function getResultScorerFiltered(result: EvalResultData): string[] {
  if (result.metadata?.scorerFiltered !== true) return [];
  const run = result.metadata?.scorersRun;
  if (!Array.isArray(run)) return [];
  return (run as unknown[]).filter((s): s is string => typeof s === 'string');
}

/**
 * Scorers flagged as degraded — failure rate exceeded the configured
 * tolerance (`EvalConfig.failOnScorerErrorRate`; deterministic scorers tolerate
 * zero failures). Populated by `runEval` into `summary.degraded` only when the
 * user opted into the trust signal and a scorer tripped it. Run-level, so it's
 * identical across the representative run in a multi-run group — reading the
 * representative result's summary is sufficient, mirroring
 * `getResultScorerFiltered`. Returns `[]` when no scorer degraded or when the
 * field is absent. Defensively filters to well-formed entries.
 */
export function getResultDegraded(result: EvalResultData): DegradedScorer[] {
  const degraded = result.summary?.degraded;
  if (!Array.isArray(degraded)) return [];
  return (degraded as unknown[]).filter(
    (d): d is DegradedScorer =>
      d != null &&
      typeof d === 'object' &&
      typeof (d as DegradedScorer).scorer === 'string' &&
      typeof (d as DegradedScorer).rate === 'number' &&
      typeof (d as DegradedScorer).limit === 'number' &&
      ((d as DegradedScorer).type === 'llm' || (d as DegradedScorer).type === 'deterministic') &&
      typeof (d as DegradedScorer).scored === 'number' &&
      typeof (d as DegradedScorer).failed === 'number',
  );
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
