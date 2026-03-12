import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent, tool, workflow } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import type { StreamEvent } from '@axlsdk/axl';
import { createTestRuntime } from '../helpers/setup.js';

describe('Streaming E2E', () => {
  it('streams tokens and fullText matches concatenation', async () => {
    const provider = MockProvider.sequence([{ content: 'Hello streaming world' }]);
    const { runtime } = createTestRuntime(provider);
    const a = agent({ name: 'stream-agent', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'stream-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const stream = runtime.stream('stream-wf', { message: 'hello' });
    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data);
      if (event.type === 'done') break;
    }

    expect(tokens.length).toBeGreaterThan(0);
    expect(stream.fullText).toBe(tokens.join(''));
  });

  it('stream.promise resolves with workflow output', async () => {
    const provider = MockProvider.sequence([{ content: 'promise result' }]);
    const { runtime } = createTestRuntime(provider);
    const a = agent({ name: 'promise-agent', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'promise-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const stream = runtime.stream('promise-wf', { message: 'hello' });
    const result = await stream.promise;
    expect(result).toBe('promise result');
  });

  it('stream emits agent_start, step, and done events', async () => {
    const provider = MockProvider.sequence([{ content: 'streamed result' }]);
    const { runtime } = createTestRuntime(provider);
    const a = agent({
      name: 'step-stream-agent',
      model: 'mock:test',
      system: 'test',
    });
    const wf = workflow({
      name: 'step-stream-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const stream = runtime.stream('step-stream-wf', { message: 'hello' });
    const allEvents: StreamEvent[] = [];
    for await (const event of stream) {
      allEvents.push(event);
      if (event.type === 'done') break;
    }

    const types = allEvents.map((e) => e.type);
    expect(types).toContain('agent_start');
    expect(types).toContain('step'); // agent_call trace is emitted as a step event
    expect(types).toContain('done');

    // Verify the step event contains an agent_call trace
    const stepEvents = allEvents.filter((e) => e.type === 'step');
    const agentCallStep = stepEvents.find(
      (e) => (e as { data: { type?: string } }).data?.type === 'agent_call',
    );
    expect(agentCallStep).toBeDefined();
  });

  it('streams tokens only from outer agent, not from sub-agent in tool handler', async () => {
    const researcher = agent({
      name: 'researcher',
      model: 'mock:researcher',
      system: 'You are a research assistant.',
    });

    const researchTool = tool({
      name: 'research',
      description: 'Research a topic using a sub-agent',
      input: z.object({ query: z.string() }),
      handler: async (input, ctx) => {
        const result = await ctx.ask(researcher, input.query);
        return result;
      },
    });

    const coordinator = agent({
      name: 'coordinator',
      model: 'mock:coordinator',
      system: 'You coordinate research tasks.',
      tools: [researchTool],
    });

    const provider = MockProvider.sequence([
      // First call (coordinator): return a tool_call for the research tool
      {
        content: '',
        tool_calls: [
          {
            id: 'call_research_1',
            type: 'function' as const,
            function: {
              name: 'research',
              arguments: JSON.stringify({ query: 'topic X' }),
            },
          },
        ],
      },
      // Second call (researcher sub-agent): return research findings
      { content: 'research findings about topic X' },
      // Third call (coordinator): return final answer incorporating tool result
      { content: 'Based on my research: final answer' },
    ]);

    const { runtime } = createTestRuntime(provider);

    const wf = workflow({
      name: 'nested-agent-stream-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(coordinator, ctx.input.message),
    });
    runtime.register(wf);

    const stream = runtime.stream('nested-agent-stream-wf', {
      message: 'Research topic X',
    });
    const allEvents: StreamEvent[] = [];
    for await (const event of stream) {
      allEvents.push(event);
      if (event.type === 'done') break;
    }

    // Token events should only contain text from the coordinator's final response
    const tokenEvents = allEvents.filter((e) => e.type === 'token');
    const streamedText = tokenEvents.map((e) => (e as { data: string }).data).join('');
    expect(streamedText).toBe('Based on my research: final answer');
    expect(streamedText).not.toContain('research findings about topic X');

    // tool_call event should include the research tool call
    const toolCallEvents = allEvents.filter((e) => e.type === 'tool_call');
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
    const researchCall = toolCallEvents.find((e) => (e as { name: string }).name === 'research');
    expect(researchCall).toBeDefined();

    // tool_result event should include the research result
    const toolResultEvents = allEvents.filter((e) => e.type === 'tool_result');
    expect(toolResultEvents.length).toBeGreaterThanOrEqual(1);
    const researchResult = toolResultEvents.find(
      (e) => (e as { name: string }).name === 'research',
    );
    expect(researchResult).toBeDefined();
    expect((researchResult as { result: unknown }).result).toBe('research findings about topic X');

    // Stream should complete with a done event
    const doneEvents = allEvents.filter((e) => e.type === 'done');
    expect(doneEvents.length).toBe(1);
  });

  it('stream rejects with error when workflow throws', async () => {
    const { runtime } = createTestRuntime();
    const wf = workflow({
      name: 'error-stream-wf',
      input: z.object({ message: z.string() }),
      handler: async () => {
        throw new Error('workflow failed');
      },
    });
    runtime.register(wf);

    const stream = runtime.stream('error-stream-wf', { message: 'hello' });
    await expect(stream.promise).rejects.toThrow('workflow failed');
  });
});
