import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AxlRuntime, AxlEvent } from '@axlsdk/axl';
import { redactStreamEvent } from './redact.js';
import type { StudioEnv } from './types.js';
import { errorHandler } from './middleware/error-handler.js';
import { ConnectionManager } from './ws/connection-manager.js';
import { createWsHandlers } from './ws/handler.js';
import { TraceAggregator } from './aggregates/trace-aggregator.js';
import { ExecutionAggregator } from './aggregates/execution-aggregator.js';
import { EvalAggregator } from './aggregates/eval-aggregator.js';
import {
  reduceCost,
  emptyCostData,
  reduceWorkflowStats,
  emptyWorkflowStatsData,
  enrichWorkflowStats,
  reduceTraceStats,
  emptyTraceStatsData,
  reduceEvalTrends,
  emptyEvalTrendData,
} from './aggregates/reducers.js';
import type { WindowId } from './aggregates/aggregate-snapshots.js';
import { createHealthRoutes } from './routes/health.js';
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
import { createEvalTrendsRoutes } from './routes/eval-trends.js';
import { createWorkflowStatsRoutes } from './routes/workflow-stats.js';
import { createTraceStatsRoutes } from './routes/trace-stats.js';

export type { StudioEnv } from './types.js';
export { ConnectionManager } from './ws/connection-manager.js';
export type { BroadcastTarget } from './ws/connection-manager.js';
export { TraceAggregator } from './aggregates/trace-aggregator.js';
export { ExecutionAggregator } from './aggregates/execution-aggregator.js';
export { EvalAggregator } from './aggregates/eval-aggregator.js';
export type { WindowId, AggregateBroadcast } from './aggregates/aggregate-snapshots.js';

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
  const windows: WindowId[] = ['24h', '7d', '30d', 'all'];

  const costAggregator = new TraceAggregator({
    runtime,
    connMgr,
    channel: 'costs',
    reducer: reduceCost,
    emptyState: emptyCostData,
    windows,
  });

  const workflowStatsAggregator = new ExecutionAggregator({
    runtime,
    connMgr,
    channel: 'workflow-stats',
    reducer: reduceWorkflowStats,
    emptyState: emptyWorkflowStatsData,
    windows,
    broadcastTransform: enrichWorkflowStats,
  });

  const traceStatsAggregator = new TraceAggregator({
    runtime,
    connMgr,
    channel: 'trace-stats',
    reducer: reduceTraceStats,
    emptyState: emptyTraceStatsData,
    windows,
  });

  const evalTrendsAggregator = new EvalAggregator({
    runtime,
    connMgr,
    channel: 'eval-trends',
    reducer: reduceEvalTrends,
    emptyState: emptyEvalTrendData,
    windows,
  });

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
    // Patterns must be precise: POST /api/evals/compare is pure computation
    // and must remain allowed, but POST /api/evals/:name/run mutates history.
    const blocked: RegExp[] = [
      /^POST \/api\/workflows(\/|$)/,
      /^POST \/api\/executions(\/|$)/,
      /^POST \/api\/sessions(\/|$)/,
      /^DELETE \/api\/sessions(\/|$)/,
      /^PUT \/api\/memory(\/|$)/,
      /^DELETE \/api\/memory(\/|$)/,
      /^POST \/api\/decisions(\/|$)/,
      /^POST \/api\/tools(\/|$)/,
      /^POST \/api\/evals\/import$/,
      /^POST \/api\/evals\/[^/]+\/run$/,
      /^POST \/api\/evals\/[^/]+\/rescore$/,
      /^POST \/api\/evals\/runs\/[^/]+\/cancel$/,
      /^DELETE \/api\/evals\/history\/[^/]+$/,
      /^POST \/api\/playground(\/|$)/,
    ];
    app.use('/api/*', async (c, next) => {
      // c.req.path returns the full path including any parent route prefix
      // (e.g., /studio/api/workflows when mounted via app.route('/studio', ...)).
      // Extract just the /api/... portion for matching.
      const apiIdx = c.req.path.indexOf('/api/');
      const apiPath = apiIdx >= 0 ? c.req.path.slice(apiIdx) : c.req.path;
      const key = `${c.req.method} ${apiPath}`;
      if (blocked.some((re) => re.test(key))) {
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
  api.route('/', createHealthRoutes(readOnly));
  api.route('/', createWorkflowRoutes(connMgr));
  api.route('/', executionRoutes);
  api.route('/', createSessionRoutes(connMgr));
  api.route('/', agentRoutes);
  api.route('/', toolRoutes);
  api.route('/', memoryRoutes);
  api.route('/', decisionRoutes);
  api.route('/', createCostRoutes(costAggregator));
  api.route('/', createEvalTrendsRoutes(evalTrendsAggregator));
  api.route('/', createWorkflowStatsRoutes(workflowStatsAggregator));
  api.route('/', createTraceStatsRoutes(traceStatsAggregator));
  const { app: evalApp, closeActiveRuns } = createEvalRoutes(connMgr, options.evalLoader);
  api.route('/', evalApp);
  api.route('/', createPlaygroundRoutes(connMgr));

  app.route('/api', api);

  // ── Trace event bridging ───────────────────────────────────────────
  // Aggregators subscribe to runtime events directly via their start() method.
  // This listener handles trace channel broadcasting and decision events only.
  // `isRedactEnabled()` is read per-event so a runtime that flips the flag
  // at runtime (not the common path, but possible) reflects immediately.
  const traceListener = (event: unknown) => {
    // Wrap the whole body in try/catch so a throw in `redactStreamEvent`
    // (malformed event shape) or `broadcastWithWildcard` (serialization
    // error) doesn't propagate back through `EventEmitter.emit('trace')`
    // and starve downstream listeners. Fail-loud to console.error so ops
    // sees it in logs but the runtime keeps going.
    try {
      const traceEvent = event as AxlEvent;

      // Broadcast to trace channels — apply the same scrubbing as the
      // playground/workflow execution paths so the trace firehose doesn't
      // leak content the per-route broadcasts are scrubbing.
      if (traceEvent.executionId) {
        connMgr.broadcastWithWildcard(
          `trace:${traceEvent.executionId}`,
          redactStreamEvent(traceEvent, runtime.isRedactEnabled()),
        );
      }

      // Broadcast pending decisions
      if (
        traceEvent.type === 'log' &&
        (traceEvent.data as { event?: string })?.event === 'await_human'
      ) {
        connMgr.broadcast('decisions', traceEvent);
      }
    } catch (err) {
      console.error(
        '[axl-studio] trace listener threw; event dropped:',
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  runtime.on('trace', traceListener);

  // ── Start aggregators (rebuild from history + subscribe to live events) ──
  const aggregatorStartPromise = Promise.all([
    costAggregator.start(),
    workflowStatsAggregator.start(),
    traceStatsAggregator.start(),
    evalTrendsAggregator.start(),
  ]).catch((err) => console.error('[axl-studio] aggregator start failed:', err));

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
      // Skip index.html (handled by SPA fallback) and /ws (handled by WebSocket upgrader)
      if (resolved === '/' || resolved === '/index.html' || resolved === '/ws') {
        return next();
      }
      return staticHandler(c, next);
    });

    // SPA fallback: serve the (possibly injected) index.html for all
    // non-API, non-static-asset routes so React Router handles routing.
    // Skip /ws so the WebSocket upgrader (registered after createServer) can handle it.
    if (spaHtml) {
      app.get('*', async (c, next) => {
        const resolved =
          basePath && c.req.path.startsWith(basePath)
            ? c.req.path.slice(basePath.length) || '/'
            : c.req.path;
        if (resolved === '/ws') return next();
        return c.html(spaHtml!);
      });
    }
  }

  return {
    app,
    connMgr,
    costAggregator,
    workflowStatsAggregator,
    traceStatsAggregator,
    evalTrendsAggregator,
    aggregatorStartPromise,
    /** Create WS handlers. Call before registering static/SPA routes are reached. */
    createWsHandlers: () => createWsHandlers(connMgr),
    traceListener,
    /** Abort all active streaming eval runs. */
    closeActiveRuns,
    /** Close all aggregators (clear intervals and unsubscribe listeners). */
    closeAggregators: () => {
      costAggregator.close();
      workflowStatsAggregator.close();
      traceStatsAggregator.close();
      evalTrendsAggregator.close();
    },
  };
}
