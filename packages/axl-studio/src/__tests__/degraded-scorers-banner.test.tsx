// @vitest-environment jsdom
/**
 * Render coverage for the "degraded scorers" trust-signal banner. The data
 * helper (`getResultDegraded`) is exercised here too via the rendered output;
 * this pins the per-scorer line wording (llm vs deterministic), the line cap,
 * singular/plural grammar, and that it renders nothing for a clean run. Mirrors
 * the scorer-filtered banner precedent for in-panel "anti-silent" banners.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DegradedScorersBanner } from '../client/panels/eval-runner/DegradedScorersBanner';
import type { DegradedScorer, EvalResultData } from '../client/panels/eval-runner/types';

function makeResult(degraded?: DegradedScorer[]): EvalResultData {
  return {
    id: 'r1',
    dataset: 'ds',
    timestamp: '2026-05-29T00:00:00.000Z',
    duration: 1,
    totalCost: 0,
    items: [],
    summary: { count: 0, failures: 0, scorers: {}, ...(degraded ? { degraded } : {}) },
  };
}

describe('DegradedScorersBanner', () => {
  it('renders nothing for a clean run (no degraded scorers)', () => {
    const { container } = render(<DegradedScorersBanner result={makeResult()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when degraded is an empty array', () => {
    const { container } = render(<DegradedScorersBanner result={makeResult([])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an llm scorer line with the rate, fraction, and limit', () => {
    render(
      <DegradedScorersBanner
        result={makeResult([
          { scorer: 'accuracy', rate: 0.5, limit: 0.1, type: 'llm', scored: 5, failed: 5 },
        ])}
      />,
    );
    expect(screen.getByText(/1 scorer exceeded the failure-rate tolerance/)).toBeInTheDocument();
    expect(
      screen.getByText('"accuracy" failed 50.0% (5/10) — over the 10.0% limit (llm)'),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders a deterministic scorer line with the no-tolerance wording', () => {
    render(
      <DegradedScorersBanner
        result={makeResult([
          { scorer: 'exact', rate: 0.25, limit: 0, type: 'deterministic', scored: 3, failed: 1 },
        ])}
      />,
    );
    expect(
      screen.getByText('"exact" failed 25.0% (1/4) — deterministic scorers tolerate no failures'),
    ).toBeInTheDocument();
  });

  it('renders one line per degraded scorer with plural grammar', () => {
    render(
      <DegradedScorersBanner
        result={makeResult([
          { scorer: 'accuracy', rate: 0.5, limit: 0.1, type: 'llm', scored: 5, failed: 5 },
          { scorer: 'exact', rate: 0.25, limit: 0, type: 'deterministic', scored: 3, failed: 1 },
        ])}
      />,
    );
    expect(screen.getByText(/2 scorers exceeded the failure-rate tolerance/)).toBeInTheDocument();
    expect(
      screen.getByText('"accuracy" failed 50.0% (5/10) — over the 10.0% limit (llm)'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('"exact" failed 25.0% (1/4) — deterministic scorers tolerate no failures'),
    ).toBeInTheDocument();
  });

  it('caps the line list at 5 and shows a "+N more" affordance', () => {
    const degraded: DegradedScorer[] = Array.from({ length: 8 }, (_, i) => ({
      scorer: `s${i}`,
      rate: 0.5,
      limit: 0.1,
      type: 'llm' as const,
      scored: 5,
      failed: 5,
    }));
    render(<DegradedScorersBanner result={makeResult(degraded)} />);
    // Headline still reports the true total.
    expect(screen.getByText(/8 scorers exceeded/)).toBeInTheDocument();
    // 5 lines visible, the 6th absent, overflow affordance present.
    expect(
      screen.getByText('"s4" failed 50.0% (5/10) — over the 10.0% limit (llm)'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('"s5" failed 50.0% (5/10) — over the 10.0% limit (llm)'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('+3 more')).toBeInTheDocument();
  });
});
