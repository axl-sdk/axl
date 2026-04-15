import { describe, it, expect } from 'vitest';
import { MockProvider } from '@axlsdk/testing';
import { createTestServer } from '../helpers/setup.js';

describe('Studio API: Workflows', () => {
  it('GET /api/workflows lists registered workflows', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/workflows');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.length).toBe(2); // test-wf + chat-wf
    const names = body.data.map((w: { name: string }) => w.name);
    expect(names).toContain('test-wf');
    expect(names).toContain('chat-wf');
  });

  it('GET /api/workflows/:name returns workflow detail', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/workflows/test-wf');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('test-wf');
    expect(body.data.inputSchema).toBeDefined();
  });

  it('GET /api/workflows/nonexistent returns 404', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/workflows/nonexistent');
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('POST /api/workflows/:name/execute returns result', async () => {
    const provider = MockProvider.sequence([{ content: 'executed result' }]);
    const { app } = createTestServer(provider);

    const res = await app.request('/api/workflows/test-wf/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { message: 'hello' } }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.result).toBe('executed result');
  });

  it('POST /api/workflows/:name/execute scrubs result when trace.redact is on', async () => {
    const provider = MockProvider.sequence([{ content: 'sensitive workflow result' }]);
    const { app } = createTestServer(provider, { redact: true });

    const res = await app.request('/api/workflows/test-wf/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { message: 'hello' } }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Synchronous execute result is scrubbed at the REST boundary
    // regardless of whether the workflow's trace events were redacted.
    expect(body.data.result).toBe('[redacted]');
  });
});
