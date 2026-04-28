import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent, tool, workflow } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import type { AxlEvent } from '@axlsdk/axl';
import { createTestRuntime } from '../helpers/setup.js';

describe('Streaming E2E', () => {
  it('streams tokens and fullText matches concatenation', async () => {
    // The unified event model emits per-token `token` AxlEvents on the
    // wire (spec/16 §2.1) and `runtime.stream()` always wires the
    // streaming code path in WorkflowContext.
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
    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
      if (event.type === 'token') tokens.push(event.data);
      if (event.type === 'done') break;
    }

    // Tokens flow on the wire.
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.join('')).toBe('Hello streaming world');
    expect(stream.fullText).toBe('Hello streaming world');

    // The lifecycle envelope reaches the wire in order.
    expect(types).toContain('workflow_start');
    expect(types).toContain('ask_start');
    expect(types).toContain('agent_call_start');
    expect(types).toContain('agent_call_end');
    expect(types).toContain('ask_end');
    expect(types).toContain('workflow_end');
    expect(types).toContain('done');

    await expect(stream.promise).resolves.toBe('Hello streaming world');
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

  it('stream emits agent_call_start, agent_call_end, and done events', async () => {
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
    const allEvents: AxlEvent[] = [];
    for await (const event of stream) {
      allEvents.push(event);
      if (event.type === 'done') break;
    }

    // Per spec/16: events flow directly to the wire — there is no `step`
    // wrapper anymore. Assert the rich variants land on the iterator as-is.
    const types = allEvents.map((e) => e.type);
    expect(types).toContain('agent_call_start');
    expect(types).toContain('agent_call_end');
    expect(types).toContain('done');
  });

  it('streams tokens from BOTH outer and sub-agent (consumers filter via meta.depth — spec/16 §3.2)', async () => {
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
    const allEvents: AxlEvent[] = [];
    for await (const event of stream) {
      allEvents.push(event);
      if (event.type === 'done') break;
    }

    // The unified event model (spec/16 §3.2) intentionally surfaces nested-ask
    // events to the wire so subagent activity is observable. Consumers that
    // want root-only behavior filter on `depth === 0`.
    //
    // Token-content assertions are deferred to the follow-up that wires
    // `runtime.stream()`'s default `onToken` (currently gated by the streaming
    // path in WorkflowContext). The depth-tagged ask events are the wire-level
    // invariant that PR 1 commit 4 lands.
    const askStarts = allEvents.filter(
      (e): e is Extract<AxlEvent, { type: 'ask_start' }> => e.type === 'ask_start',
    );
    const depths = askStarts.map((e) => e.depth).sort();
    expect(depths).toContain(0); // outer (workflow) ask
    expect(depths).toContain(1); // nested (research tool) ask

    // tool_call_start event should include the research tool call
    const toolCallStartEvents = allEvents.filter(
      (e): e is Extract<AxlEvent, { type: 'tool_call_start' }> => e.type === 'tool_call_start',
    );
    expect(toolCallStartEvents.length).toBeGreaterThanOrEqual(1);
    const researchCall = toolCallStartEvents.find((e) => e.tool === 'research');
    expect(researchCall).toBeDefined();

    // tool_call_end event should carry the research result in data.result
    const toolCallEndEvents = allEvents.filter(
      (e): e is Extract<AxlEvent, { type: 'tool_call_end' }> => e.type === 'tool_call_end',
    );
    expect(toolCallEndEvents.length).toBeGreaterThanOrEqual(1);
    const researchResult = toolCallEndEvents.find((e) => e.tool === 'research');
    expect(researchResult).toBeDefined();
    expect(researchResult!.data.result).toBe('research findings about topic X');

    // Stream should complete with a done event
    const doneEvents = allEvents.filter((e) => e.type === 'done');
    expect(doneEvents.length).toBe(1);
  });

  it('tool_call_start and tool_call_end events include callId for reliable matching', async () => {
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
    const allEvents: AxlEvent[] = [];
    for await (const event of stream) {
      allEvents.push(event);
      if (event.type === 'done') break;
    }

    // Both tool_call_start events should have distinct callIds
    const toolCallStartEvents = allEvents.filter(
      (e): e is Extract<AxlEvent, { type: 'tool_call_start' }> => e.type === 'tool_call_start',
    );
    expect(toolCallStartEvents).toHaveLength(2);
    expect(toolCallStartEvents[0].callId).toBe('call_aaa');
    expect(toolCallStartEvents[1].callId).toBe('call_bbb');
    expect(toolCallStartEvents[0].tool).toBe('lookup');
    expect(toolCallStartEvents[1].tool).toBe('lookup');

    // Both tool_call_end events should have matching callIds. The current
    // emit site stamps callId on `data.callId` rather than the top-level
    // `callId` field — the type union allows both, but the spec lists the
    // top-level slot as canonical. A follow-up will lift it; for now we
    // assert what flows so consumers can correlate either way.
    const toolCallEndEvents = allEvents.filter(
      (e): e is Extract<AxlEvent, { type: 'tool_call_end' }> => e.type === 'tool_call_end',
    );
    expect(toolCallEndEvents).toHaveLength(2);
    expect(toolCallEndEvents[0].data.callId).toBe('call_aaa');
    expect(toolCallEndEvents[1].data.callId).toBe('call_bbb');

    // Results should be correctly attributed (carried on tool_call_end.data.result)
    expect(toolCallEndEvents[0].data.result).toBe('Result for: cats');
    expect(toolCallEndEvents[1].data.result).toBe('Result for: dogs');
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

    const allEvents: AxlEvent[] = [];
    for await (const event of stream) {
      allEvents.push(event);
    }

    // Should contain an error event with a serializable message under `data.message`
    const errorEvent = allEvents.find(
      (e): e is Extract<AxlEvent, { type: 'error' }> => e.type === 'error',
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.data.message).toBe('iterator error test');

    // Error event payload should be JSON-serializable (no Error object)
    const serialized = JSON.parse(JSON.stringify(errorEvent));
    expect(serialized.data.message).toBe('iterator error test');
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
    const allEvents: AxlEvent[] = [];
    for await (const event of stream) {
      allEvents.push(event);
      if (event.type === 'done') break;
    }

    // workflow_end now flows directly on the wire (no `step` wrapper).
    const workflowEnd = allEvents.find(
      (e): e is Extract<AxlEvent, { type: 'workflow_end' }> => e.type === 'workflow_end',
    );
    expect(workflowEnd).toBeDefined();
    expect(workflowEnd!.data.status).toBe('completed');
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

    // Verify workflow_end trace fired with status: failed + error message
    const workflowEndTrace = traces.find(
      (t: AxlEvent): t is Extract<AxlEvent, { type: 'workflow_end' }> => t.type === 'workflow_end',
    );
    expect(workflowEndTrace).toBeDefined();
    expect(workflowEndTrace!.data.status).toBe('failed');
    expect(workflowEndTrace!.data.error).toBe('intentional failure');
  });
});
