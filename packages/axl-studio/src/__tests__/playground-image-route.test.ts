import { describe, expect, it, vi } from 'vitest';
import { AxlRuntime, agent } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createServer } from '../server/index.js';
import { PLAYGROUND_IMAGE_REQUEST_MAX_BYTES } from '../playground-image.js';

const testAgent = agent({ name: 'image-agent', model: 'mock:vision-test' });
const TINY_PNG_BASE64 = 'iVBORw0KGgo=';

function setup(redact = false) {
  const runtime = new AxlRuntime(redact ? { trace: { redact: true } } : undefined);
  const provider = MockProvider.echo();
  runtime.registerProvider('mock', provider);
  runtime.registerAgent(testAgent);
  const server = createServer({ runtime });
  return { runtime, provider, ...server };
}

async function post(app: ReturnType<typeof createServer>['app'], body: unknown) {
  return app.request('/api/playground/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

describe('Studio playground image route', () => {
  it('keeps string-only input as a string', async () => {
    const { app, provider } = setup();
    await post(app, { message: 'plain text', agent: 'image-agent' });
    await settle();
    expect(provider.calls[0]?.messages.at(-1)?.content).toBe('plain text');
  });

  it('dispatches a selected image only as ordered per-call input', async () => {
    const { app, provider, runtime } = setup();
    const res = await post(app, {
      message: 'describe it',
      agent: 'image-agent',
      sessionId: 'image-session',
      image: { mediaType: 'image/png', data: TINY_PNG_BASE64, label: 'private-name.png' },
    });
    expect(res.status).toBe(200);
    await settle();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'describe it' },
      { type: 'image', source: { type: 'base64', data: TINY_PNG_BASE64, mediaType: 'image/png' } },
    ]);
    const history = await runtime.getStateStore().getSession('image-session');
    expect(JSON.stringify(history)).not.toContain(TINY_PNG_BASE64);
    expect(history[0]).toEqual({ role: 'user', content: 'describe it' });
  });

  it.each([
    ['unsupported media type', { mediaType: 'image/svg+xml', data: TINY_PNG_BASE64 }],
    ['malformed base64', { mediaType: 'image/png', data: 'not base64!' }],
    ['mismatched magic bytes', { mediaType: 'image/png', data: 'QUJDREVGR0g=' }],
    ['oversize decoded image', { mediaType: 'image/png', data: 'AAAA'.repeat(1_747_627) }],
  ])('rejects %s before execution', async (_name, image) => {
    const { app, provider } = setup();
    const res = await post(app, { message: 'no call', agent: 'image-agent', image });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await settle();
    expect(provider.calls).toHaveLength(0);
  });

  it('rejects declared and chunked oversize request bodies before dispatch', async () => {
    const declared = setup();
    const declaredResponse = await declared.app.request('/api/playground/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(PLAYGROUND_IMAGE_REQUEST_MAX_BYTES + 1),
      },
      body: '{}',
    });
    expect(declaredResponse.status).toBe(413);
    expect(declared.provider.calls).toHaveLength(0);

    const chunked = setup();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(PLAYGROUND_IMAGE_REQUEST_MAX_BYTES + 1));
        controller.close();
      },
    });
    const chunkedResponse = await chunked.app.request(
      new Request('http://localhost/api/playground/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        // Required by Node's fetch implementation for streaming request bodies.
        duplex: 'half',
      } as RequestInit),
    );
    expect(chunkedResponse.status).toBe(413);
    expect(chunked.provider.calls).toHaveLength(0);
  });

  it('never puts base64 on the websocket and redacts rich descriptors', async () => {
    const { app, connMgr } = setup(true);
    const broadcast = vi.spyOn(connMgr, 'broadcastWithWildcard');
    await post(app, {
      message: 'secret prompt',
      agent: 'image-agent',
      image: { mediaType: 'image/png', data: TINY_PNG_BASE64 },
    });
    await settle();
    const serialized = JSON.stringify(broadcast.mock.calls);
    expect(serialized).not.toContain(TINY_PNG_BASE64);
    expect(serialized).toContain('"source":"base64"');
  });

  it('uses a fixed terminal message for media provider failures even without redaction', async () => {
    const { app, provider, connMgr, runtime } = setup();
    vi.spyOn(provider, 'stream').mockImplementation(async function* () {
      yield* [];
      throw new Error('provider echoed secret-image-payload');
    });
    const broadcast = vi.spyOn(connMgr, 'broadcastWithWildcard');
    await post(app, {
      message: 'describe it',
      agent: 'image-agent',
      sessionId: 'failed-media',
      image: { mediaType: 'image/png', data: TINY_PNG_BASE64 },
    });
    await settle();
    const serialized = JSON.stringify(broadcast.mock.calls);
    expect(serialized).not.toContain('provider echoed secret-image-payload');
    expect(serialized).toContain('Playground media input failed');
    expect(JSON.stringify(await runtime.getStateStore().getSession('failed-media'))).not.toContain(
      TINY_PNG_BASE64,
    );
  });

  it('keeps a later text-only provider failure observable after a rich run', async () => {
    const { app, provider, connMgr } = setup();
    const broadcast = vi.spyOn(connMgr, 'broadcastWithWildcard');
    await post(app, {
      message: 'rich succeeds',
      agent: 'image-agent',
      image: { mediaType: 'image/png', data: TINY_PNG_BASE64 },
    });
    await settle();
    vi.spyOn(provider, 'stream').mockImplementation(async function* () {
      yield* [];
      throw new Error('normal text provider error');
    });
    await post(app, { message: 'plain failure', agent: 'image-agent' });
    await settle();
    const serialized = JSON.stringify(broadcast.mock.calls);
    expect(serialized).toContain('normal text provider error');
  });

  it('does not duplicate the current message in first or subsequent provider calls', async () => {
    const { app, provider } = setup();
    await post(app, { message: 'first', agent: 'image-agent', sessionId: 'two-turns' });
    await settle();
    await post(app, { message: 'second', agent: 'image-agent', sessionId: 'two-turns' });
    await settle();
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.messages.map((message) => message.content)).toEqual(['first']);
    expect(provider.calls[1]?.messages.map((message) => message.content)).toEqual([
      'first',
      'first',
      'second',
    ]);
  });

  it('renders programmatic rich session history as descriptors, never attachment data', async () => {
    const { app, runtime } = setup();
    await runtime.getStateStore().saveSession('programmatic-image', [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'private text' },
          {
            type: 'image',
            source: { type: 'base64', data: TINY_PNG_BASE64, mediaType: 'image/png' },
          },
        ],
      },
    ]);
    const res = await app.request('/api/sessions/programmatic-image');
    const serialized = await res.text();
    expect(serialized).not.toContain(TINY_PNG_BASE64);
    expect(serialized).toContain('"source":"base64"');
    expect(serialized).not.toContain('private text');
  });

  it('keeps rich session descriptors structural under redaction', async () => {
    const { app, runtime } = setup(true);
    await runtime.getStateStore().saveSession('redacted-rich', [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'private text' },
          {
            type: 'image',
            source: { type: 'base64', data: TINY_PNG_BASE64, mediaType: 'image/png' },
            label: 'private label',
          },
        ],
      },
    ]);
    const serialized = await (await app.request('/api/sessions/redacted-rich')).text();
    expect(serialized).toContain('"characters":12');
    expect(serialized).toContain('"source":"base64"');
    expect(serialized).not.toContain('private text');
    expect(serialized).not.toContain('private label');
    expect(serialized).not.toContain(TINY_PNG_BASE64);
  });
});
