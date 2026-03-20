import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
export type { BroadcastTarget } from './ws/connection-manager.js';
export { CostAggregator } from './cost-aggregator.js';

export type CreateServerOptions = {
  runtime: AxlRuntime;
  /** Root path for serving pre-built SPA static assets. */
  staticRoot?: string;
  /** Base URL path for client-side routing and API calls. Injected into index.html at serve time. */
  basePath?: string;
  /** When true, disable all mutating API endpoints. */
  readOnly?: boolean;
  /** Apply CORS headers. Default: true (standalone CLI). Set false for embedded middleware. */
  cors?: boolean;
};

export function createServer(options: CreateServerOptions) {
  const { runtime, staticRoot, basePath = '', readOnly = false } = options;
  const app = new Hono<StudioEnv>();
  const connMgr = new ConnectionManager();
  const costAggregator = new CostAggregator(connMgr);

  // ── Middleware ──────────────────────────────────────────────────────
  if (options.cors !== false) {
    app.use('*', cors());
  }
  app.use('*', errorHandler);
  app.use('*', async (c, next) => {
    c.set('runtime', runtime);
    await next();
  });

  // ── Read-only mode ──────────────────────────────────────────────────
  if (readOnly) {
    const blocked = [
      'POST /api/workflows',
      'POST /api/executions',
      'POST /api/sessions',
      'DELETE /api/sessions',
      'PUT /api/memory',
      'DELETE /api/memory',
      'POST /api/decisions',
      'POST /api/costs',
      'POST /api/tools',
      'POST /api/evals',
      'POST /api/playground',
    ];
    app.use('/api/*', async (c, next) => {
      const key = `${c.req.method} ${c.req.path}`;
      if (blocked.some((b) => key.startsWith(b))) {
        return c.json({ error: 'Studio is mounted in read-only mode' }, 405);
      }
      await next();
    });
  }

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
  const traceListener = (event: unknown) => {
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
  };
  runtime.on('trace', traceListener);

  // ── Static SPA serving (production) ────────────────────────────────
  if (staticRoot) {
    // Serve static assets (JS, CSS, images).
    // When basePath is set and this app is mounted via Hono's app.route(),
    // c.req.path may include the full prefix. rewriteRequestPath strips it
    // so serveStatic resolves files relative to staticRoot correctly.
    app.use(
      '/*',
      serveStatic({
        root: staticRoot,
        rewriteRequestPath: basePath
          ? (path) => (path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path)
          : undefined,
      }),
    );

    if (basePath) {
      // Read and inject base path into index.html at startup (not per-request).
      const indexPath = resolve(staticRoot, 'index.html');
      if (!existsSync(indexPath)) {
        console.warn(`[axl-studio] index.html not found at ${indexPath}`);
      } else {
        const indexHtml = readFileSync(indexPath, 'utf-8');

        // Escape all '<' as '\u003c' to prevent </script> in basePath from
        // breaking out of the script tag. JSON.stringify alone is insufficient
        // because the HTML parser processes </script> before JavaScript runs.
        const safeBasePath = JSON.stringify(basePath).replace(/</g, '\\u003c');

        // Inject both:
        // 1. <base> tag so relative asset paths (./assets/main.js) resolve
        //    correctly regardless of trailing slash on the mount URL.
        // 2. Runtime config script for React Router, API client, and WS client.
        const injectedHtml = indexHtml.replace(
          '</head>',
          `<base href="${basePath}/">\n` +
            `<script>window.__AXL_STUDIO_BASE__=${safeBasePath}</script>\n</head>`,
        );

        if (injectedHtml === indexHtml) {
          console.warn(
            '[axl-studio] Could not inject basePath into index.html — ' +
              '</head> tag not found. The SPA may not route correctly.',
          );
        }

        app.get('*', (c) => c.html(injectedHtml));
      }
    } else {
      // SPA fallback: serve index.html for non-API, non-WS routes
      app.get('*', serveStatic({ root: staticRoot, path: '/index.html' }));
    }
  }

  return {
    app,
    connMgr,
    costAggregator,
    createWsHandlers: () => createWsHandlers(connMgr),
    traceListener,
  };
}
