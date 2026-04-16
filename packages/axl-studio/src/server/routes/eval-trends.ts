import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import type { EvalAggregator } from '../aggregates/eval-aggregator.js';
import type { EvalTrendData } from '../aggregates/reducers.js';
import type { WindowId } from '../aggregates/aggregate-snapshots.js';

const VALID_WINDOWS = new Set<string>(['24h', '7d', '30d', 'all']);

export function createEvalTrendsRoutes(aggregator: EvalAggregator<EvalTrendData>) {
  const app = new Hono<StudioEnv>();

  app.get('/eval-trends', (c) => {
    const windowParam = c.req.query('window');
    const window: WindowId =
      windowParam && VALID_WINDOWS.has(windowParam) ? (windowParam as WindowId) : '7d';
    return c.json({ ok: true, data: aggregator.getSnapshot(window) });
  });

  return app;
}
