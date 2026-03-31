import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent, workflow } from '@axlsdk/axl';
import type { TraceEvent } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createTestRuntime, testWorkflow, greetTool } from '../helpers/setup.js';

describe('Basic Workflow E2E', () => {
  it('defines tool + agent + workflow, executes, and returns string result', async () => {
    const provider = MockProvider.sequence([{ content: 'The answer is 42.' }]);
    const { runtime } = createTestRuntime(provider);
    const wf = testWorkflow();
    runtime.register(wf);

    const result = await runtime.execute('test-wf', { message: 'What is the answer?' });
    expect(result).toBe('The answer is 42.');
  });

  it('agent calls a tool and returns final answer including tool output', async () => {
    const provider = MockProvider.sequence([
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
      { content: 'The greeting is: Hello, World!' },
    ]);

    const { runtime } = createTestRuntime(provider);
    const a = agent({
      name: 'greeter-agent',
      model: 'mock:test',
      system: 'You greet people.',
      tools: [greetTool],
    });
    const wf = workflow({
      name: 'greet-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const result = await runtime.execute('greet-wf', { message: 'Greet World' });
    expect(result).toBe('The greeting is: Hello, World!');
  });

  it('registers and executes multiple workflows independently', async () => {
    const provider = MockProvider.fn((_msgs, callIndex) => ({
      content: callIndex === 0 ? 'first' : 'second',
    }));
    const { runtime } = createTestRuntime(provider);

    const wf1 = workflow({
      name: 'wf-1',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => {
        const a = agent({ name: 'a1', model: 'mock:test', system: 'Agent 1' });
        return ctx.ask(a, ctx.input.message);
      },
    });
    const wf2 = workflow({
      name: 'wf-2',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => {
        const a = agent({ name: 'a2', model: 'mock:test', system: 'Agent 2' });
        return ctx.ask(a, ctx.input.message);
      },
    });
    runtime.register(wf1);
    runtime.register(wf2);

    const r1 = await runtime.execute('wf-1', { message: 'hi' });
    const r2 = await runtime.execute('wf-2', { message: 'hi' });
    expect(r1).toBe('first');
    expect(r2).toBe('second');
  });

  it('rejects invalid input with Zod error', async () => {
    const { runtime } = createTestRuntime();
    const wf = testWorkflow();
    runtime.register(wf);

    await expect(runtime.execute('test-wf', { wrong: 'field' })).rejects.toThrow();
  });

  it('validates and coerces output with output schema', async () => {
    const provider = MockProvider.sequence([{ content: '42' }]);
    const { runtime } = createTestRuntime(provider);

    const wf = workflow({
      name: 'coerce-wf',
      input: z.object({ message: z.string() }),
      output: z.coerce.number(),
      handler: async (ctx) => {
        const a = agent({ name: 'num-agent', model: 'mock:test', system: 'Return numbers.' });
        return ctx.ask(a, ctx.input.message);
      },
    });
    runtime.register(wf);

    const result = await runtime.execute('coerce-wf', { message: 'give me a number' });
    expect(result).toBe(42);
    expect(typeof result).toBe('number');
  });

  it('emits trace events: log(workflow_start), agent_call, log(workflow_end)', async () => {
    const provider = MockProvider.sequence([{ content: 'done' }]);
    const { runtime, traces } = createTestRuntime(provider);
    const wf = testWorkflow();
    runtime.register(wf);

    await runtime.execute('test-wf', { message: 'hello' });

    const types = traces.map((t) => t.type);
    expect(types).toContain('log'); // workflow_start and workflow_end are emitted as 'log' type
    expect(types).toContain('agent_call');

    // Verify workflow_start and workflow_end exist as log events
    const logEvents = traces.filter((t) => t.type === 'log');
    const logData = logEvents.map((t) => (t.data as { event?: string })?.event);
    expect(logData).toContain('workflow_start');
    expect(logData).toContain('workflow_end');
  });

  it('passes metadata through to context', async () => {
    let receivedMeta: Record<string, unknown> | undefined;
    const provider = MockProvider.sequence([{ content: 'ok' }]);
    const { runtime } = createTestRuntime(provider);

    const wf = workflow({
      name: 'meta-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => {
        receivedMeta = ctx.metadata;
        const a = agent({ name: 'meta-agent', model: 'mock:test', system: 'test' });
        return ctx.ask(a, ctx.input.message);
      },
    });
    runtime.register(wf);

    await runtime.execute('meta-wf', { message: 'hi' }, { metadata: { userId: '123' } });
    expect(receivedMeta).toBeDefined();
    expect(receivedMeta!.userId).toBe('123');
  });

  it('agent_call trace step includes tokens from provider usage', async () => {
    const provider = MockProvider.replay([
      {
        content: 'response with usage',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          reasoning_tokens: 10,
        },
        cost: 0.01,
      },
    ]);
    const { runtime, traces } = createTestRuntime(provider);
    const a = agent({ name: 'token-agent', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'token-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    await runtime.execute('token-wf', { message: 'hello' });

    const agentCall = traces.find((t: TraceEvent) => t.type === 'agent_call');
    expect(agentCall).toBeDefined();
    expect(agentCall!.tokens).toEqual({ input: 100, output: 50, reasoning: 10 });
  });

  it('agent_call trace step has undefined tokens when provider returns no usage', async () => {
    const provider = MockProvider.replay([
      {
        content: 'response without usage',
      },
    ]);
    const { runtime, traces } = createTestRuntime(provider);
    const a = agent({ name: 'no-usage-agent', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'no-usage-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    await runtime.execute('no-usage-wf', { message: 'hello' });

    const agentCall = traces.find((t: TraceEvent) => t.type === 'agent_call');
    expect(agentCall).toBeDefined();
    expect(agentCall!.tokens).toBeUndefined();
  });
});
