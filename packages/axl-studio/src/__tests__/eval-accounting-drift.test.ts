/**
 * G2 — the Studio readers may not drift from `@axlsdk/eval`.
 *
 * Studio reads eval accounting three times over: the eval package owns the
 * rules, the Studio SERVER reducer re-derives them from a raw persisted blob
 * (it cannot import the package — `@axlsdk/eval` is an OPTIONAL peer
 * dependency and the reducer runs on every server start), and the Studio
 * BROWSER mirror re-implements them again because the eval package pulls in
 * `@axlsdk/axl` and `node:` builtins.
 *
 * Prose alone did not hold that together: the "budget stopped" rule moved in
 * the eval package and Studio kept the old one for three commits, putting a
 * "this run covers less than the whole dataset" banner on runs that covered
 * all of it. This file runs every implementation over ONE fixture table and
 * asserts they agree, so the next divergence fails a test instead of shipping.
 *
 * The mirror may not add behaviour the eval package lacks; where it has extra
 * helpers (render strings, item/scorer readers) they are out of scope here.
 */
import { describe, it, expect } from 'vitest';

import {
  aggregateAccounting as evalAggregate,
  isBudgetStopped as evalIsBudgetStopped,
  readAccounting as evalReadAccounting,
  refusedWork as evalRefusedWork,
} from '@axlsdk/eval';
import type { EvalCoverage, EvalResult } from '@axlsdk/eval';
import type { Accounting, EvalHistoryEntry } from '@axlsdk/axl';

import {
  aggregateAccounting as mirrorAggregate,
  isBudgetStopped as mirrorIsBudgetStopped,
  readAccounting as mirrorReadAccounting,
  refusedWork as mirrorRefusedWork,
} from '../client/panels/eval-runner/accounting.js';
import type { EvalResultData } from '../client/panels/eval-runner/types.js';
import { emptyEvalTrendData, reduceEvalTrends } from '../server/aggregates/reducers.js';

// ── One shared fixture table ─────────────────────────────────────

function acc(overrides: Partial<Accounting> = {}): Accounting {
  return {
    version: 1,
    currency: 'USD',
    knownCost: 0,
    completeness: 'complete',
    reasons: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      audioSeconds: 0,
    },
    operations: { total: 0, settled: 0, unknown: 0, denied: 0, byKind: {} },
    breakdown: { generation: 0, judging: 0, external: 0 },
    provenance: {},
    ...overrides,
  };
}

function cov(
  items: Partial<EvalCoverage['items']> = {},
  scorers: Record<string, Partial<EvalCoverage['scorers'][string]>> = {},
): EvalCoverage {
  return {
    items: {
      completed: 0,
      failed: 0,
      cancelled: 0,
      budget_skipped: 0,
      budget_interrupted: 0,
      ...items,
    },
    scorers: Object.fromEntries(
      Object.entries(scorers).map(([name, counts]) => [
        name,
        {
          scored: 0,
          failed: 0,
          skipped: 0,
          cancelled: 0,
          budget_skipped: 0,
          budget_interrupted: 0,
          ...counts,
        },
      ]),
    ),
  };
}

const closedBudget = { limit: 1, status: 'closed' as const, knownSpend: 1.5, knownOvershoot: 0.5 };
const openBudget = { limit: 5, status: 'open' as const, knownSpend: 1.5, knownOvershoot: 0 };

/**
 * The artifacts every reader must agree about. Each is a plain JSON-shaped
 * object — exactly what a persisted run looks like coming back off disk.
 */
const FIXTURES: { name: string; artifact: Record<string, unknown> }[] = [
  {
    name: 'measured run',
    artifact: {
      totalCost: 0.75,
      accounting: { ...acc({ knownCost: 0.75 }), scope: 'run' },
      summary: { count: 2, failures: 0, scorers: {}, coverage: cov({ completed: 2 }) },
    },
  },
  {
    name: 'unpriced model — a lower bound, not free',
    artifact: {
      totalCost: 0,
      accounting: {
        ...acc({ knownCost: 0, completeness: 'incomplete', reasons: { unpriced_model: 2 } }),
        scope: 'run',
      },
      summary: { count: 2, failures: 0, scorers: {}, coverage: cov({ completed: 2 }) },
    },
  },
  {
    name: 'unverified legacy artifact (no accounting block at all)',
    artifact: { totalCost: 0.42, summary: { count: 1, failures: 0, scorers: {} } },
  },
  {
    name: 'legacy artifact reporting a negative total',
    artifact: { totalCost: -5, summary: { count: 1, failures: 0, scorers: {} } },
  },
  {
    name: 'accounting reporting a negative knownCost',
    artifact: {
      totalCost: 0,
      accounting: { ...acc({ knownCost: -5 }), scope: 'run' },
      summary: { count: 1, failures: 0, scorers: {} },
    },
  },
  {
    name: 'rescore-scoped accounting',
    artifact: {
      totalCost: 0.2,
      accounting: { ...acc({ knownCost: 0.2 }), scope: 'rescore' },
      summary: { count: 1, failures: 0, scorers: {} },
    },
  },
  {
    name: 'legacy artifact flagged as a rescore in metadata',
    artifact: {
      totalCost: 0.3,
      metadata: { rescored: true },
      summary: { count: 1, failures: 0, scorers: {} },
    },
  },
  {
    name: 'closed budget that refused cases',
    artifact: {
      totalCost: 1.5,
      accounting: { ...acc({ knownCost: 1.5 }), scope: 'run', budget: closedBudget },
      summary: {
        count: 3,
        failures: 2,
        scorers: {},
        coverage: cov({ completed: 1, budget_skipped: 1, budget_interrupted: 1 }),
      },
    },
  },
  {
    name: 'closed budget that refused only a judge',
    artifact: {
      totalCost: 1.5,
      accounting: { ...acc({ knownCost: 1.5 }), scope: 'run', budget: closedBudget },
      summary: {
        count: 3,
        failures: 0,
        scorers: {},
        coverage: cov({ completed: 3 }, { j: { scored: 1, budget_skipped: 2 } }),
      },
    },
  },
  {
    name: 'closed budget that refused NOTHING — spend landed on the limit',
    artifact: {
      totalCost: 1,
      accounting: { ...acc({ knownCost: 1 }), scope: 'run', budget: closedBudget },
      summary: {
        count: 3,
        failures: 0,
        scorers: {},
        coverage: cov({ completed: 3 }, { j: { scored: 3 } }),
      },
    },
  },
  {
    name: 'closed budget with no coverage block (pre-0.24)',
    artifact: {
      totalCost: 1.5,
      accounting: { ...acc({ knownCost: 1.5 }), scope: 'run', budget: closedBudget },
      summary: { count: 3, failures: 0, scorers: {} },
    },
  },
  {
    name: 'open budget with refused work recorded',
    artifact: {
      totalCost: 1.5,
      accounting: { ...acc({ knownCost: 1.5 }), scope: 'run', budget: openBudget },
      summary: {
        count: 3,
        failures: 1,
        scorers: {},
        coverage: cov({ completed: 2, budget_skipped: 1 }),
      },
    },
  },
];

const asEvalResult = (a: Record<string, unknown>) => a as unknown as EvalResult;
const asResultData = (a: Record<string, unknown>) => a as unknown as EvalResultData;
const coverageOf = (a: Record<string, unknown>) =>
  (a.summary as { coverage?: EvalCoverage } | undefined)?.coverage;
const budgetOf = (a: Record<string, unknown>) =>
  (a.accounting as { budget?: { status?: string } } | undefined)?.budget;

describe('G2 drift tripwire — the browser mirror reads what the eval package reads', () => {
  it.each(FIXTURES)('readAccounting agrees on: $name', ({ artifact }) => {
    const fromEval = evalReadAccounting(asEvalResult(artifact));
    const fromMirror = mirrorReadAccounting(asResultData(artifact));
    expect(fromMirror.completeness).toBe(fromEval.completeness);
    expect(fromMirror.knownCost).toBe(fromEval.knownCost);
    expect(fromMirror.scope).toBe(fromEval.scope);
    expect(fromMirror.reasons).toEqual(fromEval.reasons);
  });

  it.each(FIXTURES)('refusedWork agrees on: $name', ({ artifact }) => {
    expect(mirrorRefusedWork(coverageOf(artifact))).toBe(evalRefusedWork(coverageOf(artifact)));
  });

  it.each(FIXTURES)('isBudgetStopped agrees on: $name', ({ artifact }) => {
    const input = { budget: budgetOf(artifact), coverage: coverageOf(artifact) };
    expect(mirrorIsBudgetStopped(input)).toBe(evalIsBudgetStopped(input));
  });

  it('aggregateAccounting folds the whole table identically', () => {
    const fromEval = evalAggregate(
      FIXTURES.map((f) => evalReadAccounting(asEvalResult(f.artifact))),
    );
    const fromMirror = mirrorAggregate(
      FIXTURES.map((f) => mirrorReadAccounting(asResultData(f.artifact))),
    );
    expect(fromMirror.completeness).toBe(fromEval.completeness);
    expect(fromMirror.knownCost).toBeCloseTo(fromEval.knownCost, 10);
    expect(fromMirror.reasons).toEqual(fromEval.reasons);
    expect(fromMirror.usage).toEqual(fromEval.usage);
    expect(fromMirror.operations).toEqual(fromEval.operations);
    expect(fromMirror.breakdown).toEqual(fromEval.breakdown);
    expect(fromMirror.provenance).toEqual(fromEval.provenance);
  });

  it('never upgrades an artifact the eval package calls unverified', () => {
    for (const { artifact } of FIXTURES) {
      if (evalReadAccounting(asEvalResult(artifact)).completeness === 'unverified') {
        expect(mirrorReadAccounting(asResultData(artifact)).completeness).toBe('unverified');
      }
    }
  });
});

describe('G2 drift tripwire — the server reducer reads what the eval package reads', () => {
  const entry = (data: unknown): EvalHistoryEntry =>
    ({ id: 'r', eval: 'e1', timestamp: 1, data }) as unknown as EvalHistoryEntry;

  it.each(FIXTURES)('reduceEvalTrends agrees on: $name', ({ artifact }) => {
    const point = reduceEvalTrends(emptyEvalTrendData(), entry(artifact)).byEval.e1.runs[0];
    const fromEval = evalReadAccounting(asEvalResult(artifact));

    // A trend point is a SUMMAND, so the comparand is the eval package's fold
    // rule (`usableCost`), not the pass-through a single `readAccounting`
    // gives: a corrupt negative total must contribute 0, not drag the window.
    expect(point.cost).toBeCloseTo(evalAggregate([fromEval]).knownCost, 10);
    expect(point.completeness).toBe(fromEval.completeness);
    expect(point.budgetStopped ?? false).toBe(
      evalIsBudgetStopped({ budget: budgetOf(artifact), coverage: coverageOf(artifact) }),
    );
  });
});
