import { Hono } from 'hono';
import { z } from 'zod';
import type { StudioEnv } from '../types.js';
import type { ConnectionManager } from '../ws/connection-manager.js';
import { redactStreamEvent, sanitizeRichInputFailure } from '../redact.js';
import type { AxlEventV2 as AxlEvent, ModelInput } from '@axlsdk/axl';
import {
  base64ByteLength,
  hasMatchingImageSignature,
  isPlaygroundImageMediaType,
  PLAYGROUND_IMAGE_MAX_BASE64_CHARACTERS,
  PLAYGROUND_IMAGE_MAX_BYTES,
  PLAYGROUND_IMAGE_REQUEST_MAX_BYTES,
  type PlaygroundImageAttachment,
} from '../../playground-image.js';

// Demo schemas keyed by agent name. When the playground UI selects an agent
// in this map, the chat-bubble render path exercises the spec/17
// typewriter UX (partial_object snapshots + string_delta events). Without
// a schema, `ctx.ask` returns plain text and the streamingStructuredAgent's
// JSON-shaped content would render as raw text mid-stream — which is
// exactly the gibberish the chat-bubble fix replaces.
//
// Keep this map narrow: dev-fixture agents only. The intent is "make the
// streaming-structured demo work end-to-end in the Playground", not "let
// any agent become schema-aware via convention". Production customers
// using the playground for schema'd asks should add `schema` to the
// request body explicitly (planned follow-up).
const DEMO_SCHEMA_BY_AGENT: Record<string, z.ZodObject<Record<string, z.ZodTypeAny>>> = {
  'streaming-structured-agent': z.object({
    title: z.string(),
    summary: z.string(),
    bulletPoints: z.array(z.string()),
    confidence: z.number().min(0).max(1),
  }),
};

class PlaygroundBodyTooLargeError extends Error {}

async function readPlaygroundBody(request: Request): Promise<unknown> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const bytes = Number(contentLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > PLAYGROUND_IMAGE_REQUEST_MAX_BYTES) {
      throw new PlaygroundBodyTooLargeError();
    }
  }
  if (!request.body) throw new SyntaxError('missing body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > PLAYGROUND_IMAGE_REQUEST_MAX_BYTES) {
        await reader.cancel();
        throw new PlaygroundBodyTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

export function createPlaygroundRoutes(connMgr: ConnectionManager) {
  const app = new Hono<StudioEnv>();

  // Chat with an agent directly — no workflow required
  app.post('/playground/chat', async (c) => {
    const runtime = c.get('runtime');
    let parsedBody: unknown;
    try {
      parsedBody = await readPlaygroundBody(c.req.raw);
    } catch (error) {
      if (error instanceof PlaygroundBodyTooLargeError) {
        return c.json(
          {
            ok: false,
            error: { code: 'REQUEST_TOO_LARGE', message: 'playground image request is too large' },
          },
          413,
        );
      }
      return c.json(
        { ok: false, error: { code: 'INVALID_INPUT', message: 'request body must be valid JSON' } },
        400,
      );
    }
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      return c.json(
        {
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'request body must be a JSON object' },
        },
        400,
      );
    }
    const body = parsedBody as {
      sessionId?: string;
      message?: unknown;
      agent?: string;
      image?: unknown;
    };

    if (!body.message || typeof body.message !== 'string' || !body.message.trim()) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'message is required and must be a non-empty string',
          },
        },
        400,
      );
    }
    const message = body.message;

    let image: PlaygroundImageAttachment | undefined;
    if (body.image !== undefined) {
      const candidate = body.image as Partial<PlaygroundImageAttachment> | null;
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        !isPlaygroundImageMediaType(candidate.mediaType) ||
        typeof candidate.data !== 'string'
      ) {
        return c.json(
          {
            ok: false,
            error: { code: 'INVALID_IMAGE', message: 'image must be a supported base64 image' },
          },
          400,
        );
      }
      if (candidate.data.length > PLAYGROUND_IMAGE_MAX_BASE64_CHARACTERS) {
        return c.json(
          { ok: false, error: { code: 'IMAGE_TOO_LARGE', message: 'image must be at most 5 MiB' } },
          400,
        );
      }
      const bytes = base64ByteLength(candidate.data);
      if (bytes === undefined) {
        return c.json(
          {
            ok: false,
            error: { code: 'INVALID_IMAGE', message: 'image data must be valid base64' },
          },
          400,
        );
      }
      if (bytes > PLAYGROUND_IMAGE_MAX_BYTES) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'IMAGE_TOO_LARGE',
              message: `image must be at most ${PLAYGROUND_IMAGE_MAX_BYTES / 1024 / 1024} MiB`,
            },
          },
          400,
        );
      }
      if (!hasMatchingImageSignature(candidate.mediaType, candidate.data)) {
        return c.json(
          {
            ok: false,
            error: { code: 'INVALID_IMAGE', message: 'image data does not match its media type' },
          },
          400,
        );
      }
      image = { mediaType: candidate.mediaType, data: candidate.data };
    }

    const agents = runtime.getAgents();
    const agent = body.agent ? agents.find((a) => a._name === body.agent) : agents[0];
    if (!agent) {
      return c.json(
        {
          ok: false,
          error: { code: 'NO_AGENT', message: `Agent "${body.agent ?? ''}" not found` },
        },
        400,
      );
    }

    const sessionId = body.sessionId ?? `playground-${Date.now()}`;
    const store = runtime.getStateStore();

    // The current user turn belongs to the ask, not its inherited history.
    // Keep a separate text-only snapshot for persistence after the run.
    const history = await store.getSession(sessionId);
    const persistedHistory = [...history, { role: 'user' as const, content: message }];

    const redactOn = runtime.isRedactEnabled();

    // Create context — its auto-generated executionId becomes the WS channel name.
    // Token events flow through emitEvent → runtime.emit('trace') → our listener below.
    const ctx = runtime.createContext({ sessionHistory: history });
    const executionId = ctx.executionId;
    // Touch `ctx.events` to allocate the bus — this activates the
    // streaming code path inside `ctx.ask()` so token / partial_object /
    // string_delta events fire. Without this, ctx.ask falls back to the
    // non-streaming `provider.chat` and the chat bubble never sees
    // mid-stream events. The events themselves still flow to the WS
    // channel via the `runtime.on('trace', ...)` listener below — we
    // don't need to drain `ctx.events` ourselves, just allocate it.
    void ctx.events;

    // Forward ALL AxlEvents from this execution to the WS channel.
    // This gives the playground UI access to ask_start, agent_call, tool_call,
    // handoff, pipeline, etc. — not just tokens.
    const traceListener = (event: AxlEvent) => {
      if (event.executionId !== executionId) return;
      const safeEvent = image ? sanitizeRichInputFailure(event) : event;
      connMgr.broadcastWithWildcard(
        `execution:${executionId}`,
        redactStreamEvent(safeEvent, redactOn),
      );
    };
    runtime.on('trace', traceListener);

    // Run the agent ask asynchronously, stream results via WS
    (async () => {
      let stepCounter = Number.MAX_SAFE_INTEGER - 1;
      const terminalFields = () => ({
        schemaVersion: 2 as const,
        executionId,
        step: stepCounter++,
        timestamp: Date.now(),
      });

      try {
        // Look up a demo schema by agent name (dev-fixture demo only).
        // If found, the ask is schema'd and emits partial_object +
        // string_delta — exercising the typewriter UX in the chat
        // bubble. Without a match, the ask is plain free-text.
        const schema = DEMO_SCHEMA_BY_AGENT[agent._name];
        // Images are single-run evidence: they enter only this ask and are never
        // appended to `history` or written to the session store.
        const input: ModelInput = image
          ? [
              { type: 'text', text: message },
              {
                type: 'image',
                source: { type: 'base64', data: image.data, mediaType: image.mediaType },
              },
            ]
          : message;
        const result = await ctx.ask(agent, input, schema ? { schema } : undefined);
        const resultText = typeof result === 'string' ? result : JSON.stringify(result);

        persistedHistory.push({ role: 'assistant', content: resultText });
        await store.saveSession(sessionId, persistedHistory);

        const doneEvent: AxlEvent = {
          ...terminalFields(),
          type: 'done',
          data: { result: resultText },
        };
        connMgr.broadcastWithWildcard(
          `execution:${executionId}`,
          redactStreamEvent(doneEvent, redactOn),
        );
      } catch (err) {
        const errorEvent: AxlEvent = {
          ...terminalFields(),
          type: 'error',
          // Media payloads can make providers echo user-controlled content in
          // errors. The manual terminal event is deliberately fixed and safe.
          data: {
            message: image
              ? 'Playground media input failed'
              : err instanceof Error
                ? err.message
                : String(err),
          },
        };
        connMgr.broadcastWithWildcard(
          `execution:${executionId}`,
          redactStreamEvent(errorEvent, redactOn),
        );
      } finally {
        runtime.off('trace', traceListener);
      }
    })();

    return c.json({
      ok: true,
      data: { sessionId, executionId, streaming: true },
    });
  });

  return app;
}
