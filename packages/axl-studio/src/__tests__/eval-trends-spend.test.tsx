// @vitest-environment jsdom
/**
 * How the Eval Trends view presents spend it cannot fully vouch for.
 *
 * Two readings this pins:
 *
 *   F2 — the cost sparkline drew one continuous line through a measured run, a
 *   run whose model was unpriced (`$0.00`, a lower bound) and a pre-0.24
 *   artifact. That draws a clean downward trend and a reader concludes the last
 *   model change made the eval nearly free. The window-level completeness chip
 *   does not prevent it: it describes the SUM, not the shape.
 *
 *   F6 — the window's spend figure went through the shared `CostBadge`, whose
 *   hard-coded tooltip says "this ask used an unpriced model". For a window
 *   whose only defect is one legacy artifact that is the wrong vocabulary (an
 *   ask, not an eval window) and the wrong cause (unverified is not unpriced).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import type { EvalTrendData } from '../client/lib/types';

type EvalTrendRun = EvalTrendData['byEval'][string]['runs'][number];

vi.mock('../client/lib/ws', () => ({
  wsClient: { subscribe: () => () => {}, connect: () => {} },
}));

const fetchEvalTrendsMock = vi.fn<() => Promise<EvalTrendData>>();
vi.mock('../client/lib/api', () => ({
  fetchEvalTrends: (...args: unknown[]) => fetchEvalTrendsMock(...(args as [])),
}));

import { EvalTrendsView } from '../client/panels/eval-runner/EvalTrendsView';
import { CostSparkLine } from '../client/panels/eval-runner/CostSparkLine';

function renderWithProviders(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function trendRun(over: Partial<EvalTrendRun> & Pick<EvalTrendRun, 'id' | 'cost'>): EvalTrendRun {
  return {
    timestamp: 1_700_000_000_000,
    scores: { acc: 0.8 },
    completeness: 'complete',
    ...over,
  } as EvalTrendRun;
}

/** A window holding one measured run, one unpriced run and one legacy artifact. */
function mixedWindow(): EvalTrendData {
  const runs: EvalTrendRun[] = [
    trendRun({ id: 'a', cost: 0.75, timestamp: 1 }),
    trendRun({ id: 'b', cost: 0, completeness: 'incomplete', timestamp: 2 }),
    trendRun({ id: 'c', cost: 0.42, completeness: 'unverified', timestamp: 3 }),
  ];
  return {
    byEval: {
      e1: {
        runs,
        latestScores: { acc: 0.8 },
        scoreMean: { acc: 0.8 },
        scoreStd: { acc: 0 },
        costTotal: 1.17,
        costCompleteness: 'unverified',
        budgetStoppedRuns: 0,
        runCount: 3,
      },
    },
    totalRuns: 3,
    totalCost: 1.17,
    totalCostCompleteness: 'unverified',
  } as EvalTrendData;
}

beforeEach(() => {
  fetchEvalTrendsMock.mockReset();
});

// ── F2 — the sparkline may not plot mixed completeness as one trend ──

describe('CostSparkLine — a non-measured point is not part of the trend', () => {
  it('names the non-measured points in its accessible text', () => {
    render(
      <CostSparkLine
        points={[
          { cost: 0.75, completeness: 'complete' },
          { cost: 0, completeness: 'incomplete' },
          { cost: 0.42, completeness: 'unverified' },
        ]}
      />,
    );
    const chart = screen.getByRole('img');
    expect(chart).toHaveAccessibleName(/2 of them are lower bounds or unverified/);
    expect(chart).toHaveAccessibleName(/not a measured trend/);
  });

  it('says every point is measured when every point is', () => {
    render(
      <CostSparkLine
        points={[
          { cost: 0.75, completeness: 'complete' },
          { cost: 0.5, completeness: 'complete' },
        ]}
      />,
    );
    expect(screen.getByRole('img')).toHaveAccessibleName(/across 2 measured runs/);
  });

  it('draws hollow points on dashed segments where the spend is not measured', () => {
    const { container } = render(
      <CostSparkLine
        points={[
          { cost: 0.75, completeness: 'complete' },
          { cost: 0, completeness: 'incomplete' },
          { cost: 0.42, completeness: 'unverified' },
        ]}
      />,
    );
    // Both segments touch a non-measured point, so neither may be solid.
    const segments = [...container.querySelectorAll('line')];
    expect(segments).toHaveLength(2);
    expect(segments.every((l) => l.getAttribute('stroke-dasharray') !== null)).toBe(true);
    // One filled marker (the measured run), two hollow rings.
    const markers = [...container.querySelectorAll('circle')];
    expect(markers.filter((c) => c.getAttribute('fill') === 'none')).toHaveLength(2);
    expect(markers.filter((c) => c.getAttribute('fill') !== 'none')).toHaveLength(1);
  });

  it('draws a solid line when every point is measured', () => {
    const { container } = render(
      <CostSparkLine
        points={[
          { cost: 0.75, completeness: 'complete' },
          { cost: 0.5, completeness: 'complete' },
        ]}
      />,
    );
    const segments = [...container.querySelectorAll('line')];
    expect(segments).toHaveLength(1);
    expect(segments[0].getAttribute('stroke-dasharray')).toBeNull();
  });

  it('treats a point with no completeness (older server) as not measured', () => {
    render(<CostSparkLine points={[{ cost: 1 }, { cost: 2 }]} />);
    expect(screen.getByRole('img')).toHaveAccessibleName(/2 of them are lower bounds/);
  });
});

// ── F2 / F6 — the trends view itself ─────────────────────────────

describe('EvalTrendsView — window spend states its own completeness', () => {
  it('marks the sparkline and counts the non-measured points', async () => {
    fetchEvalTrendsMock.mockResolvedValue(mixedWindow());
    renderWithProviders(<EvalTrendsView />);

    expect(await screen.findByText('2 of 3 not measured')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Cost over time/ })).toHaveAccessibleName(
      /not a measured trend/,
    );
  });

  it('does not blame an unpriced model for a window whose defect is a legacy artifact', async () => {
    fetchEvalTrendsMock.mockResolvedValue(mixedWindow());
    renderWithProviders(<EvalTrendsView />);

    expect(
      await screen.findByLabelText(/Known spend across 3 runs \$1\.17, unverified \(legacy\)/),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/unpriced model/);
    expect(document.querySelector('[title*="unpriced model"]')).toBeNull();
  });
});
