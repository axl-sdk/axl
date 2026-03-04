import { describe, it, expect } from 'vitest';
import { MockProvider } from '@axlsdk/testing';
import { createTestServer } from '../helpers/setup.js';

describe('Studio API: Playground', () => {
  it('POST /api/playground/chat returns response with sessionId', async () => {
    const provider = MockProvider.sequence([{ content: 'playground response' }]);
    const { app } = createTestServer(provider);

    const res = await app.request('/api/playground/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', workflow: 'chat-wf' }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.sessionId).toBeDefined();
  });
});
