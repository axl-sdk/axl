import { Hono } from 'hono';
import type { StudioEnv, SessionSummary } from '../types.js';
import type { ConnectionManager } from '../ws/connection-manager.js';

export function createSessionRoutes(connMgr: ConnectionManager) {
  const app = new Hono<StudioEnv>();

  // List all sessions
  app.get('/sessions', async (c) => {
    const runtime = c.get('runtime');
    const store = runtime.getStateStore();
    if (!store.listSessions) {
      return c.json({ ok: true, data: [] });
    }
    const ids = await store.listSessions();
    const sessions: SessionSummary[] = [];
    for (const id of ids) {
      const history = await store.getSession(id);
      sessions.push({ id, messageCount: history.length });
    }
    return c.json({ ok: true, data: sessions });
  });

  // Get session history
  app.get('/sessions/:id', async (c) => {
    const runtime = c.get('runtime');
    const store = runtime.getStateStore();
    const id = c.req.param('id');
    const history = await store.getSession(id);
    const handoffHistory = await store.getSessionMeta(id, 'handoffHistory');
    return c.json({ ok: true, data: { id, history, handoffHistory: handoffHistory ?? [] } });
  });

  // Send message to session (non-streaming)
  app.post('/sessions/:id/send', async (c) => {
    const runtime = c.get('runtime');
    const id = c.req.param('id');
    const body = await c.req.json<{ message: string; workflow: string }>();

    const session = runtime.session(id);
    const result = await session.send(body.workflow, body.message);
    return c.json({ ok: true, data: { result } });
  });

  // Stream session message
  app.post('/sessions/:id/stream', async (c) => {
    const runtime = c.get('runtime');
    const id = c.req.param('id');
    const body = await c.req.json<{ message: string; workflow: string }>();

    const session = runtime.session(id);
    const stream = await session.stream(body.workflow, body.message);
    const executionId = `session-${id}-${Date.now()}`;

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

    return c.json({ ok: true, data: { executionId, streaming: true } });
  });

  // Delete session
  app.delete('/sessions/:id', async (c) => {
    const runtime = c.get('runtime');
    const store = runtime.getStateStore();
    const id = c.req.param('id');
    await store.deleteSession(id);
    return c.json({ ok: true, data: { deleted: true } });
  });

  return app;
}
