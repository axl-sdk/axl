/**
 * Pure reducer functions for each aggregate panel.
 * Each reducer is a pure (state, source) => state function — no I/O, no mutation.
 */
import type { TraceEvent, ExecutionInfo, EvalHistoryEntry } from '@axlsdk/axl';
import type { CostData } from '../types.js';

// ── Cost reducer (TraceEvent → CostData) ──────────────────────────────

export function emptyCostData(): CostData {
  return {
    totalCost: 0,
    totalTokens: { input: 0, output: 0, reasoning: 0 },
    byAgent: {},
    byModel: {},
    byWorkflow: {},
  };
}

/**
 * Pure reducer extracted from CostAggregator.onTrace.
 * Every mutation becomes a fresh-object return.
 */
export function reduceCost(acc: CostData, event: TraceEvent): CostData {
  if (event.cost == null && !event.tokens) return acc;

  const cost = Number.isFinite(event.cost) ? event.cost! : 0;
  const tokens = event.tokens ?? {};

  const totalTokens = {
    input: acc.totalTokens.input + (tokens.input ?? 0),
    output: acc.totalTokens.output + (tokens.output ?? 0),
    reasoning: acc.totalTokens.reasoning + (tokens.reasoning ?? 0),
  };

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
        input: prev.tokens.input + (tokens.input ?? 0),
        output: prev.tokens.output + (tokens.output ?? 0),
      },
    };
  }

  const byWorkflow = { ...acc.byWorkflow };
  if (event.workflow) {
    const prev = byWorkflow[event.workflow] ?? { cost: 0, executions: 0 };
    byWorkflow[event.workflow] = {
      cost: prev.cost + cost,
      executions: prev.executions + (event.type === 'workflow_start' ? 1 : 0),
    };
  }

  return {
    totalCost: acc.totalCost + cost,
    totalTokens,
    byAgent,
    byModel,
    byWorkflow,
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

  byEval[entry.eval] = {
    runs,
    latestScores: scores,
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

export type WorkflowStatsData = {
  byWorkflow: Record<
    string,
    {
      total: number;
      completed: number;
      failed: number;
      durations: number[]; // kept for p50/p95 computation
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
    avgDuration: 0,
  };

  const durations = [...prev.durations, execution.duration];
  const total = prev.total + 1;
  const completed = prev.completed + (execution.status === 'completed' ? 1 : 0);
  const failed = prev.failed + (execution.status === 'failed' ? 1 : 0);
  const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;

  byWorkflow[execution.workflow] = {
    total,
    completed,
    failed,
    durations,
    avgDuration,
  };

  const totalExecutions = acc.totalExecutions + 1;
  const totalFailed = Object.values(byWorkflow).reduce((sum, w) => sum + w.failed, 0);
  const failureRate = totalExecutions > 0 ? totalFailed / totalExecutions : 0;

  return { byWorkflow, totalExecutions, failureRate };
}

/** Get p50/p95 from a WorkflowStatsData entry (computed on read). */
export function getWorkflowPercentiles(entry: WorkflowStatsData['byWorkflow'][string]): {
  durationP50: number;
  durationP95: number;
} {
  const sorted = [...entry.durations].sort((a, b) => a - b);
  return {
    durationP50: percentile(sorted, 50),
    durationP95: percentile(sorted, 95),
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
    byTool[event.tool] = {
      calls: prev.calls + (event.type === 'tool_call' ? 1 : 0),
      denied: prev.denied + (event.type === 'tool_denied' ? 1 : 0),
      approved:
        prev.approved +
        (event.type === 'tool_call' || (event.type as string) === 'tool_approval' ? 1 : 0),
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
