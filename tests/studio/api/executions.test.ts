import { describe, it, expect } from 'vitest';
import { MockProvider } from '@axlsdk/testing';
import { createTestServer } from '../helpers/setup.js';
import { readJson } from '../helpers/json.js';

describe('Studio API: Executions', () => {
  it('GET /api/executions is empty, then populated after workflow execution', async () => {
    const provider = MockProvider.sequence([{ content: 'done' }]);
    const { app } = createTestServer(provider);

    // Initially empty
    const res1 = await app.request('/api/executions');
    expect(res1.status).toBe(200);
    const body1 = await readJson(res1);
    expect(body1.ok).toBe(true);
    expect(body1.data).toEqual([]);

    // Execute a workflow
    await app.request('/api/workflows/test-wf/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { message: 'test' } }),
    });

    // Now should have an execution
    const res2 = await app.request('/api/executions');
    const body2 = await readJson(res2);
    expect(body2.ok).toBe(true);
    expect(body2.data.length).toBe(1);
    expect(body2.data[0].workflow).toBe('test-wf');
    expect(body2.data[0].status).toBe('completed');
  });

  it('POST /api/executions/:id/abort returns abort confirmation', async () => {
    const { app } = createTestServer();

    // Abort a non-existent execution — should still return a success response
    const res = await app.request('/api/executions/nonexistent/abort', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.aborted).toBe(true);
  });

  it('GET /api/executions scrubs result when trace.redact is on', async () => {
    const provider = MockProvider.sequence([{ content: 'sensitive response' }]);
    const { app } = createTestServer(provider, { redact: true });

    await app.request('/api/workflows/test-wf/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { message: 'test' } }),
    });

    // List endpoint: result should be `[redacted]`.
    const res = await app.request('/api/executions');
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0].result).toBe('[redacted]');
    // Metadata must remain visible for the Trace Explorer to render context.
    expect(body.data[0].workflow).toBe('test-wf');
    expect(body.data[0].status).toBe('completed');

    // Detail endpoint: same scrubbing.
    const id = body.data[0].executionId;
    const detailRes = await app.request(`/api/executions/${id}`);
    const detailBody = await readJson(detailRes);
    expect(detailBody.ok).toBe(true);
    expect(detailBody.data.result).toBe('[redacted]');
    expect(detailBody.data.workflow).toBe('test-wf');
  });

  it('GET /api/executions returns raw result when trace.redact is off', async () => {
    const provider = MockProvider.sequence([{ content: 'public answer' }]);
    const { app } = createTestServer(provider, { redact: false });

    await app.request('/api/workflows/test-wf/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { message: 'test' } }),
    });

    const res = await app.request('/api/executions');
    const body = await readJson(res);
    // Assert the exact raw content — a weaker `.not.toBe('[redacted]')`
    // assertion would miss regressions like `'[redacted]-suffix'` or
    // null-coerced-to-'empty' that still bypass the scrub.
    expect(body.data[0].result).toBe('public answer');
  });

  it('GET /api/executions/:id?since={step} filters events to the tail', async () => {
    // Spec/16 §5.4. Polling clients can request only events with
    // `step > since` so the wire payload stays bounded on long runs.
    const provider = MockProvider.sequence([{ content: 'done' }]);
    const { app } = createTestServer(provider);

    await app.request('/api/workflows/test-wf/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { message: 'test' } }),
    });

    const list = await readJson(await app.request('/api/executions'));
    const id = list.data[0].executionId;

    // Full fetch — note the total event count so we have a baseline.
    const full = await readJson(await app.request(`/api/executions/${id}`));
    const total = full.data.events.length;
    expect(total).toBeGreaterThan(1);

    // `?since=0` drops only events with step === 0 (workflow_start).
    const sinceZero = await readJson(await app.request(`/api/executions/${id}?since=0`));
    expect(sinceZero.data.events.length).toBe(total - 1);
    expect(sinceZero.data.events.every((e: { step: number }) => e.step > 0)).toBe(true);

    // `?since={lastStep}` returns an empty array (no events beyond the last).
    const lastStep = full.data.events[full.data.events.length - 1].step;
    const tail = await readJson(await app.request(`/api/executions/${id}?since=${lastStep}`));
    expect(tail.data.events).toEqual([]);

    // Malformed `since` param: server returns 400 with a diagnostic
    // envelope. Silent fallthrough would let a stringly-typed client bug
    // balloon the payload; a 400 surfaces the bug instead.
    const malformedRes = await app.request(`/api/executions/${id}?since=notanumber`);
    expect(malformedRes.status).toBe(400);
    const malformed = await readJson(malformedRes);
    expect(malformed.ok).toBe(false);
    expect(malformed.error.code).toBe('INVALID_PARAM');
    expect(malformed.error.param).toBe('since');

    // Fractional and Infinity also rejected.
    const fracRes = await app.request(`/api/executions/${id}?since=0.5`);
    expect(fracRes.status).toBe(400);
    const infRes = await app.request(`/api/executions/${id}?since=Infinity`);
    expect(infRes.status).toBe(400);

    // Negative `since=-1` is a valid "everything from step 0" sentinel.
    const negative = await readJson(await app.request(`/api/executions/${id}?since=-1`));
    expect(negative.data.events.length).toBe(total);
  });
});
