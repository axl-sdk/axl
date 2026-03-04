import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import type { CostAggregator } from '../cost-aggregator.js';

export function createCostRoutes(costAggregator: CostAggregator) {
  const app = new Hono<StudioEnv>();

  app.get('/costs', (c) => {
    return c.json({ ok: true, data: costAggregator.getData() });
  });

  app.post('/costs/reset', (c) => {
    costAggregator.reset();
    return c.json({ ok: true, data: { reset: true } });
  });

  return app;
}
