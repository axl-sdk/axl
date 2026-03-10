import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AxlRuntime, agent, tool, workflow } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createServer } from '@axlsdk/studio';

function createThinkingTestServer() {
  const runtime = new AxlRuntime();
  const provider = MockProvider.echo();
  runtime.registerProvider('mock', provider);

  const greet = tool({
    name: 'greet',
    description: 'Greet someone',
    input: z.object({ name: z.string() }),
    handler: (input) => `Hello, ${input.name}!`,
  });

  const thinkingAgent = agent({
    name: 'thinking-agent',
    model: 'mock:test',
    system: 'You think deeply.',
    tools: [greet],
    thinking: 'high',
    temperature: 0.3,
    maxTokens: 2048,
  });

  const budgetAgent = agent({
    name: 'budget-agent',
    model: 'mock:test',
    system: 'You think with a budget.',
    thinking: { budgetTokens: 5000 },
  });

  const maxAgent = agent({
    name: 'max-agent',
    model: 'mock:test',
    system: 'You think maximally.',
    thinking: 'max',
  });

  runtime.registerTool(greet);
  runtime.registerAgent(thinkingAgent);
  runtime.registerAgent(budgetAgent);
  runtime.registerAgent(maxAgent);

  const wf = workflow({
    name: 'test-wf',
    input: z.object({ message: z.string() }),
    handler: async (ctx) => ctx.ask(thinkingAgent, ctx.input.message),
  });
  runtime.register(wf);

  const { app } = createServer({ runtime });
  return { app, runtime };
}

describe('Studio API: Thinking', () => {
  it('GET /api/agents lists agents with thinking field (string form)', async () => {
    const { app } = createThinkingTestServer();
    const res = await app.request('/api/agents');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);

    const thinkingAgent = body.data.find((a: any) => a.name === 'thinking-agent');
    expect(thinkingAgent).toBeDefined();
    expect(thinkingAgent.thinking).toBe('high');
    expect(thinkingAgent.temperature).toBe(0.3);
    expect(thinkingAgent.maxTokens).toBe(2048);
  });

  it('GET /api/agents lists agents with thinking field (budget form)', async () => {
    const { app } = createThinkingTestServer();
    const res = await app.request('/api/agents');
    const body = await res.json();

    const budgetAgent = body.data.find((a: any) => a.name === 'budget-agent');
    expect(budgetAgent).toBeDefined();
    expect(budgetAgent.thinking).toEqual({ budgetTokens: 5000 });
  });

  it('GET /api/agents/:name returns thinking in agent detail', async () => {
    const { app } = createThinkingTestServer();
    const res = await app.request('/api/agents/thinking-agent');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('thinking-agent');
    expect(body.data.thinking).toBe('high');
  });

  it('GET /api/agents/:name returns budget thinking in agent detail', async () => {
    const { app } = createThinkingTestServer();
    const res = await app.request('/api/agents/budget-agent');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.thinking).toEqual({ budgetTokens: 5000 });
  });

  it('GET /api/agents lists agents with thinking "max"', async () => {
    const { app } = createThinkingTestServer();
    const res = await app.request('/api/agents');
    const body = await res.json();

    const maxAgent = body.data.find((a: any) => a.name === 'max-agent');
    expect(maxAgent).toBeDefined();
    expect(maxAgent.thinking).toBe('max');
  });

  it('GET /api/agents/:name returns thinking "max" in agent detail', async () => {
    const { app } = createThinkingTestServer();
    const res = await app.request('/api/agents/max-agent');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.thinking).toBe('max');
  });

  it('agents without thinking return undefined for thinking field', async () => {
    const runtime = new AxlRuntime();
    runtime.registerProvider('mock', MockProvider.echo());

    const plainAgent = agent({
      name: 'plain-agent',
      model: 'mock:test',
      system: 'No thinking.',
    });
    runtime.registerAgent(plainAgent);

    const { app } = createServer({ runtime });
    const res = await app.request('/api/agents');
    const body = await res.json();

    const a = body.data.find((a: any) => a.name === 'plain-agent');
    expect(a).toBeDefined();
    expect(a.thinking).toBeUndefined();
  });
});
