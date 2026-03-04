import { describe, it, expect } from 'vitest';
import { createTestServer } from '../helpers/setup.js';

describe('Studio API: Decisions', () => {
  it('GET /api/decisions returns empty list initially', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/decisions');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it('POST /api/decisions/:executionId/resolve returns resolved confirmation', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/decisions/exec-123/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true, reason: 'Looks good' }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.resolved).toBe(true);
  });
});
