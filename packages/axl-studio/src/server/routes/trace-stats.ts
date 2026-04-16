import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import type { TraceAggregator } from '../aggregates/trace-aggregator.js';
import type { TraceStatsData } from '../aggregates/reducers.js';
import { parseWindowParam } from '../aggregates/aggregate-snapshots.js';

export function createTraceStatsRoutes(aggregator: TraceAggregator<TraceStatsData>) {
  const app = new Hono<StudioEnv>();

  app.get('/trace-stats', (c) => {
    const window = parseWindowParam(c.req.query('window'));
    return c.json({ ok: true, data: aggregator.getSnapshot(window) });
  });

  return app;
}
