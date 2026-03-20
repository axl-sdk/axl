import { describe, it, expect } from 'vitest';
import { AxlRuntime } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createServer } from '../server/index.js';

function createTestApp() {
  const runtime = new AxlRuntime();
  const provider = MockProvider.echo();
  runtime.registerProvider('mock', provider);
  return createServer({ runtime });
}

describe('Studio Server', () => {
  it('createServer returns app, connMgr, costAggregator, createWsHandlers, traceListener', () => {
    const result = createTestApp();
    expect(result.app).toBeDefined();
    expect(result.connMgr).toBeDefined();
    expect(result.costAggregator).toBeDefined();
    expect(result.createWsHandlers).toBeTypeOf('function');
    expect(result.traceListener).toBeTypeOf('function');
  });

  it('GET /api/health returns 200 with healthy status', async () => {
    const { app } = createTestApp();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('healthy');
  });

  it('GET /api/workflows returns 200 with empty list', async () => {
    const { app } = createTestApp();
    const res = await app.request('/api/workflows');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it('GET /api/agents returns 200 with empty list', async () => {
    const { app } = createTestApp();
    const res = await app.request('/api/agents');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it('GET /api/tools returns 200 with empty list', async () => {
    const { app } = createTestApp();
    const res = await app.request('/api/tools');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it('readOnly blocks mutating POST endpoints', async () => {
    const runtime = new AxlRuntime();
    runtime.registerProvider('mock', MockProvider.echo());
    const { app } = createServer({ runtime, readOnly: true });

    const res = await app.request('/api/playground/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toContain('read-only');
  });

  it('readOnly allows GET endpoints', async () => {
    const runtime = new AxlRuntime();
    runtime.registerProvider('mock', MockProvider.echo());
    const { app } = createServer({ runtime, readOnly: true });

    const res = await app.request('/api/workflows');
    expect(res.status).toBe(200);
  });

  it('cors: false disables CORS headers', async () => {
    const runtime = new AxlRuntime();
    runtime.registerProvider('mock', MockProvider.echo());
    const { app } = createServer({ runtime, cors: false });

    const res = await app.request('/api/health', {
      headers: { Origin: 'http://example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('error handler converts errors to JSON error response', async () => {
    const runtime = new AxlRuntime();
    runtime.registerProvider('mock', MockProvider.echo());
    const { app } = createServer({ runtime });

    // Request a nonexistent workflow detail
    const res = await app.request('/api/workflows/nonexistent');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBeDefined();
    expect(body.error.message).toBeDefined();
  });
});
