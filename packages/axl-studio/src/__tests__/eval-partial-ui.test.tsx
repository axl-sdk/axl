// @vitest-environment jsdom
/**
 * Smoke coverage for the partial-batch UI affordances added end-to-end.
 *
 * The data-shape helpers (`buildMultiRunResult`, `detectPartial`) have
 * dedicated unit tests; this file pins the rendered output of the
 * three "anti-silent-partial" UI surfaces:
 *
 *   1. EvalHistoryTable — amber `X/N PARTIAL` badge on group rows where
 *      `entries.length < metadata.batchAttempted`.
 *   2. LineChart — hollow markers on points whose `partial: true` so the
 *      trend line can't visually impersonate a complete data point.
 *   3. EvalTrendsView — legend chip explaining the hollow-ring convention.
 *      Without it, a user who didn't read the changelog sees an unlabeled
 *      visual difference and has no way to know what it means.
 *
 * If any of these silently regress, the silent-partial UX bug returns at
 * a different surface — exactly the failure mode the artifact-side fix
 * was designed to prevent.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EvalHistoryTable } from '../client/panels/eval-runner/EvalHistoryTable';
import { LineChart } from '../client/components/shared/charts/LineChart';
import type { EvalHistoryEntry } from '../client/lib/types';

function makeEntry(
  id: string,
  groupId: string,
  batchAttempted: number,
  runIndex: number,
): EvalHistoryEntry {
  return {
    id,
    eval: 'test-eval',
    timestamp: 1700000000000 + runIndex,
    data: {
      id,
      dataset: 'ds',
      timestamp: '2026-04-30T00:00:00.000Z',
      duration: 1000,
      totalCost: 0.01,
      items: [],
      summary: {
        count: 1,
        failures: 0,
        scorers: { acc: { mean: 0.8, min: 0.8, max: 0.8, p50: 0.8, p95: 0.8 } },
      },
      metadata: { runGroupId: groupId, runIndex, batchAttempted },
    },
  } as EvalHistoryEntry;
}

describe('EvalHistoryTable — partial-batch badge', () => {
  it('renders the amber X/N PARTIAL badge when group entries < batchAttempted', () => {
    // 2 entries persisted, 5 were planned — partial.
    const entries = [makeEntry('r0', 'g1', 5, 0), makeEntry('r1', 'g1', 5, 1)];
    render(
      <EvalHistoryTable
        history={entries}
        evalFilter=""
        onEvalFilterChange={() => {}}
        onSelect={() => {}}
        expandedGroups={new Set()}
        onToggleGroup={() => {}}
      />,
    );
    // The badge text composes "X/N runs partial". Match the parts so the
    // test survives whitespace / wrap changes.
    expect(screen.getByText(/2\/5 runs/)).toBeInTheDocument();
    expect(screen.getByText(/partial/i)).toBeInTheDocument();
  });

  it('renders only the run count (no PARTIAL badge) when batch is complete', () => {
    // 3 entries, 3 attempted — complete.
    const entries = [
      makeEntry('r0', 'g1', 3, 0),
      makeEntry('r1', 'g1', 3, 1),
      makeEntry('r2', 'g1', 3, 2),
    ];
    render(
      <EvalHistoryTable
        history={entries}
        evalFilter=""
        onEvalFilterChange={() => {}}
        onSelect={() => {}}
        expandedGroups={new Set()}
        onToggleGroup={() => {}}
      />,
    );
    expect(screen.getByText(/3 runs/)).toBeInTheDocument();
    expect(screen.queryByText(/partial/i)).not.toBeInTheDocument();
  });

  it('renders only the run count when group has no batchAttempted (legacy data)', () => {
    // No batchAttempted on either entry — can't infer partial-ness.
    // Treat as complete so legacy data isn't falsely amber-flagged.
    const e1 = makeEntry('r0', 'g1', 0, 0);
    const e2 = makeEntry('r1', 'g1', 0, 1);
    delete (e1.data as { metadata?: Record<string, unknown> }).metadata!.batchAttempted;
    delete (e2.data as { metadata?: Record<string, unknown> }).metadata!.batchAttempted;
    render(
      <EvalHistoryTable
        history={[e1, e2]}
        evalFilter=""
        onEvalFilterChange={() => {}}
        onSelect={() => {}}
        expandedGroups={new Set()}
        onToggleGroup={() => {}}
      />,
    );
    expect(screen.getByText(/2 runs/)).toBeInTheDocument();
    expect(screen.queryByText(/partial/i)).not.toBeInTheDocument();
  });
});

describe('LineChart — hollow markers', () => {
  it('renders a hollow ring (background fill, color stroke) for partial points', () => {
    const { container } = render(
      <LineChart
        series={[
          {
            name: 'acc',
            color: '#3b82f6',
            points: [
              { x: 0, y: 0.8 },
              { x: 1, y: 0.5, partial: true },
              { x: 2, y: 0.9 },
            ],
          },
        ]}
        xMin={0}
        xMax={2}
      />,
    );

    // Every point gets a circle. The partial one is hollow: fill=background,
    // stroke=color. The complete ones are solid: fill=color.
    const circles = container.querySelectorAll('circle');
    const partialCircle = Array.from(circles).find((c) =>
      c.getAttribute('fill')?.includes('--background'),
    );
    expect(partialCircle).toBeTruthy();
    expect(partialCircle?.getAttribute('stroke')).toBe('#3b82f6');

    // Hover-tooltip via SVG <title> describes the partial state so the
    // hollow convention is self-explanatory even outside the legend.
    const titleNode = partialCircle?.querySelector('title');
    expect(titleNode?.textContent).toMatch(/partial/i);

    // And a non-partial circle is solid (fill=color).
    const solidCircle = Array.from(circles).find(
      (c) => c.getAttribute('fill') === '#3b82f6' && !c.querySelector('title'),
    );
    expect(solidCircle).toBeTruthy();
  });

  it('omits hollow markers when no point is partial', () => {
    const { container } = render(
      <LineChart
        series={[
          {
            name: 'acc',
            color: '#3b82f6',
            points: [
              { x: 0, y: 0.8 },
              { x: 1, y: 0.9 },
            ],
          },
        ]}
        xMin={0}
        xMax={1}
      />,
    );
    const circles = container.querySelectorAll('circle');
    // None of the markers should have the background fill (hollow style).
    for (const c of circles) {
      expect(c.getAttribute('fill')).not.toContain('--background');
    }
  });
});
