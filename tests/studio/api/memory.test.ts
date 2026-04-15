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

  it('GET /api/memory scrubs values when trace.redact is on (keys preserved)', async () => {
    const { app } = createTestServer(undefined, { redact: true });

    // Write raw values via PUT — redact is an observability-boundary filter,
    // write endpoints accept raw data so the user can still populate memory
    // under compliance mode.
    await app.request('/api/memory/global/user_profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { ssn: '123-45-6789' } }),
    });
    await app.request('/api/memory/global/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { theme: 'dark' } }),
    });

    // Detail: value scrubbed, key preserved.
    const detailRes = await app.request('/api/memory/global/user_profile');
    const detailBody = await detailRes.json();
    expect(detailBody.ok).toBe(true);
    expect(detailBody.data.key).toBe('user_profile');
    expect(detailBody.data.value).toBe('[redacted]');

    // List: every value scrubbed, keys preserved for navigation.
    const listRes = await app.request('/api/memory/global');
    const listBody = await listRes.json();
    expect(listBody.ok).toBe(true);
    const entries = listBody.data as Array<{ key: string; value: unknown }>;
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of entries) {
      expect(entry.value).toBe('[redacted]');
      expect(typeof entry.key).toBe('string');
      expect(entry.key).not.toBe('[redacted]');
    }
  });
});
