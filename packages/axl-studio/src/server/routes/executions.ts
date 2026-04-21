import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import { redactExecutionInfo, redactExecutionList } from '../redact.js';

const app = new Hono<StudioEnv>();

// List all executions
app.get('/executions', async (c) => {
  const runtime = c.get('runtime');
  const executions = await runtime.getExecutions();
  return c.json({
    ok: true,
    data: redactExecutionList(executions, runtime.isRedactEnabled()),
  });
});

// Get execution by ID.
//
// Supports `?since={step}` pagination (spec/16 §5.4) — filters
// `events` to those with `step > since`. `step` is monotonic
// per-execution and shared across nested asks (spec §3.7), so
// polling clients can request only the tail since their last known
// step without missing events from concurrent branches.
//
// When `since` is invalid (non-integer / negative), returns the full
// events array rather than erroring — the UX mental model is "show me
// what's current" and stale clients shouldn't crash the panel.
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

  const sinceParam = c.req.query('since');
  let paged = execution;
  if (sinceParam !== undefined) {
    const since = Number(sinceParam);
    if (Number.isFinite(since) && Number.isInteger(since) && since >= 0) {
      paged = {
        ...execution,
        events: execution.events.filter((e) => e.step > since),
      };
    }
  }

  return c.json({
    ok: true,
    data: redactExecutionInfo(paged, runtime.isRedactEnabled()),
  });
});

// Abort a running execution
app.post('/executions/:id/abort', (c) => {
  const runtime = c.get('runtime');
  const id = c.req.param('id');
  runtime.abort(id);
  return c.json({ ok: true, data: { aborted: true } });
});

export default app;
