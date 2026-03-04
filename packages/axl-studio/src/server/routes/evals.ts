import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';

const app = new Hono<StudioEnv>();

// List registered eval configs
app.get('/evals', async (c) => {
  const runtime = c.get('runtime');
  const evals = runtime.getRegisteredEvals();
  return c.json({ ok: true, data: evals });
});

// Run a registered eval by name
app.post('/evals/:name/run', async (c) => {
  const runtime = c.get('runtime');
  const name = c.req.param('name');

  const entry = runtime.getRegisteredEval(name);
  if (!entry) {
    return c.json(
      { ok: false, error: { code: 'NOT_FOUND', message: `Eval "${name}" not found` } },
      404,
    );
  }

  try {
    const result = await runtime.runRegisteredEval(name);
    return c.json({ ok: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: { code: 'EVAL_ERROR', message } }, 400);
  }
});

// Compare eval results
app.post('/evals/compare', async (c) => {
  const runtime = c.get('runtime');
  const body = await c.req.json<{ baseline: unknown; candidate: unknown }>();

  try {
    const result = await runtime.evalCompare(body.baseline, body.candidate);
    return c.json({ ok: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: { code: 'EVAL_ERROR', message } }, 400);
  }
});

export default app;
