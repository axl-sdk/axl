import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import type { ExecutionAggregator } from '../aggregates/execution-aggregator.js';
import type { WorkflowStatsData } from '../aggregates/reducers.js';
import { enrichWorkflowStats } from '../aggregates/reducers.js';
import { parseWindowParam } from '../aggregates/aggregate-snapshots.js';

export function createWorkflowStatsRoutes(aggregator: ExecutionAggregator<WorkflowStatsData>) {
  const app = new Hono<StudioEnv>();

  app.get('/workflow-stats', (c) => {
    const window = parseWindowParam(c.req.query('window'));
    return c.json({ ok: true, data: enrichWorkflowStats(aggregator.getSnapshot(window)) });
  });

  return app;
}
