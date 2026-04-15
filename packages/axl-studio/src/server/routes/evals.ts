import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import type { ConnectionManager } from '../ws/connection-manager.js';
import type { EvalResult, Scorer } from '@axlsdk/eval';
import { redactEvalHistoryList, redactEvalResult } from '../redact.js';

export function createEvalRoutes(connMgr: ConnectionManager, evalLoader?: () => Promise<void>) {
  const app = new Hono<StudioEnv>();

  // Active streaming eval runs, keyed by evalRunId. Scoped per-middleware
  // instance so multiple `createStudioMiddleware()` mounts in the same process
  // (multi-tenant deployments, concurrent unit tests) don't collide on run IDs
  // or leak AbortControllers across middleware lifecycles.
  const activeRuns = new Map<string, AbortController>();

  // List registered eval configs
  app.get('/evals', async (c) => {
    if (evalLoader) await evalLoader();
    const runtime = c.get('runtime');
    const evals = runtime.getRegisteredEvals();
    // Registered eval configs contain dataset definitions — the dataset
    // `.getItems()` contents aren't serialized in this response (we just
    // return names + scorer list), so there's no raw content to scrub.
    return c.json({ ok: true, data: evals });
  });

  // Get eval run history
  app.get('/evals/history', async (c) => {
    const runtime = c.get('runtime');
    const history = await runtime.getEvalHistory();
    return c.json({
      ok: true,
      data: redactEvalHistoryList(history, runtime.isRedactEnabled()),
    });
  });

  // Delete a single eval history entry by id.
  app.delete('/evals/history/:id', async (c) => {
    const runtime = c.get('runtime');
    const id = c.req.param('id');
    const deleted = await runtime.deleteEvalResult(id);
    if (!deleted) {
      return c.json(
        {
          ok: false,
          error: { code: 'NOT_FOUND', message: `Eval history entry "${id}" not found` },
        },
        404,
      );
    }
    return c.json({ ok: true, data: { id, deleted: true } });
  });

  // Run a registered eval by name.
  //
  // Body options:
  //   runs?: number  — multi-run count (capped at 25)
  //   stream?: true  — return evalRunId immediately, broadcast progress via WS
  //
  // When stream is false/absent, the endpoint blocks until the eval completes
  // and returns the full result (backward compatible).
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
    let stream = false;
    try {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.runs === 'number' && Number.isFinite(body.runs) && body.runs > 1) {
        runs = Math.min(Math.floor(body.runs), 25);
      }
      if (body.stream === true) {
        stream = true;
      }
    } catch {
      // No body or invalid body — single run, synchronous
    }

    // ── Streaming mode ─────────────────────────────────────────────
    if (stream) {
      const evalRunId = `eval-${randomUUID()}`;
      const ac = new AbortController();
      activeRuns.set(evalRunId, ac);

      // Fire-and-forget async execution with WS progress broadcasting.
      //
      // NOTE on the done event shape: we deliberately broadcast only a
      // pointer (`evalResultId`, optional `runGroupId`) instead of the
      // full `EvalResult`. A real eval result with ~12 items, per-item
      // score details, and metadata easily exceeds 64KB, which is our
      // WS frame budget. When we previously embedded the whole result,
      // `truncateIfOversized` replaced it with a `{__truncated}` stub
      // and the client rendered a blank screen.
      //
      // Architecturally: WS events are for small notifications,
      // `runRegisteredEval` already persists results to history via the
      // StateStore, and the client can fetch the full payload from
      // `GET /api/evals/history` once notified. This matches the hint
      // text that the truncation placeholder already used to emit.
      (async () => {
        try {
          if (runs > 1) {
            const runGroupId = randomUUID();
            const results: EvalResult[] = [];

            for (let r = 0; r < runs; r++) {
              if (ac.signal.aborted) break;
              const result = (await runtime.runRegisteredEval(name, {
                metadata: { runGroupId, runIndex: r },
                signal: ac.signal,
                onProgress: (event) => {
                  connMgr.broadcastWithWildcard(`eval:${evalRunId}`, {
                    ...event,
                    run: r + 1,
                    totalRuns: runs,
                  });
                },
              })) as EvalResult;
              results.push(result);
              connMgr.broadcastWithWildcard(`eval:${evalRunId}`, {
                type: 'run_done',
                run: r + 1,
                totalRuns: runs,
              });
            }

            if (results.length > 0) {
              connMgr.broadcastWithWildcard(`eval:${evalRunId}`, {
                type: 'done',
                evalResultId: results[0].id,
                runGroupId,
              });
            } else {
              connMgr.broadcastWithWildcard(`eval:${evalRunId}`, {
                type: 'error',
                message: 'All runs were cancelled',
              });
            }
          } else {
            const result = (await runtime.runRegisteredEval(name, {
              signal: ac.signal,
              onProgress: (event) => {
                connMgr.broadcastWithWildcard(`eval:${evalRunId}`, event);
              },
            })) as EvalResult;
            connMgr.broadcastWithWildcard(`eval:${evalRunId}`, {
              type: 'done',
              evalResultId: result.id,
            });
          }
        } catch (err) {
          connMgr.broadcastWithWildcard(`eval:${evalRunId}`, {
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          activeRuns.delete(evalRunId);
        }
      })();

      return c.json({ ok: true, data: { evalRunId } });
    }

    // ── Synchronous mode (backward compatible) ─────────────────────
    try {
      if (runs > 1) {
        const { aggregateRuns } = await import('@axlsdk/eval');
        const runGroupId = randomUUID();
        const results = [];
        for (let r = 0; r < runs; r++) {
          const result = await runtime.runRegisteredEval(name, {
            metadata: { runGroupId, runIndex: r },
          });
          results.push(result);
        }
        const typedResults = results as EvalResult[];
        const aggregate = aggregateRuns(typedResults);
        const first = typedResults[0]!;
        const result = {
          ...first,
          _multiRun: { aggregate, allRuns: typedResults },
        } as EvalResult;
        return c.json({
          ok: true,
          data: redactEvalResult(result, runtime.isRedactEnabled()),
        });
      } else {
        // Runtime persists eval result to history automatically
        const result = (await runtime.runRegisteredEval(name)) as EvalResult;
        return c.json({
          ok: true,
          data: redactEvalResult(result, runtime.isRedactEnabled()),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: { code: 'EVAL_ERROR', message } }, 400);
    }
  });

  // Cancel an active streaming eval run.
  app.post('/evals/runs/:evalRunId/cancel', (c) => {
    const evalRunId = c.req.param('evalRunId');
    const ac = activeRuns.get(evalRunId);
    if (!ac) {
      return c.json(
        { ok: false, error: { code: 'NOT_FOUND', message: 'No active eval run found' } },
        404,
      );
    }
    ac.abort();
    activeRuns.delete(evalRunId);
    return c.json({ ok: true, data: { cancelled: true } });
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
      const result = await rescore(
        historyEntry.data as EvalResult,
        config.scorers as Scorer[],
        runtime,
      );
      await runtime.saveEvalResult({
        id: result.id,
        eval: name,
        timestamp: Date.now(),
        data: result,
      });
      return c.json({
        ok: true,
        data: redactEvalResult(result, runtime.isRedactEnabled()),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: { code: 'EVAL_ERROR', message } }, 400);
    }
  });

  // Compare eval results by history ID.
  //
  // Accepts baselineId/candidateId as string (single run) or string[] (pooled
  // multi-run group). IDs are resolved from runtime history server-side so the
  // wire payload stays tiny — this avoids hitting host body-parser limits when
  // Studio is mounted as middleware behind Express/NestJS/Fastify.
  app.post('/evals/compare', async (c) => {
    const runtime = c.get('runtime');
    const body = await c.req.json<{
      baselineId: string | string[];
      candidateId: string | string[];
      options?: { thresholds?: Record<string, number> | number };
    }>();

    // Validate ID shapes up front. Each side must be a non-empty string or a
    // non-empty array of non-empty strings. `!body.baselineId` would treat
    // `[]` as truthy, so check explicitly. We also reject arrays that contain
    // any non-string element (e.g. `[null]`), which would otherwise produce a
    // confusing "Eval result(s) not found in history: null" error downstream.
    const validateIdParam = (v: unknown, name: string): string | null => {
      if (typeof v === 'string') return v === '' ? `${name} must be non-empty` : null;
      if (Array.isArray(v)) {
        if (v.length === 0) return `${name} must be a non-empty array`;
        for (const elem of v) {
          if (typeof elem !== 'string' || elem === '') {
            return `${name} array must contain only non-empty strings`;
          }
        }
        return null;
      }
      return `${name} is required (string or string[])`;
    };
    const baselineErr = validateIdParam(body.baselineId, 'baselineId');
    const candidateErr = validateIdParam(body.candidateId, 'candidateId');
    if (baselineErr || candidateErr) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'BAD_REQUEST',
            message: [baselineErr, candidateErr].filter(Boolean).join('; '),
          },
        },
        400,
      );
    }

    const history = await runtime.getEvalHistory();
    const byId = new Map(history.map((h) => [h.id, h.data as EvalResult]));

    const missing: string[] = [];
    const resolveOne = (id: string): EvalResult | undefined => {
      const data = byId.get(id);
      if (!data) missing.push(id);
      return data;
    };
    const resolveSelection = (
      idOrIds: string | string[],
    ): EvalResult | EvalResult[] | undefined => {
      if (Array.isArray(idOrIds)) {
        // Dedupe so callers passing [id, id] don't artificially shrink the
        // paired-bootstrap variance in downstream CI computation.
        const unique = Array.from(new Set(idOrIds));
        // Single-element groups are semantically equivalent to a single ID;
        // unwrap so evalCompare uses the simpler single-result code path
        // instead of the multi-run pooling path with one run.
        if (unique.length === 1) return resolveOne(unique[0]);
        const results: EvalResult[] = [];
        for (const id of unique) {
          const data = resolveOne(id);
          if (data) results.push(data);
        }
        return results;
      }
      return resolveOne(idOrIds);
    };

    const baseline = resolveSelection(body.baselineId);
    const candidate = resolveSelection(body.candidateId);

    if (missing.length > 0) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'NOT_FOUND',
            message: `Eval result(s) not found in history: ${missing.join(', ')}`,
          },
        },
        404,
      );
    }

    try {
      // `missing.length === 0` guarantees both are defined here.
      const result = await runtime.evalCompare(baseline!, candidate!, body.options);
      return c.json({ ok: true, data: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: { code: 'COMPARE_FAILED', message } }, 400);
    }
  });

  // Import a CLI eval artifact into runtime history.
  //
  // Accepts a parsed EvalResult JSON (typically produced by `axl-eval --output`).
  // Generates a fresh UUID for the history entry (overwriting result.id) so
  // repeated imports of the same file don't collide. The imported entry is
  // indistinguishable from a natively-run result in the history picker, run
  // detail view, and comparison flows.
  //
  // Note: this is the one Studio endpoint whose request bodies can be large.
  // If mounted as middleware and importing sizeable eval files, raise the
  // host framework's JSON body limit on the Studio mount.
  app.post('/evals/import', async (c) => {
    const runtime = c.get('runtime');
    const body = await c.req.json<{
      result: unknown;
      eval?: string;
    }>();

    const bad = (message: string) =>
      c.json({ ok: false, error: { code: 'BAD_REQUEST', message } }, 400);

    if (!body.result || typeof body.result !== 'object') {
      return bad('result is required');
    }

    const result = body.result as Record<string, unknown>;

    // Shape validation — catch obvious garbage early with a clear error,
    // rather than letting downstream compare/rescore throw with a confusing
    // stack. Keep the check narrow: verify the fields Studio actually reads.
    if (!Array.isArray(result.items)) {
      return bad('result.items must be an array');
    }
    if (typeof result.summary !== 'object' || result.summary == null) {
      return bad('result.summary must be an object');
    }
    if (typeof result.dataset !== 'string' || !result.dataset) {
      return bad('result.dataset must be a non-empty string (required for compare)');
    }
    const summary = result.summary as Record<string, unknown>;
    if (typeof summary.scorers !== 'object' || summary.scorers == null) {
      return bad('result.summary.scorers must be an object');
    }
    const summaryScorerNames = Object.keys(summary.scorers as Record<string, unknown>);

    // Verify that per-item score keys are covered by summary.scorers across
    // ALL items — a heterogeneous artifact where item[0] is well-formed but
    // item[N] references unknown scorers would otherwise break compare
    // downstream with a cryptic error.
    const items = result.items as Array<Record<string, unknown>>;
    const summaryScorerSet = new Set(summaryScorerNames);
    const uncoveredAcrossItems = new Set<string>();
    for (const item of items) {
      const itemScores = item?.scores;
      if (itemScores && typeof itemScores === 'object') {
        for (const name of Object.keys(itemScores as Record<string, unknown>)) {
          if (!summaryScorerSet.has(name)) uncoveredAcrossItems.add(name);
        }
      }
    }
    if (uncoveredAcrossItems.size > 0) {
      return bad(
        `item scores reference scorer(s) not in summary.scorers: ${[...uncoveredAcrossItems].join(', ')}`,
      );
    }

    // EvalResult has no eval-name field of its own — the name lives on the
    // history entry. Prefer an explicit body.eval (client may know the
    // registered eval name), then fall back to the first workflow observed
    // in metadata.workflows (primary workflow of the run), then to the
    // legacy top-level workflow field for pre-0.14 CLI artifacts, then to
    // a generic label.
    //
    // Normalize via trim() to reject strings that are whitespace-only or
    // empty (would otherwise silently fall through to the next branch).
    const trim = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

    // metadata.workflows is the canonical source post-0.14.
    const metadataObj =
      typeof result.metadata === 'object' && result.metadata != null
        ? (result.metadata as Record<string, unknown>)
        : {};
    const workflowsFromMeta = Array.isArray(metadataObj.workflows)
      ? (metadataObj.workflows as unknown[])
      : [];
    const primaryWorkflow = workflowsFromMeta.find((w): w is string => typeof w === 'string');

    const evalName =
      trim(body.eval) ??
      trim(primaryWorkflow) ??
      // Legacy fallback: pre-0.14 CLI artifacts had workflow at the top level.
      trim((result as { workflow?: unknown }).workflow) ??
      'imported';

    const id = randomUUID();
    const timestamp = Date.now();

    // Overwrite id so repeated imports of the same file get distinct entries.
    // Default metadata to {} since downstream code assumes it exists
    // (e.g. evalCompare reads metadata.scorerTypes).
    const imported: EvalResult = {
      ...(result as unknown as EvalResult),
      id,
      metadata:
        typeof result.metadata === 'object' && result.metadata != null
          ? (result.metadata as Record<string, unknown>)
          : {},
    };

    await runtime.saveEvalResult({
      id,
      eval: evalName,
      timestamp,
      data: imported,
    });

    return c.json({ ok: true, data: { id, eval: evalName, timestamp } });
  });

  return app;
}
