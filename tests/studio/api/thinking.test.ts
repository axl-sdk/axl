import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AxlRuntime, agent, tool, workflow } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createServer } from '@axlsdk/studio';
import { readJson } from '../helpers/json.js';

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

  const effortAgent = agent({
    name: 'effort-agent',
    model: 'mock:test',
    system: 'You think deeply.',
    tools: [greet],
    effort: 'high',
    temperature: 0.3,
    maxTokens: 2048,
  });

  const budgetAgent = agent({
    name: 'budget-agent',
    model: 'mock:test',
    system: 'You think with a budget.',
    thinkingBudget: 5000,
  });

  const maxAgent = agent({
    name: 'max-agent',
    model: 'mock:test',
    system: 'You think maximally.',
    effort: 'max',
  });

  runtime.registerTool(greet);
  runtime.registerAgent(effortAgent);
  runtime.registerAgent(budgetAgent);
  runtime.registerAgent(maxAgent);

  const wf = workflow({
    name: 'test-wf',
    input: z.object({ message: z.string() }),
    handler: async (ctx) => ctx.ask(effortAgent, ctx.input.message),
  });
  runtime.register(wf);

  const { app } = createServer({ runtime });
  return { app, runtime };
}

describe('Studio API: Thinking', () => {
  it('GET /api/agents lists agents with effort field', async () => {
    const { app } = createThinkingTestServer();
    const res = await app.request('/api/agents');
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);

    const effortAgent = body.data.find((a: any) => a.name === 'effort-agent');
    expect(effortAgent).toBeDefined();
    expect(effortAgent.effort).toBe('high');
    expect(effortAgent.temperature).toBe(0.3);
    expect(effortAgent.maxTokens).toBe(2048);
  });

  it('GET /api/agents lists agents with thinkingBudget field', async () => {
    const { app } = createThinkingTestServer();
    const res = await app.request('/api/agents');
    const body = await readJson(res);

    const budgetAgent = body.data.find((a: any) => a.name === 'budget-agent');
    expect(budgetAgent).toBeDefined();
    expect(budgetAgent.thinkingBudget).toBe(5000);
  });

  it('GET /api/agents/:name returns effort in agent detail', async () => {
    const { app } = createThinkingTestServer();
    const res = await app.request('/api/agents/effort-agent');
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('effort-agent');
    expect(body.data.effort).toBe('high');
  });

  it('GET /api/agents/:name returns thinkingBudget in agent detail', async () => {
    const { app } = createThinkingTestServer();
    const res = await app.request('/api/agents/budget-agent');
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.thinkingBudget).toBe(5000);
  });

  it('GET /api/agents lists agents with effort "max"', async () => {
    const { app } = createThinkingTestServer();
    const res = await app.request('/api/agents');
    const body = await readJson(res);

    const maxAgent = body.data.find((a: any) => a.name === 'max-agent');
    expect(maxAgent).toBeDefined();
    expect(maxAgent.effort).toBe('max');
  });

  it('GET /api/agents/:name returns effort "max" in agent detail', async () => {
    const { app } = createThinkingTestServer();
    const res = await app.request('/api/agents/max-agent');
    expect(res.status).toBe(200);

    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.data.effort).toBe('max');
  });

  it('agents without effort return undefined for effort field', async () => {
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
    const body = await readJson(res);

    const a = body.data.find((a: any) => a.name === 'plain-agent');
    expect(a).toBeDefined();
    expect(a.effort).toBeUndefined();
    expect(a.thinkingBudget).toBeUndefined();
  });
});
