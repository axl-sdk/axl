import { describe, it, expect } from 'vitest';
import { pairedBootstrapCI } from '../bootstrap.js';

describe('pairedBootstrapCI()', () => {
  it('returns mean close to actual mean of differences', () => {
    const diffs = [0.1, 0.2, 0.15, 0.12, 0.18, 0.22, 0.08, 0.14, 0.19, 0.16];
    const actual = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const result = pairedBootstrapCI(diffs, { seed: 42 });
    expect(result.mean).toBeCloseTo(actual, 2);
  });

  it('returns CI containing zero when all differences are zero', () => {
    const diffs = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const result = pairedBootstrapCI(diffs, { seed: 42 });
    expect(result.lower).toBe(0);
    expect(result.upper).toBe(0);
    expect(result.mean).toBe(0);
  });

  it('returns CI entirely above zero for large positive differences', () => {
    const diffs = [0.5, 0.6, 0.55, 0.52, 0.58, 0.62, 0.48, 0.54, 0.59, 0.56];
    const result = pairedBootstrapCI(diffs, { seed: 42 });
    expect(result.lower).toBeGreaterThan(0);
    expect(result.upper).toBeGreaterThan(0);
  });

  it('returns CI spanning zero for mixed differences', () => {
    const diffs = [0.1, -0.1, 0.05, -0.05, 0.02, -0.02, 0.08, -0.08, 0.03, -0.03];
    const result = pairedBootstrapCI(diffs, { seed: 42 });
    expect(result.lower).toBeLessThanOrEqual(0);
    expect(result.upper).toBeGreaterThanOrEqual(0);
  });

  it('produces deterministic results with seed', () => {
    const diffs = [0.1, 0.2, 0.15, -0.05, 0.3];
    const result1 = pairedBootstrapCI(diffs, { seed: 123 });
    const result2 = pairedBootstrapCI(diffs, { seed: 123 });
    expect(result1).toEqual(result2);
  });

  it('returns degenerate CI for single value', () => {
    const result = pairedBootstrapCI([0.5], { seed: 42 });
    expect(result.lower).toBe(0.5);
    expect(result.upper).toBe(0.5);
    expect(result.mean).toBe(0.5);
    expect(result.pImprovement).toBe(1);
    expect(result.pRegression).toBe(0);
  });

  it('returns pRegression=1, pImprovement=0 for single negative value', () => {
    const result = pairedBootstrapCI([-0.3], { seed: 42 });
    expect(result.pRegression).toBe(1);
    expect(result.pImprovement).toBe(0);
  });

  it('respects custom alpha for narrower/wider CI', () => {
    const diffs = [0.1, 0.2, 0.15, 0.12, 0.18, 0.22, 0.08, 0.14, 0.19, 0.16];
    const ci95 = pairedBootstrapCI(diffs, { seed: 42, alpha: 0.05 });
    const ci99 = pairedBootstrapCI(diffs, { seed: 42, alpha: 0.01 });
    // 99% CI should be wider than 95% CI
    expect(ci99.upper - ci99.lower).toBeGreaterThanOrEqual(ci95.upper - ci95.lower);
  });

  it('returns mean as both bounds when nResamples is 0', () => {
    const result = pairedBootstrapCI([0.1, 0.2], { nResamples: 0, seed: 42 });
    expect(result.lower).toBe(0.15);
    expect(result.upper).toBe(0.15);
    expect(result.mean).toBe(0.15);
    expect(result.pImprovement).toBe(1);
    expect(result.pRegression).toBe(0);
  });

  it('handles seed of 0 without error', () => {
    const result = pairedBootstrapCI([0.1, 0.2], { seed: 0 });
    expect(result.mean).toBeCloseTo(0.15, 2);
    expect(result.lower).toBeLessThanOrEqual(result.upper);
  });

  it('handles empty array', () => {
    const result = pairedBootstrapCI([]);
    expect(result.lower).toBe(0);
    expect(result.upper).toBe(0);
    expect(result.mean).toBe(0);
    expect(result.pRegression).toBe(0);
    expect(result.pImprovement).toBe(0);
  });

  it('returns pRegression close to 1 for consistently negative differences', () => {
    const diffs = [-0.1, -0.2, -0.15, -0.12, -0.18, -0.22, -0.08, -0.14, -0.19, -0.16];
    const result = pairedBootstrapCI(diffs, { seed: 42 });
    expect(result.pRegression).toBeGreaterThan(0.95);
    expect(result.pImprovement).toBeLessThan(0.05);
  });

  it('returns balanced probabilities for mixed differences', () => {
    const diffs = [0.1, -0.1, 0.05, -0.05, 0.02, -0.02, 0.08, -0.08, 0.03, -0.03];
    const result = pairedBootstrapCI(diffs, { seed: 42 });
    // Neither direction should dominate
    expect(result.pRegression).toBeGreaterThan(0.1);
    expect(result.pImprovement).toBeGreaterThan(0.1);
  });
});
