import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { createServer } from './server/index.js';
import { handleWsMessage } from './server/ws/protocol.js';
import { createEvalLoader } from './eval-loader.js';
import type { EvalLoaderConfig } from './eval-loader.js';
import type { AxlRuntime } from '@axlsdk/axl';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';

export type { EvalLoaderConfig } from './eval-loader.js';

export type StudioMiddlewareOptions = {
  /** The AxlRuntime instance to observe and control. */
  runtime: AxlRuntime;

  /**
   * URL path prefix where Studio is mounted.
   * Must match the mount path in your framework (Express `app.use()`,
   * Fastify `register()`, Hono `app.route()`, etc.). The framework is
   * expected to strip the prefix from `req.url` before calling the handler.
   *
   * Do not set basePath when using a raw `http.Server` as the root handler —
   * leave it empty and mount at root instead.
   *
   * Must start with '/' when non-empty. Trailing slashes are stripped.
   * Only URL-safe characters allowed: [a-zA-Z0-9/_-]
   *
   * @example '/studio'
   * @example '/admin/studio'
   * @example ''  — mounted at root (default)
   */
  basePath?: string;

  /**
   * Serve the pre-built Studio SPA.
   * Set to false if serving the client from a CDN or separate build.
   * @default true
   */
  serveClient?: boolean;

  /**
   * Verify a WebSocket upgrade request before completing the handshake.
   * Return true to allow, false to reject. Throw to reject with an error.
   *
   * IMPORTANT: WebSocket upgrades bypass Express/Fastify/Koa middleware.
   * If your HTTP routes are behind auth middleware, WS connections are NOT
   * automatically protected. Use this callback to enforce authentication
   * on WebSocket connections.
   */
  verifyUpgrade?: (req: IncomingMessage) => boolean | Promise<boolean>;

  /**
   * Disable all mutating endpoints (execute, test, send, delete, resolve).
   * When true, Studio is observation-only.
   * @default false
   */
  readOnly?: boolean;

  /**
   * Lazy-load eval files for the Eval Runner panel.
   *
   * Eval files are dynamically imported on first access to eval endpoints,
   * not at middleware construction time. This means:
   * - Zero cost during normal API operation
   * - Eval files can import from any module without creating circular deps
   *   in the static module graph (they're loaded as standalone entry points)
   * - `@axlsdk/eval` can remain a devDependency — eval files never enter
   *   the production bundle since bundlers can't see dynamic imports
   *
   * Accepts glob patterns, explicit file paths, or an object with
   * `conditions` for monorepo source export resolution.
   *
   * Eval files are loaded once and cached for the middleware's lifetime.
   * Changes to eval files require a server restart.
   *
   * @example
   * // Single glob pattern
   * evals: 'evals/*.eval.ts'
   *
   * @example
   * // Multiple patterns
   * evals: ['libs/api/evals/*.eval.ts', 'libs/ai/evals/*.eval.ts']
   *
   * @example
   * // With import conditions for monorepo source exports
   * evals: {
   *   files: 'libs/api/evals/*.eval.ts',
   *   conditions: ['development'],
   * }
   */
  evals?: EvalLoaderConfig;
};

/**
 * Minimal contract a WebSocket connection must satisfy.
 * Matches the `ws` library API (de facto standard in Node.js).
 */
export interface StudioWebSocket {
  send(data: string): void;
  close(): void;
  on(event: 'message', fn: (data: string | Buffer) => void): void;
  on(event: 'close', fn: () => void): void;
  on(event: 'error', fn: (err: Error) => void): void;
}

// Re-export for Hono-in-Hono consumers
export { handleWsMessage } from './server/ws/protocol.js';

export type StudioMiddleware = ReturnType<typeof createStudioMiddleware>;

export function createStudioMiddleware(options: StudioMiddlewareOptions) {
  const { runtime, serveClient = true, verifyUpgrade, readOnly = false } = options;

  // Normalize basePath: strip trailing slashes, validate format
  const basePath = normalizeBasePath(options.basePath);

  // Resolve pre-built SPA assets from this package's dist/
  const staticRoot = serveClient ? resolveClientDist() : undefined;

  if (serveClient && !staticRoot) {
    const dir =
      import.meta.dirname ??
      (typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url)));
    console.warn(
      '[axl-studio] serveClient is true but no pre-built client found at ' +
        `${resolve(dir, 'client')}. Studio UI will not be available. ` +
        'Set serveClient: false to suppress this warning.',
    );
  }

  // Create lazy eval loader if eval files are configured
  const evalLoader = options.evals ? createEvalLoader(options.evals, runtime) : undefined;

  const { app, connMgr, traceListener } = createServer({
    runtime,
    staticRoot,
    basePath,
    readOnly,
    cors: false, // Host framework owns CORS policy
    evalLoader,
  });

  // Log production safety warning
  if (process.env.NODE_ENV === 'production' && !verifyUpgrade) {
    console.warn(
      '[axl-studio] WARNING: Studio middleware mounted in production without verifyUpgrade. ' +
        'WebSocket connections are not authenticated. All registered workflows, tools, and ' +
        'agents are accessible. See https://axlsdk.com/docs/studio/security',
    );
  }

  // Convert Hono app → Node.js (req, res) handler via @hono/node-server.
  // overrideGlobalObjects: false prevents replacing global.Request/Response,
  // which could break the host application.
  const listener = getRequestListener(app.fetch, {
    overrideGlobalObjects: false,
  });

  let closed = false;

  function handler(req: IncomingMessage, res: ServerResponse) {
    if (closed) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: 'CLOSED', message: 'Studio middleware has been shut down' },
        }),
      );
      return;
    }

    // Express/NestJS/Koa body parsers consume the raw IncomingMessage stream
    // and store the parsed result on req.body. When that happens,
    // @hono/node-server's getRequestListener reads an empty stream and Hono
    // sees no body. To fix this, we re-serialize req.body as req.rawBody —
    // a Buffer that getRequestListener checks before falling back to the
    // stream (see newRequestFromIncoming in @hono/node-server/dist/listener.js).
    //
    // Verified against @hono/node-server@1.19.9. If this breaks after an
    // upgrade, check whether the rawBody instanceof Buffer check still exists
    // in newRequestFromIncoming.
    const reqAny = req as unknown as Record<string, unknown>;
    if (reqAny.body != null && !reqAny.rawBody) {
      try {
        reqAny.rawBody = Buffer.from(JSON.stringify(reqAny.body));
      } catch {
        // Non-serializable body — Hono will see an empty body
      }
    }

    listener(req, res).catch((err) => {
      console.error('[axl-studio] Unhandled error in request handler:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
          }),
        );
      }
    });
  }

  // Handle an individual WebSocket using the Studio protocol.
  // Adapts any StudioWebSocket to ConnectionManager's internal BroadcastTarget.
  function handleWebSocket(ws: StudioWebSocket) {
    if (closed) {
      ws.close();
      return;
    }
    const socket = {
      send: (data: string) => ws.send(data),
      close: () => ws.close(),
    };
    connMgr.add(socket);

    ws.on('message', (raw) => {
      const reply = handleWsMessage(String(raw), socket, connMgr);
      if (reply) ws.send(reply);
    });

    ws.on('close', () => connMgr.remove(socket));
    ws.on('error', () => connMgr.remove(socket));
  }

  // Internal WebSocketServer — created lazily by upgradeWebSocket()
  let wss: InstanceType<typeof WebSocketServer> | undefined;
  // References for cleanup: the upgrade handler and server it's attached to
  let upgradeHandler: ((...args: any[]) => void) | undefined;
  let serverRef: Server | undefined;

  // Convenience: attach WS handling to an http.Server.
  function upgradeWebSocket(server: Server, path?: string) {
    if (wss) {
      throw new Error(
        '[axl-studio] upgradeWebSocket() has already been called. ' +
          'Call close() first if you need to re-attach.',
      );
    }

    const wsPath = path ?? (basePath ? `${basePath}/ws` : '/ws');

    wss = new WebSocketServer({ noServer: true });
    serverRef = server;

    upgradeHandler = async (req: IncomingMessage, socket: any, head: Buffer) => {
      // Match path, ignoring query string
      const pathname = new URL(req.url!, `http://${req.headers.host}`).pathname;
      if (pathname !== wsPath) return; // Let other upgrade handlers run

      // Apply auth verification
      if (verifyUpgrade) {
        try {
          const allowed = await verifyUpgrade(req);
          if (!allowed) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
        } catch {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      // Guard against close() being called during async verifyUpgrade
      if (!wss) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        handleWebSocket(ws);
      });
    };

    server.on('upgrade', upgradeHandler);
  }

  // Cleanup function for lifecycle management.
  function close() {
    closed = true;

    // Close all WebSocket connections
    connMgr.closeAll();

    // Remove the upgrade listener from the server before closing WSS
    if (upgradeHandler && serverRef) {
      serverRef.removeListener('upgrade', upgradeHandler);
      upgradeHandler = undefined;
      serverRef = undefined;
    }

    // Shut down the internal WebSocketServer if one was created
    if (wss) {
      wss.close();
      wss = undefined;
    }

    // Remove only our trace event listener from the runtime
    if (traceListener) {
      runtime.removeListener('trace', traceListener);
    }
  }

  return {
    handler,
    handleWebSocket,
    upgradeWebSocket,
    app,
    connectionManager: connMgr,
    close,
  };
}

/**
 * Normalize and validate basePath.
 * - Empty string and undefined → ''
 * - Strip trailing slashes
 * - Validate leading slash when non-empty
 * - Reject unsafe characters
 */
function normalizeBasePath(raw?: string): string {
  if (!raw) return '';

  // Strip trailing slashes
  const normalized = raw.replace(/\/+$/, '');
  if (!normalized) return '';

  // Must start with /
  if (!normalized.startsWith('/')) {
    throw new Error(`basePath must start with '/' (got '${raw}'). Example: '/studio'`);
  }

  // Reject path traversal, consecutive slashes, and unsafe characters
  if (normalized.includes('..')) {
    throw new Error(`basePath must not contain '..' segments (got '${raw}')`);
  }
  if (normalized.includes('//')) {
    throw new Error(`basePath must not contain consecutive slashes (got '${raw}')`);
  }
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(normalized)) {
    throw new Error(
      `basePath contains invalid characters (got '${raw}'). ` +
        'Only alphanumeric characters, /, _, and - are allowed.',
    );
  }

  return normalized;
}

function resolveClientDist(): string | undefined {
  // Resolve the directory of this file (dist/ in published package).
  const dir =
    import.meta.dirname ??
    (typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url)));
  const candidate = resolve(dir, 'client');
  return existsSync(resolve(candidate, 'index.html')) ? candidate : undefined;
}
