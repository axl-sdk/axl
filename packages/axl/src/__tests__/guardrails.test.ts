import { describe, it, expect, vi } from 'vitest';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { GuardrailError } from '../errors.js';
import { randomUUID } from 'node:crypto';
import type { AxlEvent } from '../types.js';
import type { Provider, ProviderResponse } from '../providers/types.js';

/** Create a mock provider that returns a fixed response. */
function createMockProvider(responses: string[]): Provider {
  let callIndex = 0;
  return {
    name: 'mock',
    chat: async () => {
      const content = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      const resp: ProviderResponse = {
        content,
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: 0.001,
      };
      return resp;
    },
    stream: async function* () {
      yield {
        type: 'done' as const,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  };
}

function createCtx(overrides: Record<string, unknown> = {}) {
  const registry = new ProviderRegistry();
  registry.registerInstance(
    'mock',
    createMockProvider((overrides.responses as string[]) ?? ['Hello!']),
  );
  const traces: AxlEvent[] = [];
  return {
    ctx: new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: {},
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
      ...overrides,
    }),
    traces,
    registry,
  };
}

describe('guardrails', () => {
  describe('input guardrail', () => {
    it('allows clean input', async () => {
      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          input: async () => ({ block: false }),
        },
      });
      const { ctx, traces } = createCtx();
      const result = await ctx.ask(a, 'Hello');
      expect(result).toBe('Hello!');

      const guardrailTraces = traces.filter((t) => t.type === 'guardrail');
      expect(guardrailTraces).toHaveLength(1);
      expect((guardrailTraces[0].data as any).blocked).toBe(false);
    });

    it('blocks bad input with throw policy', async () => {
      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          input: async (prompt) => {
            if (prompt.includes('evil')) return { block: true, reason: 'Bad content' };
            return { block: false };
          },
          onBlock: 'throw',
        },
      });
      const { ctx } = createCtx();
      await expect(ctx.ask(a, 'evil plan')).rejects.toThrow(GuardrailError);
      await expect(ctx.ask(a, 'evil plan')).rejects.toThrow('Bad content');
    });

    it('blocks bad input with retry policy (degrades to throw for input)', async () => {
      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          input: async () => ({ block: true, reason: 'PII detected' }),
          onBlock: 'retry',
        },
      });
      const { ctx } = createCtx();
      await expect(ctx.ask(a, 'my SSN is 123-45-6789')).rejects.toThrow(GuardrailError);
    });

    it('calls custom fallback handler', async () => {
      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          input: async () => ({ block: true, reason: 'Blocked' }),
          onBlock: (reason) => `Sorry, ${reason}`,
        },
      });
      const { ctx } = createCtx();
      const result = await ctx.ask(a, 'bad input');
      expect(result).toBe('Sorry, Blocked');
    });
  });

  describe('output guardrail', () => {
    it('allows clean output', async () => {
      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          output: async () => ({ block: false }),
        },
      });
      const { ctx } = createCtx();
      const result = await ctx.ask(a, 'Hello');
      expect(result).toBe('Hello!');
    });

    it('blocks bad output with throw policy', async () => {
      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          output: async (response) => {
            if (response.includes('unsafe')) return { block: true, reason: 'Unsafe content' };
            return { block: false };
          },
          onBlock: 'throw',
        },
      });
      const { ctx } = createCtx({ responses: ['This is unsafe content'] });
      await expect(ctx.ask(a, 'Hello')).rejects.toThrow(GuardrailError);
    });

    it('retries on blocked output', async () => {
      let callCount = 0;
      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          output: async (response) => {
            callCount++;
            if (response.includes('bad')) return { block: true, reason: 'Bad word' };
            return { block: false };
          },
          onBlock: 'retry',
          maxRetries: 2,
        },
      });
      // First response is bad, second is clean
      const { ctx } = createCtx({ responses: ['This is bad', 'This is good'] });
      const result = await ctx.ask(a, 'Hello');
      expect(result).toBe('This is good');
      expect(callCount).toBe(2); // Called twice: once for bad, once for good
    });

    it('throws after max retries exhausted', async () => {
      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          output: async () => ({ block: true, reason: 'Always bad' }),
          onBlock: 'retry',
          maxRetries: 1,
        },
      });
      // All responses are bad
      const { ctx } = createCtx({ responses: ['bad1', 'bad2', 'bad3'] });
      await expect(ctx.ask(a, 'Hello')).rejects.toThrow(GuardrailError);
    });

    it('custom fallback handler for output', async () => {
      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          output: async () => ({ block: true, reason: 'Unsafe' }),
          onBlock: async (reason) => `[FILTERED: ${reason}]`,
        },
      });
      const { ctx } = createCtx({ responses: ['bad stuff'] });
      const result = await ctx.ask(a, 'Hello');
      expect(result).toBe('[FILTERED: Unsafe]');
    });
  });

  describe('trace events', () => {
    it('emits guardrail trace events', async () => {
      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          input: async () => ({ block: false }),
          output: async () => ({ block: false }),
        },
      });
      const { ctx, traces } = createCtx();
      await ctx.ask(a, 'Hello');

      const guardrailTraces = traces.filter((t) => t.type === 'guardrail');
      expect(guardrailTraces).toHaveLength(2); // input + output
      expect((guardrailTraces[0].data as any).guardrailType).toBe('input');
      expect((guardrailTraces[1].data as any).guardrailType).toBe('output');
    });
  });

  describe('OTel span events', () => {
    it('emits guardrail span events for input and output', async () => {
      const spanEvents: Array<{ name: string; attributes?: Record<string, any> }> = [];
      const mockSpanManager = {
        withSpanAsync: async <T>(_name: string, _attrs: any, fn: (span: any) => Promise<T>) => {
          return fn({
            setAttribute: () => {},
            addEvent: () => {},
            setStatus: () => {},
            end: () => {},
          });
        },
        addEventToActiveSpan: (name: string, attributes?: Record<string, any>) => {
          spanEvents.push({ name, attributes });
        },
        shutdown: async () => {},
      };

      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          input: async () => ({ block: false }),
          output: async () => ({ block: false }),
        },
      });
      const { ctx } = createCtx({ spanManager: mockSpanManager });
      await ctx.ask(a, 'Hello');

      const guardrailEvents = spanEvents.filter((e) => e.name === 'axl.guardrail.check');
      expect(guardrailEvents).toHaveLength(2);
      expect(guardrailEvents[0].attributes).toEqual({
        'axl.guardrail.type': 'input',
        'axl.guardrail.blocked': false,
        'axl.guardrail.attempt': 1,
        'axl.guardrail.maxAttempts': 1,
      });
      expect(guardrailEvents[1].attributes).toEqual({
        'axl.guardrail.type': 'output',
        'axl.guardrail.blocked': false,
        'axl.guardrail.attempt': 1,
        'axl.guardrail.maxAttempts': 3,
      });
    });

    it('emits span events on each output guardrail retry', async () => {
      const spanEvents: Array<{ name: string; attributes?: Record<string, any> }> = [];
      const mockSpanManager = {
        withSpanAsync: async <T>(_name: string, _attrs: any, fn: (span: any) => Promise<T>) => {
          return fn({
            setAttribute: () => {},
            addEvent: () => {},
            setStatus: () => {},
            end: () => {},
          });
        },
        addEventToActiveSpan: (name: string, attributes?: Record<string, any>) => {
          spanEvents.push({ name, attributes });
        },
        shutdown: async () => {},
      };

      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          input: async () => ({ block: false }),
          output: async (response) => {
            if (response.includes('bad')) return { block: true, reason: 'Bad word' };
            return { block: false };
          },
          onBlock: 'retry',
          maxRetries: 2,
        },
      });
      // First response blocked, second passes
      const { ctx } = createCtx({
        spanManager: mockSpanManager,
        responses: ['This is bad', 'This is good'],
      });
      await ctx.ask(a, 'Hello');

      const guardrailEvents = spanEvents.filter((e) => e.name === 'axl.guardrail.check');
      // 1 input (pass) + 1 output (block) + 1 output (pass) = 3
      expect(guardrailEvents).toHaveLength(3);
      expect(guardrailEvents[0].attributes).toEqual({
        'axl.guardrail.type': 'input',
        'axl.guardrail.blocked': false,
        'axl.guardrail.attempt': 1,
        'axl.guardrail.maxAttempts': 1,
      });
      expect(guardrailEvents[1].attributes).toEqual({
        'axl.guardrail.type': 'output',
        'axl.guardrail.blocked': true,
        'axl.guardrail.reason': 'Bad word',
        'axl.guardrail.attempt': 1,
        'axl.guardrail.maxAttempts': 3,
      });
      expect(guardrailEvents[2].attributes).toEqual({
        'axl.guardrail.type': 'output',
        'axl.guardrail.blocked': false,
        'axl.guardrail.attempt': 2,
        'axl.guardrail.maxAttempts': 3,
      });
    });

    it('includes reason in span event when blocked', async () => {
      const spanEvents: Array<{ name: string; attributes?: Record<string, any> }> = [];
      const mockSpanManager = {
        withSpanAsync: async <T>(_name: string, _attrs: any, fn: (span: any) => Promise<T>) => {
          return fn({
            setAttribute: () => {},
            addEvent: () => {},
            setStatus: () => {},
            end: () => {},
          });
        },
        addEventToActiveSpan: (name: string, attributes?: Record<string, any>) => {
          spanEvents.push({ name, attributes });
        },
        shutdown: async () => {},
      };

      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          input: async () => ({ block: true, reason: 'Bad content' }),
          onBlock: 'throw',
        },
      });
      const { ctx } = createCtx({ spanManager: mockSpanManager });

      await expect(ctx.ask(a, 'evil')).rejects.toThrow(GuardrailError);

      const guardrailEvents = spanEvents.filter((e) => e.name === 'axl.guardrail.check');
      expect(guardrailEvents).toHaveLength(1);
      expect(guardrailEvents[0].attributes).toEqual({
        'axl.guardrail.type': 'input',
        'axl.guardrail.blocked': true,
        'axl.guardrail.attempt': 1,
        'axl.guardrail.maxAttempts': 1,
        'axl.guardrail.reason': 'Bad content',
      });
    });
  });

  describe('combined input + output guardrails', () => {
    it('both guardrails run when input passes', async () => {
      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          input: async () => ({ block: false }),
          output: async () => ({ block: false }),
        },
      });
      const { ctx } = createCtx();
      const result = await ctx.ask(a, 'Hello');
      expect(result).toBe('Hello!');
    });

    it('output guardrail does not run if input is blocked', async () => {
      const outputCalled = vi.fn();
      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        guardrails: {
          input: async () => ({ block: true, reason: 'Bad input' }),
          output: async (_response) => {
            outputCalled();
            return { block: false };
          },
          onBlock: 'throw',
        },
      });
      const { ctx } = createCtx();
      await expect(ctx.ask(a, 'Hello')).rejects.toThrow(GuardrailError);
      expect(outputCalled).not.toHaveBeenCalled();
    });
  });
});
