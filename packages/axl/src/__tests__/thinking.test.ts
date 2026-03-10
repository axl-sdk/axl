import { describe, it, expect } from 'vitest';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
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

describe('thinking parameter', () => {
  it('passes thinking from AgentConfig to ChatOptions', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test', thinking: 'high' });

    await ctx.ask(a, 'hello');

    expect(provider.lastOptions?.thinking).toBe('high');
  });

  it('passes thinking from AskOptions to ChatOptions', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'hello', { thinking: 'low' });

    expect(provider.lastOptions?.thinking).toBe('low');
  });

  it('AskOptions thinking overrides AgentConfig thinking', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test', thinking: 'low' });

    await ctx.ask(a, 'hello', { thinking: 'high' });

    expect(provider.lastOptions?.thinking).toBe('high');
  });

  it('passes budget form to ChatOptions', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'hello', { thinking: { budgetTokens: 2000 } });

    expect(provider.lastOptions?.thinking).toEqual({ budgetTokens: 2000 });
  });

  it('includes thinking in onAgentCallComplete', async () => {
    const provider = createMockProvider();
    const calls: AgentCallInfo[] = [];
    const ctx = createContext(provider, { onAgentCallComplete: (c) => calls.push(c) });
    const a = agent({ model: 'mock:test', system: 'test', thinking: 'medium' });

    await ctx.ask(a, 'hello');

    expect(calls).toHaveLength(1);
    expect(calls[0].thinking).toBe('medium');
  });

  it('does not pass thinking when undefined', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'hello');

    expect(provider.lastOptions?.thinking).toBeUndefined();
  });

  it('passes thinking "max" from AgentConfig to ChatOptions', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test', thinking: 'max' });

    await ctx.ask(a, 'hello');

    expect(provider.lastOptions?.thinking).toBe('max');
  });

  it('AskOptions thinking "max" overrides AgentConfig thinking', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test', thinking: 'low' });

    await ctx.ask(a, 'hello', { thinking: 'max' });

    expect(provider.lastOptions?.thinking).toBe('max');
  });

  it('throws for budgetTokens <= 0', async () => {
    const provider = createMockProvider();
    const ctx = createContext(provider);
    const a = agent({ model: 'mock:test', system: 'test' });

    await expect(ctx.ask(a, 'hello', { thinking: { budgetTokens: 0 } })).rejects.toThrow(
      'thinking.budgetTokens must be a positive number',
    );

    await expect(ctx.ask(a, 'hello', { thinking: { budgetTokens: -100 } })).rejects.toThrow(
      'thinking.budgetTokens must be a positive number',
    );
  });
});
