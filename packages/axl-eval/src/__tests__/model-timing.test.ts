import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AxlRuntime, agent } from '@axlsdk/axl';
import type { AxlRuntime as AxlRuntimeType, CallTiming } from '@axlsdk/axl';
import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';
import { runEval } from '../runner.js';

// Frozen behavioral matrix group E (R-T6 / AC-6): per-model provider-call
// latency rolls up from `agent_call_end.timing` onto `item.timing` and
// `summary.modelTiming`, on BOTH the plain and the captureTraces path, without
// changing anything about cost, budget or metadata.

/**
 * Provider whose per-call `timing` is scripted per model, so every asserted sum
 * is an exact integer rather than a measured delta. `timing` is attached only
 * when the script supplies one, which is how the "uninstrumented provider"
 * cases stay honest.
 *
 * The script is keyed by the BARE model name the adapter receives on
 * `ChatOptions.model`; the rollup is asserted against the full `provider:model`
 * URI, which is what `agent_call_end.model` carries. Those two keys differing is
 * the point — a rollup keyed off the adapter's view would collide across
 * providers and defeat the cross-provider comparison.
 */
function timedProvider(script: Record<string, CallTiming | undefined>) {
  return {
    name: 'test',
    chat: async (_messages: unknown[], options: { model: string }) => {
      const timing = script[options.model];
      return {
        content: `answer from ${options.model}`,
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: 0,
        ...(timing ? { timing } : {}),
      };
    },
  };
}

function runtimeWith(script: Record<string, CallTiming | undefined>): AxlRuntimeType {
  const runtime = new AxlRuntime({ defaultProvider: 'test' });
  runtime.registerProvider('test', timedProvider(script) as never);
  return runtime;
}

/** Bare model names, as the adapter sees them. */
const BARE_A = 'model-a';
const BARE_B = 'model-b';
/** Full URIs, as `agent_call_end.model` and the rollup key them. */
const A = `test:${BARE_A}`;
const B = `test:${BARE_B}`;
const agentA = agent({ name: 'a', model: A, system: 'A' });
const agentB = agent({ name: 'b', model: B, system: 'B' });

const passScorer = scorer({ name: 'pass', description: 'pass', score: () => 1 });

function oneItemDataset(count = 1) {
  return dataset({
    name: 'ds',
    schema: z.object({ q: z.string() }),
    items: Array.from({ length: count }, (_, i) => ({ input: { q: `q${i}` } })),
  });
}

describe('runEval() — per-model timing rollup (R-T6)', () => {
  // E1
  it('keys item.timing by model with per-model call counts and sums', async () => {
    const runtime = runtimeWith({
      [BARE_A]: { queuedMs: 10, attempts: 1, retryMs: 50, ttfbMs: 3, wireMs: 30 },
      [BARE_B]: { queuedMs: 5, attempts: 1, retryMs: 0, ttfbMs: 2, wireMs: 70 },
    });

    const result = await runEval(
      { workflow: 'w', dataset: oneItemDataset(), scorers: [passScorer] },
      async (_input, rt) => {
        const ctx = rt.createContext();
        await ctx.ask(agentA, 'one');
        await ctx.ask(agentA, 'two');
        await ctx.ask(agentB, 'three');
        return { output: 'out' };
      },
      runtime,
    );

    // Two calls on A, one on B — a single merged bucket, or a calls-only
    // rollup, both fail here.
    expect(result.items[0].timing).toEqual({
      [A]: { calls: 2, queuedMs: 20, retryMs: 100, wireMs: 60 },
      [B]: { calls: 1, queuedMs: 5, retryMs: 0, wireMs: 70 },
    });
  });

  // E2 — absence must be absence.
  it('leaves item.timing off an item that made no provider call', async () => {
    const runtime = runtimeWith({
      [BARE_A]: { queuedMs: 1, attempts: 1, retryMs: 0, ttfbMs: 1, wireMs: 1 },
    });

    const result = await runEval(
      { workflow: 'w', dataset: oneItemDataset(), scorers: [passScorer] },
      async () => ({ output: 'pure compute, no ask' }),
      runtime,
    );

    expect('timing' in result.items[0]).toBe(false);
    expect(result.summary.modelTiming).toBeUndefined();
  });

  it('leaves item.timing off when the provider reports no timing', async () => {
    const runtime = runtimeWith({ [BARE_A]: undefined });

    const result = await runEval(
      { workflow: 'w', dataset: oneItemDataset(), scorers: [passScorer] },
      async (_input, rt) => {
        const ctx = rt.createContext();
        await ctx.ask(agentA, 'one');
        return { output: 'out' };
      },
      runtime,
    );

    expect('timing' in result.items[0]).toBe(false);
    expect(result.summary.modelTiming).toBeUndefined();
  });

  // E3
  it('reports every per-model bucket without redefining summary.timing', async () => {
    const runtime = runtimeWith({
      // A streams (it reports a first token) and gets throttled; B does neither.
      [BARE_A]: {
        queuedMs: 10,
        attempts: 2,
        retryMs: 60,
        ttfbMs: 3,
        firstTokenMs: 25,
        wireMs: 40,
      },
      [BARE_B]: { queuedMs: 100, attempts: 1, retryMs: 0, ttfbMs: 3, wireMs: 200 },
    });

    const result = await runEval(
      { workflow: 'w', dataset: oneItemDataset(5), scorers: [passScorer], concurrency: 1 },
      async (input, rt) => {
        const ctx = rt.createContext();
        // Item q0 makes two A calls; every item makes one A and one B call.
        // Every A call has the same scripted timing, so the uneven fan-out shows
        // up in `calls` (6, not 5) while the distribution stays flat.
        await ctx.ask(agentA, 'one');
        if ((input as { q: string }).q === 'q0') await ctx.ask(agentA, 'two');
        await ctx.ask(agentB, 'three');
        return { output: 'out' };
      },
      runtime,
    );

    expect(result.summary.modelTiming).toEqual({
      [A]: {
        calls: 6,
        wireMs: { mean: 40, min: 40, max: 40, p50: 40, p95: 40 },
        queuedMs: { mean: 10, min: 10, max: 10, p50: 10, p95: 10 },
        // Retry time reaches the summary, so a model throttled on the day of the
        // run is visible instead of being invisibly folded away.
        retryMs: { mean: 60, min: 60, max: 60, p50: 60, p95: 60 },
        firstTokenMs: { mean: 25, min: 25, max: 25, p50: 25, p95: 25 },
        firstTokenCalls: 6,
      },
      [B]: {
        calls: 5,
        wireMs: { mean: 200, min: 200, max: 200, p50: 200, p95: 200 },
        queuedMs: { mean: 100, min: 100, max: 100, p50: 100, p95: 100 },
        retryMs: { mean: 0, min: 0, max: 0, p50: 0, p95: 0 },
      },
    });
    // B never streamed: absence, not a `0` that would look like an instant
    // first token in a model comparison.
    expect('firstTokenMs' in result.summary.modelTiming![B]).toBe(false);
    expect('firstTokenCalls' in result.summary.modelTiming![B]).toBe(false);

    // The wall-clock stats keep their old meaning: they are derived from
    // item.duration, which is far larger than any single call's wire time and
    // is not a per-model figure.
    expect(result.summary.timing).toBeDefined();
    expect(result.summary.timing).not.toEqual(result.summary.modelTiming?.[A].wireMs);
    const durations = result.items.map((i) => i.duration!);
    expect(result.summary.timing!.max).toBe(Math.max(...durations));
  });

  it('samples the distribution per call, not per item, under uneven fan-out', async () => {
    // The reviewer's worked example. Item q0 makes 1 call at 100ms; item q1
    // makes 9 calls at 1000ms. Per-ITEM sampling would average 100 and 1000 to
    // 550 and report a p50 of 550 — a figure no call achieved. Per-CALL sampling
    // gives 9100/10 = 910 with a p50 of 1000, because 9 of the 10 calls were
    // slow. This assertion is what pins the weighting.
    const runtime = new AxlRuntime({ defaultProvider: 'test' });
    let callIndex = 0;
    runtime.registerProvider('test', {
      name: 'test',
      chat: async () => {
        const wireMs = callIndex++ === 0 ? 100 : 1000;
        return {
          content: 'x',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          cost: 0,
          timing: { queuedMs: 0, attempts: 1, retryMs: 0, ttfbMs: 1, wireMs },
        };
      },
    } as never);

    const result = await runEval(
      { workflow: 'w', dataset: oneItemDataset(2), scorers: [passScorer], concurrency: 1 },
      async (input, rt) => {
        const ctx = rt.createContext();
        const asks = (input as { q: string }).q === 'q0' ? 1 : 9;
        for (let i = 0; i < asks; i++) await ctx.ask(agentA, `ask ${i}`);
        return { output: 'out' };
      },
      runtime,
    );

    const stats = result.summary.modelTiming![A];
    expect(stats.calls).toBe(10);
    expect(stats.wireMs.mean).toBe(910);
    expect(stats.wireMs.p50).toBe(1000);
    expect(stats.wireMs.min).toBe(100);
    expect(stats.wireMs.max).toBe(1000);
    // The per-item mean-of-means, which the old surface also reported. Nothing
    // on `modelTiming` may equal it any more.
    expect(stats.wireMs.mean).not.toBe(550);
    // The item keeps its compact sums, and carries no raw samples — those live
    // only in memory during the run.
    expect(result.items[1].timing![A]).toEqual({
      calls: 9,
      queuedMs: 0,
      retryMs: 0,
      wireMs: 9000,
    });
  });

  // E4 — the regression guard for the reversed plan §4.5 decision.
  it('populates item.timing on the plain path without touching cost, unpriced or metadata', async () => {
    const runtime = runtimeWith({
      [BARE_A]: { queuedMs: 10, attempts: 1, retryMs: 0, ttfbMs: 3, wireMs: 30 },
    });

    const run = (rt: AxlRuntimeType) =>
      runEval(
        { workflow: 'w', dataset: oneItemDataset(), scorers: [passScorer] },
        async (_input, r) => {
          const ctx = r.createContext();
          await ctx.ask(agentA, 'one');
          // A user-returned cost is authoritative on this path, and nothing
          // else may be filled in behind it.
          return { output: 'out', cost: 0.25 };
        },
        rt,
      );

    const result = await run(runtime);
    const item = result.items[0];

    expect(item.timing).toEqual({ [A]: { calls: 1, queuedMs: 10, retryMs: 0, wireMs: 30 } });
    // Pre-feature shape, pinned: user cost only, no tracked-cost fallback, no
    // runtime-derived metadata, no unpriced flag, no captured traces.
    expect(item.cost).toBe(0.25);
    expect(result.totalCost).toBeCloseTo(0.25);
    expect('unpriced' in item).toBe(false);
    expect('metadata' in item).toBe(false);
    expect('traces' in item).toBe(false);
    expect(result.metadata.models).toBeUndefined();
  });

  it('carries firstTokenMs and its own denominator onto item.timing', async () => {
    // A model that mixes a streamed call with a non-streamed one. `calls` is 2
    // but only one call reported a first token, so the two counters must not be
    // conflated — 25/2 would be a latency no call achieved.
    const runtime = new AxlRuntime({ defaultProvider: 'test' });
    let callIndex = 0;
    runtime.registerProvider('test', {
      name: 'test',
      chat: async () => ({
        content: 'x',
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: 0,
        timing:
          callIndex++ === 0
            ? { queuedMs: 0, attempts: 1, retryMs: 0, ttfbMs: 10, firstTokenMs: 25, wireMs: 60 }
            : { queuedMs: 0, attempts: 1, retryMs: 0, ttfbMs: 8, wireMs: 40 },
      }),
    } as never);

    const result = await runEval(
      { workflow: 'w', dataset: oneItemDataset(), scorers: [passScorer] },
      async (_input, rt) => {
        const ctx = rt.createContext();
        await ctx.ask(agentA, 'streamed');
        await ctx.ask(agentA, 'not streamed');
        return { output: 'out' };
      },
      runtime,
    );

    expect(result.items[0].timing).toEqual({
      [A]: { calls: 2, queuedMs: 0, retryMs: 0, wireMs: 100, firstTokenMs: 25, firstTokenCalls: 1 },
    });
    // The first-token distribution runs over the ONE streamed call, not over
    // both: entering the non-streamed call as a `0` would halve the mean and
    // report a min of 0.
    expect(result.summary.modelTiming![A].calls).toBe(2);
    expect(result.summary.modelTiming![A].firstTokenMs).toEqual({
      mean: 25,
      min: 25,
      max: 25,
      p50: 25,
      p95: 25,
    });
    expect(result.summary.modelTiming![A].firstTokenCalls).toBe(1);
    // `firstTokenCalls` is the only thing distinguishing this from a model
    // where every call streamed — a TimingStats carries no sample size.
    expect(result.summary.modelTiming![A].firstTokenCalls).not.toBe(
      result.summary.modelTiming![A].calls,
    );
  });

  it('leaves an errored item out of item.timing and out of the summary sample', async () => {
    const runtime = runtimeWith({
      [BARE_A]: { queuedMs: 10, attempts: 1, retryMs: 0, ttfbMs: 3, wireMs: 30 },
    });

    const result = await runEval(
      { workflow: 'w', dataset: oneItemDataset(2), scorers: [passScorer], concurrency: 1 },
      async (input, rt) => {
        const ctx = rt.createContext();
        await ctx.ask(agentA, 'one');
        // The second item throws AFTER a successful provider call.
        if ((input as { q: string }).q === 'q1') throw new Error('workflow blew up');
        return { output: 'out' };
      },
      runtime,
    );

    // The throw propagates out of the wrapped trackExecution, so there is no
    // aggregate to read — the same shape `cost` and `metadata` already had on
    // this path. The failed item must not contribute a partial sample.
    expect(result.items[1].error).toBe('workflow blew up');
    expect('timing' in result.items[1]).toBe(false);
    expect(result.items[0].timing).toEqual({
      [A]: { calls: 1, queuedMs: 10, retryMs: 0, wireMs: 30 },
    });
    expect(result.summary.modelTiming![A].calls).toBe(1);
  });

  it('does not let the plain path newly abort a budgeted run', async () => {
    const runtime = runtimeWith({
      [BARE_A]: { queuedMs: 10, attempts: 1, retryMs: 0, ttfbMs: 3, wireMs: 30 },
    });

    // Every real provider call costs money the runtime can see, but the plain
    // path deliberately ignores tracked cost — so a budget of $0.01 with no
    // user-returned cost must NOT trip, exactly as before the rollup.
    const result = await runEval(
      { workflow: 'w', dataset: oneItemDataset(3), scorers: [passScorer], budget: '$0.01' },
      async (_input, rt) => {
        const ctx = rt.createContext();
        await ctx.ask(agentA, 'one');
        return { output: 'out' };
      },
      runtime,
    );

    expect(result.items.every((i) => i.error === undefined)).toBe(true);
    expect(result.items.every((i) => i.timing !== undefined)).toBe(true);
  });

  // E5 — the highest-risk compatibility break.
  it('reports no timing and does not throw on a runtime without trackExecution', async () => {
    const duckTyped = {} as AxlRuntimeType;

    const result = await runEval(
      { workflow: 'w', dataset: oneItemDataset(2), scorers: [passScorer] },
      async () => ({ output: 'out', cost: 0.002, metadata: { note: 'mine' } }),
      duckTyped,
    );

    expect(result.summary.failures).toBe(0);
    expect(result.items.every((i) => i.scores.pass === 1)).toBe(true);
    for (const item of result.items) {
      expect('timing' in item).toBe(false);
      expect(item.cost).toBe(0.002);
      expect(item.metadata).toEqual({ note: 'mine' });
    }
    expect(result.summary.modelTiming).toBeUndefined();
  });

  // E6 — the rollup must not be wired only into the trace-capturing branch.
  it('produces the same item.timing under captureTraces, alongside traces', async () => {
    const script = {
      [BARE_A]: { queuedMs: 10, attempts: 1, retryMs: 50, ttfbMs: 3, wireMs: 30 },
      [BARE_B]: { queuedMs: 5, attempts: 1, retryMs: 0, ttfbMs: 2, wireMs: 70 },
    };
    const execute = async (_input: unknown, rt: AxlRuntimeType) => {
      const ctx = rt.createContext();
      await ctx.ask(agentA, 'one');
      await ctx.ask(agentA, 'two');
      await ctx.ask(agentB, 'three');
      return { output: 'out' };
    };
    const config = { workflow: 'w', dataset: oneItemDataset(), scorers: [passScorer] };

    const plain = await runEval(config, execute, runtimeWith(script));
    const traced = await runEval(config, execute, runtimeWith(script), { captureTraces: true });

    // Pinned to the literal, not just to each other — comparing the two paths
    // alone would pass with both of them empty.
    const expected = {
      [A]: { calls: 2, queuedMs: 20, retryMs: 100, wireMs: 60 },
      [B]: { calls: 1, queuedMs: 5, retryMs: 0, wireMs: 70 },
    };
    expect(plain.items[0].timing).toEqual(expected);
    expect(traced.items[0].timing).toEqual(expected);
    expect(traced.items[0].traces?.length).toBeGreaterThan(0);
    expect(plain.items[0].traces).toBeUndefined();
  });
});
