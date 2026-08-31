import { Hono } from 'hono';
import type { ChatMessage, ModelInputDescriptor } from '@axlsdk/axl';
import type { StudioEnv, SessionSummary } from '../types.js';
import type { ConnectionManager } from '../ws/connection-manager.js';
import { redactSessionHistory, redactStreamEvent, redactValue } from '../redact.js';

function describeStudioInput(content: ChatMessage['content']): ModelInputDescriptor | undefined {
  if (typeof content === 'string') return undefined;
  return {
    parts: content.map((part) => {
      if (part.type === 'text') return { type: 'text' as const, characters: part.text.length };
      const { source } = part;
      const bytes =
        source.type === 'bytes'
          ? source.data.byteLength
          : source.type === 'base64'
            ? Math.floor((source.data.length * 3) / 4) -
              (source.data.endsWith('==') ? 2 : source.data.endsWith('=') ? 1 : 0)
            : undefined;
      return {
        type: 'image' as const,
        source: source.type,
        ...(source.mediaType ? { mediaType: source.mediaType } : {}),
        ...(bytes !== undefined ? { bytes } : {}),
        // URLs, provider-file references, and labels are intentionally not
        // included: this is a Studio-safe descriptor, not a replay payload.
      };
    }),
  };
}

export function createSessionRoutes(connMgr: ConnectionManager) {
  const app = new Hono<StudioEnv>();

  // List all sessions
  app.get('/sessions', async (c) => {
    const runtime = c.get('runtime');
    const store = runtime.getStateStore();
    if (!store.listSessions) {
      return c.json({ ok: true, data: [] });
    }
    const ids = await store.listSessions();
    const sessions: SessionSummary[] = [];
    for (const id of ids) {
      const history = await store.getSession(id);
      sessions.push({ id, messageCount: history.length });
    }
    // List endpoint carries no message content — just id + count.
    // Nothing to redact.
    return c.json({ ok: true, data: sessions });
  });

  // Get session history
  app.get('/sessions/:id', async (c) => {
    const runtime = c.get('runtime');
    const store = runtime.getStateStore();
    const id = c.req.param('id');
    const history = await store.getSession(id);
    const handoffHistory = await store.getSessionMeta(id, 'handoffHistory');
    // Rich programmatic history may contain base64, URLs, or provider file
    // references. Studio is an observation boundary, so expose only the
    // core's bounded descriptor — never attachment data or locators.
    const redact = runtime.isRedactEnabled();
    const studioHistory = history.map((message) => {
      const input = describeStudioInput(message.content);
      // Project rich values before redaction. The descriptor contains only
      // structural/count data, so redact mode preserves it for diagnosis
      // while never exposing text, labels, locators, or attachment bytes.
      if (input) return { ...message, content: input };
      return redact ? redactSessionHistory([message], true)[0]! : message;
    });
    return c.json({
      ok: true,
      data: {
        id,
        history: studioHistory,
        // HandoffRecord has no content fields (source/target/mode/
        // timestamp/duration) — nothing to scrub.
        handoffHistory: handoffHistory ?? [],
      },
    });
  });

  // Send message to session (non-streaming)
  app.post('/sessions/:id/send', async (c) => {
    const runtime = c.get('runtime');
    const id = c.req.param('id');
    const body = await c.req.json<{ message: string; workflow: string }>();

    const session = runtime.session(id);
    const result = await session.send(body.workflow, body.message);
    return c.json({
      ok: true,
      data: { result: redactValue(result, runtime.isRedactEnabled()) },
    });
  });

  // Stream session message
  app.post('/sessions/:id/stream', async (c) => {
    const runtime = c.get('runtime');
    const id = c.req.param('id');
    const body = await c.req.json<{ message: string; workflow: string }>();

    const session = runtime.session(id);
    const stream = await session.stream(body.workflow, body.message);
    const executionId = `session-${id}-${Date.now()}`;
    const redactOn = runtime.isRedactEnabled();

    // Forward stream events to WS (error events flow through the iterator)
    (async () => {
      for await (const event of stream) {
        connMgr.broadcastWithWildcard(
          `execution:${executionId}`,
          redactStreamEvent(event, redactOn),
        );
      }
    })();

    return c.json({ ok: true, data: { executionId, streaming: true } });
  });

  // Delete session
  app.delete('/sessions/:id', async (c) => {
    const runtime = c.get('runtime');
    const store = runtime.getStateStore();
    const id = c.req.param('id');
    await store.deleteSession(id);
    return c.json({ ok: true, data: { deleted: true } });
  });

  return app;
}
