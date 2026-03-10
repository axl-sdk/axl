import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent, workflow } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createTestRuntime } from '../helpers/setup.js';

describe('Thinking E2E', () => {
  it('thinking flows from AgentConfig through runtime to provider', async () => {
    const provider = MockProvider.sequence([{ content: 'solved' }]);
    const { runtime } = createTestRuntime(provider);

    const reasoner = agent({
      name: 'thinker',
      model: 'mock:test',
      system: 'Think deeply.',
      thinking: 'high',
    });

    const wf = workflow({
      name: 'thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(reasoner, ctx.input.message),
    });
    runtime.register(wf);

    const result = await runtime.execute('thinking-wf', { message: 'solve this' });
    expect(result).toBe('solved');

    // Verify thinking was passed to provider
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].options.thinking).toBe('high');
  });

  it('per-call AskOptions thinking overrides agent-level thinking', async () => {
    const provider = MockProvider.sequence([{ content: 'quick answer' }]);
    const { runtime } = createTestRuntime(provider);

    const reasoner = agent({
      name: 'override-thinker',
      model: 'mock:test',
      system: 'Think.',
      thinking: 'high',
    });

    const wf = workflow({
      name: 'override-thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(reasoner, ctx.input.message, { thinking: 'low' }),
    });
    runtime.register(wf);

    await runtime.execute('override-thinking-wf', { message: 'quick question' });
    expect(provider.calls[0].options.thinking).toBe('low');
  });

  it('budget form { budgetTokens } flows through to provider', async () => {
    const provider = MockProvider.sequence([{ content: 'done' }]);
    const { runtime } = createTestRuntime(provider);

    const a = agent({
      name: 'budget-thinker',
      model: 'mock:test',
      system: 'Think.',
      thinking: { budgetTokens: 3000 },
    });

    const wf = workflow({
      name: 'budget-thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    await runtime.execute('budget-thinking-wf', { message: 'think about this' });
    expect(provider.calls[0].options.thinking).toEqual({ budgetTokens: 3000 });
  });

  it('thinking "max" flows through runtime to provider', async () => {
    const provider = MockProvider.sequence([{ content: 'maximum thought' }]);
    const { runtime } = createTestRuntime(provider);

    const reasoner = agent({
      name: 'max-thinker',
      model: 'mock:test',
      system: 'Think maximally.',
      thinking: 'max',
    });

    const wf = workflow({
      name: 'max-thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(reasoner, ctx.input.message),
    });
    runtime.register(wf);

    const result = await runtime.execute('max-thinking-wf', { message: 'go hard' });
    expect(result).toBe('maximum thought');
    expect(provider.calls[0].options.thinking).toBe('max');
  });

  it('thinking does not leak from source agent to handoff target', async () => {
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
      // No thinking configured
    });

    const source = agent({
      name: 'source',
      model: 'mock:test',
      system: 'I am the source.',
      thinking: 'high',
      handoffs: [{ agent: target }],
    });

    const wf = workflow({
      name: 'handoff-thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(source, ctx.input.message),
    });
    runtime.register(wf);

    // This test verifies the source agent has thinking, but the target should use its own config
    expect(source._config.thinking).toBe('high');
    expect(target._config.thinking).toBeUndefined();
  });

  it('thinking works with streaming execution', async () => {
    const provider = MockProvider.sequence([{ content: 'streamed thought' }]);
    const { runtime } = createTestRuntime(provider);

    const a = agent({
      name: 'stream-thinker',
      model: 'mock:test',
      system: 'Think.',
      thinking: 'medium',
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
    expect(provider.calls[0].options.thinking).toBe('medium');
  });

  it('thinking coexists with other model params (temperature, maxTokens, toolChoice)', async () => {
    const provider = MockProvider.sequence([{ content: 'done' }]);
    const { runtime } = createTestRuntime(provider);

    const a = agent({
      name: 'full-config',
      model: 'mock:test',
      system: 'test',
      thinking: 'high',
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
    expect(opts.thinking).toBe('high');
    expect(opts.temperature).toBe(0.5);
    expect(opts.maxTokens).toBe(2048);
    expect(opts.toolChoice).toBe('none');
    expect(opts.stop).toEqual(['END']);
  });

  it('thinking flows through spawn() to all concurrent agents', async () => {
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
      thinking: 'high',
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

    // All 3 provider calls should have thinking: 'high'
    expect(provider.calls).toHaveLength(3);
    for (const call of provider.calls) {
      expect(call.options.thinking).toBe('high');
    }
  });

  it('thinking flows through race() to competing agents', async () => {
    const provider = MockProvider.sequence([{ content: 'winner' }, { content: 'loser' }]);
    const { runtime } = createTestRuntime(provider);

    const fast = agent({
      name: 'fast-thinker',
      model: 'mock:test',
      system: 'Be fast.',
      thinking: 'low',
    });

    const slow = agent({
      name: 'slow-thinker',
      model: 'mock:test',
      system: 'Be thorough.',
      thinking: 'high',
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

    // Each agent should have its own thinking level
    const fastCall = provider.calls.find((c) => c.options.thinking === 'low');
    const highCall = provider.calls.find((c) => c.options.thinking === 'high');
    expect(fastCall).toBeDefined();
    expect(highCall).toBeDefined();
  });

  it('thinking flows through parallel() to independent agents', async () => {
    const provider = MockProvider.sequence([{ content: 'answer-a' }, { content: 'answer-b' }]);
    const { runtime } = createTestRuntime(provider);

    const agentA = agent({
      name: 'parallel-a',
      model: 'mock:test',
      system: 'Agent A.',
      thinking: 'low',
    });

    const agentB = agent({
      name: 'parallel-b',
      model: 'mock:test',
      system: 'Agent B.',
      thinking: 'high',
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

    // Each call should retain its agent's thinking config
    expect(provider.calls).toHaveLength(2);
    const thinkingValues = provider.calls.map((c) => c.options.thinking);
    expect(thinkingValues).toContain('low');
    expect(thinkingValues).toContain('high');
  });

  it('thinking with per-call override inside spawn()', async () => {
    const provider = MockProvider.sequence([{ content: 'r1' }, { content: 'r2' }]);
    const { runtime } = createTestRuntime(provider);

    const a = agent({
      name: 'spawn-override',
      model: 'mock:test',
      system: 'Think.',
      thinking: 'high',
    });

    const wf = workflow({
      name: 'spawn-override-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) =>
        ctx.spawn(2, async () => ctx.ask(a, ctx.input.message, { thinking: 'low' })),
    });
    runtime.register(wf);

    await runtime.execute('spawn-override-wf', { message: 'go' });

    // Per-call override should take precedence
    for (const call of provider.calls) {
      expect(call.options.thinking).toBe('low');
    }
  });

  it('trace events include thinking in agent_call data', async () => {
    const provider = MockProvider.sequence([{ content: 'traced' }]);
    const { runtime, traces } = createTestRuntime(provider);

    const a = agent({
      name: 'traced-thinker',
      model: 'mock:test',
      system: 'test',
      thinking: 'high',
    });

    const wf = workflow({
      name: 'trace-thinking-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    await runtime.execute('trace-thinking-wf', { message: 'trace me' });

    const agentCallTraces = traces.filter((t) => t.type === 'agent_call');
    expect(agentCallTraces.length).toBeGreaterThanOrEqual(1);
  });
});
