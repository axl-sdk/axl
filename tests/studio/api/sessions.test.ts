import { describe, it, expect } from 'vitest';
import { MockProvider } from '@axlsdk/testing';
import { createTestServer } from '../helpers/setup.js';

describe('Studio API: Sessions', () => {
  it('POST /api/sessions/:id/send returns response', async () => {
    const provider = MockProvider.sequence([{ content: 'session response' }]);
    const { app } = createTestServer(provider);

    const res = await app.request('/api/sessions/test-session/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', workflow: 'chat-wf' }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.result).toBe('session response');
  });

  it('GET /api/sessions/:id returns session detail with history', async () => {
    const provider = MockProvider.sequence([{ content: 'reply' }]);
    const { app } = createTestServer(provider);

    // First send a message to create the session
    await app.request('/api/sessions/detail-test/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', workflow: 'chat-wf' }),
    });

    // Then fetch session detail
    const res = await app.request('/api/sessions/detail-test');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('detail-test');
    expect(body.data.history.length).toBeGreaterThanOrEqual(2);
  });

  it('DELETE /api/sessions/:id removes the session', async () => {
    const provider = MockProvider.sequence([{ content: 'reply' }]);
    const { app } = createTestServer(provider);

    // Create a session
    await app.request('/api/sessions/delete-test/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', workflow: 'chat-wf' }),
    });

    // Delete the session
    const res = await app.request('/api/sessions/delete-test', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);
  });

  it('GET /api/sessions/:id scrubs message content when trace.redact is on', async () => {
    // Closes the same inconsistency as the executions Result fix:
    // agent_call.data.prompt/response are already scrubbed in trace events,
    // so scrubbing session history content here makes the two views
    // consistent for compliance users.
    const provider = MockProvider.sequence([{ content: 'sensitive response' }]);
    const { app } = createTestServer(provider, { redact: true });

    await app.request('/api/sessions/redact-test/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'secret user question', workflow: 'chat-wf' }),
    });

    const res = await app.request('/api/sessions/redact-test');
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('redact-test');
    expect(body.data.history.length).toBeGreaterThanOrEqual(2);
    // Every message content is scrubbed; roles remain visible so users
    // can still understand the session shape.
    for (const msg of body.data.history) {
      expect(msg.content).toBe('[redacted]');
      expect(typeof msg.role).toBe('string');
      expect(msg.role).not.toBe('[redacted]');
    }
  });
});
