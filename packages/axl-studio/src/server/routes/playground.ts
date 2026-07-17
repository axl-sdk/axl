import { Hono } from 'hono';
import { z } from 'zod';
import type { StudioEnv } from '../types.js';
import type { ConnectionManager } from '../ws/connection-manager.js';
import { redactStreamEvent } from '../redact.js';
import type { AxlEvent } from '@axlsdk/axl';

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

export function createPlaygroundRoutes(connMgr: ConnectionManager) {
  const app = new Hono<StudioEnv>();

  // Chat with an agent directly — no workflow required
  app.post('/playground/chat', async (c) => {
    const runtime = c.get('runtime');
    const body = await c.req.json<{
      sessionId?: string;
      message: string;
      agent?: string;
    }>();

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

    // Load session history for multi-turn conversations
    const history = await store.getSession(sessionId);
    history.push({ role: 'user', content: body.message });

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
      connMgr.broadcastWithWildcard(`execution:${executionId}`, redactStreamEvent(event, redactOn));
    };
    runtime.on('trace', traceListener);

    // Run the agent ask asynchronously, stream results via WS
    (async () => {
      let stepCounter = Number.MAX_SAFE_INTEGER - 1;
      const terminalFields = () => ({
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
        const result = await ctx.ask(agent, body.message, schema ? { schema } : undefined);
        const resultText = typeof result === 'string' ? result : JSON.stringify(result);

        history.push({ role: 'assistant', content: resultText });
        await store.saveSession(sessionId, history);

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
          data: { message: err instanceof Error ? err.message : String(err) },
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
