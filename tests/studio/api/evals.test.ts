import { describe, it, expect } from 'vitest';
import { MockProvider } from '@axlsdk/testing';
import { createTestServer } from '../helpers/setup.js';

describe('Studio API: Evals', () => {
  it('GET /api/evals lists registered eval configs', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/evals');
    expect(res.status).toBe(200);

    const body = await res.json();
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

    const body = await res.json();
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

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET /api/evals/history returns empty initially', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/evals/history');
    expect(res.status).toBe(200);

    const body = await res.json();
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
    const body = await res.json();
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
    const body = await res.json();
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

    const body = await histRes.json();
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
    const runBody = await runRes.json();
    const resultId = runBody.data.id;

    // Rescore that result
    const rescoreRes = await app.request('/api/evals/test-eval/rescore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultId }),
    });
    expect(rescoreRes.status).toBe(200);

    const body = await rescoreRes.json();
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

    const body = await res.json();
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

    const body = await res.json();
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

    const body = await res.json();
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

    const body = (await res.json()) as any;
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

    const body = (await res.json()) as any;
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

    const body = (await res.json()) as any;
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

    const body = (await res.json()) as any;
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

    const body = (await res.json()) as any;
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
    const baselineId = (await baselineRes.json()).data.id;

    const candidateRes = await app.request('/api/evals/test-eval/run', { method: 'POST' });
    expect(candidateRes.status).toBe(200);
    const candidateId = (await candidateRes.json()).data.id;

    const compareRes = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId, candidateId }),
    });
    expect(compareRes.status).toBe(200);

    const body = await compareRes.json();
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
      await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json()
    ).data.id;
    const candidateId = (
      await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json()
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

    const body = await compareRes.json();
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
    const b1 = (await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json())
      .data.id;
    const b2 = (await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json())
      .data.id;
    const c1 = (await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json())
      .data.id;
    const c2 = (await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json())
      .data.id;

    const compareRes = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId: [b1, b2], candidateId: [c1, c2] }),
    });
    expect(compareRes.status).toBe(200);

    const body = await compareRes.json();
    expect(body.ok).toBe(true);
    expect(body.data.scorers['always-pass']).toBeDefined();
  });

  it('POST /api/evals/compare returns 404 with the missing ID listed', async () => {
    const provider = MockProvider.sequence([{ content: 'baseline output' }]);
    const { app } = createTestServer(provider);

    const baselineId = (
      await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json()
    ).data.id;

    const res = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId, candidateId: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);

    const body = await res.json();
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

    const body = await res.json();
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

    const body = await res.json();
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

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.data.id).toBe('string');
    expect(body.data.id).not.toBe('original-cli-id'); // Fresh UUID
    expect(body.data.eval).toBe('imported-wf'); // Falls back to workflow name
    expect(typeof body.data.timestamp).toBe('number');

    // History contains the imported entry under the new ID
    const histRes = await app.request('/api/evals/history');
    const histBody = await histRes.json();
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

    const body = await res.json();
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
    expect((await res.json()).data.eval).toBe('my-custom-name');
  });

  it('POST /api/evals/import then compare round-trip works end-to-end', async () => {
    const provider = MockProvider.sequence([{ content: 'native run' }]);
    const { app } = createTestServer(provider);

    // Run a native eval to use as the baseline.
    const nativeId = (
      await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json()
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
    const importedId = (await importRes.json()).data.id;

    const compareRes = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId: nativeId, candidateId: importedId }),
    });
    expect(compareRes.status).toBe(200);

    const body = await compareRes.json();
    expect(body.ok).toBe(true);
    expect(body.data.scorers['always-pass']).toBeDefined();
  });

  it('POST /api/evals/import returns 400 for invalid shape', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: { not: 'an eval result' } }),
    });
    expect(res.status).toBe(400);

    const body = await res.json();
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

    const body = await res.json();
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
    const body = await res.json();
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

    const body = await res.json();
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

    const body = await res.json();
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

    const b1 = (await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json())
      .data.id;
    const c1 = (await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json())
      .data.id;
    const c2 = (await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json())
      .data.id;

    const res = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId: b1, candidateId: [c1, c2] }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.scorers['always-pass']).toBeDefined();
  });

  it('POST /api/evals/compare dedupes duplicate IDs in a pooled group', async () => {
    // Duplicates in a group would artificially shrink the paired-bootstrap
    // variance — the server dedupes via Set before resolving.
    const provider = MockProvider.sequence([{ content: 'b1' }, { content: 'c1' }]);
    const { app } = createTestServer(provider);

    const b1 = (await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json())
      .data.id;
    const c1 = (await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json())
      .data.id;

    const res = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId: [b1, b1, b1], candidateId: [c1, c1] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('POST /api/evals/compare uses COMPARE_FAILED code when evalCompare throws', async () => {
    // Baseline and candidate from different datasets — evalCompare throws,
    // the route should surface it as a structured error (not EVAL_ERROR).
    const provider = MockProvider.sequence([{ content: 'out' }]);
    const { app } = createTestServer(provider);

    const baselineId = (
      await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json()
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
    const candidateId = (await importRes.json()).data.id;

    const res = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baselineId, candidateId }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
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
    const body = await res.json();
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
    const body = await res.json();
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
    const body = await res.json();
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
    const body = await res.json();
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
    const body = await res.json();
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
    const histBody = await histRes.json();
    const id = (await res.json()).data.id;
    const entry = histBody.data.find((e: { id: string }) => e.id === id);
    expect(entry.data.metadata).toEqual({});
  });

  // --- Delete endpoint ---

  it('DELETE /api/evals/history/:id removes an entry from history', async () => {
    const provider = MockProvider.sequence([{ content: 'eval output' }]);
    const { app } = createTestServer(provider);

    // Run an eval to populate history.
    const runRes = await app.request('/api/evals/test-eval/run', { method: 'POST' });
    const id = (await runRes.json()).data.id;

    // Confirm it's in history first.
    const histBefore = await (await app.request('/api/evals/history')).json();
    expect(histBefore.data.find((e: { id: string }) => e.id === id)).toBeDefined();

    // Delete.
    const delRes = await app.request(`/api/evals/history/${id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.ok).toBe(true);
    expect(delBody.data).toEqual({ id, deleted: true });

    // Confirm it's gone.
    const histAfter = await (await app.request('/api/evals/history')).json();
    expect(histAfter.data.find((e: { id: string }) => e.id === id)).toBeUndefined();
  });

  it('DELETE /api/evals/history/:id returns 404 for unknown id', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/history/does-not-exist', { method: 'DELETE' });
    expect(res.status).toBe(404);

    const body = await res.json();
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
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('READ_ONLY');
  });

  it('DELETE /api/evals/history/:id then compare with that ID returns 404', async () => {
    // End-to-end: deleted entries should disappear from compare's resolution path.
    const provider = MockProvider.sequence([{ content: 'a' }, { content: 'b' }]);
    const { app } = createTestServer(provider);

    const baselineId = (
      await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json()
    ).data.id;
    const candidateId = (
      await (await app.request('/api/evals/test-eval/run', { method: 'POST' })).json()
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
    const body = await res.json();
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

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.evalRunId).toBeDefined();
    expect(typeof body.data.evalRunId).toBe('string');
    expect(body.data.evalRunId.startsWith('eval-')).toBe(true);

    // Give the async eval a moment to complete so history gets populated
    await new Promise((resolve) => setTimeout(resolve, 100));
    const histRes = await app.request('/api/evals/history');
    const histBody = await histRes.json();
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
    expect((await res.json()).data.evalRunId).toBeDefined();

    // Wait for async completion
    await new Promise((resolve) => setTimeout(resolve, 200));
    const histRes = await app.request('/api/evals/history');
    const histBody = await histRes.json();
    // Multi-run produces N individual entries (each run saved separately)
    expect(histBody.data.length).toBe(3);
  });

  it('POST /api/evals/runs/:evalRunId/cancel returns 404 for unknown run', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/evals/runs/nonexistent/cancel', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('POST /api/evals/runs/:evalRunId/cancel is blocked in readOnly mode', async () => {
    const { app } = createTestServer(undefined, { readOnly: true });

    const res = await app.request('/api/evals/runs/any-id/cancel', { method: 'POST' });
    expect(res.status).toBe(405);
    const body = await res.json();
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
    const evalRunId = ((await res.json()) as any).data.evalRunId;

    // Cancel while the eval is still running (provider is blocked)
    const cancelRes = await app.request(`/api/evals/runs/${evalRunId}/cancel`, {
      method: 'POST',
    });
    expect(cancelRes.status).toBe(200);
    const cancelBody = await cancelRes.json();
    expect(cancelBody.ok).toBe(true);
    expect((cancelBody as any).data.cancelled).toBe(true);

    // Unblock the provider so the async IIFE can complete
    resolveCall?.();

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

    const body = await res.json();
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
    const histBody = await histRes.json();
    const id = (await res.json()).data.id;
    const entry = histBody.data.find((e: { id: string }) => e.id === id);
    expect(entry.data._multiRun).toBeDefined();
    expect(entry.data._multiRun.allRuns.length).toBe(3);
  });
});
