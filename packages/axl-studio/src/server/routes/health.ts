import { Hono } from 'hono';
import type { StudioEnv } from '../types.js';

const app = new Hono<StudioEnv>();

app.get('/health', (c) => {
  const runtime = c.get('runtime');
  return c.json({
    ok: true,
    data: {
      status: 'healthy',
      workflows: runtime.getWorkflowNames().length,
      agents: runtime.getAgents().length,
      tools: runtime.getTools().length,
    },
  });
});

export default app;
