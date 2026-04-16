import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import type { EvalAggregator } from '../aggregates/eval-aggregator.js';
import type { EvalTrendData } from '../aggregates/reducers.js';
import { parseWindowParam } from '../aggregates/aggregate-snapshots.js';

export function createEvalTrendsRoutes(aggregator: EvalAggregator<EvalTrendData>) {
  const app = new Hono<StudioEnv>();

  app.get('/eval-trends', (c) => {
    const window = parseWindowParam(c.req.query('window'));
    return c.json({ ok: true, data: aggregator.getSnapshot(window) });
  });

  return app;
}
