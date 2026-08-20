// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendSessionMessage, streamSessionMessage } from '../client/lib/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockJsonResponse(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Studio client session API helpers', () => {
  it('sends the workflow and message to the session send route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ result: 'sent' }));
    vi.stubGlobal('fetch', fetchMock);

    await sendSessionMessage('session / id', 'chat-workflow', 'hello session');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session%20%2F%20id/send', {
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      body: JSON.stringify({ workflow: 'chat-workflow', message: 'hello session' }),
    });
  });

  it('sends the workflow and message to the session stream route', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockJsonResponse({ executionId: 'execution-1', streaming: true }));
    vi.stubGlobal('fetch', fetchMock);

    await streamSessionMessage('session / id', 'chat-workflow', 'stream this');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session%20%2F%20id/stream', {
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      body: JSON.stringify({ workflow: 'chat-workflow', message: 'stream this' }),
    });
  });
});
