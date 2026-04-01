import type { EvalResult, EvalComparison, EvalRegression, EvalImprovement } from './types.js';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function evalCompare(baseline: EvalResult, candidate: EvalResult): EvalComparison {
  if (baseline.dataset !== candidate.dataset) {
    throw new Error(
      `Cannot compare evals from different datasets: "${baseline.dataset}" vs "${candidate.dataset}"`,
    );
  }

  const baselineScorerNames = Object.keys(baseline.summary.scorers).sort();
  const candidateScorerNames = Object.keys(candidate.summary.scorers).sort();
  if (JSON.stringify(baselineScorerNames) !== JSON.stringify(candidateScorerNames)) {
    throw new Error(`Cannot compare evals with different scorers`);
  }

  const scorers: EvalComparison['scorers'] = {};
  for (const name of baselineScorerNames) {
    const bMean = baseline.summary.scorers[name].mean;
    const cMean = candidate.summary.scorers[name].mean;
    const delta = round(cMean - bMean);
    const deltaPercent = bMean > 0 ? round((delta / bMean) * 100) : 0;
    scorers[name] = { baselineMean: bMean, candidateMean: cMean, delta, deltaPercent };
  }

  const regressions: EvalRegression[] = [];
  const improvements: EvalImprovement[] = [];

  const minLength = Math.min(baseline.items.length, candidate.items.length);
  for (let i = 0; i < minLength; i++) {
    const bItem = baseline.items[i];
    const cItem = candidate.items[i];
    if (bItem.error || cItem.error) continue;
    for (const name of baselineScorerNames) {
      const bScore = bItem.scores[name];
      const cScore = cItem.scores[name];
      if (bScore == null || cScore == null) continue;
      const delta = round(cScore - bScore);
      if (delta < -0.1)
        regressions.push({
          input: bItem.input,
          scorer: name,
          baselineScore: bScore,
          candidateScore: cScore,
          delta,
        });
      else if (delta > 0.1)
        improvements.push({
          input: bItem.input,
          scorer: name,
          baselineScore: bScore,
          candidateScore: cScore,
          delta,
        });
    }
  }

  const parts: string[] = [];
  for (const name of baselineScorerNames) {
    const s = scorers[name];
    if (Math.abs(s.delta) > 0.001) {
      const direction = s.delta > 0 ? 'improves' : 'regresses';
      const sign = s.delta > 0 ? '+' : '';
      parts.push(
        `'${name}' ${direction} by ${sign}${s.deltaPercent.toFixed(1)}% (${s.baselineMean.toFixed(2)} -> ${s.candidateMean.toFixed(2)})`,
      );
    }
  }
  const summaryStr = `candidate ${parts.length > 0 ? parts.join(', ') : 'no significant changes'} with ${regressions.length} regressions and ${improvements.length} improvements`;

  return {
    baseline: { id: baseline.id, metadata: baseline.metadata },
    candidate: { id: candidate.id, metadata: candidate.metadata },
    scorers,
    regressions,
    improvements,
    summary: summaryStr,
  };
}
