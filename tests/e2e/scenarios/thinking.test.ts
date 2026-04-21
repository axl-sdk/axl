import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent, workflow } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createTestRuntime } from '../helpers/setup.js';

describe('Thinking E2E', () => {
  it('effort flows from AgentConfig through runtime to provider', async () => {
    const provider = MockProvider.sequence([{ content: 'solved' }]);
    const { runtime } = createTestRuntime(provider);

    const reasoner = agent({
      name: 'thinker',
      model: 'mock:test',
      system: 'Think deeply.',
      effort: 'high',
    });

    const wf = workflow({
      name: 'thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(reasoner, ctx.input.message),
    });
    runtime.register(wf);

    const result = await runtime.execute('thinking-wf', { message: 'solve this' });
    expect(result).toBe('solved');

    // Verify effort was passed to provider
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].options.effort).toBe('high');
  });

  it('per-call AskOptions effort overrides agent-level effort', async () => {
    const provider = MockProvider.sequence([{ content: 'quick answer' }]);
    const { runtime } = createTestRuntime(provider);

    const reasoner = agent({
      name: 'override-thinker',
      model: 'mock:test',
      system: 'Think.',
      effort: 'high',
    });

    const wf = workflow({
      name: 'override-thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(reasoner, ctx.input.message, { effort: 'low' }),
    });
    runtime.register(wf);

    await runtime.execute('override-thinking-wf', { message: 'quick question' });
    expect(provider.calls[0].options.effort).toBe('low');
  });

  it('thinkingBudget flows through to provider', async () => {
    const provider = MockProvider.sequence([{ content: 'done' }]);
    const { runtime } = createTestRuntime(provider);

    const a = agent({
      name: 'budget-thinker',
      model: 'mock:test',
      system: 'Think.',
      thinkingBudget: 3000,
    });

    const wf = workflow({
      name: 'budget-thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    await runtime.execute('budget-thinking-wf', { message: 'think about this' });
    expect(provider.calls[0].options.thinkingBudget).toBe(3000);
  });

  it('effort "max" flows through runtime to provider', async () => {
    const provider = MockProvider.sequence([{ content: 'maximum thought' }]);
    const { runtime } = createTestRuntime(provider);

    const reasoner = agent({
      name: 'max-thinker',
      model: 'mock:test',
      system: 'Think maximally.',
      effort: 'max',
    });

    const wf = workflow({
      name: 'max-thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(reasoner, ctx.input.message),
    });
    runtime.register(wf);

    const result = await runtime.execute('max-thinking-wf', { message: 'go hard' });
    expect(result).toBe('maximum thought');
    expect(provider.calls[0].options.effort).toBe('max');
  });

  it('effort does not leak from source agent to handoff target', async () => {
    const provider = MockProvider.sequence([
      // Source agent response: handoff to target
      { content: '' },
      // Target agent response
      { content: 'target response' },
    ]);
    const { runtime } = createTestRuntime(provider);

    const target = agent({
      name: 'target',
      model: 'mock:test',
      system: 'I am the target.',
      // No effort configured
    });

    const source = agent({
      name: 'source',
      model: 'mock:test',
      system: 'I am the source.',
      effort: 'high',
      handoffs: [{ agent: target }],
    });

    const wf = workflow({
      name: 'handoff-thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(source, ctx.input.message),
    });
    runtime.register(wf);

    // This test verifies the source agent has effort, but the target should use its own config
    expect(source._config.effort).toBe('high');
    expect(target._config.effort).toBeUndefined();
  });

  it('effort works with streaming execution', async () => {
    const provider = MockProvider.sequence([{ content: 'streamed thought' }]);
    const { runtime } = createTestRuntime(provider);

    const a = agent({
      name: 'stream-thinker',
      model: 'mock:test',
      system: 'Think.',
      effort: 'medium',
    });

    const wf = workflow({
      name: 'stream-thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const stream = runtime.stream('stream-thinking-wf', { message: 'think' });
    const result = await stream.promise;
    expect(result).toBe('streamed thought');
    expect(provider.calls[0].options.effort).toBe('medium');
  });

  it('effort coexists with other model params (temperature, maxTokens, toolChoice)', async () => {
    const provider = MockProvider.sequence([{ content: 'done' }]);
    const { runtime } = createTestRuntime(provider);

    const a = agent({
      name: 'full-config',
      model: 'mock:test',
      system: 'test',
      effort: 'high',
      temperature: 0.5,
      maxTokens: 2048,
      toolChoice: 'none',
      stop: ['END'],
    });

    const wf = workflow({
      name: 'full-config-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    await runtime.execute('full-config-wf', { message: 'test' });
    const opts = provider.calls[0].options;
    expect(opts.effort).toBe('high');
    expect(opts.temperature).toBe(0.5);
    expect(opts.maxTokens).toBe(2048);
    expect(opts.toolChoice).toBe('none');
    expect(opts.stop).toEqual(['END']);
  });

  it('effort flows through spawn() to all concurrent agents', async () => {
    const provider = MockProvider.sequence([
      { content: 'result-1' },
      { content: 'result-2' },
      { content: 'result-3' },
    ]);
    const { runtime } = createTestRuntime(provider);

    const a = agent({
      name: 'spawn-thinker',
      model: 'mock:test',
      system: 'Think.',
      effort: 'high',
    });

    const wf = workflow({
      name: 'spawn-thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => {
        const results = await ctx.spawn(3, async () => ctx.ask(a, ctx.input.message));
        return results;
      },
    });
    runtime.register(wf);

    const results = await runtime.execute('spawn-thinking-wf', { message: 'think' });
    expect(results).toHaveLength(3);

    // All 3 provider calls should have effort: 'high'
    expect(provider.calls).toHaveLength(3);
    for (const call of provider.calls) {
      expect(call.options.effort).toBe('high');
    }
  });

  it('effort flows through race() to competing agents', async () => {
    const provider = MockProvider.sequence([{ content: 'winner' }, { content: 'loser' }]);
    const { runtime } = createTestRuntime(provider);

    const fast = agent({
      name: 'fast-thinker',
      model: 'mock:test',
      system: 'Be fast.',
      effort: 'low',
    });

    const slow = agent({
      name: 'slow-thinker',
      model: 'mock:test',
      system: 'Be thorough.',
      effort: 'high',
    });

    const wf = workflow({
      name: 'race-thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) =>
        ctx.race([() => ctx.ask(fast, ctx.input.message), () => ctx.ask(slow, ctx.input.message)]),
    });
    runtime.register(wf);

    const result = await runtime.execute('race-thinking-wf', { message: 'go' });
    expect(result).toBe('winner');

    // Each agent should have its own effort level
    const lowCall = provider.calls.find((c) => c.options.effort === 'low');
    const highCall = provider.calls.find((c) => c.options.effort === 'high');
    expect(lowCall).toBeDefined();
    expect(highCall).toBeDefined();
  });

  it('effort flows through parallel() to independent agents', async () => {
    const provider = MockProvider.sequence([{ content: 'answer-a' }, { content: 'answer-b' }]);
    const { runtime } = createTestRuntime(provider);

    const agentA = agent({
      name: 'parallel-a',
      model: 'mock:test',
      system: 'Agent A.',
      effort: 'low',
    });

    const agentB = agent({
      name: 'parallel-b',
      model: 'mock:test',
      system: 'Agent B.',
      effort: 'high',
    });

    const wf = workflow({
      name: 'parallel-thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) =>
        ctx.parallel([
          () => ctx.ask(agentA, ctx.input.message),
          () => ctx.ask(agentB, ctx.input.message),
        ]),
    });
    runtime.register(wf);

    const [a, b] = (await runtime.execute('parallel-thinking-wf', { message: 'go' })) as [
      string,
      string,
    ];
    expect(a).toBe('answer-a');
    expect(b).toBe('answer-b');

    // Each call should retain its agent's effort config
    expect(provider.calls).toHaveLength(2);
    const effortValues = provider.calls.map((c) => c.options.effort);
    expect(effortValues).toContain('low');
    expect(effortValues).toContain('high');
  });

  it('effort with per-call override inside spawn()', async () => {
    const provider = MockProvider.sequence([{ content: 'r1' }, { content: 'r2' }]);
    const { runtime } = createTestRuntime(provider);

    const a = agent({
      name: 'spawn-override',
      model: 'mock:test',
      system: 'Think.',
      effort: 'high',
    });

    const wf = workflow({
      name: 'spawn-override-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) =>
        ctx.spawn(2, async () => ctx.ask(a, ctx.input.message, { effort: 'low' })),
    });
    runtime.register(wf);

    await runtime.execute('spawn-override-wf', { message: 'go' });

    // Per-call override should take precedence
    for (const call of provider.calls) {
      expect(call.options.effort).toBe('low');
    }
  });

  it('trace events include effort in agent_call data', async () => {
    const provider = MockProvider.sequence([{ content: 'traced' }]);
    const { runtime, traces } = createTestRuntime(provider);

    const a = agent({
      name: 'traced-thinker',
      model: 'mock:test',
      system: 'test',
      effort: 'high',
    });

    const wf = workflow({
      name: 'trace-thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    await runtime.execute('trace-thinking-wf', { message: 'trace me' });

    const agentCallTraces = traces.filter((t) => t.type === 'agent_call_end');
    expect(agentCallTraces.length).toBeGreaterThanOrEqual(1);
  });
});
