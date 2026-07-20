import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import { redactPendingDecisionList } from '../redact.js';

const app = new Hono<StudioEnv>();

// List pending decisions
app.get('/decisions', async (c) => {
  const runtime = c.get('runtime');
  const decisions = await runtime.getPendingDecisions();
  return c.json({
    ok: true,
    data: redactPendingDecisionList(decisions, runtime.isRedactEnabled()),
  });
});

// Resolve a pending decision
app.post('/decisions/:executionId/resolve', async (c) => {
  const runtime = c.get('runtime');
  const executionId = c.req.param('executionId');
  let body: { approved: true; data?: string } | { approved: false; reason?: string };
  try {
    body = await c.req.json();
  } catch {
    const error = new Error('Invalid JSON request body');
    Object.assign(error, { code: 'INVALID_HUMAN_DECISION', status: 400 });
    throw error;
  }

  await runtime.resolveDecision(executionId, body);
  return c.json({ ok: true, data: { resolved: true } });
});

export default app;
