/**
 * What a closed budget means for the exit code, and how a denial is recognized
 * across a package boundary (review findings H1, H2, M1, L1, L4).
 *
 * The distinction these defend: "the budget closed" and "the budget refused
 * work" are different facts. Only the second makes a run incomplete, and only
 * the second may fail a build.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AxlError } from '@axlsdk/axl';

import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';
import { runEval } from '../runner.js';
import { rescore } from '../rescore.js';
import { scoreItem } from '../score-item.js';
import {
  isAdmissionDenied,
  isBudgetStopped,
  parseBudget,
  readAccounting,
  refusedWork,
} from '../accounting.js';
import { budgetStopMessage, isTotalWipeout } from '../cli-format.js';
import { scorerCounts } from '../utils.js';
import type { EvalCoverage, EvalItemOutcome, EvalResult, ScorerOutcome } from '../types.js';
import { askExecute, scriptedRuntime } from './accounting-helpers.js';

const pass = scorer({ name: 'pass', description: 'always 1', score: () => 1 });

function ds(n: number) {
  return dataset({
    name: `ds-${n}`,
    schema: z.object({ q: z.string() }),
    items: Array.from({ length: n }, (_, i) => ({ input: { q: `q${i}` } })),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// H1 — a closed budget is not, by itself, a stop
// ═══════════════════════════════════════════════════════════════════════════

describe('H1: a run that finished everything inside its budget is not a budget stop', () => {
  it('reports no stop when spend lands exactly on the limit with full coverage', async () => {
    // Setting `--budget` to a run's expected spend is the obvious way to use a
    // threshold in CI. The final settlement then closes the controller with
    // nothing left to admit — every case completed, every judge scored, nothing
    // refused. Failing that build (and printing "0 never started, 0 stopped
    // mid-flight, 2 completed … incomplete by design") is the defect this pins.
    const { runtime } = scriptedRuntime([{ cost: 0.5 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(2), scorers: [pass], budget: '$1', concurrency: 1 },
      askExecute(),
      runtime,
    );

    expect(result.accounting!.budget!.status).toBe('closed');
    expect(result.summary.coverage!.items).toMatchObject({
      completed: 2,
      budget_skipped: 0,
      budget_interrupted: 0,
    });

    expect(budgetStopMessage(result, 'evals/a.eval.ts')).toBeNull();
    expect(isTotalWipeout(result)).toBe(false);
  });

  it('still reports a stop when the budget actually refused a case', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.5 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(3), scorers: [pass], budget: '$1', concurrency: 1 },
      askExecute(),
      runtime,
    );

    expect(result.summary.coverage!.items.budget_skipped).toBe(1);
    expect(budgetStopMessage(result, 'evals/a.eval.ts')).toContain('BUDGET STOPPED');
  });

  it('reports a stop when only a JUDGE was refused, with every case completed', async () => {
    // The cases all finished; the budget closed on the first judge, so the
    // remaining judges never ran. Item coverage alone shows nothing wrong —
    // scorer coverage is the only evidence, and it must gate the exit too.
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    runtime.registerProvider('judgep', {
      name: 'judgep',
      chat: async () => ({
        content: JSON.stringify({ score: 1, reasoning: 'x' }),
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 2,
      }),
    } as never);
    const { llmScorer } = await import('../llm-scorer.js');
    const judge = llmScorer({
      name: 'judge',
      description: 'judge',
      model: 'judgep:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [judge, { ...judge, name: 'judge2' }] },
      askExecute(),
      runtime,
      undefined,
    );
    expect(result.items[0].outcome).toBe('completed');

    // A second run WITH a budget: same shape, but the second judge is refused.
    const { runtime: budgeted } = scriptedRuntime([{ cost: 0 }]);
    budgeted.registerProvider('judgep', {
      name: 'judgep',
      chat: async () => ({
        content: JSON.stringify({ score: 1, reasoning: 'x' }),
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 2,
      }),
    } as never);
    const stopped = await runEval(
      {
        workflow: 'w',
        dataset: ds(1),
        scorers: [judge, { ...judge, name: 'judge2' }],
        budget: '$1',
        scorerConcurrency: 1,
      },
      askExecute(),
      budgeted,
    );

    expect(stopped.summary.coverage!.items).toMatchObject({
      completed: 1,
      budget_skipped: 0,
      budget_interrupted: 0,
    });
    expect(stopped.summary.coverage!.scorers.judge2.budget_skipped).toBe(1);
    expect(budgetStopMessage(stopped, 'evals/a.eval.ts')).toContain('BUDGET STOPPED');
  });

  it('reports no stop for a run with no budget at all', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.5 }]);
    const result = await runEval(
      { workflow: 'w', dataset: ds(2), scorers: [pass] },
      askExecute(),
      runtime,
    );
    expect(budgetStopMessage(result, 'evals/a.eval.ts')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H2 — a denial is recognized by contract, not by class identity
// ═══════════════════════════════════════════════════════════════════════════

describe('H2: a denial from a second copy of the core is still a budget stop', () => {
  /**
   * A structurally-identical denial that shares NO class with this module —
   * exactly what a CJS consumer gets when its runtime comes from the CJS core
   * and the eval package loads the ESM one through a dynamic import.
   */
  function foreignDenial(): Error {
    const err = new Error('Budget exhausted') as Error & { code: string };
    err.name = 'AdmissionDeniedError';
    err.code = 'ADMISSION_DENIED';
    return err;
  }

  it('recognizes a foreign denial and rejects look-alikes', () => {
    expect(isAdmissionDenied(foreignDenial())).toBe(true);
    // A plain object across a serialization boundary still reads correctly.
    expect(isAdmissionDenied({ code: 'ADMISSION_DENIED', name: 'AdmissionDeniedError' })).toBe(
      true,
    );

    // Everything else is NOT a denial — misclassifying here would hide a real
    // defect behind "the budget stopped it".
    expect(isAdmissionDenied(new Error('boom'))).toBe(false);
    expect(isAdmissionDenied({ code: 'ADMISSION_DENIED' })).toBe(false);
    expect(isAdmissionDenied({ name: 'AdmissionDeniedError' })).toBe(false);
    expect(isAdmissionDenied({ code: 'INVALID_BUDGET', name: 'AxlError' })).toBe(false);
    expect(isAdmissionDenied(null)).toBe(false);
    expect(isAdmissionDenied('ADMISSION_DENIED')).toBe(false);
    expect(isAdmissionDenied(undefined)).toBe(false);
  });

  it('classifies a case that threw a foreign denial as budget_interrupted, not failed', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.25 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] },
      async (_input, rt) => {
        const { fixtureAgent } = await import('./accounting-helpers.js');
        await rt.createContext().ask(fixtureAgent, 'go');
        throw foreignDenial();
      },
      runtime,
    );

    expect(result.items[0].outcome).toBe('budget_interrupted');
    expect(result.items[0].error).toBe('Budget interrupted');
    expect(result.summary.coverage!.items.failed).toBe(0);
    // The charge incurred before the refusal is still accounted.
    expect(result.accounting!.knownCost).toBeCloseTo(0.25, 10);
  });

  it('classifies a SCORER that threw a foreign denial as budget_interrupted', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    const denying = scorer({
      name: 'denied',
      description: 'refused by the budget',
      score: () => {
        throw foreignDenial();
      },
    });

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [denying] },
      askExecute(),
      runtime,
    );

    const detail = result.items[0].scoreDetails!.denied;
    expect(detail.outcome).toBe('budget_interrupted');
    // A budget stop is not a scorer defect, so it is outside the failure rate.
    expect(result.summary.scorers.denied.failed).toBe(0);
    expect(result.items[0].scorerErrors).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L1 — one bad item is one scorer failure, not a lost run
// ═══════════════════════════════════════════════════════════════════════════

describe('L1: a throw while reporting a scorer result cannot destroy the run', () => {
  it('records a scorer failure when the input cannot be serialized', async () => {
    // The scorer returns an out-of-range score, whose message serializes the
    // input — and the input is circular. Unguarded, that TypeError escapes the
    // concurrency pool, the item scope and the run scope, and `runEval` throws
    // away every result it had already computed.
    const circular: Record<string, unknown> = { q: 'a' };
    circular.self = circular;

    const item = {
      input: circular,
      output: 'out',
      scores: {} as Record<string, number | null>,
    };
    const outOfRange = scorer({
      name: 'wild',
      description: 'returns 7',
      score: () => 7,
    });

    await expect(
      scoreItem(item, [outOfRange], {
        runtime: {} as never,
        scorerContext: {} as never,
        scorerConcurrency: 1,
      }),
    ).resolves.toBeUndefined();

    // Pre-seeded null, never a score.
    expect(item.scores.wild).toBeNull();
    expect(item.scoreDetails!.wild.outcome).toBe('failed');
    expect(item.scorerErrors).toHaveLength(1);
    // The message still names the real problem — the score, not the serializer.
    expect(item.scorerErrors![0]).toContain('out-of-range score 7');
    expect(item.scorerErrors![0]).toContain('[unserializable input]');
  });

  it('keeps the rest of the run when one item cannot be serialized', async () => {
    const circular: Record<string, unknown> = { q: 'q1' };
    circular.self = circular;
    const mixed = dataset({
      name: 'mixed',
      schema: z.any(),
      items: [{ input: { q: 'q0' } }, { input: circular }],
    });
    const outOfRange = scorer({ name: 'wild', description: 'returns 7', score: () => 7 });
    const { runtime } = scriptedRuntime([{ cost: 0.1 }]);

    const result = await runEval(
      { workflow: 'w', dataset: mixed, scorers: [outOfRange] },
      askExecute(),
      runtime,
    );

    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.outcome === 'completed')).toBe(true);
    expect(result.summary.scorers.wild.failed).toBe(2);
    expect(result.accounting!.knownCost).toBeCloseTo(0.2, 10);
  });

  it('truncates a very long input in the message rather than persisting it whole', async () => {
    const item = {
      input: { q: 'x'.repeat(5000) },
      output: 'out',
      scores: {} as Record<string, number | null>,
    };
    await scoreItem(item, [scorer({ name: 'wild', description: 'r', score: () => 7 })], {
      runtime: {} as never,
      scorerContext: {} as never,
      scorerConcurrency: 1,
    });

    expect(item.scorerErrors![0].length).toBeLessThan(400);
    expect(item.scorerErrors![0]).toContain('…');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L4 — a rescore chain keeps pointing at the original generation
// ═══════════════════════════════════════════════════════════════════════════

describe('L4: rescoring a rescore still names the ORIGINAL generation spend', () => {
  it('reaches past the intermediate rescore rather than storing judging as generation', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.5 }]);
    const original = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] },
      askExecute(),
      runtime,
    );
    expect(original.accounting!.knownCost).toBeCloseTo(0.5, 10);

    const first = await rescore(original, [pass], runtime);
    expect(first.accounting!.scope).toBe('rescore');
    expect(first.accounting!.source).toEqual({
      runId: original.id,
      generation: original.accounting,
    });

    const second = await rescore(first, [pass], runtime);

    // `runId` follows the chain one link, but `generation` skips back to the
    // only record that actually describes generation spend. Storing `first`'s
    // judging-only accounting here would let a reader add it to the new total
    // and believe they had recovered total spend.
    expect(second.accounting!.source!.runId).toBe(first.id);
    expect(second.accounting!.source!.generation).toEqual(original.accounting);
    expect(second.accounting!.source!.generation!.scope).toBe('run');
  });

  it('keeps a legacy origin unknown through the whole chain', async () => {
    const legacy: EvalResult = {
      id: 'legacy',
      dataset: 'ds-1',
      metadata: {},
      timestamp: '',
      totalCost: 3,
      duration: 0,
      items: [{ input: { q: 'a' }, output: 'out', scores: { pass: 1 } }],
      summary: { count: 1, failures: 0, scorers: {} },
    };
    const { runtime } = scriptedRuntime([{ cost: 0 }]);

    const first = await rescore(legacy, [pass], runtime);
    expect(first.accounting!.source!.generation).toBeNull();

    const second = await rescore(first, [pass], runtime);
    // Still null — an unknown origin is never upgraded by being rescored again.
    expect(second.accounting!.source!.generation).toBeNull();
    expect(readAccounting(second).completeness).not.toBe('unverified');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseBudget — the unit the CLI and both runners share
// ═══════════════════════════════════════════════════════════════════════════

describe('parseBudget()', () => {
  it.each([
    ['$1', 1],
    ['1', 1],
    ['$0.50', 0.5],
    ['0.50', 0.5],
    ['$10.00', 10],
    ['0', 0],
    ['$0', 0],
    ['12.345', 12.345],
  ])('parses %p as %p', (input, expected) => {
    expect(parseBudget(input)).toBe(expected);
  });

  it.each([
    ['-1'],
    ['$-1'],
    ['abc'],
    ['$'],
    [''],
    ['1.2.3'],
    ['Infinity'],
    ['$1,000'],
    ['1 USD'],
    [' $1'],
    ['$1 '],
    ['1e3'],
    [null],
    [undefined],
    [{ limit: 1 }],
    [5],
  ])('rejects %p with INVALID_BUDGET', (input) => {
    // `parseFloat` would have accepted most of these — `parseFloat('$1.2.3')`
    // is 1.2 and `parseFloat('1 USD')` is 1 — silently running with a limit the
    // user never wrote. A budget typo must fail loudly, not approximately.
    expect(() => parseBudget(input as string)).toThrow(AxlError);
    try {
      parseBudget(input as string);
    } catch (err) {
      expect((err as AxlError).code).toBe('INVALID_BUDGET');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F5 — one classifier for scorer outcomes
// ═══════════════════════════════════════════════════════════════════════════

describe('scorerCounts() reads the authoritative outcome', () => {
  const items = [
    { scores: { s: 1 }, scoreDetails: { s: { score: 1, outcome: 'scored', duration: 5 } } },
    { scores: { s: null }, scoreDetails: { s: { score: null, outcome: 'failed', duration: 5 } } },
    {
      scores: { s: null },
      scoreDetails: { s: { score: null, outcome: 'skipped', skipped: true } },
    },
    // A judge the budget stopped MID-FLIGHT: it ran, so it has a duration. The
    // old duration heuristic would have counted this as a scorer failure and
    // tripped the degradation gate on a run with no scorer defect.
    {
      scores: { s: null },
      scoreDetails: { s: { score: null, outcome: 'budget_interrupted', duration: 12 } },
    },
    { scores: { s: null }, scoreDetails: { s: { score: null, outcome: 'budget_skipped' } } },
    {
      scores: { s: null },
      scoreDetails: { s: { score: null, outcome: 'cancelled', duration: 3 } },
    },
  ];

  it('excludes budget stops and cancellations from the sample', () => {
    expect(scorerCounts(items, 's')).toEqual({ scored: 1, failed: 1, skipped: 1 });
  });

  it('falls back to the duration heuristic only for a pre-0.24 artifact', () => {
    const legacy = [
      { scores: { s: 1 }, scoreDetails: { s: { score: 1, duration: 5 } } },
      { scores: { s: null }, scoreDetails: { s: { score: null, duration: 5 } } },
      { scores: { s: null }, scoreDetails: { s: { score: null, skipped: true } } },
      { scores: { s: null }, scoreDetails: { s: { score: null } } },
    ];
    expect(scorerCounts(legacy, 's')).toEqual({ scored: 1, failed: 1, skipped: 1 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The "budget stopped" predicate the CLI and Studio both read
// ═══════════════════════════════════════════════════════════════════════════

function coverage(over: {
  items?: Partial<Record<EvalItemOutcome, number>>;
  scorers?: Record<string, Partial<Record<ScorerOutcome, number>>>;
}): EvalCoverage {
  const items: Record<EvalItemOutcome, number> = {
    completed: 0,
    failed: 0,
    cancelled: 0,
    budget_skipped: 0,
    budget_interrupted: 0,
    ...over.items,
  };
  const scorers: Record<string, Record<ScorerOutcome, number>> = {};
  for (const [name, counts] of Object.entries(over.scorers ?? {})) {
    scorers[name] = {
      scored: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      budget_skipped: 0,
      budget_interrupted: 0,
      ...counts,
    };
  }
  return { items, scorers };
}

describe('refusedWork() / isBudgetStopped()', () => {
  it('counts nothing refused for a clean run', () => {
    expect(refusedWork(coverage({ items: { completed: 3 }, scorers: { j: { scored: 3 } } }))).toBe(
      0,
    );
  });

  it('counts refused cases and refused judges together', () => {
    const c = coverage({
      items: { completed: 1, budget_skipped: 1, budget_interrupted: 1 },
      scorers: { j: { scored: 1, budget_skipped: 2, budget_interrupted: 1 } },
    });
    expect(refusedWork(c)).toBe(5);
  });

  it('reads a pre-0.24 artifact with no coverage as refusing nothing', () => {
    // An artifact that never recorded outcomes cannot be used to ASSERT that
    // work was refused. Guessing "stopped" from an absent block would put a
    // truncation badge on every legacy run.
    expect(refusedWork(undefined)).toBe(0);
    expect(isBudgetStopped({ budget: { status: 'closed' }, coverage: undefined })).toBe(false);
  });

  it('is false for a closed controller that refused nothing', () => {
    // The `--budget $expected` CI threshold case: the last settlement lands
    // exactly on the limit and closes the controller with the work done.
    expect(
      isBudgetStopped({
        budget: { status: 'closed' },
        coverage: coverage({ items: { completed: 2 }, scorers: { j: { scored: 2 } } }),
      }),
    ).toBe(false);
  });

  it('is true only once the closed controller actually refused something', () => {
    expect(
      isBudgetStopped({
        budget: { status: 'closed' },
        coverage: coverage({ items: { completed: 1, budget_skipped: 1 } }),
      }),
    ).toBe(true);
    // A refused JUDGE with every case completed still counts.
    expect(
      isBudgetStopped({
        budget: { status: 'closed' },
        coverage: coverage({ items: { completed: 2 }, scorers: { j: { budget_skipped: 2 } } }),
      }),
    ).toBe(true);
  });

  it('tolerates a malformed coverage block instead of throwing in a renderer', () => {
    // Studio ingests imported CLI artifacts and hand-edited files, and the
    // browser mirror of this function runs inside a render with no schema in
    // front of it. A missing `scorers` key used to throw
    // `Cannot convert undefined or null to object` and blank the panel.
    expect(
      refusedWork({ items: coverage({ items: { budget_skipped: 2 } }).items } as EvalCoverage),
    ).toBe(2);
    expect(
      refusedWork({
        scorers: coverage({ scorers: { j: { budget_skipped: 2 } } }).scorers,
      } as EvalCoverage),
    ).toBe(2);
    expect(refusedWork({} as EvalCoverage)).toBe(0);
  });

  it('clamps a negative count at 0 rather than cancelling out a real refusal', () => {
    // `-2 + 1 = -1` reads as "nothing refused" while the same artifact reads as
    // stopped through the Studio server reducer, which has always clamped.
    const c = coverage({ items: { budget_skipped: -2, budget_interrupted: 1 } });
    expect(refusedWork(c)).toBe(1);
    expect(isBudgetStopped({ budget: { status: 'closed' }, coverage: c })).toBe(true);
  });

  it('is false while the budget is still open, and with no budget at all', () => {
    const c = coverage({ items: { completed: 1, budget_skipped: 1 } });
    expect(isBudgetStopped({ budget: { status: 'open' }, coverage: c })).toBe(false);
    expect(isBudgetStopped({ budget: undefined, coverage: c })).toBe(false);
  });
});
