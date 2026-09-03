import { describe, it, expect, vi } from 'vitest';
import { z, ZodError } from 'zod';
import { agent } from '../agent.js';
import { GuardrailError, ValidationError, VerifyError } from '../errors.js';
import { createSequenceProvider, createTestCtx } from './helpers.js';
import type { AxlEvent, ChatMessage, RetryFeedbackInfo } from '../types.js';

/**
 * `AskOptions.retryFeedback` — one hook across the guardrail, schema, and validate gates.
 *
 * Covers the frozen behavioral matrix cases A1–A14 (A15 is the type-level fixture in
 * `retry-feedback.test-d.ts`) plus the frozen ambiguity decisions: `{ retry: false }` throws
 * with the *configured* maximum in `retries`, `info.error` at the schema stage is the raw
 * thrown error (`ZodError` or `SyntaxError`) with `info.reason` its message, a whitespace-only
 * return is a genuine override, and the hook is reachable only when `onBlock === 'retry'`.
 */
const Xs = z.object({ x: z.number() });
const ValueSchema = z.object({ value: z.number() });

const SCHEMA_DEFAULT_PREFIX = 'Your response was not valid JSON or did not match the required';
const VALIDATE_DEFAULT_PREFIX = 'Your previous response failed validation:';
const GUARDRAIL_DEFAULT_PREFIX = 'Your previous response was blocked by a safety guardrail:';

const jsonAgent = () => agent({ model: 'mock:test', system: 'Return JSON.' });

/** An agent whose output guardrail blocks the literal string `blocked`. */
const guardedAgent = (onBlock: 'retry' | 'throw') =>
  agent({
    model: 'mock:test',
    system: 'Be nice.',
    guardrails: {
      output: (c) => ({ block: c === 'blocked', reason: 'Unsafe' }),
      onBlock,
      maxRetries: 1,
    },
  });

function messagesOf(
  provider: { calls: Array<{ messages: unknown[] }> },
  index: number,
): ChatMessage[] {
  return provider.calls[index].messages as ChatMessage[];
}

/** The text the model actually received on the retry turn. */
function retryTurn(provider: { calls: Array<{ messages: unknown[] }> }, index: number): string {
  const last = messagesOf(provider, index).at(-1)!;
  expect(last.role).toBe('user');
  return last.content;
}

function failedReasons(traces: AxlEvent[]): string[] {
  return traces
    .filter((e) => e.type === 'pipeline' && e.status === 'failed')
    .map((e) => (e as { reason: string }).reason);
}

function gateEvents(traces: AxlEvent[], type: 'guardrail' | 'schema_check' | 'validate') {
  return traces.filter((e) => e.type === type) as Array<{ data: { feedbackMessage?: string } }>;
}

describe('retryFeedback — replacing the feedback text', () => {
  it('A1: the hook string occupies the same role and position as the default feedback', async () => {
    // Differential control run: the only difference between the two conversations must be
    // the text of the feedback turn — not its role, its index, or the surrounding turns.
    const control = createTestCtx({ provider: createSequenceProvider(['not-json', '{"x":1}']) });
    const controlResult = await control.ctx.ask(jsonAgent(), 'go', { schema: Xs, retries: 3 });

    const hooked = createTestCtx({ provider: createSequenceProvider(['not-json', '{"x":1}']) });
    const hookedResult = await hooked.ctx.ask(jsonAgent(), 'go', {
      schema: Xs,
      retries: 3,
      retryFeedback: () => 'ONLY JSON.',
    });

    expect(controlResult).toEqual({ x: 1 });
    expect(hookedResult).toEqual({ x: 1 });
    expect(control.provider.calls).toHaveLength(2);
    expect(hooked.provider.calls).toHaveLength(2);

    const controlMessages = messagesOf(control.provider, 1);
    const hookedMessages = messagesOf(hooked.provider, 1);
    const feedbackIndex = controlMessages.findIndex((m) =>
      m.content.startsWith(SCHEMA_DEFAULT_PREFIX),
    );
    expect(feedbackIndex).toBeGreaterThan(-1);

    // Same conversation length, same slot, same role — only the text differs.
    expect(hookedMessages).toHaveLength(controlMessages.length);
    expect(hookedMessages[feedbackIndex].role).toBe(controlMessages[feedbackIndex].role);
    expect(hookedMessages[feedbackIndex].content).toBe('ONLY JSON.');
    expect(
      hookedMessages.some((m) => m.content.includes('did not match the required schema')),
    ).toBe(false);
    expect(hookedMessages[feedbackIndex - 1]).toMatchObject({
      role: 'assistant',
      content: 'not-json',
    });
  });

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
  ])('A2: returning %s keeps the default feedback', async (_label, value) => {
    const provider = createSequenceProvider(['not-json', '{"x":1}']);
    const { ctx } = createTestCtx({ provider });

    const result = await ctx.ask(jsonAgent(), 'go', {
      schema: Xs,
      retries: 3,
      retryFeedback: () => value,
    });

    expect(result).toEqual({ x: 1 });
    expect(provider.calls).toHaveLength(2);
    expect(retryTurn(provider, 1).startsWith(SCHEMA_DEFAULT_PREFIX)).toBe(true);
  });

  it('a hook that returns nothing at all (logging only) keeps the default feedback', async () => {
    const seen: string[] = [];
    const provider = createSequenceProvider(['not-json', '{"x":1}']);
    const { ctx } = createTestCtx({ provider });

    const result = await ctx.ask(jsonAgent(), 'go', {
      schema: Xs,
      retryFeedback: (info) => {
        seen.push(info.stage);
      },
    });

    expect(result).toEqual({ x: 1 });
    expect(seen).toEqual(['schema']);
    expect(retryTurn(provider, 1).startsWith(SCHEMA_DEFAULT_PREFIX)).toBe(true);
  });

  it('a whitespace-only string is a genuine override, not an empty return', async () => {
    const provider = createSequenceProvider(['not-json', '{"x":1}']);
    const { ctx } = createTestCtx({ provider });

    await ctx.ask(jsonAgent(), 'go', { schema: Xs, retryFeedback: () => '   ' });

    expect(retryTurn(provider, 1)).toBe('   ');
  });

  it('validate: the hook string reaches the model and pipeline(failed), the gate event keeps the default', async () => {
    const provider = createSequenceProvider(['{"value":1}', '{"value":2}']);
    const { ctx, traces } = createTestCtx({ provider });

    const result = await ctx.ask(jsonAgent(), 'go', {
      schema: ValueSchema,
      validate: (o) =>
        o.value === 1 ? { valid: false, reason: 'must not be 1' } : { valid: true },
      retryFeedback: () => 'Use value 2, not 1.',
    });

    expect(result).toEqual({ value: 2 });
    expect(retryTurn(provider, 1)).toBe('Use value 2, not 1.');
    expect(failedReasons(traces)).toEqual(['Use value 2, not 1.']);
    const validateEvents = gateEvents(traces, 'validate');
    expect(validateEvents[0].data.feedbackMessage?.startsWith(VALIDATE_DEFAULT_PREFIX)).toBe(true);
  });

  it('schema: the hook string reaches the model and pipeline(failed), the gate event keeps the default', async () => {
    const provider = createSequenceProvider(['not-json', '{"x":1}']);
    const { ctx, traces } = createTestCtx({ provider });

    await ctx.ask(jsonAgent(), 'go', {
      schema: Xs,
      retryFeedback: () => 'Emit an object with a numeric `x`.',
    });

    expect(retryTurn(provider, 1)).toBe('Emit an object with a numeric `x`.');
    expect(failedReasons(traces)).toEqual(['Emit an object with a numeric `x`.']);
    expect(gateEvents(traces, 'schema_check')[0].data.feedbackMessage).toContain(
      'did not match the required schema',
    );
  });
});

describe('retryFeedback — the info payload', () => {
  it.each([
    ['a Zod rejection', '{"x":"nope"}', ZodError],
    ['a JSON parse failure', 'not-json', SyntaxError],
  ])('A3: schema stage reports %s', async (_label, badResponse, errorType) => {
    const seen: RetryFeedbackInfo[] = [];
    const provider = createSequenceProvider([badResponse, '{"x":1}']);
    const { ctx } = createTestCtx({ provider });

    await ctx.ask(jsonAgent(), 'go', {
      schema: Xs,
      retries: 3,
      retryFeedback: (info) => {
        seen.push(info);
        return undefined;
      },
    });

    expect(seen).toHaveLength(1);
    const info = seen[0];
    expect(info.stage).toBe('schema');
    expect(info.attempt).toBe(1);
    expect(info.maxAttempts).toBe(4);
    // The raw model output, not an extracted or repaired projection of it.
    expect(info.output).toBe(badResponse);
    expect('parsed' in info).toBe(false);
    expect(info.error).toBeInstanceOf(errorType);
    expect(info.reason).toBe((info.error as Error).message);
    expect(info.defaultMessage).toBe(
      `Your response was not valid JSON or did not match the required schema: ${info.reason}. Return a corrected response that matches the required schema.`,
    );
  });

  it('A4: validate stage reports the parsed value and a clean rejection reason', async () => {
    const seen: RetryFeedbackInfo[] = [];
    const provider = createSequenceProvider(['{"value":-1}', '{"value":42}']);
    const { ctx } = createTestCtx({ provider });

    await ctx.ask(jsonAgent(), 'go', {
      schema: ValueSchema,
      validate: (o) =>
        o.value < 0 ? { valid: false, reason: 'Must be positive' } : { valid: true },
      retryFeedback: (info) => {
        seen.push(info);
        return undefined;
      },
    });

    const info = seen[0];
    expect(info.stage).toBe('validate');
    expect(info.parsed).toEqual({ value: -1 });
    expect(info.attempt).toBe(1);
    expect(info.maxAttempts).toBe(3);
    expect(info.error).toBeUndefined();
    expect(info.reason).toContain('Must be positive');
    expect(info.defaultMessage.startsWith(VALIDATE_DEFAULT_PREFIX)).toBe(true);
  });

  it("A4: validate stage carries the validator's thrown error", async () => {
    const seen: RetryFeedbackInfo[] = [];
    const boom = new Error('boom');
    let calls = 0;
    const provider = createSequenceProvider(['{"value":-1}', '{"value":42}']);
    const { ctx } = createTestCtx({ provider });

    await ctx.ask(jsonAgent(), 'go', {
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

    const info = seen[0];
    expect(info.stage).toBe('validate');
    expect(info.parsed).toEqual({ value: -1 });
    expect(info.error).toBe(boom);
    expect(info.reason).toContain('Validator error: boom');
    expect(info.defaultMessage.startsWith(VALIDATE_DEFAULT_PREFIX)).toBe(true);
  });

  it('A5: guardrail stage reports the blocked output and its reason', async () => {
    const seen: RetryFeedbackInfo[] = [];
    const provider = createSequenceProvider(['blocked', 'fine']);
    const { ctx, traces } = createTestCtx({ provider });

    const result = await ctx.ask(guardedAgent('retry'), 'go', {
      retryFeedback: (info) => {
        seen.push(info);
        return 'Be safer.';
      },
    });

    expect(result).toBe('fine');
    expect(retryTurn(provider, 1)).toBe('Be safer.');
    expect(failedReasons(traces)).toEqual(['Be safer.']);
    const info = seen[0];
    expect(info.stage).toBe('guardrail');
    expect(info.output).toBe('blocked');
    expect('parsed' in info).toBe(false);
    expect(info.error).toBeUndefined();
    expect(info.reason).toContain('Unsafe');
    expect(info.defaultMessage.startsWith(GUARDRAIL_DEFAULT_PREFIX)).toBe(true);
    expect(gateEvents(traces, 'guardrail')[0].data.feedbackMessage).toContain('Unsafe');
  });

  it('A12: receives the merged context metadata that `validate` receives', async () => {
    let validateMetadata: Record<string, unknown> | undefined;
    let hookMetadata: Record<string, unknown> | undefined;
    const provider = createSequenceProvider(['{"value":1}', '{"value":2}']);
    const { ctx } = createTestCtx({ provider, metadata: { tenant: 'acme' } });

    await ctx.ask(jsonAgent(), 'go', {
      schema: ValueSchema,
      metadata: { plan: 'pro' },
      validate: (o, vctx) => {
        validateMetadata = vctx.metadata;
        return o.value === 1 ? { valid: false, reason: 'must not be 1' } : { valid: true };
      },
      retryFeedback: (_info, hctx) => {
        hookMetadata = hctx.metadata;
        return undefined;
      },
    });

    // Parity with `OutputValidator` is the contract (R4): the hook is handed exactly what
    // `validate` is handed. Note the shipped `validate` contract passes the *workflow*
    // metadata — per-call `AskOptions.metadata` is merged only for dynamic model/system
    // resolution — so neither sees `plan`. The hook must never be handed `options.metadata`
    // on its own.
    expect(hookMetadata).toEqual(validateMetadata);
    expect(hookMetadata).toEqual({ tenant: 'acme' });
    expect(hookMetadata).not.toHaveProperty('plan');
  });
});

describe('retryFeedback — when it runs', () => {
  it('A6: is not called when the guardrail cannot retry (onBlock: throw)', async () => {
    const hook = vi.fn(() => 'never used');
    const provider = createSequenceProvider(['blocked', 'fine']);
    const { ctx } = createTestCtx({ provider });

    await expect(ctx.ask(guardedAgent('throw'), 'go', { retryFeedback: hook })).rejects.toThrow(
      GuardrailError,
    );

    expect(hook).not.toHaveBeenCalled();
    expect(provider.calls).toHaveLength(1);
  });

  it('A7: is not called on the exhausting attempt', async () => {
    const hook = vi.fn(() => 'again');
    const provider = createSequenceProvider(['not-json']);
    const { ctx } = createTestCtx({ provider });

    await expect(
      ctx.ask(jsonAgent(), 'go', { schema: Xs, retries: 1, retryFeedback: hook }),
    ).rejects.toThrow(VerifyError);

    expect(provider.calls).toHaveLength(2);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toMatchObject({ stage: 'schema', attempt: 1, maxAttempts: 2 });
  });

  it('A10: runs after the gate event and before pipeline(failed)', async () => {
    const log: string[] = [];
    const provider = createSequenceProvider(['not-json', '{"x":1}']);
    const traces: AxlEvent[] = [];
    const { ctx } = createTestCtx({
      provider,
      onTrace: (e: AxlEvent) => {
        traces.push(e);
        log.push(e.type);
      },
    });

    await ctx.ask(jsonAgent(), 'go', {
      schema: Xs,
      retryFeedback: () => {
        log.push('hook');
        return 'CUSTOM';
      },
    });

    const gateIndex = log.indexOf('schema_check');
    const hookIndex = log.indexOf('hook');
    const pipelineFailedIndex = log.indexOf('pipeline', gateIndex);
    expect(gateIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(hookIndex);
    expect(hookIndex).toBeLessThan(pipelineFailedIndex);

    // The gate's own record is the default text; only the sent text changes.
    expect(gateEvents(traces, 'schema_check')[0].data.feedbackMessage).not.toBe('CUSTOM');
    expect(gateEvents(traces, 'schema_check')[0].data.feedbackMessage).toContain(
      'did not match the required schema',
    );
    expect(failedReasons(traces)).toEqual(['CUSTOM']);
  });

  it('A11: an async hook is awaited and sees the advancing attempt counter', async () => {
    const provider = createSequenceProvider(['bad', 'bad', '{"x":1}']);
    const { ctx } = createTestCtx({ provider });
    const seenMaxAttempts: number[] = [];

    const result = await ctx.ask(jsonAgent(), 'go', {
      schema: Xs,
      retries: 3,
      retryFeedback: async (info) => {
        await Promise.resolve();
        seenMaxAttempts.push(info.maxAttempts);
        return `fix#${info.attempt}`;
      },
    });

    expect(result).toEqual({ x: 1 });
    expect(provider.calls).toHaveLength(3);
    expect(retryTurn(provider, 1)).toBe('fix#1');
    expect(retryTurn(provider, 2)).toBe('fix#2');
    expect(seenMaxAttempts).toEqual([4, 4]);
  });
});

describe('retryFeedback — { retry: false } throws the gate error as on exhaustion', () => {
  it('A8(a): schema throws VerifyError carrying the configured maximum', async () => {
    const provider = createSequenceProvider(['not-json', '{"x":1}']);
    const { ctx, traces } = createTestCtx({ provider });

    const err = await ctx
      .ask(jsonAgent(), 'go', {
        schema: Xs,
        retries: 3,
        retryFeedback: () => ({ retry: false as const }),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VerifyError);
    expect((err as VerifyError).lastOutput).toBe('not-json');
    expect((err as VerifyError).zodError).toBeInstanceOf(ZodError);
    // The configured maximum, not the attempt at which the hook stopped.
    expect((err as VerifyError).retries).toBe(3);
    expect(provider.calls).toHaveLength(1);
    expect(gateEvents(traces, 'schema_check')).toHaveLength(1);
    expect(failedReasons(traces)).toEqual([]);
  });

  it('A8(b): validate throws ValidationError carrying the parsed value and the default maximum', async () => {
    const provider = createSequenceProvider(['{"value":-1}', '{"value":42}']);
    const { ctx, traces } = createTestCtx({ provider });

    const err = await ctx
      .ask(jsonAgent(), 'go', {
        schema: ValueSchema,
        validate: (o) =>
          o.value < 0 ? { valid: false, reason: 'Must be positive' } : { valid: true },
        retryFeedback: () => ({ retry: false as const }),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).lastOutput).toEqual({ value: -1 });
    expect((err as ValidationError).reason).toBe('Must be positive');
    expect((err as ValidationError).retries).toBe(2);
    expect(provider.calls).toHaveLength(1);
    expect(gateEvents(traces, 'validate')).toHaveLength(1);
    expect(failedReasons(traces)).toEqual([]);
  });

  it('reports the cancellation, not the gate error, when the ask was aborted mid-hook', async () => {
    const cancelled = new Error('cancelled');
    const controller = new AbortController();
    const provider = createSequenceProvider(['not-json', '{"x":1}']);
    const { ctx } = createTestCtx({ provider, signal: controller.signal });

    const err = await ctx
      .ask(jsonAgent(), 'go', {
        schema: Xs,
        retryFeedback: async () => {
          controller.abort(cancelled);
          return { retry: false as const };
        },
      })
      .catch((e: unknown) => e);

    expect(err).toBe(cancelled);
    expect(err).not.toBeInstanceOf(VerifyError);
  });

  it('A8(c): guardrail throws GuardrailError carrying the guardrail reason, not the feedback text', async () => {
    const provider = createSequenceProvider(['blocked', 'fine']);
    const { ctx, traces } = createTestCtx({ provider });

    const err = await ctx
      .ask(guardedAgent('retry'), 'go', { retryFeedback: () => ({ retry: false as const }) })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GuardrailError);
    expect((err as GuardrailError).guardrailType).toBe('output');
    expect((err as GuardrailError).reason).toBe('Unsafe');
    expect(provider.calls).toHaveLength(1);
    expect(gateEvents(traces, 'guardrail')).toHaveLength(1);
    expect(failedReasons(traces)).toEqual([]);
  });
});

describe('retryFeedback — off-contract returns fail loudly', () => {
  it.each([
    ['a number', 42],
    ['an object without `retry: false`', { message: 'coach the model' }],
    ['{ retry: true }', { retry: true }],
    ['null', null],
  ])('rejects with a TypeError naming %s', async (_label, value) => {
    const provider = createSequenceProvider(['not-json', '{"x":1}']);
    const { ctx } = createTestCtx({ provider });

    const err = await ctx
      .ask(jsonAgent(), 'go', {
        schema: Xs,
        // A JavaScript caller has no compiler to stop this; silently using the default
        // would hide the defect behind extra token spend.
        retryFeedback: () => value as unknown as string,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TypeError);
    expect((err as TypeError).message).toContain('retryFeedback must return');
    expect(provider.calls).toHaveLength(1);
  });

  it('names the received shape without stringifying its values', async () => {
    const provider = createSequenceProvider(['not-json', '{"x":1}']);
    const { ctx } = createTestCtx({ provider });

    const err = await ctx
      .ask(jsonAgent(), 'go', {
        schema: Xs,
        retryFeedback: () => ({ apiKey: 'sk-secret' }) as unknown as string,
      })
      .catch((e: unknown) => e);

    expect((err as TypeError).message).toContain('an object with keys [apiKey]');
    expect((err as TypeError).message).not.toContain('sk-secret');
  });
});

describe('retryFeedback — hook exceptions propagate', () => {
  it('A9: rejects with the exact error instance, unwrapped, with no further provider call', async () => {
    const boom = new Error('hook exploded');
    const provider = createSequenceProvider(['not-json', '{"x":1}']);
    const { ctx, traces } = createTestCtx({ provider });

    const err = await ctx
      .ask(jsonAgent(), 'go', {
        schema: Xs,
        retries: 3,
        retryFeedback: () => {
          throw boom;
        },
      })
      .catch((e: unknown) => e);

    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(VerifyError);
    expect(provider.calls).toHaveLength(1);
    // The gate still recorded its rejection before the hook ran.
    expect(gateEvents(traces, 'schema_check')).toHaveLength(1);
    expect(failedReasons(traces)).toEqual([]);
  });

  it('A9: an async hook rejection propagates from the validate gate', async () => {
    const boom = new Error('async hook exploded');
    const provider = createSequenceProvider(['{"value":1}', '{"value":2}']);
    const { ctx } = createTestCtx({ provider });

    const err = await ctx
      .ask(jsonAgent(), 'go', {
        schema: ValueSchema,
        validate: (o) =>
          o.value === 1 ? { valid: false, reason: 'must not be 1' } : { valid: true },
        retryFeedback: async () => {
          throw boom;
        },
      })
      .catch((e: unknown) => e);

    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(provider.calls).toHaveLength(1);
  });
});

describe('retryFeedback — ctx.delegate forwarding', () => {
  it('A13: reaches the terminal ask on the single-candidate path', async () => {
    const solo = agent({ name: 'solo_agent', model: 'mock:test', system: 'Solo.' });
    const provider = createSequenceProvider(['not-json', '{"x":1}']);
    const { ctx } = createTestCtx({ provider });

    const result = await ctx.delegate([solo], 'go', {
      schema: Xs,
      retries: 3,
      retryFeedback: () => 'delegated feedback',
    });

    expect(result).toEqual({ x: 1 });
    expect(retryTurn(provider, 1)).toBe('delegated feedback');
  });

  it('A14: reaches the terminal ask on the routed multi-candidate path', async () => {
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
      'not-json',
      '{"x":1}',
    ]);
    const { ctx } = createTestCtx({ provider });

    const result = await ctx.delegate([billing, support], 'go', {
      schema: Xs,
      retries: 3,
      retryFeedback: () => 'routed feedback',
    });

    expect(result).toEqual({ x: 1 });
    expect(provider.calls).toHaveLength(3);
    expect(retryTurn(provider, 2)).toBe('routed feedback');
  });
});
