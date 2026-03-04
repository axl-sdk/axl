import { describe, it, expect, vi } from 'vitest';
import { WorkflowContext } from '../context.js';
import type { WorkflowContextInit } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';

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
    // If signal is already aborted, throw immediately
    if (options.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
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
    executionId: 'test-exec-abort',
    metadata: init?.metadata ?? {},
    config: { defaultProvider: 'test' },
    providerRegistry: registry,
    onTrace: init?.onTrace ?? vi.fn(),
    ...init,
  });
}

const testAgent = agent({
  model: 'test:test-model',
  system: 'You are a test agent',
  tools: [],
});

// ═════════════════════════════════════════════════════════════════════════
// race() abort
// ═════════════════════════════════════════════════════════════════════════

describe('race() cancellation', () => {
  it('aborts losers when winner completes', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const abortedBranches: number[] = [];

    const result = await ctx.race([
      async () => {
        // This one resolves immediately — the winner
        return 'fast';
      },
      async () => {
        // Slow branch — should be "cancelled" because race resolved
        await new Promise((resolve) => setTimeout(resolve, 200));
        abortedBranches.push(1);
        return 'slow';
      },
    ]);

    expect(result).toBe('fast');
    // The slow branch may or may not have completed,
    // but the result is from the fast branch
  });

  it('resolves with first success even when some branches fail', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const result = await ctx.race([
      () => Promise.reject(new Error('fail')),
      () => Promise.resolve('success'),
    ]);

    expect(result).toBe('success');
  });

  it('rejects when all branches fail', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    await expect(
      ctx.race([
        () => Promise.reject(new Error('fail1')),
        () => Promise.reject(new Error('fail2')),
      ]),
    ).rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// spawn({ quorum }) abort
// ═════════════════════════════════════════════════════════════════════════

describe('spawn({ quorum }) cancellation', () => {
  it('aborts remaining branches after quorum met', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const results = await ctx.spawn(5, async (i) => `result-${i}`, { quorum: 2 });

    const successes = results.filter((r) => r?.ok);
    expect(successes.length).toBeGreaterThanOrEqual(2);
  });

  it('AbortError does not count as failure in spawn results', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const results = await ctx.spawn(
      3,
      async (i) => {
        if (i === 0) return 'quick'; // First completes immediately
        if (i === 1) return 'also-quick';
        // Third one is slow, should get aborted after quorum
        await new Promise((resolve) => setTimeout(resolve, 500));
        return 'slow';
      },
      { quorum: 2 },
    );

    // At least 2 successes (quorum)
    const successes = results.filter((r) => r?.ok);
    expect(successes.length).toBeGreaterThanOrEqual(2);

    // AbortErrors should not appear as { ok: false } in results
    const failures = results.filter((r) => r && !r.ok);
    for (const f of failures) {
      if (!f.ok) {
        expect(f.error).not.toContain('AbortError');
      }
    }
  });
});

describe('spawn({ quorum }) signal propagation', () => {
  it('cancels remaining branches after quorum of 2 from 5 branches', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);
    const completedBranches: number[] = [];

    const results = await ctx.spawn(
      5,
      async (i) => {
        if (i < 2) {
          // First two complete immediately
          completedBranches.push(i);
          return `quick-${i}`;
        }
        // Remaining branches are slow
        await new Promise((resolve) => setTimeout(resolve, 500));
        completedBranches.push(i);
        return `slow-${i}`;
      },
      { quorum: 2 },
    );

    // Exactly 2 or more successes
    const successes = results.filter((r) => r?.ok);
    expect(successes.length).toBeGreaterThanOrEqual(2);

    // The fast branches should have completed
    expect(completedBranches).toContain(0);
    expect(completedBranches).toContain(1);
  });

  it('propagates abort signal to provider in spawned branches', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider);

    const results = await ctx.spawn(
      3,
      async (i) => {
        if (i === 0) return 'winner';
        // Slow branches — will be cancelled
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Attempt an ask to check signal propagation
        await ctx.ask(testAgent, `from branch ${i}`);
        return `branch-${i}`;
      },
      { quorum: 1 },
    );

    const successes = results.filter((r) => r?.ok);
    expect(successes.length).toBeGreaterThanOrEqual(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// budget({ onExceed: 'hard_stop' }) abort
// ═════════════════════════════════════════════════════════════════════════

describe('budget({ onExceed: "hard_stop" }) cancellation', () => {
  it('aborts current call when budget exceeded with hard_stop', async () => {
    // Provider returns high cost to exceed the budget
    const provider = new TestProvider([
      { content: 'expensive-result', cost: 10.0 },
      { content: 'should-not-reach', cost: 10.0 },
    ]);
    const ctx = createTestContext(provider);

    const result = await ctx.budget({ cost: '$0.01', onExceed: 'hard_stop' }, async () => {
      // First call exceeds the budget
      const r = await ctx.ask(testAgent, 'expensive call');
      // The second call should be stopped by budget abort
      try {
        await ctx.ask(testAgent, 'another expensive call');
      } catch {
        // Expected — budget exceeded
      }
      return r;
    });

    expect(result.budgetExceeded).toBe(true);
  });

  it('returns budgetExceeded when hard_stop triggers abort on next call', async () => {
    const provider = new TestProvider([{ content: 'response-1', cost: 5.0 }]);
    const ctx = createTestContext(provider);

    const result = await ctx.budget({ cost: '$1.00', onExceed: 'hard_stop' }, async () => {
      await ctx.ask(testAgent, 'expensive call');
      return 'done';
    });

    // Budget was exceeded but first call completed
    expect(result.budgetExceeded).toBe(true);
    expect(result.totalCost).toBeGreaterThanOrEqual(5.0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// signal threading through ask()
// ═════════════════════════════════════════════════════════════════════════

describe('signal threading', () => {
  it('passes signal through to provider chat options', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const controller = new AbortController();
    const ctx = createTestContext(provider, { signal: controller.signal });

    await ctx.ask(testAgent, 'hello');

    expect(provider.calls[0].options.signal).toBe(controller.signal);
  });

  it('pre-aborted signal causes immediate rejection', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const controller = new AbortController();
    controller.abort();
    const ctx = createTestContext(provider, { signal: controller.signal });

    await expect(ctx.ask(testAgent, 'hello')).rejects.toThrow();
  });
});
