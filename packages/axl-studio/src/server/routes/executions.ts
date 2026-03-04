import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';

const app = new Hono<StudioEnv>();

// List all executions
app.get('/executions', (c) => {
  const runtime = c.get('runtime');
  const executions = runtime.getExecutions();
  return c.json({ ok: true, data: executions });
});

// Get execution by ID
app.get('/executions/:id', async (c) => {
  const runtime = c.get('runtime');
  const id = c.req.param('id');
  const execution = await runtime.getExecution(id);
  if (!execution) {
    return c.json(
      { ok: false, error: { code: 'NOT_FOUND', message: `Execution "${id}" not found` } },
      404,
    );
  }
  return c.json({ ok: true, data: execution });
});

// Abort a running execution
app.post('/executions/:id/abort', (c) => {
  const runtime = c.get('runtime');
  const id = c.req.param('id');
  runtime.abort(id);
  return c.json({ ok: true, data: { aborted: true } });
});

export default app;
