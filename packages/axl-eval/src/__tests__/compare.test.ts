import { describe, it, expect } from 'vitest';
import { evalCompare } from '../compare.js';
import type { EvalResult } from '../types.js';

function makeEvalResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    id: 'test-baseline',
    workflow: 'test',
    dataset: 'test-ds',
    metadata: {},
    timestamp: new Date().toISOString(),
    totalCost: 0,
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

describe('evalCompare()', () => {
  it('compares two eval results with same dataset and scorers', () => {
    const baseline = makeEvalResult({ id: 'baseline-1' });
    const candidate = makeEvalResult({
      id: 'candidate-1',
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.9 } },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.7 } },
      ],
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.8, min: 0.7, max: 0.9, p50: 0.8, p95: 0.9 } },
      },
    });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.baseline.id).toBe('baseline-1');
    expect(comparison.candidate.id).toBe('candidate-1');
    expect(comparison.scorers.accuracy).toBeDefined();
    expect(comparison.scorers.accuracy.baselineMean).toBe(0.7);
    expect(comparison.scorers.accuracy.candidateMean).toBe(0.8);
  });

  it('calculates delta and deltaPercent correctly', () => {
    const baseline = makeEvalResult({
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.5, min: 0.4, max: 0.6, p50: 0.5, p95: 0.6 } },
      },
    });
    const candidate = makeEvalResult({
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.75, min: 0.7, max: 0.8, p50: 0.75, p95: 0.8 } },
      },
    });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.scorers.accuracy.delta).toBe(0.25);
    expect(comparison.scorers.accuracy.deltaPercent).toBe(50);
  });

  it('detects regressions (score drops > 0.1)', () => {
    const baseline = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.9 } },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.8 } },
      ],
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.85, min: 0.8, max: 0.9, p50: 0.85, p95: 0.9 } },
      },
    });
    const candidate = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.5 } },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.8 } },
      ],
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.65, min: 0.5, max: 0.8, p50: 0.65, p95: 0.8 } },
      },
    });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0].scorer).toBe('accuracy');
    expect(comparison.regressions[0].baselineScore).toBe(0.9);
    expect(comparison.regressions[0].candidateScore).toBe(0.5);
    expect(comparison.regressions[0].delta).toBe(-0.4);
    expect(comparison.regressions[0].input).toEqual({ q: '1' });
  });

  it('detects improvements (score increases > 0.1)', () => {
    const baseline = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.3 } },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.6 } },
      ],
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.45, min: 0.3, max: 0.6, p50: 0.45, p95: 0.6 } },
      },
    });
    const candidate = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.9 } },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.6 } },
      ],
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.75, min: 0.6, max: 0.9, p50: 0.75, p95: 0.9 } },
      },
    });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.improvements).toHaveLength(1);
    expect(comparison.improvements[0].scorer).toBe('accuracy');
    expect(comparison.improvements[0].baselineScore).toBe(0.3);
    expect(comparison.improvements[0].candidateScore).toBe(0.9);
    expect(comparison.improvements[0].delta).toBe(0.6);
  });

  it('does not flag items with delta within [-0.1, 0.1] as regressions or improvements', () => {
    const baseline = makeEvalResult({
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: 0.8 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: { accuracy: { mean: 0.8, min: 0.8, max: 0.8, p50: 0.8, p95: 0.8 } },
      },
    });
    const candidate = makeEvalResult({
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: 0.85 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: { accuracy: { mean: 0.85, min: 0.85, max: 0.85, p50: 0.85, p95: 0.85 } },
      },
    });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.regressions).toHaveLength(0);
    expect(comparison.improvements).toHaveLength(0);
  });

  it('generates human-readable summary', () => {
    const baseline = makeEvalResult({
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.7, min: 0.6, max: 0.8, p50: 0.7, p95: 0.8 } },
      },
    });
    const candidate = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.9 } },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.8 } },
      ],
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.85, min: 0.8, max: 0.9, p50: 0.85, p95: 0.9 } },
      },
    });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.summary).toBeDefined();
    expect(typeof comparison.summary).toBe('string');
    expect(comparison.summary).toContain('candidate');
  });

  it('summary indicates no significant changes when scores are equal', () => {
    const baseline = makeEvalResult();
    const candidate = makeEvalResult();

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.summary).toContain('no significant changes');
  });

  it('summary includes direction and percentage for changed scores', () => {
    const baseline = makeEvalResult({
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.5, min: 0.4, max: 0.6, p50: 0.5, p95: 0.6 } },
      },
    });
    const candidate = makeEvalResult({
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.75, min: 0.7, max: 0.8, p50: 0.75, p95: 0.8 } },
      },
    });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.summary).toContain('accuracy');
    expect(comparison.summary).toContain('+');
  });

  it('throws when datasets do not match', () => {
    const baseline = makeEvalResult({ dataset: 'dataset-A' });
    const candidate = makeEvalResult({ dataset: 'dataset-B' });

    expect(() => evalCompare(baseline, candidate)).toThrow(
      'Cannot compare evals from different datasets',
    );
  });

  it('throws when scorers do not match', () => {
    const baseline = makeEvalResult({
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.7, min: 0.6, max: 0.8, p50: 0.7, p95: 0.8 } },
      },
    });
    const candidate = makeEvalResult({
      summary: {
        count: 2,
        failures: 0,
        scorers: { relevance: { mean: 0.7, min: 0.6, max: 0.8, p50: 0.7, p95: 0.8 } },
      },
    });

    expect(() => evalCompare(baseline, candidate)).toThrow(
      'Cannot compare evals with different scorers',
    );
  });

  it('handles multiple scorers in comparison', () => {
    const baseline = makeEvalResult({
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: 0.8, relevance: 0.9 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: {
          accuracy: { mean: 0.8, min: 0.8, max: 0.8, p50: 0.8, p95: 0.8 },
          relevance: { mean: 0.9, min: 0.9, max: 0.9, p50: 0.9, p95: 0.9 },
        },
      },
    });
    const candidate = makeEvalResult({
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: 0.9, relevance: 0.7 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: {
          accuracy: { mean: 0.9, min: 0.9, max: 0.9, p50: 0.9, p95: 0.9 },
          relevance: { mean: 0.7, min: 0.7, max: 0.7, p50: 0.7, p95: 0.7 },
        },
      },
    });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.scorers.accuracy).toBeDefined();
    expect(comparison.scorers.relevance).toBeDefined();
    expect(comparison.scorers.accuracy.delta).toBeCloseTo(0.1, 3);
    expect(comparison.scorers.relevance.delta).toBeCloseTo(-0.2, 3);
  });

  it('skips items with errors when finding regressions/improvements', () => {
    const baseline = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.9 }, error: 'failed' },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.8 } },
      ],
    });
    const candidate = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.1 } },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.8 } },
      ],
    });

    const comparison = evalCompare(baseline, candidate);

    // First item should be skipped due to error in baseline
    expect(comparison.regressions).toHaveLength(0);
    expect(comparison.improvements).toHaveLength(0);
  });

  it('handles deltaPercent when baseline mean is zero', () => {
    const baseline = makeEvalResult({
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0, min: 0, max: 0, p50: 0, p95: 0 } },
      },
    });
    const candidate = makeEvalResult({
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.5, min: 0.5, max: 0.5, p50: 0.5, p95: 0.5 } },
      },
    });

    const comparison = evalCompare(baseline, candidate);

    // When baseline mean is 0, deltaPercent should be 0 (not Infinity)
    expect(comparison.scorers.accuracy.deltaPercent).toBe(0);
  });

  it('preserves metadata from both baseline and candidate', () => {
    const baseline = makeEvalResult({
      id: 'base-id',
      metadata: { version: 'v1', model: 'gpt-3' },
    });
    const candidate = makeEvalResult({
      id: 'cand-id',
      metadata: { version: 'v2', model: 'gpt-4' },
    });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.baseline.id).toBe('base-id');
    expect(comparison.baseline.metadata).toEqual({ version: 'v1', model: 'gpt-3' });
    expect(comparison.candidate.id).toBe('cand-id');
    expect(comparison.candidate.metadata).toEqual({ version: 'v2', model: 'gpt-4' });
  });

  it('handles different item counts by comparing only overlapping items', () => {
    const baseline = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.9 } },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.8 } },
        { input: { q: '3' }, output: 'c', scores: { accuracy: 0.7 } },
      ],
    });
    const candidate = makeEvalResult({
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: 0.3 } }],
    });

    const comparison = evalCompare(baseline, candidate);

    // Should only compare the first item (minLength = 1)
    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0].baselineScore).toBe(0.9);
    expect(comparison.regressions[0].candidateScore).toBe(0.3);
  });

  it('skips items with null scores (invalid scores)', () => {
    const baseline = makeEvalResult({
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: null } }],
    });
    const candidate = makeEvalResult({
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: 0.9 } }],
    });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.regressions).toHaveLength(0);
    expect(comparison.improvements).toHaveLength(0);
  });

  it('includes itemIndex in regressions and improvements', () => {
    const baseline = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.9 } },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.3 } },
      ],
    });
    const candidate = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.5 } },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.8 } },
      ],
    });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.regressions[0].itemIndex).toBe(0);
    expect(comparison.improvements[0].itemIndex).toBe(1);
  });

  it('compares timing when both runs have duration data', () => {
    const baseline = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.8 }, duration: 1000 },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.6 }, duration: 2000 },
      ],
    });
    const candidate = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.8 }, duration: 2000 },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.6 }, duration: 4000 },
      ],
    });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.timing).toBeDefined();
    expect(comparison.timing!.baselineMean).toBe(1500);
    expect(comparison.timing!.candidateMean).toBe(3000);
    expect(comparison.timing!.delta).toBe(1500);
    expect(comparison.timing!.deltaPercent).toBe(100);
  });

  it('omits timing when neither run has duration data', () => {
    const baseline = makeEvalResult();
    const candidate = makeEvalResult();

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.timing).toBeUndefined();
  });

  it('compares cost when either run has non-zero cost', () => {
    const baseline = makeEvalResult({ totalCost: 1.0 });
    const candidate = makeEvalResult({ totalCost: 0.4 });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.cost).toBeDefined();
    expect(comparison.cost!.baselineTotal).toBe(1.0);
    expect(comparison.cost!.candidateTotal).toBe(0.4);
    expect(comparison.cost!.delta).toBe(-0.6);
    expect(comparison.cost!.deltaPercent).toBe(-60);
  });

  it('omits cost when both runs have zero cost', () => {
    const baseline = makeEvalResult({ totalCost: 0 });
    const candidate = makeEvalResult({ totalCost: 0 });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.cost).toBeUndefined();
  });

  it('includes timing delta in summary string', () => {
    const baseline = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.8 }, duration: 1000 },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.8 }, duration: 1000 },
      ],
    });
    const candidate = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.8 }, duration: 3000 },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.8 }, duration: 3000 },
      ],
    });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.summary).toContain('slower');
  });

  it('includes cost delta in summary string', () => {
    const baseline = makeEvalResult({ totalCost: 2.0 });
    const candidate = makeEvalResult({ totalCost: 0.5 });

    const comparison = evalCompare(baseline, candidate);

    expect(comparison.summary).toContain('cheaper');
  });
});
