import { describe, it, expect } from 'vitest';
import { createTestServer } from '../helpers/setup.js';
import { readJson } from '../helpers/json.js';

describe('Studio API: Costs', () => {
  it('GET /api/costs returns cost data with zero totals (default window: 7d)', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/costs');
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.totalCost).toBe(0);
    expect(body.data.totalTokens).toBeDefined();
    expect(body.data.totalTokens.input).toBe(0);
    expect(body.data.totalTokens.output).toBe(0);
  });

  it('GET /api/costs?window=all returns the all-time snapshot', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/costs?window=all');
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.totalCost).toBe(0);
  });

  it('GET /api/costs?windows=all returns all window snapshots', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/costs?windows=all');
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    // Should have all four windows
    expect(body.data['24h']).toBeDefined();
    expect(body.data['7d']).toBeDefined();
    expect(body.data['30d']).toBeDefined();
    expect(body.data['all']).toBeDefined();
  });

  it('GET /api/costs?window=invalid falls back to 7d', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/costs?window=invalid');
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.totalCost).toBe(0);
  });

  it('POST /api/costs/reset returns 410 Gone with migration hint (removed)', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/costs/reset', { method: 'POST' });
    expect(res.status).toBe(410);
    const body = await readJson(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('GONE');
    expect(body.error.message).toMatch(/window=/);
  });
});
