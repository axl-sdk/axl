import type { EvalResult } from './types.js';
import { randomUUID } from 'node:crypto';
import { round } from './utils.js';

export type MultiRunSummary = {
  runGroupId: string;
  runCount: number;
  workflow: string;
  dataset: string;
  totalCost: number;
  totalDuration: number;
  scorers: Record<string, { mean: number; std: number; min: number; max: number }>;
  timing?: { mean: number; std: number };
};

function std(values: number[], mean: number): number {
  if (values.length <= 1) return 0;
  const sumSqDiffs = values.reduce((sum, v) => sum + (v - mean) ** 2, 0);
  return Math.sqrt(sumSqDiffs / (values.length - 1));
}

/**
 * Aggregate multiple eval runs into a summary with mean +/- std per scorer.
 */
export function aggregateRuns(runs: EvalResult[]): MultiRunSummary {
  if (runs.length === 0) throw new Error('Cannot aggregate zero runs');

  const runGroupId = (runs[0].metadata.runGroupId as string) ?? randomUUID();
  const { workflow, dataset } = runs[0];

  const totalCost = runs.reduce((sum, r) => sum + r.totalCost, 0);
  const totalDuration = runs.reduce((sum, r) => sum + r.duration, 0);

  // Collect per-scorer means from each run
  const scorerNames = Object.keys(runs[0].summary.scorers);
  const scorers: MultiRunSummary['scorers'] = {};

  for (const name of scorerNames) {
    const means = runs.map((r) => r.summary.scorers[name]?.mean ?? 0);
    const meanOfMeans = means.reduce((a, b) => a + b, 0) / means.length;
    const minMean = Math.min(...means);
    const maxMean = Math.max(...means);

    scorers[name] = {
      mean: round(meanOfMeans),
      std: round(std(means, meanOfMeans)),
      min: round(minMean),
      max: round(maxMean),
    };
  }

  // Timing aggregation
  let timing: MultiRunSummary['timing'];
  const timingMeans = runs.filter((r) => r.summary.timing).map((r) => r.summary.timing!.mean);
  if (timingMeans.length === runs.length && timingMeans.length > 0) {
    const meanTiming = timingMeans.reduce((a, b) => a + b, 0) / timingMeans.length;
    timing = {
      mean: round(meanTiming),
      std: round(std(timingMeans, meanTiming)),
    };
  }

  return {
    runGroupId,
    runCount: runs.length,
    workflow,
    dataset,
    totalCost: round(totalCost),
    totalDuration: round(totalDuration),
    scorers,
    timing,
  };
}
