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

  // Migration stub for the removed `POST /api/costs/reset` endpoint.
  //
  // Pre-0.15 Studio exposed a mutating reset that cleared the in-memory cost
  // aggregator. In 0.15 the dashboard switched to time-window aggregates over
  // StateStore history, so "reset" is no longer meaningful — the displayed
  // window simply narrows. Scripts (CI dashboards, ops tooling) that still hit
  // this URL would otherwise get Hono's default 404 with no hint about the
  // migration path. Return a structured 410 Gone with a concrete pointer.
  app.post('/costs/reset', (c) => {
    return c.json(
      {
        ok: false,
        error: {
          code: 'GONE',
          message:
            'POST /api/costs/reset was removed in @axlsdk/studio 0.15. ' +
            'Cost aggregates are now time-windowed and rebuilt from StateStore history. ' +
            'Use GET /api/costs?window=24h|7d|30d|all to narrow the view instead of resetting.',
        },
      },
      410,
    );
  });

  return app;
}
