export type BootstrapCIResult = {
  /** Lower bound of the confidence interval. */
  lower: number;
  /** Upper bound of the confidence interval. */
  upper: number;
  /** Mean of the original differences. */
  mean: number;
};

/**
 * Compute a bootstrap confidence interval on paired differences.
 *
 * Resamples the differences array with replacement, computes the mean of each
 * resample, and returns the percentile-based confidence interval.
 */
export function pairedBootstrapCI(
  differences: number[],
  options?: { nResamples?: number; alpha?: number; seed?: number },
): BootstrapCIResult {
  const n = differences.length;
  if (n === 0) return { lower: 0, upper: 0, mean: 0 };

  const nResamples = options?.nResamples ?? 1000;
  const alpha = options?.alpha ?? 0.05;

  const mean = differences.reduce((a, b) => a + b, 0) / n;

  if (n === 1) return { lower: differences[0], upper: differences[0], mean };

  if (nResamples <= 0) return { lower: round(mean), upper: round(mean), mean: round(mean) };

  // Seeded or random number generator
  const rng = options?.seed != null ? xorshift32(options.seed) : () => Math.random();

  const resampleMeans: number[] = new Array(nResamples);
  for (let r = 0; r < nResamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += differences[Math.floor(rng() * n)];
    }
    resampleMeans[r] = sum / n;
  }

  resampleMeans.sort((a, b) => a - b);

  const lowerIdx = Math.floor((alpha / 2) * nResamples);
  const upperIdx = Math.floor((1 - alpha / 2) * nResamples) - 1;

  return {
    lower: round(resampleMeans[Math.max(0, lowerIdx)]),
    upper: round(resampleMeans[Math.min(nResamples - 1, upperIdx)]),
    mean: round(mean),
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Simple xorshift32 PRNG for deterministic test behavior. Returns values in [0, 1). */
function xorshift32(seed: number): () => number {
  let state = seed | 0 || 1; // Ensure non-zero
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}
