import { Hono } from 'hono';
import { zodToJsonSchema } from '@axlsdk/axl';
import type { StudioEnv, ToolSummary } from '../types.js';

const app = new Hono<StudioEnv>();

// List all tools
app.get('/tools', (c) => {
  const runtime = c.get('runtime');
  const tools: ToolSummary[] = runtime.getTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema ? zodToJsonSchema(t.inputSchema) : {},
    sensitive: t.sensitive ?? false,
    requireApproval: t.requireApproval ?? false,
  }));
  return c.json({ ok: true, data: tools });
});

// Get tool detail
app.get('/tools/:name', (c) => {
  const runtime = c.get('runtime');
  const name = c.req.param('name');
  const tool = runtime.getTool(name);
  if (!tool) {
    return c.json(
      { ok: false, error: { code: 'NOT_FOUND', message: `Tool "${name}" not found` } },
      404,
    );
  }

  return c.json({
    ok: true,
    data: {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ? zodToJsonSchema(tool.inputSchema) : {},
      sensitive: tool.sensitive,
      requireApproval: tool.requireApproval,
      retry: tool.retry,
      hasHooks: !!tool.hooks,
      hooks: tool.hooks
        ? {
            hasBefore: !!tool.hooks.before,
            hasAfter: !!tool.hooks.after,
          }
        : null,
    },
  });
});

// Test a tool directly
app.post('/tools/:name/test', async (c) => {
  const runtime = c.get('runtime');
  const name = c.req.param('name');
  const tool = runtime.getTool(name);
  if (!tool) {
    return c.json(
      { ok: false, error: { code: 'NOT_FOUND', message: `Tool "${name}" not found` } },
      404,
    );
  }

  const body = await c.req.json<{ input: unknown }>();
  const result = await tool._execute(body.input);
  return c.json({ ok: true, data: { result } });
});

export default app;
