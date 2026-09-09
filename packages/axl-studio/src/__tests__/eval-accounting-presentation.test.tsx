// @vitest-environment jsdom
/**
 * Presentation coverage for measured eval spend, budget outcomes, item/scorer
 * outcomes and cost certification in the Eval Runner panels.
 *
 * These tests all defend one property: **a Studio view never states a spend or
 * a coverage figure more confidently than the artifact supports.** Every case
 * below has a specific wrong rendering it kills — a bare `$0.00` that reads as
 * "free", a legacy run labelled complete, a budget-skipped judge shown as a
 * zero, a partial run advertised as cheaper.
 *
 * Test-matrix rows: A5.9, A15.9, A15.10, A16.18 (P5 sections).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { EvalSummaryTable } from '../client/panels/eval-runner/EvalSummaryTable';
import { EvalItemList } from '../client/panels/eval-runner/EvalItemList';
import { EvalItemDetail } from '../client/panels/eval-runner/EvalItemDetail';
import { EvalHistoryTable } from '../client/panels/eval-runner/EvalHistoryTable';
import { EvalCompareView } from '../client/panels/eval-runner/EvalCompareView';
import type {
  Accounting,
  ComparisonResult,
  EvalAccounting,
  EvalCoverage,
  EvalItem,
  EvalItemOutcome,
  EvalResultData,
  ScorerOutcome,
} from '../client/panels/eval-runner/types';
import type { EvalHistoryEntry } from '../client/lib/types';

// ── Fixtures ─────────────────────────────────────────────────────

function accounting(overrides: Partial<EvalAccounting> = {}): EvalAccounting {
  return {
    version: 1,
    currency: 'USD',
    knownCost: 0,
    completeness: 'complete',
    reasons: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      audioSeconds: 0,
    },
    operations: { total: 0, settled: 0, unknown: 0, denied: 0, byKind: {} },
    breakdown: { generation: 0, judging: 0, external: 0 },
    provenance: {},
    scope: 'run',
    ...overrides,
  };
}

function coverage(
  items: Partial<Record<EvalItemOutcome, number>>,
  scorers: Record<string, Partial<Record<ScorerOutcome, number>>> = {},
): EvalCoverage {
  return {
    items: {
      completed: 0,
      failed: 0,
      cancelled: 0,
      budget_skipped: 0,
      budget_interrupted: 0,
      ...items,
    },
    scorers: Object.fromEntries(
      Object.entries(scorers).map(([name, counts]) => [
        name,
        {
          scored: 0,
          failed: 0,
          skipped: 0,
          cancelled: 0,
          budget_skipped: 0,
          budget_interrupted: 0,
          ...counts,
        },
      ]),
    ),
  };
}

function result(overrides: Partial<EvalResultData> = {}): EvalResultData {
  return {
    id: 'run-1',
    dataset: 'ds',
    timestamp: '2026-09-09T00:00:00.000Z',
    totalCost: 0,
    duration: 1000,
    items: [],
    summary: { count: 0, failures: 0, scorers: {} },
    ...overrides,
  };
}

const itemProps = {
  onSelectItem: () => {},
  errorFilter: 'all' as const,
  onErrorFilterChange: () => {},
  scorerFilter: '',
  onScorerFilterChange: () => {},
  threshold: '',
  onThresholdChange: () => {},
  sortField: 'index',
  onSortFieldChange: () => {},
  sortDir: 'asc' as const,
  onSortDirChange: () => {},
};

// ── Known spend + completeness ───────────────────────────────────

describe('EvalSummaryTable — known spend carries its completeness', () => {
  it('labels a fully measured run complete', () => {
    render(
      <EvalSummaryTable
        result={result({
          totalCost: 1.5,
          accounting: accounting({
            knownCost: 1.5,
            operations: {
              total: 3,
              settled: 3,
              unknown: 0,
              denied: 0,
              byKind: { chat: 3 },
            },
          }),
        })}
      />,
    );
    expect(screen.getByLabelText('Known spend $1.50, complete')).toBeInTheDocument();
  });

  it('never hides an unknown $0 — an unpriced run states its reasons', () => {
    // The defect: a run whose model had no price rendered `$0.00`, or nothing
    // at all, which reads as "this was free" when the truth is "we could not
    // price 2 operations".
    render(
      <EvalSummaryTable
        result={result({
          totalCost: 0,
          unpriced: true,
          accounting: accounting({
            knownCost: 0,
            completeness: 'incomplete',
            reasons: { unpriced_model: 2 },
          }),
        })}
      />,
    );
    expect(
      screen.getByLabelText('Known spend $0.00, incomplete: 2 unpriced_model'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/complete$/)).not.toBeInTheDocument();
  });

  it('reads a legacy artifact as unverified, never as complete', () => {
    // No `accounting` block at all — a pre-0.24 artifact. Its `totalCost` is
    // repeated for continuity but must never be certified.
    render(<EvalSummaryTable result={result({ totalCost: 0.42 })} />);
    expect(screen.getByLabelText('Known spend $0.42, unverified (legacy)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Known spend $0.42, complete')).not.toBeInTheDocument();
  });
});

// ── A5.9 — a budget-stopped run in the summary view ──────────────

describe('A5.9 — budget-stopped run in EvalSummaryTable', () => {
  const budgetStopped = result({
    totalCost: 1.5,
    accounting: accounting({
      knownCost: 1.5,
      budget: {
        limit: 1,
        status: 'closed',
        knownSpend: 1.5,
        knownOvershoot: 0.5,
        closedBy: 'case',
      },
    }),
    summary: {
      count: 5,
      failures: 3,
      coverage: coverage({ completed: 2, budget_skipped: 2, budget_interrupted: 1 }),
      scorers: {},
    },
  });

  it('shows known spend, the limit, the overshoot and a stop label', () => {
    render(<EvalSummaryTable result={budgetStopped} />);
    const budget = screen.getByText(/STOPPED/);
    expect(budget).toHaveTextContent('$1.50 known spend against a $1.00 limit');
    expect(budget).toHaveTextContent('$0.50 over');
    expect(budget).toHaveTextContent('first observed by case');
    expect(screen.getByLabelText('Known spend $1.50, complete')).toBeInTheDocument();
  });

  it('does not present the truncated run as a completed full run', () => {
    render(<EvalSummaryTable result={budgetStopped} />);
    // The stopped cases are counted as stopped, not as model failures.
    const items = screen.getByText('Items').closest('div')!;
    expect(within(items).getByLabelText('Item outcome: budget skipped')).toBeInTheDocument();
    expect(within(items).getByLabelText('Item outcome: budget interrupted')).toBeInTheDocument();
    // `summary.failures` stays visible with its legacy meaning spelled out.
    expect(
      screen.getByText(/items carrying an error string \(includes cancelled \/ budget-stopped\)/),
    ).toBeInTheDocument();
  });
});

// ── A15.9 — five distinct item outcomes ──────────────────────────

describe('A15.9 — the five item outcomes render distinctly', () => {
  const outcomes: EvalItemOutcome[] = [
    'completed',
    'failed',
    'cancelled',
    'budget_skipped',
    'budget_interrupted',
  ];

  it('gives each item outcome its own accessible label', () => {
    const items: EvalItem[] = outcomes.map((outcome, i) => ({
      input: { q: `q${i}` },
      output: 'out',
      scores: {},
      outcome,
    }));
    render(<EvalItemList items={items} scorerNames={[]} {...itemProps} />);
    const labels = outcomes.map(
      (o) => screen.getByLabelText(`Item outcome: ${o.replace('_', ' ')}`).textContent,
    );
    // Five outcomes, five different words — not one "failed" pill for all of them.
    expect(new Set(labels).size).toBe(5);
    expect(labels).toEqual([
      'completed',
      'failed',
      'cancelled',
      'budget skipped',
      'budget interrupted',
    ]);
  });

  it('shows a completeness badge on an incomplete history row and none on a complete one', () => {
    const history: EvalHistoryEntry[] = [
      {
        id: 'a',
        eval: 'e1',
        timestamp: 2,
        data: result({
          id: 'a',
          totalCost: 1,
          accounting: accounting({ knownCost: 1 }),
        }),
      },
      {
        id: 'b',
        eval: 'e1',
        timestamp: 1,
        // Legacy artifact: no accounting block.
        data: result({ id: 'b', totalCost: 2 }),
      },
    ];
    render(
      <EvalHistoryTable
        history={history}
        evalFilter=""
        onEvalFilterChange={() => {}}
        onSelect={() => {}}
        expandedGroups={new Set()}
        onToggleGroup={() => {}}
      />,
    );
    expect(screen.getByLabelText('Known spend $1.00, complete')).toBeInTheDocument();
    expect(screen.getByLabelText('Known spend $2.00, unverified (legacy)')).toBeInTheDocument();
    // Exactly one row carries the chip — the legacy one.
    expect(screen.getAllByText('unverified')).toHaveLength(1);
  });

  it('badges a budget-stopped history row', () => {
    const history: EvalHistoryEntry[] = [
      {
        id: 'a',
        eval: 'e1',
        timestamp: 1,
        data: result({
          id: 'a',
          totalCost: 1.5,
          accounting: accounting({
            knownCost: 1.5,
            budget: { limit: 1, status: 'closed', knownSpend: 1.5, knownOvershoot: 0.5 },
          }),
        }),
      },
    ];
    render(
      <EvalHistoryTable
        history={history}
        evalFilter=""
        onEvalFilterChange={() => {}}
        onSelect={() => {}}
        expandedGroups={new Set()}
        onToggleGroup={() => {}}
      />,
    );
    expect(screen.getByLabelText('Budget stopped')).toBeInTheDocument();
  });
});

// ── A15.10 — budget-skipped judges ───────────────────────────────

describe('A15.10 — a completed item with budget-skipped judges', () => {
  const item: EvalItem = {
    input: { q: 'why' },
    output: 'the answer',
    scores: { judge: null },
    outcome: 'completed',
    accounting: {
      ...accounting({ knownCost: 0.2, breakdown: { generation: 0.2, judging: 0, external: 0 } }),
    } as Accounting,
    scoreDetails: { judge: { score: null, outcome: 'budget_skipped' } },
  };

  it('keeps the item visible in the list with its judge labelled "not run (budget)"', () => {
    render(<EvalItemList items={[item]} scorerNames={['judge']} {...itemProps} />);
    // The item is NOT filtered out for lacking a score.
    expect(screen.getByText('why')).toBeInTheDocument();
    // The judge cell says "not run (budget)" and carries NO numeric score.
    // Rendering a `0.00` there — the defect this kills — would put an unrun
    // judge in the same bucket as a judge that scored zero.
    const judgeCell = screen.getByLabelText('Scorer outcome: not run (budget)').closest('td')!;
    expect(judgeCell).toHaveTextContent('not run (budget)');
    expect(judgeCell.textContent).not.toMatch(/\d\.\d/);
  });

  it('shows the output and the judge outcome in the item detail', () => {
    render(<EvalItemDetail item={item} itemIndex={0} scorerNames={['judge']} onBack={() => {}} />);
    expect(screen.getAllByLabelText('Scorer outcome: not run (budget)').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Item outcome: completed')).toBeInTheDocument();
    // Generation spend is separated from judging spend, each with completeness.
    expect(screen.getByLabelText('Generation spend $0.20, complete')).toBeInTheDocument();
    expect(screen.getByLabelText('Judging spend $0.00, complete')).toBeInTheDocument();
  });

  it('labels a caller-reported cost as not counted', () => {
    render(
      <EvalItemDetail
        item={{ ...item, callerReport: { cost: 9.99 } }}
        itemIndex={0}
        scorerNames={['judge']}
        onBack={() => {}}
      />,
    );
    expect(screen.getByText(/\$9\.99 — caller-reported \(not counted\)/)).toBeInTheDocument();
    // The claim never becomes the measurement.
    expect(screen.queryByLabelText(/known spend \$9\.99/i)).not.toBeInTheDocument();
  });
});

// ── Cost certification in the compare view ───────────────────────

describe('EvalCompareView — uncertified cost is descriptive, not a saving', () => {
  function comparison(cost: ComparisonResult['cost']): ComparisonResult {
    return {
      baseline: { id: 'b', runCount: 1 },
      candidate: { id: 'c', runCount: 1 },
      regressions: [],
      improvements: [],
      scorers: {
        acc: { baselineMean: 0.8, candidateMean: 0.85, delta: 0.05, deltaPercent: 6.25 },
      },
      cost,
      summary: 'ok',
    };
  }

  it('states the refusal reason and never claims a percentage saving', () => {
    render(
      <EvalCompareView
        compareResult={comparison({
          baselineTotal: 1,
          candidateTotal: 0.4,
          delta: -0.6,
          deltaPercent: -60,
          certified: false,
          reason: 'candidate accounting is incomplete',
        })}
        baseline={null}
        candidate={null}
      />,
    );
    expect(
      screen.getByText('not certified: candidate accounting is incomplete'),
    ).toBeInTheDocument();
    expect(screen.getByText('not certified')).toBeInTheDocument();
    // Quality comparison is untouched by an uncertified cost.
    expect(screen.getByText('acc')).toBeInTheDocument();
  });

  it('renders a null deltaPercent as n/a rather than 0% or Infinity', () => {
    render(
      <EvalCompareView
        compareResult={comparison({
          baselineTotal: 0,
          candidateTotal: 0.4,
          delta: 0.4,
          deltaPercent: null,
          certified: false,
          reason: 'baseline total is zero',
        })}
        baseline={null}
        candidate={null}
      />,
    );
    expect(screen.getByText(/\(n\/a\)/)).toBeInTheDocument();
  });

  it('treats an absent `certified` flag (older server) as not certified', () => {
    render(
      <EvalCompareView
        compareResult={comparison({
          baselineTotal: 1,
          candidateTotal: 0.4,
          delta: -0.6,
          deltaPercent: -60,
        })}
        baseline={null}
        candidate={null}
      />,
    );
    expect(screen.getByText('not certified: costs are not comparable')).toBeInTheDocument();
  });

  it('certifies only when the server says so', () => {
    render(
      <EvalCompareView
        compareResult={comparison({
          baselineTotal: 1,
          candidateTotal: 0.9,
          delta: -0.1,
          deltaPercent: -10,
          certified: true,
        })}
        baseline={null}
        candidate={null}
      />,
    );
    expect(
      screen.getByText('certified — both sides complete and equally covered'),
    ).toBeInTheDocument();
  });
});
