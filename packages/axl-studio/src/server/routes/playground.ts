import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import type { ConnectionManager } from '../ws/connection-manager.js';

export function createPlaygroundRoutes(connMgr: ConnectionManager) {
  const app = new Hono<StudioEnv>();

  // Chat with an agent via session
  app.post('/playground/chat', async (c) => {
    const runtime = c.get('runtime');
    const body = await c.req.json<{
      sessionId?: string;
      message: string;
      workflow?: string;
    }>();

    const workflowName = body.workflow ?? runtime.getWorkflowNames()[0];
    if (!workflowName) {
      return c.json(
        { ok: false, error: { code: 'NO_WORKFLOW', message: 'No workflows registered' } },
        400,
      );
    }
    const sessionId = body.sessionId ?? `playground-${Date.now()}`;
    const session = runtime.session(sessionId);

    // Stream the response
    const stream = await session.stream(workflowName, body.message);
    const executionId = `playground-${sessionId}-${Date.now()}`;

    // Forward stream events to WS
    (async () => {
      try {
        for await (const event of stream) {
          connMgr.broadcastWithWildcard(`execution:${executionId}`, event);
        }
      } catch (err) {
        connMgr.broadcastWithWildcard(`execution:${executionId}`, {
          type: 'error',
          message: err instanceof Error ? err.message : 'Stream error',
        });
      }
    })();

    return c.json({
      ok: true,
      data: { sessionId, executionId, streaming: true },
    });
  });

  return app;
}
