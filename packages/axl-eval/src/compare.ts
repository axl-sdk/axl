import type {
  EvalResult,
  EvalComparison,
  EvalCompareOptions,
  EvalRegression,
  EvalImprovement,
} from './types.js';
import { pairedBootstrapCI } from './bootstrap.js';

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const DEFAULT_LLM_THRESHOLD = 0.05;
const DEFAULT_DETERMINISTIC_THRESHOLD = 0;
const LEGACY_THRESHOLD = 0.1;

function resolveThreshold(
  scorerName: string,
  options: EvalCompareOptions | undefined,
  metadata: Record<string, unknown>,
): number {
  // Explicit global threshold
  if (typeof options?.thresholds === 'number') return options.thresholds;

  // Per-scorer threshold map
  if (options?.thresholds && typeof options.thresholds === 'object') {
    const perScorer = options.thresholds[scorerName];
    if (perScorer != null) return perScorer;
    // Fall through to auto-calibration if scorer not in map
  }

  // Auto-calibrate from scorerTypes metadata
  const scorerTypes = metadata.scorerTypes as Record<string, string> | undefined;
  if (scorerTypes && scorerName in scorerTypes) {
    return scorerTypes[scorerName] === 'llm'
      ? DEFAULT_LLM_THRESHOLD
      : DEFAULT_DETERMINISTIC_THRESHOLD;
  }

  // Legacy fallback for results without scorerTypes
  return LEGACY_THRESHOLD;
}

export function evalCompare(
  baseline: EvalResult | EvalResult[],
  candidate: EvalResult | EvalResult[],
  options?: EvalCompareOptions,
): EvalComparison {
  const baselineRuns = Array.isArray(baseline) ? baseline : [baseline];
  const candidateRuns = Array.isArray(candidate) ? candidate : [candidate];

  if (baselineRuns.length === 0 || candidateRuns.length === 0) {
    throw new Error('Cannot compare empty eval result arrays');
  }

  // Use the first run as representative for metadata, dataset, scorers
  const baselineRef = baselineRuns[0];
  const candidateRef = candidateRuns[0];

  if (baselineRef.dataset !== candidateRef.dataset) {
    throw new Error(
      `Cannot compare evals from different datasets: "${baselineRef.dataset}" vs "${candidateRef.dataset}"`,
    );
  }

  const baselineScorerNames = Object.keys(baselineRef.summary.scorers).sort();
  const candidateScorerNames = Object.keys(candidateRef.summary.scorers).sort();
  if (JSON.stringify(baselineScorerNames) !== JSON.stringify(candidateScorerNames)) {
    throw new Error(`Cannot compare evals with different scorers`);
  }

  // Collect per-item paired differences for each scorer across all runs (used for bootstrap CI).
  // For multi-run: pool differences from all (baselineRun[r].items[i], candidateRun[r].items[i]) pairs.
  const pairedDiffs: Record<string, number[]> = {};
  for (const name of baselineScorerNames) {
    pairedDiffs[name] = [];
  }
  const runCount = Math.min(baselineRuns.length, candidateRuns.length);
  for (let r = 0; r < runCount; r++) {
    const bRun = baselineRuns[r];
    const cRun = candidateRuns[r];
    const minLength = Math.min(bRun.items.length, cRun.items.length);
    for (let i = 0; i < minLength; i++) {
      const bItem = bRun.items[i];
      const cItem = cRun.items[i];
      if (bItem.error || cItem.error) continue;
      for (const name of baselineScorerNames) {
        const bScore = bItem.scores[name];
        const cScore = cItem.scores[name];
        if (bScore != null && cScore != null) {
          pairedDiffs[name].push(cScore - bScore);
        }
      }
    }
  }

  // Compute aggregate means across runs
  const baselineMeans: Record<string, number> = {};
  const candidateMeans: Record<string, number> = {};
  for (const name of baselineScorerNames) {
    baselineMeans[name] =
      baselineRuns.reduce((sum, r) => sum + (r.summary.scorers[name]?.mean ?? 0), 0) /
      baselineRuns.length;
    candidateMeans[name] =
      candidateRuns.reduce((sum, r) => sum + (r.summary.scorers[name]?.mean ?? 0), 0) /
      candidateRuns.length;
  }

  const scorers: EvalComparison['scorers'] = {};
  for (const name of baselineScorerNames) {
    const bMeanRaw = baselineMeans[name];
    const cMeanRaw = candidateMeans[name];
    const deltaRaw = cMeanRaw - bMeanRaw;
    const bMean = round(bMeanRaw);
    const cMean = round(cMeanRaw);
    const delta = round(deltaRaw);
    const deltaPercent = bMeanRaw > 0 ? round((deltaRaw / bMeanRaw) * 100) : 0;
    const threshold = resolveThreshold(name, options, baselineRef.metadata);

    const entry: EvalComparison['scorers'][string] = {
      baselineMean: bMean,
      candidateMean: cMean,
      delta,
      deltaPercent,
    };

    // Compute bootstrap CI when we have enough paired data
    const diffs = pairedDiffs[name];
    if (diffs.length >= 2) {
      const ci = pairedBootstrapCI(diffs);
      entry.ci = { lower: ci.lower, upper: ci.upper };
      entry.pRegression = ci.pRegression;
      entry.pImprovement = ci.pImprovement;
      entry.n = diffs.length;
      // Significant when CI excludes zero AND delta exceeds practical threshold
      const ciExcludesZero = ci.lower > 0 || ci.upper < 0;
      entry.significant = ciExcludesZero && Math.abs(ci.mean) >= threshold;
    }

    scorers[name] = entry;
  }

  // Per-item regressions/improvements.
  // For multi-run: average each item's score across runs to get a stable per-item comparison.
  const regressions: EvalRegression[] = [];
  const improvements: EvalImprovement[] = [];

  const itemCount = Math.min(
    ...baselineRuns.map((r) => r.items.length),
    ...candidateRuns.map((r) => r.items.length),
  );

  for (let i = 0; i < itemCount; i++) {
    // Check if any run has an error for this item
    const hasBaselineError = baselineRuns.some((r) => r.items[i]?.error);
    const hasCandidateError = candidateRuns.some((r) => r.items[i]?.error);
    if (hasBaselineError || hasCandidateError) continue;

    for (const name of baselineScorerNames) {
      // Average this item's score across all runs on each side
      const bScores = baselineRuns
        .map((r) => r.items[i]?.scores[name])
        .filter((s): s is number => s != null);
      const cScores = candidateRuns
        .map((r) => r.items[i]?.scores[name])
        .filter((s): s is number => s != null);
      if (bScores.length === 0 || cScores.length === 0) continue;

      const bAvg = bScores.reduce((a, b) => a + b, 0) / bScores.length;
      const cAvg = cScores.reduce((a, b) => a + b, 0) / cScores.length;
      const delta = round(cAvg - bAvg);
      const threshold = resolveThreshold(name, options, baselineRef.metadata);
      if (delta < -threshold)
        regressions.push({
          itemIndex: i,
          input: baselineRef.items[i]?.input,
          scorer: name,
          baselineScore: round(bAvg),
          candidateScore: round(cAvg),
          delta,
        });
      else if (delta > threshold)
        improvements.push({
          itemIndex: i,
          input: baselineRef.items[i]?.input,
          scorer: name,
          baselineScore: round(bAvg),
          candidateScore: round(cAvg),
          delta,
        });
    }
  }

  // Timing comparison (average across all runs for multi-run)
  let timing: EvalComparison['timing'];
  const baselineTimings = baselineRuns
    .filter((r) => r.summary.timing)
    .map((r) => r.summary.timing!.mean);
  const candidateTimings = candidateRuns
    .filter((r) => r.summary.timing)
    .map((r) => r.summary.timing!.mean);
  if (baselineTimings.length > 0 && candidateTimings.length > 0) {
    const bMean = baselineTimings.reduce((a, b) => a + b, 0) / baselineTimings.length;
    const cMean = candidateTimings.reduce((a, b) => a + b, 0) / candidateTimings.length;
    const delta = round(cMean - bMean);
    const deltaPercent = bMean > 0 ? round(((cMean - bMean) / bMean) * 100) : 0;
    timing = { baselineMean: round(bMean), candidateMean: round(cMean), delta, deltaPercent };
  }

  // Cost comparison (per-run average for multi-run)
  let cost: EvalComparison['cost'];
  const baselineAvgCost =
    baselineRuns.reduce((sum, r) => sum + r.totalCost, 0) / baselineRuns.length;
  const candidateAvgCost =
    candidateRuns.reduce((sum, r) => sum + r.totalCost, 0) / candidateRuns.length;
  if (baselineAvgCost > 0 || candidateAvgCost > 0) {
    const deltaRaw = candidateAvgCost - baselineAvgCost;
    const delta = round(deltaRaw);
    const deltaPercent = baselineAvgCost > 0 ? round((deltaRaw / baselineAvgCost) * 100) : 0;
    cost = {
      baselineTotal: round(baselineAvgCost),
      candidateTotal: round(candidateAvgCost),
      delta,
      deltaPercent,
    };
  }

  const parts: string[] = [];
  for (const name of baselineScorerNames) {
    const s = scorers[name];
    if (Math.abs(s.delta) > 0.001) {
      const direction = s.delta > 0 ? 'improves' : 'regresses';
      const sign = s.delta > 0 ? '+' : '';
      let sigLabel = '';
      if (s.significant === true) sigLabel = ' (significant)';
      else if (s.significant === false) sigLabel = ' (not significant)';
      parts.push(
        `'${name}' ${direction} by ${sign}${s.deltaPercent.toFixed(1)}% (${s.baselineMean.toFixed(2)} -> ${s.candidateMean.toFixed(2)})${sigLabel}`,
      );
    }
  }
  if (timing && Math.abs(timing.deltaPercent) > 1) {
    const dir = timing.delta > 0 ? 'slower' : 'faster';
    parts.push(`${Math.abs(timing.deltaPercent).toFixed(0)}% ${dir}`);
  }
  if (cost && Math.abs(cost.deltaPercent) > 1) {
    const dir = cost.delta > 0 ? 'more expensive' : 'cheaper';
    parts.push(`${Math.abs(cost.deltaPercent).toFixed(0)}% ${dir}`);
  }
  const summaryStr = `candidate ${parts.length > 0 ? parts.join(', ') : 'no meaningful changes'} with ${regressions.length} regressions and ${improvements.length} improvements`;

  return {
    baseline: { id: baselineRef.id, metadata: baselineRef.metadata },
    candidate: { id: candidateRef.id, metadata: candidateRef.metadata },
    scorers,
    timing,
    cost,
    regressions,
    improvements,
    summary: summaryStr,
  };
}
