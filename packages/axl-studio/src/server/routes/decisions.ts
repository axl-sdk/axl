import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';

const app = new Hono<StudioEnv>();

// List pending decisions
app.get('/decisions', async (c) => {
  const runtime = c.get('runtime');
  const decisions = await runtime.getPendingDecisions();
  return c.json({ ok: true, data: decisions });
});

// Resolve a pending decision
app.post('/decisions/:executionId/resolve', async (c) => {
  const runtime = c.get('runtime');
  const executionId = c.req.param('executionId');
  const body = await c.req.json<{ approved: boolean; reason?: string }>();

  await runtime.resolveDecision(executionId, body);
  return c.json({ ok: true, data: { resolved: true } });
});

export default app;
