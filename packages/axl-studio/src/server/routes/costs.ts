import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import type { TraceAggregator } from '../aggregates/trace-aggregator.js';
import type { CostData } from '../types.js';
import { parseWindowParam } from '../aggregates/aggregate-snapshots.js';

export function createCostRoutes(costAggregator: TraceAggregator<CostData>) {
  const app = new Hono<StudioEnv>();

  app.get('/costs', (c) => {
    // Multi-window debug mode
    if (c.req.query('windows') === 'all') {
      return c.json({ ok: true, data: costAggregator.getAllSnapshots() });
    }

    const window = parseWindowParam(c.req.query('window'));
    return c.json({ ok: true, data: costAggregator.getSnapshot(window) });
  });

  return app;
}
