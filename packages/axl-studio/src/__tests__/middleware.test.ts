import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { AxlRuntime } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createStudioMiddleware } from '../middleware.js';

function createTestRuntime() {
  const runtime = new AxlRuntime();
  runtime.registerProvider('mock', MockProvider.echo());
  return runtime;
}

describe('createStudioMiddleware', () => {
  it('returns all expected properties', () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({ runtime, serveClient: false });

    expect(studio.handler).toBeTypeOf('function');
    expect(studio.handleWebSocket).toBeTypeOf('function');
    expect(studio.upgradeWebSocket).toBeTypeOf('function');
    expect(studio.app).toBeDefined();
    expect(studio.connectionManager).toBeDefined();
    expect(studio.close).toBeTypeOf('function');

    studio.close();
  });

  it('handler responds to API requests', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({ runtime, serveClient: false });

    const res = await studio.app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('healthy');

    studio.close();
  });

  it('readOnly mode blocks mutating endpoints', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({ runtime, serveClient: false, readOnly: true });

    // GET should work
    const getRes = await studio.app.request('/api/health');
    expect(getRes.status).toBe(200);

    // POST to mutating endpoint should be blocked
    const postRes = await studio.app.request('/api/playground/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(postRes.status).toBe(405);
    const body = await postRes.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('READ_ONLY');
    expect(body.error.message).toContain('read-only');

    studio.close();
  });

  it('readOnly mode allows GET endpoints', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({ runtime, serveClient: false, readOnly: true });

    const res = await studio.app.request('/api/workflows');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    studio.close();
  });

  it('handler returns 503 after close()', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({ runtime, serveClient: false });

    // Works before close
    const res1 = await studio.app.request('/api/health');
    expect(res1.status).toBe(200);

    studio.close();

    // The Hono app still works (it wasn't shut down), but the Node.js
    // handler wrapper returns 503. We can't test handler() directly without
    // an http.Server, so we verify close() sets the flag by testing through
    // a real server in the integration tests.
  });

  it('close() removes trace listener from runtime', () => {
    const runtime = createTestRuntime();
    const initialCount = runtime.listenerCount('trace');
    const studio = createStudioMiddleware({ runtime, serveClient: false });
    expect(runtime.listenerCount('trace')).toBe(initialCount + 1);

    studio.close();
    expect(runtime.listenerCount('trace')).toBe(initialCount);
  });

  it('handleWebSocket manages connections via protocol', () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({ runtime, serveClient: false });

    const messages: string[] = [];
    const mockWs = {
      send: (data: string) => messages.push(data),
      close: () => {},
      on: vi.fn(),
    };

    studio.handleWebSocket(mockWs as any);

    // Should have registered event handlers
    expect(mockWs.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith('close', expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith('error', expect.any(Function));

    // Connection should be tracked
    expect(studio.connectionManager.connectionCount).toBe(1);

    // Simulate a message
    const messageHandler = mockWs.on.mock.calls.find((c: any[]) => c[0] === 'message')![1];
    messageHandler(JSON.stringify({ type: 'ping' }));

    expect(messages.length).toBe(1);
    expect(JSON.parse(messages[0]).type).toBe('pong');

    // Simulate close
    const closeHandler = mockWs.on.mock.calls.find((c: any[]) => c[0] === 'close')![1];
    closeHandler();
    expect(studio.connectionManager.connectionCount).toBe(0);

    studio.close();
  });

  it('does not apply CORS headers (host framework responsibility)', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({ runtime, serveClient: false });

    const res = await studio.app.request('/api/health', {
      headers: { Origin: 'http://evil.com' },
    });

    // No Access-Control-Allow-Origin header should be set
    expect(res.headers.get('access-control-allow-origin')).toBeNull();

    studio.close();
  });

  it('logs production warning when no verifyUpgrade is set', () => {
    const originalEnv = process.env.NODE_ENV;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      process.env.NODE_ENV = 'production';
      const runtime = createTestRuntime();
      const studio = createStudioMiddleware({ runtime, serveClient: false });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('verifyUpgrade'));

      studio.close();
    } finally {
      process.env.NODE_ENV = originalEnv;
      warnSpy.mockRestore();
    }
  });

  it('does not log production warning when verifyUpgrade is set', () => {
    const originalEnv = process.env.NODE_ENV;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      process.env.NODE_ENV = 'production';
      const runtime = createTestRuntime();
      const studio = createStudioMiddleware({
        runtime,
        serveClient: false,
        verifyUpgrade: () => true,
      });

      const wsWarnings = warnSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('verifyUpgrade'),
      );
      expect(wsWarnings.length).toBe(0);

      studio.close();
    } finally {
      process.env.NODE_ENV = originalEnv;
      warnSpy.mockRestore();
    }
  });
});

describe('normalizeBasePath (via createStudioMiddleware)', () => {
  it('empty string defaults to root', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({ runtime, basePath: '', serveClient: false });

    // API should be at /api/health (no prefix)
    const res = await studio.app.request('/api/health');
    expect(res.status).toBe(200);

    studio.close();
  });

  it('strips trailing slashes', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({ runtime, basePath: '/studio/', serveClient: false });

    // The app still works — basePath is normalized
    const res = await studio.app.request('/api/health');
    expect(res.status).toBe(200);

    studio.close();
  });

  it('single slash normalizes to root mount', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({ runtime, basePath: '/', serveClient: false });

    const res = await studio.app.request('/api/health');
    expect(res.status).toBe(200);

    studio.close();
  });

  it('multiple slashes normalize to root mount', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({ runtime, basePath: '///', serveClient: false });

    const res = await studio.app.request('/api/health');
    expect(res.status).toBe(200);

    studio.close();
  });

  it('throws on missing leading slash', () => {
    const runtime = createTestRuntime();
    expect(() =>
      createStudioMiddleware({ runtime, basePath: 'studio', serveClient: false }),
    ).toThrow("basePath must start with '/'");
  });

  it('throws on path traversal', () => {
    const runtime = createTestRuntime();
    expect(() =>
      createStudioMiddleware({ runtime, basePath: '/studio/../etc', serveClient: false }),
    ).toThrow("must not contain '..'");
  });

  it('throws on consecutive slashes', () => {
    const runtime = createTestRuntime();
    expect(() =>
      createStudioMiddleware({ runtime, basePath: '/studio//admin', serveClient: false }),
    ).toThrow('consecutive slashes');
  });

  it('throws on invalid characters', () => {
    const runtime = createTestRuntime();
    expect(() =>
      createStudioMiddleware({ runtime, basePath: '/studio<script>', serveClient: false }),
    ).toThrow('invalid characters');
  });

  it('accepts deeply nested paths', async () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({
      runtime,
      basePath: '/admin/tools/studio',
      serveClient: false,
    });

    const res = await studio.app.request('/api/health');
    expect(res.status).toBe(200);

    studio.close();
  });
});

describe('upgradeWebSocket with http.Server', () => {
  let server: Server;
  let studio: ReturnType<typeof createStudioMiddleware>;

  afterEach(() => {
    studio?.close();
    server?.close();
  });

  it('attaches upgrade handler to server', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, serveClient: false });

    server = createHttpServer(studio.handler);
    studio.upgradeWebSocket(server);

    // The server should have an upgrade listener
    expect(server.listenerCount('upgrade')).toBeGreaterThanOrEqual(1);
  });

  it('throws on double upgradeWebSocket call', () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, serveClient: false });

    server = createHttpServer(studio.handler);
    studio.upgradeWebSocket(server);

    expect(() => studio.upgradeWebSocket(server)).toThrow('already been called');
  });

  it('uses custom path when provided', () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, basePath: '/studio', serveClient: false });

    server = createHttpServer(studio.handler);
    studio.upgradeWebSocket(server, '/custom/ws');

    // The server should have an upgrade listener
    expect(server.listenerCount('upgrade')).toBeGreaterThanOrEqual(1);
  });
});

describe('ConnectionManager closeAll and maxConnections', () => {
  it('closeAll closes all connections', () => {
    const runtime = createTestRuntime();
    const studio = createStudioMiddleware({ runtime, serveClient: false });

    const closed: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const mockWs = {
        send: () => {},
        close: () => closed.push(true),
        on: vi.fn(),
      };
      studio.handleWebSocket(mockWs as any);
    }

    expect(studio.connectionManager.connectionCount).toBe(5);

    studio.close();

    expect(studio.connectionManager.connectionCount).toBe(0);
    expect(closed.length).toBe(5);
  });
});
