// @vitest-environment jsdom
/**
 * Render coverage for the "annotation keys dropped" banner. The data helper
 * (`getResultDroppedAnnotationKeys`) is unit-tested separately; this pins the
 * rendered output — singular/plural grammar, the chip list, the chip cap, and
 * that it renders nothing when there are no dropped keys. Mirrors the
 * eval-partial-ui precedent for in-panel "anti-silent" banners.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DroppedAnnotationKeysBanner } from '../client/panels/eval-runner/DroppedAnnotationKeysBanner';
import type { EvalResultData } from '../client/panels/eval-runner/types';

function makeResult(droppedAnnotationKeys?: string[]): EvalResultData {
  return {
    id: 'r1',
    dataset: 'ds',
    timestamp: '2026-05-29T00:00:00.000Z',
    duration: 1,
    totalCost: 0,
    items: [],
    summary: { count: 0, failures: 0, scorers: {} },
    ...(droppedAnnotationKeys ? { metadata: { droppedAnnotationKeys } } : {}),
  };
}

describe('DroppedAnnotationKeysBanner', () => {
  it('renders nothing when there are no dropped keys', () => {
    const { container } = render(<DroppedAnnotationKeysBanner result={makeResult()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a chip per dropped key with plural grammar and role=status', () => {
    render(<DroppedAnnotationKeysBanner result={makeResult(['expectedTone', 'persona.role'])} />);
    expect(screen.getByText(/2 annotation keys dropped by the dataset schema/)).toBeInTheDocument();
    expect(screen.getByText('expectedTone')).toBeInTheDocument();
    expect(screen.getByText('persona.role')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('uses singular grammar for one key', () => {
    render(<DroppedAnnotationKeysBanner result={makeResult(['answer'])} />);
    expect(screen.getByText(/1 annotation key dropped by the dataset schema/)).toBeInTheDocument();
  });

  it('caps the chip list at 20 and shows a "+N more" affordance', () => {
    const keys = Array.from({ length: 25 }, (_, i) => `k${i}`);
    render(<DroppedAnnotationKeysBanner result={makeResult(keys)} />);
    // Headline still reports the true total.
    expect(screen.getByText(/25 annotation keys dropped/)).toBeInTheDocument();
    // 20 chips visible, the 21st absent, overflow affordance present.
    expect(screen.getByText('k19')).toBeInTheDocument();
    expect(screen.queryByText('k20')).not.toBeInTheDocument();
    expect(screen.getByText('+5 more')).toBeInTheDocument();
  });
});
