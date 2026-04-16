import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import type { ExecutionAggregator } from '../aggregates/execution-aggregator.js';
import type { WorkflowStatsData } from '../aggregates/reducers.js';
import { getWorkflowPercentiles } from '../aggregates/reducers.js';
import { parseWindowParam } from '../aggregates/aggregate-snapshots.js';

/** Enrich the raw WorkflowStatsData with computed percentiles for the API response.
 *  Strips the internal `durations` and `durationSum` arrays to keep the payload lean. */
function enrichWorkflowStats(data: WorkflowStatsData) {
  const byWorkflow: Record<
    string,
    {
      total: number;
      completed: number;
      failed: number;
      durationP50: number;
      durationP95: number;
      avgDuration: number;
    }
  > = {};
  for (const [name, entry] of Object.entries(data.byWorkflow)) {
    const { durationP50, durationP95 } = getWorkflowPercentiles(entry);
    byWorkflow[name] = {
      total: entry.total,
      completed: entry.completed,
      failed: entry.failed,
      durationP50,
      durationP95,
      avgDuration: entry.avgDuration,
    };
  }
  return {
    byWorkflow,
    totalExecutions: data.totalExecutions,
    failureRate: data.failureRate,
  };
}

export function createWorkflowStatsRoutes(aggregator: ExecutionAggregator<WorkflowStatsData>) {
  const app = new Hono<StudioEnv>();

  app.get('/workflow-stats', (c) => {
    const window = parseWindowParam(c.req.query('window'));
    return c.json({ ok: true, data: enrichWorkflowStats(aggregator.getSnapshot(window)) });
  });

  return app;
}
