import { Hono } from 'hono';
import { zodToJsonSchema } from '@axlsdk/axl';
import type { StudioEnv, AgentSummary } from '../types.js';

const app = new Hono<StudioEnv>();

// List all agents
app.get('/agents', (c) => {
  const runtime = c.get('runtime');
  const agents: AgentSummary[] = runtime.getAgents().map((a) => ({
    name: a._name,
    model: a.resolveModel(),
    system: a.resolveSystem(),
    tools: a._config.tools?.map((t) => t.name) ?? [],
    handoffs:
      typeof a._config.handoffs === 'function'
        ? ['(dynamic)']
        : (a._config.handoffs?.map((h) => h.agent._name) ?? []),
    maxTurns: a._config.maxTurns,
    temperature: a._config.temperature,
    maxTokens: a._config.maxTokens,
    thinking: a._config.thinking,
    reasoningEffort: a._config.reasoningEffort,
    toolChoice: a._config.toolChoice,
    stop: a._config.stop,
  }));
  return c.json({ ok: true, data: agents });
});

// Get agent detail
app.get('/agents/:name', (c) => {
  const runtime = c.get('runtime');
  const name = c.req.param('name');
  const agent = runtime.getAgent(name);
  if (!agent) {
    return c.json(
      { ok: false, error: { code: 'NOT_FOUND', message: `Agent "${name}" not found` } },
      404,
    );
  }

  const cfg = agent._config;
  return c.json({
    ok: true,
    data: {
      name: agent._name,
      model: agent.resolveModel(),
      system: agent.resolveSystem(),
      tools:
        cfg.tools?.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: zodToJsonSchema(t.inputSchema),
        })) ?? [],
      handoffs:
        typeof cfg.handoffs === 'function'
          ? [
              {
                agent: '(dynamic)',
                description: 'Resolved at runtime from metadata',
                mode: 'oneway' as const,
              },
            ]
          : (cfg.handoffs?.map((h) => ({
              agent: h.agent._name,
              description: h.description,
              mode: h.mode ?? 'oneway',
            })) ?? []),
      maxTurns: cfg.maxTurns,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      thinking: cfg.thinking,
      reasoningEffort: cfg.reasoningEffort,
      toolChoice: cfg.toolChoice,
      stop: cfg.stop,
      timeout: cfg.timeout,
      maxContext: cfg.maxContext,
      version: cfg.version,
      mcp: cfg.mcp,
      mcpTools: cfg.mcpTools,
      hasGuardrails: !!cfg.guardrails,
      guardrails: cfg.guardrails
        ? {
            hasInput: !!cfg.guardrails.input,
            hasOutput: !!cfg.guardrails.output,
            onBlock: cfg.guardrails.onBlock ?? 'throw',
            maxRetries: cfg.guardrails.maxRetries,
          }
        : null,
    },
  });
});

export default app;
