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
// Polling pattern: client tracks `lastStep = events[events.length - 1]?.step`
// and passes `?since=<lastStep>` on the next poll. First poll either
// omits `since` or passes `-1` for "everything from step 0 onward" —
// `since=0` explicitly means "I already have step 0, give me step 1+".
// This preserves correctness when `workflow_start` lands at step 0.
//
// Malformed `since` (non-integer / non-finite) returns 400 — stale or
// buggy clients get a clear diagnostic instead of silently receiving
// the full events array and blowing their memory budget.
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
    // Accept any finite integer, including -1 for "everything". Reject
    // NaN, Infinity, fractions, and non-numeric strings with a 400.
    if (!Number.isFinite(since) || !Number.isInteger(since)) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'INVALID_PARAM',
            message: `\`since\` must be a finite integer (got "${sinceParam}")`,
            param: 'since',
          },
        },
        400,
      );
    }
    paged = {
      ...execution,
      events: execution.events.filter((e) => e.step > since),
    };
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
