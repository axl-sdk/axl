import { describe, it, expect } from 'vitest';
import { agent } from '../agent.js';
import { z } from 'zod';
import { createSequenceProvider, createTestCtx, type SequenceProvider } from './helpers.js';

describe('ctx.delegate()', () => {
  it('throws on empty agents array', async () => {
    const { ctx } = createTestCtx();
    await expect(ctx.delegate([], 'hello')).rejects.toThrow(
      'ctx.delegate() requires at least one candidate agent',
    );
  });

  it('single agent skips router and calls ask directly', async () => {
    const solo = agent({
      name: 'solo_agent',
      model: 'mock:test',
      system: 'You are the solo agent.',
    });

    const provider = createSequenceProvider(['solo response']);
    const { ctx, traces } = createTestCtx({ provider });
    const result = await ctx.delegate([solo], 'do the thing');

    expect(result).toBe('solo response');

    // Verify provider received the solo agent's system prompt, not a router prompt
    const firstCall = provider.calls[0];
    const messages = firstCall.messages as Array<{ role: string; content: string }>;
    const systemMsg = messages.find((m) => m.role === 'system' || m.role === 'developer');
    expect(systemMsg?.content).toBe('You are the solo agent.');

    // No delegate trace event should be emitted for single-agent case
    const delegateTraces = traces.filter((t) => t.type === 'delegate');
    expect(delegateTraces).toHaveLength(0);
  });

  it('multiple agents creates router with handoffs', async () => {
    const billing = agent({
      name: 'billing',
      model: 'mock:test',
      system: 'You handle billing inquiries.',
    });

    const support = agent({
      name: 'support',
      model: 'mock:test',
      system: 'You handle support inquiries.',
    });

    // Call 1: router picks handoff_to_billing
    // Call 2: billing agent responds
    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'handoff_to_billing', arguments: '{}' },
          },
        ],
      },
      'Your invoice total is $42.',
    ]);

    const { ctx } = createTestCtx({ provider });
    const result = await ctx.delegate([billing, support], 'What is my invoice total?');

    expect(result).toBe('Your invoice total is $42.');

    // First call should be the router (system = 'Route to the best agent...')
    const routerMessages = provider.calls[0].messages as Array<{ role: string; content: string }>;
    const routerSystem = routerMessages.find((m) => m.role === 'system' || m.role === 'developer');
    expect(routerSystem?.content).toBe(
      'Route to the best agent for this task. Always hand off; never answer directly.',
    );

    // Second call should be the billing agent
    const billingMessages = provider.calls[1].messages as Array<{ role: string; content: string }>;
    const billingSystem = billingMessages.find(
      (m) => m.role === 'system' || m.role === 'developer',
    );
    expect(billingSystem?.content).toBe('You handle billing inquiries.');
  });

  it('uses routerModel option when specified', async () => {
    const agentA = agent({
      name: 'agent_a',
      model: 'mock:model-a',
      system: 'Agent A.',
    });

    const agentB = agent({
      name: 'agent_b',
      model: 'mock:model-b',
      system: 'Agent B.',
    });

    const customRouterProvider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'handoff_to_agent_a', arguments: '{}' },
          },
        ],
      },
      'agent a response',
    ]);

    const registry = new ProviderRegistry();
    registry.registerInstance('mock', createSequenceProvider(['fallback']));
    registry.registerInstance('custom', customRouterProvider);

    const { ctx, traces } = createTestCtx({ provider: customRouterProvider, registry });

    await ctx.delegate([agentA, agentB], 'pick one', { routerModel: 'custom:router-model' });

    // The delegate trace should show the custom router model
    const delegateTrace = traces.find((t) => t.type === 'delegate');
    expect(delegateTrace).toBeDefined();
    expect((delegateTrace!.data as Record<string, unknown>).routerModel).toBe(
      'custom:router-model',
    );
  });

  it('defaults routerModel to first candidate model', async () => {
    const first = agent({
      name: 'first',
      model: 'mock:first-model',
      system: 'First agent.',
    });

    const second = agent({
      name: 'second',
      model: 'mock:second-model',
      system: 'Second agent.',
    });

    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'handoff_to_first', arguments: '{}' },
          },
        ],
      },
      'first response',
    ]);

    const { ctx, traces } = createTestCtx({ provider });
    await ctx.delegate([first, second], 'pick');

    // The delegate trace should show the first candidate's model
    const delegateTrace = traces.find((t) => t.type === 'delegate');
    expect(delegateTrace).toBeDefined();
    expect((delegateTrace!.data as Record<string, unknown>).routerModel).toBe('mock:first-model');
  });

  it('passes schema through to final agent', async () => {
    const structured = agent({
      name: 'structured_agent',
      model: 'mock:test',
      system: 'Return JSON.',
    });

    const schema = z.object({ answer: z.number() });

    // Single-agent path to simplify — schema should still be passed through
    const provider = createSequenceProvider(['{"answer": 42}']);
    const { ctx } = createTestCtx({ provider });
    const result = await ctx.delegate([structured], 'what is 6 * 7?', { schema });

    expect(result).toEqual({ answer: 42 });
  });

  it('passes metadata through to agent calls', async () => {
    const metaAgent = agent({
      name: 'meta_agent',
      model: 'mock:test',
      system: (ctx) => `You are serving tier: ${ctx.metadata?.tier ?? 'unknown'}.`,
    });

    const provider = createSequenceProvider(['tier response']);
    const { ctx } = createTestCtx({ provider });
    await ctx.delegate([metaAgent], 'hello', { metadata: { tier: 'premium' } });

    // The agent's system prompt should reflect the metadata
    const messages = provider.calls[0].messages as Array<{ role: string; content: string }>;
    const systemMsg = messages.find((m) => m.role === 'system' || m.role === 'developer');
    expect(systemMsg?.content).toContain('premium');
  });

  it('emits delegate trace event with candidates and routerModel', async () => {
    const agentA = agent({ name: 'trace_a', model: 'mock:test', system: 'A.' });
    const agentB = agent({ name: 'trace_b', model: 'mock:test', system: 'B.' });

    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'handoff_to_trace_a', arguments: '{}' },
          },
        ],
      },
      'a response',
    ]);

    const { ctx, traces } = createTestCtx({ provider });
    await ctx.delegate([agentA, agentB], 'route me');

    const delegateTraces = traces.filter((t) => t.type === 'delegate');
    expect(delegateTraces).toHaveLength(1);

    const data = delegateTraces[0].data as Record<string, unknown>;
    expect(data.candidates).toEqual(['trace_a', 'trace_b']);
    expect(data.routerModel).toBe('mock:test');
  });

  it('handoff descriptions use agent system prompt truncated to 200 chars', async () => {
    const longSystem = 'A'.repeat(300);
    const longAgent = agent({
      name: 'long_system',
      model: 'mock:test',
      system: longSystem,
    });

    const shortAgent = agent({
      name: 'short_system',
      model: 'mock:test',
      system: 'Short.',
    });

    // We need to capture the tool definitions sent to the provider
    let capturedTools: Array<{
      type: string;
      function: { name: string; description: string };
    }> = [];

    const captureProvider: SequenceProvider = {
      name: 'mock',
      calls: [],
      chat: async (messages, options) => {
        captureProvider.calls.push({ messages, options });
        if (captureProvider.calls.length === 1) {
          // First call is the router — capture tools and hand off
          capturedTools = (options?.tools ?? []) as typeof capturedTools;
          return {
            content: '',
            tool_calls: [
              {
                id: 'tc1',
                type: 'function' as const,
                function: { name: 'handoff_to_short_system', arguments: '{}' },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            cost: 0.001,
          };
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

    const { ctx } = createTestCtx({ provider: captureProvider });
    await ctx.delegate([longAgent, shortAgent], 'pick one');

    // Find the handoff tool for the long-system agent
    const longHandoff = capturedTools.find((t) => t.function.name === 'handoff_to_long_system');
    expect(longHandoff).toBeDefined();
    // Description should be truncated to 200 chars
    expect(longHandoff!.function.description).toHaveLength(200);
    expect(longHandoff!.function.description).toBe('A'.repeat(200));

    // Short agent description should be the full system prompt
    const shortHandoff = capturedTools.find((t) => t.function.name === 'handoff_to_short_system');
    expect(shortHandoff).toBeDefined();
    expect(shortHandoff!.function.description).toBe('Short.');
  });

  it('candidates with dynamic system prompts resolve correctly', async () => {
    const dynamicAgent = agent({
      name: 'dynamic_agent',
      model: 'mock:test',
      system: (ctx) => `Specialist for ${ctx.metadata?.domain ?? 'general'} domain.`,
    });

    const staticAgent = agent({
      name: 'static_agent',
      model: 'mock:test',
      system: 'A static system prompt.',
    });

    // Capture the tool definitions to inspect handoff descriptions
    let capturedTools: Array<{
      type: string;
      function: { name: string; description: string };
    }> = [];

    const captureProvider: SequenceProvider = {
      name: 'mock',
      calls: [],
      chat: async (messages, options) => {
        captureProvider.calls.push({ messages, options });
        if (captureProvider.calls.length === 1) {
          capturedTools = (options?.tools ?? []) as typeof capturedTools;
          return {
            content: '',
            tool_calls: [
              {
                id: 'tc1',
                type: 'function' as const,
                function: { name: 'handoff_to_dynamic_agent', arguments: '{}' },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            cost: 0.001,
          };
        }
        return {
          content: 'dynamic result',
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
    const result = await ctx.delegate([dynamicAgent, staticAgent], 'route me', {
      metadata: { domain: 'finance' },
    });

    expect(result).toBe('dynamic result');

    // The dynamic agent's handoff description should reflect the metadata
    const dynamicHandoff = capturedTools.find(
      (t) => t.function.name === 'handoff_to_dynamic_agent',
    );
    expect(dynamicHandoff).toBeDefined();
    expect(dynamicHandoff!.function.description).toBe('Specialist for finance domain.');
  });

  it('router returning text instead of handoff returns that text', async () => {
    const agentA = agent({ name: 'a', model: 'mock:test', system: 'Agent A.' });
    const agentB = agent({ name: 'b', model: 'mock:test', system: 'Agent B.' });

    // Router responds with text on both turns (never hands off)
    const provider = createSequenceProvider([
      'I can help you directly without routing.',
      'Still helping directly.',
    ]);

    const { ctx } = createTestCtx({ provider });
    const result = await ctx.delegate([agentA, agentB], 'help me');

    // The router's text response is returned since it never handed off
    expect(result).toBe('I can help you directly without routing.');
    // Only 1 call made — the router responded with text so the loop exits
    expect(provider.calls).toHaveLength(1);
  });

  it('resolveSystem failure falls back to agent name', async () => {
    const throwingAgent = agent({
      name: 'thrower',
      model: 'mock:test',
      // This will throw when metadata.requiredField is missing
      system: (ctx) => {
        const val = (ctx.metadata as { requiredField: string }).requiredField;
        if (!val) throw new Error('requiredField is required');
        return `Agent for ${val}`;
      },
    });

    const safeAgent = agent({
      name: 'safe',
      model: 'mock:test',
      system: 'A safe agent.',
    });

    // Capture tool definitions to verify fallback description
    let capturedTools: Array<{
      type: string;
      function: { name: string; description: string };
    }> = [];

    const captureProvider: SequenceProvider = {
      name: 'mock',
      calls: [],
      chat: async (messages, options) => {
        captureProvider.calls.push({ messages, options });
        if (captureProvider.calls.length === 1) {
          capturedTools = (options?.tools ?? []) as typeof capturedTools;
          return {
            content: '',
            tool_calls: [
              {
                id: 'tc1',
                type: 'function' as const,
                function: { name: 'handoff_to_safe', arguments: '{}' },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            cost: 0.001,
          };
        }
        return {
          content: 'safe response',
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

    // No metadata.requiredField — thrower's resolveSystem will throw
    const { ctx } = createTestCtx({ provider: captureProvider });
    const result = await ctx.delegate([throwingAgent, safeAgent], 'route');

    expect(result).toBe('safe response');

    // The throwing agent should fall back to "Agent: thrower"
    const throwerHandoff = capturedTools.find((t) => t.function.name === 'handoff_to_thrower');
    expect(throwerHandoff).toBeDefined();
    expect(throwerHandoff!.function.description).toBe('Agent: thrower');

    // The safe agent should use its system prompt
    const safeHandoff = capturedTools.find((t) => t.function.name === 'handoff_to_safe');
    expect(safeHandoff).toBeDefined();
    expect(safeHandoff!.function.description).toBe('A safe agent.');
  });
});
