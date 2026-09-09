/**
 * Spend, budget and coverage rows in the CLI (matrix A15.5–A15.8).
 *
 * These are what a developer actually reads after a run. The rule they enforce
 * is that the terminal never states a number more confidently than the run
 * measured it, and never lets a budget stop look like a broken eval.
 *
 * They live beside `cli-format.test.ts` and import from `cli-format.ts` rather
 * than `cli.ts`, whose module body runs `main()` on import.
 */

import { describe, it, expect } from 'vitest';

import {
  budgetStopMessage,
  formatBudgetLine,
  formatCoverageLine,
  formatKnownSpend,
  isTotalWipeout,
} from '../cli-format.js';
import type { EvalAccounting, EvalCoverage, EvalResult } from '../types.js';

const COMPLETE: EvalAccounting = {
  version: 1,
  currency: 'USD',
  knownCost: 1.5,
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
  operations: { total: 2, settled: 2, unknown: 0, denied: 0, byKind: {} },
  breakdown: { generation: 1.5, judging: 0, external: 0 },
  provenance: {},
  scope: 'run',
};

/** A result carrying just the fields the row builders read. */
function resultWith(overrides: Partial<EvalResult>): EvalResult {
  return {
    id: 'r1',
    dataset: 'ds',
    metadata: {},
    timestamp: '',
    totalCost: 0,
    duration: 0,
    items: [],
    summary: { count: 0, failures: 0, scorers: {} },
    ...overrides,
  };
}

describe('formatKnownSpend()', () => {
  it('prints a measured total plainly', () => {
    expect(formatKnownSpend(COMPLETE)).toBe('$1.50');
  });

  it('says WHY an incomplete total is only a lower bound', () => {
    // `$0.00` alone reads as "this run was free". When two models had no price
    // the honest statement is that we could not price them.
    const line = formatKnownSpend({
      ...COMPLETE,
      knownCost: 0,
      completeness: 'incomplete',
      reasons: { unpriced_model: 2 },
    });

    expect(line).toBe('$0.00 (incomplete: 2 unpriced_model)');
  });

  it('lists every reason a total is incomplete', () => {
    const line = formatKnownSpend({
      ...COMPLETE,
      completeness: 'incomplete',
      reasons: { unpriced_model: 1, usage_missing: 3 },
    });

    expect(line).toContain('1 unpriced_model');
    expect(line).toContain('3 usage_missing');
  });

  it('marks a legacy artifact total as unverified rather than measured', () => {
    expect(formatKnownSpend({ ...COMPLETE, completeness: 'unverified' })).toBe(
      '$1.50 (unverified)',
    );
  });
});

describe('formatBudgetLine()', () => {
  it('prints nothing when the run had no budget', () => {
    expect(formatBudgetLine(COMPLETE)).toBeUndefined();
  });

  it('shows progress against an open budget', () => {
    const line = formatBudgetLine({
      ...COMPLETE,
      budget: { limit: 5, knownSpend: 1.5, knownOvershoot: 0, status: 'open' },
    });

    expect(line).toContain('$1.50 of $5.00');
    expect(line).toContain('(open)');
    expect(line).not.toContain('STOPPED');
  });

  it('shows the overshoot and what observed the stop', () => {
    const line = formatBudgetLine({
      ...COMPLETE,
      budget: {
        limit: 1,
        knownSpend: 1.5,
        knownOvershoot: 0.5,
        status: 'closed',
        closedBy: 'scorer',
      },
    });

    expect(line).toContain('STOPPED');
    expect(line).toContain('$1.50 known spend against a $1.00 limit');
    expect(line).toContain('$0.50 over');
    expect(line).toContain('scorer');
  });
});

describe('formatCoverageLine()', () => {
  it('prints nothing when every case simply completed', () => {
    const result = resultWith({
      summary: {
        count: 3,
        failures: 0,
        scorers: {},
        coverage: {
          items: {
            completed: 3,
            failed: 0,
            cancelled: 0,
            budget_skipped: 0,
            budget_interrupted: 0,
          },
          scorers: {},
        },
      },
    });

    expect(formatCoverageLine(result)).toBeUndefined();
  });

  it('names each way a case did not complete', () => {
    const result = resultWith({
      summary: {
        count: 6,
        failures: 4,
        scorers: {},
        coverage: {
          items: {
            completed: 2,
            failed: 1,
            cancelled: 1,
            budget_skipped: 1,
            budget_interrupted: 1,
          },
          scorers: {},
        },
      },
    });

    const line = formatCoverageLine(result)!;
    expect(line).toContain('2 completed');
    expect(line).toContain('1 failed');
    expect(line).toContain('1 cancelled');
    expect(line).toContain('1 budget-skipped');
    expect(line).toContain('1 budget-interrupted');
  });
});

describe('budgetStopMessage()', () => {
  const stopped = resultWith({
    accounting: {
      ...COMPLETE,
      budget: {
        limit: 1,
        knownSpend: 1.5,
        knownOvershoot: 0.5,
        status: 'closed',
        closedBy: 'case',
      },
    },
    summary: {
      count: 4,
      failures: 3,
      scorers: {},
      coverage: {
        items: { completed: 1, failed: 0, cancelled: 0, budget_skipped: 2, budget_interrupted: 1 },
        scorers: {},
      },
    },
  });

  it('says nothing for a run that stayed inside its budget', () => {
    expect(
      budgetStopMessage(
        resultWith({
          accounting: {
            ...COMPLETE,
            budget: { limit: 5, knownSpend: 1.5, knownOvershoot: 0, status: 'open' },
          },
        }),
        'evals/a.ts',
      ),
    ).toBeNull();
  });

  it('says nothing for a run that had no budget at all', () => {
    expect(budgetStopMessage(resultWith({ accounting: COMPLETE }), 'evals/a.ts')).toBeNull();
  });

  it('states the stop, the shortfall in coverage, and that it is not a model failure', () => {
    const message = budgetStopMessage(stopped, 'evals/a.ts')!;

    // The distinct prefix is what a CI log scanner keys on.
    expect(message.startsWith('[axl-eval] BUDGET STOPPED:')).toBe(true);
    expect(message).toContain('evals/a.ts');
    expect(message).toContain('$1.50');
    expect(message).toContain('$1.00 limit');
    expect(message).toContain('2 case(s) never started');
    expect(message).toContain('1 stopped mid-flight');
    // Without this sentence a reader treats a deliberate stop as a regression.
    expect(message).toContain('NOT a model or scorer failure');
  });
});

describe('isTotalWipeout()', () => {
  function withCoverage(items: EvalCoverage['items'], count: number, failures: number): EvalResult {
    return resultWith({
      summary: { count, failures, scorers: {}, coverage: { items, scorers: {} } },
    });
  }

  it('is false for an empty run', () => {
    expect(isTotalWipeout(resultWith({}))).toBe(false);
  });

  it('is true when the workflow failed on every case', () => {
    expect(
      isTotalWipeout(
        withCoverage(
          { completed: 0, failed: 3, cancelled: 0, budget_skipped: 0, budget_interrupted: 0 },
          3,
          3,
        ),
      ),
    ).toBe(true);
  });

  it('is FALSE when the cases were stopped on budget rather than broken', () => {
    // This is the distinction the exit code turns on: a budget stop must not be
    // reported as "your workflow is completely broken".
    expect(
      isTotalWipeout(
        withCoverage(
          { completed: 0, failed: 0, cancelled: 0, budget_skipped: 3, budget_interrupted: 0 },
          3,
          3,
        ),
      ),
    ).toBe(false);
    expect(
      isTotalWipeout(
        withCoverage(
          { completed: 0, failed: 2, cancelled: 0, budget_skipped: 0, budget_interrupted: 1 },
          3,
          3,
        ),
      ),
    ).toBe(false);
  });

  it('is false as soon as one case completed', () => {
    expect(
      isTotalWipeout(
        withCoverage(
          { completed: 1, failed: 2, cancelled: 0, budget_skipped: 0, budget_interrupted: 0 },
          3,
          2,
        ),
      ),
    ).toBe(false);
  });

  it('falls back to the legacy failure count for an artifact with no coverage', () => {
    expect(isTotalWipeout(resultWith({ summary: { count: 2, failures: 2, scorers: {} } }))).toBe(
      true,
    );
    expect(isTotalWipeout(resultWith({ summary: { count: 2, failures: 1, scorers: {} } }))).toBe(
      false,
    );
  });
});
