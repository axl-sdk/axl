import { describe, it, expect } from 'vitest';
import { computeStats, round } from '../utils.js';

describe('computeStats()', () => {
  it('returns zeros for empty array', () => {
    expect(computeStats([])).toEqual({ mean: 0, min: 0, max: 0, p50: 0, p95: 0 });
  });

  it('returns the value for single-element array', () => {
    expect(computeStats([0.5])).toEqual({ mean: 0.5, min: 0.5, max: 0.5, p50: 0.5, p95: 0.5 });
  });

  it('computes correct stats for three elements', () => {
    const stats = computeStats([0.1, 0.5, 0.9]);
    expect(stats.mean).toBe(0.5);
    expect(stats.min).toBe(0.1);
    expect(stats.max).toBe(0.9);
    expect(stats.p50).toBe(0.5);
    expect(stats.p95).toBe(0.9);
  });
});

describe('round()', () => {
  it('rounds to 3 decimal places', () => {
    expect(round(0.1234)).toBe(0.123);
  });

  it('rounds up at midpoint', () => {
    expect(round(0.1235)).toBe(0.124);
  });
});
