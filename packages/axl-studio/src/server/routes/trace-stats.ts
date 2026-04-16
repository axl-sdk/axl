import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import type { TraceAggregator } from '../aggregates/trace-aggregator.js';
import type { TraceStatsData } from '../aggregates/reducers.js';
import type { WindowId } from '../aggregates/aggregate-snapshots.js';

const VALID_WINDOWS = new Set<string>(['24h', '7d', '30d', 'all']);

export function createTraceStatsRoutes(aggregator: TraceAggregator<TraceStatsData>) {
  const app = new Hono<StudioEnv>();

  app.get('/trace-stats', (c) => {
    const windowParam = c.req.query('window');
    const window: WindowId =
      windowParam && VALID_WINDOWS.has(windowParam) ? (windowParam as WindowId) : '7d';
    return c.json({ ok: true, data: aggregator.getSnapshot(window) });
  });

  return app;
}
