import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { WorkflowContext } from '../context.js';
import type { WorkflowContextInit } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import {
  NoConsensus,
  QuorumNotMet,
  VerifyError,
  TimeoutError,
  MaxTurnsError,
  BudgetExceededError,
} from '../errors.js';

// ── Mock Provider ────────────────────────────────────────────────────────

class TestProvider {
  readonly name = 'test';
  private responses: Array<{ content: string; tool_calls?: any[]; cost?: number }>;
  private callIndex = 0;
  calls: any[] = [];

  constructor(responses: Array<{ content: string; tool_calls?: any[]; cost?: number }>) {
    this.responses = responses;
  }

  async chat(messages: any[], options: any) {
    this.calls.push({ messages, options });
    const resp = this.responses[this.callIndex] ?? this.responses[this.responses.length - 1];
    this.callIndex++;
    return {
      content: resp.content,
      tool_calls: resp.tool_calls,
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      cost: resp.cost ?? 0.001,
    };
  }

  async *stream(messages: any[], options: any) {
    const resp = await this.chat(messages, options);
    yield { type: 'text_delta' as const, content: resp.content };
    yield { type: 'done' as const, usage: (resp as any).usage };
  }
}

// ── Helper ───────────────────────────────────────────────────────────────

function createTestContext(provider: TestProvider, init?: Partial<WorkflowContextInit>) {
  const registry = new ProviderRegistry();
  registry.registerInstance('test', provider as any);
  return new WorkflowContext({
    input: init?.input ?? 'test input',
    executionId: 'test-exec-123',
    metadata: init?.metadata ?? {},
    config: { defaultProvider: 'test' },
    providerRegistry: registry,
    onTrace: init?.onTrace ?? vi.fn(),
    ...init,
  });
}

// ── Test Agent ───────────────────────────────────────────────────────────

const testAgent = agent({
  model: 'test:test-model',
  system: 'You are a test agent',
  tools: [],
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.ask()
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.ask()', () => {
  it('returns text response from agent', async () => {
    const provider = new TestProvider([{ content: 'Hello, world!' }]);
    const ctx = createTestContext(provider);

    const result = await ctx.ask(testAgent, 'Say hello');
    expect(result).toBe('Hello, world!');
  });

  it('returns parsed/validated object when schema provided', async () => {
    const provider = new TestProvider([{ content: '{"name":"Alice","age":30}' }]);
    const ctx = createTestContext(provider);

    const schema = z.object({ name: z.string(), age: z.number() });
    const result = await ctx.ask(testAgent, 'Get user info', { schema });
    expect(result).toEqual({ name: 'Alice', age: 30 });
  });

  it('self-correction retry on schema validation failure then success', async () => {
    const provider = new TestProvider([
      // First response: invalid (missing age)
      { content: '{"name":"Alice"}' },
      // Second response: valid
      { content: '{"name":"Alice","age":30}' },
    ]);
    const ctx = createTestContext(provider);

    const schema = z.object({ name: z.string(), age: z.number() });
    const result = await ctx.ask(testAgent, 'Get user info', { schema, retries: 3 });
    expect(result).toEqual({ name: 'Alice', age: 30 });
    // Provider should have been called twice
    expect(provider.calls.length).toBe(2);
  });

  it('throws VerifyError after max retries exhausted', async () => {
    const provider = new TestProvider([{ content: '{"invalid":true}' }]);
    const ctx = createTestContext(provider);

    const schema = z.object({ name: z.string(), age: z.number() });
    await expect(ctx.ask(testAgent, 'Get user info', { schema, retries: 2 })).rejects.toThrow(
      VerifyError,
    );
  });

  it('handles tool calls: agent returns tool_call, then final text', async () => {
    const searchTool = tool({
      name: 'search',
      description: 'Search the web',
      input: z.object({ query: z.string() }),
      handler: async (input) => ({ results: [`Found: ${input.query}`] }),
    });

    const agentWithTools = agent({
      model: 'test:test-model',
      system: 'You are a test agent with tools',
      tools: [searchTool],
    });

    const provider = new TestProvider([
      // First response: tool call
      {
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'search',
              arguments: '{"query":"vitest"}',
            },
          },
        ],
      },
      // Second response: final text after seeing tool result
      { content: 'I found results for vitest.' },
    ]);
    const ctx = createTestContext(provider);

    const result = await ctx.ask(agentWithTools, 'Search for vitest');
    expect(result).toBe('I found results for vitest.');
    expect(provider.calls.length).toBe(2);

    // Verify tool result was included in the messages for the second call
    const secondCallMessages = provider.calls[1].messages;
    const toolMessage = secondCallMessages.find((m: any) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage.content).toContain('Found: vitest');
  });

  it('redacts sensitive tool output in messages', async () => {
    const secretTool = tool({
      name: 'get_secret',
      description: 'Get a secret value',
      input: z.object({}),
      handler: async () => ({ secret: 'super-secret-value' }),
      sensitive: true,
    });

    const agentWithSensitiveTool = agent({
      model: 'test:test-model',
      system: 'You are a test agent',
      tools: [secretTool],
    });

    const provider = new TestProvider([
      {
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_secret', arguments: '{}' },
          },
        ],
      },
      { content: 'Secret retrieved.' },
    ]);
    const ctx = createTestContext(provider);

    await ctx.ask(agentWithSensitiveTool, 'Get the secret');

    // Verify the tool result was redacted in messages sent to provider
    const secondCallMessages = provider.calls[1].messages;
    const toolMessage = secondCallMessages.find((m: any) => m.role === 'tool');
    expect(toolMessage.content).toBe('[REDACTED - sensitive tool output]');
    expect(toolMessage.content).not.toContain('super-secret-value');
  });

  it('sends system prompt in messages', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    await ctx.ask(testAgent, 'hello');

    const messages = provider.calls[0].messages;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe('You are a test agent');
  });

  it('per-call metadata overrides workflow metadata in dynamic model/system', async () => {
    const dynamicAgent = agent({
      model: (ctx) => {
        return ctx.metadata?.tier === 'premium' ? 'test:premium-model' : 'test:basic-model';
      },
      system: (ctx) => `You serve ${ctx.metadata?.tier ?? 'unknown'} tier users.`,
    });

    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider, {
      metadata: { tier: 'basic', userId: '123' },
    });

    await ctx.ask(dynamicAgent, 'hello', {
      metadata: { tier: 'premium' },
    });

    // The provider should receive the premium model
    expect(provider.calls[0].options.model).toBe('premium-model');

    // The system prompt should reflect premium tier
    const systemMsg = provider.calls[0].messages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).toBe('You serve premium tier users.');
  });

  it('per-call metadata merges with workflow metadata (workflow keys preserved)', async () => {
    const dynamicAgent = agent({
      model: (ctx) => `test:model-${ctx.metadata?.region ?? 'default'}`,
      system: (ctx) => `Region: ${ctx.metadata?.region}, User: ${ctx.metadata?.userId}`,
    });

    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider, {
      metadata: { userId: 'u42', region: 'us-east' },
    });

    // Override region but userId should still be available
    await ctx.ask(dynamicAgent, 'hello', {
      metadata: { region: 'eu-west' },
    });

    const systemMsg = provider.calls[0].messages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).toBe('Region: eu-west, User: u42');
    expect(provider.calls[0].options.model).toBe('model-eu-west');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.spawn()
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.spawn()', () => {
  it('runs n concurrent tasks and returns Result[]', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const results = await ctx.spawn(3, async (i) => `result-${i}`);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true, value: 'result-0' });
    expect(results[1]).toEqual({ ok: true, value: 'result-1' });
    expect(results[2]).toEqual({ ok: true, value: 'result-2' });
  });

  it('returns errors as { ok: false } for failed tasks', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const results = await ctx.spawn(3, async (i) => {
      if (i === 1) throw new Error('task 1 failed');
      return `result-${i}`;
    });

    expect(results[0]).toEqual({ ok: true, value: 'result-0' });
    expect(results[1]).toEqual({ ok: false, error: 'task 1 failed' });
    expect(results[2]).toEqual({ ok: true, value: 'result-2' });
  });

  it('throws QuorumNotMet when quorum is not met', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    await expect(
      ctx.spawn(
        3,
        async (i) => {
          if (i < 2) throw new Error(`fail-${i}`);
          return 'success';
        },
        { quorum: 2 },
      ),
    ).rejects.toThrow(QuorumNotMet);
  });

  it('resolves early when quorum is met', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const results = await ctx.spawn(5, async (i) => `result-${i}`, { quorum: 2 });

    const successes = results.filter((r) => r?.ok);
    expect(successes.length).toBeGreaterThanOrEqual(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.vote()
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.vote()', () => {
  function makeCtx() {
    const provider = new TestProvider([{ content: 'ok' }]);
    return createTestContext(provider);
  }

  it('majority: returns most common value', () => {
    const ctx = makeCtx();
    const results = [
      { ok: true as const, value: 'a' },
      { ok: true as const, value: 'b' },
      { ok: true as const, value: 'a' },
      { ok: true as const, value: 'a' },
      { ok: true as const, value: 'b' },
    ];
    const winner = ctx.vote(results, { strategy: 'majority' });
    expect(winner).toBe('a');
  });

  it('unanimous: returns value when all agree', () => {
    const ctx = makeCtx();
    const results = [
      { ok: true as const, value: 'yes' },
      { ok: true as const, value: 'yes' },
      { ok: true as const, value: 'yes' },
    ];
    const winner = ctx.vote(results, { strategy: 'unanimous' });
    expect(winner).toBe('yes');
  });

  it('unanimous: throws NoConsensus when values differ', () => {
    const ctx = makeCtx();
    const results = [
      { ok: true as const, value: 'yes' },
      { ok: true as const, value: 'no' },
    ];
    expect(() => ctx.vote(results, { strategy: 'unanimous' })).toThrow(NoConsensus);
  });

  it('highest with key: returns item with highest value on key', () => {
    const ctx = makeCtx();
    const results = [
      { ok: true as const, value: { name: 'A', score: 10 } },
      { ok: true as const, value: { name: 'B', score: 25 } },
      { ok: true as const, value: { name: 'C', score: 15 } },
    ];
    const winner = ctx.vote(results, { strategy: 'highest', key: 'score' });
    expect(winner).toEqual({ name: 'B', score: 25 });
  });

  it('lowest with key: returns item with lowest value on key', () => {
    const ctx = makeCtx();
    const results = [
      { ok: true as const, value: { name: 'A', cost: 100 } },
      { ok: true as const, value: { name: 'B', cost: 50 } },
      { ok: true as const, value: { name: 'C', cost: 75 } },
    ];
    const winner = ctx.vote(results, { strategy: 'lowest', key: 'cost' });
    expect(winner).toEqual({ name: 'B', cost: 50 });
  });

  it('mean: returns arithmetic mean', () => {
    const ctx = makeCtx();
    const results = [
      { ok: true as const, value: 10 },
      { ok: true as const, value: 20 },
      { ok: true as const, value: 30 },
    ];
    const mean = ctx.vote(results, { strategy: 'mean' });
    expect(mean).toBe(20);
  });

  it('median: returns median of odd-length array', () => {
    const ctx = makeCtx();
    const results = [
      { ok: true as const, value: 3 },
      { ok: true as const, value: 1 },
      { ok: true as const, value: 2 },
    ];
    const median = ctx.vote(results, { strategy: 'median' });
    expect(median).toBe(2);
  });

  it('median: returns median of even-length array', () => {
    const ctx = makeCtx();
    const results = [
      { ok: true as const, value: 1 },
      { ok: true as const, value: 2 },
      { ok: true as const, value: 3 },
      { ok: true as const, value: 4 },
    ];
    const median = ctx.vote(results, { strategy: 'median' });
    expect(median).toBe(2.5);
  });

  it('custom with reducer: calls reducer with successful values', async () => {
    const ctx = makeCtx();
    const results = [
      { ok: true as const, value: 5 },
      { ok: true as const, value: 10 },
      { ok: true as const, value: 15 },
    ];
    const sum = await ctx.vote(results, {
      strategy: 'custom',
      reducer: (vals: number[]) => vals.reduce((a, b) => a + b, 0),
    });
    expect(sum).toBe(30);
  });

  it('scorer with async function for highest', async () => {
    const ctx = makeCtx();
    const results = [
      { ok: true as const, value: 'short' },
      { ok: true as const, value: 'a much longer string' },
      { ok: true as const, value: 'medium text' },
    ];
    const winner = await ctx.vote(results, {
      strategy: 'highest',
      scorer: async (val: string) => val.length,
    });
    expect(winner).toBe('a much longer string');
  });

  it('scorer with async function for lowest', async () => {
    const ctx = makeCtx();
    const results = [
      { ok: true as const, value: 'short' },
      { ok: true as const, value: 'a much longer string' },
      { ok: true as const, value: 'medium text' },
    ];
    const winner = await ctx.vote(results, {
      strategy: 'lowest',
      scorer: async (val: string) => val.length,
    });
    expect(winner).toBe('short');
  });

  it('throws NoConsensus when no successful results', () => {
    const ctx = makeCtx();
    const results = [
      { ok: false as const, error: 'fail1' },
      { ok: false as const, error: 'fail2' },
    ];
    expect(() => ctx.vote(results, { strategy: 'majority' })).toThrow(NoConsensus);
  });

  it('filters out failed results before voting', () => {
    const ctx = makeCtx();
    const results = [
      { ok: true as const, value: 'a' },
      { ok: false as const, error: 'failed' },
      { ok: true as const, value: 'a' },
      { ok: true as const, value: 'b' },
    ];
    const winner = ctx.vote(results, { strategy: 'majority' });
    expect(winner).toBe('a');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.verify()
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.verify()', () => {
  it('returns validated value on success', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const schema = z.object({ name: z.string() });
    const result = await ctx.verify(async () => ({ name: 'Alice' }), schema);
    expect(result).toEqual({ name: 'Alice' });
  });

  it('retries on failure', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    let attempt = 0;
    const schema = z.number();
    const result = await ctx.verify(
      async () => {
        attempt++;
        if (attempt < 3) return 'not a number';
        return 42;
      },
      schema,
      { retries: 3 },
    );
    expect(result).toBe(42);
    expect(attempt).toBe(3);
  });

  it('returns fallback when all retries fail and fallback provided', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const schema = z.number();
    const result = await ctx.verify(async () => 'always invalid', schema, {
      retries: 2,
      fallback: -1,
    });
    expect(result).toBe(-1);
  });

  it('throws VerifyError when retries fail and no fallback', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const schema = z.number();
    await expect(ctx.verify(async () => 'always invalid', schema, { retries: 2 })).rejects.toThrow(
      VerifyError,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.budget()
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.budget()', () => {
  it('returns BudgetResult with value and cost tracking', async () => {
    const provider = new TestProvider([{ content: 'hello', cost: 0.01 }]);
    const ctx = createTestContext(provider);

    const result = await ctx.budget({ cost: '$1.00' }, async () => {
      // Make an ask call to trigger cost tracking
      await ctx.ask(testAgent, 'hello');
      return 'done';
    });

    expect(result.value).toBe('done');
    expect(result.totalCost).toBeGreaterThan(0);
    expect(result.budgetExceeded).toBe(false);
  });

  it('sets budgetExceeded when cost exceeds limit', async () => {
    // Provider returns high cost to exceed budget
    const provider = new TestProvider([{ content: 'hello', cost: 5.0 }]);
    const ctx = createTestContext(provider);

    const result = await ctx.budget({ cost: '$0.01' }, async () => {
      await ctx.ask(testAgent, 'expensive call');
      return 'done';
    });

    expect(result.budgetExceeded).toBe(true);
    expect(result.totalCost).toBeGreaterThanOrEqual(5.0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.race()
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.race()', () => {
  it('returns first successful result', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const result = await ctx.race([
      () => new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 100)),
      () => Promise.resolve('fast'),
      () => new Promise<string>((resolve) => setTimeout(() => resolve('slower'), 200)),
    ]);
    expect(result).toBe('fast');
  });

  it('rejects when all fail', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    await expect(
      ctx.race([
        () => Promise.reject(new Error('fail1')),
        () => Promise.reject(new Error('fail2')),
        () => Promise.reject(new Error('fail3')),
      ]),
    ).rejects.toThrow('fail3');
  });

  it('returns first success even if some fail', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const result = await ctx.race([
      () => Promise.reject(new Error('fail')),
      () => Promise.resolve('success'),
    ]);
    expect(result).toBe('success');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.parallel()
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.parallel()', () => {
  it('returns all results as tuple', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const [a, b, c] = await ctx.parallel([
      () => Promise.resolve('first'),
      () => Promise.resolve(42),
      () => Promise.resolve(true),
    ]);

    expect(a).toBe('first');
    expect(b).toBe(42);
    expect(c).toBe(true);
  });

  it('rejects if any function rejects', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    await expect(
      ctx.parallel([() => Promise.resolve('ok'), () => Promise.reject(new Error('boom'))]),
    ).rejects.toThrow('boom');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.map()
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.map()', () => {
  it('maps over items and returns Result[] with successes', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const results = await ctx.map([1, 2, 3], async (item) => item * 2);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true, value: 2 });
    expect(results[1]).toEqual({ ok: true, value: 4 });
    expect(results[2]).toEqual({ ok: true, value: 6 });
  });

  it('returns Result[] with failures', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const results = await ctx.map([1, 2, 3], async (item) => {
      if (item === 2) throw new Error('item 2 failed');
      return item * 10;
    });

    expect(results[0]).toEqual({ ok: true, value: 10 });
    expect(results[1]).toEqual({ ok: false, error: 'item 2 failed' });
    expect(results[2]).toEqual({ ok: true, value: 30 });
  });

  it('respects bounded concurrency', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const results = await ctx.map(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      async (item) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        currentConcurrent--;
        return item;
      },
      { concurrency: 3 },
    );

    expect(results).toHaveLength(10);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('handles empty array', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const results = await ctx.map([], async (item) => item);
    expect(results).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.log()
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.log()', () => {
  it('emits trace event with log type', () => {
    const onTrace = vi.fn();
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider, { onTrace });

    ctx.log('my_event', { key: 'value' });

    expect(onTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'log',
        executionId: 'test-exec-123',
        data: { event: 'my_event', key: 'value' },
        step: expect.any(Number),
        timestamp: expect.any(Number),
      }),
    );
  });

  it('emits trace event with scalar data', () => {
    const onTrace = vi.fn();
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider, { onTrace });

    ctx.log('count', 42);

    expect(onTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'log',
        data: { event: 'count', value: 42 },
      }),
    );
  });

  it('emits trace event without data', () => {
    const onTrace = vi.fn();
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider, { onTrace });

    ctx.log('checkpoint');

    expect(onTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'log',
        data: { event: 'checkpoint' },
      }),
    );
  });

  it('increments step counter across multiple log calls', () => {
    const onTrace = vi.fn();
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider, { onTrace });

    ctx.log('first');
    ctx.log('second');
    ctx.log('third');

    const steps = onTrace.mock.calls.map((call) => call[0].step);
    expect(steps[0]).toBeLessThan(steps[1]);
    expect(steps[1]).toBeLessThan(steps[2]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.vote() — error paths
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.vote() error paths', () => {
  function makeCtx() {
    const provider = new TestProvider([{ content: 'ok' }]);
    return createTestContext(provider);
  }

  it('custom strategy without reducer throws NoConsensus', () => {
    const ctx = makeCtx();
    const results = [{ ok: true as const, value: 'a' }];
    expect(() => ctx.vote(results, { strategy: 'custom' })).toThrow(NoConsensus);
  });

  it('scorer with unsupported strategy throws NoConsensus', async () => {
    const ctx = makeCtx();
    const results = [
      { ok: true as const, value: 'a' },
      { ok: true as const, value: 'b' },
    ];
    await expect(
      ctx.vote(results, { strategy: 'majority', scorer: async (v: string) => v.length }),
    ).rejects.toThrow(NoConsensus);
  });

  it('unknown strategy string throws NoConsensus', () => {
    const ctx = makeCtx();
    const results = [{ ok: true as const, value: 'a' }];
    expect(() => ctx.vote(results, { strategy: 'unknown_strategy' as any })).toThrow(NoConsensus);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.getBudgetStatus()
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.getBudgetStatus()', () => {
  it('returns null when not inside a budget block', () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);
    expect(ctx.getBudgetStatus()).toBeNull();
  });

  it('returns correct values inside a budget block', async () => {
    const provider = new TestProvider([{ content: 'hello', cost: 0.05 }]);
    const ctx = createTestContext(provider);

    await ctx.budget({ cost: '$1.00' }, async () => {
      // Before any ask, spent should be 0
      const before = ctx.getBudgetStatus();
      expect(before).not.toBeNull();
      expect(before!.spent).toBe(0);
      expect(before!.limit).toBe(1.0);
      expect(before!.remaining).toBe(1.0);

      await ctx.ask(testAgent, 'hello');

      const after = ctx.getBudgetStatus();
      expect(after!.spent).toBeGreaterThan(0);
      expect(after!.remaining).toBeLessThan(1.0);
      expect(after!.remaining).toBe(Math.max(0, after!.limit - after!.spent));

      return 'done';
    });

    // After budget block, should be null again
    expect(ctx.getBudgetStatus()).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Trace redaction
// ═════════════════════════════════════════════════════════════════════════

describe('trace redaction', () => {
  it('redacts prompt/response from agent_call traces when redact is true', async () => {
    const onTrace = vi.fn();
    const provider = new TestProvider([{ content: 'secret response' }]);
    const ctx = createTestContext(provider, {
      onTrace,
      config: { defaultProvider: 'test', trace: { redact: true } },
    });

    await ctx.ask(testAgent, 'secret prompt');

    const agentCallTrace = onTrace.mock.calls
      .map((c) => c[0])
      .find((e: any) => e.type === 'agent_call_end');
    expect(agentCallTrace).toBeDefined();
    expect((agentCallTrace.data as any).prompt).toBe('[redacted]');
    expect((agentCallTrace.data as any).response).toBe('[redacted]');
  });

  it('does not redact when redact is false', async () => {
    const onTrace = vi.fn();
    const provider = new TestProvider([{ content: 'visible response' }]);
    const ctx = createTestContext(provider, {
      onTrace,
      config: { defaultProvider: 'test', trace: { redact: false } },
    });

    await ctx.ask(testAgent, 'visible prompt');

    const agentCallTrace = onTrace.mock.calls
      .map((c) => c[0])
      .find((e: any) => e.type === 'agent_call_end');
    expect(agentCallTrace).toBeDefined();
    expect((agentCallTrace.data as any).prompt).toBe('visible prompt');
    expect((agentCallTrace.data as any).response).toBe('visible response');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.ask() — TimeoutError
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.ask() TimeoutError', () => {
  it('throws TimeoutError when agent tool loop exceeds timeout', async () => {
    // Use a tool so the agent enters a multi-turn loop where timeout can trigger
    const slowTool = tool({
      name: 'slow_tool',
      description: 'A slow tool',
      input: z.object({ q: z.string() }),
      handler: async (input) => {
        // Delay enough to push total time past timeout
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { result: input.q };
      },
    });

    const agentWithTimeout = agent({
      model: 'test:test-model',
      system: 'You are a test agent',
      tools: [slowTool],
      timeout: '100ms',
    });

    // Provider always returns tool calls so the loop continues until timeout
    const provider = new TestProvider([
      {
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'slow_tool', arguments: '{"q":"a"}' } },
        ],
      },
    ]);
    const ctx = createTestContext(provider);

    await expect(ctx.ask(agentWithTimeout, 'hello')).rejects.toThrow(TimeoutError);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.ask() — MaxTurnsError
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.ask() MaxTurnsError', () => {
  it('throws MaxTurnsError when tool-calling loop exceeds maxTurns', async () => {
    const searchTool = tool({
      name: 'search',
      description: 'Search the web',
      input: z.object({ query: z.string() }),
      handler: async (input) => ({ results: [`Found: ${input.query}`] }),
    });

    const agentWithMaxTurns = agent({
      model: 'test:test-model',
      system: 'You are a test agent',
      tools: [searchTool],
      maxTurns: 3,
    });

    // Provider that always returns tool calls (never a final text response)
    const provider = new TestProvider([
      {
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"query":"test"}' },
          },
        ],
      },
    ]);
    const ctx = createTestContext(provider);

    await expect(ctx.ask(agentWithMaxTurns, 'Search forever')).rejects.toThrow(MaxTurnsError);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.budget() — BudgetExceededError / hard_stop
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.budget() hard_stop', () => {
  it('returns budgetExceeded and null value when hard_stop aborts work', async () => {
    // Provider with cost that exceeds the budget on the first call
    const provider = new TestProvider([{ content: 'expensive', cost: 5.0 }]);
    const ctx = createTestContext(provider);

    const result = await ctx.budget({ cost: '$0.01', onExceed: 'hard_stop' }, async () => {
      await ctx.ask(testAgent, 'expensive call');
      // Second call should be aborted
      await ctx.ask(testAgent, 'another expensive call');
      return 'should not reach';
    });

    expect(result.budgetExceeded).toBe(true);
    expect(result.value).toBeNull();
    expect(result.totalCost).toBeGreaterThanOrEqual(5.0);
  });

  it('finish_and_stop throws BudgetExceededError on next ask', async () => {
    const provider = new TestProvider([
      { content: 'first response', cost: 5.0 },
      { content: 'second response', cost: 0.001 },
    ]);
    const ctx = createTestContext(provider);

    const result = await ctx.budget({ cost: '$0.01', onExceed: 'finish_and_stop' }, async () => {
      await ctx.ask(testAgent, 'first call');
      // Budget is now exceeded; next call should throw
      try {
        await ctx.ask(testAgent, 'second call');
        return 'should not reach';
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetExceededError);
        return 'caught budget error';
      }
    });

    expect(result.budgetExceeded).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ctx.map() — quorum
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.map() with quorum', () => {
  it('returns early after quorum successes', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);
    const results = await ctx.map(
      [1, 2, 3, 4, 5],
      async (item) => {
        // Simulate work
        await new Promise((resolve) => setTimeout(resolve, 10));
        return item * 2;
      },
      { quorum: 2, concurrency: 5 },
    );

    const successes = results.filter((r) => r?.ok);
    expect(successes.length).toBeGreaterThanOrEqual(2);
  });

  it('throws QuorumNotMet when quorum cannot be met', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    await expect(
      ctx.map(
        [1, 2, 3],
        async () => {
          throw new Error('always fails');
        },
        { quorum: 2 },
      ),
    ).rejects.toThrow(QuorumNotMet);
  });
});
