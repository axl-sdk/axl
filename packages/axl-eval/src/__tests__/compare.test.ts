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

    expect(comparison.summary).toContain('no meaningful changes');
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

  it('compares timing when both runs have summary.timing', () => {
    const baseline = makeEvalResult({
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.7, min: 0.6, max: 0.8, p50: 0.7, p95: 0.8 } },
        timing: { mean: 1500, min: 1000, max: 2000, p50: 1500, p95: 2000 },
      },
    });
    const candidate = makeEvalResult({
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.7, min: 0.6, max: 0.8, p50: 0.7, p95: 0.8 } },
        timing: { mean: 3000, min: 2000, max: 4000, p50: 3000, p95: 4000 },
      },
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

  it('omits timing when only one side has timing data', () => {
    const baseline = makeEvalResult({
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.7, min: 0.6, max: 0.8, p50: 0.7, p95: 0.8 } },
        timing: { mean: 1000, min: 500, max: 1500, p50: 1000, p95: 1500 },
      },
    });
    const candidate = makeEvalResult(); // no timing

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
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.8, min: 0.8, max: 0.8, p50: 0.8, p95: 0.8 } },
        timing: { mean: 1000, min: 1000, max: 1000, p50: 1000, p95: 1000 },
      },
    });
    const candidate = makeEvalResult({
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.8, min: 0.8, max: 0.8, p50: 0.8, p95: 0.8 } },
        timing: { mean: 3000, min: 3000, max: 3000, p50: 3000, p95: 3000 },
      },
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

  // ── Configurable threshold tests ────────────────────────────────

  it('uses global threshold from options', () => {
    const baseline = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.8 } },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.7 } },
      ],
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.75, min: 0.7, max: 0.8, p50: 0.75, p95: 0.8 } },
      },
    });
    const candidate = makeEvalResult({
      items: [
        { input: { q: '1' }, output: 'a', scores: { accuracy: 0.77 } },
        { input: { q: '2' }, output: 'b', scores: { accuracy: 0.68 } },
      ],
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.725, min: 0.68, max: 0.77, p50: 0.725, p95: 0.77 } },
      },
    });

    // With threshold 0, the 0.03 delta on item 1 should be flagged as regression
    const withZero = evalCompare(baseline, candidate, { thresholds: 0 });
    expect(withZero.regressions.length).toBeGreaterThan(0);

    // With threshold 0.1 (legacy), 0.03 should NOT be flagged
    const withLegacy = evalCompare(baseline, candidate, { thresholds: 0.1 });
    expect(withLegacy.regressions).toHaveLength(0);
    expect(withLegacy.improvements).toHaveLength(0);
  });

  it('uses per-scorer thresholds from options', () => {
    const baseline = makeEvalResult({
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: 0.8, tone: 0.9 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: {
          accuracy: { mean: 0.8, min: 0.8, max: 0.8, p50: 0.8, p95: 0.8 },
          tone: { mean: 0.9, min: 0.9, max: 0.9, p50: 0.9, p95: 0.9 },
        },
      },
    });
    const candidate = makeEvalResult({
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: 0.75, tone: 0.85 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: {
          accuracy: { mean: 0.75, min: 0.75, max: 0.75, p50: 0.75, p95: 0.75 },
          tone: { mean: 0.85, min: 0.85, max: 0.85, p50: 0.85, p95: 0.85 },
        },
      },
    });

    // accuracy threshold=0 → flags -0.05, tone threshold=0.1 → does NOT flag -0.05
    const comparison = evalCompare(baseline, candidate, {
      thresholds: { accuracy: 0, tone: 0.1 },
    });
    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0].scorer).toBe('accuracy');
  });

  it('auto-calibrates threshold from scorerTypes metadata', () => {
    const baseline = makeEvalResult({
      metadata: { scorerTypes: { accuracy: 'deterministic', quality: 'llm' } },
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: 0.8, quality: 0.8 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: {
          accuracy: { mean: 0.8, min: 0.8, max: 0.8, p50: 0.8, p95: 0.8 },
          quality: { mean: 0.8, min: 0.8, max: 0.8, p50: 0.8, p95: 0.8 },
        },
      },
    });
    const candidate = makeEvalResult({
      metadata: { scorerTypes: { accuracy: 'deterministic', quality: 'llm' } },
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: 0.78, quality: 0.78 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: {
          accuracy: { mean: 0.78, min: 0.78, max: 0.78, p50: 0.78, p95: 0.78 },
          quality: { mean: 0.78, min: 0.78, max: 0.78, p50: 0.78, p95: 0.78 },
        },
      },
    });

    // No explicit thresholds → auto-calibrate
    // accuracy (deterministic): threshold=0, delta=-0.02 → regression
    // quality (llm): threshold=0.05, delta=-0.02 → NOT flagged
    const comparison = evalCompare(baseline, candidate);
    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0].scorer).toBe('accuracy');
  });

  it('falls back to 0.1 threshold when no scorerTypes metadata and no explicit threshold', () => {
    // Default makeEvalResult has no scorerTypes in metadata
    const baseline = makeEvalResult({
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: 0.8 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: { accuracy: { mean: 0.8, min: 0.8, max: 0.8, p50: 0.8, p95: 0.8 } },
      },
    });
    const candidate = makeEvalResult({
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: 0.72 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: { accuracy: { mean: 0.72, min: 0.72, max: 0.72, p50: 0.72, p95: 0.72 } },
      },
    });

    // delta = -0.08, legacy threshold = 0.1 → NOT flagged
    const comparison = evalCompare(baseline, candidate);
    expect(comparison.regressions).toHaveLength(0);
  });

  it('threshold=0 with identical scores produces no regressions', () => {
    const baseline = makeEvalResult();
    const candidate = makeEvalResult();

    const comparison = evalCompare(baseline, candidate, { thresholds: 0 });
    expect(comparison.regressions).toHaveLength(0);
    expect(comparison.improvements).toHaveLength(0);
  });

  // ── Bootstrap CI tests ──────────────────────────────────────

  it('attaches CI data to scorers when sufficient items exist', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      input: { q: String(i) },
      output: 'a',
      scores: { accuracy: 0.7 + i * 0.02 },
    }));
    const baseline = makeEvalResult({
      items,
      summary: {
        count: 10,
        failures: 0,
        scorers: { accuracy: { mean: 0.79, min: 0.7, max: 0.88, p50: 0.79, p95: 0.88 } },
      },
    });
    const candidateItems = items.map((item) => ({
      ...item,
      scores: { accuracy: (item.scores.accuracy as number) + 0.05 },
    }));
    const candidate = makeEvalResult({
      id: 'cand',
      items: candidateItems,
      summary: {
        count: 10,
        failures: 0,
        scorers: { accuracy: { mean: 0.84, min: 0.75, max: 0.93, p50: 0.84, p95: 0.93 } },
      },
    });

    const comparison = evalCompare(baseline, candidate);
    expect(comparison.scorers.accuracy.ci).toBeDefined();
    expect(comparison.scorers.accuracy.ci!.lower).toBeDefined();
    expect(comparison.scorers.accuracy.ci!.upper).toBeDefined();
  });

  it('marks scorer as significant when CI does not cross zero', () => {
    // All items improve by +0.2 — CI should be entirely above zero
    const items = Array.from({ length: 10 }, (_, i) => ({
      input: { q: String(i) },
      output: 'a',
      scores: { accuracy: 0.5 },
    }));
    const candidateItems = items.map((item) => ({
      ...item,
      scores: { accuracy: 0.7 },
    }));
    const baseline = makeEvalResult({
      items,
      summary: {
        count: 10,
        failures: 0,
        scorers: { accuracy: { mean: 0.5, min: 0.5, max: 0.5, p50: 0.5, p95: 0.5 } },
      },
    });
    const candidate = makeEvalResult({
      id: 'cand',
      items: candidateItems,
      summary: {
        count: 10,
        failures: 0,
        scorers: { accuracy: { mean: 0.7, min: 0.7, max: 0.7, p50: 0.7, p95: 0.7 } },
      },
    });

    const comparison = evalCompare(baseline, candidate, { thresholds: 0 });
    expect(comparison.scorers.accuracy.significant).toBe(true);
  });

  it('marks scorer as not significant when CI spans zero', () => {
    // Items alternate between small positive and negative changes
    const items = Array.from({ length: 10 }, (_, i) => ({
      input: { q: String(i) },
      output: 'a',
      scores: { accuracy: 0.5 },
    }));
    const candidateItems = items.map((item, i) => ({
      ...item,
      scores: { accuracy: i % 2 === 0 ? 0.52 : 0.48 },
    }));
    const baseline = makeEvalResult({
      items,
      summary: {
        count: 10,
        failures: 0,
        scorers: { accuracy: { mean: 0.5, min: 0.5, max: 0.5, p50: 0.5, p95: 0.5 } },
      },
    });
    const candidate = makeEvalResult({
      id: 'cand',
      items: candidateItems,
      summary: {
        count: 10,
        failures: 0,
        scorers: { accuracy: { mean: 0.5, min: 0.48, max: 0.52, p50: 0.5, p95: 0.52 } },
      },
    });

    const comparison = evalCompare(baseline, candidate, { thresholds: 0 });
    expect(comparison.scorers.accuracy.significant).toBe(false);
  });

  it('omits CI when fewer than 2 paired items', () => {
    const baseline = makeEvalResult({
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: 0.8 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: { accuracy: { mean: 0.8, min: 0.8, max: 0.8, p50: 0.8, p95: 0.8 } },
      },
    });
    const candidate = makeEvalResult({
      items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: 0.9 } }],
      summary: {
        count: 1,
        failures: 0,
        scorers: { accuracy: { mean: 0.9, min: 0.9, max: 0.9, p50: 0.9, p95: 0.9 } },
      },
    });

    const comparison = evalCompare(baseline, candidate);
    expect(comparison.scorers.accuracy.ci).toBeUndefined();
    expect(comparison.scorers.accuracy.significant).toBeUndefined();
  });

  it('includes significance indicator in summary string', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      input: { q: String(i) },
      output: 'a',
      scores: { accuracy: 0.5 },
    }));
    const candidateItems = items.map((item) => ({
      ...item,
      scores: { accuracy: 0.7 },
    }));
    const baseline = makeEvalResult({
      metadata: { scorerTypes: { accuracy: 'deterministic' } },
      items,
      summary: {
        count: 10,
        failures: 0,
        scorers: { accuracy: { mean: 0.5, min: 0.5, max: 0.5, p50: 0.5, p95: 0.5 } },
      },
    });
    const candidate = makeEvalResult({
      id: 'cand',
      metadata: { scorerTypes: { accuracy: 'deterministic' } },
      items: candidateItems,
      summary: {
        count: 10,
        failures: 0,
        scorers: { accuracy: { mean: 0.7, min: 0.7, max: 0.7, p50: 0.7, p95: 0.7 } },
      },
    });

    const comparison = evalCompare(baseline, candidate);
    expect(comparison.summary).toContain('significant');
  });

  // ── Multi-run array comparison tests ────────────────────────

  it('accepts arrays of EvalResult and pools items across runs', () => {
    const makeRun = (scoreMean: number) =>
      makeEvalResult({
        items: Array.from({ length: 5 }, (_, i) => ({
          input: { q: String(i) },
          output: 'a',
          scores: { accuracy: scoreMean },
        })),
        summary: {
          count: 5,
          failures: 0,
          scorers: {
            accuracy: {
              mean: scoreMean,
              min: scoreMean,
              max: scoreMean,
              p50: scoreMean,
              p95: scoreMean,
            },
          },
        },
      });

    const baselineRuns = [makeRun(0.5), makeRun(0.55), makeRun(0.52)];
    const candidateRuns = [makeRun(0.7), makeRun(0.75), makeRun(0.72)];

    const comparison = evalCompare(baselineRuns, candidateRuns, { thresholds: 0 });

    // Should have aggregated means across runs
    expect(comparison.scorers.accuracy.baselineMean).toBeCloseTo(0.523, 1);
    expect(comparison.scorers.accuracy.candidateMean).toBeCloseTo(0.723, 1);
    // CI should be computed from pooled 15 items (5 items × 3 runs)
    expect(comparison.scorers.accuracy.ci).toBeDefined();
  });

  it('normalizes single EvalResult to array internally', () => {
    const baseline = makeEvalResult();
    const candidate = makeEvalResult();

    // Should work the same whether passed as single or array
    const single = evalCompare(baseline, candidate);
    const asArray = evalCompare([baseline], [candidate]);

    expect(single.scorers).toEqual(asArray.scorers);
    expect(single.regressions.length).toBe(asArray.regressions.length);
  });

  it('handles mismatched run counts by using minimum', () => {
    const makeRun = (score: number) =>
      makeEvalResult({
        items: [{ input: { q: '1' }, output: 'a', scores: { accuracy: score } }],
        summary: {
          count: 1,
          failures: 0,
          scorers: {
            accuracy: { mean: score, min: score, max: score, p50: score, p95: score },
          },
        },
      });

    const baselineRuns = [makeRun(0.5), makeRun(0.55)];
    const candidateRuns = [makeRun(0.7), makeRun(0.75), makeRun(0.72)];

    // Should not throw — uses min(2, 3) = 2 runs for paired diffs
    const comparison = evalCompare(baselineRuns, candidateRuns, { thresholds: 0 });
    expect(comparison.scorers.accuracy).toBeDefined();
    expect(comparison.scorers.accuracy.ci).toBeDefined();
  });

  it('multi-run provides tighter CI with more data points', () => {
    const makeRun = (baseScore: number, candScore: number) => ({
      baseline: makeEvalResult({
        items: Array.from({ length: 5 }, (_, i) => ({
          input: { q: String(i) },
          output: 'a',
          scores: { accuracy: baseScore + (i % 2 === 0 ? 0.01 : -0.01) },
        })),
        summary: {
          count: 5,
          failures: 0,
          scorers: {
            accuracy: {
              mean: baseScore,
              min: baseScore - 0.01,
              max: baseScore + 0.01,
              p50: baseScore,
              p95: baseScore + 0.01,
            },
          },
        },
      }),
      candidate: makeEvalResult({
        id: 'cand',
        items: Array.from({ length: 5 }, (_, i) => ({
          input: { q: String(i) },
          output: 'a',
          scores: { accuracy: candScore + (i % 2 === 0 ? 0.01 : -0.01) },
        })),
        summary: {
          count: 5,
          failures: 0,
          scorers: {
            accuracy: {
              mean: candScore,
              min: candScore - 0.01,
              max: candScore + 0.01,
              p50: candScore,
              p95: candScore + 0.01,
            },
          },
        },
      }),
    });

    const run1 = makeRun(0.5, 0.6);
    const run2 = makeRun(0.5, 0.6);
    const run3 = makeRun(0.5, 0.6);

    // Single run: 5 paired diffs
    const singleCI = evalCompare(run1.baseline, run1.candidate, { thresholds: 0 });
    // Multi run: 15 paired diffs
    const multiCI = evalCompare(
      [run1.baseline, run2.baseline, run3.baseline],
      [run1.candidate, run2.candidate, run3.candidate],
      { thresholds: 0 },
    );

    expect(singleCI.scorers.accuracy.ci).toBeDefined();
    expect(multiCI.scorers.accuracy.ci).toBeDefined();
    // Both CIs should indicate the same direction
    expect(multiCI.scorers.accuracy.ci!.lower).toBeGreaterThan(0);
    expect(singleCI.scorers.accuracy.ci!.lower).toBeGreaterThan(0);
  });

  it('propagates pRegression, pImprovement, and n from bootstrap CI', () => {
    // Candidate is clearly better than baseline for all items
    const items = Array.from({ length: 10 }, (_, i) => ({
      input: { q: String(i) },
      output: 'a',
      scores: { accuracy: 0.4 },
    }));
    const candidateItems = items.map((item) => ({
      ...item,
      scores: { accuracy: 0.8 },
    }));
    const baseline = makeEvalResult({
      items,
      summary: {
        count: 10,
        failures: 0,
        scorers: { accuracy: { mean: 0.4, min: 0.4, max: 0.4, p50: 0.4, p95: 0.4 } },
      },
    });
    const candidate = makeEvalResult({
      id: 'cand',
      items: candidateItems,
      summary: {
        count: 10,
        failures: 0,
        scorers: { accuracy: { mean: 0.8, min: 0.8, max: 0.8, p50: 0.8, p95: 0.8 } },
      },
    });

    const comparison = evalCompare(baseline, candidate);

    // pRegression and pImprovement are numbers propagated from pairedBootstrapCI
    expect(typeof comparison.scorers.accuracy.pRegression).toBe('number');
    expect(typeof comparison.scorers.accuracy.pImprovement).toBe('number');
    // n equals the number of paired item differences
    expect(comparison.scorers.accuracy.n).toBe(10);
    // Clear improvement: pImprovement should be very high
    expect(comparison.scorers.accuracy.pImprovement).toBeGreaterThan(0.9);
  });

  it('multi-run averages per-item scores for regression/improvement detection', () => {
    // Item 0: baseline avg 0.5, candidate avg 0.9 -> improvement
    // Item 1: baseline avg 0.8, candidate avg 0.3 -> regression
    const baselineRun1 = makeEvalResult({
      id: 'b1',
      items: [
        { input: { q: '0' }, output: 'a', scores: { accuracy: 0.4 } },
        { input: { q: '1' }, output: 'b', scores: { accuracy: 0.7 } },
      ],
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.55, min: 0.4, max: 0.7, p50: 0.55, p95: 0.7 } },
      },
    });
    const baselineRun2 = makeEvalResult({
      id: 'b2',
      items: [
        { input: { q: '0' }, output: 'a', scores: { accuracy: 0.6 } },
        { input: { q: '1' }, output: 'b', scores: { accuracy: 0.9 } },
      ],
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.75, min: 0.6, max: 0.9, p50: 0.75, p95: 0.9 } },
      },
    });
    const candidateRun1 = makeEvalResult({
      id: 'c1',
      items: [
        { input: { q: '0' }, output: 'a', scores: { accuracy: 0.85 } },
        { input: { q: '1' }, output: 'b', scores: { accuracy: 0.35 } },
      ],
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.6, min: 0.35, max: 0.85, p50: 0.6, p95: 0.85 } },
      },
    });
    const candidateRun2 = makeEvalResult({
      id: 'c2',
      items: [
        { input: { q: '0' }, output: 'a', scores: { accuracy: 0.95 } },
        { input: { q: '1' }, output: 'b', scores: { accuracy: 0.25 } },
      ],
      summary: {
        count: 2,
        failures: 0,
        scorers: { accuracy: { mean: 0.6, min: 0.25, max: 0.95, p50: 0.6, p95: 0.95 } },
      },
    });

    const comparison = evalCompare([baselineRun1, baselineRun2], [candidateRun1, candidateRun2], {
      thresholds: 0,
    });

    // Item 0: baseline avg (0.4+0.6)/2=0.5, candidate avg (0.85+0.95)/2=0.9 -> improvement
    expect(comparison.improvements).toHaveLength(1);
    expect(comparison.improvements[0].itemIndex).toBe(0);

    // Item 1: baseline avg (0.7+0.9)/2=0.8, candidate avg (0.35+0.25)/2=0.3 -> regression
    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0].itemIndex).toBe(1);
  });

  it('handles comparison where all items have errors', () => {
    const baseline = makeEvalResult({
      items: [
        { input: { q: '1' }, output: null, error: 'failed', scores: { accuracy: null } },
        { input: { q: '2' }, output: null, error: 'failed', scores: { accuracy: null } },
      ],
      summary: {
        count: 2,
        failures: 2,
        scorers: { accuracy: { mean: 0, min: 0, max: 0, p50: 0, p95: 0 } },
      },
    });
    const candidate = makeEvalResult({
      items: [
        { input: { q: '1' }, output: null, error: 'failed', scores: { accuracy: null } },
        { input: { q: '2' }, output: null, error: 'failed', scores: { accuracy: null } },
      ],
      summary: {
        count: 2,
        failures: 2,
        scorers: { accuracy: { mean: 0, min: 0, max: 0, p50: 0, p95: 0 } },
      },
    });

    const comparison = evalCompare(baseline, candidate);

    // No paired diffs possible — CI should be undefined
    expect(comparison.scorers.accuracy.ci).toBeUndefined();
    expect(comparison.scorers.accuracy.significant).toBeUndefined();
    expect(comparison.regressions).toHaveLength(0);
    expect(comparison.improvements).toHaveLength(0);
  });
});
