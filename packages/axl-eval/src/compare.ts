import type {
  EvalResult,
  EvalComparison,
  EvalCompareOptions,
  EvalRegression,
  EvalImprovement,
} from './types.js';
import { pairedBootstrapCI } from './bootstrap.js';
import { scorerCounts, evaluateScorerTolerance, round } from './utils.js';

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
  const baselineRunsRaw = Array.isArray(baseline) ? baseline : [baseline];
  const candidateRunsRaw = Array.isArray(candidate) ? candidate : [candidate];

  if (baselineRunsRaw.length === 0 || candidateRunsRaw.length === 0) {
    throw new Error('Cannot compare empty eval result arrays');
  }

  // Truncate both sides to a common run count BEFORE computing anything. The
  // paired bootstrap CI was already restricted to `min(baseline, candidate)`
  // runs (a CI over paired diffs requires equal-length sides), but means /
  // regressions / timing / cost previously used the full-length pool on each
  // side. That hybrid produced an internally inconsistent view: a 5-run
  // baseline vs 2-run candidate showed `delta = mean(5) - mean(2)` next to
  // a CI computed over only 2 paired diffs, so the user couldn't tell the
  // numbers were drawn from different samples. Truncating symmetrically
  // here keeps every per-scorer figure aligned with the CI's sample size,
  // and the `runCount` field on each side surfaces the truncation
  // explicitly so the UI can render "n=2 of 5 pooled".
  const runCount = Math.min(baselineRunsRaw.length, candidateRunsRaw.length);
  const baselineRuns = baselineRunsRaw.slice(0, runCount);
  const candidateRuns = candidateRunsRaw.slice(0, runCount);

  // Use the first run as representative for metadata, dataset, scorers.
  // `partial` detection downstream still walks the FULL pool so
  // pre-truncation history (`metadata.batchAttempted` from any pooled run)
  // is honored.
  const baselineRef = baselineRunsRaw[0];
  const candidateRef = candidateRunsRaw[0];

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

  // Compute aggregate means across the truncated runs (matches the CI's sample).
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

    // Per-side scored/failed over the SAME truncated pool the means/CI use, so
    // a gate (`--max-scorer-error-rate`) reads a sample consistent with the
    // displayed numbers. Sum across this side's truncated runs (the
    // `scorerCounts` helper excludes workflow-errored items and counts a
    // ran-and-failed scorer via its `scoreDetails.duration` discriminator).
    let baselineScored = 0;
    let baselineFailed = 0;
    for (const run of baselineRuns) {
      const c = scorerCounts(run.items, name);
      baselineScored += c.scored;
      baselineFailed += c.failed;
    }
    let candidateScored = 0;
    let candidateFailed = 0;
    for (const run of candidateRuns) {
      const c = scorerCounts(run.items, name);
      candidateScored += c.scored;
      candidateFailed += c.failed;
    }

    const entry: EvalComparison['scorers'][string] = {
      baselineMean: bMean,
      candidateMean: cMean,
      delta,
      deltaPercent,
      baselineScored,
      baselineFailed,
      candidateScored,
      candidateFailed,
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

  // Run partial detection against the FULL pre-truncation pool. The user's
  // original selection (e.g. 5 of an attempted 10 runs) determines partial
  // status; the truncation we did above is a stats-consistency concern, not
  // a partial-batch one.
  const baselinePartial = detectPartial(baselineRunsRaw);
  const candidatePartial = detectPartial(candidateRunsRaw);

  return {
    baseline: {
      id: baselineRef.id,
      metadata: baselineRef.metadata,
      runCount,
      ...(baselinePartial ? { partial: baselinePartial } : {}),
    },
    candidate: {
      id: candidateRef.id,
      metadata: candidateRef.metadata,
      runCount,
      ...(candidatePartial ? { partial: candidatePartial } : {}),
    },
    scorers,
    timing,
    cost,
    regressions,
    improvements,
    summary: summaryStr,
  };
}

/**
 * Detect whether one side of a comparison was pooled from a partial batch
 * (or a user-selected subset). Returns `{ completed, attempted }` when the
 * pooled run count is less than the original batch's planned run count
 * (read from `metadata.batchAttempted` on any run in the pool); `undefined`
 * otherwise.
 *
 * The signal is the same regardless of cause (batch failed mid-way vs user
 * cherry-picked from the picker) — both result in a smaller-N pool that
 * the consumer should mark visually so the comparison isn't mistaken for
 * an apples-to-apples run.
 *
 * Walks every run looking for the first finite `batchAttempted` rather than
 * trusting `runs[0]` alone — when a user cherry-picks runs from the compare
 * picker, the array order is the user's order, so the first item may be a
 * legacy single-run with no batch metadata while a sibling carries it.
 *
 * If `runs.length > attempted` (more results than were planned), treats the
 * data as suspicious and returns `undefined` — silently marking it "complete"
 * would mask data corruption.
 */
function detectPartial(runs: EvalResult[]): { completed: number; attempted: number } | undefined {
  if (runs.length === 0) return undefined;
  let attempted: number | undefined;
  for (const r of runs) {
    const v = r.metadata?.batchAttempted;
    if (typeof v === 'number' && Number.isFinite(v)) {
      attempted = v;
      break;
    }
  }
  if (attempted === undefined) return undefined;
  if (runs.length >= attempted) return undefined;
  return { completed: runs.length, attempted };
}

/**
 * Decide whether a comparison should be REFUSED under a gate-side scorer
 * failure-rate limit (`axl-eval compare --max-scorer-error-rate`). Pure and
 * testable — returns a human-readable refusal reason, or `null` to allow.
 *
 * Type-aware via the baseline's `scorerTypes` metadata: a scorer EXPLICITLY
 * marked `'deterministic'` tolerates ZERO failures (a deterministic throw is a
 * bug); everything else — including an unknown/absent type on a pre-`scorerTypes`
 * artifact — uses the LLM `limit`. Defaulting unknown types to LLM (the
 * permissive tier) is deliberate: classifying an old artifact's scorers as
 * deterministic would hard-fail them on the first flake, contradicting the
 * `--max-scorer-error-rate <n>` the user passed. Scorer NAMES are identical
 * across sides (enforced by `evalCompare`), so reading types from the baseline
 * is sufficient.
 *
 * Also refuses a scorer that produced ZERO scored items on a side — a mean over
 * an empty sample can't be certified. Counts come from the same truncated pool
 * `evalCompare` used for the means/CI (`baseline/candidateScored/Failed`).
 */
export function evaluateScorerErrorRateGate(
  comparison: EvalComparison,
  maxScorerErrorRate: number,
): string | null {
  const scorerTypes = (comparison.baseline.metadata?.scorerTypes ?? {}) as Record<string, string>;
  for (const name of Object.keys(comparison.scorers)) {
    const s = comparison.scorers[name];
    const type = scorerTypes[name] === 'deterministic' ? 'deterministic' : 'llm';
    const limit = type === 'deterministic' ? 0 : maxScorerErrorRate;
    for (const side of ['baseline', 'candidate'] as const) {
      const scored = (side === 'baseline' ? s.baselineScored : s.candidateScored) ?? 0;
      const failed = (side === 'baseline' ? s.baselineFailed : s.candidateFailed) ?? 0;
      const verdict = evaluateScorerTolerance(scored, failed, type, limit);
      if (verdict.zeroSample) {
        // attempted === 0 means the scorer produced no valid scores AND recorded
        // no ran-and-failed attempts on this side — typically every one of its
        // items errored in the workflow (or was skipped), not necessarily a fault
        // of the scorer itself. Either way a mean over zero samples can't be certified.
        return `scorer "${name}" has no scored items on ${side} (its items errored or were skipped) — cannot certify a mean over an empty sample.`;
      }
      if (verdict.exceeds) {
        const limitStr =
          type === 'deterministic'
            ? 'deterministic zero-tolerance'
            : `${(limit * 100).toFixed(1)}%`;
        return `scorer "${name}" failed ${(verdict.rate * 100).toFixed(1)}% on ${side} (${failed}/${verdict.attempted}), over the ${limitStr} limit.`;
      }
    }
  }
  return null;
}
