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

  // F3
  it('still reports a cost row when both sides know nothing about their spend', async () => {
    // Both sides ran entirely on unpriced models: `knownCost` is 0 on each, but
    // "we could not price 2 calls" is the opposite of "these cost the same".
    // Printing nothing here left the most uncertain comparison saying the least.
    const baseline = await unpricedRun(2);
    const candidate = await unpricedRun(2);

    const { cost } = evalCompare(baseline, candidate);

    expect(cost).toBeDefined();
    expect(cost!.baselineTotal).toBe(0);
    expect(cost!.candidateTotal).toBe(0);
    expect(cost!.delta).toBe(0);
    expect(cost!.deltaPercent).toBeNull();
    expect(cost!.certified).toBe(false);
    expect(cost!.reason).toMatch(/incomplete accounting/);
  });

  // F3(b)
  it('reports a row when a genuinely-free baseline meets an unpriced candidate', async () => {
    // The trap this closes: baseline is known-free (a local model, complete at
    // $0), candidate is an unpriced gateway. Both totals read 0, so the old
    // guard printed nothing and the reader concluded "no cost change" — when in
    // fact the candidate's spend is entirely unknown.
    const baseline = await measuredRun(2, 0);
    const candidate = await unpricedRun(2);

    const { cost } = evalCompare(baseline, candidate);

    expect(cost).toBeDefined();
    expect(cost!.certified).toBe(false);
    expect(cost!.reason).toMatch(/candidate/);
    expect(cost!.reason).toMatch(/unpriced_model/);
  });

  // F4
  it('refuses when ONE side mixes a rescore into an otherwise full-run group', async () => {
    // A multi-run side assembled from history can mix scopes. Checking only
    // run[0] certifies a per-run average built from two different denominators
    // — a judging-only total averaged with full-run totals.
    const runA = await measuredRun(2, 0.5);
    const runB = await measuredRun(2, 0.5);
    const disguisedRescore: EvalResult = {
      ...runB,
      id: 'mixed-in',
      accounting: { ...runB.accounting!, scope: 'rescore' },
    };
    const candidate = [await measuredRun(2, 0.4), await measuredRun(2, 0.4)];

    const { cost } = evalCompare([runA, disguisedRescore], candidate);

    expect(cost!.certified).toBe(false);
    expect(cost!.reason).toMatch(/mixes accounting scopes/);
    expect(cost!.reason).toMatch(/baseline/);
    // Raw averages are still reported.
    expect(cost!.baselineTotal).toBeCloseTo(1, 10);
  });

  // F4(b)
  it('certifies a consistent multi-run group on both sides', async () => {
    const baseline = [await measuredRun(2, 0.5), await measuredRun(2, 0.5)];
    const candidate = [await measuredRun(2, 0.25), await measuredRun(2, 0.25)];

    const { cost } = evalCompare(baseline, candidate);

    expect(cost!.certified).toBe(true);
    expect(cost!.reason).toBeUndefined();
    expect(cost!.deltaPercent).toBeCloseTo(-50, 6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The prose summary may not carry an uncertified saving
// ═══════════════════════════════════════════════════════════════════════════

describe('EvalComparison.summary states a cost change only when it is certified', () => {
  it('appends the cost clause for a certified delta', async () => {
    const baseline = await measuredRun(2, 1);
    const candidate = await measuredRun(2, 0.5);

    const { summary, cost } = evalCompare(baseline, candidate);

    expect(cost!.certified).toBe(true);
    expect(summary).toMatch(/50% cheaper/);
  });

  it('omits the cost clause when certification was refused', async () => {
    // Both sides are fully measured, so the raw delta is a real number — but
    // they did different amounts of work, which is exactly why the cheaper
    // side is cheaper. A one-line "75% cheaper" has no room for that reason,
    // and a reader ships a model change on it.
    const baseline = await measuredRun(2, 1);
    const measured = await measuredRun(2, 0.5);
    // Same dataset, one case fewer — the candidate did less work.
    const candidate: EvalResult = { ...measured, items: measured.items.slice(0, 1) };

    const { summary, cost } = evalCompare(baseline, candidate);

    expect(cost!.certified).toBe(false);
    expect(cost!.reason).toMatch(/item counts differ/);
    expect(cost!.deltaPercent).toBeCloseTo(-50, 6);
    expect(summary).not.toMatch(/cheaper/);
    expect(summary).not.toMatch(/more expensive/);
  });
});
