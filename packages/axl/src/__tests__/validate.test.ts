import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { ValidationError, VerifyError } from '../errors.js';
import { randomUUID } from 'node:crypto';
import type { TraceEvent } from '../types.js';
import type { Provider, ProviderResponse } from '../providers/types.js';

/** Create a mock provider that returns fixed responses in sequence. */
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
    createMockProvider((overrides.responses as string[]) ?? ['{"ok":true}']),
  );
  const traces: TraceEvent[] = [];
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

// Shared schemas for tests
const ValueSchema = z.object({ value: z.number() });
const StatusSchema = z.object({ status: z.string() });
const PlanSchema = z.object({
  primaryMetric: z.string(),
  metrics: z.array(z.string()),
});

describe('validate (post-schema business rule validation)', () => {
  describe('basic behavior', () => {
    it('passes when validate returns valid', async () => {
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const good = JSON.stringify({ value: 42 });
      const { ctx } = createCtx({ responses: [good] });
      const result = await ctx.ask(a, 'Hello', {
        schema: ValueSchema,
        validate: (output) => {
          if (output.value > 0) return { valid: true };
          return { valid: false, reason: 'Must be positive' };
        },
      });
      expect(result).toEqual({ value: 42 });
    });

    it('retries when validate returns invalid', async () => {
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const bad = JSON.stringify({ value: -1 });
      const good = JSON.stringify({ value: 42 });
      const { ctx } = createCtx({ responses: [bad, good] });
      const result = await ctx.ask(a, 'Hello', {
        schema: ValueSchema,
        validate: (output) => {
          if (output.value > 0) return { valid: true };
          return { valid: false, reason: 'Must be positive' };
        },
      });
      expect(result).toEqual({ value: 42 });
    });

    it('throws ValidationError after max retries exhausted', async () => {
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const { ctx } = createCtx({
        responses: [
          JSON.stringify({ value: 1 }),
          JSON.stringify({ value: 2 }),
          JSON.stringify({ value: 3 }),
        ],
      });
      const err = await ctx
        .ask(a, 'Hello', {
          schema: ValueSchema,
          validate: () => ({ valid: false, reason: 'Always fails' }),
          validateRetries: 1,
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toContain('Validation failed after 1 retries: Always fails');
      expect(err.lastOutput).toEqual({ value: 2 }); // parsed object, not raw string
      expect(err.retries).toBe(1);
    });
  });

  describe('requires schema', () => {
    it('validate is skipped when no schema is provided', async () => {
      let validateCalled = false;
      const a = agent({ model: 'mock:test', system: 'You are helpful.' });
      const { ctx } = createCtx({ responses: ['Hello!'] });
      const result = await ctx.ask(a, 'Hello', {
        validate: () => {
          validateCalled = true;
          return { valid: false, reason: 'Should not run' };
        },
      });
      expect(result).toBe('Hello!');
      expect(validateCalled).toBe(false);
    });

    it('throws when validate is used with streaming', async () => {
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const { ctx } = createCtx({
        responses: [JSON.stringify({ value: 1 })],
        onToken: () => {},
      });
      const err = await ctx
        .ask(a, 'Hello', {
          schema: ValueSchema,
          validate: () => ({ valid: true }),
        })
        .catch((e) => e);
      expect(err.code).toBe('INVALID_CONFIG');
      expect(err.message).toContain('Cannot use validate with streaming');
    });
  });

  describe('typed validation', () => {
    it('validates parsed object after schema parsing', async () => {
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const good = JSON.stringify({ primaryMetric: 'latency', metrics: ['latency', 'cost'] });
      const { ctx } = createCtx({ responses: [good] });
      const result = await ctx.ask(a, 'Create a plan', {
        schema: PlanSchema,
        validate: (plan) => {
          if (!plan.metrics.includes(plan.primaryMetric)) {
            return { valid: false, reason: 'primaryMetric must be in metrics list' };
          }
          return { valid: true };
        },
      });
      expect(result).toEqual({ primaryMetric: 'latency', metrics: ['latency', 'cost'] });
    });

    it('retries when schema passes but validate fails', async () => {
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const bad = JSON.stringify({ primaryMetric: 'latency', metrics: ['throughput', 'cost'] });
      const good = JSON.stringify({ primaryMetric: 'latency', metrics: ['latency', 'cost'] });
      const { ctx } = createCtx({ responses: [bad, good] });
      const result = await ctx.ask(a, 'Create a plan', {
        schema: PlanSchema,
        validate: (plan) => {
          if (!plan.metrics.includes(plan.primaryMetric)) {
            return { valid: false, reason: 'primaryMetric must be in metrics list' };
          }
          return { valid: true };
        },
      });
      expect(result).toEqual({ primaryMetric: 'latency', metrics: ['latency', 'cost'] });
    });

    it('schema failure retries before validate runs', async () => {
      const validateCalls: unknown[] = [];
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const invalidJson = 'not json at all';
      const validJson = JSON.stringify({ value: 42 });
      const { ctx } = createCtx({ responses: [invalidJson, validJson] });
      const result = await ctx.ask(a, 'Get value', {
        schema: ValueSchema,
        validate: (output) => {
          validateCalls.push(output);
          return { valid: true };
        },
      });
      expect(result).toEqual({ value: 42 });
      // validate should only be called once (after schema passes)
      expect(validateCalls).toHaveLength(1);
      expect(validateCalls[0]).toEqual({ value: 42 });
    });
  });

  describe('retry context accumulation', () => {
    it('LLM sees all previous failed attempts in context', async () => {
      const messagesReceived: Array<Array<{ role: string; content: string }>> = [];
      let callIndex = 0;
      const responses = [
        JSON.stringify({ value: 1 }),
        JSON.stringify({ value: 2 }),
        JSON.stringify({ value: 100 }),
      ];
      const provider: Provider = {
        name: 'mock',
        chat: async (messages) => {
          messagesReceived.push(messages.map((m) => ({ role: m.role, content: m.content })));
          const content = responses[callIndex] ?? responses[responses.length - 1];
          callIndex++;
          return {
            content,
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

      const registry = new ProviderRegistry();
      registry.registerInstance('mock', provider);

      const a = agent({ model: 'mock:test', system: 'Return JSON.' });

      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: registry,
      });

      const result = await ctx.ask(a, 'Hello', {
        schema: ValueSchema,
        validate: (output) => {
          if (output.value >= 50) return { valid: true };
          return { valid: false, reason: `value ${output.value} is too low` };
        },
        validateRetries: 3,
      });
      expect(result).toEqual({ value: 100 });

      // Third call should see both previous failed attempts
      expect(messagesReceived).toHaveLength(3);

      // Second call should see first failure
      const secondCall = messagesReceived[1];
      expect(
        secondCall.some(
          (m) => m.role === 'assistant' && m.content === JSON.stringify({ value: 1 }),
        ),
      ).toBe(true);
      expect(
        secondCall.some((m) => m.role === 'system' && m.content.includes('value 1 is too low')),
      ).toBe(true);

      // Third call should see both failures
      const thirdCall = messagesReceived[2];
      expect(
        thirdCall.some((m) => m.role === 'assistant' && m.content === JSON.stringify({ value: 1 })),
      ).toBe(true);
      expect(
        thirdCall.some((m) => m.role === 'assistant' && m.content === JSON.stringify({ value: 2 })),
      ).toBe(true);
      expect(
        thirdCall.some((m) => m.role === 'system' && m.content.includes('value 2 is too low')),
      ).toBe(true);
    });
  });

  describe('schema retry context accumulation', () => {
    it('LLM sees previous schema failures in context', async () => {
      const messagesReceived: Array<Array<{ role: string; content: string }>> = [];
      let callIndex = 0;
      const responses = ['not json', 'still not json', '{"value": 42}'];
      const provider: Provider = {
        name: 'mock',
        chat: async (messages) => {
          messagesReceived.push(messages.map((m) => ({ role: m.role, content: m.content })));
          const content = responses[callIndex] ?? responses[responses.length - 1];
          callIndex++;
          return {
            content,
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

      const registry = new ProviderRegistry();
      registry.registerInstance('mock', provider);

      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: registry,
      });

      const result = await ctx.ask(a, 'Get value', { schema: ValueSchema });
      expect(result).toEqual({ value: 42 });

      // Third call should see both previous failed attempts
      expect(messagesReceived).toHaveLength(3);

      // Second call should see first failure
      const secondCall = messagesReceived[1];
      expect(secondCall.some((m) => m.role === 'assistant' && m.content === 'not json')).toBe(true);
      expect(
        secondCall.some((m) => m.role === 'system' && m.content.includes('not valid JSON')),
      ).toBe(true);

      // Third call should see both failures
      const thirdCall = messagesReceived[2];
      expect(thirdCall.some((m) => m.role === 'assistant' && m.content === 'not json')).toBe(true);
      expect(thirdCall.some((m) => m.role === 'assistant' && m.content === 'still not json')).toBe(
        true,
      );
    });
  });

  describe('gate interaction', () => {
    it('validate retry goes through guardrail again', async () => {
      const guardrailCalls: string[] = [];
      const validateCalls: unknown[] = [];

      const a = agent({
        model: 'mock:test',
        system: 'Return JSON.',
        guardrails: {
          output: async (response) => {
            guardrailCalls.push(response);
            return { block: false };
          },
        },
      });

      const { ctx } = createCtx({
        responses: [JSON.stringify({ value: 1 }), JSON.stringify({ value: 99 })],
      });
      await ctx.ask(a, 'Hello', {
        schema: ValueSchema,
        validate: (output) => {
          validateCalls.push(output);
          if (output.value > 50) return { valid: true };
          return { valid: false, reason: 'Too low' };
        },
      });

      // Guardrail should be called twice (once per LLM response)
      expect(guardrailCalls).toHaveLength(2);
      // Validate should be called twice
      expect(validateCalls).toEqual([{ value: 1 }, { value: 99 }]);
    });

    it('validate retry goes through schema again', async () => {
      const validateCalls: unknown[] = [];
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });

      const { ctx } = createCtx({
        responses: [JSON.stringify({ value: 5 }), JSON.stringify({ value: 42 })],
      });

      const result = await ctx.ask(a, 'Give me a number', {
        schema: ValueSchema,
        validate: (output) => {
          validateCalls.push(output);
          if (output.value > 10) return { valid: true };
          return { valid: false, reason: 'value must be > 10' };
        },
      });
      expect(result).toEqual({ value: 42 });
      // Both responses passed schema, validate ran on both
      expect(validateCalls).toEqual([{ value: 5 }, { value: 42 }]);
    });

    it('guardrail failure on validate retry uses guardrail retry budget', async () => {
      const a = agent({
        model: 'mock:test',
        system: 'Return JSON.',
        guardrails: {
          output: async (response) => {
            if (response.includes('toxic')) return { block: true, reason: 'Toxic content' };
            return { block: false };
          },
          onBlock: 'retry',
          maxRetries: 1,
        },
      });

      const { ctx } = createCtx({
        responses: [
          JSON.stringify({ value: 1 }), // passes guardrail, fails validate
          'toxic stuff', // fails guardrail (1 guardrail retry used)
          JSON.stringify({ value: 99 }), // passes both
        ],
      });

      const result = await ctx.ask(a, 'Hello', {
        schema: ValueSchema,
        validate: (output) => {
          if (output.value > 50) return { valid: true };
          return { valid: false, reason: 'Too low' };
        },
        validateRetries: 2,
      });
      expect(result).toEqual({ value: 99 });
    });

    it('separate retry counters do not interfere', async () => {
      const a = agent({
        model: 'mock:test',
        system: 'Return JSON.',
        guardrails: {
          output: async (response) => {
            if (response.includes('unsafe')) return { block: true, reason: 'Unsafe' };
            return { block: false };
          },
          onBlock: 'retry',
          maxRetries: 2,
        },
      });

      const { ctx } = createCtx({
        responses: [
          'unsafe content', // guardrail blocks (guardrail retry 1)
          'not json', // guardrail passes, schema fails (schema retry 1)
          JSON.stringify({ status: 'pending' }), // all gates pass except validate (validate retry 1)
          JSON.stringify({ status: 'approved' }), // all gates pass
        ],
      });

      const result = await ctx.ask(a, 'Check', {
        schema: StatusSchema,
        validate: (output) => {
          if (output.status === 'approved') return { valid: true };
          return { valid: false, reason: 'Status must be approved' };
        },
        validateRetries: 2,
      });
      expect(result).toEqual({ status: 'approved' });
    });
  });

  describe('trace events', () => {
    it('emits validate trace events with type "validate"', async () => {
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const { ctx, traces } = createCtx({ responses: [JSON.stringify({ value: 1 })] });
      await ctx.ask(a, 'Hello', {
        schema: ValueSchema,
        validate: () => ({ valid: true }),
      });

      const validateTraces = traces.filter((t) => t.type === 'validate');
      expect(validateTraces).toHaveLength(1);
      expect((validateTraces[0].data as any).valid).toBe(true);
    });

    it('emits trace events on validate retry', async () => {
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const { ctx, traces } = createCtx({
        responses: [JSON.stringify({ value: 1 }), JSON.stringify({ value: 99 })],
      });
      await ctx.ask(a, 'Hello', {
        schema: ValueSchema,
        validate: (output) => {
          if (output.value > 50) return { valid: true };
          return { valid: false, reason: 'Too low' };
        },
      });

      const validateTraces = traces.filter((t) => t.type === 'validate');
      expect(validateTraces).toHaveLength(2);
      expect((validateTraces[0].data as any).valid).toBe(false);
      expect((validateTraces[0].data as any).reason).toBe('Too low');
      expect((validateTraces[1].data as any).valid).toBe(true);
    });
  });

  describe('OTel span events', () => {
    it('emits validate span events', async () => {
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

      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const { ctx } = createCtx({
        spanManager: mockSpanManager,
        responses: [JSON.stringify({ value: 1 }), JSON.stringify({ value: 99 })],
      });
      await ctx.ask(a, 'Hello', {
        schema: ValueSchema,
        validate: (output) => {
          if (output.value > 50) return { valid: true };
          return { valid: false, reason: 'Too low' };
        },
      });

      const validateEvents = spanEvents.filter((e) => e.name === 'axl.validate.check');
      expect(validateEvents).toHaveLength(2);
      expect(validateEvents[0].attributes).toEqual({
        'axl.validate.valid': false,
        'axl.validate.reason': 'Too low',
        'axl.validate.attempt': 1,
        'axl.validate.maxAttempts': 3,
      });
      expect(validateEvents[1].attributes).toEqual({
        'axl.validate.valid': true,
        'axl.validate.attempt': 2,
        'axl.validate.maxAttempts': 3,
      });
    });
  });

  describe('async validator', () => {
    it('supports async validate function', async () => {
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const { ctx } = createCtx({
        responses: [JSON.stringify({ value: 1 }), JSON.stringify({ value: 99 })],
      });
      const result = await ctx.ask(a, 'Hello', {
        schema: ValueSchema,
        validate: async (output) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (output.value > 50) return { valid: true };
          return { valid: false, reason: 'Too low' };
        },
      });
      expect(result).toEqual({ value: 99 });
    });
  });

  describe('default retry count', () => {
    it('defaults to 2 validate retries', async () => {
      let attempts = 0;
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const { ctx } = createCtx({
        responses: [
          JSON.stringify({ value: 1 }),
          JSON.stringify({ value: 2 }),
          JSON.stringify({ value: 3 }),
          JSON.stringify({ value: 4 }),
        ],
      });
      await expect(
        ctx.ask(a, 'Hello', {
          schema: ValueSchema,
          validate: () => {
            attempts++;
            return { valid: false, reason: 'Always fails' };
          },
        }),
      ).rejects.toThrow(ValidationError);
      // 1 initial + 2 retries = 3 total validate calls
      expect(attempts).toBe(3);
    });

    it('respects custom validateRetries', async () => {
      let attempts = 0;
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const { ctx } = createCtx({
        responses: [
          JSON.stringify({ value: 1 }),
          JSON.stringify({ value: 2 }),
          JSON.stringify({ value: 3 }),
          JSON.stringify({ value: 4 }),
          JSON.stringify({ value: 5 }),
          JSON.stringify({ value: 6 }),
        ],
      });
      await expect(
        ctx.ask(a, 'Hello', {
          schema: ValueSchema,
          validate: () => {
            attempts++;
            return { valid: false, reason: 'Always fails' };
          },
          validateRetries: 4,
        }),
      ).rejects.toThrow(ValidationError);
      // 1 initial + 4 retries = 5 total validate calls
      expect(attempts).toBe(5);
    });
  });

  describe('metadata access', () => {
    it('validator receives workflow metadata', async () => {
      let receivedMetadata: Record<string, unknown> | undefined;
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });

      const registry = new ProviderRegistry();
      registry.registerInstance('mock', createMockProvider([JSON.stringify({ value: 1 })]));

      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: registry,
        metadata: { env: 'production', userId: '123' },
      });

      await ctx.ask(a, 'Hello', {
        schema: ValueSchema,
        validate: (_output, vctx) => {
          receivedMetadata = vctx.metadata;
          return { valid: true };
        },
      });
      expect(receivedMetadata).toEqual({ env: 'production', userId: '123' });
    });
  });

  describe('validator exceptions', () => {
    it('treats thrown exceptions as validation failures with retries', async () => {
      let callCount = 0;
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const { ctx } = createCtx({
        responses: [JSON.stringify({ value: 1 }), JSON.stringify({ value: 2 })],
      });
      const result = await ctx.ask(a, 'Hello', {
        schema: ValueSchema,
        validate: () => {
          callCount++;
          if (callCount === 1) throw new Error('Database connection failed');
          return { valid: true };
        },
        validateRetries: 2,
      });
      expect(result).toEqual({ value: 2 });
      expect(callCount).toBe(2);
    });

    it('throws ValidationError after retries exhausted on validator exceptions', async () => {
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const { ctx } = createCtx({
        responses: [
          JSON.stringify({ value: 1 }),
          JSON.stringify({ value: 2 }),
          JSON.stringify({ value: 3 }),
        ],
      });
      const err = await ctx
        .ask(a, 'Hello', {
          schema: ValueSchema,
          validate: () => {
            throw new TypeError('Cannot read property "legs" of undefined');
          },
          validateRetries: 1,
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.reason).toContain('Validator error:');
      expect(err.reason).toContain('Cannot read property');
    });

    it('includes exception message in retry feedback to LLM', async () => {
      const messagesReceived: Array<Array<{ role: string; content: string }>> = [];
      let callIndex = 0;
      const provider: Provider = {
        name: 'mock',
        chat: async (messages) => {
          messagesReceived.push(messages.map((m) => ({ role: m.role, content: m.content })));
          const content = JSON.stringify({ value: callIndex + 1 });
          callIndex++;
          return {
            content,
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

      const registry = new ProviderRegistry();
      registry.registerInstance('mock', provider);

      let callCount = 0;
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });

      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: registry,
      });

      await ctx.ask(a, 'Hello', {
        schema: ValueSchema,
        validate: () => {
          callCount++;
          if (callCount === 1) throw new Error('DB timeout');
          return { valid: true };
        },
        validateRetries: 2,
      });

      // Second LLM call should see the error in context
      const secondCall = messagesReceived[1];
      expect(
        secondCall.some(
          (m) => m.role === 'system' && m.content.includes('Validator error: DB timeout'),
        ),
      ).toBe(true);
    });
  });

  describe('ValidationError.lastOutput', () => {
    it('contains parsed object when schema is used', async () => {
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const { ctx } = createCtx({ responses: [JSON.stringify({ value: 42 })] });
      const err = await ctx
        .ask(a, 'Hello', {
          schema: ValueSchema,
          validate: () => ({ valid: false, reason: 'Always fails' }),
          validateRetries: 0,
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      // lastOutput should be the parsed object, not the raw JSON string
      expect(err.lastOutput).toEqual({ value: 42 });
    });
  });

  describe('schema + validate combined retries', () => {
    it('handles multiple schema failures then validate failure then success', async () => {
      const CountSchema = z.object({ count: z.number() });
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });

      const { ctx } = createCtx({
        responses: [
          'not json', // schema fails (schema retry 1)
          '{"count": "not a number"}', // schema fails (schema retry 2)
          JSON.stringify({ count: 5 }), // schema passes, validate fails (validate retry 1)
          JSON.stringify({ count: 15 }), // schema passes, validate passes
        ],
      });

      const result = await ctx.ask(a, 'Give count', {
        schema: CountSchema,
        validate: (output) => {
          if (output.count >= 10) return { valid: true };
          return { valid: false, reason: 'count must be >= 10' };
        },
        validateRetries: 2,
      });
      expect(result).toEqual({ count: 15 });
    });
  });

  describe('ctx.verify() with validate', () => {
    it('runs validate after schema parse succeeds', async () => {
      let callCount = 0;
      const { ctx } = createCtx();

      const result = await ctx.verify(
        async () => {
          callCount++;
          return { value: callCount * 10 };
        },
        ValueSchema,
        {
          validate: (output) => {
            if (output.value >= 20) return { valid: true };
            return { valid: false, reason: 'value too low' };
          },
        },
      );
      expect(result).toEqual({ value: 20 });
      expect(callCount).toBe(2);
    });

    it('passes retry context to fn on validate failure', async () => {
      const retriesReceived: Array<{ error: string; hasParsed: boolean } | undefined> = [];
      const { ctx } = createCtx();

      await ctx.verify(
        async (retry) => {
          retriesReceived.push(
            retry ? { error: retry.error, hasParsed: !!retry.parsed } : undefined,
          );
          return { value: retriesReceived.length * 100 };
        },
        ValueSchema,
        {
          validate: (output) => {
            if (output.value >= 200) return { valid: true };
            return { valid: false, reason: `${output.value} is insufficient` };
          },
        },
      );

      // First call has no retry context
      expect(retriesReceived[0]).toBeUndefined();
      // Second call gets validate error with parsed object
      expect(retriesReceived[1]?.error).toBe('100 is insufficient');
      expect(retriesReceived[1]?.hasParsed).toBe(true);
    });

    it('provides parsed on validate failure but not on schema failure', async () => {
      let callCount = 0;
      const retriesReceived: Array<{ error: string; hasParsed: boolean } | undefined> = [];
      const { ctx } = createCtx();

      await ctx.verify(
        async (retry) => {
          retriesReceived.push(
            retry ? { error: retry.error, hasParsed: !!retry.parsed } : undefined,
          );
          callCount++;
          if (callCount === 1) return 'not valid json object'; // schema failure
          if (callCount === 2) return { value: -1 }; // schema passes, validate fails
          return { value: 99 }; // passes both
        },
        ValueSchema,
        {
          validate: (output) => {
            if (output.value > 0) return { valid: true };
            return { valid: false, reason: 'Must be positive' };
          },
        },
      );

      expect(retriesReceived[0]).toBeUndefined(); // first call
      expect(retriesReceived[1]?.hasParsed).toBe(false); // schema failure — no parsed
      expect(retriesReceived[2]?.hasParsed).toBe(true); // validate failure — has parsed
      expect(retriesReceived[2]?.error).toBe('Must be positive');
    });

    it('throws ValidationError when validate retries exhausted', async () => {
      const { ctx } = createCtx();

      const err = await ctx
        .verify(async () => ({ value: 1 }), ValueSchema, {
          retries: 1,
          validate: () => ({ valid: false, reason: 'Always fails' }),
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.reason).toBe('Always fails');
      expect(err.lastOutput).toEqual({ value: 1 });
    });

    it('uses fallback when validate retries exhausted and fallback provided', async () => {
      const { ctx } = createCtx();

      const result = await ctx.verify(async () => ({ value: 1 }), ValueSchema, {
        retries: 1,
        validate: () => ({ valid: false, reason: 'Always fails' }),
        fallback: { value: 999 },
      });
      expect(result).toEqual({ value: 999 });
    });

    it('handles validator exceptions with retries', async () => {
      let callCount = 0;
      const { ctx } = createCtx();

      const result = await ctx.verify(
        async () => {
          callCount++;
          return { value: callCount };
        },
        ValueSchema,
        {
          validate: (output) => {
            if (output.value >= 2) return { valid: true };
            throw new Error('Unexpected error');
          },
        },
      );
      expect(result).toEqual({ value: 2 });
    });

    it('schema failure takes precedence over validate', async () => {
      let validateCalled = false;
      const { ctx } = createCtx();

      const err = await ctx
        .verify(async () => 'not an object', ValueSchema, {
          retries: 0,
          validate: () => {
            validateCalled = true;
            return { valid: true };
          },
        })
        .catch((e) => e);
      // Should throw VerifyError (schema), not ValidationError
      expect(err.name).toBe('VerifyError');
      expect(validateCalled).toBe(false);
    });

    it('catches ValidationError from fn and provides parsed for repair', async () => {
      // Simulates: ctx.ask() with validate exhausts retries and throws ValidationError.
      // ctx.verify() catches it and provides retry.parsed so fn can repair the data.
      const { ctx } = createCtx();
      const validator = (output: { value: number }) => {
        if (output.value >= 50) return { valid: true };
        return { valid: false, reason: `value ${output.value} is too low` } as const;
      };

      const result = await ctx.verify(
        async (retry) => {
          if (retry?.parsed) {
            // LLM couldn't get it right — repair programmatically
            return { ...retry.parsed, value: Math.max(retry.parsed.value, 50) };
          }
          // Simulate ctx.ask() throwing ValidationError after exhausting retries
          throw new ValidationError({ value: 10 }, 'value 10 is too low', 2);
        },
        ValueSchema,
        {
          retries: 2,
          validate: validator,
        },
      );
      expect(result).toEqual({ value: 50 });
    });

    it('retries with parsed from fn ValidationError even without verify validate', async () => {
      // verify has no validate of its own — fn throws ValidationError, verify retries
      const { ctx } = createCtx();

      const result = await ctx.verify(
        async (retry) => {
          if (retry?.parsed) {
            // Repair the data
            return { value: (retry.parsed as { value: number }).value + 100 };
          }
          throw new ValidationError({ value: 5 }, 'too low', 1);
        },
        ValueSchema,
        { retries: 1 },
      );
      expect(result).toEqual({ value: 105 });
    });
  });

  describe('ctx.delegate() with validate', () => {
    it('forwards validate on single-agent shortcut', async () => {
      const validateCalls: unknown[] = [];
      const a = agent({ model: 'mock:test', system: 'Return JSON.' });
      const { ctx } = createCtx({
        responses: [JSON.stringify({ value: 5 }), JSON.stringify({ value: 99 })],
      });

      const result = await ctx.delegate([a], 'Hello', {
        schema: ValueSchema,
        validate: (output) => {
          validateCalls.push(output);
          if (output.value > 50) return { valid: true };
          return { valid: false, reason: 'Too low' };
        },
      });
      expect(result).toEqual({ value: 99 });
      expect(validateCalls).toEqual([{ value: 5 }, { value: 99 }]);
    });
  });

  describe('ctx.race() with validate', () => {
    it('discards results that fail validate', async () => {
      const { ctx } = createCtx();

      const result = await ctx.race(
        [
          async () => ({ value: 3 }), // passes schema, fails validate
          async () => {
            // Slight delay so first result is checked first
            await new Promise((r) => setTimeout(r, 5));
            return { value: 99 }; // passes schema and validate
          },
        ],
        {
          schema: ValueSchema,
          validate: (output) => {
            if (output.value > 50) return { valid: true };
            return { valid: false, reason: 'Too low' };
          },
        },
      );
      expect(result).toEqual({ value: 99 });
    });

    it('rejects when all results fail validate', async () => {
      const { ctx } = createCtx();

      await expect(
        ctx.race([async () => ({ value: 1 }), async () => ({ value: 2 })], {
          schema: ValueSchema,
          validate: () => ({ valid: false, reason: 'All bad' }),
        }),
      ).rejects.toThrow('Validation failed');
    });

    it('validate is skipped when no schema is provided', async () => {
      let validateCalled = false;
      const { ctx } = createCtx();

      const result = await ctx.race([async () => 'hello'], {
        validate: () => {
          validateCalled = true;
          return { valid: false, reason: 'Should not run' };
        },
      });
      expect(result).toBe('hello');
      expect(validateCalled).toBe(false);
    });
  });

  describe('verify + fn ValidationError + verify validate', () => {
    it('fn throws ValidationError, repair passes verify validate', async () => {
      const { ctx } = createCtx();

      const result = await ctx.verify(
        async (retry) => {
          if (retry?.parsed) {
            // Repair: bump value to pass verify's validate
            return { value: retry.parsed.value + 100 };
          }
          // Simulate ctx.ask() exhausting retries
          throw new ValidationError({ value: 5 }, 'value too low', 2);
        },
        ValueSchema,
        {
          retries: 2,
          validate: (output) => {
            // verify's own validate — stricter threshold
            if (output.value >= 100) return { valid: true };
            return { valid: false, reason: `${output.value} still too low for verify` };
          },
        },
      );
      expect(result).toEqual({ value: 105 });
    });

    it('fn throws ValidationError, repair fails verify validate, retries again', async () => {
      let fnCalls = 0;
      const { ctx } = createCtx();

      const result = await ctx.verify(
        async (retry) => {
          fnCalls++;
          if (retry?.parsed) {
            // First repair: value 15 (fails verify's validate >= 50)
            // Second repair: value 65 (passes)
            return { value: retry.parsed.value + 50 };
          }
          // Simulate ctx.ask() failure
          throw new ValidationError({ value: 15 }, 'too low', 1);
        },
        ValueSchema,
        {
          retries: 3,
          validate: (output) => {
            if (output.value >= 50) return { valid: true };
            return { valid: false, reason: `${output.value} below threshold` };
          },
        },
      );
      // Call 1: fn throws ValidationError (parsed: {value: 15})
      // Call 2: fn repairs to {value: 65}, schema passes, verify validate passes
      expect(result).toEqual({ value: 65 });
      expect(fnCalls).toBe(2);
    });
  });

  describe('verify retry fields when fn() throws errors with structured output', () => {
    it('populates retry.parsed and retry.output from ValidationError.lastOutput', async () => {
      const retries: Array<{ error: string; output: unknown; parsed: unknown } | undefined> = [];
      const { ctx } = createCtx();

      await ctx.verify(
        async (retry) => {
          retries.push(
            retry ? { error: retry.error, output: retry.output, parsed: retry.parsed } : undefined,
          );
          if (retry?.parsed) return retry.parsed; // return as-is to pass
          // Simulate ctx.ask() exhausting validate retries — fn never returns, it throws
          throw new ValidationError({ value: 42 }, 'business rule failed', 2);
        },
        ValueSchema,
        { retries: 1 },
      );

      // First call: no retry context
      expect(retries[0]).toBeUndefined();
      // Second call: verify extracted lastOutput from the caught ValidationError
      expect(retries[1]).toBeDefined();
      expect(retries[1]!.error).toBe('business rule failed');
      expect(retries[1]!.parsed).toEqual({ value: 42 }); // from err.lastOutput
      expect(retries[1]!.output).toEqual({ value: 42 }); // falls back to err.lastOutput
    });

    it('populates retry.output from VerifyError.lastOutput (e.g., ctx.ask schema failure)', async () => {
      const retries: Array<{ error: string; output: unknown; hasParsed: boolean } | undefined> = [];
      const { ctx } = createCtx();

      const result = await ctx.verify(
        async (retry) => {
          retries.push(
            retry
              ? { error: retry.error, output: retry.output, hasParsed: retry.parsed !== undefined }
              : undefined,
          );
          if (retry?.output) {
            // Repair the raw output from the inner verify's failure
            return { value: (retry.output as { value: string }).value === 'not-a-number' ? 99 : 0 };
          }
          // Simulate a nested ctx.verify() that failed schema validation
          throw new VerifyError(
            { value: 'not-a-number' },
            new (await import('zod')).ZodError([
              { code: 'custom', path: ['value'], message: 'Expected number' },
            ]),
            2,
          );
        },
        ValueSchema,
        { retries: 1 },
      );

      expect(retries[0]).toBeUndefined();
      expect(retries[1]).toBeDefined();
      expect(retries[1]!.output).toEqual({ value: 'not-a-number' }); // from err.lastOutput
      expect(retries[1]!.hasParsed).toBe(false); // schema failed — no parsed
      expect(result).toEqual({ value: 99 });
    });

    it('VerifyError from fn is re-thrown after retries exhausted', async () => {
      const { ctx } = createCtx();

      const err = await ctx
        .verify(
          async () => {
            throw new VerifyError(
              { raw: 'data' },
              new (await import('zod')).ZodError([
                { code: 'custom', path: [], message: 'Schema failed' },
              ]),
              1,
            );
          },
          ValueSchema,
          { retries: 0 },
        )
        .catch((e) => e);

      expect(err).toBeInstanceOf(VerifyError);
      expect(err.lastOutput).toEqual({ raw: 'data' });
    });

    it('VerifyError from fn uses fallback when provided', async () => {
      const { ctx } = createCtx();

      const result = await ctx.verify(
        async () => {
          throw new VerifyError(
            'bad',
            new (await import('zod')).ZodError([
              { code: 'custom', path: [], message: 'Schema failed' },
            ]),
            1,
          );
        },
        ValueSchema,
        { retries: 0, fallback: { value: -1 } },
      );

      expect(result).toEqual({ value: -1 });
    });
  });
});
