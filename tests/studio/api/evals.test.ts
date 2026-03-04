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
    expect(body.data.items.length).toBe(1);
    expect(body.data.items[0].output).toBe('eval output');
    expect(body.data.items[0].scores['always-pass']).toBe(1);
    expect(body.data.summary.scorers['always-pass'].mean).toBe(1);
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
});
