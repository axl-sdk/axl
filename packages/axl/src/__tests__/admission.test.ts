/**
 * Admission invariants (plan A5, A6, A8, A9).
 *
 * The threshold is a KNOWN-spend threshold checked synchronously: work already
 * dispatched settles and is counted, and nothing new is admitted afterwards.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { AdmissionController, externalOperation } from '../accounting.js';
import { AdmissionDeniedError, AxlError } from '../errors.js';
import {
  deferred,
  registerAskWorkflow,
  scriptedRuntime,
  ScriptedProvider,
} from './accounting-helpers.js';

// ═══════════════════════════════════════════════════════════════════════════
// I6 — the controller itself
// ═══════════════════════════════════════════════════════════════════════════

describe('I6: AdmissionController is a synchronous known-spend threshold', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
    ['a string', '5' as unknown as number],
    ['undefined', undefined as unknown as number],
  ])('rejects a %s limit before any work happens', (_label, limit) => {
    expect(() => new AdmissionController({ limit })).toThrow(AxlError);
    try {
      new AdmissionController({ limit });
    } catch (error) {
      expect((error as AxlError).code).toBe('INVALID_BUDGET');
    }
  });

  it('admits nothing at limit 0', async () => {
    const admission = new AdmissionController({ limit: 0 });
    expect(admission.closed).toBe(true);
    expect(admission.status).toBe('closed');
    expect(admission.admit()).toEqual({ admitted: false, limit: 0, knownSpend: 0 });

    const { runtime, provider } = scriptedRuntime([{ cost: 1 }]);
    registerAskWorkflow(runtime);
    const outcome = await runtime.trackOutcome(() => runtime.execute('ask', {}), { admission });

    expect(outcome.status).toBe('rejected');
    expect(provider.calls).toHaveLength(0);
    expect(outcome.accounting.knownCost).toBe(0);
    expect(outcome.accounting.operations.denied).toBe(1);
    // A denial contributes nothing: not to `total`, not to `reasons`, and it
    // does not make the scope incomplete.
    expect(outcome.accounting.operations.total).toBe(0);
    expect(outcome.accounting.reasons).toEqual({});
    expect(outcome.accounting.completeness).toBe('complete');
  });

  it('closes at exactly the limit, not one cent past it', async () => {
    const admission = new AdmissionController({ limit: 1 });
    const { runtime, provider } = scriptedRuntime([{ cost: 1 }]);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    runtime.register(
      workflow({
        name: 'twice',
        input: z.any(),
        handler: async (ctx) => {
          await ctx.ask(asker, 'one');
          return ctx.ask(asker, 'two');
        },
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('twice', {}), { admission });

    expect(provider.calls).toHaveLength(1);
    expect(admission.knownSpend).toBe(1);
    expect(admission.status).toBe('closed');
    expect(admission.knownOvershoot).toBe(0);
    expect(outcome.status).toBe('rejected');
    expect(outcome.accounting.knownCost).toBe(1);
  });

  it('reports known overshoot when concurrent dispatched work settles past the limit', async () => {
    const admission = new AdmissionController({ limit: 1 });
    const release = deferred();
    let dispatched = 0;
    const provider: import('../providers/types.js').Provider = {
      name: 'concurrent',
      async chat() {
        dispatched += 1;
        await release.promise;
        return {
          content: 'ok',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          cost: 0.75,
        };
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('unused');
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'concurrent' });
    runtime.registerProvider('concurrent', provider);
    const asker = agent({ name: 'a', model: 'concurrent:m' });
    runtime.register(
      workflow({
        name: 'fanout',
        input: z.any(),
        handler: async (ctx) => {
          // Both are admitted before either settles — the documented
          // threshold-not-reservation behavior.
          const [one, two] = await Promise.all([ctx.ask(asker, 'a'), ctx.ask(asker, 'b')]);
          // A third call after the crossing must not be admitted.
          await expect(ctx.ask(asker, 'c')).rejects.toBeInstanceOf(AdmissionDeniedError);
          return [one, two];
        },
      }),
    );

    const outcomePromise = runtime.trackOutcome(() => runtime.execute('fanout', {}), { admission });
    await new Promise((resolve) => setImmediate(resolve));
    release.resolve();
    const outcome = await outcomePromise;

    expect(dispatched).toBe(2);
    expect(outcome.accounting.knownCost).toBeCloseTo(1.5, 10);
    expect(admission.knownOvershoot).toBeCloseTo(0.5, 10);
    expect(admission.snapshot()).toEqual({
      limit: 1,
      status: 'closed',
      knownSpend: admission.knownSpend,
      knownOvershoot: admission.knownOvershoot,
    });
  });

  it('counts a charged FAILED call against the threshold like a success', async () => {
    const admission = new AdmissionController({ limit: 1 });
    // The adapter reports its charge and then the workflow throws; the money
    // is spent either way.
    const { runtime } = scriptedRuntime([{ cost: 1 }]);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    runtime.register(
      workflow({
        name: 'charge-then-fail',
        input: z.any(),
        handler: async (ctx) => {
          await ctx.ask(asker, 'go');
          throw new Error('workflow failed after paying');
        },
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('charge-then-fail', {}), {
      admission,
    });
    expect(outcome.status).toBe('rejected');
    expect(admission.knownSpend).toBe(1);
    expect(admission.closed).toBe(true);
  });

  it('carries the refusal details on the error', async () => {
    const admission = new AdmissionController({ limit: 0.5 });
    const { runtime } = scriptedRuntime([{ cost: 0.5 }]);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    runtime.register(
      workflow({
        name: 'twice',
        input: z.any(),
        handler: async (ctx) => {
          await ctx.ask(asker, 'one');
          return ctx.ask(asker, 'two');
        },
      }),
    );

    let denied: AdmissionDeniedError | undefined;
    await runtime.trackOutcome(
      async () => {
        try {
          await runtime.execute('twice', {});
        } catch (error) {
          // The runtime wraps ask failures; walk to the admission error.
          for (let c: unknown = error; c != null; c = (c as { cause?: unknown }).cause) {
            if (c instanceof AdmissionDeniedError) denied = c;
          }
          throw error;
        }
      },
      { admission },
    );

    expect(denied).toBeInstanceOf(AdmissionDeniedError);
    expect(denied?.code).toBe('ADMISSION_DENIED');
    expect(denied?.name).toBe('AdmissionDeniedError');
    expect(denied?.limit).toBe(0.5);
    expect(denied?.knownSpend).toBe(0.5);
    expect(denied?.operation.kind).toBe('chat');
    expect(denied?.operation.model).toBe('m');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I8 — tools obey the same closed scope
// ═══════════════════════════════════════════════════════════════════════════

describe('I8: tool invocations are denied after closure', () => {
  it('denies a direct tool.run once the budget has closed', async () => {
    const admission = new AdmissionController({ limit: 0 });
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    let handlerRuns = 0;
    const local = tool({
      name: 'local',
      description: 'apparently local, still admitted',
      input: z.object({}),
      handler: async () => {
        handlerRuns += 1;
        return 'ran';
      },
    });
    runtime.register(
      workflow({
        name: 'direct-tool',
        input: z.any(),
        handler: async (ctx) => local.run(ctx, {}),
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('direct-tool', {}), {
      admission,
    });
    expect(outcome.status).toBe('rejected');
    // No implicit local-tool exemption: the handler never ran.
    expect(handlerRuns).toBe(0);
  });

  it('does not start a further retry attempt after the budget closes mid-retry', async () => {
    const admission = new AdmissionController({ limit: 1 });
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    const attempts: number[] = [];
    const flaky = tool({
      name: 'flaky',
      description: 'fails, then would retry',
      input: z.object({}),
      retry: { attempts: 3, backoff: 'none' },
      handler: async () => {
        attempts.push(attempts.length + 1);
        // Close the budget from inside the first attempt via a declared
        // external charge, then fail so a retry would normally follow.
        await externalOperation({ name: 'vendor' }, async (report) => {
          report.setCost(1);
        });
        throw new Error('attempt failed');
      },
    });
    runtime.register(
      workflow({
        name: 'retrying-tool',
        input: z.any(),
        handler: async (ctx) => flaky.run(ctx, {}),
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('retrying-tool', {}), {
      admission,
    });

    expect(outcome.status).toBe('rejected');
    // The first attempt ran and paid; the second was refused admission.
    expect(attempts).toEqual([1]);
    expect(admission.closed).toBe(true);
    expect(outcome.accounting.knownCost).toBe(1);
  });

  it('lets a running handler finish but denies new instrumented work inside it', async () => {
    const admission = new AdmissionController({ limit: 1 });
    const { runtime } = scriptedRuntime([{ cost: 1 }, { cost: 1 }]);
    const asker = agent({ name: 'inner', model: 'scripted:m' });
    let finished = false;
    let innerDenied: unknown;
    const spender = tool({
      name: 'spender',
      description: 'asks twice from inside a handler',
      input: z.object({}),
      handler: async (_input, ctx) => {
        await ctx.ask(asker, 'first');
        try {
          await ctx.ask(asker, 'second');
        } catch (error) {
          for (let c: unknown = error; c != null; c = (c as { cause?: unknown }).cause) {
            if (c instanceof AdmissionDeniedError) innerDenied = c;
          }
        }
        finished = true;
        return 'handler completed';
      },
    });
    runtime.register(
      workflow({
        name: 'handler-scope',
        input: z.any(),
        handler: async (ctx) => spender.run(ctx, {}),
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('handler-scope', {}), {
      admission,
    });

    expect(finished).toBe(true);
    expect(innerDenied).toBeInstanceOf(AdmissionDeniedError);
    expect(outcome.accounting.knownCost).toBe(1);
    expect(outcome.accounting.operations.denied).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I9 — abort and nested ctx.budget keep their own identities
// ═══════════════════════════════════════════════════════════════════════════

describe('I9: other stop mechanisms keep their own semantics', () => {
  it("keeps ctx.budget()'s own semantics rather than reporting an admission denial", async () => {
    const { runtime } = scriptedRuntime([{ cost: 1 }, { cost: 1 }]);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    let budgetResult: { budgetExceeded: boolean; totalCost: number } | undefined;
    runtime.register(
      workflow({
        name: 'ctx-budget',
        input: z.any(),
        handler: async (ctx) => {
          budgetResult = await ctx.budget({ cost: '$0.50', onExceed: 'hard_stop' }, async () => {
            await ctx.ask(asker, 'one');
            return ctx.ask(asker, 'two');
          });
          return 'workflow completed';
        },
      }),
    );

    // A generous outer admission, so only `ctx.budget` can stop anything.
    const admission = new AdmissionController({ limit: 100 });
    const outcome = await runtime.trackOutcome(() => runtime.execute('ctx-budget', {}), {
      admission,
    });

    // `ctx.budget` reports through its own result shape; it never turns into an
    // admission denial and never closes the run-level controller.
    expect(outcome.status).toBe('fulfilled');
    expect(budgetResult?.budgetExceeded).toBe(true);
    expect(budgetResult?.totalCost).toBe(1);
    expect(admission.closed).toBe(false);
    expect(admission.knownSpend).toBe(1);
    expect(outcome.accounting.operations.denied).toBe(0);
    // The narrower stop kept the second call from ever dispatching, so the
    // run accounting shows one settled operation, not two.
    expect(outcome.accounting.operations.total).toBe(1);
    expect(outcome.accounting.knownCost).toBe(1);
  });

  it('lets the NARROWEST closed controller deny', async () => {
    const outer = new AdmissionController({ limit: 100 });
    const inner = new AdmissionController({ limit: 0 });
    const { runtime, provider } = scriptedRuntime([{ cost: 1 }]);
    registerAskWorkflow(runtime);

    const result = await runtime.trackOutcome(
      async () => {
        const nested = await runtime.trackOutcome(() => runtime.execute('ask', {}), {
          admission: inner,
        });
        expect(nested.status).toBe('rejected');
        for (
          let c: unknown = nested.status === 'rejected' ? nested.error : undefined;
          c != null;
          c = (c as { cause?: unknown }).cause
        ) {
          if (c instanceof AdmissionDeniedError) expect(c.limit).toBe(0);
        }
        return 'outer survived';
      },
      { admission: outer },
    );

    expect(result.status).toBe('fulfilled');
    expect(provider.calls).toHaveLength(0);
    expect(outer.closed).toBe(false);
  });

  it('preserves a caller abort rather than reporting it as an admission denial', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([{ cost: 0.1 }]);
    const runtime = new AxlRuntime({ defaultProvider: 'scripted' });
    runtime.registerProvider('scripted', provider);
    runtime.register(
      workflow({
        name: 'aborted',
        input: z.any(),
        handler: async () => {
          controller.abort();
          await new Promise((resolve) => setImmediate(resolve));
          controller.signal.throwIfAborted();
          return 'never';
        },
      }),
    );

    const outcome = await runtime.trackOutcome(
      () => runtime.execute('aborted', {}, { signal: controller.signal }),
      { admission: new AdmissionController({ limit: 100 }) },
    );
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.error).not.toBeInstanceOf(AdmissionDeniedError);
    }
  });
});
