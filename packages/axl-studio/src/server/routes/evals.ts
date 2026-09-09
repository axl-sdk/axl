import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import type { ConnectionManager } from '../ws/connection-manager.js';
import type { DegradedScorer, EvalResult, Scorer } from '@axlsdk/eval';
import type { CapturedRequestRecord } from '@axlsdk/axl';
import {
  redactEvalHistoryList,
  redactEvalResult,
  redactErrorMessage,
  redactRecordLine,
} from '../redact.js';
import {
  importedAccountingIsTrustworthy,
  isValidImportedCoverage,
  stripAccounting,
} from '../eval-import.js';

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
    const redactOn = runtime.isRedactEnabled();

    const entry = runtime.getRegisteredEval(name);
    if (!entry) {
      return c.json(
        { ok: false, error: { code: 'NOT_FOUND', message: `Eval "${name}" not found` } },
        404,
      );
    }

    let runs = 1;
    let stream = false;
    let captureTraces = false;
    let captureRequests = false;
    try {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.runs === 'number' && Number.isFinite(body.runs) && body.runs > 1) {
        runs = Math.min(Math.floor(body.runs), 25);
      }
      if (body.stream === true) {
        stream = true;
      }
      if (body.captureTraces === true) {
        captureTraces = true;
      }
      // Boolean only. The byte bounds are runtime configuration, not something a
      // request body gets to raise -- an unbounded capture requested over HTTP is
      // a disk-exhaustion lever.
      if (body.captureRequests === true) {
        captureRequests = true;
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
            // Per-run failure no longer tanks the whole batch — completed
            // runs cost real money and have statistical signal. We capture
            // the first failure, stop attempting further runs (same
            // reasoning as the CLI: don't speculatively burn API calls on a
            // potentially-permanent failure), and emit a partial-aware
            // `done` event so the client can render the partial result
            // distinctly. `batchAttempted` is stamped on every run's
            // metadata up front so persisted history records carry the
            // expected count, letting any later viewer derive partial-ness.
            let runFailure: Error | undefined;

            // Tracks user cancellation separately from genuine failure
            // so the terminal `done` event can label the partial batch
            // correctly (`cancelled: true` vs `batchFailure: "<msg>"`).
            // Without this distinction, a mid-run cancel would show as
            // "Run 3/5 failed: AbortError: ..." — confusing UX since the
            // user knows they pressed cancel.
            let cancelled = false;
            for (let r = 0; r < runs; r++) {
              if (ac.signal.aborted) {
                cancelled = true;
                break;
              }
              try {
                const result = (await runtime.runRegisteredEval(name, {
                  metadata: { runGroupId, runIndex: r, batchAttempted: runs },
                  signal: ac.signal,
                  captureTraces,
                  captureRequests,
                  onProgress: (event) => {
                    // Library-level `run_done` fires after every iteration with
                    // `{ totalItems, failures }`; Studio emits its own wire-level
                    // `run_done` below with `{ run, totalRuns }` semantics, so we
                    // drop the library variant to avoid collision on the client.
                    if (event.type === 'run_done') return;
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
              } catch (err) {
                // Distinguish user cancellation from genuine failure. An
                // AbortError thrown mid-`runRegisteredEval` (signal fired
                // while the run was in flight) is the user pressing
                // cancel, not the provider failing. Don't stamp a
                // `batchFailure` for it — that field reads as a fault
                // signal in the History badge and Compare banners.
                const isAbort =
                  ac.signal.aborted || (err instanceof Error && err.name === 'AbortError');
                if (isAbort) {
                  cancelled = true;
                  connMgr.broadcastWithWildcard(`eval:${evalRunId}`, {
                    type: 'run_cancelled',
                    run: r + 1,
                    totalRuns: runs,
                  });
                  break;
                }
                runFailure = err instanceof Error ? err : new Error(String(err));
                connMgr.broadcastWithWildcard(`eval:${evalRunId}`, {
                  type: 'run_failed',
                  run: r + 1,
                  totalRuns: runs,
                  message: redactErrorMessage(runFailure, redactOn),
                });
                break;
              }
            }

            if (results.length > 0) {
              const partial = results.length < runs;
              // Coalesce empty-message errors so the banner never shows a
              // blank "Stopped after:" line. `new Error('')` produces
              // `message === ''`; `redactErrorMessage` preserves that under
              // safe-error-name allow-listing, so we fall through to
              // `String(runFailure)` (which yields at least the constructor
              // name) before omitting the field entirely.
              const failureMsg = runFailure
                ? redactErrorMessage(runFailure, redactOn) || String(runFailure) || undefined
                : undefined;
              connMgr.broadcastWithWildcard(`eval:${evalRunId}`, {
                type: 'done',
                evalResultId: results[0].id,
                runGroupId,
                ...(partial && {
                  partial: true,
                  batchCompleted: results.length,
                  batchAttempted: runs,
                  // `cancelled` and `batchFailure` are mutually exclusive:
                  // the catch block sets at most one of {cancelled,
                  // runFailure}. The client uses `cancelled` to render a
                  // neutral "Cancelled — X of N runs completed" caption
                  // instead of the amber "Stopped after: <message>"
                  // failure caption.
                  ...(cancelled ? { cancelled: true } : {}),
                  ...(failureMsg ? { batchFailure: failureMsg } : {}),
                }),
              });
            } else if (runFailure) {
              // No runs completed — a hard error, not a partial.
              connMgr.broadcastWithWildcard(`eval:${evalRunId}`, {
                type: 'error',
                message: redactErrorMessage(runFailure, redactOn),
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
              captureTraces,
              captureRequests,
              onProgress: (event) => {
                // Drop library-level `run_done` — Studio's terminal signal for
                // single-run streams is the `done` event below, which carries
                // the `evalResultId` pointer the client uses to refetch.
                if (event.type === 'run_done') return;
                connMgr.broadcastWithWildcard(`eval:${evalRunId}`, event);
              },
            })) as EvalResult;
            connMgr.broadcastWithWildcard(`eval:${evalRunId}`, {
              type: 'done',
              evalResultId: result.id,
            });
          }
        } catch (err) {
          // Eval-channel error event shape is NOT a `StreamEvent`, so it
          // doesn't pass through `redactStreamEvent`. Scrub the message
          // inline so ValidationError/GuardrailError/provider errors don't
          // leak user input on the eval:* channel under redact mode.
          connMgr.broadcastWithWildcard(`eval:${evalRunId}`, {
            type: 'error',
            message: redactErrorMessage(err, redactOn),
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
        const results: EvalResult[] = [];
        // Same partial-preservation pattern as the streaming path: catch
        // per-run failures, break, return the partial batch with explicit
        // markers. Differs from streaming only in delivery — here partial
        // info rides on the JSON response (`_multiRun.partial` etc.)
        // instead of a WS event.
        let runFailure: Error | undefined;
        for (let r = 0; r < runs; r++) {
          try {
            const result = await runtime.runRegisteredEval(name, {
              metadata: { runGroupId, runIndex: r, batchAttempted: runs },
              captureTraces,
              captureRequests,
            });
            results.push(result as EvalResult);
          } catch (err) {
            runFailure = err instanceof Error ? err : new Error(String(err));
            break;
          }
        }
        if (results.length === 0) {
          throw runFailure ?? new Error('No runs completed');
        }
        const aggregate = aggregateRuns(results);
        const first = results[0];
        const partial = results.length < runs;
        // Coalesce empty-message errors so the response never carries a
        // blank batchFailure (downstream `buildMultiRunResult` filters
        // empty strings, so an empty value here just becomes silent —
        // worse than omitting the field).
        const failureMsg = runFailure
          ? redactErrorMessage(runFailure, redactOn) || String(runFailure) || undefined
          : undefined;
        // Union scorer degradation across all runs onto the aggregate summary.
        // Spreading `...first` would surface only run[0]'s `summary.degraded`,
        // so a gate that trips on a later run would be invisible in the default
        // aggregate landing view even though the aggregate mean is contaminated.
        // Mirrors the client's `buildMultiRunResult` so the sync (stream:false)
        // and streaming (stream:true, client-rebuilt) paths behave identically.
        const aggDegraded = unionDegradedScorers(results);
        const result = {
          ...first,
          summary: {
            ...first.summary,
            ...(aggDegraded.length > 0 ? { degraded: aggDegraded } : {}),
          },
          _multiRun: {
            aggregate,
            allRuns: results,
            ...(partial && {
              partial: true,
              batchCompleted: results.length,
              batchAttempted: runs,
              ...(failureMsg ? { batchFailure: failureMsg } : {}),
            }),
          },
        } as EvalResult;
        return c.json({
          ok: true,
          data: redactEvalResult(result, redactOn),
        });
      } else {
        // Runtime persists eval result to history automatically
        const result = (await runtime.runRegisteredEval(name, {
          captureTraces,
          captureRequests,
        })) as EvalResult;
        return c.json({
          ok: true,
          data: redactEvalResult(result, redactOn),
        });
      }
    } catch (err) {
      // Inline error envelope — scrub to keep redaction semantics
      // consistent with the global `errorHandler` middleware.
      return c.json(
        { ok: false, error: { code: 'EVAL_ERROR', message: redactErrorMessage(err, redactOn) } },
        400,
      );
    }
  });

  // ── Captured-request diagnostics ───────────────────────────────────
  //
  // Two endpoints, deliberately split: the manifest is small, cheap and safe to
  // render in a list; the records can be megabytes and are streamed only when
  // someone actually asks to read them.
  //
  // Both address the artifact by the owning HISTORY ID, never by artifact id
  // from the client. A client that could name an artifact directly could read
  // one whose owning run it is not looking at (or that belongs to another
  // tenant's history row); resolving through history keeps authorization and
  // lookup on the same key. `runtime.openDiagnosticArtifact` then applies the
  // logical checks — owner still exists, expiry has not passed — so an artifact
  // whose Redis row aged out while this process was offline 404s instead of
  // serving bytes.

  /** Locate a history entry and the artifact id it declares, if any. */
  async function resolveDiagnostics(
    runtime: StudioEnv['Variables']['runtime'],
    id: string,
  ): Promise<{ artifactId: string } | undefined> {
    const history = await runtime.getEvalHistory();
    const entry = history.find((h) => h.id === id);
    const artifactId = (entry?.data as EvalResult | undefined)?.diagnostics?.artifactId;
    return typeof artifactId === 'string' && artifactId !== '' ? { artifactId } : undefined;
  }

  app.get('/evals/:id/diagnostics', async (c) => {
    const runtime = c.get('runtime');
    const id = c.req.param('id');
    const resolved = await resolveDiagnostics(runtime, id);
    if (!resolved) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'NOT_FOUND',
            message: `Eval result "${id}" has no captured requests`,
          },
        },
        404,
      );
    }
    const opened = await runtime.openDiagnosticArtifact(resolved.artifactId);
    if (!opened) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'NOT_FOUND',
            message: `Captured requests for eval result "${id}" are no longer available`,
          },
        },
        404,
      );
    }
    // The manifest is structural throughout — counts, byte totals, a status, an
    // expiry — so redaction has nothing to scrub here. `reason` is generated by
    // Axl (a limit or a sink error), never echoed user content.
    return c.json({
      ok: true,
      data: {
        artifactId: opened.manifest.artifactId,
        status: opened.manifest.status,
        ...(opened.manifest.reason !== undefined ? { reason: opened.manifest.reason } : {}),
        records: opened.manifest.records,
        bytes: opened.manifest.bytes,
        fidelity: opened.manifest.fidelity,
        redaction: opened.manifest.redaction,
        ...(opened.manifest.expiresAt !== undefined
          ? { expiresAt: opened.manifest.expiresAt }
          : {}),
        ...(opened.manifest.copiedFrom !== undefined
          ? { copiedFrom: opened.manifest.copiedFrom }
          : {}),
      },
    });
  });

  app.get('/evals/:id/diagnostics/records', async (c) => {
    const runtime = c.get('runtime');
    const redactOn = runtime.isRedactEnabled();
    const id = c.req.param('id');
    const resolved = await resolveDiagnostics(runtime, id);
    const opened = resolved ? await runtime.openDiagnosticArtifact(resolved.artifactId) : undefined;
    if (!opened) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'NOT_FOUND',
            message: `Captured requests for eval result "${id}" are not available`,
          },
        },
        404,
      );
    }
    // Streamed as JSONL rather than buffered into a JSON array: an artifact is
    // allowed to be 16 MiB and materializing that as one string to serialize is
    // how a diagnostics read takes the server down.
    //
    // The reader is held explicitly rather than driven by `for await`, because a
    // consumer that vanishes mid-artifact (a closed tab, an aborted fetch) has
    // to end the underlying read too. Without `cancel()` the loop keeps pulling
    // lines off the disk for a stream nobody is attached to and enqueues into a
    // closed controller, which throws where nothing is waiting to catch it.
    let cancelled = false;
    const lines = opened.lines[Symbol.asyncIterator]();
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          try {
            for (;;) {
              const next = await lines.next();
              if (next.done || cancelled) break;
              controller.enqueue(encoder.encode(`${redactRecordLine(next.value, redactOn)}\n`));
            }
            if (!cancelled) controller.close();
          } catch (error) {
            if (!cancelled) controller.error(error);
          } finally {
            // Release the artifact's file handle. Abandoning it would hold a
            // descriptor open for as long as the process lives.
            await lines.return?.().catch(() => undefined);
          }
        },
        cancel() {
          cancelled = true;
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    );
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
    const redactOn = runtime.isRedactEnabled();
    const name = c.req.param('name');
    const body = await c.req.json<{ resultId: string; captureRequests?: unknown }>();
    const captureRequests = body.captureRequests === true;

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
        captureRequests ? { captureRequests: true } : undefined,
      );
      await runtime.saveEvalResult({
        id: result.id,
        eval: name,
        timestamp: Date.now(),
        data: result,
      });
      return c.json({
        ok: true,
        data: redactEvalResult(result, redactOn),
      });
    } catch (err) {
      return c.json(
        { ok: false, error: { code: 'EVAL_ERROR', message: redactErrorMessage(err, redactOn) } },
        400,
      );
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
    const redactOn = runtime.isRedactEnabled();
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
    //
    // DoS cap (reviewer HIGH H1): `evalCompare` pools items across all runs
    // for paired bootstrap CI (1000 resamples). An unbounded array lets a
    // readOnly attacker run 500-run × 100-item × 1000-resample comparisons
    // on each request. Cap at 25 to match the multi-run ceiling on
    // `POST /api/evals/:name/run`.
    const MAX_POOLED_RUNS = 25;
    const validateIdParam = (v: unknown, name: string): string | null => {
      if (typeof v === 'string') return v === '' ? `${name} must be non-empty` : null;
      if (Array.isArray(v)) {
        if (v.length === 0) return `${name} must be a non-empty array`;
        if (v.length > MAX_POOLED_RUNS) {
          return `${name} may contain at most ${MAX_POOLED_RUNS} ids (pooled comparison)`;
        }
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
      return c.json(
        {
          ok: false,
          error: { code: 'COMPARE_FAILED', message: redactErrorMessage(err, redactOn) },
        },
        400,
      );
    }
  });

  // Import a CLI eval artifact into runtime history.
  //
  // Accepts a parsed EvalResult JSON (single object) OR an array of
  // EvalResults (multi-run output). The CLI writes a single object when
  // `results.length === 1` and an array otherwise — including for partial
  // batches (e.g. 2-of-5 produces a 2-element array). Without array
  // support, partial multi-run artifacts couldn't be imported in one
  // request, undermining the partial-batch story we worked to preserve.
  //
  // For arrays: every result is imported as its own history entry; if the
  // artifact's per-run `metadata.runGroupId` is consistent across the
  // array, the entries appear together as a multi-run group in the
  // History tab. A fresh UUID is generated per entry so repeated imports
  // don't collide.
  //
  // Note: this is the one Studio endpoint whose request bodies can be large.
  // If mounted as middleware and importing sizeable eval files, raise the
  // host framework's JSON body limit on the Studio mount.
  app.post('/evals/import', async (c) => {
    const runtime = c.get('runtime');
    const body = await c.req.json<{
      result: unknown;
      eval?: string;
      requests?: unknown;
    }>();

    const bad = (message: string) =>
      c.json({ ok: false, error: { code: 'BAD_REQUEST', message } }, 400);

    if (body.result === undefined || body.result === null) {
      return bad('result is required');
    }

    // Normalize to an array up front. Single-object form is just a
    // 1-element array internally — keeps the validation/import loop
    // uniform and avoids two divergent code paths that could drift.
    const resultsRaw = Array.isArray(body.result) ? body.result : [body.result];
    if (resultsRaw.length === 0) {
      return bad('result must be a non-empty array or object');
    }

    // Validate each entry separately so a heterogeneous batch (one bad
    // run in a 5-run array) reports a precise index rather than rejecting
    // the whole import or accepting it half-formed.
    const validatedResults: Array<Record<string, unknown>> = [];
    for (let i = 0; i < resultsRaw.length; i++) {
      const entry = resultsRaw[i];
      const prefix = resultsRaw.length > 1 ? `result[${i}]` : 'result';
      if (!entry || typeof entry !== 'object') {
        return bad(`${prefix} must be an object`);
      }
      const r = entry as Record<string, unknown>;
      if (!Array.isArray(r.items)) {
        return bad(`${prefix}.items must be an array`);
      }
      if (typeof r.summary !== 'object' || r.summary == null) {
        return bad(`${prefix}.summary must be an object`);
      }
      if (typeof r.dataset !== 'string' || !r.dataset) {
        return bad(`${prefix}.dataset must be a non-empty string (required for compare)`);
      }
      const summary = r.summary as Record<string, unknown>;
      if (typeof summary.scorers !== 'object' || summary.scorers == null) {
        return bad(`${prefix}.summary.scorers must be an object`);
      }
      const summaryScorerNames = Object.keys(summary.scorers as Record<string, unknown>);
      const items = r.items as Array<Record<string, unknown>>;
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
          `${prefix} item scores reference scorer(s) not in summary.scorers: ${[...uncoveredAcrossItems].join(', ')}`,
        );
      }
      validatedResults.push(r);
    }

    // Eval-name resolution uses the FIRST run's metadata as the
    // representative — multi-run groups always share a workflow today
    // (the runner produces homogeneous batches), and falling back across
    // all runs would silently mask a heterogeneous import the user
    // probably didn't intend.
    const trim = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    const firstResult = validatedResults[0];
    const metadataObj =
      typeof firstResult.metadata === 'object' && firstResult.metadata != null
        ? (firstResult.metadata as Record<string, unknown>)
        : {};
    const workflowsFromMeta = Array.isArray(metadataObj.workflows)
      ? (metadataObj.workflows as unknown[])
      : [];
    const primaryWorkflow = workflowsFromMeta.find((w): w is string => typeof w === 'string');
    const evalName =
      trim(body.eval) ??
      trim(primaryWorkflow) ??
      trim((firstResult as { workflow?: unknown }).workflow) ??
      'imported';

    // Stamp an accounting record on any artifact that lacks one, so a stored
    // pre-0.24 import describes itself as `unverified` instead of looking like a
    // measured run whose spend happened to be whatever `totalCost` said. Cost
    // certification downstream then refuses it for a stated reason rather than
    // silently trusting it. `@axlsdk/eval` stays an optional peer here (same as
    // the aggregate/rescore routes): if it isn't installed we import the
    // artifact unchanged, and readers synthesize the same `unverified` view.
    let readAccounting: ((r: EvalResult) => unknown) | undefined;
    let validateRequestSidecar:
      | ((
          text: unknown,
        ) => { ok: true; lines: string[]; bytes: number } | { ok: false; reason: string })
      | undefined;
    try {
      ({ readAccounting, validateRequestSidecar } = await import('@axlsdk/eval'));
    } catch {
      readAccounting = undefined;
      validateRequestSidecar = undefined;
    }

    // Optional captured-request sidecar. It is validated in full BEFORE a
    // single result is stored: a malformed sidecar is a bad request, not a
    // half-imported run. Note what it cannot express -- a path, a URL, an
    // artifact id of the exporter's choosing. Records are re-staged under a
    // NEW artifact id owned by the NEW history row, so an imported reference
    // can only ever resolve to bytes this runtime wrote itself.
    let sidecarLines: string[] | undefined;
    if (body.requests !== undefined && body.requests !== null) {
      if (!validateRequestSidecar) {
        return bad('importing captured requests requires @axlsdk/eval to be installed');
      }
      const validation = validateRequestSidecar(body.requests);
      if (!validation.ok) return bad(validation.reason);
      sidecarLines = validation.lines;
    }
    if (sidecarLines && validatedResults.length > 1) {
      return bad('a requests sidecar can only accompany a single result');
    }

    const timestamp = Date.now();
    const imported: Array<{ id: string; eval: string; timestamp: number }> = [];
    for (const r of validatedResults) {
      const id = randomUUID();
      // Overwrite id so repeated imports of the same file get distinct
      // entries. Preserve metadata so per-run runGroupId / batchAttempted
      // / fromPartialBatch flow through to compare and trends views.
      const entry: EvalResult = {
        ...(r as unknown as EvalResult),
        id,
        metadata:
          typeof r.metadata === 'object' && r.metadata != null
            ? (r.metadata as Record<string, unknown>)
            : {},
      };
      // An imported artifact is the one result this runtime did not measure, so
      // a DECLARED accounting record has to prove it is internally consistent
      // before compare is allowed to certify a cost delta from it. A record that
      // does not add up is replaced by the same `unverified` synthesis an
      // artifact with no accounting receives -- the numbers stay readable, the
      // certification does not survive. Which way it went is recorded rather
      // than left to be inferred.
      if (entry.accounting === undefined) {
        // No accounting to certify, but `summary.coverage` is still an
        // accounting-derived claim a reader turns into "N cases were never
        // attempted". A malformed one reads as zeros, so it goes too.
        if (
          entry.summary?.coverage !== undefined &&
          !isValidImportedCoverage(entry.summary.coverage)
        ) {
          delete entry.summary.coverage;
        }
        if (readAccounting) {
          entry.accounting = readAccounting(entry) as EvalResult['accounting'];
        }
      } else if (importedAccountingIsTrustworthy(entry)) {
        entry.metadata.importedAccounting = 'declared';
      } else {
        const stripped = stripAccounting(entry);
        entry.accounting = readAccounting
          ? (readAccounting(stripped) as EvalResult['accounting'])
          : undefined;
        entry.items = stripped.items;
        // `summary` carries `coverage`, the other half of the budget-stopped
        // verdict. Leaving it behind would badge this run budget-stopped on the
        // strength of a record that just failed validation.
        entry.summary = stripped.summary;
        entry.metadata.importedAccounting = 'invalid';
      }

      // Re-stage the sidecar under the NEW history id and rewrite the result's
      // reference to the new artifact id. The exporter's artifact id is
      // deliberately discarded: it names storage in a deployment this one knows
      // nothing about.
      if (sidecarLines) {
        entry.diagnostics = await restageImportedRequests(runtime, id, sidecarLines);
      } else if (entry.diagnostics) {
        // A result that claims captured requests but arrived without them: keep
        // the numbers, say plainly that the evidence is missing, and drop the
        // dangling artifact id rather than letting a reader chase it.
        entry.diagnostics = {
          ...entry.diagnostics,
          artifactId: '',
          status: 'unavailable',
          reason: 'imported without its captured-request sidecar',
        };
      }

      await runtime.saveEvalResult({ id, eval: evalName, timestamp, data: entry });
      imported.push({ id, eval: evalName, timestamp });
    }

    // Back-compat: single-import callers still get the flat shape they
    // expected. Multi-import callers get an array indistinguishable
    // from the input order.
    if (imported.length === 1) {
      return c.json({ ok: true, data: imported[0] });
    }
    return c.json({ ok: true, data: { imported } });
  });

  /**
   * Store an imported sidecar's records as a fresh artifact owned by `ownerId`.
   *
   * Deliberately NOT committed here: `runtime.saveEvalResult` is what commits an
   * artifact, and it does so only after the history row it belongs to actually
   * lands. Staging now and letting the save commit keeps imports on exactly the
   * same two-phase path as a live run, including the rollback if the save fails.
   *
   * A storage failure yields an `unavailable` manifest rather than failing the
   * import: the caller's numeric results are valid and worth keeping even when
   * this deployment has nowhere to put the evidence.
   */
  async function restageImportedRequests(
    runtime: StudioEnv['Variables']['runtime'],
    ownerId: string,
    lines: readonly string[],
  ): Promise<EvalResult['diagnostics']> {
    try {
      const staged = await runtime.stageDiagnosticArtifact({ kind: 'eval', id: ownerId });
      let bytes = 0;
      // The bytes arrive already scrubbed or not; this deployment's own
      // `trace.redact` says nothing about them. Reading it off the records is
      // the only honest source — a manifest that claimed `'none'` over redacted
      // records would tell a compliance reader the opposite of the truth, and
      // one that claimed `'applied'` over raw ones is worse.
      let allRedacted = lines.length > 0;
      for (const line of lines) {
        await staged.sink.append(line);
        bytes += Buffer.byteLength(line, 'utf-8');
        if (allRedacted) {
          try {
            allRedacted = (JSON.parse(line) as CapturedRequestRecord).captured?.redacted === true;
          } catch {
            allRedacted = false;
          }
        }
      }
      const manifest = await runtime.finalizeDiagnosticArtifact(
        staged.artifactId,
        'complete',
        undefined,
        allRedacted ? 'applied' : 'none',
      );
      return {
        version: 1,
        artifactId: manifest.artifactId,
        fidelity: 'runtime_request',
        status: manifest.status,
        records: lines.length,
        bytes,
        redaction: manifest.redaction,
      };
    } catch (error) {
      return {
        version: 1,
        artifactId: '',
        fidelity: 'runtime_request',
        status: 'unavailable',
        reason: `captured requests could not be stored: ${error instanceof Error ? error.message : String(error)}`,
        records: 0,
        bytes: 0,
        redaction: 'none',
      };
    }
  }

  function closeActiveRuns() {
    for (const ac of activeRuns.values()) ac.abort();
    activeRuns.clear();
  }

  return { app, closeActiveRuns };
}

/**
 * Union the per-run `summary.degraded` lists across a multi-run group into a
 * single list for the aggregate. Merges by scorer name keeping the entry with
 * the higher `rate` (worst observed) and stamps `runsAffected` with the count
 * of runs that flagged that scorer. Returns `[]` when no run degraded. The
 * `runsAffected` field is a client-facing extension (absent on the canonical
 * `DegradedScorer` shape) consumed by Studio's `DegradedScorersBanner`.
 */
function unionDegradedScorers(
  results: EvalResult[],
): (DegradedScorer & { runsAffected: number })[] {
  const byScorer = new Map<string, DegradedScorer & { runsAffected: number }>();
  for (const run of results) {
    const degraded = run.summary?.degraded;
    if (!Array.isArray(degraded)) continue;
    for (const d of degraded) {
      const existing = byScorer.get(d.scorer);
      if (!existing) {
        byScorer.set(d.scorer, { ...d, runsAffected: 1 });
      } else {
        const worse = d.rate > existing.rate ? d : existing;
        byScorer.set(d.scorer, { ...worse, runsAffected: existing.runsAffected + 1 });
      }
    }
  }
  return [...byScorer.values()];
}
