import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AxlRuntime } from '@axlsdk/axl';
import type { StudioEnv } from './types.js';
import { errorHandler } from './middleware/error-handler.js';
import { ConnectionManager } from './ws/connection-manager.js';
import { createWsHandlers } from './ws/handler.js';
import { CostAggregator } from './cost-aggregator.js';
import healthRoutes from './routes/health.js';
import { createWorkflowRoutes } from './routes/workflows.js';
import executionRoutes from './routes/executions.js';
import { createSessionRoutes } from './routes/sessions.js';
import agentRoutes from './routes/agents.js';
import toolRoutes from './routes/tools.js';
import memoryRoutes from './routes/memory.js';
import decisionRoutes from './routes/decisions.js';
import { createCostRoutes } from './routes/costs.js';
import evalRoutes from './routes/evals.js';
import { createPlaygroundRoutes } from './routes/playground.js';

export type { StudioEnv } from './types.js';
export { ConnectionManager } from './ws/connection-manager.js';
export { CostAggregator } from './cost-aggregator.js';

export type CreateServerOptions = {
  runtime: AxlRuntime;
  /** Root path for serving pre-built SPA static assets. */
  staticRoot?: string;
};

export function createServer(options: CreateServerOptions) {
  const { runtime, staticRoot } = options;
  const app = new Hono<StudioEnv>();
  const connMgr = new ConnectionManager();
  const costAggregator = new CostAggregator(connMgr);

  // ── Middleware ──────────────────────────────────────────────────────
  app.use('*', cors());
  app.use('*', errorHandler);
  app.use('*', async (c, next) => {
    c.set('runtime', runtime);
    await next();
  });

  // ── API Routes ─────────────────────────────────────────────────────
  const api = new Hono<StudioEnv>();
  api.route('/', healthRoutes);
  api.route('/', createWorkflowRoutes(connMgr));
  api.route('/', executionRoutes);
  api.route('/', createSessionRoutes(connMgr));
  api.route('/', agentRoutes);
  api.route('/', toolRoutes);
  api.route('/', memoryRoutes);
  api.route('/', decisionRoutes);
  api.route('/', createCostRoutes(costAggregator));
  api.route('/', evalRoutes);
  api.route('/', createPlaygroundRoutes(connMgr));

  app.route('/api', api);

  // ── Trace event bridging ───────────────────────────────────────────
  runtime.on('trace', (event: unknown) => {
    const traceEvent = event as {
      executionId?: string;
      type?: string;
      agent?: string;
      model?: string;
      workflow?: string;
      cost?: number;
      tokens?: { input?: number; output?: number; reasoning?: number };
    };

    // Broadcast to trace channels
    if (traceEvent.executionId) {
      connMgr.broadcastWithWildcard(`trace:${traceEvent.executionId}`, traceEvent);
    }

    // Feed cost aggregator
    costAggregator.onTrace(traceEvent);

    // Broadcast pending decisions
    if (traceEvent.type === 'await_human') {
      connMgr.broadcast('decisions', traceEvent);
    }
  });

  // ── Static SPA serving (production) ────────────────────────────────
  if (staticRoot) {
    app.use('/*', serveStatic({ root: staticRoot }));
    // SPA fallback: serve index.html for non-API, non-WS routes
    app.get('*', serveStatic({ root: staticRoot, path: '/index.html' }));
  }

  return { app, connMgr, costAggregator, createWsHandlers: () => createWsHandlers(connMgr) };
}
