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
    expect(data).toHaveProperty('workflow');
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
    expect(agg.workflow).toBe('test-wf');
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

  // --- Compare endpoint ---

  it('POST /api/evals/compare compares two eval results', async () => {
    // Run two evals to get results for comparison
    const provider = MockProvider.sequence([
      { content: 'baseline output' },
      { content: 'candidate output' },
    ]);
    const { app } = createTestServer(provider);

    const baselineRes = await app.request('/api/evals/test-eval/run', { method: 'POST' });
    expect(baselineRes.status).toBe(200);
    const baseline = (await baselineRes.json()).data;

    const candidateRes = await app.request('/api/evals/test-eval/run', { method: 'POST' });
    expect(candidateRes.status).toBe(200);
    const candidate = (await candidateRes.json()).data;

    const compareRes = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseline, candidate }),
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

    const baselineRes = await app.request('/api/evals/test-eval/run', { method: 'POST' });
    const baseline = (await baselineRes.json()).data;

    const candidateRes = await app.request('/api/evals/test-eval/run', { method: 'POST' });
    const candidate = (await candidateRes.json()).data;

    const compareRes = await app.request('/api/evals/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseline,
        candidate,
        options: { thresholds: { 'always-pass': 0.1 } },
      }),
    });
    expect(compareRes.status).toBe(200);

    const body = await compareRes.json();
    expect(body.ok).toBe(true);
    expect(body.data.scorers['always-pass']).toBeDefined();
    // With 1-item dataset, not enough paired data for bootstrap CI,
    // so significant is undefined. Verify the core comparison fields exist.
    expect(typeof body.data.scorers['always-pass'].baselineMean).toBe('number');
    expect(typeof body.data.scorers['always-pass'].delta).toBe('number');
  });
});
