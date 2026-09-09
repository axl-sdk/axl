/**
 * Cost certification in `evalCompare` and `aggregateRuns` (matrix A14).
 *
 * "Candidate is 40% cheaper" is a claim someone ships a model change on. These
 * cases pin that the claim is made ONLY when both sides measured the same work
 * completely, and that when it is refused the reader is told why — with the raw
 * totals still visible, because hiding them would be its own kind of lie.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';
import { runEval } from '../runner.js';
import { evalCompare } from '../compare.js';
import { aggregateRuns } from '../multi-run.js';
import type { EvalResult } from '../types.js';
import { askExecute, scriptedRuntime } from './accounting-helpers.js';

const pass = scorer({ name: 'pass', description: 'always 1', score: () => 1 });

function ds(n: number) {
  return dataset({
    name: `ds-${n}`,
    schema: z.object({ q: z.string() }),
    items: Array.from({ length: n }, (_, i) => ({ input: { q: `q${i}` } })),
  });
}

/** A complete, measured run of `n` items at `cost` each. */
async function measuredRun(
  n: number,
  cost: number,
  config?: { budget?: string; concurrency?: number },
): Promise<EvalResult> {
  const { runtime } = scriptedRuntime([{ cost }]);
  return runEval(
    { workflow: 'w', dataset: ds(n), scorers: [pass], concurrency: 1, ...config },
    askExecute(),
    runtime,
  );
}

/** A run whose model had no usable price — a lower bound, not a total. */
async function unpricedRun(n: number): Promise<EvalResult> {
  const { runtime } = scriptedRuntime([{}]);
  return runEval(
    { workflow: 'w', dataset: ds(n), scorers: [pass], concurrency: 1 },
    askExecute(),
    runtime,
  );
}

describe('A14: a cost claim is certified only when both sides measured the same work', () => {
  // A14.3
  it('certifies a like-for-like comparison and states the delta', async () => {
    const baseline = await measuredRun(2, 1);
    const candidate = await measuredRun(2, 0.5);

    const { cost } = evalCompare(baseline, candidate);

    expect(cost).toBeDefined();
    expect(cost!.certified).toBe(true);
    expect(cost!.reason).toBeUndefined();
    expect(cost!.baselineTotal).toBeCloseTo(2, 10);
    expect(cost!.candidateTotal).toBeCloseTo(1, 10);
    expect(cost!.deltaPercent).toBeCloseTo(-50, 6);
  });

  // A14.4
  it('refuses to certify against an unpriced side, but still shows both totals', async () => {
    const baseline = await unpricedRun(2);
    const candidate = await measuredRun(2, 0.5);

    const { cost } = evalCompare(baseline, candidate);

    expect(cost!.certified).toBe(false);
    expect(cost!.reason).toMatch(/incomplete accounting/);
    expect(cost!.reason).toMatch(/unpriced_model/);
    // The numbers are still reported — refusing to certify is not refusing to
    // show. Suppressing them would leave the reader with nothing at all.
    expect(cost!.candidateTotal).toBeCloseTo(1, 10);
    expect(cost!.baselineTotal).toBe(0);
  });

  // A14.5
  it('refuses to certify a legacy artifact whose total was never measured', async () => {
    const legacy: EvalResult = {
      id: 'legacy',
      dataset: 'ds-2',
      metadata: {},
      timestamp: '',
      totalCost: 4,
      duration: 0,
      items: [
        { input: { q: 'q0' }, output: 'o', scores: { pass: 1 } },
        { input: { q: 'q1' }, output: 'o', scores: { pass: 1 } },
      ],
      summary: {
        count: 2,
        failures: 0,
        scorers: { pass: { mean: 1, min: 1, max: 1, p50: 1, p95: 1, scored: 2, failed: 0 } },
      },
    };
    const candidate = await measuredRun(2, 0.5);

    const { cost } = evalCompare(legacy, candidate);

    expect(cost!.certified).toBe(false);
    expect(cost!.reason).toMatch(/unverified/);
    expect(cost!.baselineTotal).toBeCloseTo(4, 10);
  });

  // A14.6
  it('refuses to certify when one side did less work because of a budget', async () => {
    // The budgeted side is genuinely cheaper — because it skipped half the
    // dataset. Certifying that as an efficiency win is the exact wrong call.
    const baseline = await measuredRun(4, 0.5);
    const candidate = await measuredRun(4, 0.5, { budget: '$1' });

    const { cost } = evalCompare(baseline, candidate);

    expect(cost!.certified).toBe(false);
    expect(cost!.reason).toMatch(/case coverage differs/);
    expect(cost!.reason).toMatch(/budget_skipped/);
    expect(cost!.candidateTotal).toBeLessThan(cost!.baselineTotal);
  });

  // A14.7
  it('reports deltaPercent as null rather than Infinity when the baseline was free', async () => {
    const baseline = await measuredRun(2, 0);
    const candidate = await measuredRun(2, 0.5);

    const { cost } = evalCompare(baseline, candidate);

    expect(cost!.baselineTotal).toBe(0);
    // A percentage change from zero is undefined, not infinite and not 100%.
    expect(cost!.deltaPercent).toBeNull();
    expect(cost!.delta).toBeCloseTo(1, 10);
    expect(cost!.certified).toBe(true);
  });

  // A14.8
  it('still compares quality when the cost claim is refused', async () => {
    const baseline = await unpricedRun(2);
    const candidate = await measuredRun(2, 0.5);

    const comparison = evalCompare(baseline, candidate);

    // Cost certification and quality comparison are independent judgments.
    expect(comparison.cost!.certified).toBe(false);
    expect(comparison.scorers.pass).toBeDefined();
    expect(comparison.scorers.pass.baselineMean).toBe(1);
    expect(comparison.scorers.pass.candidateMean).toBe(1);
    expect(comparison.scorers.pass.delta).toBe(0);
    expect(comparison.summary).toBeTruthy();
  });

  // A14.9
  it('aggregates runs conservatively: one unverified run taints the group', async () => {
    const measured = await measuredRun(2, 0.5);
    const legacy: EvalResult = { ...measured, id: 'legacy', accounting: undefined };

    const clean = aggregateRuns([measured, await measuredRun(2, 0.5)]);
    expect(clean.accounting.completeness).toBe('complete');
    expect(clean.accounting.knownCost).toBeCloseTo(2, 10);

    const tainted = aggregateRuns([measured, legacy]);
    expect(tainted.accounting.completeness).toBe('unverified');
    // The known spend is still summed — unverified means "at least this much",
    // not "unknown".
    expect(tainted.accounting.knownCost).toBeCloseTo(2, 10);
  });

  // A14.10
  it('refuses to certify a rescore total against a full run total', async () => {
    // A rescore covers judging only. Comparing it to a run total would report a
    // 90%+ "saving" that is really just a different denominator.
    const run = await measuredRun(2, 0.5);
    const rescored: EvalResult = {
      ...run,
      id: 'rescored',
      accounting: { ...run.accounting!, scope: 'rescore' },
    };

    const { cost } = evalCompare(run, rescored);

    expect(cost!.certified).toBe(false);
    expect(cost!.reason).toMatch(/scope differs/);
  });
});
