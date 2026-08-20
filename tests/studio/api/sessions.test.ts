import { describe, it, expect, vi } from 'vitest';
import type { AxlEvent } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createTestServer } from '../helpers/setup.js';
import { readJson } from '../helpers/json.js';

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

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.result).toBe('session response');
  });

  it('POST /api/sessions/:id/send scrubs its opaque result when trace.redact is on', async () => {
    const userMarker = 'session-send-user-marker';
    const modelMarker = 'session-send-model-marker';
    const provider = MockProvider.sequence([{ content: modelMarker }]);
    const { app } = createTestServer(provider, { redact: true });

    const res = await app.request('/api/sessions/redact-send/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userMarker, workflow: 'chat-wf' }),
    });

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.result).toBe('[redacted]');
    expect(JSON.stringify(body)).not.toContain(userMarker);
    expect(JSON.stringify(body)).not.toContain(modelMarker);
  });

  it('POST /api/sessions/:id/send preserves its raw result when trace.redact is off', async () => {
    const modelMarker = 'session-send-public-model-marker';
    const provider = MockProvider.sequence([{ content: modelMarker }]);
    const { app } = createTestServer(provider, { redact: false });

    const res = await app.request('/api/sessions/raw-send/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'session-send-public-user-marker', workflow: 'chat-wf' }),
    });

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.result).toBe(modelMarker);
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

    const body = await readJson(res);
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

    const body = await readJson(res);
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
    const body = await readJson(res);
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

  it('POST /api/sessions/:id/stream redacts every broadcast when trace.redact is on', async () => {
    const userMarker = 'session-stream-user-marker';
    const modelMarker = 'session-stream-model-marker';
    const provider = MockProvider.sequence([{ content: modelMarker }]);
    const { app, connMgr } = createTestServer(provider, { redact: true });
    const broadcastSpy = vi.spyOn(connMgr, 'broadcastWithWildcard');

    const res = await app.request('/api/sessions/redact-stream/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userMarker, workflow: 'chat-wf' }),
    });

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.streaming).toBe(true);
    expect(typeof body.data.executionId).toBe('string');

    await expect
      .poll(() =>
        broadcastSpy.mock.calls.some(
          ([channel, event]) =>
            channel.startsWith(`execution:${body.data.executionId}`) &&
            (event as { type?: string }).type === 'done',
        ),
      )
      .toBe(true);

    const broadcasts = broadcastSpy.mock.calls.filter(([channel]) =>
      channel.startsWith(`execution:${body.data.executionId}`),
    );
    expect(broadcasts.length).toBeGreaterThan(0);
    for (const [, event] of broadcasts) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(userMarker);
      expect(serialized).not.toContain(modelMarker);
    }

    const terminal = broadcasts.find(([, event]) => (event as { type?: string }).type === 'done');
    expect(terminal).toBeDefined();
    const [, doneEvent] = terminal!;
    expect(doneEvent).toMatchObject({
      type: 'done',
      data: { result: '[redacted]' },
    });
    expect((doneEvent as { executionId?: unknown }).executionId).toBeDefined();
    expect((doneEvent as { step?: unknown }).step).toEqual(expect.any(Number));
  });

  it('POST /api/sessions/:id/stream redacts raw stream fixtures at the Studio boundary', async () => {
    const argsMarker = 'raw-stream-tool-args-marker';
    const resultMarker = 'raw-stream-tool-result-marker';
    const errorMarker = 'raw-stream-error-marker';
    const doneMarker = 'raw-stream-done-marker';
    const fixtureExecutionId = 'raw-stream-fixture-execution';
    const rawEvents: AxlEvent[] = [
      {
        schemaVersion: 2,
        type: 'tool_call_end',
        executionId: fixtureExecutionId,
        step: 41,
        timestamp: 1_700_000_000_000,
        askId: 'raw-stream-ask',
        depth: 0,
        agent: 'raw-stream-agent',
        tool: 'raw-stream-tool',
        callId: 'raw-stream-call',
        duration: 73,
        cost: 0.42,
        tokens: { input: 13, output: 8 },
        data: {
          args: { marker: argsMarker },
          outcome: { status: 'succeeded', result: { marker: resultMarker } },
        },
      },
      {
        schemaVersion: 2,
        type: 'error',
        executionId: fixtureExecutionId,
        step: 42,
        timestamp: 1_700_000_000_001,
        data: { message: errorMarker, name: 'ProviderError' },
      },
      {
        schemaVersion: 2,
        type: 'done',
        executionId: fixtureExecutionId,
        step: 43,
        timestamp: 1_700_000_000_002,
        data: { result: { marker: doneMarker } },
      },
    ];
    const rawStream = {
      async *[Symbol.asyncIterator](): AsyncGenerator<AxlEvent> {
        yield* rawEvents;
      },
    };
    const { app, connMgr, runtime } = createTestServer(undefined, { redact: true });
    vi.spyOn(runtime, 'session').mockReturnValue({
      stream: vi.fn().mockResolvedValue(rawStream),
    } as never);
    const broadcastSpy = vi.spyOn(connMgr, 'broadcastWithWildcard');

    const res = await app.request('/api/sessions/raw-fixture-stream/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'route-boundary-input', workflow: 'chat-wf' }),
    });
    const body = await readJson(res);

    await expect
      .poll(() =>
        broadcastSpy.mock.calls.some(
          ([channel, event]) =>
            channel.startsWith(`execution:${body.data.executionId}`) &&
            (event as { type?: string }).type === 'done',
        ),
      )
      .toBe(true);

    const broadcasts = broadcastSpy.mock.calls.filter(([channel]) =>
      channel.startsWith(`execution:${body.data.executionId}`),
    );
    const serializedBroadcasts = broadcasts.map(([, event]) => JSON.stringify(event)).join('|||');
    for (const marker of [argsMarker, resultMarker, errorMarker, doneMarker]) {
      expect(serializedBroadcasts).not.toContain(marker);
    }

    const toolEvent = broadcasts.find(
      ([, event]) => (event as { type?: string }).type === 'tool_call_end',
    )![1] as Extract<AxlEvent, { type: 'tool_call_end' }>;
    expect(toolEvent).toMatchObject({
      executionId: fixtureExecutionId,
      step: 41,
      duration: 73,
      cost: 0.42,
      tokens: { input: 13, output: 8 },
      data: {
        args: '[redacted]',
        outcome: { status: 'succeeded', result: '[redacted]' },
      },
    });
    const errorEvent = broadcasts.find(
      ([, event]) => (event as { type?: string }).type === 'error',
    )![1] as Extract<AxlEvent, { type: 'error' }>;
    expect(errorEvent.data.message).toBe('[redacted]');
    const doneEvent = broadcasts.find(
      ([, event]) => (event as { type?: string }).type === 'done',
    )![1] as Extract<AxlEvent, { type: 'done' }>;
    expect(doneEvent.data.result).toBe('[redacted]');
  });

  it('POST /api/sessions/:id/stream broadcasts raw events when trace.redact is off', async () => {
    const modelMarker = 'session-stream-public-model-marker';
    const provider = MockProvider.sequence([{ content: modelMarker }]);
    const { app, connMgr } = createTestServer(provider, { redact: false });
    const broadcastSpy = vi.spyOn(connMgr, 'broadcastWithWildcard');

    const res = await app.request('/api/sessions/raw-stream/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'session-stream-public-user-marker', workflow: 'chat-wf' }),
    });
    const body = await readJson(res);

    await expect
      .poll(() =>
        broadcastSpy.mock.calls
          .filter(([channel]) => channel.startsWith(`execution:${body.data.executionId}`))
          .map(([, event]) => JSON.stringify(event))
          .join('|||'),
      )
      .toContain(modelMarker);
    const serializedBroadcasts = broadcastSpy.mock.calls
      .filter(([channel]) => channel.startsWith(`execution:${body.data.executionId}`))
      .map(([, event]) => JSON.stringify(event))
      .join('|||');
    expect(serializedBroadcasts).toContain(modelMarker);
  });
});
