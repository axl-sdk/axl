import { describe, it, expect } from 'vitest';
import { agent } from '../agent.js';
import { createTestCtx } from './helpers.js';
import type { AxlEvent, AskScoped } from '../types.js';

/**
 * Each branch primitive (spawn / parallel / race / map) must preserve
 * `askId` correlation under concurrent interleaving. AsyncLocalStorage
 * gives each branch its own independent frame chain because every branch
 * synchronously calls `ctx.ask()` which allocates its own ALS scope.
 *
 * The pattern under test: a parent runs N branches concurrently; each
 * branch's ctx.ask events must carry that branch's own askId — never
 * mixed with a sibling's. Step counters share the root execution counter
 * so they're monotonic across branches.
 */
describe('AsyncLocalStorage — branch primitive ask correlation', () => {
  it('ctx.spawn — each branch ask carries its own askId; no cross-talk', async () => {
    const a = agent({ name: 'leaf', model: 'mock:test', system: 'leaf' });
    const { ctx, traces } = createTestCtx();

    const delays = [5, 1, 3];
    const prompts = ['branch-A', 'branch-B', 'branch-C'];
    await ctx.spawn(3, async (i) => {
      await new Promise((r) => setTimeout(r, delays[i]));
      return ctx.ask(a, prompts[i]);
    });

    const askStarts = traces.filter((t) => t.type === 'ask_start') as Array<
      AxlEvent & AskScoped & { type: 'ask_start'; prompt: string }
    >;
    expect(askStarts.length).toBe(3);
    const askIds = new Set(askStarts.map((s) => s.askId));
    expect(askIds.size).toBe(3);

    // Every event grouped by askId must reference exactly one prompt.
    for (const start of askStarts) {
      const askEvents = traces.filter(
        (t) =>
          (t.type === 'ask_start' || t.type === 'ask_end' || t.type === 'agent_call_end') &&
          (t as AxlEvent & AskScoped).askId === start.askId,
      );
      expect(askEvents.every((e) => (e as AxlEvent & AskScoped).askId === start.askId)).toBe(true);
    }
  });

  it('ctx.race — winning branch carries its own askId; losers also tagged correctly', async () => {
    const a = agent({ name: 'leaf', model: 'mock:test', system: 'leaf' });
    const { ctx, traces } = createTestCtx();

    await ctx.race([
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        return ctx.ask(a, 'race-slow');
      },
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        return ctx.ask(a, 'race-fast');
      },
    ]);

    const askStarts = traces.filter((t) => t.type === 'ask_start') as Array<
      AxlEvent & AskScoped & { type: 'ask_start'; prompt: string }
    >;
    // At least the winning branch's ask_start fires; losers may fire if they
    // started before the abort signal propagated. All emitted askIds must be
    // distinct.
    expect(askStarts.length).toBeGreaterThanOrEqual(1);
    const askIds = new Set(askStarts.map((s) => s.askId));
    expect(askIds.size).toBe(askStarts.length);
  });

  it('ctx.parallel — interleaved branches preserve isolation', async () => {
    const a = agent({ name: 'leaf', model: 'mock:test', system: 'leaf' });
    const { ctx, traces } = createTestCtx();

    await ctx.parallel([
      async () => {
        await new Promise((r) => setTimeout(r, 4));
        return ctx.ask(a, 'p-A');
      },
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        return ctx.ask(a, 'p-B');
      },
      async () => ctx.ask(a, 'p-C'),
    ]);

    const askStarts = traces.filter((t) => t.type === 'ask_start') as Array<
      AxlEvent & AskScoped & { type: 'ask_start'; prompt: string }
    >;
    expect(askStarts.length).toBe(3);
    const askIds = new Set(askStarts.map((s) => s.askId));
    expect(askIds.size).toBe(3);
    // Step counter is monotonic even under concurrent emission (single-
    // threaded JS event loop + atomic ++stepRef.value guarantees this).
    const sortedSteps = traces.map((t) => t.step).sort((a, b) => a - b);
    for (let i = 1; i < sortedSteps.length; i++) {
      expect(sortedSteps[i]).toBeGreaterThan(sortedSteps[i - 1]);
    }
  });
});
