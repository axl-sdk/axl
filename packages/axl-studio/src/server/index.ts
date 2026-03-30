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
import { createEvalRoutes } from './routes/evals.js';
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
  /** Lazy eval file loader. Called before eval routes access the runtime's registered evals. */
  evalLoader?: () => Promise<void>;
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
      // c.req.path returns the full path including any parent route prefix
      // (e.g., /studio/api/workflows when mounted via app.route('/studio', ...)).
      // Extract just the /api/... portion for matching.
      const apiIdx = c.req.path.indexOf('/api/');
      const apiPath = apiIdx >= 0 ? c.req.path.slice(apiIdx) : c.req.path;
      const key = `${c.req.method} ${apiPath}`;
      if (blocked.some((b) => key.startsWith(b))) {
        return c.json(
          {
            ok: false,
            error: { code: 'READ_ONLY', message: 'Studio is mounted in read-only mode' },
          },
          405,
        );
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
  api.route('/', createEvalRoutes(options.evalLoader));
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
    // Read index.html once at startup. When basePath is set, inject the <base>
    // tag and runtime config so asset paths and client-side routing work
    // regardless of whether the mount URL has a trailing slash.
    const indexPath = resolve(staticRoot, 'index.html');
    let spaHtml: string | undefined;

    if (!existsSync(indexPath)) {
      console.warn(`[axl-studio] index.html not found at ${indexPath}`);
    } else {
      const rawHtml = readFileSync(indexPath, 'utf-8');

      if (basePath) {
        // Escape '<' to prevent </script> in basePath from breaking out of
        // the script tag. JSON.stringify alone is insufficient because the
        // HTML parser processes </script> before JavaScript runs.
        const safeBasePath = JSON.stringify(basePath).replace(/</g, '\\u003c');
        const injected = rawHtml.replace(
          '<head>',
          `<head>\n<base href="${basePath}/">\n` +
            `<script>window.__AXL_STUDIO_BASE__=${safeBasePath}</script>`,
        );

        if (injected === rawHtml) {
          console.warn(
            '[axl-studio] Could not inject basePath into index.html — ' +
              '<head> tag not found. The SPA may not route correctly.',
          );
        }
        spaHtml = injected;
      } else {
        spaHtml = rawHtml;
      }
    }

    // Serve static assets (JS, CSS, images). index.html is excluded so the
    // SPA fallback below always serves the version with basePath injection.
    // Without this guard, serveStatic would serve the raw index.html for root
    // requests (/ or /index.html), missing <base> and __AXL_STUDIO_BASE__.
    const staticHandler = serveStatic({
      root: staticRoot,
      rewriteRequestPath: basePath
        ? (path) => (path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path)
        : undefined,
    });

    app.use('/*', async (c, next) => {
      const reqPath = c.req.path;
      const resolved =
        basePath && reqPath.startsWith(basePath) ? reqPath.slice(basePath.length) || '/' : reqPath;
      if (resolved === '/' || resolved === '/index.html') {
        return next();
      }
      return staticHandler(c, next);
    });

    // SPA fallback: serve the (possibly injected) index.html for all
    // non-API, non-static-asset routes so React Router handles routing.
    if (spaHtml) {
      app.get('*', (c) => c.html(spaHtml!));
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
