// @vitest-environment jsdom
/**
 * Render coverage for the "filtered scorer subset" banner. The data helper
 * (`getResultScorerFiltered`) is unit-tested separately; this pins the rendered
 * output — singular/plural grammar, the chip list, the chip cap, and that it
 * renders nothing for a full-coverage run. Mirrors the dropped-annotation-keys
 * banner precedent for in-panel "anti-silent" banners.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScorerFilteredBanner } from '../client/panels/eval-runner/ScorerFilteredBanner';
import type { EvalResultData } from '../client/panels/eval-runner/types';

function makeResult(scorersRun?: string[]): EvalResultData {
  return {
    id: 'r1',
    dataset: 'ds',
    timestamp: '2026-05-29T00:00:00.000Z',
    duration: 1,
    totalCost: 0,
    items: [],
    summary: { count: 0, failures: 0, scorers: {} },
    ...(scorersRun ? { metadata: { scorerFiltered: true, scorersRun } } : {}),
  };
}

describe('ScorerFilteredBanner', () => {
  it('renders nothing for a full-coverage run', () => {
    const { container } = render(<ScorerFilteredBanner result={makeResult()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a chip per scorer with plural grammar and role=status', () => {
    render(<ScorerFilteredBanner result={makeResult(['accuracy', 'tone'])} />);
    expect(screen.getByText(/Filtered scorer subset .* ran 2 scorers/)).toBeInTheDocument();
    expect(screen.getByText('accuracy')).toBeInTheDocument();
    expect(screen.getByText('tone')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('uses singular grammar for one scorer', () => {
    render(<ScorerFilteredBanner result={makeResult(['accuracy'])} />);
    expect(screen.getByText(/Filtered scorer subset .* ran 1 scorer/)).toBeInTheDocument();
  });

  it('caps the chip list at 20 and shows a "+N more" affordance', () => {
    const scorers = Array.from({ length: 25 }, (_, i) => `s${i}`);
    render(<ScorerFilteredBanner result={makeResult(scorers)} />);
    // Headline still reports the true total.
    expect(screen.getByText(/ran 25 scorers/)).toBeInTheDocument();
    // 20 chips visible, the 21st absent, overflow affordance present.
    expect(screen.getByText('s19')).toBeInTheDocument();
    expect(screen.queryByText('s20')).not.toBeInTheDocument();
    expect(screen.getByText('+5 more')).toBeInTheDocument();
  });
});
