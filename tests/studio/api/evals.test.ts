import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MockProvider } from '@axlsdk/testing';
import { dataset, scorer } from '@axlsdk/eval';
import { createTestServer } from '../helpers/setup.js';
import { readJson } from '../helpers/json.js';

describe('Studio API: Evals', () => {
  it('GET /api/evals lists registered eval configs', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/evals');
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0].name).toBe('test-eval');
    expect(body.data[0].workflow).toBe('test-wf');
    expect(body.data[0].dataset).toBe('test-dataset');
    expect(body.data[0].scorers).toEqual(['always-pass']);
  });

  it('POST /api/evals/:name/run executes a registered eval', async () => {
    const provider = MockProvider.sequence([{ content: 'eval output' }]);
    const { app } = createTestServer(provider);

    const res = await app.request('/api/evals/test-eval/run', {
      method: 'POST',
    });
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);

    // Validate the full EvalResult shape that the Eval Runner panel depends on
    const data = body.data;
    expect(data).toHaveProperty('id');
    // Workflow name lives in metadata.workflows (trace-derived).
    expect(data.metadata.workflows).toEqual(['test-wf']);
    expect(data).toHaveProperty('timestamp');
    expect(typeof data.totalCost).toBe('number');
    expect(typeof data.duration).toBe('number');

    // Items
    expect(data.items.length).toBe(1);
    expect(data.items[0].output).toBe('eval output');
    expect(data.items[0].scores['always-pass']).toBe(1);

    // Summary — the panel reads summary.count, summary.failures, summary.scorers
    expect(typeof data.summary.count).toBe('number');
    expect(typeof data.summary.failures).toBe('number');
    expect(data.summary.scorers).toBeDefined();
    const scorerStats = data.summary.scorers['always-pass'];
    expect(typeof scorerStats.mean).toBe('number');
    expect(typeof scorerStats.min).toBe('number');
    expect(typeof scorerStats.max).toBe('number');
    expect(typeof scorerStats.p50).toBe('number');
    expect(typeof scorerStats.p95).toBe('number');
  });

  it('POST /api/evals/:name/run returns 404 for unregistered eval', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/nonexistent/run', {
      method: 'POST',
    });
    expect(res.status).toBe(404);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET /api/evals/history returns empty initially', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/evals/history');
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it('POST /api/evals/:name/run scrubs per-item content when trace.redact is on', async () => {
    // Closes the gap where eval results with raw prompts/responses would
    // render in the Studio Eval Runner under compliance mode.
    const provider = MockProvider.sequence([{ content: 'sensitive eval response' }]);
    const { app } = createTestServer(provider, { redact: true });

    const res = await app.request('/api/evals/test-eval/run', {
      method: 'POST',
    });
    const body = await readJson(res);
    expect(body.ok).toBe(true);

    // Per-item content scrubbed
    expect(body.data.items.length).toBe(1);
    expect(body.data.items[0].input).toBe('[redacted]');
    expect(body.data.items[0].output).toBe('[redacted]');

    // Scores preserved (structural metric)
    expect(body.data.items[0].scores['always-pass']).toBe(1);

    // Summary preserved — Eval Runner needs this to render stats under redact
    expect(typeof body.data.summary.count).toBe('number');
    expect(typeof body.data.summary.scorers['always-pass'].mean).toBe('number');

    // Metadata (execution context) preserved
    expect(body.data.metadata.workflows).toEqual(['test-wf']);
  });

  it('GET /api/evals/history scrubs per-item content when trace.redact is on', async () => {
    const provider = MockProvider.sequence([{ content: 'history content' }]);
    const { app } = createTestServer(provider, { redact: true });

    // Run an eval to populate history
    await app.request('/api/evals/test-eval/run', { method: 'POST' });

    const res = await app.request('/api/evals/history');
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.length).toBe(1);
    const result = body.data[0].data;
    expect(result.items[0].input).toBe('[redacted]');
    expect(result.items[0].output).toBe('[redacted]');
    // History-entry-level metadata preserved
    expect(body.data[0].eval).toBe('test-eval');
    expect(typeof body.data[0].timestamp).toBe('number');
  });

  it('GET /api/evals/history returns runs after execution', async () => {
    const provider = MockProvider.sequence([{ content: 'eval output' }]);
    const { app } = createTestServer(provider);

    // Run an eval
    const runRes = await app.request('/api/evals/test-eval/run', { method: 'POST' });
    expect(runRes.status).toBe(200);

    // Check history
    const histRes = await app.request('/api/evals/history');
    expect(histRes.status).toBe(200);

    const body = await readJson(histRes);
    expect(body.ok).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0].eval).toBe('test-eval');
    expect(body.data[0]).toHaveProperty('id');
    expect(typeof body.data[0].timestamp).toBe('number');
    expect(body.data[0].data).toHaveProperty('summary');
  });

  // --- Rescore endpoint ---

  it('POST /api/evals/:name/rescore rescores a previous result', async () => {
    const provider = MockProvider.sequence([{ content: 'eval output' }]);
    const { app } = createTestServer(provider);

    // Run an eval first to get a result in history
    const runRes = await app.request('/api/evals/test-eval/run', { method: 'POST' });
    expect(runRes.status).toBe(200);
    const runBody = await readJson(runRes);
    const resultId = runBody.data.id;

    // Rescore that result
    const rescoreRes = await app.request('/api/evals/test-eval/rescore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultId }),
    });
    expect(rescoreRes.status).toBe(200);

    const body = await readJson(rescoreRes);
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty('id');
    expect(body.data.id).not.toBe(resultId); // New result ID
    expect(body.data.metadata.rescored).toBe(true);
    expect(body.data.metadata.originalId).toBe(resultId);
    expect(body.data.items.length).toBe(1);
    expect(body.data.items[0].scores['always-pass']).toBe(1);
    expect(body.data.summary.scorers['always-pass']).toBeDefined();
  });

  it('POST /api/evals/:name/rescore returns 400 when resultId is missing', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/test-eval/rescore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultId: '' }),
    });
    expect(res.status).toBe(400);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('POST /api/evals/:name/rescore returns 404 for unknown eval', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/nonexistent/rescore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultId: 'some-id' }),
    });
    expect(res.status).toBe(404);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('POST /api/evals/:name/rescore returns 404 for unknown resultId', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/test-eval/rescore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultId: 'nonexistent-result-id' }),
    });
    expect(res.status).toBe(404);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('nonexistent-result-id');
  });

  // --- Multi-run endpoint ---

  it('POST /api/evals/:name/run with runs > 1 returns _multiRun data', async () => {
    const provider = MockProvider.sequence([
      { content: 'run1 output' },
      { content: 'run2 output' },
      { content: 'run3 output' },
    ]);
    const { app } = createTestServer(provider);

    const res = await app.request('/api/evals/test-eval/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs: 3 }),
    });
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);

    // Multi-run response wraps first result with _multiRun
    const data = body.data;
    expect(data).toHaveProperty('_multiRun');
    expect(data._multiRun.allRuns.length).toBe(3);

    // Aggregate summary
    const agg = data._multiRun.aggregate;
    expect(agg.runCount).toBe(3);
    expect(agg.workflows).toEqual(['test-wf']);
    expect(agg.dataset).toBe('test-dataset');
    expect(agg.scorers['always-pass']).toBeDefined();
    expect(typeof agg.scorers['always-pass'].mean).toBe('number');
    expect(typeof agg.scorers['always-pass'].std).toBe('number');

    // Each run has metadata with runGroupId and runIndex
    for (let i = 0; i < 3; i++) {
      expect(data._multiRun.allRuns[i].metadata.runGroupId).toBeDefined();
      expect(data._multiRun.allRuns[i].metadata.runIndex).toBe(i);
    }
  });

  it('POST /api/evals/:name/run preserves partial batch when run N fails mid-way', async () => {
    // Simulates the same class of failure the CLI fix addresses: run 1
    // succeeds, run 2's getItems() throws (e.g. transient provider hiccup,
    // network blip, exhausted resource). Without the fix, the whole batch
    // would error out and run 1's completed work would be discarded.
    const provider = MockProvider.echo();
    const { app, runtime } = createTestServer(provider);

    let getItemsCalls = 0;
    const partialDataset = dataset({
      name: 'partial-dataset',
      schema: z.object({ message: z.string() }),
      items: [{ input: { message: 'hello' } }],
      // Override getItems via a wrapper — first call succeeds, second throws.
      // Note: dataset() returns an object with getItems, so we monkey-patch.
    });
    const originalGetItems = partialDataset.getItems.bind(partialDataset);
    partialDataset.getItems = async () => {
      getItemsCalls++;
      if (getItemsCalls === 2) throw new Error('SIMULATED_RUN_2_FAILURE');
      return originalGetItems();
    };

    runtime.registerEval('partial-eval', {
      workflow: 'test-wf',
      dataset: partialDataset,
      scorers: [scorer({ name: 's', description: 's', score: () => 1 })],
    });

    const res = await app.request('/api/evals/partial-eval/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs: 3 }),
    });
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);

    // Completed run is preserved — the work we paid for is not thrown away.
    expect(body.data._multiRun.allRuns.length).toBe(1);
    expect(body.data._multiRun.aggregate.runCount).toBe(1);

    // Partial flags make the partial-ness explicit so the UI can render a
    // distinct badge instead of letting a 1-of-3 batch impersonate a 1-run
    // batch.
    expect(body.data._multiRun.partial).toBe(true);
    expect(body.data._multiRun.batchCompleted).toBe(1);
    expect(body.data._multiRun.batchAttempted).toBe(3);
    expect(body.data._multiRun.batchFailure).toContain('SIMULATED_RUN_2_FAILURE');

    // The completed run carries `batchAttempted` in its persisted metadata
    // so any later viewer (history reload, comparison, rescore) can derive
    // partial-ness without relying on the live response payload.
    expect(body.data._multiRun.allRuns[0].metadata.batchAttempted).toBe(3);
    expect(body.data._multiRun.allRuns[0].metadata.runIndex).toBe(0);
  });

  it('POST /api/evals/:name/run returns error when every run fails', async () => {
    const provider = MockProvider.echo();
    const { app, runtime } = createTestServer(provider);

    const failDataset = dataset({
      name: 'fail-dataset',
      schema: z.object({ message: z.string() }),
      items: [{ input: { message: 'x' } }],
    });
    failDataset.getItems = async () => {
      throw new Error('TOTAL_FAILURE');
    };

    runtime.registerEval('fail-eval', {
      workflow: 'test-wf',
      dataset: failDataset,
      scorers: [scorer({ name: 's', description: 's', score: () => 1 })],
    });

    const res = await app.request('/api/evals/fail-eval/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs: 3 }),
    });

    // No runs completed → error response, not a partial.
    expect(res.status).not.toBe(200);
  });

  it('POST /api/evals/:name/run caps runs at 25', async () => {
    // Create 25 mock responses (1 per run, dataset has 1 item each)
    const responses = Array.from({ length: 25 }, (_, i) => ({ content: `run${i} output` }));
    const provider = MockProvider.sequence(responses);
    const { app } = createTestServer(provider);

    const res = await app.request('/api/evals/test-eval/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs: 100 }), // Request 100, should be capped to 25
    });
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data._multiRun.allRuns.length).toBe(25);
    expect(body.data._multiRun.aggregate.runCount).toBe(25);
  });

  it('POST /api/evals/:name/run captures per-item and per-result workflow metadata', async () => {
    // End-to-end verification that trace-derived workflows flow through the
    // real runtime → trackExecution → runner → EvalResult. The dev seed's
    // test-eval runs test-wf, so we expect 'test-wf' to appear automatically
    // with no callback-level wiring.
    const provider = MockProvider.sequence([{ content: 'output' }]);
    const { app } = createTestServer(provider);

    const res = await app.request('/api/evals/test-eval/run', { method: 'POST' });
    expect(res.status).toBe(200);

    const body = await readJson(res);
    const data = body.data;

    // Per-item: workflows array captured from trace events
    expect(data.items[0].metadata.workflows).toEqual(['test-wf']);
    expect(data.items[0].metadata.workflowCallCounts).toEqual({ 'test-wf': 1 });

    // Per-result: aggregated workflows
    expect(data.metadata.workflows).toEqual(['test-wf']);
    expect(data.metadata.workflowCounts).toEqual({ 'test-wf': 1 });

    // There is no top-level workflow field anymore — consumers read
    // metadata.workflows. Verify the legacy field is absent on fresh runs.
    expect((data as { workflow?: unknown }).workflow).toBeUndefined();
  });

  it('POST /api/evals/:name/run captures per-item model metadata', async () => {
    const provider = MockProvider.sequence([{ content: 'output' }]);
    const { app } = createTestServer(provider);

    const res = await app.request('/api/evals/test-eval/run', { method: 'POST' });
    expect(res.status).toBe(200);

    const body = await readJson(res);
    const item = body.data.items[0];

    // The test setup uses MockProvider registered as 'test' provider with model 'default'
    // trackExecution captures model from agent_call trace events
    expect(item.metadata).toBeDefined();
    expect(item.metadata.models).toBeInstanceOf(Array);
    expect(item.metadata.models.length).toBeGreaterThan(0);
    expect(item.metadata.agentCalls).toBeGreaterThanOrEqual(1);
    expect(item.metadata.tokens).toBeDefined();

    // Result-level aggregation
    expect(body.data.metadata.models).toBeInstanceOf(Array);
    expect(body.data.metadata.models.length).toBeGreaterThan(0);
  });

  it('POST /api/evals/:name/run multi-run preserves metadata on each run', async () => {
    const provider = MockProvider.sequence([{ content: 'run1' }, { content: 'run2' }]);
    const { app } = createTestServer(provider);

    const res = await app.request('/api/evals/test-eval/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs: 2 }),
    });
    expect(res.status).toBe(200);

    const body = await readJson(res);
    for (const run of body.data._multiRun.allRuns) {
      expect(run.items[0].metadata).toBeDefined();
      expect(run.items[0].metadata.models).toBeInstanceOf(Array);
      expect(run.metadata.models).toBeInstanceOf(Array);
    }
  });

  // --- Compare endpoint (ID-based) ---
  //
  // Compare resolves baseline/candidate from runtime history by ID rather
  // than accepting full EvalResult payloads in the request body. Keeps the
  // wire payload tiny so host body-parser limits don't fire when Studio is
  // mounted as middleware behind Express/NestJS/Fastify.

  it('POST /api/evals/compare compares two eval results by ID', async () => {
    const provider = MockProvider.sequence([
      { content: 'baseline output' },
      { content: 'candidate output' },
    ]);
    const { app } = createTestServer(provider);

    const baselineRes = await app.request('/api/evals/test-eval/run', { method: 'POST' });
    expect(baselineRes.status).toBe(200);
    const baselineId = (await readJson(baselineRes)).data.id;

    const candidateRes = await app.request('/api/evals/test-eval/run', { method: 'POST' });
    expect(candidateRes.status).toBe(200);
    const candidateId = (await readJson(candidateRes)).data.id;

    const compareRes = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId, candidateId }),
    });
    expect(compareRes.status).toBe(200);

    const body = await readJson(compareRes);
    expect(body.ok).toBe(true);

    const data = body.data;
    expect(data).toHaveProperty('scorers');
    expect(data.scorers['always-pass']).toBeDefined();
    expect(typeof data.scorers['always-pass'].baselineMean).toBe('number');
    expect(typeof data.scorers['always-pass'].candidateMean).toBe('number');
    expect(typeof data.scorers['always-pass'].delta).toBe('number');
  });

  it('POST /api/evals/compare accepts thresholds option', async () => {
    const provider = MockProvider.sequence([
      { content: 'baseline output' },
      { content: 'candidate output' },
    ]);
    const { app } = createTestServer(provider);

    const baselineId = (
      await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' }))
    ).data.id;
    const candidateId = (
      await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' }))
    ).data.id;

    const compareRes = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baselineId,
        candidateId,
        options: { thresholds: { 'always-pass': 0.1 } },
      }),
    });
    expect(compareRes.status).toBe(200);

    const body = await readJson(compareRes);
    expect(body.ok).toBe(true);
    expect(body.data.scorers['always-pass']).toBeDefined();
    expect(typeof body.data.scorers['always-pass'].baselineMean).toBe('number');
    expect(typeof body.data.scorers['always-pass'].delta).toBe('number');
  });

  it('POST /api/evals/compare accepts grouped (string[]) IDs for pooled comparison', async () => {
    const provider = MockProvider.sequence([
      { content: 'b1' },
      { content: 'b2' },
      { content: 'c1' },
      { content: 'c2' },
    ]);
    const { app } = createTestServer(provider);

    // Two baseline runs and two candidate runs.
    const b1 = (await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' })))
      .data.id;
    const b2 = (await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' })))
      .data.id;
    const c1 = (await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' })))
      .data.id;
    const c2 = (await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' })))
      .data.id;

    const compareRes = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId: [b1, b2], candidateId: [c1, c2] }),
    });
    expect(compareRes.status).toBe(200);

    const body = await readJson(compareRes);
    expect(body.ok).toBe(true);
    expect(body.data.scorers['always-pass']).toBeDefined();
  });

  it('POST /api/evals/compare returns 404 with the missing ID listed', async () => {
    const provider = MockProvider.sequence([{ content: 'baseline output' }]);
    const { app } = createTestServer(provider);

    const baselineId = (
      await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' }))
    ).data.id;

    const res = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId, candidateId: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('does-not-exist');
  });

  it('POST /api/evals/compare returns 400 when IDs are missing', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('POST /api/evals/compare rejects pooled ID arrays larger than the cap (DoS guard)', async () => {
    // Reviewer security finding (H1): `evalCompare` runs paired bootstrap
    // CI (1000 resamples) across every pooled run × item. Without a cap,
    // a readOnly attacker submitting 500 IDs per side could trigger ~50B
    // operations per request. Cap is 25 to match the multi-run ceiling on
    // `POST /api/evals/:name/run`.
    const { app } = createTestServer();

    const tooManyIds = Array.from({ length: 26 }, (_, i) => `run-${i}`);
    const res = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId: tooManyIds, candidateId: 'other' }),
    });
    expect(res.status).toBe(400);

    const body = await readJson(res);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toMatch(/baselineId.*25.*ids.*pooled/i);
  });

  // --- Import endpoint ---

  it('POST /api/evals/import stores a CLI artifact in history', async () => {
    const { app } = createTestServer();

    const fakeResult = {
      id: 'original-cli-id',
      workflow: 'imported-wf',
      dataset: 'imported-ds',
      metadata: {},
      timestamp: new Date().toISOString(),
      totalCost: 0.01,
      duration: 1234,
      items: [
        {
          input: 'in',
          output: 'out',
          scores: { 'always-pass': 1 },
        },
      ],
      summary: {
        count: 1,
        failures: 0,
        scorers: {
          'always-pass': { mean: 1, min: 1, max: 1, p50: 1, p95: 1 },
        },
      },
    };

    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: fakeResult }),
    });
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(typeof body.data.id).toBe('string');
    expect(body.data.id).not.toBe('original-cli-id'); // Fresh UUID
    expect(body.data.eval).toBe('imported-wf'); // Falls back to workflow name
    expect(typeof body.data.timestamp).toBe('number');

    // History contains the imported entry under the new ID
    const histRes = await app.request('/api/evals/history');
    const histBody = await readJson(histRes);
    const entry = histBody.data.find((e: { id: string }) => e.id === body.data.id);
    expect(entry).toBeDefined();
    expect(entry.eval).toBe('imported-wf');
    expect(entry.data.id).toBe(body.data.id); // result.id was rewritten too
    expect(entry.data.items.length).toBe(1);
  });

  it('POST /api/evals/import derives eval name from metadata.workflows first', async () => {
    // Modern CLI artifacts (post-0.14) carry workflow names in metadata.workflows
    // rather than at the top level. Import should pick up the first workflow
    // in that array as the derived eval name.
    const { app } = createTestServer();

    const modernArtifact = {
      id: 'cli-original',
      dataset: 'ds',
      metadata: {
        workflows: ['modern-wf', 'nested-wf'],
        workflowCounts: { 'modern-wf': 3, 'nested-wf': 1 },
      },
      timestamp: new Date().toISOString(),
      totalCost: 0,
      duration: 100,
      items: [{ input: 'in', output: 'out', scores: { 'always-pass': 1 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: { 'always-pass': { mean: 1, min: 1, max: 1, p50: 1, p95: 1 } },
      },
    };

    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: modernArtifact }),
    });
    expect(res.status).toBe(200);

    const body = await readJson(res);
    // Primary path wins: first entry from metadata.workflows becomes the eval name.
    expect(body.data.eval).toBe('modern-wf');
  });

  it('POST /api/evals/import accepts an explicit eval name override', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eval: 'my-custom-name',
        result: {
          workflow: 'wf',
          dataset: 'ds',
          metadata: {},
          timestamp: new Date().toISOString(),
          totalCost: 0,
          duration: 0,
          items: [],
          summary: { count: 0, failures: 0, scorers: {} },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).data.eval).toBe('my-custom-name');
  });

  it('POST /api/evals/import then compare round-trip works end-to-end', async () => {
    const provider = MockProvider.sequence([{ content: 'native run' }]);
    const { app } = createTestServer(provider);

    // Run a native eval to use as the baseline.
    const nativeId = (
      await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' }))
    ).data.id;

    // Import a CLI artifact to use as the candidate. Dataset and scorer names
    // must match the native eval — evalCompare rejects mismatched datasets.
    const importRes = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        result: {
          workflow: 'test-wf',
          dataset: 'test-dataset',
          metadata: {},
          timestamp: new Date().toISOString(),
          totalCost: 0,
          duration: 100,
          items: [{ input: 'in', output: 'out', scores: { 'always-pass': 1 } }],
          summary: {
            count: 1,
            failures: 0,
            scorers: { 'always-pass': { mean: 1, min: 1, max: 1, p50: 1, p95: 1 } },
          },
        },
      }),
    });
    const importedId = (await readJson(importRes)).data.id;

    const compareRes = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId: nativeId, candidateId: importedId }),
    });
    expect(compareRes.status).toBe(200);

    const body = await readJson(compareRes);
    expect(body.ok).toBe(true);
    expect(body.data.scorers['always-pass']).toBeDefined();
  });

  it('POST /api/evals/import accepts an array of EvalResults (multi-run CLI artifact)', async () => {
    // The CLI's `--output` writes a JSON array when `--runs N > 1`,
    // including for partial batches (e.g. 2-of-5). Pre-fix the import
    // endpoint required a single object, so a partial multi-run
    // artifact couldn't be imported in one request — undermining the
    // partial-batch story. Now: array form imports each as its own
    // history entry, sharing runGroupId so they appear as a group.
    const { app } = createTestServer();

    const runGroupId = 'cli-group-abc';
    const makeRun = (runIndex: number) => ({
      id: `cli-run-${runIndex}`,
      dataset: 'partial-ds',
      metadata: {
        runGroupId,
        runIndex,
        batchAttempted: 5,
        batchCompleted: 2,
        fromPartialBatch: true,
        batchFailure: 'Provider 503',
        workflows: ['imported-wf'],
      },
      timestamp: new Date().toISOString(),
      totalCost: 0.01,
      duration: 1000,
      items: [{ input: 'in', output: 'out', scores: { 'always-pass': 1 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: { 'always-pass': { mean: 1, min: 1, max: 1, p50: 1, p95: 1 } },
      },
    });

    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: [makeRun(0), makeRun(1)] }),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    // Multi-import returns the array shape (single-import returns flat
    // for back-compat).
    expect(Array.isArray(body.data.imported)).toBe(true);
    expect(body.data.imported.length).toBe(2);
    // Both runs share the same eval name (derived once from the first
    // run's metadata), but each gets a fresh UUID so reimports don't
    // collide.
    expect(body.data.imported[0].eval).toBe('imported-wf');
    expect(body.data.imported[1].eval).toBe('imported-wf');
    expect(body.data.imported[0].id).not.toBe(body.data.imported[1].id);
    expect(body.data.imported[0].id).not.toBe('cli-run-0');

    // History contains both entries, sharing runGroupId so the History
    // tab renders them as a group with the X/N PARTIAL badge.
    const histRes = await app.request('/api/evals/history');
    const histBody = await readJson(histRes);
    const importedEntries = histBody.data.filter((e: { eval: string }) => e.eval === 'imported-wf');
    expect(importedEntries.length).toBe(2);
    const groupIds = new Set(
      importedEntries.map(
        (e: { data: { metadata?: { runGroupId?: string } } }) => e.data.metadata?.runGroupId,
      ),
    );
    expect(groupIds.size).toBe(1);
    expect([...groupIds][0]).toBe(runGroupId);
    // Partial-batch metadata round-trips so the History badge fires.
    for (const entry of importedEntries) {
      expect(entry.data.metadata.batchAttempted).toBe(5);
      expect(entry.data.metadata.fromPartialBatch).toBe(true);
    }
  });

  it('POST /api/evals/import rejects empty arrays with a clear message', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: [] }),
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.message).toMatch(/non-empty/);
  });

  it('POST /api/evals/import points to the offending index when one entry of a multi-run array is malformed', async () => {
    // A 5-element CLI artifact where item[2] has a corrupted
    // summary.scorers shape would otherwise produce a confusing
    // generic error. The error pinpoints the index so the user
    // can find the bad entry in the source JSON.
    const { app } = createTestServer();
    const goodRun = {
      id: 'good',
      dataset: 'ds',
      metadata: {},
      timestamp: new Date().toISOString(),
      totalCost: 0,
      duration: 0,
      items: [{ input: 'a', output: 'b', scores: { s: 1 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: { s: { mean: 1, min: 1, max: 1, p50: 1, p95: 1 } },
      },
    };
    const badRun = { ...goodRun, summary: null }; // broken
    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: [goodRun, badRun, goodRun] }),
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.message).toMatch(/result\[1\]\.summary/);
    // Good runs in the array should NOT have been partially saved —
    // the import is all-or-nothing per request.
    const histRes = await app.request('/api/evals/history');
    const histBody = await readJson(histRes);
    expect(histBody.data.length).toBe(0);
  });

  it('POST /api/evals/import returns 400 for invalid shape', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: { not: 'an eval result' } }),
    });
    expect(res.status).toBe(400);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('POST /api/evals/import is blocked in readOnly mode', async () => {
    const { app } = createTestServer(undefined, { readOnly: true });

    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        result: {
          workflow: 'wf',
          dataset: 'ds',
          metadata: {},
          timestamp: new Date().toISOString(),
          totalCost: 0,
          duration: 0,
          items: [],
          summary: { count: 0, failures: 0, scorers: {} },
        },
      }),
    });
    expect(res.status).toBe(405);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('READ_ONLY');
  });

  it('POST /api/evals/compare is allowed in readOnly mode (pure computation)', async () => {
    // readOnly should not block compare — only run/rescore/import which mutate state.
    const { app } = createTestServer(undefined, { readOnly: true });

    const res = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // Reaches the route handler (returns 400 for missing IDs, not 405 for readOnly).
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('POST /api/evals/import returns 400 when result is missing', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  // --- Additional edge-case coverage (hardening pass) ---

  it('POST /api/evals/compare returns 400 for empty-array IDs', async () => {
    // Empty arrays are truthy, so a naive `!body.baselineId` check would pass
    // them through — verify the explicit empty-array guard.
    const { app } = createTestServer();

    const res = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId: [], candidateId: [] }),
    });
    expect(res.status).toBe(400);

    const body = await readJson(res);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('non-empty');
  });

  it('POST /api/evals/compare accepts mixed single + array IDs', async () => {
    const provider = MockProvider.sequence([
      { content: 'b1' },
      { content: 'c1' },
      { content: 'c2' },
    ]);
    const { app } = createTestServer(provider);

    const b1 = (await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' })))
      .data.id;
    const c1 = (await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' })))
      .data.id;
    const c2 = (await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' })))
      .data.id;

    const res = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId: b1, candidateId: [c1, c2] }),
    });
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.scorers['always-pass']).toBeDefined();
  });

  it('POST /api/evals/compare dedupes duplicate IDs in a pooled group', async () => {
    // Duplicates in a group would artificially shrink the paired-bootstrap
    // variance — the server dedupes via Set before resolving.
    const provider = MockProvider.sequence([{ content: 'b1' }, { content: 'c1' }]);
    const { app } = createTestServer(provider);

    const b1 = (await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' })))
      .data.id;
    const c1 = (await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' })))
      .data.id;

    const res = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId: [b1, b1, b1], candidateId: [c1, c1] }),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
  });

  it('POST /api/evals/compare uses COMPARE_FAILED code when evalCompare throws', async () => {
    // Baseline and candidate from different datasets — evalCompare throws,
    // the route should surface it as a structured error (not EVAL_ERROR).
    const provider = MockProvider.sequence([{ content: 'out' }]);
    const { app } = createTestServer(provider);

    const baselineId = (
      await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' }))
    ).data.id;

    // Import a candidate with a different dataset name.
    const importRes = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        result: {
          workflow: 'wf',
          dataset: 'different-dataset',
          metadata: {},
          timestamp: new Date().toISOString(),
          totalCost: 0,
          duration: 0,
          items: [{ input: 'x', output: 'y', scores: { 'always-pass': 1 } }],
          summary: {
            count: 1,
            failures: 0,
            scorers: { 'always-pass': { mean: 1, min: 1, max: 1, p50: 1, p95: 1 } },
          },
        },
      }),
    });
    const candidateId = (await readJson(importRes)).data.id;

    const res = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId, candidateId }),
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('COMPARE_FAILED');
    expect(body.error.message).toContain('dataset');
  });

  it('POST /api/evals/import returns 400 when dataset is missing', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        result: {
          workflow: 'wf',
          // dataset: missing
          metadata: {},
          timestamp: new Date().toISOString(),
          totalCost: 0,
          duration: 0,
          items: [],
          summary: { count: 0, failures: 0, scorers: {} },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('dataset');
  });

  it('POST /api/evals/import detects scorer-coverage mismatch in items beyond the first', async () => {
    // Heterogeneous artifact: item[0] is well-formed but item[1] references a
    // scorer that's not in summary.scorers. Validation must scan every item,
    // not just the first.
    const { app } = createTestServer();

    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        result: {
          workflow: 'wf',
          dataset: 'ds',
          metadata: {},
          timestamp: new Date().toISOString(),
          totalCost: 0,
          duration: 0,
          items: [
            // item[0] OK
            {
              input: 'in1',
              output: 'out1',
              scores: { 'always-pass': 1 },
            },
            // item[1] references a phantom scorer
            {
              input: 'in2',
              output: 'out2',
              scores: { 'always-pass': 1, 'phantom-scorer': 0.5 },
            },
          ],
          summary: {
            count: 2,
            failures: 0,
            scorers: { 'always-pass': { mean: 1, min: 1, max: 1, p50: 1, p95: 1 } },
          },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('phantom-scorer');
  });

  it('POST /api/evals/compare rejects array IDs containing non-strings', async () => {
    // A confused caller passing [null] or [123] should get a structured
    // BAD_REQUEST instead of a confusing "not found: null" downstream.
    const { app } = createTestServer();

    const res = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId: [null], candidateId: 'some-id' }),
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('baselineId');
  });

  it('POST /api/evals/import returns 400 when item scores reference unknown scorers', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        result: {
          workflow: 'wf',
          dataset: 'ds',
          metadata: {},
          timestamp: new Date().toISOString(),
          totalCost: 0,
          duration: 0,
          items: [
            {
              input: 'in',
              output: 'out',
              // References a scorer not in summary.scorers
              scores: { 'rogue-scorer': 0.5, 'always-pass': 1 },
            },
          ],
          summary: {
            count: 1,
            failures: 0,
            scorers: { 'always-pass': { mean: 1, min: 1, max: 1, p50: 1, p95: 1 } },
          },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('rogue-scorer');
  });

  it('POST /api/evals/import normalizes whitespace-only eval name', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eval: '   ', // whitespace-only — should fall through to workflow name
        result: {
          workflow: 'fallback-wf',
          dataset: 'ds',
          metadata: {},
          timestamp: new Date().toISOString(),
          totalCost: 0,
          duration: 0,
          items: [],
          summary: { count: 0, failures: 0, scorers: {} },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.data.eval).toBe('fallback-wf');
  });

  it('POST /api/evals/import defaults missing result.metadata to empty object', async () => {
    // Downstream code (evalCompare, runner) assumes result.metadata exists.
    const { app } = createTestServer();

    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        result: {
          workflow: 'wf',
          dataset: 'ds',
          // metadata: missing entirely
          timestamp: new Date().toISOString(),
          totalCost: 0,
          duration: 0,
          items: [],
          summary: { count: 0, failures: 0, scorers: {} },
        },
      }),
    });
    expect(res.status).toBe(200);

    const histRes = await app.request('/api/evals/history');
    const histBody = await readJson(histRes);
    const id = (await readJson(res)).data.id;
    const entry = histBody.data.find((e: { id: string }) => e.id === id);
    expect(entry.data.metadata).toEqual({});
  });

  // --- Delete endpoint ---

  it('DELETE /api/evals/history/:id removes an entry from history', async () => {
    const provider = MockProvider.sequence([{ content: 'eval output' }]);
    const { app } = createTestServer(provider);

    // Run an eval to populate history.
    const runRes = await app.request('/api/evals/test-eval/run', { method: 'POST' });
    const id = (await readJson(runRes)).data.id;

    // Confirm it's in history first.
    const histBefore = await readJson(await app.request('/api/evals/history'));
    expect(histBefore.data.find((e: { id: string }) => e.id === id)).toBeDefined();

    // Delete.
    const delRes = await app.request(`/api/evals/history/${id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const delBody = await readJson(delRes);
    expect(delBody.ok).toBe(true);
    expect(delBody.data).toEqual({ id, deleted: true });

    // Confirm it's gone.
    const histAfter = await readJson(await app.request('/api/evals/history'));
    expect(histAfter.data.find((e: { id: string }) => e.id === id)).toBeUndefined();
  });

  it('DELETE /api/evals/history/:id returns 404 for unknown id', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/history/does-not-exist', { method: 'DELETE' });
    expect(res.status).toBe(404);

    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('does-not-exist');
  });

  it('DELETE /api/evals/history/:id is blocked in readOnly mode', async () => {
    const provider = MockProvider.sequence([{ content: 'eval output' }]);
    // Need a regular (non-readOnly) server first to seed an entry, then a
    // readOnly one. Simpler: seed via the same readOnly server's runtime
    // before mounting, but createTestServer doesn't expose that. Instead,
    // hit the readOnly server directly with a fake id — readOnly gating
    // happens at the route layer before the handler runs, so 405 fires
    // regardless of whether the id exists.
    const { app } = createTestServer(provider, { readOnly: true });

    const res = await app.request('/api/evals/history/any-id', { method: 'DELETE' });
    expect(res.status).toBe(405);
    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('READ_ONLY');
  });

  it('DELETE /api/evals/history/:id then compare with that ID returns 404', async () => {
    // End-to-end: deleted entries should disappear from compare's resolution path.
    const provider = MockProvider.sequence([{ content: 'a' }, { content: 'b' }]);
    const { app } = createTestServer(provider);

    const baselineId = (
      await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' }))
    ).data.id;
    const candidateId = (
      await readJson(await app.request('/api/evals/test-eval/run', { method: 'POST' }))
    ).data.id;

    // Delete the baseline.
    await app.request(`/api/evals/history/${baselineId}`, { method: 'DELETE' });

    // Compare should now 404 listing the missing baseline.
    const res = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId, candidateId }),
    });
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.error.message).toContain(baselineId);
  });

  // --- Streaming eval run endpoint ---

  it('POST /api/evals/:name/run with stream: true returns evalRunId immediately', async () => {
    const provider = MockProvider.sequence([{ content: 'output' }]);
    const { app } = createTestServer(provider);

    const res = await app.request('/api/evals/test-eval/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.evalRunId).toBeDefined();
    expect(typeof body.data.evalRunId).toBe('string');
    expect(body.data.evalRunId.startsWith('eval-')).toBe(true);

    // Give the async eval a moment to complete so history gets populated
    await new Promise((resolve) => setTimeout(resolve, 100));
    const histRes = await app.request('/api/evals/history');
    const histBody = await readJson(histRes);
    expect(histBody.data.length).toBeGreaterThan(0);
  });

  it('POST /api/evals/:name/run with stream: true + runs: 3 completes all runs', async () => {
    const provider = MockProvider.sequence([
      { content: 'r1' },
      { content: 'r2' },
      { content: 'r3' },
    ]);
    const { app } = createTestServer(provider);

    const res = await app.request('/api/evals/test-eval/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs: 3, stream: true }),
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).data.evalRunId).toBeDefined();

    // Wait for async completion
    await new Promise((resolve) => setTimeout(resolve, 200));
    const histRes = await app.request('/api/evals/history');
    const histBody = await readJson(histRes);
    // Multi-run produces N individual entries (each run saved separately)
    expect(histBody.data.length).toBe(3);
  });

  it('POST /api/evals/:name/run with stream: true preserves partial multi-run batch', async () => {
    // Streaming-mode partial preservation. Runs differ from sync-mode in
    // delivery (events on the WS channel) but share the same per-run
    // try/catch + break + batchAttempted-stamping pattern. This covers
    // BOTH state persistence AND the wire-event sequence:
    //
    //   1. run_done broadcast for run 1 (success)
    //   2. run_failed broadcast for run 2 (with redacted error message)
    //   3. terminal `done` broadcast carrying partial markers
    //
    // The original test only asserted persisted state via REST. A
    // refactor that broadcast `run_done` for the FAILED run, or skipped
    // the `run_failed` event entirely, or never reached the terminal
    // `done`, would all silently regress the streaming UX while leaving
    // the persisted-history assertion green. The WS subscriber here is
    // the tripwire.
    const provider = MockProvider.echo();
    const { app, runtime, connMgr } = createTestServer(provider);

    let getItemsCalls = 0;
    const partialDataset = dataset({
      name: 'partial-stream-dataset',
      schema: z.object({ message: z.string() }),
      items: [{ input: { message: 'hello' } }],
    });
    const originalGetItems = partialDataset.getItems.bind(partialDataset);
    partialDataset.getItems = async () => {
      getItemsCalls++;
      if (getItemsCalls === 2) throw new Error('STREAM_RUN_2_FAILURE');
      return originalGetItems();
    };

    runtime.registerEval('partial-stream-eval', {
      workflow: 'test-wf',
      dataset: partialDataset,
      scorers: [scorer({ name: 's', description: 's', score: () => 1 })],
    });

    // Subscribe a fake WS to the wildcard eval channel BEFORE kicking off
    // the run. Replay buffers cover late subscribers, but pre-subscribing
    // makes the assertion deterministic without depending on buffer TTL.
    const messages: string[] = [];
    const fakeWs = {
      send: (msg: string) => {
        messages.push(msg);
      },
    } as Parameters<typeof connMgr.add>[0];
    connMgr.add(fakeWs);
    connMgr.subscribe(fakeWs, 'eval:*');

    const res = await app.request('/api/evals/partial-stream-eval/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs: 3, stream: true }),
    });
    expect(res.status).toBe(200);
    const { evalRunId } = (await readJson(res)).data;
    expect(evalRunId).toBeDefined();

    // Wait until we see the terminal `done` event (or `error` if things
    // went sideways). Polling is bounded so a hang surfaces fast as a
    // test failure rather than an indefinite block.
    const deadline = Date.now() + 2000;
    let terminal: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      for (const raw of messages) {
        const parsed = JSON.parse(raw) as {
          type: string;
          channel: string;
          data: Record<string, unknown>;
        };
        if (parsed.data.type === 'done' || parsed.data.type === 'error') {
          terminal = parsed.data;
          break;
        }
      }
      if (terminal) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(terminal, 'streaming run never reached a terminal done/error event').toBeDefined();

    // Decode the full event stream and pin its key invariants.
    const events = messages.map(
      (raw) =>
        (JSON.parse(raw) as { data: Record<string, unknown> }).data as {
          type: string;
          run?: number;
          totalRuns?: number;
          message?: string;
        },
    );
    const runDones = events.filter((e) => e.type === 'run_done');
    const runFails = events.filter((e) => e.type === 'run_failed');

    // Exactly one successful run before the failure.
    expect(runDones.map((e) => e.run)).toEqual([1]);
    expect(runDones[0].totalRuns).toBe(3);

    // Exactly one failure event, matching the failed run number.
    expect(runFails.length).toBe(1);
    expect(runFails[0].run).toBe(2);
    expect(runFails[0].totalRuns).toBe(3);
    expect(runFails[0].message).toContain('STREAM_RUN_2_FAILURE');

    // Terminal `done` carries partial markers and the result-id pointer
    // the client uses to refetch the persisted artifact.
    expect(terminal!.type).toBe('done');
    expect(terminal!.partial).toBe(true);
    expect(terminal!.batchCompleted).toBe(1);
    expect(terminal!.batchAttempted).toBe(3);
    expect(terminal!.batchFailure).toContain('STREAM_RUN_2_FAILURE');
    expect(terminal!.evalResultId).toBeDefined();
    expect(terminal!.runGroupId).toBeDefined();

    // Run-failed and the terminal done MUST come AFTER run_done(1) so the
    // client can render its banner update from a coherent sequence. This
    // ordering check is the actual tripwire: a refactor that broadcasts
    // `done` before `run_failed` would still pass all the per-event
    // assertions above but break the client's UI state machine.
    const indexOf = (predicate: (e: { type: string; run?: number }) => boolean) =>
      events.findIndex(predicate);
    const idxRun1 = indexOf((e) => e.type === 'run_done' && e.run === 1);
    const idxFail2 = indexOf((e) => e.type === 'run_failed' && e.run === 2);
    const idxDone = indexOf((e) => e.type === 'done');
    expect(idxRun1).toBeGreaterThan(-1);
    expect(idxFail2).toBeGreaterThan(idxRun1);
    expect(idxDone).toBeGreaterThan(idxFail2);

    // Persisted history should contain exactly one run (the one that
    // completed) carrying `batchAttempted: 3` so any consumer reloading
    // the group can derive partial-ness.
    const histRes = await app.request('/api/evals/history');
    const histBody = await readJson(histRes);
    const partialEntries = histBody.data.filter(
      (e: { eval: string }) => e.eval === 'partial-stream-eval',
    );
    expect(partialEntries.length).toBe(1);
    expect(partialEntries[0].data.metadata.batchAttempted).toBe(3);
    expect(partialEntries[0].data.metadata.runIndex).toBe(0);
    expect(partialEntries[0].data.metadata.runGroupId).toBeDefined();
  });

  it('POST /api/evals/runs/:evalRunId/cancel returns 404 for unknown run', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/runs/nonexistent/cancel', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('POST /api/evals/runs/:evalRunId/cancel is blocked in readOnly mode', async () => {
    const { app } = createTestServer(undefined, { readOnly: true });

    const res = await app.request('/api/evals/runs/any-id/cancel', { method: 'POST' });
    expect(res.status).toBe(405);
    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('READ_ONLY');
  });

  it('POST /api/evals/runs/:evalRunId/cancel stops an active streaming run', async () => {
    // Use a slow provider so we can cancel mid-flight
    let resolveCall: (() => void) | null = null;
    const provider = MockProvider.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveCall = resolve;
      });
      return { content: 'should not reach' };
    });
    const { app } = createTestServer(provider);

    // Start streaming eval
    const res = await app.request('/api/evals/test-eval/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });
    expect(res.status).toBe(200);
    const evalRunId = (await readJson(res)).data.evalRunId;

    // Cancel while the eval is still running (provider is blocked)
    const cancelRes = await app.request(`/api/evals/runs/${evalRunId}/cancel`, {
      method: 'POST',
    });
    expect(cancelRes.status).toBe(200);
    const cancelBody = await readJson(cancelRes);
    expect(cancelBody.ok).toBe(true);
    expect((cancelBody as any).data.cancelled).toBe(true);

    // Unblock the provider so the async IIFE can complete.
    // Cast: TS's CFA narrows `resolveCall` to `null` because the assignment
    // happens in a closure that hasn't run from CFA's point of view; at
    // runtime the provider has executed and assigned `resolveCall` before
    // the cancel REST call returns.
    (resolveCall as null | (() => void))?.();

    // Second cancel should 404 — the run was already cleaned up
    const cancelRes2 = await app.request(`/api/evals/runs/${evalRunId}/cancel`, {
      method: 'POST',
    });
    expect(cancelRes2.status).toBe(404);
  });

  it('POST /api/evals/:name/run without stream remains synchronous', async () => {
    const provider = MockProvider.sequence([{ content: 'sync output' }]);
    const { app } = createTestServer(provider);

    const res = await app.request('/api/evals/test-eval/run', {
      method: 'POST',
    });
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    // Synchronous mode returns the full result, not an evalRunId
    expect(body.data.evalRunId).toBeUndefined();
    expect(body.data.items).toBeDefined();
    expect(body.data.summary).toBeDefined();
  });

  it('POST /api/evals/import round-trip preserves multi-run artifact shape', async () => {
    // CLI --runs N writes a single file enriched with _multiRun. Importing
    // such a file should round-trip the _multiRun field and still render
    // correctly as a history entry.
    const { app } = createTestServer();

    const singleRun = {
      workflow: 'wf',
      dataset: 'ds',
      metadata: {},
      timestamp: new Date().toISOString(),
      totalCost: 0,
      duration: 0,
      items: [{ input: 'in', output: 'out', scores: { 'always-pass': 1 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: { 'always-pass': { mean: 1, min: 1, max: 1, p50: 1, p95: 1 } },
      },
    };
    const withMultiRun = {
      ...singleRun,
      _multiRun: {
        aggregate: {
          runGroupId: 'group-123',
          runCount: 3,
          scorers: { 'always-pass': { mean: 1, std: 0, min: 1, max: 1 } },
        },
        allRuns: [singleRun, singleRun, singleRun],
      },
    };

    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: withMultiRun }),
    });
    expect(res.status).toBe(200);

    const histRes = await app.request('/api/evals/history');
    const histBody = await readJson(histRes);
    const id = (await readJson(res)).data.id;
    const entry = histBody.data.find((e: { id: string }) => e.id === id);
    expect(entry.data._multiRun).toBeDefined();
    expect(entry.data._multiRun.allRuns.length).toBe(3);
  });
});
