import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool, agent, workflow } from '@axlsdk/axl';
import { AxlTestRuntime, MockProvider } from '@axlsdk/testing';

describe('Cross-Package E2E', () => {
  it('AxlTestRuntime + MockProvider.sequence executes a real workflow', async () => {
    const greet = tool({
      name: 'greet',
      description: 'Greet a person',
      input: z.object({ name: z.string() }),
      handler: (input) => `Hello, ${input.name}!`,
    });

    const a = agent({
      name: 'cross-agent',
      model: 'mock:test',
      system: 'You greet people.',
      tools: [greet],
    });

    const wf = workflow({
      name: 'cross-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });

    const testRuntime = new AxlTestRuntime();
    testRuntime.register(wf);
    testRuntime.mockProvider(
      'mock',
      MockProvider.sequence([
        {
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'greet', arguments: JSON.stringify({ name: 'World' }) },
            },
          ],
        },
        { content: 'The greeting was: Hello, World!' },
      ]),
    );

    const result = await testRuntime.execute('cross-wf', { message: 'greet world' });
    expect(result).toBe('The greeting was: Hello, World!');
  });

  it('MockProvider.echo through full test runtime execution', async () => {
    const a = agent({ name: 'echo-agent', model: 'mock:test', system: 'Echo back.' });
    const wf = workflow({
      name: 'echo-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });

    const testRuntime = new AxlTestRuntime();
    testRuntime.register(wf);
    testRuntime.mockProvider('mock', MockProvider.echo());

    const result = await testRuntime.execute('echo-wf', { message: 'testing echo' });
    expect(typeof result).toBe('string');
  });

  it('runtime.toolCalls() and runtime.agentCalls() return correct data', async () => {
    const greet = tool({
      name: 'greet',
      description: 'Greet',
      input: z.object({ name: z.string() }),
      handler: (input) => `Hello, ${input.name}!`,
    });

    const a = agent({
      name: 'recorded-agent',
      model: 'mock:test',
      system: 'test',
      tools: [greet],
    });

    const wf = workflow({
      name: 'recorded-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });

    const testRuntime = new AxlTestRuntime();
    testRuntime.register(wf);
    testRuntime.mockProvider(
      'mock',
      MockProvider.sequence([
        {
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'greet', arguments: JSON.stringify({ name: 'Test' }) },
            },
          ],
        },
        { content: 'done' },
      ]),
    );

    await testRuntime.execute('recorded-wf', { message: 'test' });

    const toolCalls = testRuntime.toolCalls();
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('greet');
    expect(toolCalls[0].result).toBe('Hello, Test!');

    const agentCalls = testRuntime.agentCalls();
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);
    expect(agentCalls[0].agent).toBe('recorded-agent');
  });

  it('MockTool overrides replace real tool handlers', async () => {
    const greet = tool({
      name: 'greet',
      description: 'Greet',
      input: z.object({ name: z.string() }),
      handler: (input) => `Hello, ${input.name}!`,
    });

    const a = agent({
      name: 'override-agent',
      model: 'mock:test',
      system: 'test',
      tools: [greet],
    });

    const wf = workflow({
      name: 'override-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });

    const testRuntime = new AxlTestRuntime();
    testRuntime.register(wf);
    testRuntime.mockProvider(
      'mock',
      MockProvider.sequence([
        {
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'greet', arguments: JSON.stringify({ name: 'Override' }) },
            },
          ],
        },
        { content: 'done' },
      ]),
    );

    // Override the greet tool with a mock
    testRuntime.mockTool('greet', () => 'Mocked greeting!');

    await testRuntime.execute('override-wf', { message: 'test' });

    const toolCalls = testRuntime.toolCalls();
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].result).toBe('Mocked greeting!');
  });
});
