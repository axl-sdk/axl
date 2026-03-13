import { describe, it, expect } from 'vitest';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { resolveThinkingOptions } from '../providers/types.js';
import type { Provider, ChatOptions, StreamChunk } from '../providers/types.js';
import type { ChatMessage, ProviderResponse, AgentCallInfo } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function createMockProvider(): Provider & { lastOptions: ChatOptions | null } {
  const mock: Provider & { lastOptions: ChatOptions | null } = {
    name: 'mock',
    lastOptions: null,
    async chat(_messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
      mock.lastOptions = options;
      return {
        content: 'ok',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 0.001,
      };
    },
    async *stream(_messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
      mock.lastOptions = options;
      yield { type: 'text_delta', content: 'ok' };
      yield { type: 'done', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    },
  };
  return mock;
}

function createContext(
  provider: Provider,
  opts?: { onAgentCallComplete?: (call: AgentCallInfo) => void },
) {
  const registry = new ProviderRegistry();
  registry.registerInstance('mock', provider as any);
  return new WorkflowContext({
    input: 'test',
    executionId: 'test-exec',
    config: {},
    providerRegistry: registry,
    onAgentCallComplete: opts?.onAgentCallComplete,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('effort parameter', () => {
  it('passes effort from AgentConfig to ChatOptions', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test', effort: 'high' });

    await ctx.ask(a, 'hello');

    expect(provider.lastOptions?.effort).toBe('high');
  });

  it('passes effort from AskOptions to ChatOptions', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'hello', { effort: 'low' });

    expect(provider.lastOptions?.effort).toBe('low');
  });

  it('AskOptions effort overrides AgentConfig effort', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test', effort: 'low' });

    await ctx.ask(a, 'hello', { effort: 'high' });

    expect(provider.lastOptions?.effort).toBe('high');
  });

  it('passes thinkingBudget from AskOptions to ChatOptions', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'hello', { thinkingBudget: 2000 });

    expect(provider.lastOptions?.thinkingBudget).toBe(2000);
  });

  it('passes thinkingBudget from AgentConfig to ChatOptions', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test', thinkingBudget: 5000 });

    await ctx.ask(a, 'hello');

    expect(provider.lastOptions?.thinkingBudget).toBe(5000);
  });

  it('AskOptions thinkingBudget overrides AgentConfig', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test', thinkingBudget: 5000 });

    await ctx.ask(a, 'hello', { thinkingBudget: 8000 });

    expect(provider.lastOptions?.thinkingBudget).toBe(8000);
  });

  it('passes includeThoughts from AgentConfig to ChatOptions', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test', includeThoughts: true });

    await ctx.ask(a, 'hello');

    expect(provider.lastOptions?.includeThoughts).toBe(true);
  });

  it('AskOptions includeThoughts overrides AgentConfig', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test', includeThoughts: false });

    await ctx.ask(a, 'hello', { includeThoughts: true });

    expect(provider.lastOptions?.includeThoughts).toBe(true);
  });

  it('includes effort in onAgentCallComplete', async () => {
    const provider = createMockProvider();
    const calls: AgentCallInfo[] = [];
    const ctx = createContext(provider, { onAgentCallComplete: (c) => calls.push(c) });
    const a = agent({ model: 'mock:test', system: 'test', effort: 'medium' });

    await ctx.ask(a, 'hello');

    expect(calls).toHaveLength(1);
    expect(calls[0].effort).toBe('medium');
  });

  it('does not pass effort when undefined', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'hello');

    expect(provider.lastOptions?.effort).toBeUndefined();
  });

  it('passes effort "max" from AgentConfig to ChatOptions', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test', effort: 'max' });

    await ctx.ask(a, 'hello');

    expect(provider.lastOptions?.effort).toBe('max');
  });

  it('AskOptions effort "max" overrides AgentConfig effort', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test', effort: 'low' });

    await ctx.ask(a, 'hello', { effort: 'max' });

    expect(provider.lastOptions?.effort).toBe('max');
  });

  it('effort "none" disables thinking', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test', effort: 'none' });

    await ctx.ask(a, 'hello');

    expect(provider.lastOptions?.effort).toBe('none');
  });
});

describe('resolveThinkingOptions', () => {
  it('returns defaults when nothing is set', () => {
    const result = resolveThinkingOptions({});
    expect(result.effort).toBeUndefined();
    expect(result.thinkingBudget).toBeUndefined();
    expect(result.includeThoughts).toBe(false);
    expect(result.thinkingDisabled).toBe(false);
    expect(result.activeEffort).toBeUndefined();
    expect(result.hasBudgetOverride).toBe(false);
  });

  it('passes through effort and computes derived fields', () => {
    const result = resolveThinkingOptions({ effort: 'high' });
    expect(result.effort).toBe('high');
    expect(result.activeEffort).toBe('high');
    expect(result.thinkingDisabled).toBe(false);
    expect(result.hasBudgetOverride).toBe(false);
  });

  it('effort: none sets thinkingDisabled and clears activeEffort', () => {
    const result = resolveThinkingOptions({ effort: 'none' });
    expect(result.thinkingDisabled).toBe(true);
    expect(result.activeEffort).toBeUndefined();
  });

  it('thinkingBudget: 0 sets thinkingDisabled', () => {
    const result = resolveThinkingOptions({ thinkingBudget: 0 });
    expect(result.thinkingDisabled).toBe(true);
    expect(result.hasBudgetOverride).toBe(false);
  });

  it('positive thinkingBudget sets hasBudgetOverride', () => {
    const result = resolveThinkingOptions({ thinkingBudget: 5000 });
    expect(result.thinkingBudget).toBe(5000);
    expect(result.hasBudgetOverride).toBe(true);
    expect(result.thinkingDisabled).toBe(false);
  });

  it('budget override wins over effort: none (contradictory inputs)', () => {
    const result = resolveThinkingOptions({ effort: 'none', thinkingBudget: 5000 });
    expect(result.hasBudgetOverride).toBe(true);
    expect(result.thinkingDisabled).toBe(false); // budget wins
    expect(result.thinkingBudget).toBe(5000);
    expect(result.activeEffort).toBeUndefined(); // effort: 'none' → no active effort
  });

  it('defaults includeThoughts to false', () => {
    const result = resolveThinkingOptions({ effort: 'high' });
    expect(result.includeThoughts).toBe(false);
  });

  it('passes through includeThoughts when true', () => {
    const result = resolveThinkingOptions({ includeThoughts: true });
    expect(result.includeThoughts).toBe(true);
  });

  it('throws on negative thinkingBudget', () => {
    expect(() => resolveThinkingOptions({ thinkingBudget: -100 })).toThrow(
      'thinkingBudget must be non-negative',
    );
  });
});
