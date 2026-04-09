export function computeStats(scores: number[]): {
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
} {
  if (scores.length === 0) return { mean: 0, min: 0, max: 0, p50: 0, p95: 0 };
  const sorted = [...scores].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  return { mean: round(mean), min: round(min), max: round(max), p50: round(p50), p95: round(p95) };
}

export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
