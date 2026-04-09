import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';

export function createEvalRoutes(evalLoader?: () => Promise<void>) {
  const app = new Hono<StudioEnv>();

  // List registered eval configs
  app.get('/evals', async (c) => {
    if (evalLoader) await evalLoader();
    const runtime = c.get('runtime');
    const evals = runtime.getRegisteredEvals();
    return c.json({ ok: true, data: evals });
  });

  // Get eval run history
  app.get('/evals/history', async (c) => {
    const runtime = c.get('runtime');
    const history = await runtime.getEvalHistory();
    return c.json({ ok: true, data: history });
  });

  // Run a registered eval by name (supports optional multi-run via { runs: N })
  app.post('/evals/:name/run', async (c) => {
    if (evalLoader) await evalLoader();
    const runtime = c.get('runtime');
    const name = c.req.param('name');

    const entry = runtime.getRegisteredEval(name);
    if (!entry) {
      return c.json(
        { ok: false, error: { code: 'NOT_FOUND', message: `Eval "${name}" not found` } },
        404,
      );
    }

    let runs = 1;
    try {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.runs === 'number' && Number.isFinite(body.runs) && body.runs > 1) {
        runs = Math.min(Math.floor(body.runs), 25);
      }
    } catch {
      // No body or invalid body — single run
    }

    try {
      if (runs > 1) {
        const { randomUUID } = await import('node:crypto');
        const { aggregateRuns } = await import('@axlsdk/eval');
        const runGroupId = randomUUID();
        const results = [];
        for (let r = 0; r < runs; r++) {
          const result = await runtime.runRegisteredEval(name);
          (result as any).metadata = { ...(result as any).metadata, runGroupId, runIndex: r };
          results.push(result);
        }
        const aggregate = aggregateRuns(results as any);
        const result = { ...(results[0] as any), _multiRun: { aggregate, allRuns: results } };
        return c.json({ ok: true, data: result });
      } else {
        // Runtime persists eval result to history automatically
        const result = await runtime.runRegisteredEval(name);
        return c.json({ ok: true, data: result });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: { code: 'EVAL_ERROR', message } }, 400);
    }
  });

  // Rescore: re-run scorers on saved outputs
  app.post('/evals/:name/rescore', async (c) => {
    if (evalLoader) await evalLoader();
    const runtime = c.get('runtime');
    const name = c.req.param('name');
    const body = await c.req.json<{ resultId: string }>();

    if (!body.resultId || typeof body.resultId !== 'string') {
      return c.json(
        { ok: false, error: { code: 'BAD_REQUEST', message: 'resultId is required' } },
        400,
      );
    }

    const entry = runtime.getRegisteredEval(name);
    if (!entry) {
      return c.json(
        { ok: false, error: { code: 'NOT_FOUND', message: `Eval "${name}" not found` } },
        404,
      );
    }

    const history = await runtime.getEvalHistory();
    const historyEntry = history.find((h) => h.id === body.resultId);
    if (!historyEntry) {
      return c.json(
        { ok: false, error: { code: 'NOT_FOUND', message: `Result "${body.resultId}" not found` } },
        404,
      );
    }

    try {
      const { rescore } = await import('@axlsdk/eval');
      const config = entry.config as { scorers?: unknown[] };
      const result = await rescore(historyEntry.data as any, config.scorers as any, runtime);
      await runtime.saveEvalResult({
        id: result.id,
        eval: name,
        timestamp: Date.now(),
        data: result,
      });
      return c.json({ ok: true, data: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: { code: 'EVAL_ERROR', message } }, 400);
    }
  });

  // Compare eval results
  app.post('/evals/compare', async (c) => {
    const runtime = c.get('runtime');
    const body = await c.req.json<{
      baseline: unknown;
      candidate: unknown;
      options?: { thresholds?: Record<string, number> | number };
    }>();

    try {
      const result = await runtime.evalCompare(body.baseline, body.candidate, body.options);
      return c.json({ ok: true, data: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: { code: 'EVAL_ERROR', message } }, 400);
    }
  });

  return app;
}
