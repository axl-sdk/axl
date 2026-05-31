// @vitest-environment jsdom
/**
 * Render coverage for making a SKIPPED scorer result (the scorer's `applies`
 * predicate returned false → null score WITH a `scoreDetails.skipped === true`
 * marker) visible and DISTINCT from a genuine FAILURE (null score WITH a
 * recorded `duration` and no skip marker) across the remaining Eval Runner
 * surfaces:
 *
 *   1. EvalItemDetail — the clicked-item detail panel must show a neutral
 *      "N/A" treatment for a skipped scorer, NOT the gray "null" badge it
 *      shows for a genuine null, and NOT the amber error block it shows for a
 *      failure.
 *   2. EvalItemList — a skipped cell reads "N/A" (muted) rather than a bare
 *      dash.
 *   3. ScorerSampleChips (the extracted multi-run Per-Scorer Aggregate chip) —
 *      renders the neutral "N/A: N" chip from the aggregate's skipped count
 *      and stays distinct from the amber failed chip.
 *   4. EvalCompareItemTable — a per-item cell skipped on one side renders
 *      "N/A" and the delta is reported as non-comparable ("N/A"), never as a
 *      0-delta drop.
 *
 * If any of these regress, all three null causes (skipped / failed / cancelled)
 * render identically again — the exact gap this work closed.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { EvalItemDetail } from '../client/panels/eval-runner/EvalItemDetail';
import { EvalItemList } from '../client/panels/eval-runner/EvalItemList';
import { EvalCompareItemTable } from '../client/panels/eval-runner/EvalCompareItemTable';
import { ScorerSampleChips } from '../client/panels/eval-runner/ScorerSampleChips';
import { AggregateScorerRow } from '../client/panels/eval-runner/AggregateScorerRow';
import { EvalCompareView } from '../client/panels/eval-runner/EvalCompareView';
import type {
  ComparisonResult,
  EvalItem,
  EvalResultData,
} from '../client/panels/eval-runner/types';

const okItem = (q: string, score: number): EvalItem => ({
  input: { q },
  output: 'x',
  scores: { acc: score },
  scoreDetails: { acc: { score, duration: 5 } },
});
const failedItem = (q: string): EvalItem => ({
  input: { q },
  output: 'x',
  scores: { acc: null },
  scoreDetails: { acc: { score: null, duration: 5 } },
  scorerErrors: ['scorer "acc" threw: boom'],
});
const skippedItem = (q: string): EvalItem => ({
  input: { q },
  output: 'x',
  scores: { acc: null },
  scoreDetails: { acc: { score: null, skipped: true } },
});

describe('EvalItemDetail — skipped vs failed scorer', () => {
  const noop = () => {};

  it('shows a distinct N/A treatment for a skipped scorer (no error block, no null badge)', () => {
    render(
      <EvalItemDetail item={skippedItem('q1')} itemIndex={0} scorerNames={['acc']} onBack={noop} />,
    );
    // The N/A explanation appears in the scorer body.
    expect(screen.getByText(/Not applicable/i)).toBeInTheDocument();
    // The skipped badge carries the explanatory tooltip and reads N/A.
    const naBadges = screen.getAllByTitle(/applies. predicate returned false/i);
    expect(naBadges.length).toBeGreaterThan(0);
    // A skipped result must NOT render the generic gray "null" badge…
    expect(screen.queryByText('null')).not.toBeInTheDocument();
    // …nor any scorer error text.
    expect(screen.queryByText(/threw: boom/)).not.toBeInTheDocument();
  });

  it('shows the amber error rendering (not N/A) for a genuine failure', () => {
    render(
      <EvalItemDetail item={failedItem('q1')} itemIndex={0} scorerNames={['acc']} onBack={noop} />,
    );
    expect(screen.getByText(/threw: boom/)).toBeInTheDocument();
    // Failures are not skips — the N/A explanation must be absent.
    expect(screen.queryByText(/Not applicable/i)).not.toBeInTheDocument();
  });
});

describe('EvalItemList — skipped cell reads N/A', () => {
  const noop = () => {};
  const listProps = {
    onSelectItem: noop,
    errorFilter: 'all' as const,
    onErrorFilterChange: noop,
    scorerFilter: '',
    onScorerFilterChange: noop,
    threshold: '',
    onThresholdChange: noop,
    sortField: 'index',
    onSortFieldChange: noop,
    sortDir: 'asc' as const,
    onSortDirChange: noop,
  };

  it('renders "N/A" for a skipped scorer cell', () => {
    render(
      <EvalItemList
        items={[okItem('1', 0.9), skippedItem('2')]}
        scorerNames={['acc']}
        {...listProps}
      />,
    );
    const naCell = screen.getByTitle('Not applicable (N/A)');
    expect(naCell).toHaveTextContent('N/A');
  });

  it('marks a ran-and-failed cell with a "Scorer failed" tooltip (still a dash)', () => {
    render(
      <EvalItemList
        items={[okItem('1', 0.9), failedItem('2')]}
        scorerNames={['acc']}
        {...listProps}
      />,
    );
    expect(screen.getByTitle('Scorer failed')).toBeInTheDocument();
    // Failed is not skipped — no N/A cell.
    expect(screen.queryByTitle('Not applicable (N/A)')).not.toBeInTheDocument();
  });
});

describe('ScorerSampleChips — multi-run aggregate N/A chip', () => {
  it('renders the neutral N/A chip with the aggregate skipped count', () => {
    render(<ScorerSampleChips failed={0} skipped={3} />);
    expect(screen.getByText('N/A: 3')).toBeInTheDocument();
    // Distinct from a failure — no amber failed chip.
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  });

  it('renders both the amber failed chip and the neutral N/A chip together', () => {
    render(<ScorerSampleChips failed={2} skipped={1} />);
    expect(screen.getByText('2 failed')).toBeInTheDocument();
    expect(screen.getByText('N/A: 1')).toBeInTheDocument();
  });

  it('renders nothing when there are no failures or skips', () => {
    const { container } = render(<ScorerSampleChips failed={0} skipped={0} />);
    expect(container.textContent).toBe('');
  });
});

describe('EvalCompareItemTable — skipped cell is non-comparable', () => {
  const makeResult = (items: EvalItem[]): EvalResultData => ({
    id: 'r',
    dataset: 'ds',
    timestamp: '2026-05-31T00:00:00.000Z',
    totalCost: 0,
    duration: 0,
    items,
    summary: {
      count: items.length,
      failures: 0,
      scorers: { acc: { mean: 0.5, min: 0, max: 1, p50: 0.5, p95: 1 } },
    },
  });

  it('labels a cell skipped on the candidate side "N/A" and reports the delta as N/A', () => {
    // Baseline scored 0.80; candidate skipped this item for `acc`.
    const baseline = makeResult([okItem('q1', 0.8)]);
    const candidate = makeResult([skippedItem('q1')]);

    render(
      <EvalCompareItemTable baseline={baseline} candidate={candidate} scorerNames={['acc']} />,
    );

    const rows = screen.getAllByRole('row');
    // Find the data row (it carries the item label cell). Header row has the
    // sortable column headers; the data row contains the "0.800" baseline.
    const dataRow = rows.find((r) => within(r).queryByText('0.800'));
    expect(dataRow).toBeTruthy();
    const cells = within(dataRow!).getAllByText('N/A');
    // One N/A for the skipped candidate cell, one for the non-comparable delta.
    expect(cells.length).toBe(2);
    // The non-comparable delta must NOT be rendered as a red "-0.800" drop.
    expect(within(dataRow!).queryByText(/-0\.800/)).not.toBeInTheDocument();
  });

  it('still shows a real delta when neither side is skipped', () => {
    const baseline = makeResult([okItem('q1', 0.8)]);
    const candidate = makeResult([okItem('q1', 0.6)]);
    render(
      <EvalCompareItemTable baseline={baseline} candidate={candidate} scorerNames={['acc']} />,
    );
    // candidate - baseline = 0.6 - 0.8 = -0.200, a genuine drop.
    expect(screen.getByText('-0.200')).toBeInTheDocument();
    expect(screen.queryByText('N/A')).not.toBeInTheDocument();
  });

  // FINDING 4 — a ran-and-failed null (duration recorded, not skipped) must
  // carry a "Scorer failed" tooltip on its dash, distinct from a cancelled null
  // (no tooltip) and a skip ("N/A"). Both sides covered.
  it('tags a ran-and-failed candidate cell with a "Scorer failed" tooltip (still a dash)', () => {
    const baseline = makeResult([okItem('q1', 0.8)]);
    const candidate = makeResult([failedItem('q1')]); // null score WITH duration
    render(
      <EvalCompareItemTable baseline={baseline} candidate={candidate} scorerNames={['acc']} />,
    );
    expect(screen.getByTitle('Scorer failed')).toBeInTheDocument();
    // Not a skip — no N/A cell.
    expect(screen.queryByText('N/A')).not.toBeInTheDocument();
  });

  it('tags a ran-and-failed baseline cell with a "Scorer failed" tooltip', () => {
    const baseline = makeResult([failedItem('q1')]);
    const candidate = makeResult([okItem('q1', 0.8)]);
    render(
      <EvalCompareItemTable baseline={baseline} candidate={candidate} scorerNames={['acc']} />,
    );
    expect(screen.getByTitle('Scorer failed')).toBeInTheDocument();
  });

  it('leaves a cancelled null (no duration, not skipped) untitled', () => {
    const cancelledItem = (q: string): EvalItem => ({
      input: { q },
      output: 'x',
      scores: { acc: null },
      scoreDetails: { acc: { score: null } }, // no duration, no skipped marker
    });
    const baseline = makeResult([okItem('q1', 0.8)]);
    const candidate = makeResult([cancelledItem('q1')]);
    render(
      <EvalCompareItemTable baseline={baseline} candidate={candidate} scorerNames={['acc']} />,
    );
    // A cancelled null gets neither "Scorer failed" nor "N/A".
    expect(screen.queryByTitle('Scorer failed')).not.toBeInTheDocument();
  });
});

// FINDING 1 — the multi-run Per-Scorer Aggregate row (extracted to
// AggregateScorerRow) must not miscolor a fully-skipped scorer (scored 0,
// mean/min/max = 0) as a red 0.000; it shows "No valid scores" like the
// single-run summary.
describe('AggregateScorerRow — fully-skipped scorer parity', () => {
  const renderRow = (props: Parameters<typeof AggregateScorerRow>[0]) =>
    render(
      <table>
        <tbody>
          <AggregateScorerRow {...props} />
        </tbody>
      </table>,
    );

  it('renders "No valid scores" when the scorer scored zero items', () => {
    renderRow({
      name: 'acc',
      stats: { mean: 0, std: 0, min: 0, max: 0, scored: 0, failed: 0, skipped: 3 },
    });
    expect(screen.getByText('No valid scores')).toBeInTheDocument();
    // No red 0.000 mean.
    expect(screen.queryByText('0.000')).not.toBeInTheDocument();
    // The N/A chip still surfaces the skip count.
    expect(screen.getByText('N/A: 3')).toBeInTheDocument();
  });

  it('renders the stat columns normally when the scorer scored at least one item', () => {
    renderRow({
      name: 'acc',
      stats: { mean: 0.9, std: 0.01, min: 0.88, max: 0.92, scored: 3, failed: 0, skipped: 0 },
    });
    expect(screen.queryByText('No valid scores')).not.toBeInTheDocument();
    expect(screen.getByText('0.900')).toBeInTheDocument();
  });
});

// FINDING 2 — a per-side mean of 0 from a fully-skipped scorer must NOT render
// red in the compare summary table; it renders neutral muted.
describe('EvalCompareView — per-side mean not red when scored 0', () => {
  const makeSide = (items: EvalItem[]): EvalResultData => ({
    id: 'r',
    dataset: 'ds',
    timestamp: '2026-05-31T00:00:00.000Z',
    totalCost: 0,
    duration: 0,
    items,
    summary: {
      count: items.length,
      failures: 0,
      scorers: { acc: { mean: 0, min: 0, max: 0, p50: 0, p95: 0 } },
    },
  });

  const compareResult: ComparisonResult = {
    regressions: [],
    improvements: [],
    summary: '',
    scorers: {
      acc: {
        baselineMean: 0,
        candidateMean: 0.9,
        delta: 0.9,
        deltaPercent: 0,
        // Baseline fully skipped this scorer; candidate scored it.
        baselineScored: 0,
        candidateScored: 3,
      },
    },
  };

  it('colors a scored-0 side mean neutral (muted), not red', () => {
    const baseline = makeSide([skippedItem('q1')]);
    const candidate = makeSide([okItem('q1', 0.9)]);
    render(
      <EvalCompareView compareResult={compareResult} baseline={baseline} candidate={candidate} />,
    );
    // The baseline 0.000 cell must carry the muted class, not text-red-*.
    const cells = screen.getAllByText('0.000');
    const baselineMeanCell = cells.find((el) =>
      el.className.includes('text-[hsl(var(--muted-foreground))]'),
    );
    expect(baselineMeanCell).toBeTruthy();
    expect(baselineMeanCell!.className).not.toMatch(/text-red/);
  });
});
