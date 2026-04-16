/**
 * Pure reducer functions for each aggregate panel.
 * Each reducer is a pure (state, source) => state function — no I/O, no mutation.
 */
import type { TraceEvent, ExecutionInfo, EvalHistoryEntry } from '@axlsdk/axl';
import type { CostData } from '../types.js';

// ── Shared helpers ────────────────────────────────────────────────────

/** Clamp a possibly-NaN/Infinity number to 0. */
const finite = (v: number | undefined): number => (Number.isFinite(v) ? v! : 0);

/** Detect log-form events from the production runtime (type: 'log' + data.event). */
export function isLogEvent(event: TraceEvent, eventName: string): boolean {
  if (event.type === eventName) return true;
  if (event.type === 'log' && event.data != null && typeof event.data === 'object') {
    return (event.data as { event?: unknown }).event === eventName;
  }
  return false;
}

// ── Cost reducer (TraceEvent → CostData) ──────────────────────────────

function emptyRetry(): CostData['retry'] {
  return {
    primary: 0,
    primaryCalls: 0,
    schema: 0,
    schemaCalls: 0,
    validate: 0,
    validateCalls: 0,
    guardrail: 0,
    guardrailCalls: 0,
    retryCalls: 0,
  };
}

export function emptyCostData(): CostData {
  return {
    totalCost: 0,
    totalTokens: { input: 0, output: 0, reasoning: 0 },
    byAgent: {},
    byModel: {},
    byWorkflow: {},
    retry: emptyRetry(),
    byEmbedder: {},
  };
}

/**
 * Pure reducer for CostData with full parity to CostAggregator.onTrace.
 * Handles retry decomposition, embedder cost bucketing, workflow_start
 * detection (both production log-form and test runtime shapes), and
 * NaN/Infinity guards on all numeric accumulations.
 */
export function reduceCost(acc: CostData, event: TraceEvent): CostData {
  const isWorkflowStart = isLogEvent(event, 'workflow_start');

  // Early return for events with no cost data. workflow_start events carry
  // no cost/tokens but need to increment the per-workflow executions counter.
  if (event.cost == null && !event.tokens) {
    if (isWorkflowStart && event.workflow) {
      const byWorkflow = { ...acc.byWorkflow };
      const prev = byWorkflow[event.workflow] ?? { cost: 0, executions: 0 };
      byWorkflow[event.workflow] = { ...prev, executions: prev.executions + 1 };
      return { ...acc, byWorkflow };
    }
    return acc;
  }

  const cost = finite(event.cost);
  const tokens = event.tokens ?? {};

  // Only count tokens from agent_call events — embedder tokens are
  // bucketed separately into byEmbedder.tokens.
  const totalTokens =
    event.type === 'agent_call'
      ? {
          input: acc.totalTokens.input + finite(tokens.input),
          output: acc.totalTokens.output + finite(tokens.output),
          reasoning: acc.totalTokens.reasoning + finite(tokens.reasoning),
        }
      : acc.totalTokens;

  const byAgent = { ...acc.byAgent };
  if (event.agent) {
    const prev = byAgent[event.agent] ?? { cost: 0, calls: 0 };
    byAgent[event.agent] = { cost: prev.cost + cost, calls: prev.calls + 1 };
  }

  const byModel = { ...acc.byModel };
  if (event.model) {
    const prev = byModel[event.model] ?? { cost: 0, calls: 0, tokens: { input: 0, output: 0 } };
    byModel[event.model] = {
      cost: prev.cost + cost,
      calls: prev.calls + 1,
      tokens: {
        input: prev.tokens.input + finite(tokens.input),
        output: prev.tokens.output + finite(tokens.output),
      },
    };
  }

  const byWorkflow = { ...acc.byWorkflow };
  if (event.workflow) {
    const prev = byWorkflow[event.workflow] ?? { cost: 0, executions: 0 };
    byWorkflow[event.workflow] = {
      cost: prev.cost + cost,
      executions: prev.executions + (isWorkflowStart ? 1 : 0),
    };
  }

  // Retry-cost decomposition: split agent_call cost by retryReason.
  let retry = acc.retry;
  if (event.type === 'agent_call') {
    const d = (event.data ?? {}) as { retryReason?: 'schema' | 'validate' | 'guardrail' };
    const reason = d.retryReason;
    retry = { ...acc.retry };
    if (reason === 'schema') {
      retry.schema += cost;
      retry.schemaCalls += 1;
      retry.retryCalls += 1;
    } else if (reason === 'validate') {
      retry.validate += cost;
      retry.validateCalls += 1;
      retry.retryCalls += 1;
    } else if (reason === 'guardrail') {
      retry.guardrail += cost;
      retry.guardrailCalls += 1;
      retry.retryCalls += 1;
    } else {
      retry.primary += cost;
      retry.primaryCalls += 1;
    }
  }

  // Embedder cost: memory_remember and memory_recall log events.
  let byEmbedder = acc.byEmbedder;
  if (event.type === 'log') {
    const d = (event.data ?? {}) as {
      event?: string;
      usage?: { model?: string; tokens?: number };
    };
    if (d.event === 'memory_remember' || d.event === 'memory_recall') {
      byEmbedder = { ...acc.byEmbedder };
      const modelKey = d.usage?.model ?? 'unknown';
      const embedTokens = typeof d.usage?.tokens === 'number' ? finite(d.usage.tokens) : 0;
      const prev = byEmbedder[modelKey] ?? { cost: 0, calls: 0, tokens: 0 };
      byEmbedder[modelKey] = {
        cost: prev.cost + cost,
        calls: prev.calls + 1,
        tokens: prev.tokens + embedTokens,
      };
    }
  }

  return {
    totalCost: acc.totalCost + cost,
    totalTokens,
    byAgent,
    byModel,
    byWorkflow,
    retry,
    byEmbedder,
  };
}

// ── Eval trends reducer (EvalHistoryEntry → EvalTrendData) ────────────

export type EvalTrendRun = {
  timestamp: number;
  id: string;
  scores: Record<string, number>;
  cost: number;
};

export type EvalTrendEntry = {
  runs: EvalTrendRun[];
  latestScores: Record<string, number>;
  scoreMean: Record<string, number>;
  scoreStd: Record<string, number>;
  costTotal: number;
  runCount: number;
};

export type EvalTrendData = {
  byEval: Record<string, EvalTrendEntry>;
  totalRuns: number;
  totalCost: number;
};

export function emptyEvalTrendData(): EvalTrendData {
  return { byEval: {}, totalRuns: 0, totalCost: 0 };
}

/** Extract scores from an EvalHistoryEntry's data blob. */
function extractScores(data: unknown): Record<string, number> {
  if (!data || typeof data !== 'object') return {};
  const result = data as Record<string, unknown>;
  // EvalResult.summary?.scores is the standard location
  const summary = result.summary as Record<string, unknown> | undefined;
  const scores = summary?.scores as Record<string, number> | undefined;
  return scores ?? {};
}

/** Extract cost from an EvalHistoryEntry's data blob. */
function extractCost(data: unknown): number {
  if (!data || typeof data !== 'object') return 0;
  const result = data as Record<string, unknown>;
  const summary = result.summary as Record<string, unknown> | undefined;
  return typeof summary?.totalCost === 'number' ? summary.totalCost : 0;
}

/** Compute mean and std for score arrays. */
function computeScoreStats(runs: EvalTrendRun[]): {
  mean: Record<string, number>;
  std: Record<string, number>;
} {
  const scorerNames = new Set<string>();
  for (const run of runs) {
    for (const name of Object.keys(run.scores)) scorerNames.add(name);
  }

  const mean: Record<string, number> = {};
  const std: Record<string, number> = {};
  for (const name of scorerNames) {
    const values = runs.map((r) => r.scores[name]).filter((v) => v != null);
    if (values.length === 0) continue;
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    mean[name] = m;
    const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
    std[name] = Math.sqrt(variance);
  }
  return { mean, std };
}

export function reduceEvalTrends(acc: EvalTrendData, entry: EvalHistoryEntry): EvalTrendData {
  const scores = extractScores(entry.data);
  const cost = extractCost(entry.data);
  const run: EvalTrendRun = {
    timestamp: entry.timestamp,
    id: entry.id,
    scores,
    cost,
  };

  const byEval = { ...acc.byEval };
  const prev = byEval[entry.eval];
  const runs = prev ? [...prev.runs, run] : [run];
  const { mean, std } = computeScoreStats(runs);

  // latestScores is the most recent run's scores by timestamp.
  // During rebuild, entries arrive newest-first, so only overwrite if
  // there's no existing entry or this run is newer.
  const latestScores =
    prev && prev.runs.length > 0 && prev.runs[prev.runs.length - 1].timestamp > run.timestamp
      ? prev.latestScores
      : scores;

  byEval[entry.eval] = {
    runs,
    latestScores,
    scoreMean: mean,
    scoreStd: std,
    costTotal: (prev?.costTotal ?? 0) + cost,
    runCount: runs.length,
  };

  return {
    byEval,
    totalRuns: acc.totalRuns + 1,
    totalCost: acc.totalCost + cost,
  };
}

// ── Workflow stats reducer (ExecutionInfo → WorkflowStatsData) ────────

/** Max recent durations to keep per workflow for percentile computation. */
const MAX_DURATIONS = 200;

export type WorkflowStatsData = {
  byWorkflow: Record<
    string,
    {
      total: number;
      completed: number;
      failed: number;
      /** Bounded sorted array of recent durations for p50/p95. Max MAX_DURATIONS entries. */
      durations: number[];
      durationSum: number;
      avgDuration: number;
    }
  >;
  totalExecutions: number;
  failureRate: number;
};

export function emptyWorkflowStatsData(): WorkflowStatsData {
  return { byWorkflow: {}, totalExecutions: 0, failureRate: 0 };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

export function reduceWorkflowStats(
  acc: WorkflowStatsData,
  execution: ExecutionInfo,
): WorkflowStatsData {
  const byWorkflow = { ...acc.byWorkflow };
  const prev = byWorkflow[execution.workflow] ?? {
    total: 0,
    completed: 0,
    failed: 0,
    durations: [],
    durationSum: 0,
    avgDuration: 0,
  };

  // Maintain a bounded sorted array for percentile computation.
  // Insert in sorted position, evict the smallest (front) if over cap.
  // This biases toward recent larger values — acceptable for dashboard use.
  const durations = [...prev.durations];
  const insertIdx = durations.findIndex((d) => d > execution.duration);
  if (insertIdx === -1) durations.push(execution.duration);
  else durations.splice(insertIdx, 0, execution.duration);
  if (durations.length > MAX_DURATIONS) durations.shift();

  const total = prev.total + 1;
  const completed = prev.completed + (execution.status === 'completed' ? 1 : 0);
  const failed = prev.failed + (execution.status === 'failed' ? 1 : 0);
  const durationSum = prev.durationSum + execution.duration;
  const avgDuration = durationSum / total;

  byWorkflow[execution.workflow] = {
    total,
    completed,
    failed,
    durations,
    durationSum,
    avgDuration,
  };

  const totalExecutions = acc.totalExecutions + 1;
  const totalFailed = Object.values(byWorkflow).reduce((sum, w) => sum + w.failed, 0);
  const failureRate = totalExecutions > 0 ? totalFailed / totalExecutions : 0;

  return { byWorkflow, totalExecutions, failureRate };
}

/** Get p50/p95 from a WorkflowStatsData entry. Durations are pre-sorted. */
export function getWorkflowPercentiles(entry: WorkflowStatsData['byWorkflow'][string]): {
  durationP50: number;
  durationP95: number;
} {
  // Durations are maintained in sorted order by the reducer
  return {
    durationP50: percentile(entry.durations, 50),
    durationP95: percentile(entry.durations, 95),
  };
}

// ── Trace stats reducer (TraceEvent → TraceStatsData) ────────────────

export type TraceStatsData = {
  eventTypeCounts: Record<string, number>;
  byTool: Record<string, { calls: number; denied: number; approved: number }>;
  retryByAgent: Record<string, { schema: number; validate: number; guardrail: number }>;
  totalEvents: number;
};

export function emptyTraceStatsData(): TraceStatsData {
  return {
    eventTypeCounts: {},
    byTool: {},
    retryByAgent: {},
    totalEvents: 0,
  };
}

export function reduceTraceStats(acc: TraceStatsData, event: TraceEvent): TraceStatsData {
  const eventTypeCounts = { ...acc.eventTypeCounts };
  eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;

  const byTool = { ...acc.byTool };
  if (event.tool) {
    const prev = byTool[event.tool] ?? { calls: 0, denied: 0, approved: 0 };
    // tool_approval events include both approved and denied outcomes.
    // Only count as 'approved' when data.approved === true.
    const isApproved =
      (event.type as string) === 'tool_approval' &&
      (event.data as { approved?: boolean } | undefined)?.approved === true;
    byTool[event.tool] = {
      calls: prev.calls + (event.type === 'tool_call' ? 1 : 0),
      denied: prev.denied + (event.type === 'tool_denied' ? 1 : 0),
      approved: prev.approved + (isApproved ? 1 : 0),
    };
  }

  const retryByAgent = { ...acc.retryByAgent };
  if (event.agent && event.type === 'agent_call') {
    const data = event.data as { retryReason?: string } | undefined;
    if (data?.retryReason) {
      const prev = retryByAgent[event.agent] ?? { schema: 0, validate: 0, guardrail: 0 };
      const reason = data.retryReason as 'schema' | 'validate' | 'guardrail';
      if (reason in prev) {
        retryByAgent[event.agent] = { ...prev, [reason]: prev[reason] + 1 };
      }
    }
  }

  return {
    eventTypeCounts,
    byTool,
    retryByAgent,
    totalEvents: acc.totalEvents + 1,
  };
}
