import { describe, it, expect } from 'vitest';
import { createTestServer } from '../helpers/setup.js';

describe('Studio API: Health', () => {
  it('GET /api/health returns healthy status with counts', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('healthy');
    expect(body.data.readOnly).toBe(false);
    expect(body.data.workflows).toBe(2); // test-wf + chat-wf
    expect(body.data.agents).toBe(1);
    expect(body.data.tools).toBe(1);
  });

  it('GET /api/health reports readOnly: true when mounted in read-only mode', async () => {
    const { app } = createTestServer(undefined, { readOnly: true });
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.readOnly).toBe(true);
  });
});
