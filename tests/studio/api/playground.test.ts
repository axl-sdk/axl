import { describe, it, expect, vi } from 'vitest';
import { MockProvider } from '@axlsdk/testing';
import { createTestServer } from '../helpers/setup.js';
import { readJson } from '../helpers/json.js';

// Wait for the async WS broadcast loop to flush. Playground fires
// `runtime.ask()` in the background and pipes stream events to the
// connection manager; the REST response returns before those events
// fire, so we need a short settle before asserting broadcast content.
async function tick(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.sessionId).toBeDefined();
  });

  it('scrubs WS stream events when trace.redact is on', async () => {
    const provider = MockProvider.sequence([{ content: 'sensitive playground output' }]);
    const { app, connMgr } = createTestServer(provider, { redact: true });
    const broadcastSpy = vi.spyOn(connMgr, 'broadcastWithWildcard');

    await app.request('/api/playground/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', agent: 'test-agent' }),
    });

    // Give the background ctx.ask() time to emit events
    await tick(100);

    // Every broadcast to the execution: channel should be a scrubbed
    // StreamEvent — no raw content should have leaked. Iterate all
    // broadcast calls and assert no field contains the sensitive text.
    const sensitive = 'sensitive playground output';
    for (const call of broadcastSpy.mock.calls) {
      const [, event] = call as [string, { data?: unknown; message?: unknown }];
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(sensitive);
    }
    // Sanity: we did broadcast at least one event
    expect(broadcastSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('broadcasts raw WS events when trace.redact is off', async () => {
    const provider = MockProvider.sequence([{ content: 'public playground output' }]);
    const { app, connMgr } = createTestServer(provider, { redact: false });
    const broadcastSpy = vi.spyOn(connMgr, 'broadcastWithWildcard');

    await app.request('/api/playground/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', agent: 'test-agent' }),
    });
    await tick(100);

    // At least one broadcast should contain the raw response text
    const serializedCalls = broadcastSpy.mock.calls
      .map((call) => JSON.stringify(call[1]))
      .join('|||');
    expect(serializedCalls).toContain('public playground output');
  });
});
