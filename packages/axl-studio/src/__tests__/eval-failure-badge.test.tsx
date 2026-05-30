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

function summaryWith(scored?: number, failed?: number): EvalResultData['summary'] {
  return {
    count: 3,
    failures: 0,
    scorers: {
      acc: { mean: 0.9, min: 0.9, max: 0.9, p50: 0.9, p95: 0.9, scored, failed },
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
