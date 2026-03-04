import { describe, it, expect } from 'vitest';
import { createTestServer } from '../helpers/setup.js';

describe('Studio API: Memory', () => {
  it('PUT /api/memory/:scope/:key saves a memory entry', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/memory/global/key1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'test-value' }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.saved).toBe(true);
  });

  it('GET /api/memory/:scope/:key retrieves saved entry', async () => {
    const { app } = createTestServer();

    // Save first
    await app.request('/api/memory/global/key1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'saved-data' }),
    });

    // Retrieve
    const res = await app.request('/api/memory/global/key1');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.key).toBe('key1');
    expect(body.data.value).toBe('saved-data');
  });

  it('DELETE /api/memory/:scope/:key deletes entry', async () => {
    const { app } = createTestServer();

    // Save first
    await app.request('/api/memory/global/delkey', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'to-delete' }),
    });

    // Delete
    const res = await app.request('/api/memory/global/delkey', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);

    // Verify subsequent GET returns 404
    const getRes = await app.request('/api/memory/global/delkey');
    expect(getRes.status).toBe(404);
    const getBody = await getRes.json();
    expect(getBody.ok).toBe(false);
    expect(getBody.error.code).toBe('NOT_FOUND');
  });
});
