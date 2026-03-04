import { describe, it, expect } from 'vitest';
import { createTestServer } from '../helpers/setup.js';

describe('Studio API: Agents', () => {
  it('GET /api/agents lists registered agents', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/agents');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0].name).toBe('test-agent');
    expect(body.data[0].model).toBe('mock:test');
  });

  it('GET /api/agents/nonexistent returns 404', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/agents/nonexistent');
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
