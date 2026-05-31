// @vitest-environment jsdom
/**
 * Render coverage for the per-scorer "thinned sample" failure badge in the
 * Eval Runner summary table + score distribution. A scorer that ran and failed
 * on some items (null score WITH a recorded scoreDetails.duration) must surface
 * a loud `scored/attempted scored, N failed` annotation so a healthy-looking
 * mean computed over survivors can't pass silently. Mirrors the dropped-keys /
 * scorer-filtered banner precedent for in-panel anti-silent signals.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EvalSummaryTable } from '../client/panels/eval-runner/EvalSummaryTable';
import { ScoreDistribution } from '../client/panels/eval-runner/ScoreDistribution';
import { ScorerSampleChips } from '../client/panels/eval-runner/ScorerSampleChips';
import { collectScorerScores, getScorerSampleCounts } from '../client/panels/eval-runner/types';
import type { EvalItem, EvalResultData } from '../client/panels/eval-runner/types';

const okItem = (q: string, score: number): EvalItem => ({
  input: { q },
  output: 'x',
  scores: { acc: score },
  scoreDetails: { acc: { score, duration: 5 } },
});
// Ran-and-failed: null score WITH a duration.
const failedItem = (q: string): EvalItem => ({
  input: { q },
  output: 'x',
  scores: { acc: null },
  scoreDetails: { acc: { score: null, duration: 5 } },
});
// Skipped by the `applies` predicate: null score WITH a `skipped: true` marker
// (no duration — the scorer never ran).
const skippedItem = (q: string): EvalItem => ({
  input: { q },
  output: 'x',
  scores: { acc: null },
  scoreDetails: { acc: { score: null, skipped: true } },
});

function summaryWith(
  scored?: number,
  failed?: number,
  skipped?: number,
): EvalResultData['summary'] {
  return {
    count: 3,
    failures: 0,
    scorers: {
      acc: { mean: 0.9, min: 0.9, max: 0.9, p50: 0.9, p95: 0.9, scored, failed, skipped },
    },
  };
}

describe('EvalSummaryTable failure badge', () => {
  it('shows the thinned-sample badge when a scorer ran and failed', () => {
    render(
      <EvalSummaryTable
        summary={summaryWith(2, 1)}
        items={[okItem('1', 0.9), okItem('2', 0.9), failedItem('3')]}
        totalCost={0}
      />,
    );
    expect(screen.getByText(/2\/3 scored, 1 failed/)).toBeInTheDocument();
  });

  it('shows no badge when nothing failed', () => {
    render(
      <EvalSummaryTable
        summary={summaryWith(2, 0)}
        items={[okItem('1', 0.9), okItem('2', 0.9)]}
        totalCost={0}
      />,
    );
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  });

  it('falls back to recomputing counts from items when summary fields are absent', () => {
    // Pre-0.18.0 artifact: no scored/failed on the summary, but scoreDetails
    // still carries the duration discriminator on the items.
    render(
      <EvalSummaryTable
        summary={summaryWith(undefined, undefined)}
        items={[okItem('1', 0.9), failedItem('2'), failedItem('3')]}
        totalCost={0}
      />,
    );
    expect(screen.getByText(/1\/3 scored, 2 failed/)).toBeInTheDocument();
  });
});

describe('ScoreDistribution failure note', () => {
  it('annotates a scorer with failures', () => {
    render(
      <ScoreDistribution
        items={[okItem('1', 0.9), okItem('2', 0.9), failedItem('3')]}
        scorerNames={['acc']}
      />,
    );
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });
});

describe('EvalSummaryTable skipped (N/A) chip', () => {
  it('shows the N/A chip when a scorer skipped some items via applies', () => {
    render(
      <EvalSummaryTable
        summary={summaryWith(2, 0, 1)}
        items={[okItem('1', 0.9), okItem('2', 0.9), skippedItem('3')]}
        totalCost={0}
      />,
    );
    expect(screen.getByText(/N\/A: 1/)).toBeInTheDocument();
    // Skips are not failures — the amber failed chip must stay absent.
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  });

  it('shows no N/A chip when nothing was skipped', () => {
    render(
      <EvalSummaryTable
        summary={summaryWith(2, 0, 0)}
        items={[okItem('1', 0.9), okItem('2', 0.9)]}
        totalCost={0}
      />,
    );
    expect(screen.queryByText(/N\/A:/)).not.toBeInTheDocument();
  });

  it('recomputes the skip count from items when summary.skipped is absent', () => {
    // Pre-feature artifact: no skipped on the summary, but scoreDetails carries
    // the skipped marker on the items.
    render(
      <EvalSummaryTable
        summary={summaryWith(undefined, undefined, undefined)}
        items={[okItem('1', 0.9), skippedItem('2'), skippedItem('3')]}
        totalCost={0}
      />,
    );
    expect(screen.getByText(/N\/A: 2/)).toBeInTheDocument();
  });
});

describe('ScoreDistribution skipped (N/A) note', () => {
  it('annotates a scorer with skips', () => {
    render(
      <ScoreDistribution
        items={[okItem('1', 0.9), okItem('2', 0.9), skippedItem('3')]}
        scorerNames={['acc']}
      />,
    );
    expect(screen.getByText(/N\/A: 1/)).toBeInTheDocument();
  });

  it('shows no N/A note when nothing was skipped', () => {
    render(
      <ScoreDistribution items={[okItem('1', 0.9), okItem('2', 0.9)]} scorerNames={['acc']} />,
    );
    expect(screen.queryByText(/N\/A:/)).not.toBeInTheDocument();
  });
});

describe('ScorerSampleChips failed-label form (rich vs simple)', () => {
  it('renders the rich label when scored is provided', () => {
    render(<ScorerSampleChips failed={1} scored={2} />);
    expect(screen.getByText('2/3 scored, 1 failed')).toBeInTheDocument();
  });

  it('renders the simple label when scored is omitted', () => {
    render(<ScorerSampleChips failed={2} />);
    expect(screen.getByText('2 failed')).toBeInTheDocument();
    // Simple form must not synthesize a "scored" count.
    expect(screen.queryByText(/scored,/)).not.toBeInTheDocument();
  });
});

describe('collectScorerScores / getScorerSampleCounts skipped computation', () => {
  it('classifies scored / failed / skipped by the server precedence', () => {
    const items = [okItem('1', 0.9), failedItem('2'), skippedItem('3')];
    const { scores, failed, skipped } = collectScorerScores(items, 'acc');
    expect(scores).toEqual([0.9]);
    expect(failed).toBe(1);
    expect(skipped).toBe(1);
  });

  it('prefers a positive skipped marker over the duration heuristic', () => {
    // A skipped item that ALSO happens to carry a duration must count as
    // skipped, not failed — skipped check precedes duration.
    const item: EvalItem = {
      input: { q: 'x' },
      output: 'x',
      scores: { acc: null },
      scoreDetails: { acc: { score: null, duration: 5, skipped: true } },
    };
    const { failed, skipped } = collectScorerScores([item], 'acc');
    expect(failed).toBe(0);
    expect(skipped).toBe(1);
  });

  it('getScorerSampleCounts prefers stats.skipped over recomputation', () => {
    const items = [okItem('1', 0.9), skippedItem('2')];
    const counts = getScorerSampleCounts({ scored: 1, failed: 0, skipped: 7 }, 'acc', items);
    expect(counts).toEqual({ scored: 1, failed: 0, skipped: 7 });
  });

  it('getScorerSampleCounts recomputes skipped from items when stats omits it', () => {
    const items = [okItem('1', 0.9), skippedItem('2'), skippedItem('3')];
    const counts = getScorerSampleCounts({ scored: 1, failed: 0 }, 'acc', items);
    expect(counts).toEqual({ scored: 1, failed: 0, skipped: 2 });
  });

  it('getScorerSampleCounts yields skipped: 0 for pre-feature artifacts', () => {
    // No stats.skipped, no scoreDetails.skipped markers, no items at all.
    expect(getScorerSampleCounts({ scored: 3, failed: 0 }, 'acc')).toEqual({
      scored: 3,
      failed: 0,
      skipped: 0,
    });
  });
});
