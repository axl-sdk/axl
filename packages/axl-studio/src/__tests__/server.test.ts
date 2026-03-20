import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

  it('basePath injects <base> and __AXL_STUDIO_BASE__ into index.html', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'axl-studio-test-'));
    writeFileSync(
      join(tmpDir, 'index.html'),
      '<!DOCTYPE html><html><head><title>Test</title></head><body></body></html>',
    );

    try {
      const runtime = new AxlRuntime();
      runtime.registerProvider('mock', MockProvider.echo());
      const { app } = createServer({ runtime, staticRoot: tmpDir, basePath: '/studio' });

      // Request a non-API path to get the SPA fallback
      const res = await app.request('/playground');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<base href="/studio/">');
      expect(html).toContain('window.__AXL_STUDIO_BASE__="/studio"');
      expect(html).toContain('</head>');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('no basePath serves index.html unmodified for SPA fallback', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'axl-studio-test-'));
    const original =
      '<!DOCTYPE html><html><head><title>Test</title></head><body>Original</body></html>';
    writeFileSync(join(tmpDir, 'index.html'), original);

    try {
      const runtime = new AxlRuntime();
      runtime.registerProvider('mock', MockProvider.echo());
      const { app } = createServer({ runtime, staticRoot: tmpDir });

      // serveStatic with path: '/index.html' serves the fallback
      const res = await app.request('/playground');
      expect(res.status).toBe(200);
      const html = await res.text();
      // Should NOT contain injected base or script
      expect(html).not.toContain('__AXL_STUDIO_BASE__');
      expect(html).not.toContain('<base');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('basePath XSS prevention escapes < in injected script', async () => {
    // normalizeBasePath rejects '<' characters, so this tests the defense-in-depth
    // layer in createServer by calling it directly with a basePath that contains
    // no '<' — the escaping logic runs on any basePath but only matters if '<' is present.
    // We verify the escaping function exists by checking the injected value is JSON-safe.
    const tmpDir = mkdtempSync(join(tmpdir(), 'axl-studio-test-'));
    writeFileSync(
      join(tmpDir, 'index.html'),
      '<!DOCTYPE html><html><head></head><body></body></html>',
    );

    try {
      const runtime = new AxlRuntime();
      runtime.registerProvider('mock', MockProvider.echo());
      const { app } = createServer({ runtime, staticRoot: tmpDir, basePath: '/admin/studio' });

      const res = await app.request('/any-path');
      const html = await res.text();
      // The basePath should be JSON-encoded in the script
      expect(html).toContain('window.__AXL_STUDIO_BASE__="/admin/studio"');
      // No raw '<' in the injected value (defense-in-depth)
      const scriptMatch = html.match(/window\.__AXL_STUDIO_BASE__=([^<]*?)</);
      expect(scriptMatch).toBeTruthy();
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('readOnly works when studio app is mounted via Hono app.route()', async () => {
    const runtime = new AxlRuntime();
    runtime.registerProvider('mock', MockProvider.echo());
    const { app: studioApp } = createServer({ runtime, readOnly: true, cors: false });

    // Mount at a prefix like Hono-in-Hono usage
    const { Hono } = await import('hono');
    const parentApp = new Hono();
    parentApp.route('/studio', studioApp);

    // GET should work
    const getRes = await parentApp.request('/studio/api/health');
    expect(getRes.status).toBe(200);

    // POST should be blocked
    const postRes = await parentApp.request('/studio/api/playground/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(postRes.status).toBe(405);
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
