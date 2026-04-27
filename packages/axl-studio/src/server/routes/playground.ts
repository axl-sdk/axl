import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';
import type { ConnectionManager } from '../ws/connection-manager.js';
import { redactStreamEvent } from '../redact.js';
import type { AxlEvent } from '@axlsdk/axl';

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
    // Token events flow through emitEvent → runtime.emit('trace') → our listener below,
    // so no manual onToken needed.
    const ctx = runtime.createContext({ sessionHistory: history });
    const executionId = ctx.executionId;

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
        const result = await ctx.ask(agent, body.message);
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
