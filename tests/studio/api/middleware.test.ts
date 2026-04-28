import { describe, it, expect, afterEach } from 'vitest';
import {
  createServer as createHttpServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { z } from 'zod';
import { AxlRuntime, tool, agent, workflow } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { dataset, scorer } from '@axlsdk/eval';
import { createStudioMiddleware } from '@axlsdk/studio/middleware';
import { WebSocket } from 'ws';
import { readJson } from '../helpers/json.js';

function createTestRuntime() {
  const runtime = new AxlRuntime();
  const provider = MockProvider.echo();
  runtime.registerProvider('mock', provider);

  const greetTool = tool({
    name: 'greet',
    description: 'Greet someone',
    input: z.object({ name: z.string() }),
    handler: (input) => `Hello, ${input.name}!`,
  });
  runtime.registerTool(greetTool);

  const testAgent = agent({
    name: 'test-agent',
    model: 'mock:test',
    system: 'You are helpful.',
    tools: [greetTool],
  });
  runtime.registerAgent(testAgent);

  const wf = workflow({
    name: 'test-wf',
    input: z.object({ message: z.string() }),
    handler: async (ctx) => ctx.ask(testAgent, ctx.input.message),
  });
  runtime.register(wf);

  return runtime;
}

/** Creates a runtime with eval support for multi-run tests. */
function createEvalRuntime(provider?: MockProvider) {
  const runtime = new AxlRuntime();
  const p = provider ?? MockProvider.echo();
  runtime.registerProvider('mock', p);

  const testAgent = agent({ name: 'eval-agent', model: 'mock:test', system: 'test' });
  runtime.registerAgent(testAgent);

  const wf = workflow({
    name: 'eval-wf',
    input: z.object({ q: z.string() }),
    handler: async (ctx) => ctx.ask(testAgent, ctx.input.q),
  });
  runtime.register(wf);

  const ds = dataset({
    name: 'test-ds',
    schema: z.object({ q: z.string() }),
    items: [{ input: { q: 'hello' } }],
  });
  const s = scorer({ name: 'pass', description: 'always 1', score: () => 1 });
  runtime.registerEval('test-eval', { workflow: 'eval-wf', dataset: ds, scorers: [s] });

  return runtime;
}

/**
 * Creates an http.Server that simulates Express/NestJS body-parser behavior:
 * reads and parses the request body, stores it on req.body, then forwards
 * to the given handler — leaving the raw stream consumed.
 */
function createBodyParserServer(
  studioHandler: (req: IncomingMessage, res: ServerResponse) => void,
): Server {
  return createHttpServer((req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      studioHandler(req, res);
      return;
    }
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk;
    });
    req.on('end', () => {
      if (data) {
        try {
          (req as any).body = JSON.parse(data);
        } catch {
          /* not JSON */
        }
      }
      studioHandler(req, res);
    });
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

describe('Studio Middleware Integration', () => {
  let server: Server;
  let studio: ReturnType<typeof createStudioMiddleware>;

  afterEach(async () => {
    studio?.close();
    if (server?.listening) {
      // closeAllConnections() forces all keepalive/upgrade sockets to close
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('serves API via Node.js handler at root', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, serveClient: false });

    // Test through Hono app directly
    const res = await studio.app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('healthy');
    expect(body.data.workflows).toBe(1);
    expect(body.data.agents).toBe(1);
    expect(body.data.tools).toBe(1);
  });

  it('handler responds to HTTP requests through http.Server', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, serveClient: false });

    server = createHttpServer(studio.handler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const res = await fetch(`http://localhost:${port}/api/health`);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('healthy');
  });

  it('serves API via Hono app with basePath', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, basePath: '/studio', serveClient: false });

    // API routes are still at /api/* relative to the app
    const res = await studio.app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
  });

  it('readOnly blocks POST endpoints, allows GET', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, serveClient: false, readOnly: true });

    // GET should work
    const getRes = await studio.app.request('/api/workflows');
    expect(getRes.status).toBe(200);

    // POST should be blocked
    const postRes = await studio.app.request('/api/tools/greet/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { name: 'World' } }),
    });
    expect(postRes.status).toBe(405);
  });

  it('readOnly blocks DELETE endpoints', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, serveClient: false, readOnly: true });

    const res = await studio.app.request('/api/sessions/test-session', {
      method: 'DELETE',
    });
    expect(res.status).toBe(405);
  });

  it('WebSocket connection via upgradeWebSocket', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, serveClient: false });

    server = createHttpServer(studio.handler);
    studio.upgradeWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await waitForOpen(ws);

    // Send ping
    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await waitForMessage(ws);
    expect(pong.type).toBe('pong');

    // Subscribe to a channel
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'costs' }));
    const subReply = await waitForMessage(ws);
    expect(subReply.type).toBe('subscribed');
    expect(subReply.channel).toBe('costs');

    ws.close();
  });

  it('WebSocket at basePath/ws', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, basePath: '/studio', serveClient: false });

    server = createHttpServer(studio.handler);
    studio.upgradeWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const ws = new WebSocket(`ws://localhost:${port}/studio/ws`);
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await waitForMessage(ws);
    expect(pong.type).toBe('pong');

    ws.close();
  });

  it('verifyUpgrade rejects unauthorized connections', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({
      runtime,
      serveClient: false,
      verifyUpgrade: (req) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        return url.searchParams.get('token') === 'secret123';
      },
    });

    server = createHttpServer(studio.handler);
    studio.upgradeWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    // Without token — should be rejected
    const ws1 = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => {
      ws1.on('error', () => resolve());
      ws1.on('close', () => resolve());
    });
    expect(ws1.readyState).not.toBe(WebSocket.OPEN);

    // With correct token — should succeed
    const ws2 = new WebSocket(`ws://localhost:${port}/ws?token=secret123`);
    await waitForOpen(ws2);
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    ws2.close();
  });

  it('verifyUpgrade rejects when callback throws', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({
      runtime,
      serveClient: false,
      verifyUpgrade: () => {
        throw new Error('auth failed');
      },
    });

    server = createHttpServer(studio.handler);
    studio.upgradeWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => {
      ws.on('error', () => resolve());
      ws.on('close', () => resolve());
    });
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });

  it('handler returns 503 after close()', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, serveClient: false });

    server = createHttpServer(studio.handler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    // Works before close
    const res1 = await fetch(`http://localhost:${port}/api/health`);
    expect(res1.status).toBe(200);

    studio.close();

    // Returns 503 after close
    const res2 = await fetch(`http://localhost:${port}/api/health`);
    expect(res2.status).toBe(503);
    const body = await readJson(res2);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('CLOSED');
  });

  it('close() shuts down WebSocket connections', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, serveClient: false });

    server = createHttpServer(studio.handler);
    studio.upgradeWebSocket(server);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await waitForOpen(ws);

    const closePromise = new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
    });

    studio.close();
    await closePromise;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('multiple middleware instances on different paths', async () => {
    const runtime1 = createTestRuntime();
    const runtime2 = createTestRuntime();
    const studio1 = createStudioMiddleware({
      runtime: runtime1,
      basePath: '/a',
      serveClient: false,
    });
    const studio2 = createStudioMiddleware({
      runtime: runtime2,
      basePath: '/b',
      serveClient: false,
    });

    // Both should have independent health endpoints
    const res1 = await studio1.app.request('/api/health');
    const res2 = await studio2.app.request('/api/health');
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    studio1.close();
    studio2.close();
  });

  it('handler reads pre-parsed body from Express/NestJS body parser', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, serveClient: false });

    server = createBodyParserServer(studio.handler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const res = await fetch(`http://localhost:${port}/api/tools/greet/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { name: 'World' } }),
    });

    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.result).toBe('Hello, World!');
  });

  it('multi-run eval works through body-parser middleware', async () => {
    const provider = MockProvider.sequence([
      { content: 'r1' },
      { content: 'r2' },
      { content: 'r3' },
    ]);
    const runtime = createEvalRuntime(provider);
    studio = createStudioMiddleware({ runtime, serveClient: false });

    server = createBodyParserServer(studio.handler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const res = await fetch(`http://localhost:${port}/api/evals/test-eval/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs: 3 }),
    });

    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data._multiRun).toBeDefined();
    expect(body.data._multiRun.allRuns).toHaveLength(3);
    expect(body.data._multiRun.aggregate.runCount).toBe(3);

    // Verify grouping metadata exists on each run
    const groupId = body.data._multiRun.allRuns[0].metadata.runGroupId;
    expect(groupId).toBeDefined();
    for (let i = 0; i < 3; i++) {
      expect(body.data._multiRun.allRuns[i].metadata.runGroupId).toBe(groupId);
      expect(body.data._multiRun.allRuns[i].metadata.runIndex).toBe(i);
    }
  });

  it('streaming eval (stream: true) works through body-parser middleware', async () => {
    const provider = MockProvider.sequence([{ content: 'streamed' }]);
    const runtime = createEvalRuntime(provider);
    studio = createStudioMiddleware({ runtime, serveClient: false });

    server = createBodyParserServer(studio.handler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const res = await fetch(`http://localhost:${port}/api/evals/test-eval/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });

    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    // stream: true should return evalRunId, not the full result
    expect(body.data.evalRunId).toBeDefined();
    expect(typeof body.data.evalRunId).toBe('string');
    expect(body.data.evalRunId.startsWith('eval-')).toBe(true);

    // Wait for async completion then verify result is in history
    await new Promise((resolve) => setTimeout(resolve, 100));
    const histRes = await fetch(`http://localhost:${port}/api/evals/history`);
    const histBody = await readJson(histRes);
    expect(histBody.data.length).toBeGreaterThan(0);
  });

  it('POST without body parser still works (raw stream)', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, serveClient: false });

    // Direct handler — no body parser consuming the stream
    server = createHttpServer(studio.handler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const res = await fetch(`http://localhost:${port}/api/tools/greet/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { name: 'Direct' } }),
    });

    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.result).toBe('Hello, Direct!');
  });

  it('GET requests work through body-parser middleware', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, serveClient: false });

    server = createBodyParserServer(studio.handler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const res = await fetch(`http://localhost:${port}/api/health`);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('healthy');
  });

  it('deeply nested basePath works', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({
      runtime,
      basePath: '/admin/tools/studio',
      serveClient: false,
    });

    const res = await studio.app.request('/api/workflows');
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
  });

  it('API-only mode (serveClient: false) serves API without static files', async () => {
    const runtime = createTestRuntime();
    studio = createStudioMiddleware({ runtime, serveClient: false });

    // API works
    const apiRes = await studio.app.request('/api/health');
    expect(apiRes.status).toBe(200);

    // Non-API routes should 404 (no SPA fallback)
    const spaRes = await studio.app.request('/playground');
    expect(spaRes.status).toBe(404);
  });
});
