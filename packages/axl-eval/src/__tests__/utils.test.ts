import { describe, it, expect } from 'vitest';
import { computeStats, round, mapWithConcurrency } from '../utils.js';

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

describe('mapWithConcurrency()', () => {
  it('returns [] for an empty array without hanging', async () => {
    const result = await mapWithConcurrency([], 5, async () => 1);
    expect(result).toEqual([]);
  });

  it('preserves input order regardless of completion order', async () => {
    // Item 0 resolves last, item 2 first — output must still be [0, 2, 4].
    const delays = [30, 10, 0];
    const result = await mapWithConcurrency([0, 1, 2], 3, async (n) => {
      await new Promise((r) => setTimeout(r, delays[n]));
      return n * 2;
    });
    expect(result).toEqual([0, 2, 4]);
  });

  it('coerces non-finite / fractional concurrency instead of running zero workers', async () => {
    // Regression: Math.max(1, NaN) === NaN → Array.from({length:NaN}) === []
    // → zero workers → results full of `undefined` holes. Must coerce to 1.
    for (const bad of [NaN, Infinity, -Infinity]) {
      const result = await mapWithConcurrency([1, 2, 3], bad as number, async (n) => n * 10);
      expect(result).toEqual([10, 20, 30]);
    }
    // Fractional floors to an integer worker count but still runs every item.
    const frac = await mapWithConcurrency([1, 2, 3, 4], 2.9, async (n) => n);
    expect(frac).toEqual([1, 2, 3, 4]);
  });

  it('clamps concurrency <= 0 to one worker (does not hang)', async () => {
    let maxInFlight = 0;
    let inFlight = 0;
    const result = await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n;
    });
    expect(result).toEqual([1, 2, 3]);
    expect(maxInFlight).toBe(1);
  });

  it('bounds concurrency to the requested width', async () => {
    let maxInFlight = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n;
    });
    expect(maxInFlight).toBe(2);
  });

  it('does not reject the batch when a task handles its own error', async () => {
    // The helper does not catch — tasks must own try/catch. A task that resolves
    // (after internally swallowing an error) keeps the pool draining.
    const result = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      try {
        if (n === 2) throw new Error('boom');
        return n;
      } catch {
        return -1;
      }
    });
    expect(result).toEqual([1, -1, 3]);
  });
});
