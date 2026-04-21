import { Hono } from 'hono';
import { zodToJsonSchema } from '@axlsdk/axl';
import type { StudioEnv, WorkflowSummary } from '../types.js';
import type { ConnectionManager } from '../ws/connection-manager.js';
import { redactStreamEvent, redactValue } from '../redact.js';

export function createWorkflowRoutes(connMgr: ConnectionManager) {
  const app = new Hono<StudioEnv>();

  // List all workflows
  app.get('/workflows', (c) => {
    const runtime = c.get('runtime');
    const workflows: WorkflowSummary[] = runtime.getWorkflows().map((w) => ({
      name: w.name,
      hasInputSchema: !!w.inputSchema,
      hasOutputSchema: !!w.outputSchema,
    }));
    return c.json({ ok: true, data: workflows });
  });

  // Get workflow detail (including schemas)
  app.get('/workflows/:name', (c) => {
    const runtime = c.get('runtime');
    const name = c.req.param('name');
    const workflow = runtime.getWorkflow(name);
    if (!workflow) {
      return c.json(
        { ok: false, error: { code: 'NOT_FOUND', message: `Workflow "${name}" not found` } },
        404,
      );
    }

    return c.json({
      ok: true,
      data: {
        name: workflow.name,
        inputSchema: workflow.inputSchema ? zodToJsonSchema(workflow.inputSchema) : null,
        outputSchema: workflow.outputSchema ? zodToJsonSchema(workflow.outputSchema) : null,
      },
    });
  });

  // Execute a workflow
  app.post('/workflows/:name/execute', async (c) => {
    const runtime = c.get('runtime');
    const name = c.req.param('name');

    const workflow = runtime.getWorkflow(name);
    if (!workflow) {
      return c.json(
        { ok: false, error: { code: 'NOT_FOUND', message: `Workflow "${name}" not found` } },
        404,
      );
    }

    const body = await c.req.json<{
      input?: unknown;
      stream?: boolean;
      metadata?: Record<string, unknown>;
    }>();

    if (body.stream) {
      // Streaming execution — pipe events to WS channel. Under
      // `trace.redact`, scrub each StreamEvent before broadcast so
      // token deltas, tool args/results, and the final `done.data`
      // don't leak raw LLM/user content to WS subscribers.
      // TODO(PR-3-spec-16): the wire emits AxlEvent directly after PR 3 and
      // `redactStreamEvent` is replaced with an AxlEvent-aware scrubber.
      const stream = runtime.stream(name, body.input ?? {}, { metadata: body.metadata });
      const executionId = `stream-${Date.now()}`;
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
    }

    const result = await runtime.execute(name, body.input ?? {}, { metadata: body.metadata });
    return c.json({
      ok: true,
      data: { result: redactValue(result, runtime.isRedactEnabled()) },
    });
  });

  return app;
}
