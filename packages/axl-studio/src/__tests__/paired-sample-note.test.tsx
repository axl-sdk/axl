// @vitest-environment jsdom
/**
 * PairedSampleNote labels the per-side-vs-paired sample mismatch in the compare
 * view: the headline delta is the diff of two INDEPENDENT per-side means, while
 * the CI is paired over `n` items scored on both sides. The note must appear
 * ONLY when those samples actually diverge (a side skipped/failed items, or the
 * paired sample is smaller than either side's scored count) and stay invisible
 * for clean symmetric runs.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PairedSampleNote } from '../client/panels/eval-runner/PairedSampleNote';
import type { ComparisonScorerEntry } from '../client/panels/eval-runner/types';

const base: ComparisonScorerEntry = {
  baselineMean: 0.8,
  candidateMean: 0.8,
  delta: 0,
  deltaPercent: 0,
};

describe('PairedSampleNote', () => {
  it('renders nothing for a clean symmetric run (no skips/failures, paired === per-side)', () => {
    const { container } = render(
      <PairedSampleNote stats={{ ...base, n: 10, baselineScored: 10, candidateScored: 10 }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when sample counts are absent (pre-feature / old artifacts)', () => {
    const { container } = render(<PairedSampleNote stats={base} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('surfaces an asymmetric skip: different N/A per side and a thinned paired sample', () => {
    // baseline scored 9 (1 N/A), candidate scored 7 (3 N/A), only 6 paired.
    render(
      <PairedSampleNote
        stats={{
          ...base,
          n: 6,
          baselineScored: 9,
          baselineSkipped: 1,
          candidateScored: 7,
          candidateSkipped: 3,
        }}
      />,
    );
    const note = screen.getByText(/paired n=6/);
    expect(note).toBeInTheDocument();
    expect(note).toHaveTextContent('per-side 9/7');
    // The tooltip spells out both sides and the paired basis.
    const title = note.getAttribute('title') ?? '';
    expect(title).toMatch(/baseline over 9 scored, 1 N\/A/);
    expect(title).toMatch(/candidate over 7 scored, 3 N\/A/);
    expect(title).toMatch(/6 item\(s\) scored on BOTH sides/);
  });

  it('surfaces a thinned paired sample even with no skips (e.g. failures shrink the overlap)', () => {
    // Both sides scored 10, but only 8 items overlap (failures on different items).
    render(
      <PairedSampleNote
        stats={{
          ...base,
          n: 8,
          baselineScored: 10,
          baselineFailed: 2,
          candidateScored: 10,
          candidateFailed: 2,
        }}
      />,
    );
    const note = screen.getByText(/paired n=8/);
    expect(note).toBeInTheDocument();
    expect(note.getAttribute('title') ?? '').toMatch(/2 failed/);
  });

  it('renders when paired < per-side even if there are zero recorded skips/failures', () => {
    // Defensive: paired shortfall alone is enough to flag a sample mismatch.
    render(<PairedSampleNote stats={{ ...base, n: 4, baselineScored: 6, candidateScored: 6 }} />);
    expect(screen.getByText(/paired n=4/)).toBeInTheDocument();
  });
});
