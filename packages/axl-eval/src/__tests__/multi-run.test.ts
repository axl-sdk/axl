import { describe, it, expect } from 'vitest';
import { aggregateRuns } from '../multi-run.js';
import type { EvalResult } from '../types.js';

function makeRun(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    id: 'run-1',
    workflow: 'test-wf',
    dataset: 'test-ds',
    metadata: { runGroupId: 'group-1' },
    timestamp: new Date().toISOString(),
    totalCost: 0.01,
    duration: 100,
    items: [
      { input: { q: '1' }, output: 'a', scores: { accuracy: 0.8 } },
      { input: { q: '2' }, output: 'b', scores: { accuracy: 0.6 } },
    ],
    summary: {
      count: 2,
      failures: 0,
      scorers: { accuracy: { mean: 0.7, min: 0.6, max: 0.8, p50: 0.7, p95: 0.8 } },
    },
    ...overrides,
  };
}

describe('aggregateRuns()', () => {
  it('computes mean and std across runs', () => {
    const runs = [
      makeRun({
        summary: {
          count: 2,
          failures: 0,
          scorers: { accuracy: { mean: 0.7, min: 0.6, max: 0.8, p50: 0.7, p95: 0.8 } },
        },
      }),
      makeRun({
        summary: {
          count: 2,
          failures: 0,
          scorers: { accuracy: { mean: 0.8, min: 0.7, max: 0.9, p50: 0.8, p95: 0.9 } },
        },
      }),
      makeRun({
        summary: {
          count: 2,
          failures: 0,
          scorers: { accuracy: { mean: 0.9, min: 0.8, max: 1.0, p50: 0.9, p95: 1.0 } },
        },
      }),
    ];

    const summary = aggregateRuns(runs);

    expect(summary.runCount).toBe(3);
    expect(summary.scorers.accuracy.mean).toBeCloseTo(0.8, 2);
    expect(summary.scorers.accuracy.std).toBeGreaterThan(0);
    expect(summary.scorers.accuracy.min).toBeCloseTo(0.7, 2);
    expect(summary.scorers.accuracy.max).toBeCloseTo(0.9, 2);
  });

  it('returns std of 0 for single run', () => {
    const runs = [makeRun()];
    const summary = aggregateRuns(runs);

    expect(summary.runCount).toBe(1);
    expect(summary.scorers.accuracy.std).toBe(0);
  });

  it('includes timing stats when all runs have timing', () => {
    const runs = [
      makeRun({
        summary: {
          count: 2,
          failures: 0,
          scorers: { accuracy: { mean: 0.7, min: 0.6, max: 0.8, p50: 0.7, p95: 0.8 } },
          timing: { mean: 100, min: 80, max: 120, p50: 100, p95: 120 },
        },
      }),
      makeRun({
        summary: {
          count: 2,
          failures: 0,
          scorers: { accuracy: { mean: 0.8, min: 0.7, max: 0.9, p50: 0.8, p95: 0.9 } },
          timing: { mean: 200, min: 180, max: 220, p50: 200, p95: 220 },
        },
      }),
    ];

    const summary = aggregateRuns(runs);

    expect(summary.timing).toBeDefined();
    expect(summary.timing!.mean).toBeCloseTo(150, 0);
    expect(summary.timing!.std).toBeGreaterThan(0);
  });

  it('includes cost totals across all runs', () => {
    const runs = [
      makeRun({ totalCost: 0.5, duration: 100 }),
      makeRun({ totalCost: 0.3, duration: 200 }),
    ];

    const summary = aggregateRuns(runs);

    expect(summary.totalCost).toBeCloseTo(0.8, 2);
    expect(summary.totalDuration).toBe(300);
  });

  it('omits timing when not all runs have it', () => {
    const runs = [
      makeRun({
        summary: {
          count: 2,
          failures: 0,
          scorers: { accuracy: { mean: 0.7, min: 0.6, max: 0.8, p50: 0.7, p95: 0.8 } },
          timing: { mean: 100, min: 80, max: 120, p50: 100, p95: 120 },
        },
      }),
      makeRun({
        summary: {
          count: 2,
          failures: 0,
          scorers: { accuracy: { mean: 0.8, min: 0.7, max: 0.9, p50: 0.8, p95: 0.9 } },
        },
      }),
      makeRun({
        summary: {
          count: 2,
          failures: 0,
          scorers: { accuracy: { mean: 0.9, min: 0.8, max: 1.0, p50: 0.9, p95: 1.0 } },
        },
      }),
    ];

    const summary = aggregateRuns(runs);
    expect(summary.timing).toBeUndefined();
  });

  it('aggregates multiple scorers correctly', () => {
    const runs = [
      makeRun({
        summary: {
          count: 2,
          failures: 0,
          scorers: {
            accuracy: { mean: 0.8, min: 0.7, max: 0.9, p50: 0.8, p95: 0.9 },
            relevance: { mean: 0.6, min: 0.5, max: 0.7, p50: 0.6, p95: 0.7 },
          },
        },
      }),
      makeRun({
        summary: {
          count: 2,
          failures: 0,
          scorers: {
            accuracy: { mean: 0.9, min: 0.8, max: 1.0, p50: 0.9, p95: 1.0 },
            relevance: { mean: 0.7, min: 0.6, max: 0.8, p50: 0.7, p95: 0.8 },
          },
        },
      }),
    ];

    const summary = aggregateRuns(runs);

    expect(summary.scorers.accuracy).toBeDefined();
    expect(summary.scorers.relevance).toBeDefined();
    expect(summary.scorers.accuracy.mean).toBeCloseTo(0.85, 2);
    expect(summary.scorers.relevance.mean).toBeCloseTo(0.65, 2);
  });

  it('generates UUID runGroupId when not in metadata', () => {
    const runs = [makeRun({ metadata: {} }), makeRun({ metadata: {} })];

    const summary = aggregateRuns(runs);
    expect(summary.runGroupId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('throws when given empty runs array', () => {
    expect(() => aggregateRuns([])).toThrow('Cannot aggregate zero runs');
  });

  it('sums scored/failed across runs', () => {
    const runs = [
      makeRun({
        summary: {
          count: 2,
          failures: 0,
          scorers: {
            accuracy: { mean: 0.7, min: 0.6, max: 0.8, p50: 0.7, p95: 0.8, scored: 8, failed: 2 },
          },
        },
      }),
      makeRun({
        summary: {
          count: 2,
          failures: 0,
          scorers: {
            accuracy: { mean: 0.8, min: 0.7, max: 0.9, p50: 0.8, p95: 0.9, scored: 9, failed: 1 },
          },
        },
      }),
    ];
    const summary = aggregateRuns(runs);
    expect(summary.scorers.accuracy.scored).toBe(17);
    expect(summary.scorers.accuracy.failed).toBe(3);
  });

  it('treats missing scored/failed as 0 (pre-0.18.0 artifacts)', () => {
    // makeRun's default summary has no scored/failed fields.
    const summary = aggregateRuns([makeRun(), makeRun()]);
    expect(summary.scorers.accuracy.scored).toBe(0);
    expect(summary.scorers.accuracy.failed).toBe(0);
  });

  it('excludes a 100%-failed run (scored 0) from the mean but counts it in failed', () => {
    // Run A scored everything (mean 0.9); run B's scorer failed on every item,
    // so its summary mean is a meaningless 0 from an empty sample. The aggregate
    // mean must reflect only the contributing run (0.9), not (0.9+0)/2 = 0.45.
    const runs = [
      makeRun({
        summary: {
          count: 10,
          failures: 0,
          scorers: {
            accuracy: { mean: 0.9, min: 0.9, max: 0.9, p50: 0.9, p95: 0.9, scored: 10, failed: 0 },
          },
        },
      }),
      makeRun({
        summary: {
          count: 10,
          failures: 0,
          scorers: { accuracy: { mean: 0, min: 0, max: 0, p50: 0, p95: 0, scored: 0, failed: 10 } },
        },
      }),
    ];
    const summary = aggregateRuns(runs);
    expect(summary.scorers.accuracy.mean).toBe(0.9); // not 0.45
    expect(summary.scorers.accuracy.min).toBe(0.9);
    expect(summary.scorers.accuracy.scored).toBe(10);
    expect(summary.scorers.accuracy.failed).toBe(10); // failed summed across ALL runs
  });

  it('falls back to all runs when every run scored zero (no divide-by-zero)', () => {
    const runs = [
      makeRun({
        summary: {
          count: 5,
          failures: 0,
          scorers: { accuracy: { mean: 0, min: 0, max: 0, p50: 0, p95: 0, scored: 0, failed: 5 } },
        },
      }),
      makeRun({
        summary: {
          count: 5,
          failures: 0,
          scorers: { accuracy: { mean: 0, min: 0, max: 0, p50: 0, p95: 0, scored: 0, failed: 5 } },
        },
      }),
    ];
    const summary = aggregateRuns(runs);
    expect(summary.scorers.accuracy.mean).toBe(0);
    expect(Number.isNaN(summary.scorers.accuracy.mean)).toBe(false);
    expect(summary.scorers.accuracy.failed).toBe(10);
  });
});
