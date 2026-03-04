import { describe, it, expect } from 'vitest';
import { MockProvider } from '@axlsdk/testing';
import { createTestServer } from '../helpers/setup.js';

describe('Studio API: Executions', () => {
  it('GET /api/executions is empty, then populated after workflow execution', async () => {
    const provider = MockProvider.sequence([{ content: 'done' }]);
    const { app } = createTestServer(provider);

    // Initially empty
    const res1 = await app.request('/api/executions');
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
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
    const body2 = await res2.json();
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
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.aborted).toBe(true);
  });
});
