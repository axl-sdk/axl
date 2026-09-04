import { describe, it, expect } from 'vitest';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { z } from 'zod';
import { createSequenceProvider, createTestCtx } from './helpers.js';
import type { Provider } from '../providers/types.js';
import type { SpanHandle, SpanManager } from '../telemetry/types.js';

type RecordedSpan = {
  name: string;
  attributes: Record<string, string | number | boolean>;
  parent?: RecordedSpan;
};

class NestingSpanManager implements SpanManager {
  readonly spans: RecordedSpan[] = [];
  private active?: RecordedSpan;

  async withSpanAsync<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    const parent = this.active;
    const record: RecordedSpan = {
      name,
      attributes: { ...attributes },
      ...(parent ? { parent } : {}),
    };
    this.spans.push(record);
    this.active = record;
    const span: SpanHandle = {
      setAttribute: (key, value) => {
        record.attributes[key] = value;
      },
      addEvent: () => undefined,
      setStatus: () => undefined,
      end: () => undefined,
    };
    try {
      return await fn(span);
    } finally {
      this.active = parent;
    }
  }

  addEventToActiveSpan(): void {}
  async shutdown(): Promise<void> {}
}

describe('child context', () => {
  it('createChildContext() isolates session history', async () => {
    // Parent context with pre-existing session history
    const { ctx } = createTestCtx({
      sessionHistory: [
        { role: 'user' as const, content: 'Hello from parent' },
        { role: 'assistant' as const, content: 'Hi there' },
      ],
    });

    const child = ctx.createChildContext();

    // The child should have an isolated (empty) session history.
    // We verify by having the child make an agent call and checking that the
    // messages sent to the provider do NOT include the parent's history.
    let capturedMessages: Array<{ role: string; content: string }> = [];
    const captureProvider: Provider = {
      name: 'mock',
      chat: async (messages) => {
        capturedMessages = messages.map((m) => ({ role: m.role, content: m.content }));
        return {
          content: 'child response',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          cost: 0.001,
        };
      },
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    };

    // Register the capture provider in the child's registry
    child['providerRegistry'].registerInstance('capture', captureProvider);

    const childAgent = agent({
      name: 'child_agent',
      model: 'capture:test',
      system: 'You are a child agent.',
    });

    await child.ask(childAgent, 'child question');

    // Parent history messages should NOT appear in the captured messages
    const userMessages = capturedMessages.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe('child question');
    expect(capturedMessages.find((m) => m.content === 'Hello from parent')).toBeUndefined();
  });

  it('createChildContext() shares budget tracking', async () => {
    // Create a parent with a budget context
    const budgetContext = {
      totalCost: 0,
      limit: 1.0,
      exceeded: false,
      policy: 'finish_and_stop',
    };

    const { ctx } = createTestCtx({ budgetContext });
    const child = ctx.createChildContext();

    // The child should share the same budgetContext reference.
    // Make a call with the child; cost should accumulate in the shared budget.
    const childAgent = agent({
      name: 'budget_child',
      model: 'mock:test',
      system: 'You are a child.',
    });

    await child.ask(childAgent, 'do something');

    // The provider returns cost: 0.001 per call, so budget should reflect that
    expect(budgetContext.totalCost).toBeGreaterThan(0);

    // The parent's getBudgetStatus should also reflect the child's spending
    const parentBudget = ctx.getBudgetStatus();
    expect(parentBudget).not.toBeNull();
    expect(parentBudget!.spent).toBe(budgetContext.totalCost);
  });

  it('createChildContext() shares trace emission', async () => {
    const { ctx, traces } = createTestCtx();
    const child = ctx.createChildContext();

    const childAgent = agent({
      name: 'traced_child',
      model: 'mock:test',
      system: 'You are a child.',
    });

    await child.ask(childAgent, 'trace me');

    // Traces from the child's agent call should appear in the parent's trace array
    const agentCallTraces = traces.filter((t) => t.type === 'agent_call_end');
    expect(agentCallTraces.length).toBeGreaterThanOrEqual(1);
    expect(agentCallTraces.some((t) => t.agent === 'traced_child')).toBe(true);
  });

  it('createChildContext() shares stream-first agent events', async () => {
    const { ctx } = createTestCtx();
    const agentStartInvocations: { agent: string; depth: number }[] = [];
    ctx.events.on('agent_call_start', (event) => {
      agentStartInvocations.push({ agent: event.agent, depth: event.depth });
    });

    const child = ctx.createChildContext();

    const childAgent = agent({
      name: 'streaming_child',
      model: 'mock:test',
      system: 'You are a child.',
    });

    await child.ask(childAgent, 'hello');

    // The parent observer sees the child ask and can filter by depth.
    expect(agentStartInvocations.length).toBeGreaterThan(0);
    expect(agentStartInvocations[0].agent).toBe('streaming_child');
    // Depth is 0 because the child ctx is invoked outside any parent ask;
    // this is the root ask of that child.
    expect(agentStartInvocations[0].depth).toBe(0);
  });

  it('agent-as-tool pattern: tool handler can invoke sub-agent via ctx.ask()', async () => {
    // Define a sub-agent that will be called from within a tool handler
    const subAgent = agent({
      name: 'sub_agent',
      model: 'mock:test',
      system: 'You are a specialist sub-agent.',
    });

    // Define a tool whose handler invokes the sub-agent via ctx.ask()
    const agentTool = tool({
      name: 'ask_specialist',
      description: 'Ask a specialist sub-agent a question',
      input: z.object({ question: z.string() }),
      handler: async (input, ctx) => {
        const answer = await ctx.ask(subAgent, input.question);
        return answer;
      },
    });

    // Define an outer agent that uses the tool
    const outerAgent = agent({
      name: 'outer_agent',
      model: 'mock:test',
      system: 'You coordinate work.',
      tools: [agentTool],
    });

    // Provider sequence:
    // Call 1 (outer agent): returns tool_call to ask_specialist
    // Call 2 (sub-agent, invoked by tool handler): returns "specialist answer"
    // Call 3 (outer agent, after tool result): returns final text
    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'ask_specialist',
              arguments: '{"question":"What is the answer?"}',
            },
          },
        ],
      },
      'specialist answer',
      'Final result: specialist answer',
    ]);

    const spanManager = new NestingSpanManager();
    const { ctx, traces } = createTestCtx({ provider, spanManager });
    const result = await ctx.ask(outerAgent, 'Coordinate this task');

    expect(result).toBe('Final result: specialist answer');
    expect(traces.filter((event) => event.type === 'ask_start')).toHaveLength(2);
    expect(traces.filter((event) => event.type === 'ask_end')).toHaveLength(2);
    expect(traces.filter((event) => event.type === 'tool_call_start')).toHaveLength(1);
    expect(traces.filter((event) => event.type === 'tool_call_end')).toHaveLength(1);
    expect(traces.filter((event) => event.type === 'tool_call_rejected')).toHaveLength(0);
    const outerAskStarts = traces.filter(
      (event) => event.type === 'ask_start' && event.agent === 'outer_agent',
    );
    const innerAskStarts = traces.filter(
      (event) => event.type === 'ask_start' && event.agent === 'sub_agent',
    );
    expect(outerAskStarts).toHaveLength(1);
    expect(innerAskStarts).toHaveLength(1);
    const [outerAsk] = outerAskStarts;
    const [innerAsk] = innerAskStarts;
    expect(outerAsk).toMatchObject({ depth: 0, agent: 'outer_agent' });
    expect(outerAsk?.parentAskId).toBeUndefined();
    expect(innerAsk).toMatchObject({
      parentAskId: outerAsk?.askId,
      depth: 1,
      agent: 'sub_agent',
    });
    expect(innerAsk?.askId).not.toBe(outerAsk?.askId);
    expect(innerAsk?.executionId).toBe(outerAsk?.executionId);

    const outerAskEnds = traces.filter(
      (event) => event.type === 'ask_end' && event.askId === outerAsk?.askId,
    );
    const innerAskEnds = traces.filter(
      (event) => event.type === 'ask_end' && event.askId === innerAsk?.askId,
    );
    expect(outerAskEnds).toHaveLength(1);
    expect(innerAskEnds).toHaveLength(1);
    const [outerAskEnd] = outerAskEnds;
    const [innerAskEnd] = innerAskEnds;
    expect(outerAskEnd).toMatchObject({
      executionId: outerAsk?.executionId,
      askId: outerAsk?.askId,
      depth: 0,
      agent: 'outer_agent',
      outcome: { ok: true, result: 'Final result: specialist answer' },
    });
    expect(outerAskEnd?.parentAskId).toBeUndefined();
    expect(innerAskEnd).toMatchObject({
      executionId: innerAsk?.executionId,
      askId: innerAsk?.askId,
      parentAskId: outerAsk?.askId,
      depth: 1,
      agent: 'sub_agent',
      outcome: { ok: true, result: 'specialist answer' },
    });

    const toolStarts = traces.filter(
      (event) => event.type === 'tool_call_start' && event.callId === 'tc1',
    );
    const toolEnds = traces.filter(
      (event) => event.type === 'tool_call_end' && event.callId === 'tc1',
    );
    expect(toolStarts).toHaveLength(1);
    expect(toolEnds).toHaveLength(1);
    const [toolStart] = toolStarts;
    const [toolEnd] = toolEnds;
    expect(toolStart).toMatchObject({
      schemaVersion: 2,
      executionId: outerAsk?.executionId,
      tool: 'ask_specialist',
      askId: outerAsk?.askId,
      depth: 0,
      agent: 'outer_agent',
      callId: 'tc1',
    });
    expect(toolEnd).toMatchObject({
      schemaVersion: 2,
      executionId: outerAsk?.executionId,
      tool: 'ask_specialist',
      askId: outerAsk?.askId,
      depth: 0,
      agent: 'outer_agent',
      callId: 'tc1',
      data: { outcome: { status: 'succeeded', result: 'specialist answer' } },
    });
    expect(toolStart?.parentAskId).toBeUndefined();
    expect(toolEnd?.parentAskId).toBeUndefined();
    expect(toolEnd?.duration).toBeGreaterThanOrEqual(innerAskEnd?.duration ?? 0);
    expect(outerAskEnd?.duration).toBeGreaterThanOrEqual(toolEnd?.duration ?? 0);

    expect(outerAsk?.step).toBeLessThan(toolStart?.step ?? 0);
    expect(toolStart?.step).toBeLessThan(innerAsk?.step ?? 0);
    expect(innerAsk?.step).toBeLessThan(innerAskEnd?.step ?? 0);
    expect(innerAskEnd?.step).toBeLessThan(toolEnd?.step ?? 0);
    expect(toolEnd?.step).toBeLessThan(outerAskEnd?.step ?? 0);

    const outerAskSpan = spanManager.spans.find(
      (span) =>
        span.name === 'axl.agent.ask' && span.attributes['axl.agent.name'] === 'outer_agent',
    );
    const toolSpan = spanManager.spans.find(
      (span) =>
        span.name === 'axl.tool.call' && span.attributes['axl.tool.name'] === 'ask_specialist',
    );
    const innerAskSpan = spanManager.spans.find(
      (span) => span.name === 'axl.agent.ask' && span.attributes['axl.agent.name'] === 'sub_agent',
    );
    expect(outerAskSpan).toBeDefined();
    expect(toolSpan).toBeDefined();
    expect(innerAskSpan).toBeDefined();
    expect(toolSpan!.parent).toBe(outerAskSpan);
    expect(innerAskSpan!.parent).toBe(toolSpan);
  });

  it('agent-as-tool propagates cancellation through the inner and outer lifecycle', async () => {
    const controller = new AbortController();
    let calls = 0;
    const provider: Provider = {
      name: 'mock',
      chat: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: '',
            tool_calls: [
              {
                id: 'outer-call',
                type: 'function',
                function: { name: 'ask_inner_cancel', arguments: '{"question":"go"}' },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        }
        controller.abort('cancel nested ask');
        throw new DOMException('cancel nested ask', 'AbortError');
      },
      stream: async function* () {
        yield { type: 'done' as const };
      },
    };
    const inner = agent({ name: 'inner_cancel', model: 'mock:test', system: 'inner' });
    const outerTool = tool({
      name: 'ask_inner_cancel',
      description: 'invoke cancellable inner agent',
      input: z.object({ question: z.string() }),
      handler: ({ question }, ctx) => ctx.ask(inner, question),
    });
    const outer = agent({
      name: 'outer_cancel',
      model: 'mock:test',
      system: 'outer',
      tools: [outerTool],
    });
    const spanManager = new NestingSpanManager();
    const { ctx, traces } = createTestCtx({
      provider,
      signal: controller.signal,
      spanManager,
    });

    await expect(ctx.ask(outer, 'go')).rejects.toBe('cancel nested ask');
    expect(calls).toBe(2);
    expect(controller.signal).toMatchObject({ aborted: true, reason: 'cancel nested ask' });
    expect(traces.filter((event) => event.type === 'ask_start')).toHaveLength(2);
    expect(traces.filter((event) => event.type === 'ask_end')).toHaveLength(2);
    expect(traces.filter((event) => event.type === 'tool_call_start')).toHaveLength(1);
    expect(traces.filter((event) => event.type === 'tool_call_end')).toHaveLength(1);
    expect(traces.filter((event) => event.type === 'tool_call_rejected')).toHaveLength(0);

    const outerAskStarts = traces.filter(
      (event) => event.type === 'ask_start' && event.agent === 'outer_cancel',
    );
    const innerAskStarts = traces.filter(
      (event) => event.type === 'ask_start' && event.agent === 'inner_cancel',
    );
    expect(outerAskStarts).toHaveLength(1);
    expect(innerAskStarts).toHaveLength(1);
    const [outerAsk] = outerAskStarts;
    const [innerAsk] = innerAskStarts;
    expect(outerAsk).toMatchObject({ depth: 0, agent: 'outer_cancel' });
    expect(outerAsk?.parentAskId).toBeUndefined();
    expect(innerAsk).toMatchObject({
      parentAskId: outerAsk?.askId,
      depth: 1,
      agent: 'inner_cancel',
    });
    expect(innerAsk?.askId).not.toBe(outerAsk?.askId);
    expect(innerAsk?.executionId).toBe(outerAsk?.executionId);

    const outerAskEnds = traces.filter(
      (event) => event.type === 'ask_end' && event.askId === outerAsk?.askId,
    );
    const innerAskEnds = traces.filter(
      (event) => event.type === 'ask_end' && event.askId === innerAsk?.askId,
    );
    expect(outerAskEnds).toHaveLength(1);
    expect(innerAskEnds).toHaveLength(1);
    const [outerAskEnd] = outerAskEnds;
    const [innerAskEnd] = innerAskEnds;
    expect(outerAskEnd).toMatchObject({
      executionId: outerAsk?.executionId,
      askId: outerAsk?.askId,
      depth: 0,
      agent: 'outer_cancel',
      outcome: { ok: false },
    });
    expect(outerAskEnd?.parentAskId).toBeUndefined();
    expect(innerAskEnd).toMatchObject({
      executionId: innerAsk?.executionId,
      askId: innerAsk?.askId,
      parentAskId: outerAsk?.askId,
      depth: 1,
      agent: 'inner_cancel',
      outcome: { ok: false },
    });

    const toolStarts = traces.filter(
      (event) => event.type === 'tool_call_start' && event.callId === 'outer-call',
    );
    const toolEnds = traces.filter(
      (event) => event.type === 'tool_call_end' && event.callId === 'outer-call',
    );
    expect(toolStarts).toHaveLength(1);
    expect(toolEnds).toHaveLength(1);
    const [toolStart] = toolStarts;
    const [toolEnd] = toolEnds;
    expect(toolStart).toMatchObject({
      schemaVersion: 2,
      executionId: outerAsk?.executionId,
      askId: outerAsk?.askId,
      depth: 0,
      agent: 'outer_cancel',
      tool: 'ask_inner_cancel',
      callId: 'outer-call',
    });
    expect(toolEnd).toMatchObject({
      schemaVersion: 2,
      executionId: outerAsk?.executionId,
      askId: outerAsk?.askId,
      depth: 0,
      agent: 'outer_cancel',
      tool: 'ask_inner_cancel',
      callId: 'outer-call',
      data: {
        outcome: { status: 'cancelled', cancellation: { phase: 'handler' } },
      },
    });
    expect(toolStart?.parentAskId).toBeUndefined();
    expect(toolEnd?.parentAskId).toBeUndefined();
    expect(toolEnd?.duration).toBeGreaterThanOrEqual(innerAskEnd?.duration ?? 0);
    expect(outerAskEnd?.duration).toBeGreaterThanOrEqual(toolEnd?.duration ?? 0);

    expect(outerAsk?.step).toBeLessThan(toolStart?.step ?? 0);
    expect(toolStart?.step).toBeLessThan(innerAsk?.step ?? 0);
    expect(innerAsk?.step).toBeLessThan(innerAskEnd?.step ?? 0);
    expect(innerAskEnd?.step).toBeLessThan(toolEnd?.step ?? 0);
    expect(toolEnd?.step).toBeLessThan(outerAskEnd?.step ?? 0);

    const outerAskSpan = spanManager.spans.find(
      (span) =>
        span.name === 'axl.agent.ask' && span.attributes['axl.agent.name'] === 'outer_cancel',
    );
    const toolSpan = spanManager.spans.find(
      (span) =>
        span.name === 'axl.tool.call' && span.attributes['axl.tool.name'] === 'ask_inner_cancel',
    );
    const innerAskSpan = spanManager.spans.find(
      (span) =>
        span.name === 'axl.agent.ask' && span.attributes['axl.agent.name'] === 'inner_cancel',
    );
    expect(outerAskSpan).toBeDefined();
    expect(toolSpan).toBeDefined();
    expect(innerAskSpan).toBeDefined();
    expect(toolSpan!.parent).toBe(outerAskSpan);
    expect(innerAskSpan!.parent).toBe(toolSpan);
  });

  it('token events carry depth 0 for root asks and >= 1 for nested asks', async () => {
    const subAgent = agent({
      name: 'inner',
      model: 'mock:test',
      system: 'inner',
    });
    const askTool = tool({
      name: 'ask_inner',
      description: 'ask the inner sub-agent',
      input: z.object({ q: z.string() }),
      handler: async (input, ctx) => ctx.ask(subAgent, input.q),
    });
    const outerAgent = agent({
      name: 'outer',
      model: 'mock:test',
      system: 'outer',
      tools: [askTool],
    });

    // Provider sequence:
    // Turn 1 (outer): tool_call to ask_inner — no text chunks
    // Turn 2 (inner): text "INNER" — streamed
    // Turn 3 (outer): text "OUTER" — streamed
    let outerCallCount = 0;
    const provider: Provider = {
      name: 'mock',
      chat: async () => ({
        content: '',
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: 0.001,
      }),
      stream: async function* (_messages, options) {
        const toolNames = (options?.tools ?? []).map(
          (t) => (t as { function?: { name?: string } }).function?.name,
        );
        // Outer agent has the ask_inner tool exposed; inner agent does
        // not. Detect which agent is being called by checking tool names.
        const isOuter = toolNames.includes('ask_inner');
        if (isOuter) {
          // Decide based on a per-test counter: first outer call =
          // tool_call, second outer call = final text.
          outerCallCount++;
          if (outerCallCount === 1) {
            yield {
              type: 'tool_call_delta' as const,
              id: 'tc1',
              name: 'ask_inner',
              arguments: '{"q":"go"}',
            };
            yield {
              type: 'done' as const,
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            };
            return;
          }
          // Second outer turn — emit final text.
          for (const ch of ['OU', 'TER']) {
            yield { type: 'text_delta' as const, content: ch };
          }
          yield {
            type: 'done' as const,
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          };
          return;
        }
        // Inner agent — emit text.
        for (const ch of ['IN', 'NER']) {
          yield { type: 'text_delta' as const, content: ch };
        }
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        };
      },
    };

    const tokens: Array<{ token: string; depth: number; agent?: string }> = [];

    const { ctx } = createTestCtx({ provider });
    ctx.events.on('token', (event) => {
      tokens.push({ token: event.data, depth: event.depth, agent: event.agent });
    });
    await ctx.ask(outerAgent, 'start');

    // Group tokens by depth.
    const byDepth = new Map<number, string[]>();
    for (const { token, depth } of tokens) {
      if (!byDepth.has(depth)) byDepth.set(depth, []);
      byDepth.get(depth)!.push(token);
    }

    // BOTH depth=0 (root) and depth>=1 (nested) MUST be represented.
    expect(byDepth.has(0)).toBe(true);
    const nestedDepths = [...byDepth.keys()].filter((d) => d >= 1);
    expect(nestedDepths.length).toBeGreaterThan(0);

    // Root-ask tokens are the outer agent's text; nested-ask tokens are
    // the inner agent's text.
    const rootText = byDepth.get(0)!.join('');
    expect(rootText).toBe('OUTER');
    // Sum across all nested depths (likely just depth=1) gives 'INNER'.
    const nestedText = nestedDepths.flatMap((d) => byDepth.get(d) ?? []).join('');
    expect(nestedText).toBe('INNER');

    // Sanity: meta.agent is present and matches the lane.
    const rootTokens = tokens.filter((t) => t.depth === 0);
    const nestedTokens = tokens.filter((t) => t.depth >= 1);
    expect(rootTokens.every((t) => t.agent === 'outer')).toBe(true);
    expect(nestedTokens.every((t) => t.agent === 'inner')).toBe(true);
  });

  it('agent-as-tool: nested traces appear in execution timeline', async () => {
    const subAgent = agent({
      name: 'inner_specialist',
      model: 'mock:test',
      system: 'You are the inner specialist.',
    });

    const agentTool = tool({
      name: 'consult_specialist',
      description: 'Consult the inner specialist',
      input: z.object({ query: z.string() }),
      handler: async (input, ctx) => {
        return ctx.ask(subAgent, input.query);
      },
    });

    const outerAgent = agent({
      name: 'outer_coordinator',
      model: 'mock:test',
      system: 'You coordinate.',
      tools: [agentTool],
    });

    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'consult_specialist',
              arguments: '{"query":"analyze this"}',
            },
          },
        ],
      },
      'inner result',
      'outer final',
    ]);

    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(outerAgent, 'Run analysis');

    // Should have agent_call traces for both the outer and inner agents
    const agentCallTraces = traces.filter((t) => t.type === 'agent_call_end');
    const outerTraces = agentCallTraces.filter((t) => t.agent === 'outer_coordinator');
    const innerTraces = agentCallTraces.filter((t) => t.agent === 'inner_specialist');

    expect(outerTraces.length).toBeGreaterThanOrEqual(1);
    expect(innerTraces.length).toBeGreaterThanOrEqual(1);

    // Should also have a tool_call trace for consult_specialist
    const toolCallTraces = traces.filter((t) => t.type === 'tool_call_end');
    expect(toolCallTraces.some((t) => t.tool === 'consult_specialist')).toBe(true);
  });
});

describe('dynamic handoffs', () => {
  it('static handoffs array still works', async () => {
    const targetAgent = agent({
      name: 'static_target',
      model: 'mock:test',
      system: 'You are the target.',
    });

    const sourceAgent = agent({
      name: 'static_source',
      model: 'mock:test',
      system: 'You are the source.',
      handoffs: [{ agent: targetAgent }],
    });

    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'handoff_to_static_target', arguments: '{}' },
          },
        ],
      },
      'target response',
    ]);

    const { ctx } = createTestCtx({ provider });
    const result = await ctx.ask(sourceAgent, 'Hello');

    expect(result).toBe('target response');
  });

  it('dynamic handoffs function resolves based on metadata', async () => {
    const agentA = agent({
      name: 'agent_a',
      model: 'mock:test',
      system: 'You are agent A.',
    });

    const agentB = agent({
      name: 'agent_b',
      model: 'mock:test',
      system: 'You are agent B.',
    });

    const dynamicSource = agent({
      name: 'dynamic_source',
      model: 'mock:test',
      system: 'You coordinate.',
      handoffs: (ctx) => {
        const tier = ctx.metadata?.tier as string | undefined;
        if (tier === 'premium') {
          return [{ agent: agentA }, { agent: agentB }];
        }
        return [{ agent: agentA }];
      },
    });

    // Capture tool definitions for different metadata
    let capturedToolsPremium: Array<{ function: { name: string } }> = [];
    let capturedToolsBasic: Array<{ function: { name: string } }> = [];

    // Test with premium metadata
    let callCount = 0;
    const premiumProvider: Provider = {
      name: 'mock',
      chat: async (_messages, options) => {
        callCount++;
        if (callCount === 1) {
          capturedToolsPremium = (options?.tools ?? []) as Array<{ function: { name: string } }>;
        }
        return {
          content: 'done',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          cost: 0.001,
        };
      },
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    };

    const { ctx: premiumCtx } = createTestCtx({
      provider: premiumProvider,
      metadata: { tier: 'premium' },
    });
    await premiumCtx.ask(dynamicSource, 'Hello');

    // Premium tier should have both handoff tools
    const premiumHandoffTools = capturedToolsPremium.filter((t) =>
      t.function.name.startsWith('handoff_to_'),
    );
    expect(premiumHandoffTools).toHaveLength(2);
    expect(premiumHandoffTools.map((t) => t.function.name)).toContain('handoff_to_agent_a');
    expect(premiumHandoffTools.map((t) => t.function.name)).toContain('handoff_to_agent_b');

    // Test with basic metadata (no tier)
    callCount = 0;
    const basicProvider: Provider = {
      name: 'mock',
      chat: async (_messages, options) => {
        callCount++;
        if (callCount === 1) {
          capturedToolsBasic = (options?.tools ?? []) as Array<{ function: { name: string } }>;
        }
        return {
          content: 'done',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          cost: 0.001,
        };
      },
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    };

    const { ctx: basicCtx } = createTestCtx({
      provider: basicProvider,
      metadata: { tier: 'basic' },
    });
    await basicCtx.ask(dynamicSource, 'Hello');

    // Basic tier should only have agent_a
    const basicHandoffTools = capturedToolsBasic.filter((t) =>
      t.function.name.startsWith('handoff_to_'),
    );
    expect(basicHandoffTools).toHaveLength(1);
    expect(basicHandoffTools[0].function.name).toBe('handoff_to_agent_a');
  });

  it('dynamic handoff tool definitions are correct', async () => {
    const specialist = agent({
      name: 'dyn_specialist',
      model: 'mock:test',
      system: 'You are a specialist.',
    });

    const dynamicAgent = agent({
      name: 'dyn_coordinator',
      model: 'mock:test',
      system: 'You coordinate.',
      handoffs: (_ctx) => [
        { agent: specialist, mode: 'roundtrip', description: 'Ask the specialist' },
      ],
    });

    let capturedTools: Array<{
      type: string;
      function: { name: string; description: string; parameters: unknown };
    }> = [];

    const captureProvider: Provider = {
      name: 'mock',
      chat: async (_messages, options) => {
        capturedTools = (options?.tools ?? []) as typeof capturedTools;
        return {
          content: 'done',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          cost: 0.001,
        };
      },
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    };

    const { ctx } = createTestCtx({ provider: captureProvider });
    await ctx.ask(dynamicAgent, 'Hello');

    const handoffTool = capturedTools.find((t) => t.function.name === 'handoff_to_dyn_specialist');
    expect(handoffTool).toBeDefined();
    expect(handoffTool!.function.description).toBe('Ask the specialist');
    // Roundtrip handoffs include a message parameter
    expect(handoffTool!.function.parameters).toEqual({
      type: 'object',
      properties: { message: { type: 'string', description: 'The task to delegate' } },
      required: ['message'],
    });
  });

  it('dynamic handoffs resolved at handoff lookup time', async () => {
    const targetAgent = agent({
      name: 'dyn_target',
      model: 'mock:test',
      system: 'You are the dynamic target.',
    });

    const dynamicSource = agent({
      name: 'dyn_source',
      model: 'mock:test',
      system: 'You coordinate dynamically.',
      handoffs: (ctx) => {
        if (ctx.metadata?.enableHandoff) {
          return [{ agent: targetAgent }];
        }
        return [];
      },
    });

    // Provider sequence:
    // Call 1 (source): triggers handoff_to_dyn_target
    // Call 2 (target): returns the target's response
    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'handoff_to_dyn_target', arguments: '{}' },
          },
        ],
      },
      'dynamic target response',
    ]);

    const { ctx, traces } = createTestCtx({
      provider,
      metadata: { enableHandoff: true },
    });
    const result = await ctx.ask(dynamicSource, 'Route me');

    // The handoff should succeed since metadata enables it
    expect(result).toBe('dynamic target response');

    // Verify handoff_start trace was emitted (always fires, carries mode).
    // Oneway handoff: no handoff_return follows — target's ask_end ends
    // the chain.
    const handoffTraces = traces.filter((t) => t.type === 'handoff_start');
    expect(handoffTraces).toHaveLength(1);
    expect((handoffTraces[0].data as Record<string, unknown>).target).toBe('dyn_target');
    expect((handoffTraces[0].data as Record<string, unknown>).mode).toBe('oneway');
  });

  it('roundtrip handoff with dynamic handoffs works', async () => {
    const specialist = agent({
      name: 'rt_specialist',
      model: 'mock:test',
      system: 'You are a specialist.',
    });

    const router = agent({
      name: 'rt_router',
      model: 'mock:test',
      system: 'You route.',
      handoffs: () => [
        { agent: specialist, mode: 'roundtrip' as const, description: 'Ask specialist' },
      ],
    });

    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'handoff_to_rt_specialist',
              arguments: '{"message":"analyze this"}',
            },
          },
        ],
      },
      'specialist result',
      'router final with specialist result',
    ]);

    const { ctx } = createTestCtx({ provider });
    const result = await ctx.ask(router, 'Do analysis');

    // Roundtrip: router continues after getting specialist result
    expect(result).toBe('router final with specialist result');
  });
});

describe('edge cases', () => {
  it('tool handler error propagates correctly through child context', async () => {
    const handlerError = new Error('tool handler exploded');
    const failingTool = tool({
      name: 'failing_tool',
      description: 'A tool that always fails',
      input: z.object({ x: z.string() }),
      handler: async () => {
        throw handlerError;
      },
    });

    const outerAgent = agent({
      name: 'error_agent',
      model: 'mock:test',
      system: 'You use tools.',
      tools: [failingTool],
    });

    // Provider advertises a continuation that must never run after an unexpected failure.
    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'failing_tool', arguments: '{"x":"test"}' },
          },
        ],
      },
      'Handled the error gracefully',
    ]);

    const { ctx } = createTestCtx({ provider });
    await expect(ctx.ask(outerAgent, 'Try the tool')).rejects.toBe(handlerError);
    expect(provider.calls).toHaveLength(1);
  });

  it('existing tool handlers without ctx parameter still work', async () => {
    // Simulates old-style handler that only takes input
    const legacyTool = tool({
      name: 'legacy',
      description: 'A legacy tool',
      input: z.object({ value: z.number() }),
      handler: (input) => ({ doubled: input.value * 2 }),
    });

    const testAgent = agent({
      name: 'legacy_test',
      model: 'mock:test',
      system: 'You test.',
      tools: [legacyTool],
    });

    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'legacy', arguments: '{"value":21}' },
          },
        ],
      },
      'The result was 42',
    ]);

    const { ctx } = createTestCtx({ provider });
    const result = await ctx.ask(testAgent, 'Double 21');
    expect(result).toBe('The result was 42');
  });

  it('child context ctx.log() traces appear in parent', async () => {
    const loggingTool = tool({
      name: 'logging_tool',
      description: 'A tool that logs',
      input: z.object({ msg: z.string() }),
      handler: async (input, ctx) => {
        ctx.log('custom_event', { message: input.msg });
        return 'logged';
      },
    });

    const testAgent = agent({
      name: 'log_agent',
      model: 'mock:test',
      system: 'You log.',
      tools: [loggingTool],
    });

    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'logging_tool', arguments: '{"msg":"hello from child"}' },
          },
        ],
      },
      'done',
    ]);

    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(testAgent, 'Log something');

    // The log trace from the child context should appear in parent's traces
    const logTraces = traces.filter(
      (t) =>
        t.type === 'log' && (t.data as Record<string, unknown>)?.message === 'hello from child',
    );
    expect(logTraces).toHaveLength(1);
  });

  it('child context shares toolOverrides for test mock propagation', async () => {
    // Simulates AxlTestRuntime.mockTool() — toolOverrides should propagate
    // to child contexts so mocked tools work in agent-as-tool patterns.
    const subAgent = agent({
      name: 'sub_with_tool',
      model: 'mock:test',
      system: 'You use tools.',
      tools: [
        tool({
          name: 'inner_tool',
          description: 'An inner tool',
          input: z.object({ x: z.string() }),
          handler: () => 'real handler — should not be called',
        }),
      ],
    });

    const outerTool = tool({
      name: 'delegate',
      description: 'Delegate to sub-agent',
      input: z.object({ task: z.string() }),
      handler: async (input, ctx) => ctx.ask(subAgent, input.task),
    });

    const outerAgent = agent({
      name: 'outer_with_delegate',
      model: 'mock:test',
      system: 'You delegate.',
      tools: [outerTool],
    });

    // Provider sequence:
    // Call 1 (outer): calls delegate tool
    // Call 2 (sub-agent): calls inner_tool
    // Call 3 (sub-agent): returns text after tool result
    // Call 4 (outer): returns final text
    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'delegate', arguments: '{"task":"do it"}' },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: 'tc2',
            type: 'function',
            function: { name: 'inner_tool', arguments: '{"x":"test"}' },
          },
        ],
      },
      'sub-agent done with mocked result',
      'outer done',
    ]);

    // Set up toolOverrides (like AxlTestRuntime.mockTool would)
    const toolOverrides = new Map<string, (args: unknown) => Promise<unknown>>();
    toolOverrides.set('inner_tool', async () => 'MOCKED');

    const { ctx, traces } = createTestCtx({ provider, toolOverrides });
    const result = await ctx.ask(outerAgent, 'Run');

    expect(result).toBe('outer done');

    // Verify the mock was used (not the real handler). The strict v2 end
    // variant exposes the discriminated outcome without a cast.
    const innerToolTraces = traces.filter(
      (t): t is Extract<typeof t, { type: 'tool_call_end' }> =>
        t.type === 'tool_call_end' && t.tool === 'inner_tool',
    );
    expect(innerToolTraces).toHaveLength(1);
    expect(innerToolTraces[0].data.outcome).toEqual({ status: 'succeeded', result: 'MOCKED' });
  });

  it('dynamic handoff function that throws is handled gracefully', async () => {
    const sourceAgent = agent({
      name: 'error_handoff_source',
      model: 'mock:test',
      system: 'You route.',
      handoffs: () => {
        throw new Error('handoff resolver exploded');
      },
    });

    // Agent should still work — just without handoff tools
    let capturedTools: Array<{ function: { name: string } }> = [];
    const captureProvider: Provider = {
      name: 'mock',
      chat: async (_messages, options) => {
        capturedTools = (options?.tools ?? []) as typeof capturedTools;
        return {
          content: 'worked without handoffs',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          cost: 0.001,
        };
      },
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    };

    const { ctx, traces } = createTestCtx({ provider: captureProvider });
    const result = await ctx.ask(sourceAgent, 'Try to route');

    expect(result).toBe('worked without handoffs');

    // No handoff tools should be present
    const handoffTools = capturedTools.filter((t) => t.function.name.startsWith('handoff_to_'));
    expect(handoffTools).toHaveLength(0);

    // A log trace about the error should have been emitted
    const errorLogs = traces.filter(
      (t) =>
        t.type === 'log' &&
        (t.data as Record<string, unknown>)?.error === 'handoff resolver exploded',
    );
    expect(errorLogs).toHaveLength(1);
  });

  it('dynamic handoff function that returns empty array prevents handoffs', async () => {
    agent({
      name: 'blocked_target',
      model: 'mock:test',
      system: 'You should not be reached.',
    });

    const sourceAgent = agent({
      name: 'blocked_source',
      model: 'mock:test',
      system: 'You try to hand off.',
      handoffs: () => [], // Empty — no handoffs available
    });

    // Agent tries to call handoff_to_blocked_target but it's not in tool definitions
    // so it won't be generated. Provider just returns text.
    createSequenceProvider(['No handoffs available']);

    let capturedTools: Array<{ function: { name: string } }> = [];
    const captureProvider: Provider = {
      name: 'mock',
      chat: async (_messages, options) => {
        capturedTools = (options?.tools ?? []) as typeof capturedTools;
        return {
          content: 'No handoffs available',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          cost: 0.001,
        };
      },
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    };

    const { ctx } = createTestCtx({ provider: captureProvider });
    await ctx.ask(sourceAgent, 'Try to hand off');

    // No handoff tools should be in the tool definitions
    const handoffTools = capturedTools.filter((t) => t.function.name.startsWith('handoff_to_'));
    expect(handoffTools).toHaveLength(0);
  });
});
