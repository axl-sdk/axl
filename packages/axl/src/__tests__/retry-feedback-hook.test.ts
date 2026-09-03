import { describe, it, expect } from 'vitest';
import { z, ZodError } from 'zod';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { randomUUID } from 'node:crypto';
import { GuardrailError, ValidationError, VerifyError } from '../errors.js';
import { createSequenceProvider, createTestCtx } from './helpers.js';
import type { AxlEvent, ChatMessage, RetryFeedbackInfo } from '../types.js';
import type { Provider, ProviderResponse } from '../providers/types.js';

/**
 * `AskOptions.retryFeedback` — one hook across the guardrail, schema, and validate gates.
 * Covers AC4 (feedback replacement, abort, throw, event ordering) and AC5 (delegate
 * forwarding on both the single-candidate and the routed path).
 */
function createRecordingProvider(responses: string[]): Provider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    name: 'recording',
    calls,
    chat: async (messages) => {
      calls.push(messages.map((m) => ({ ...m })));
      const content = responses[calls.length - 1] ?? responses[responses.length - 1];
      const resp: ProviderResponse = {
        content,
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: 0.001,
      };
      return resp;
    },
    stream: async function* () {
      yield { type: 'text_delta' as const, content: '' };
      throw new Error('streaming is not exercised by this suite');
    },
  };
}

function createCtx(responses: string[], metadata?: Record<string, unknown>) {
  const registry = new ProviderRegistry();
  const provider = createRecordingProvider(responses);
  registry.registerInstance('mock', provider);
  const traces: AxlEvent[] = [];
  const ctx = new WorkflowContext({
    input: 'test',
    executionId: randomUUID(),
    config: {},
    providerRegistry: registry,
    onTrace: (e) => traces.push(e),
    ...(metadata ? { metadata } : {}),
  });
  return { ctx, provider, traces };
}

const ValueSchema = z.object({ value: z.number() });

/** The text the model actually received on the retry turn. */
function retryTurn(messages: ChatMessage[]): string {
  const last = messages.at(-1)!;
  expect(last.role).toBe('user');
  return last.content;
}

function failedReasons(traces: AxlEvent[]): string[] {
  return traces
    .filter((e) => e.type === 'pipeline' && e.status === 'failed')
    .map((e) => (e as { reason: string }).reason);
}

function gateEvent(traces: AxlEvent[], type: 'guardrail' | 'schema_check' | 'validate') {
  return traces.filter((e) => e.type === type) as Array<{
    data: { feedbackMessage?: string };
  }>;
}

const guardedAgent = () =>
  agent({
    model: 'mock:test',
    system: 'Be nice.',
    guardrails: {
      output: (c) => ({ block: c === 'bad', reason: 'not nice' }),
      onBlock: 'retry',
      maxRetries: 1,
    },
  });

const rejectOne = (o: { value: number }) =>
  o.value === 1 ? { valid: false as const, reason: 'must not be 1' } : { valid: true as const };

describe('retryFeedback hook — feedback replacement', () => {
  it('validate: a returned string replaces the default on the retry turn and pipeline(failed)', async () => {
    const { ctx, provider, traces } = createCtx(['{"value": 1}', '{"value": 2}']);
    const result = await ctx.ask(agent({ model: 'mock:test', system: 'Return JSON.' }), 'go', {
      schema: ValueSchema,
      validate: rejectOne,
      retryFeedback: () => 'Use value 2, not 1.',
    });

    expect(result).toEqual({ value: 2 });
    expect(retryTurn(provider.calls[1])).toBe('Use value 2, not 1.');
    expect(failedReasons(traces)).toEqual(['Use value 2, not 1.']);
    // The legacy gate event still carries the default text (R5): a hook can rewrite what
    // the model sees, never the record of what the gate itself decided.
    const validateEvents = gateEvent(traces, 'validate');
    expect(validateEvents[0].data.feedbackMessage).toContain('must not be 1');
    expect(validateEvents[0].data.feedbackMessage).not.toBe('Use value 2, not 1.');
  });

  it('schema: a returned string replaces the default on the retry turn and pipeline(failed)', async () => {
    const { ctx, provider, traces } = createCtx(['not json', '{"value": 2}']);
    await ctx.ask(agent({ model: 'mock:test', system: 'Return JSON.' }), 'go', {
      schema: ValueSchema,
      retryFeedback: () => 'Emit an object with a numeric `value`.',
    });

    expect(retryTurn(provider.calls[1])).toBe('Emit an object with a numeric `value`.');
    expect(failedReasons(traces)).toEqual(['Emit an object with a numeric `value`.']);
    expect(gateEvent(traces, 'schema_check')[0].data.feedbackMessage).toContain(
      'did not match the required schema',
    );
  });

  it('guardrail: a returned string replaces the default on the retry turn and pipeline(failed)', async () => {
    const { ctx, provider, traces } = createCtx(['bad', 'good']);
    const result = await ctx.ask(guardedAgent(), 'go', {
      retryFeedback: () => 'Try again, politely.',
    });

    expect(result).toBe('good');
    expect(retryTurn(provider.calls[1])).toBe('Try again, politely.');
    expect(failedReasons(traces)).toEqual(['Try again, politely.']);
    expect(gateEvent(traces, 'guardrail')[0].data.feedbackMessage).toContain('not nice');
  });

  it('returning undefined keeps the default feedback', async () => {
    const { ctx, provider, traces } = createCtx(['{"value": 1}', '{"value": 2}']);
    await ctx.ask(agent({ model: 'mock:test', system: 'Return JSON.' }), 'go', {
      schema: ValueSchema,
      validate: rejectOne,
      retryFeedback: () => undefined,
    });

    const sent = retryTurn(provider.calls[1]);
    expect(sent).toContain('must not be 1');
    expect(failedReasons(traces)).toEqual([sent]);
  });

  it('returning an empty string keeps the default feedback', async () => {
    const { ctx, provider } = createCtx(['{"value": 1}', '{"value": 2}']);
    await ctx.ask(agent({ model: 'mock:test', system: 'Return JSON.' }), 'go', {
      schema: ValueSchema,
      validate: rejectOne,
      retryFeedback: () => '',
    });

    expect(retryTurn(provider.calls[1])).toContain('must not be 1');
  });

  it('awaits an async hook', async () => {
    const { ctx, provider } = createCtx(['{"value": 1}', '{"value": 2}']);
    await ctx.ask(agent({ model: 'mock:test', system: 'Return JSON.' }), 'go', {
      schema: ValueSchema,
      validate: rejectOne,
      retryFeedback: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return 'async feedback';
      },
    });

    expect(retryTurn(provider.calls[1])).toBe('async feedback');
  });
});

describe('retryFeedback hook — info payload', () => {
  it('receives ctx.metadata and the stage-specific info for validate', async () => {
    const seen: RetryFeedbackInfo[] = [];
    const metadataSeen: Array<Record<string, unknown>> = [];
    const { ctx } = createCtx(['{"value": 1}', '{"value": 2}'], { tenant: 'acme' });
    await ctx.ask(agent({ model: 'mock:test', system: 'Return JSON.' }), 'go', {
      schema: ValueSchema,
      validate: rejectOne,
      validateRetries: 2,
      retryFeedback: (info, hookCtx) => {
        seen.push(info);
        metadataSeen.push(hookCtx.metadata);
        return undefined;
      },
    });

    expect(metadataSeen[0]).toEqual({ tenant: 'acme' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      stage: 'validate',
      attempt: 1,
      maxAttempts: 3,
      output: '{"value": 1}',
      parsed: { value: 1 },
      reason: 'must not be 1',
    });
    expect(seen[0].defaultMessage).toContain('must not be 1');
    // `error` is absent for a clean validate rejection.
    expect('error' in seen[0]).toBe(false);
  });

  it('carries the ZodError for schema and no parsed value', async () => {
    const seen: RetryFeedbackInfo[] = [];
    const { ctx } = createCtx(['{"value": "x"}', '{"value": 2}']);
    await ctx.ask(agent({ model: 'mock:test', system: 'Return JSON.' }), 'go', {
      schema: ValueSchema,
      retryFeedback: (info) => {
        seen.push(info);
        return undefined;
      },
    });

    expect(seen[0].stage).toBe('schema');
    expect(seen[0].error).toBeInstanceOf(ZodError);
    expect('parsed' in seen[0]).toBe(false);
  });

  it("carries the validator's thrown error for validate", async () => {
    const seen: RetryFeedbackInfo[] = [];
    const boom = new Error('validator exploded');
    let calls = 0;
    const { ctx } = createCtx(['{"value": 1}', '{"value": 2}']);
    await ctx.ask(agent({ model: 'mock:test', system: 'Return JSON.' }), 'go', {
      schema: ValueSchema,
      validate: () => {
        calls++;
        if (calls === 1) throw boom;
        return { valid: true };
      },
      retryFeedback: (info) => {
        seen.push(info);
        return undefined;
      },
    });

    expect(seen[0].error).toBe(boom);
    expect(seen[0].reason).toContain('validator exploded');
  });

  it('is not invoked on the exhausting attempt', async () => {
    const stages: string[] = [];
    const { ctx, provider } = createCtx(['{"value": 1}', '{"value": 1}', '{"value": 1}']);
    await expect(
      ctx.ask(agent({ model: 'mock:test', system: 'Return JSON.' }), 'go', {
        schema: ValueSchema,
        validate: rejectOne,
        validateRetries: 2,
        retryFeedback: (info) => {
          stages.push(`${info.stage}:${info.attempt}`);
          return undefined;
        },
      }),
    ).rejects.toThrow(ValidationError);

    // Three attempts, two of which were retried — the third had no retry left.
    expect(provider.calls).toHaveLength(3);
    expect(stages).toEqual(['validate:1', 'validate:2']);
  });
});

describe('retryFeedback hook — { retry: false }', () => {
  it('validate: throws ValidationError with the parsed value and stops calling the provider', async () => {
    const { ctx, provider, traces } = createCtx(['{"value": 1}', '{"value": 2}']);
    const err = await ctx
      .ask(agent({ model: 'mock:test', system: 'Return JSON.' }), 'go', {
        schema: ValueSchema,
        validate: rejectOne,
        validateRetries: 2,
        retryFeedback: () => ({ retry: false as const }),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).lastOutput).toEqual({ value: 1 });
    expect((err as ValidationError).reason).toBe('must not be 1');
    expect((err as ValidationError).retries).toBe(2);
    expect(provider.calls).toHaveLength(1);
    // The gate rejected and said so; only the retry was abandoned.
    expect(gateEvent(traces, 'validate')).toHaveLength(1);
    expect(failedReasons(traces)).toEqual([]);
  });

  it('schema: throws VerifyError with the raw content and stops calling the provider', async () => {
    const { ctx, provider, traces } = createCtx(['not json', '{"value": 2}']);
    const err = await ctx
      .ask(agent({ model: 'mock:test', system: 'Return JSON.' }), 'go', {
        schema: ValueSchema,
        retries: 3,
        retryFeedback: () => ({ retry: false as const }),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VerifyError);
    expect((err as VerifyError).lastOutput).toBe('not json');
    expect((err as VerifyError).zodError).toBeInstanceOf(ZodError);
    expect((err as VerifyError).retries).toBe(3);
    expect(provider.calls).toHaveLength(1);
    expect(gateEvent(traces, 'schema_check')).toHaveLength(1);
    expect(failedReasons(traces)).toEqual([]);
  });

  it('guardrail: throws GuardrailError and stops calling the provider', async () => {
    const { ctx, provider, traces } = createCtx(['bad', 'good']);
    const err = await ctx
      .ask(guardedAgent(), 'go', { retryFeedback: () => ({ retry: false as const }) })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GuardrailError);
    expect((err as GuardrailError).message).toContain('not nice');
    expect(provider.calls).toHaveLength(1);
    expect(gateEvent(traces, 'guardrail')).toHaveLength(1);
    expect(failedReasons(traces)).toEqual([]);
  });
});

describe('retryFeedback hook — exceptions propagate', () => {
  it('rejects the ask with the hook error, makes no further provider call, and keeps the gate event', async () => {
    const boom = new Error('hook is broken');
    const { ctx, provider, traces } = createCtx(['{"value": 1}', '{"value": 2}']);
    await expect(
      ctx.ask(agent({ model: 'mock:test', system: 'Return JSON.' }), 'go', {
        schema: ValueSchema,
        validate: rejectOne,
        retryFeedback: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);

    expect(provider.calls).toHaveLength(1);
    expect(gateEvent(traces, 'validate')).toHaveLength(1);
    expect(failedReasons(traces)).toEqual([]);
  });

  it('propagates an async hook rejection from the schema gate', async () => {
    const boom = new Error('async hook is broken');
    const { ctx, provider } = createCtx(['not json', '{"value": 2}']);
    await expect(
      ctx.ask(agent({ model: 'mock:test', system: 'Return JSON.' }), 'go', {
        schema: ValueSchema,
        retryFeedback: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);

    expect(provider.calls).toHaveLength(1);
  });
});

describe('retryFeedback hook — delegate forwarding (AC5)', () => {
  it('reaches the terminal ask on the single-candidate path', async () => {
    const solo = agent({ name: 'solo_agent', model: 'mock:test', system: 'Solo.' });
    const provider = createSequenceProvider(['not json', '{"value": 2}']);
    const { ctx } = createTestCtx({ provider });

    await ctx.delegate([solo], 'go', {
      schema: ValueSchema,
      retryFeedback: () => 'delegated feedback',
    });

    const retry = provider.calls[1].messages as ChatMessage[];
    expect(retry.at(-1)).toMatchObject({ role: 'user', content: 'delegated feedback' });
  });

  it('reaches the terminal ask on the routed multi-candidate path', async () => {
    const billing = agent({ name: 'billing', model: 'mock:test', system: 'Billing.' });
    const support = agent({ name: 'support', model: 'mock:test', system: 'Support.' });
    const provider = createSequenceProvider([
      // Call 1: the router hands off to `billing`.
      {
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'handoff_to_billing', arguments: '{}' },
          },
        ],
      },
      // Call 2: billing's first attempt fails the schema gate; call 3 succeeds.
      'not json',
      '{"value": 2}',
    ]);
    const { ctx } = createTestCtx({ provider });

    const result = await ctx.delegate([billing, support], 'go', {
      schema: ValueSchema,
      retryFeedback: () => 'routed feedback',
    });

    expect(result).toEqual({ value: 2 });
    expect(provider.calls).toHaveLength(3);
    const retry = provider.calls[2].messages as ChatMessage[];
    expect(retry.at(-1)).toMatchObject({ role: 'user', content: 'routed feedback' });
  });
});
