/**
 * Recovery boundaries must not absorb stops.
 *
 * `ctx.verify` (retries + `fallback`), `validate` catches, `ctx.spawn` /
 * `ctx.map` result folding and `ctx.race` loser handling all turn application
 * failures into something recoverable. An `AdmissionDeniedError` (a spend stop)
 * and the cancellation of the scope the boundary runs in are not application
 * failures: they must surface unwrapped, unretried, and never be replaced by a
 * `fallback`.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { WorkflowContext } from '../context.js';
import type { WorkflowContextInit } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';
import { workflow } from '../workflow.js';
import { AdmissionController } from '../accounting.js';
import {
  AdmissionDeniedError,
  QuorumNotMet,
  ValidationError,
  VerifyError,
  isAdmissionDeniedError,
} from '../errors.js';
import type { AxlEvent } from '../types.js';
import { scriptedRuntime } from './accounting-helpers.js';

class TestProvider {
  readonly name = 'test';
  calls = 0;

  constructor(private readonly contents: string[]) {}

  async chat(_messages: unknown[], options: { signal?: AbortSignal }) {
    options.signal?.throwIfAborted();
    const content = this.contents[Math.min(this.calls, this.contents.length - 1)];
    this.calls++;
    return {
      content,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      cost: 0.001,
    };
  }

  async *stream(messages: unknown[], options: { signal?: AbortSignal }) {
    const resp = await this.chat(messages, options);
    yield { type: 'text_delta' as const, content: resp.content };
    yield { type: 'done' as const, usage: resp.usage };
  }
}

function createContext(provider: TestProvider, init?: Partial<WorkflowContextInit>) {
  const registry = new ProviderRegistry();
  registry.registerInstance('test', provider as never);
  const events: AxlEvent[] = [];
  const ctx = new WorkflowContext({
    input: 'input',
    executionId: 'exec-recovery-boundaries',
    metadata: {},
    config: { defaultProvider: 'test' },
    providerRegistry: registry,
    onTrace: (event: AxlEvent) => events.push(event),
    ...init,
  });
  return { ctx, events };
}

const testAgent = agent({ model: 'test:m', system: 'fixture' });

function denial(): AdmissionDeniedError {
  return new AdmissionDeniedError({ limit: 1, knownSpend: 1, operation: { kind: 'chat' } });
}

/** A branch that only settles when its signal aborts, recording that it did. */
function abortable(signal: AbortSignal | undefined, onAbort: () => void): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      onAbort();
      reject(signal.reason);
    });
  });
}

/** The signal a branch runs under, as the branch itself sees it. */
function branchSignal(ctx: WorkflowContext): AbortSignal | undefined {
  // `currentSignal` is private; a branch observes it through the signal handed
  // to the provider, but a direct read keeps these fixtures provider-free.
  return (ctx as unknown as { currentSignal: AbortSignal | undefined }).currentSignal;
}

const numberSchema = z.object({ n: z.number() });

// ═══════════════════════════════════════════════════════════════════════════
// AdmissionDeniedError
// ═══════════════════════════════════════════════════════════════════════════

describe('AdmissionDeniedError passes every ctx recovery boundary unwrapped', () => {
  it('ctx.verify: a denial from fn is not retried, wrapped, or replaced by fallback', async () => {
    const { ctx, events } = createContext(new TestProvider(['x']));
    const denied = denial();
    const fn = vi.fn(async () => {
      throw denied;
    });

    const outcome = ctx.verify(fn, numberSchema, { retries: 3, fallback: { n: -1 } });

    await expect(outcome).rejects.toBe(denied);
    expect(fn).toHaveBeenCalledTimes(1);
    // An interrupted verify reaches no pass/fail verdict, so it emits none.
    expect(events.filter((e) => e.type === 'verify')).toHaveLength(0);
  });

  it('ctx.verify: a denial from fn without a fallback is not wrapped in VerifyError', async () => {
    const { ctx } = createContext(new TestProvider(['x']));
    const denied = denial();
    const fn = vi.fn(async () => {
      throw denied;
    });

    await expect(ctx.verify(fn, numberSchema, { retries: 0 })).rejects.toBe(denied);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ctx.verify: a denial from validate is not a validation failure', async () => {
    const { ctx } = createContext(new TestProvider(['x']));
    const denied = denial();
    const fn = vi.fn(async () => ({ n: 1 }));
    const validate = vi.fn(async () => {
      throw denied;
    });

    const outcome = ctx.verify(fn, numberSchema, {
      retries: 2,
      validate,
      fallback: { n: -1 },
    });

    await expect(outcome).rejects.toBe(denied);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('ctx.verify: a real admission stop inside a retried ask surfaces, not the fallback', async () => {
    // First ask spends the whole limit and returns unparseable output; the
    // retry's ask is then refused at admission.
    const admission = new AdmissionController({ limit: 1 });
    const { runtime, provider } = scriptedRuntime([{ content: 'not json', cost: 1 }]);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    let caught: unknown;
    runtime.register(
      workflow({
        name: 'verify-ask',
        input: z.any(),
        handler: async (ctx) => {
          try {
            return await ctx.verify(() => ctx.ask(asker, 'go'), numberSchema, {
              retries: 3,
              fallback: { n: -1 },
            });
          } catch (error) {
            caught = error;
            throw error;
          }
        },
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('verify-ask', {}), {
      admission,
    });

    expect(provider.calls).toHaveLength(1);
    expect(isAdmissionDeniedError(caught)).toBe(true);
    expect(outcome.status).toBe('rejected');
  });

  it('ctx.ask: a denial from validate is not fed back to the model as a validation failure', async () => {
    const provider = new TestProvider(['{"n":1}']);
    const { ctx } = createContext(provider);
    const denied = denial();
    const validate = vi.fn(async () => {
      throw denied;
    });

    const outcome = ctx.ask(testAgent, 'go', {
      schema: numberSchema,
      validate,
      validateRetries: 2,
    });

    await expect(outcome).rejects.toBe(denied);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(provider.calls).toBe(1);
  });

  it('ctx.spawn (default): rejects with the denial instead of an { ok: false } result', async () => {
    const { ctx } = createContext(new TestProvider(['x']));
    const denied = denial();
    const fn = vi.fn(async (i: number) => {
      if (i === 0) throw denied;
      return i;
    });

    await expect(ctx.spawn(3, fn)).rejects.toBe(denied);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('ctx.spawn (quorum): rejects with the denial, not QuorumNotMet, and aborts siblings', async () => {
    const { ctx } = createContext(new TestProvider(['x']));
    const denied = denial();
    const siblingsAborted: number[] = [];

    const outcome = ctx.spawn(
      3,
      async (i) => {
        if (i === 0) {
          await Promise.resolve();
          throw denied;
        }
        return abortable(branchSignal(ctx), () => siblingsAborted.push(i));
      },
      { quorum: 2 },
    );

    await expect(outcome).rejects.toBe(denied);
    expect(siblingsAborted.sort()).toEqual([1, 2]);
  });

  it('ctx.map (default): rejects with the denial instead of an { ok: false } result', async () => {
    const { ctx } = createContext(new TestProvider(['x']));
    const denied = denial();
    const fn = vi.fn(async (item: number) => {
      if (item === 0) throw denied;
      return item;
    });

    await expect(ctx.map([0, 1, 2], fn, { concurrency: 1 })).rejects.toBe(denied);
    // Sequential: the denial on the first item stops the map from starting more.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ctx.map (quorum): rejects with the denial, not QuorumNotMet, and aborts siblings', async () => {
    const { ctx } = createContext(new TestProvider(['x']));
    const denied = denial();
    const siblingsAborted: number[] = [];

    const outcome = ctx.map(
      [0, 1, 2],
      async (item) => {
        if (item === 0) {
          await Promise.resolve();
          throw denied;
        }
        return abortable(branchSignal(ctx), () => siblingsAborted.push(item));
      },
      { quorum: 2, concurrency: 3 },
    );

    await expect(outcome).rejects.toBe(denied);
    expect(siblingsAborted.sort()).toEqual([1, 2]);
  });

  it('ctx.race: a denied branch rejects the race and aborts the others', async () => {
    const { ctx } = createContext(new TestProvider(['x']));
    const denied = denial();
    let siblingAborted = false;

    const outcome = ctx.race([
      async () => {
        await Promise.resolve();
        throw denied;
      },
      async () => abortable(branchSignal(ctx), () => (siblingAborted = true)),
    ]);

    await expect(outcome).rejects.toBe(denied);
    expect(siblingAborted).toBe(true);
  });

  it('ctx.race: a denial from validate rejects the race instead of discarding the branch', async () => {
    const { ctx } = createContext(new TestProvider(['x']));
    const denied = denial();
    let siblingAborted = false;
    const validate = vi.fn(async () => {
      throw denied;
    });

    const outcome = ctx.race(
      [
        async () => ({ n: 1 }),
        async () => abortable(branchSignal(ctx), () => (siblingAborted = true)),
      ],
      { schema: numberSchema, validate },
    );

    await expect(outcome).rejects.toBe(denied);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(siblingAborted).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cancellation of the governing scope
// ═══════════════════════════════════════════════════════════════════════════

describe('an aborted scope is not recovered by a ctx recovery boundary', () => {
  it('ctx.verify: does not retry or return fallback once the workflow is cancelled', async () => {
    const controller = new AbortController();
    const { ctx } = createContext(new TestProvider(['x']), { signal: controller.signal });
    const reason = new Error('caller cancelled');
    const fn = vi.fn(async () => {
      controller.abort(reason);
      // Whatever fn surfaces after the abort, verify must not recover from it.
      throw new Error('downstream failure after abort');
    });

    const outcome = ctx.verify(fn, numberSchema, { retries: 3, fallback: { n: -1 } });

    await expect(outcome).rejects.toThrow('downstream failure after abort');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ctx.verify: an abort surfaces with its original reason identity', async () => {
    const controller = new AbortController();
    const provider = new TestProvider(['not json']);
    const { ctx } = createContext(provider, { signal: controller.signal });
    const reason = { custom: 'reason' };
    const fn = vi.fn(async () => {
      controller.abort(reason);
      return ctx.ask(testAgent, 'go');
    });

    const outcome = ctx.verify(fn, numberSchema, { retries: 3, fallback: { n: -1 } });

    await expect(outcome).rejects.toBe(reason);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(provider.calls).toBe(0);
  });

  it('ctx.verify: an invalid result under an aborted scope is not a fallback', async () => {
    const controller = new AbortController();
    const { ctx } = createContext(new TestProvider(['x']), { signal: controller.signal });
    const reason = new Error('caller cancelled');
    const fn = vi.fn(async () => ({ n: 1 }));
    const validate = vi.fn(async () => {
      controller.abort(reason);
      return { valid: false, reason: 'nope' };
    });

    const outcome = ctx.verify(fn, numberSchema, { retries: 0, validate, fallback: { n: -1 } });

    await expect(outcome).rejects.toBe(reason);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ctx.verify: a validator failing because the scope was cancelled is rethrown as-is', async () => {
    const controller = new AbortController();
    const { ctx } = createContext(new TestProvider(['x']), { signal: controller.signal });
    const validatorError = new Error('validator saw a torn-down dependency');
    const fn = vi.fn(async () => ({ n: 1 }));
    const validate = vi.fn(async () => {
      controller.abort(new Error('caller cancelled'));
      throw validatorError;
    });

    const outcome = ctx.verify(fn, numberSchema, { retries: 2, validate, fallback: { n: -1 } });

    await expect(outcome).rejects.toBe(validatorError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ctx.verify inside a hard_stop budget: the budget stop wins over retries and fallback', async () => {
    // The first ask costs more than the whole budget, and its output fails the
    // schema. hard_stop aborts the budget scope, so verify must not retry.
    const provider = new TestProvider(['not json']);
    const { ctx } = createContext(provider);
    const originalChat = provider.chat.bind(provider);
    provider.chat = async (messages, options) => ({
      ...(await originalChat(messages, options)),
      cost: 5,
    });
    const fn = vi.fn(() => ctx.ask(testAgent, 'go'));

    const result = await ctx.budget({ cost: '$1', onExceed: 'hard_stop' }, () =>
      ctx.verify(fn, numberSchema, { retries: 3, fallback: { n: -1 } }),
    );

    expect(result.budgetExceeded).toBe(true);
    expect(result.value).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(provider.calls).toBe(1);
  });

  it('ctx.verify: an ordinary failure still retries and still falls back', async () => {
    const { ctx } = createContext(new TestProvider(['x']));
    const fn = vi.fn(async () => {
      throw new Error('flaky');
    });

    await expect(
      ctx.verify(fn, numberSchema, { retries: 2, fallback: { n: -1 } }),
    ).resolves.toEqual({ n: -1 });
    expect(fn).toHaveBeenCalledTimes(3);
    await expect(ctx.verify(fn, numberSchema, { retries: 0 })).rejects.toBeInstanceOf(VerifyError);
  });

  it('ctx.ask: a validator failing because the ask was cancelled is not a validation failure', async () => {
    const controller = new AbortController();
    const provider = new TestProvider(['{"n":1}']);
    const { ctx } = createContext(provider, { signal: controller.signal });
    const reason = new Error('caller cancelled');
    const validate = vi.fn(async () => {
      controller.abort(reason);
      throw new Error('validator saw a torn-down dependency');
    });

    const outcome = ctx.ask(testAgent, 'go', {
      schema: numberSchema,
      validate,
      validateRetries: 0,
    });

    await expect(outcome).rejects.toThrow('validator saw a torn-down dependency');
    await expect(outcome).rejects.not.toBeInstanceOf(ValidationError);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(provider.calls).toBe(1);
  });

  it('ctx.spawn (default): an outer abort rejects instead of folding into results', async () => {
    const controller = new AbortController();
    const { ctx } = createContext(new TestProvider(['x']), { signal: controller.signal });
    const reason = new Error('caller cancelled');

    const outcome = ctx.spawn(2, async () => {
      const signal = branchSignal(ctx);
      const pending = abortable(signal, () => {});
      controller.abort(reason);
      return pending;
    });

    await expect(outcome).rejects.toBe(reason);
  });

  it('ctx.spawn (quorum): an outer abort rejects instead of QuorumNotMet', async () => {
    const controller = new AbortController();
    const { ctx } = createContext(new TestProvider(['x']), { signal: controller.signal });
    const reason = new Error('caller cancelled');

    const outcome = ctx.spawn(
      2,
      async () => {
        const pending = abortable(branchSignal(ctx), () => {});
        controller.abort(reason);
        return pending;
      },
      { quorum: 2 },
    );

    await expect(outcome).rejects.toBe(reason);
  });

  it('ctx.spawn (quorum): its own quorum cancellation of losers is still ignored', async () => {
    const { ctx } = createContext(new TestProvider(['x']));
    const results = await ctx.spawn(
      3,
      async (i) => (i === 0 ? 'winner' : abortable(branchSignal(ctx), () => {})),
      { quorum: 1 },
    );
    expect(results[0]).toEqual({ ok: true, value: 'winner' });
  });

  it('ctx.map (default): an outer abort rejects instead of folding into results', async () => {
    const controller = new AbortController();
    const { ctx } = createContext(new TestProvider(['x']), { signal: controller.signal });
    const reason = new Error('caller cancelled');
    const fn = vi.fn(async () => {
      const pending = abortable(branchSignal(ctx), () => {});
      controller.abort(reason);
      return pending;
    });

    await expect(ctx.map([0, 1, 2], fn, { concurrency: 1 })).rejects.toBe(reason);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ctx.map (quorum): an outer abort rejects instead of folding into results', async () => {
    const controller = new AbortController();
    const { ctx } = createContext(new TestProvider(['x']), { signal: controller.signal });
    const reason = new Error('caller cancelled');

    const outcome = ctx.map(
      [0, 1],
      async () => {
        const pending = abortable(branchSignal(ctx), () => {});
        controller.abort(reason);
        return pending;
      },
      { quorum: 1, concurrency: 1 },
    );

    await expect(outcome).rejects.toBe(reason);
  });

  it('ctx.map (quorum): its own quorum cancellation of stragglers is still ignored', async () => {
    const { ctx } = createContext(new TestProvider(['x']));
    const results = await ctx.map(
      [0, 1, 2],
      async (item) => (item === 0 ? 'winner' : abortable(branchSignal(ctx), () => {})),
      { quorum: 1, concurrency: 3 },
    );
    expect(results[0]).toEqual({ ok: true, value: 'winner' });
  });

  it('ctx.race: an outer abort rejects with the abort, not a generic all-aborted error', async () => {
    const controller = new AbortController();
    const { ctx } = createContext(new TestProvider(['x']), { signal: controller.signal });

    const outcome = ctx.race([
      async () => {
        const pending = abortable(branchSignal(ctx), () => {});
        // No reason: the default DOMException('AbortError') is indistinguishable
        // by shape from the race's own loser cancellation.
        controller.abort();
        return pending;
      },
      async () => abortable(branchSignal(ctx), () => {}),
    ]);

    await expect(outcome).rejects.toBe(controller.signal.reason);
  });

  it('ctx.spawn / ctx.map (default) still fold ordinary failures into results', async () => {
    const { ctx } = createContext(new TestProvider(['x']));
    const spawned = await ctx.spawn(2, async (i) => {
      if (i === 0) throw new Error('boom');
      return i;
    });
    expect(spawned).toEqual([
      { ok: false, error: 'boom' },
      { ok: true, value: 1 },
    ]);
    const mapped = await ctx.map([0, 1], async (item) => {
      if (item === 0) throw new Error('boom');
      return item;
    });
    expect(mapped).toEqual([
      { ok: false, error: 'boom' },
      { ok: true, value: 1 },
    ]);
    await expect(
      ctx.spawn(2, async () => Promise.reject(new Error('boom')), { quorum: 1 }),
    ).rejects.toBeInstanceOf(QuorumNotMet);
  });
});
