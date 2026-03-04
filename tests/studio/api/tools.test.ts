import { describe, it, expect } from 'vitest';
import { createTestServer } from '../helpers/setup.js';

describe('Studio API: Tools', () => {
  it('GET /api/tools lists registered tools with schema', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/tools');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0].name).toBe('greet');
    expect(body.data[0].description).toBe('Greet someone by name');
    expect(body.data[0].inputSchema).toBeDefined();
  });

  it('POST /api/tools/greet/test executes the tool and returns result', async () => {
    const { app } = createTestServer();

    const res = await app.request('/api/tools/greet/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { name: 'World' } }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.result).toBe('Hello, World!');
  });

  it('GET /api/tools/nonexistent returns 404', async () => {
    const { app } = createTestServer();
    const res = await app.request('/api/tools/nonexistent');
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
