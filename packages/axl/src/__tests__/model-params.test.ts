import { describe, it, expect, vi } from 'vitest';
import { WorkflowContext } from '../context.js';
import type { WorkflowContextInit } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';
import type { AxlEvent } from '../types.js';

// ── Mock Provider ────────────────────────────────────────────────────────

class TestProvider {
  readonly name = 'test';
  private responses: Array<{ content: string; omitCost?: boolean }>;
  private callIndex = 0;
  calls: any[] = [];

  constructor(responses: Array<{ content: string; omitCost?: boolean }>) {
    this.responses = responses;
  }

  async chat(messages: any[], options: any) {
    this.calls.push({ messages, options });
    const resp = this.responses[this.callIndex] ?? this.responses[this.responses.length - 1];
    this.callIndex++;
    return {
      content: resp.content,
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      ...(resp.omitCost ? {} : { cost: 0.001 }),
    };
  }

  async *stream(messages: any[], options: any) {
    const resp = await this.chat(messages, options);
    yield { type: 'text_delta' as const, content: resp.content };
    yield {
      type: 'done' as const,
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    };
  }
}

// ── Helper ───────────────────────────────────────────────────────────────

function createTestContext(provider: TestProvider, init?: Partial<WorkflowContextInit>) {
  const registry = new ProviderRegistry();
  registry.registerInstance('test', provider as any);
  return new WorkflowContext({
    input: 'test input',
    executionId: 'test-exec-123',
    metadata: {},
    config: { defaultProvider: 'test' },
    providerRegistry: registry,
    onTrace: vi.fn(),
    ...init,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Configurable Model Parameters', () => {
  describe('defaults', () => {
    it('uses maxTokens 4096 when nothing is configured', async () => {
      const provider = new TestProvider([{ content: 'hello' }]);
      const a = agent({ model: 'test:m', system: 'sys' });
      const ctx = createTestContext(provider);

      await ctx.ask(a, 'hi');

      expect(provider.calls[0].options.maxTokens).toBe(4096);
      expect(provider.calls[0].options.temperature).toBeUndefined();
      expect(provider.calls[0].options.effort).toBeUndefined();
      expect(provider.calls[0].options.toolChoice).toBeUndefined();
      expect(provider.calls[0].options.stop).toBeUndefined();
    });
  });

  describe('agent-level config', () => {
    it('passes agent-level parameters to the provider', async () => {
      const provider = new TestProvider([{ content: 'hello' }]);
      const a = agent({
        model: 'test:m',
        system: 'sys',
        temperature: 0.7,
        maxTokens: 8192,
        effort: 'high',
        toolChoice: 'required',
        stop: ['\n---'],
      });
      const ctx = createTestContext(provider);

      await ctx.ask(a, 'hi');

      const opts = provider.calls[0].options;
      expect(opts.temperature).toBe(0.7);
      expect(opts.maxTokens).toBe(8192);
      expect(opts.effort).toBe('high');
      expect(opts.toolChoice).toBe('required');
      expect(opts.stop).toEqual(['\n---']);
    });
  });

  describe('per-call overrides via AskOptions', () => {
    it('overrides agent-level parameters with AskOptions', async () => {
      const provider = new TestProvider([{ content: 'hello' }]);
      const a = agent({
        model: 'test:m',
        system: 'sys',
        temperature: 0.7,
        maxTokens: 8192,
        effort: 'high',
        toolChoice: 'auto',
        stop: ['\n---'],
      });
      const ctx = createTestContext(provider);

      await ctx.ask(a, 'hi', {
        temperature: 0.2,
        maxTokens: 2048,
        effort: 'low',
        toolChoice: 'none',
        stop: ['END'],
      });

      const opts = provider.calls[0].options;
      expect(opts.temperature).toBe(0.2);
      expect(opts.maxTokens).toBe(2048);
      expect(opts.effort).toBe('low');
      expect(opts.toolChoice).toBe('none');
      expect(opts.stop).toEqual(['END']);
    });

    it('falls back to agent-level when AskOptions omits a field', async () => {
      const provider = new TestProvider([{ content: 'hello' }]);
      const a = agent({
        model: 'test:m',
        system: 'sys',
        temperature: 0.5,
        maxTokens: 16384,
      });
      const ctx = createTestContext(provider);

      // Only override temperature, leave others to agent defaults
      await ctx.ask(a, 'hi', { temperature: 0.1 });

      const opts = provider.calls[0].options;
      expect(opts.temperature).toBe(0.1);
      expect(opts.maxTokens).toBe(16384);
      expect(opts.effort).toBeUndefined();
    });
  });

  describe('promptCache precedence', () => {
    it('is off by default and reaches the provider as undefined', async () => {
      const provider = new TestProvider([{ content: 'hello' }]);
      const ctx = createTestContext(provider);
      await ctx.ask(agent({ model: 'test:m', system: 'sys' }), 'hi');
      expect(provider.calls[0].options.promptCache).toBeUndefined();
    });

    it('passes the agent-level opt-in to the provider', async () => {
      const provider = new TestProvider([{ content: 'hello' }]);
      const ctx = createTestContext(provider);
      await ctx.ask(agent({ model: 'test:m', system: 'sys', promptCache: true }), 'hi');
      expect(provider.calls[0].options.promptCache).toBe(true);
    });

    it('lets AskOptions override the agent-level value in both directions', async () => {
      const provider = new TestProvider([{ content: 'a' }, { content: 'b' }]);
      const ctx = createTestContext(provider);
      const on = agent({ model: 'test:m', system: 'sys', promptCache: true });
      const off = agent({ model: 'test:m', system: 'sys', promptCache: false });
      await ctx.ask(on, 'hi', { promptCache: false });
      await ctx.ask(off, 'hi', { promptCache: true });
      expect(provider.calls[0].options.promptCache).toBe(false);
      expect(provider.calls[1].options.promptCache).toBe(true);
    });

    it('falls back to the agent-level value when AskOptions omits it', async () => {
      const provider = new TestProvider([{ content: 'hello' }]);
      const ctx = createTestContext(provider);
      await ctx.ask(agent({ model: 'test:m', system: 'sys', promptCache: true }), 'hi', {
        effort: 'low',
      });
      expect(provider.calls[0].options.promptCache).toBe(true);
    });
  });

  describe('promptCache cold-write diagnostic', () => {
    class UsageProvider {
      readonly name = 'test';
      private i = 0;
      constructor(private readonly usages: Array<Record<string, number>>) {}
      async chat() {
        const u = this.usages[Math.min(this.i++, this.usages.length - 1)];
        return {
          content: 'ok',
          usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, ...u },
          cost: 0.001,
        };
      }
      async *stream() {
        const r = await this.chat();
        yield { type: 'done' as const, usage: r.usage };
      }
    }
    const warningsFrom = (onTrace: ReturnType<typeof vi.fn>) =>
      onTrace.mock.calls
        .map(([e]: any[]) => e?.data?.warning)
        .filter((w: unknown): w is string => typeof w === 'string' && w.includes('promptCache'));

    it('warns once after consecutive cache writes with no reads', async () => {
      const provider = new UsageProvider([{ cache_write_tokens: 900 }]);
      const onTrace = vi.fn();
      const ctx = createTestContext(provider as any, { onTrace });
      const a = agent({ model: 'test:m', system: 'sys', promptCache: true });
      await ctx.ask(a, 'one');
      await ctx.ask(a, 'two');
      await ctx.ask(a, 'three');
      const warnings = warningsFrom(onTrace);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('no cache reads');
    });

    it('stays silent when writes are followed by reads, and when promptCache is off', async () => {
      const cached = new UsageProvider([{ cache_write_tokens: 900 }, { cached_tokens: 900 }]);
      const onTrace = vi.fn();
      const ctx = createTestContext(cached as any, { onTrace });
      const a = agent({ model: 'test:m', system: 'sys', promptCache: true });
      await ctx.ask(a, 'one');
      await ctx.ask(a, 'two');
      await ctx.ask(a, 'three');
      expect(warningsFrom(onTrace)).toHaveLength(0);

      const off = new UsageProvider([{ cache_write_tokens: 900 }]);
      const onTrace2 = vi.fn();
      const ctx2 = createTestContext(off as any, { onTrace: onTrace2 });
      const b = agent({ model: 'test:m', system: 'sys' });
      await ctx2.ask(b, 'one');
      await ctx2.ask(b, 'two');
      await ctx2.ask(b, 'three');
      expect(warningsFrom(onTrace2)).toHaveLength(0);
    });
  });

  describe('onAgentCallComplete captures parameters', () => {
    it('reports resolved parameters in the callback', async () => {
      const provider = new TestProvider([{ content: 'hello' }]);
      const a = agent({
        model: 'test:m',
        system: 'sys',
        temperature: 0.7,
        maxTokens: 8192,
      });

      let captured: any;
      const ctx = createTestContext(provider, {
        onAgentCallComplete: (call) => {
          captured = call;
        },
      });

      await ctx.ask(a, 'hi', { maxTokens: 2048 });

      expect(captured.temperature).toBe(0.7);
      expect(captured.maxTokens).toBe(2048); // per-call override wins
    });

    it('reports defaults when nothing is configured', async () => {
      const provider = new TestProvider([{ content: 'hello' }]);
      const a = agent({ model: 'test:m', system: 'sys' });

      let captured: any;
      const ctx = createTestContext(provider, {
        onAgentCallComplete: (call) => {
          captured = call;
        },
      });

      await ctx.ask(a, 'hi');

      expect(captured.maxTokens).toBe(4096);
      expect(captured.temperature).toBeUndefined();
      expect(captured.effort).toBeUndefined();
    });

    it('reports when callback cost is a lower bound because the call was unpriced', async () => {
      const provider = new TestProvider([{ content: 'hello', omitCost: true }]);
      const a = agent({ model: 'test:m', system: 'sys' });

      let captured: any;
      const ctx = createTestContext(provider, {
        onAgentCallComplete: (call) => {
          captured = call;
        },
      });

      await ctx.ask(a, 'hi');

      expect(captured.cost).toBe(0);
      expect(captured.unpriced).toBe(true);
    });

    it('reports callback cost as exact when the call was priced', async () => {
      const provider = new TestProvider([{ content: 'hello' }]);
      const a = agent({ model: 'test:m', system: 'sys' });

      let captured: any;
      const ctx = createTestContext(provider, {
        onAgentCallComplete: (call) => {
          captured = call;
        },
      });

      await ctx.ask(a, 'hi');

      expect(captured.unpriced).toBe(false);
    });

    it('hook throw does NOT corrupt ask_end.outcome.ok (post-success observability is isolated)', async () => {
      // Reviewer concern: prior to this fix, an `onAgentCallComplete`
      // throw landed in the surrounding catch and overwrote
      // `outcome = { ok: false, error: hookErrorMessage }`. Reliability
      // dashboards filtering on ask_end.outcome.ok === false would
      // misattribute hook bugs to ask failures. The hook is now wrapped
      // in try/catch + console.error so the agent's actual outcome
      // survives intact.
      const provider = new TestProvider([{ content: 'real result' }]);
      const a = agent({ model: 'test:m', system: 'sys' });

      const events: AxlEvent[] = [];
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ctx = createTestContext(provider, {
        onAgentCallComplete: () => {
          throw new Error('hook is buggy');
        },
        onTrace: (e: AxlEvent) => {
          events.push(e);
        },
      });

      const result = await ctx.ask(a, 'hi');
      consoleErrorSpy.mockRestore();

      // Agent's real result is returned (hook throw doesn't propagate).
      expect(result).toBe('real result');

      // ask_end carries outcome.ok:true, NOT a misattributed false.
      const askEnd = events.find((e) => e.type === 'ask_end');
      expect(askEnd).toBeDefined();
      expect(askEnd!.outcome).toEqual({ ok: true, result: 'real result' });

      // No workflow-level error emitted (decision 9: only ask-internal
      // failures surface via ask_end, and this WASN'T a failure).
      expect(events.find((e) => e.type === 'error')).toBeUndefined();
    });
  });

  describe('toolChoice with function specification', () => {
    it('passes structured toolChoice to provider', async () => {
      const provider = new TestProvider([{ content: 'hello' }]);
      const a = agent({
        model: 'test:m',
        system: 'sys',
        toolChoice: { type: 'function', function: { name: 'search' } },
      });
      const ctx = createTestContext(provider);

      await ctx.ask(a, 'hi');

      expect(provider.calls[0].options.toolChoice).toEqual({
        type: 'function',
        function: { name: 'search' },
      });
    });
  });
});
