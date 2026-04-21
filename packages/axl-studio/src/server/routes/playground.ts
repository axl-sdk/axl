import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import type { ConnectionManager } from '../ws/connection-manager.js';
import { redactStreamEvent } from '../redact.js';
// TODO(PR-3-spec-16): the playground broadcasts events through
// `runtime.stream()`'s legacy translation layer (`runtime.ts` adapter), which
// emits the old `StreamEvent` shape. PR 3 collapses the wire to `AxlEvent`
// and this local import disappears (along with `redactStreamEvent` itself).
import type { StreamEvent } from '../redact.js';

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
    const executionId = `playground-${sessionId}-${Date.now()}`;
    const store = runtime.getStateStore();

    // Load session history for multi-turn conversations
    const history = await store.getSession(sessionId);
    history.push({ role: 'user', content: body.message });

    // Shared scrubber — playground broadcasts token/done/error events
    // over WS. Under trace.redact we scrub content before broadcast so
    // WS subscribers (Studio UI, any filterTraceEvent consumer) never
    // see raw LLM output.
    const redactOn = runtime.isRedactEnabled();
    const broadcast = (event: StreamEvent) => {
      connMgr.broadcastWithWildcard(`execution:${executionId}`, redactStreamEvent(event, redactOn));
    };

    // Create a context wired to stream events to the WS channel
    const ctx = runtime.createContext({
      sessionHistory: history,
      onToken: (token: string) => {
        broadcast({ type: 'token', data: token });
      },
    });

    // Run the agent ask asynchronously, stream results via WS
    (async () => {
      try {
        const result = await ctx.ask(agent, body.message);
        const resultText = typeof result === 'string' ? result : JSON.stringify(result);

        // Save assistant response to session history — raw, because
        // redaction is an observability-boundary filter, not a data-at-
        // rest transform. The next playground turn needs the real text.
        history.push({ role: 'assistant', content: resultText });
        await store.saveSession(sessionId, history);

        broadcast({ type: 'done', data: resultText });
      } catch (err) {
        broadcast({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return c.json({
      ok: true,
      data: { sessionId, executionId, streaming: true },
    });
  });

  return app;
}
