import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import type { ConnectionManager } from '../ws/connection-manager.js';
import { redactExecutionInfo, summarizeExecution } from '../redact.js';
import { decodeExecutionCursor, encodeExecutionCursor } from '../execution-cursor.js';
import type { ExecutionCursor, HistoricalExecutionInfo } from '@axlsdk/axl';

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

export function createExecutionRoutes(connMgr?: ConnectionManager): Hono<StudioEnv> {
  const app = new Hono<StudioEnv>();

  // List executions, newest first, one page at a time. Items are summaries
  // (no `events`); fetch `/executions/:id` for the events. `nextCursor` is
  // `null` on the last page.
  app.get('/executions', async (c) => {
    const runtime = c.get('runtime');

    const limitParam = c.req.query('limit');
    let limit = DEFAULT_PAGE_LIMIT;
    if (limitParam !== undefined) {
      limit = Number(limitParam);
      if (limitParam.trim() === '' || !Number.isInteger(limit) || limit < 1) {
        return invalidParam('limit', `\`limit\` must be a positive integer (got "${limitParam}")`);
      }
      if (limit > MAX_PAGE_LIMIT) {
        return invalidParam('limit', `\`limit\` must be at most ${MAX_PAGE_LIMIT} (got ${limit})`);
      }
    }

    const cursorParam = c.req.query('cursor');
    let cursor: ExecutionCursor | undefined;
    if (cursorParam !== undefined) {
      cursor = decodeExecutionCursor(cursorParam);
      if (!cursor) return invalidParam('cursor', '`cursor` is not a valid cursor');
    }

    // One extra row tells us whether another page exists.
    const rows = await runtime.getExecutions({ limit: limit + 1, cursor });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const redact = runtime.isRedactEnabled();
    return c.json({
      ok: true,
      data: page.map((info) => summarizeExecution(info, redact)),
      nextCursor:
        rows.length > limit && last
          ? encodeExecutionCursor({ startedAt: last.startedAt, executionId: last.executionId })
          : null,
    });
  });

  function invalidParam(param: string, message: string) {
    return Response.json(
      { ok: false, error: { code: 'INVALID_PARAM', message, param } },
      { status: 400 },
    );
  }

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
      } as HistoricalExecutionInfo;
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

  // Delete an execution from history.
  //
  // Use cases: GDPR right-to-be-forgotten, operator-driven cleanup of specific
  // runs (e.g. a workflow that recorded PII the user requested scrubbed). Does
  // NOT abort an in-flight execution — call POST /executions/:id/abort first
  // if the run is still running, then DELETE after it finishes.
  //
  // Symmetric to DELETE /api/evals/history/:id. Blocked in readOnly mode.
  app.delete('/executions/:id', async (c) => {
    const runtime = c.get('runtime');
    const id = c.req.param('id');
    const deleted = await runtime.deleteExecution(id);
    if (!deleted) {
      return c.json(
        {
          ok: false,
          error: { code: 'NOT_FOUND', message: `Execution "${id}" not found` },
        },
        404,
      );
    }
    // Scrub the WS replay buffer for this execution so late subscribers can't
    // replay events for a deleted run. Otherwise the events remain replayable
    // for up to BUFFER_TTL_MS after stream completion — a leak path for the
    // GDPR-delete use case.
    connMgr?.clearChannelBuffer(`execution:${id}`);
    return c.json({ ok: true, data: { id, deleted: true } });
  });

  return app;
}

// Back-compat default export so existing imports still work. Embedders
// who want WS buffer scrubbing on DELETE should switch to the factory form.
export default createExecutionRoutes();
