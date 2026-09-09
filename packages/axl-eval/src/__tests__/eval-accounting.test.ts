/**
 * Eval accounting invariants (matrix A1–A4, A16 public-surface rows).
 *
 * Every case here drives a PUBLIC entry point (`runEval`, `readAccounting`,
 * `aggregateAccounting`) against a real `AxlRuntime`. The one thing they all
 * defend is that `EvalResult.totalCost` answers "what did this run spend?" from
 * measurement, identically whether the run succeeded, failed, or was traced.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AxlRuntime, externalOperation } from '@axlsdk/axl';
import type { AxlRuntime as AxlRuntimeType } from '@axlsdk/axl';

import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';
import { llmScorer } from '../llm-scorer.js';
import { runEval } from '../runner.js';
import { aggregateAccounting, readAccounting } from '../accounting.js';
import type { EvalConfig, EvalResult } from '../types.js';
import { askExecute, fixtureAgent, scriptedRuntime } from './accounting-helpers.js';

const pass = scorer({ name: 'pass', description: 'always 1', score: () => 1 });

function ds(n: number) {
  return dataset({
    name: `ds-${n}`,
    schema: z.object({ q: z.string() }),
    items: Array.from({ length: n }, (_, i) => ({ input: { q: `q${i}` } })),
  });
}

/** A judge whose provider is registered separately so judging is isolable. */
function judgeOn(runtime: AxlRuntimeType, cost: number | undefined, name = 'judge') {
  runtime.registerProvider('judgep', {
    name: 'judgep',
    chat: async () => ({
      content: JSON.stringify({ score: 0.5, reasoning: 'x' }),
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      ...(cost === undefined ? {} : { cost }),
    }),
  } as never);
  return llmScorer({
    name,
    description: 'judge',
    model: 'judgep:model',
    system: 'Rate it',
    schema: z.object({ score: z.number(), reasoning: z.string() }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// A1 — one authoritative path, independent of diagnostics
// ═══════════════════════════════════════════════════════════════════════════

describe('A1: the run total is measured, whatever the case did', () => {
  // A1.8
  it('keeps the charge from a case that threw after its paid call', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.75 }]);
    const result = await runEval(
      { workflow: 'w', dataset: ds(2), scorers: [pass] } satisfies EvalConfig,
      askExecute({
        afterAsks: (input) => {
          if ((input as { q: string }).q === 'q1') throw new Error('after the money was spent');
        },
      }),
      runtime,
    );

    expect(result.totalCost).toBeCloseTo(1.5, 10);
    expect(result.accounting!.knownCost).toBeCloseTo(1.5, 10);
    expect(result.items[1].outcome).toBe('failed');
    expect(result.items[1].error).toBe('after the money was spent');
    // The defect this replaces: a failed case used to contribute $0.
    expect(result.items[1].accounting!.breakdown.generation).toBeCloseTo(0.75, 10);
    expect(result.items[1].cost).toBeCloseTo(0.75, 10);
  });

  // A1.9
  it('reports the same accounting across every trace / capture configuration', async () => {
    const variants: {
      trace: ConstructorParameters<typeof AxlRuntime>[0]['trace'];
      captureTraces: boolean;
    }[] = [
      { trace: { enabled: false }, captureTraces: false },
      { trace: { enabled: false }, captureTraces: true },
      { trace: { level: 'full' }, captureTraces: false },
      { trace: { level: 'full' }, captureTraces: true },
      { trace: { level: 'full', redact: true }, captureTraces: false },
      { trace: { level: 'full', redact: true }, captureTraces: true },
      { trace: { level: 'steps' }, captureTraces: false },
      { trace: { level: 'steps' }, captureTraces: true },
    ];

    const accountings: string[] = [];
    for (const variant of variants) {
      const runtime = new AxlRuntime({ defaultProvider: 'mock', trace: variant.trace });
      runtime.registerProvider('mock', {
        name: 'mock',
        chat: async () => ({
          content: 'ok',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          cost: 0.75,
        }),
      } as never);

      const result = await runEval(
        { workflow: 'w', dataset: ds(2), scorers: [pass] },
        askExecute({
          afterAsks: (input) => {
            if ((input as { q: string }).q === 'q1') throw new Error('boom');
          },
        }),
        runtime,
        { captureTraces: variant.captureTraces },
      );
      expect(result.totalCost).toBeCloseTo(1.5, 10);
      accountings.push(JSON.stringify(result.accounting));
    }

    // Byte-identical, not merely equal totals: diagnostics change diagnostics.
    expect(new Set(accountings).size).toBe(1);
  });

  // A1.10
  it('splits generation from judging, per run and per scorer', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.75 }]);
    const judge = judgeOn(runtime, 0.2, 'exact');

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [judge] },
      askExecute(),
      runtime,
    );

    expect(result.accounting!.breakdown).toEqual({
      generation: 0.75,
      judging: 0.2,
      external: 0,
    });
    expect(result.accounting!.knownCost).toBeCloseTo(0.95, 10);
    expect(result.items[0].cost).toBeCloseTo(0.75, 10);
    expect(result.items[0].scorerCost).toBeCloseTo(0.2, 10);
    expect(result.items[0].scoreDetails!.exact.accounting!.knownCost).toBeCloseTo(0.2, 10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A2 — folding once, and isolation between concurrent runs
// ═══════════════════════════════════════════════════════════════════════════

describe('A2: each charge is counted once, in exactly one run', () => {
  // A2.12
  it('counts every turn of a multi-turn case, not just the last', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.3 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] },
      askExecute({ askCount: 2 }),
      runtime,
    );

    expect(result.items[0].accounting!.breakdown.generation).toBeCloseTo(0.6, 10);
    expect(result.items[0].cost).toBeCloseTo(0.6, 10);
    expect(result.totalCost).toBeCloseTo(0.6, 10);
  });

  // A2.11
  it('isolates two concurrent runs sharing one runtime, budgets included', async () => {
    // Both runs are driven through the SAME runtime while both are mid-flight:
    // every call parks until the test releases it, so the two runs' second
    // items are dispatched simultaneously.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatched = 0;
    let resolveBothDispatched!: () => void;
    const bothDispatched = new Promise<void>((resolve) => {
      resolveBothDispatched = resolve;
    });

    const runtime = new AxlRuntime({ defaultProvider: 'mock', trace: { enabled: false } });
    runtime.registerProvider('mock', {
      name: 'mock',
      chat: async () => {
        if (++dispatched === 4) resolveBothDispatched();
        if (dispatched > 2) await gate;
        return {
          content: 'ok',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          cost: 0.75,
        };
      },
    } as never);

    const runA = runEval(
      { workflow: 'a', dataset: ds(3), scorers: [pass], budget: '$1', concurrency: 2 },
      askExecute(),
      runtime,
    );
    const runB = runEval(
      { workflow: 'b', dataset: ds(3), scorers: [pass], budget: '$10', concurrency: 2 },
      askExecute(),
      runtime,
    );
    await bothDispatched;
    release();
    const [a, b] = await Promise.all([runA, runB]);

    // A closed on its own $1; B never saw a cent of A's spend.
    expect(a.accounting!.budget!.status).toBe('closed');
    expect(b.accounting!.budget!.status).toBe('open');
    expect(b.items.some((i) => i.outcome === 'budget_skipped')).toBe(false);
    expect(b.accounting!.knownCost).toBeCloseTo(2.25, 10);
    expect(a.accounting!.knownCost).toBeCloseTo(1.5, 10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A3 — zero vs unknown vs uninstrumented
// ═══════════════════════════════════════════════════════════════════════════

describe('A3: unknown spend is reported as unknown, never as zero', () => {
  // A3.12
  it('marks a run whose generation model has no usable price', async () => {
    const { runtime } = scriptedRuntime([{}]); // usage, but no `cost` field

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] },
      askExecute(),
      runtime,
      { captureTraces: false },
    );

    expect(result.unpriced).toBe(true);
    expect(result.accounting!.completeness).toBe('incomplete');
    expect(result.accounting!.reasons.unpriced_model).toBeGreaterThanOrEqual(1);
  });

  // A3.13
  it('marks an unpriced JUDGE at the run level and on the scorer', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    const judge = judgeOn(runtime, undefined, 'unpricedJudge');

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [judge] },
      askExecute(),
      runtime,
    );

    expect(result.accounting!.completeness).toBe('incomplete');
    const detail = result.items[0].scoreDetails!.unpricedJudge;
    expect(detail.accounting!.reasons.unpriced_model).toBe(1);
    // It still SCORED — an unknown price is not a scoring failure.
    expect(detail.outcome).toBe('scored');
  });

  // A3.14
  it('keeps a judge cost when the judge output fails to parse', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    runtime.registerProvider('judgep', {
      name: 'judgep',
      chat: async () => ({
        content: 'not json at all',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 0.2,
      }),
    } as never);
    const judge = llmScorer({
      name: 'broken',
      description: 'judge',
      model: 'judgep:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [judge] },
      askExecute(),
      runtime,
    );

    expect(result.items[0].scoreDetails!.broken.outcome).toBe('failed');
    expect(result.items[0].scoreDetails!.broken.accounting!.knownCost).toBeCloseTo(0.2, 10);
    expect(result.accounting!.knownCost).toBeCloseTo(0.2, 10);
  });

  // A3.15
  it('reports an uninstrumented runtime as incomplete, not as free', async () => {
    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] },
      async () => ({ output: 'out', cost: 0.42 }),
      {} as AxlRuntimeType,
    );

    expect(result.accounting!.completeness).toBe('incomplete');
    expect(result.accounting!.reasons.uninstrumented).toBe(1);
    expect(result.accounting!.knownCost).toBe(0);
    expect(result.totalCost).toBe(0);
    // The caller's number survives ONLY as a caller report.
    expect(result.items[0].callerReport).toEqual({ cost: 0.42 });
    expect(result.items[0].cost).toBe(0);
  });

  /**
   * Pin the fixture assumption the rest of the eval suite rests on.
   *
   * `axl-eval` has no dependency on `@axlsdk/testing`, so every instrumented
   * eval test runs against a hand-written adapter. What makes those runs come
   * out `complete` is that the adapter reports a usable cost — the same reason
   * `MockProvider`-backed runs elsewhere do. If a fixture (or MockProvider,
   * where a consumer uses one) ever stops reporting cost, every eval silently
   * flips to `incomplete`, so assert the three adapter shapes and their
   * accounting consequences explicitly rather than inheriting them.
   */
  it('pins how an adapter reporting cost / usage-only / nothing is accounted', async () => {
    // A reported cost of `0` is KNOWN-free, not unknown → complete.
    const { runtime: free } = scriptedRuntime([{ cost: 0 }]);
    const viaZero = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] },
      askExecute(),
      free,
    );
    expect(viaZero.accounting!.completeness).toBe('complete');
    expect(viaZero.accounting!.knownCost).toBe(0);
    expect(viaZero.unpriced).toBeUndefined();

    // Usage but NO cost → unpriced_model.
    const { runtime: unpriced } = scriptedRuntime([{}]);
    const viaUsageOnly = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] },
      askExecute(),
      unpriced,
    );
    expect(viaUsageOnly.accounting!.reasons.unpriced_model).toBe(1);

    // Neither usage nor cost → usage_missing (the call was dispatched, so we
    // cannot conclude it was free).
    const { runtime: silent } = scriptedRuntime([{ usage: null }]);
    const viaSilence = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] },
      askExecute(),
      silent,
    );
    expect(viaSilence.accounting!.completeness).toBe('incomplete');
    expect(viaSilence.accounting!.reasons.usage_missing).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A4 — caller reports are additive, never replacements
// ═══════════════════════════════════════════════════════════════════════════

describe('A4: what the callback claims never becomes what the run spent', () => {
  // A4.9
  it('keeps the measured cost when the caller reports $0', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.75 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] },
      askExecute({ callerCost: 0 }),
      runtime,
    );

    expect(result.items[0].cost).toBeCloseTo(0.75, 10);
    expect(result.items[0].callerReport!.cost).toBe(0);
    expect(result.accounting!.knownCost).toBeCloseTo(0.75, 10);
    expect(result.accounting!.callerReported).toEqual({
      costItems: 1,
      costTotal: 0,
      metadataItems: 0,
    });
  });

  // A4.11
  it('never lets a caller aggregate inflate the total', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.75 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] },
      askExecute({ callerCost: 0.95 }),
      runtime,
    );

    // Neither 1.70 (summed) nor 0.95 (replaced).
    expect(result.accounting!.knownCost).toBeCloseTo(0.75, 10);
    expect(result.totalCost).toBeCloseTo(0.75, 10);
    expect(result.accounting!.callerReported!.costTotal).toBeCloseTo(0.95, 10);
  });

  // A4.12
  it.each([['free'], [Number.NaN], [-1], [Number.POSITIVE_INFINITY]])(
    'ignores an invalid caller cost (%p) without poisoning the total',
    async (callerCost) => {
      const { runtime } = scriptedRuntime([{ cost: 0.75 }]);

      const result = await runEval(
        { workflow: 'w', dataset: ds(1), scorers: [pass] },
        async (_input, rt) => {
          const ctx = rt.createContext();
          await ctx.ask(fixtureAgent, 'go');
          return { output: 'out', cost: callerCost as number };
        },
        runtime,
      );

      expect(result.accounting!.knownCost).toBeCloseTo(0.75, 10);
      expect(Number.isFinite(result.totalCost)).toBe(true);
      expect(result.items[0].callerReport?.cost).toBeUndefined();
    },
  );

  // A4.13
  it('shows a custom scorer cost only when nothing was measured for it', async () => {
    const claiming = scorer({
      name: 'x',
      description: 'claims a cost',
      score: () => ({ score: 1, cost: 0.5 }),
    });

    // (a) with a measured judge alongside: the measurement wins for that judge,
    // and the claim never enters the run total.
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    const judge = judgeOn(runtime, 0.2, 'judge');
    const measured = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [judge, claiming] },
      askExecute(),
      runtime,
    );
    expect(measured.items[0].scoreDetails!.judge.cost).toBeCloseTo(0.2, 10);
    // The claiming scorer made no operation on an instrumented runtime, so no
    // cost is asserted for it at all — a claim is not a measurement.
    expect(measured.items[0].scoreDetails!.x.cost).toBeUndefined();
    expect(measured.accounting!.knownCost).toBeCloseTo(0.2, 10);

    // (b) with no measurement rail at all, the claim is the only thing we have.
    const legacy = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [claiming] },
      async () => ({ output: 'out' }),
      {} as AxlRuntimeType,
    );
    expect(legacy.items[0].scoreDetails!.x.cost).toBe(0.5);
    expect(legacy.accounting!.knownCost).toBe(0);
  });

  // A4.14
  it('classifies declared external judging spend as external, once', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    const external = scorer({
      name: 'ext',
      description: 'calls a third-party grader',
      score: () => 1,
    });
    // `externalOperation` is the supported way to declare spend Axl cannot see.
    const declaring = {
      ...external,
      score: async () =>
        externalOperation({ name: 'third-party-grader' }, async (report) => {
          report.setCost(0.1);
          return 1;
        }),
    };

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [declaring] },
      askExecute(),
      runtime,
    );

    expect(result.accounting!.breakdown.judging).toBe(0);
    expect(result.accounting!.breakdown.external).toBeCloseTo(0.1, 10);
    expect(result.accounting!.knownCost).toBeCloseTo(0.1, 10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A13.5–A13.7 / A16.12 — reading, aggregating and serializing
// ═══════════════════════════════════════════════════════════════════════════

describe('reading accounting off an artifact', () => {
  // A13.5
  it('reads a pre-0.24 artifact as unverified, never as complete', async () => {
    const legacy = {
      id: 'old',
      dataset: 'ds',
      metadata: {},
      timestamp: '',
      totalCost: 3,
      duration: 0,
      items: [],
      summary: { count: 0, failures: 0, scorers: {} },
    } satisfies EvalResult;

    const accounting = readAccounting(legacy);
    expect(accounting.completeness).toBe('unverified');
    expect(accounting.knownCost).toBe(3);
    expect(accounting.operations.total).toBe(0);
  });

  // A13.6
  it('returns a real record unchanged', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.25 }]);
    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] },
      askExecute(),
      runtime,
    );

    expect(readAccounting(result)).toBe(result.accounting);
    expect(readAccounting(result).completeness).toBe('complete');
  });

  // A13.7 / A16.12
  it('survives a JSON round trip without upgrading completeness or leaking prompts', async () => {
    const { runtime } = scriptedRuntime([{}]);
    const result = await runEval(
      { workflow: 'w', dataset: ds(2), scorers: [pass], budget: '$5' },
      askExecute(),
      runtime,
    );

    const roundTripped = JSON.parse(JSON.stringify(result)) as EvalResult;
    expect(roundTripped.accounting).toEqual(result.accounting);
    expect(roundTripped.accounting!.completeness).toBe('incomplete');
    expect(roundTripped.accounting!.budget).toEqual(result.accounting!.budget);
    expect(roundTripped.items[0].outcome).toBe('completed');
    expect(roundTripped.items[0].scoreDetails!.pass.outcome).toBe('scored');
    expect(roundTripped.summary.coverage).toEqual(result.summary.coverage);

    // Capture stays opt-in: no traces, no diagnostics, no message snapshots.
    const serialized = JSON.stringify(roundTripped);
    expect(serialized).not.toContain('"traces"');
    expect(serialized).not.toContain('"diagnostics"');
    expect(serialized).not.toContain('"messages"');
  });

  // A14.1 / A14.2
  it("takes the worst completeness of a group, not the first run's", async () => {
    const complete = {
      ...readAccounting({ totalCost: 1 } as EvalResult),
      completeness: 'complete' as const,
    };
    const incomplete = {
      ...complete,
      knownCost: 2,
      completeness: 'incomplete' as const,
      reasons: { unpriced_model: 2 },
    };
    const unverified = { ...complete, knownCost: 4, completeness: 'unverified' as const };

    const mixed = aggregateAccounting([complete, incomplete]);
    expect(mixed.completeness).toBe('incomplete');
    expect(mixed.knownCost).toBe(3);
    expect(mixed.reasons).toEqual({ unpriced_model: 2 });

    // `unverified` dominates: a group containing an unmeasured run is unmeasured.
    expect(aggregateAccounting([complete, incomplete, unverified]).completeness).toBe('unverified');
  });
});
