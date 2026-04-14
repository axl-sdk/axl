import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';

export function createHealthRoutes(readOnly: boolean) {
  const app = new Hono<StudioEnv>();

  app.get('/health', (c) => {
    const runtime = c.get('runtime');
    return c.json({
      ok: true,
      data: {
        status: 'healthy',
        readOnly,
        workflows: runtime.getWorkflowNames().length,
        agents: runtime.getAgents().length,
        tools: runtime.getTools().length,
      },
    });
  });

  return app;
}
