import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent, tool, workflow } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import type { StreamEvent, TraceEvent } from '@axlsdk/axl';
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

  it('tool_call and tool_result events include callId for reliable matching', async () => {
    const lookupTool = tool({
      name: 'lookup',
      description: 'Look up a topic',
      input: z.object({ query: z.string() }),
      handler: (input) => `Result for: ${input.query}`,
    });

    const a = agent({
      name: 'multi-tool-agent',
      model: 'mock:test',
      system: 'Use lookup for each topic.',
      tools: [lookupTool],
    });

    const provider = MockProvider.sequence([
      // First response: two tool calls to the SAME tool with different args
      {
        content: '',
        tool_calls: [
          {
            id: 'call_aaa',
            type: 'function' as const,
            function: { name: 'lookup', arguments: JSON.stringify({ query: 'cats' }) },
          },
          {
            id: 'call_bbb',
            type: 'function' as const,
            function: { name: 'lookup', arguments: JSON.stringify({ query: 'dogs' }) },
          },
        ],
      },
      // Second response: final answer
      { content: 'Here are the results for cats and dogs.' },
    ]);

    const { runtime } = createTestRuntime(provider);
    const wf = workflow({
      name: 'callid-test-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const stream = runtime.stream('callid-test-wf', { message: 'Look up cats and dogs' });
    const allEvents: StreamEvent[] = [];
    for await (const event of stream) {
      allEvents.push(event);
      if (event.type === 'done') break;
    }

    // Both tool_call events should have distinct callIds
    const toolCallEvents = allEvents.filter((e) => e.type === 'tool_call') as Array<
      Extract<StreamEvent, { type: 'tool_call' }>
    >;
    expect(toolCallEvents).toHaveLength(2);
    expect(toolCallEvents[0].callId).toBe('call_aaa');
    expect(toolCallEvents[1].callId).toBe('call_bbb');
    expect(toolCallEvents[0].name).toBe('lookup');
    expect(toolCallEvents[1].name).toBe('lookup');

    // Both tool_result events should have matching callIds
    const toolResultEvents = allEvents.filter((e) => e.type === 'tool_result') as Array<
      Extract<StreamEvent, { type: 'tool_result' }>
    >;
    expect(toolResultEvents).toHaveLength(2);
    expect(toolResultEvents[0].callId).toBe('call_aaa');
    expect(toolResultEvents[1].callId).toBe('call_bbb');

    // Results should be correctly attributed
    expect(toolResultEvents[0].result).toBe('Result for: cats');
    expect(toolResultEvents[1].result).toBe('Result for: dogs');
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

  it('stream iterator yields serializable error event when workflow throws', async () => {
    const { runtime } = createTestRuntime();
    const wf = workflow({
      name: 'error-iter-wf',
      input: z.object({ message: z.string() }),
      handler: async () => {
        throw new Error('iterator error test');
      },
    });
    runtime.register(wf);

    const stream = runtime.stream('error-iter-wf', { message: 'hello' });
    // Prevent unhandled rejection from stream.promise
    stream.promise.catch(() => {});

    const allEvents: StreamEvent[] = [];
    for await (const event of stream) {
      allEvents.push(event);
    }

    // Should contain an error event with a serializable message
    const errorEvent = allEvents.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent).toEqual({ type: 'error', message: 'iterator error test' });

    // Error event should be JSON-serializable (no Error object)
    const serialized = JSON.parse(JSON.stringify(errorEvent));
    expect(serialized.message).toBe('iterator error test');
  });

  it('stream emits workflow_end with status completed on success', async () => {
    const provider = MockProvider.sequence([{ content: 'success' }]);
    const { runtime } = createTestRuntime(provider);
    const a = agent({ name: 'wf-end-agent', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'wf-end-stream-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const stream = runtime.stream('wf-end-stream-wf', { message: 'hello' });
    const allEvents: StreamEvent[] = [];
    for await (const event of stream) {
      allEvents.push(event);
      if (event.type === 'done') break;
    }

    const stepEvents = allEvents.filter((e) => e.type === 'step');
    const workflowEndStep = stepEvents.find((e) => {
      const data = (e as { data: TraceEvent }).data;
      return data.type === 'log' && (data.data as { event?: string })?.event === 'workflow_end';
    });
    expect(workflowEndStep).toBeDefined();

    const endData = (workflowEndStep as { data: TraceEvent }).data;
    expect((endData.data as { status?: string })?.status).toBe('completed');
  });

  it('stream emits workflow_end with status failed on error', async () => {
    const { runtime, traces } = createTestRuntime();
    const wf = workflow({
      name: 'wf-fail-stream-wf',
      input: z.object({ message: z.string() }),
      handler: async () => {
        throw new Error('intentional failure');
      },
    });
    runtime.register(wf);

    const stream = runtime.stream('wf-fail-stream-wf', { message: 'hello' });
    await expect(stream.promise).rejects.toThrow('intentional failure');

    // Verify workflow_end trace was emitted via the runtime trace listener
    const logTraces = traces.filter((t: TraceEvent) => t.type === 'log');
    const workflowEndTrace = logTraces.find(
      (t: TraceEvent) => (t.data as { event?: string })?.event === 'workflow_end',
    );
    expect(workflowEndTrace).toBeDefined();
    expect((workflowEndTrace!.data as { status?: string })?.status).toBe('failed');
    expect((workflowEndTrace!.data as { error?: string })?.error).toBe('intentional failure');
  });
});
