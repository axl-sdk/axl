import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('runtime branch finalization barrier', () => {
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, null])(
    'rejects invalid branchDrainTimeoutMs=%s before runtime bookkeeping',
    async (branchDrainTimeoutMs) => {
      const wf = workflow({
        name: `invalid-branch-drain-${String(branchDrainTimeoutMs)}`,
        input: z.object({}).strict(),
        handler: () => 'unreachable',
      });
      const runtime = new AxlRuntime();
      runtime.register(wf);

      await expect(
        runtime.execute(
          wf.name,
          {},
          {
            branchDrainTimeoutMs: branchDrainTimeoutMs as number,
          },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      await expect(runtime.getExecutions()).resolves.toEqual([]);
      expect(() =>
        runtime.stream(
          wf.name,
          {},
          {
            branchDrainTimeoutMs: branchDrainTimeoutMs as number,
          },
        ),
      ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
      await expect(runtime.getExecutions()).resolves.toEqual([]);
    },
  );

  it('finalizes with an incomplete marker when an abort-ignoring loser never settles', async () => {
    const loserStarted = deferred();
    const releaseLoser = deferred();
    const events: Array<{ type: string; data?: unknown }> = [];
    const wf = workflow({
      name: 'bounded-branch-drain',
      input: z.object({}).strict(),
      handler: (ctx) =>
        ctx.race([
          async () => {
            await loserStarted.promise;
            return 'winner';
          },
          async () => {
            loserStarted.resolve();
            await releaseLoser.promise;
            ctx.log('too-late');
            return 'loser';
          },
        ]),
    });
    const runtime = new AxlRuntime();
    runtime.register(wf);
    runtime.on('trace', (event) => events.push(event));

    await expect(runtime.execute(wf.name, {}, { branchDrainTimeoutMs: 10 })).resolves.toBe(
      'winner',
    );

    const terminal = events.find((event) => event.type === 'workflow_end') as
      | { data: { observation?: unknown } }
      | undefined;
    expect(terminal?.data.observation).toEqual({
      complete: false,
      reason: 'branch_drain_timeout',
      pendingContinuations: 2,
      timeoutMs: 10,
    });
    const executionId = (events[0] as { executionId?: string }).executionId!;
    expect((await runtime.getExecution(executionId))?.observation).toEqual(
      terminal?.data.observation,
    );

    const terminalIndex = events.findIndex((event) => event.type === 'workflow_end');
    releaseLoser.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toHaveLength(terminalIndex + 1);
  });

  it('suppresses late child-context events after bounded finalization', async () => {
    const loserStarted = deferred();
    const releaseLoser = deferred();
    const events: Array<{ type: string }> = [];
    const wf = workflow({
      name: 'bounded-child-branch-drain',
      input: z.object({}).strict(),
      handler: (ctx) => {
        const child = ctx.createChildContext();
        return ctx.race([
          async () => {
            await loserStarted.promise;
            return 'winner';
          },
          async () => {
            loserStarted.resolve();
            await releaseLoser.promise;
            child.log('too-late-child');
            return 'loser';
          },
        ]);
      },
    });
    const runtime = new AxlRuntime();
    runtime.register(wf);
    runtime.on('trace', (event) => events.push(event));

    await expect(runtime.execute(wf.name, {}, { branchDrainTimeoutMs: 10 })).resolves.toBe(
      'winner',
    );

    const terminalIndex = events.findIndex((event) => event.type === 'workflow_end');
    releaseLoser.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toHaveLength(terminalIndex + 1);
  });

  it.each(['race', 'spawn', 'map'] as const)(
    'waits for an abort-ignoring %s loser before workflow_end',
    async (primitive) => {
      const loser = deferred();
      const events: Array<{ type: string; data?: unknown }> = [];
      const wf = workflow({
        name: `drain-${primitive}`,
        input: z.object({}).strict(),
        handler: async (ctx) => {
          if (primitive === 'race') {
            await ctx.race([
              async () => 'winner',
              async () => {
                await loser.promise;
                ctx.log('loser-settled');
                return 'loser';
              },
            ]);
          } else if (primitive === 'spawn') {
            await ctx.spawn(
              2,
              async (index) => {
                if (index === 1) {
                  await loser.promise;
                  ctx.log('loser-settled');
                }
                return index;
              },
              { quorum: 1 },
            );
          } else {
            await ctx.map(
              [0, 1],
              async (value) => {
                if (value === 1) {
                  await loser.promise;
                  ctx.log('loser-settled');
                }
                return value;
              },
              { quorum: 1, concurrency: 2 },
            );
          }
          return 'winner';
        },
      });
      const runtime = new AxlRuntime();
      runtime.register(wf);
      runtime.on('trace', (event) => events.push(event));

      let completed = false;
      const execution = runtime.execute(wf.name, {}).then((result) => {
        completed = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(completed).toBe(false);

      loser.resolve();
      await expect(execution).resolves.toBe('winner');
      expect(events.map((event) => event.type)).toContain('log');
      expect(events.findIndex((event) => event.type === 'log')).toBeLessThan(
        events.findIndex((event) => event.type === 'workflow_end'),
      );
    },
  );

  it('retains a late abort-ignoring provider cost and closes its ask before workflow_end', async () => {
    const losingStarted = deferred();
    const releaseLosing = deferred();
    const losingProvider = {
      name: 'losing',
      async chat() {
        losingStarted.resolve();
        await releaseLosing.promise;
        return {
          content: 'too late',
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          cost: 0.02,
        };
      },
    };
    const winningProvider = {
      name: 'winning',
      async chat() {
        await losingStarted.promise;
        return {
          content: 'winner',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          cost: 0.01,
        };
      },
    };
    const losingAgent = agent({ name: 'loser', model: 'losing:model', system: 'test' });
    const winningAgent = agent({ name: 'winner', model: 'winning:model', system: 'test' });
    const wf = workflow({
      name: 'drain-provider-cost',
      input: z.object({}).strict(),
      handler: (ctx) =>
        ctx.race([() => ctx.ask(losingAgent, 'go'), () => ctx.ask(winningAgent, 'go')]),
    });
    const runtime = new AxlRuntime();
    runtime.registerProvider('losing', losingProvider);
    runtime.registerProvider('winning', winningProvider);
    runtime.register(wf);
    const events: Array<{ type: string; agent?: string; executionId?: string }> = [];
    runtime.on('trace', (event) => events.push(event));

    let completed = false;
    const execution = runtime.execute(wf.name, {}).then((result) => {
      completed = true;
      return result;
    });
    await losingStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(false);

    releaseLosing.resolve();
    await expect(execution).resolves.toBe('winner');
    const workflowEnd = events.findIndex((event) => event.type === 'workflow_end');
    const losingAskEnd = events.findIndex(
      (event) => event.type === 'ask_end' && event.agent === 'loser',
    );
    expect(losingAskEnd).toBeGreaterThan(-1);
    expect(losingAskEnd).toBeLessThan(workflowEnd);

    const historical = await runtime.getExecution(events[0].executionId!);
    expect(historical?.totalCost).toBeCloseTo(0.03);
  });

  it('does not let a late map quorum loser mutate the returned result', async () => {
    const loserStarted = deferred();
    const releaseLoser = deferred();
    const wf = workflow({
      name: 'map-quorum-result-stability',
      input: z.object({}).strict(),
      handler: (ctx) =>
        ctx.map(
          [0, 1],
          async (value) => {
            if (value === 1) {
              loserStarted.resolve();
              await releaseLoser.promise;
            } else {
              await loserStarted.promise;
            }
            return value;
          },
          { quorum: 1, concurrency: 2 },
        ),
    });
    const runtime = new AxlRuntime();
    runtime.register(wf);

    const execution = runtime.execute(wf.name, {});
    await loserStarted.promise;
    releaseLoser.resolve();

    await expect(execution).resolves.toEqual([{ ok: true, value: 0 }, undefined]);
  });

  it('propagates strict event overflow from a late race loser', async () => {
    const loserStarted = deferred();
    const releaseLoser = deferred();
    const wf = workflow({
      name: 'race-loser-overflow',
      input: z.object({}).strict(),
      handler: async (ctx) => {
        const bus = ctx.events;
        const iterator = bus[Symbol.asyncIterator]();
        void (async () => {
          while (!(await iterator.next()).done) {
            // Keep the main queue drained so only the loser's synchronous
            // burst can exceed the strict cap.
          }
        })();
        return ctx.race([
          async () => {
            await loserStarted.promise;
            return 'winner';
          },
          async () => {
            loserStarted.resolve();
            await releaseLoser.promise;
            ctx.log('delivered to waiter');
            ctx.log('fills queue');
            ctx.log('loser overflows queue');
            return 'loser';
          },
        ]);
      },
    });
    const runtime = new AxlRuntime();
    runtime.register(wf);

    const execution = runtime.execute(
      wf.name,
      {},
      {
        events: { maxQueued: 1, onOverflow: 'throw' },
      },
    );
    await loserStarted.promise;
    releaseLoser.resolve();

    await expect(execution).rejects.toMatchObject({
      name: 'EventStreamOverflowError',
      eventType: 'log',
    });
  });

  it('preserves the handler failure as the cause when late strict overflow replaces it', async () => {
    const loserStarted = deferred();
    const releaseLoser = deferred();
    const handlerFailure = new Error('primary handler failure');
    const wf = workflow({
      name: 'late-overflow-preserves-cause',
      input: z.object({}).strict(),
      handler: async (ctx) => {
        const iterator = ctx.events[Symbol.asyncIterator]();
        void (async () => {
          while (!(await iterator.next()).done) {
            // Drain mainline events so only the late burst saturates.
          }
        })();
        await ctx.race([
          async () => {
            await loserStarted.promise;
            return 'winner';
          },
          async () => {
            loserStarted.resolve();
            await releaseLoser.promise;
            ctx.log('delivered to waiter');
            ctx.log('fills queue');
            ctx.log('overflows queue');
            return 'loser';
          },
        ]);
        throw handlerFailure;
      },
    });
    const runtime = new AxlRuntime();
    runtime.register(wf);

    const execution = runtime.execute(
      wf.name,
      {},
      {
        events: { maxQueued: 1, onOverflow: 'throw' },
      },
    );
    await loserStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseLoser.resolve();

    const error = await execution.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: 'EventStreamOverflowError',
      cause: handlerFailure,
    });
  });

  it('propagates strict overflow from a late async race validator', async () => {
    const loserValidating = deferred();
    const releaseValidator = deferred();
    const wf = workflow({
      name: 'race-validator-overflow',
      input: z.object({}).strict(),
      handler: async (ctx) => {
        const bus = ctx.events;
        const iterator = bus[Symbol.asyncIterator]();
        void (async () => {
          while (!(await iterator.next()).done) {
            // Keep mainline events drained; only the validator burst overflows.
          }
        })();
        return ctx.race(
          [
            async () => {
              await loserValidating.promise;
              return 'winner';
            },
            async () => 'loser',
          ],
          {
            schema: z.string(),
            validate: async (value) => {
              if (value === 'loser') {
                loserValidating.resolve();
                await releaseValidator.promise;
                ctx.log('delivered to waiter');
                ctx.log('fills queue');
                ctx.log('validator overflows queue');
              }
              return { valid: true };
            },
          },
        );
      },
    });
    const runtime = new AxlRuntime();
    runtime.register(wf);

    const execution = runtime.execute(
      wf.name,
      {},
      {
        events: { maxQueued: 1, onOverflow: 'throw' },
      },
    );
    await loserValidating.promise;
    releaseValidator.resolve();

    await expect(execution).rejects.toMatchObject({
      name: 'EventStreamOverflowError',
      eventType: 'log',
    });
  });

  it.each(['race', 'spawn-quorum', 'spawn-all', 'map-quorum', 'map-all'] as const)(
    'propagates strict event overflow before %s resolves',
    async (primitive) => {
      const wf = workflow({
        name: `pre-resolution-overflow-${primitive}`,
        input: z.object({}).strict(),
        handler: async (ctx) => {
          const bus = ctx.events;
          const iterator = bus[Symbol.asyncIterator]();
          void (async () => {
            while (!(await iterator.next()).done) {
              // Keep mainline events drained; the synchronous log burst is
              // the only source capable of exceeding this test's cap.
            }
          })();
          const overflow = async () => {
            ctx.log('delivered to waiter');
            ctx.log('fills queue');
            ctx.log('overflows queue');
            return 'unreachable';
          };

          if (primitive === 'race') return ctx.race([overflow]);
          if (primitive === 'spawn-quorum') return ctx.spawn(1, overflow, { quorum: 1 });
          if (primitive === 'spawn-all') return ctx.spawn(1, overflow);
          if (primitive === 'map-quorum') {
            return ctx.map([0], overflow, { quorum: 1 });
          }
          return ctx.map([0], overflow);
        },
      });
      const runtime = new AxlRuntime();
      runtime.register(wf);

      await expect(
        runtime.execute(wf.name, {}, { events: { maxQueued: 1, onOverflow: 'throw' } }),
      ).rejects.toMatchObject({ name: 'EventStreamOverflowError', eventType: 'log' });
    },
  );
});
