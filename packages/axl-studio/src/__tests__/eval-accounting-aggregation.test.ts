/**
 * Conservative aggregation of eval spend across multi-run groups and trend
 * windows, plus the tripwire that keeps every eval cost render routed through
 * a completeness-carrying helper.
 *
 * The property under test throughout: **folding several runs together never
 * makes the result more certain than its least certain input.** One legacy run
 * makes a group unverified; one incomplete run makes it incomplete; and neither
 * can be talked back into `complete` by aggregation, by the window cap, or by
 * inheriting run[0]'s flags.
 *
 * Test-matrix rows: A16.17, A16.18 (P5 sections), invariants S1 and S3.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { emptyEvalTrendData, reduceEvalTrends } from '../server/aggregates/reducers.js';
import type { EvalHistoryEntry } from '@axlsdk/axl';
import {
  aggregateAccounting,
  readAccounting,
  readItemAccounting,
  worseCompleteness,
} from '../client/panels/eval-runner/accounting.js';
import {
  aggregateGroupAccounting,
  buildMultiRunResult,
} from '../client/panels/eval-runner/types.js';
import type {
  Accounting,
  EvalAccounting,
  EvalResultData,
} from '../client/panels/eval-runner/types.js';

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

function run(id: string, acc?: EvalAccounting, totalCost = 0): EvalResultData {
  return {
    id,
    dataset: 'ds',
    timestamp: '2026-09-09T00:00:00.000Z',
    totalCost: acc ? acc.knownCost : totalCost,
    duration: 100,
    items: [],
    summary: {
      count: 1,
      failures: 0,
      scorers: { acc: { mean: 0.8, min: 0.8, max: 0.8, p50: 0.8, p95: 0.8 } },
    },
    metadata: { runGroupId: 'g1' },
    ...(acc ? { accounting: acc } : {}),
  };
}

// ── Reading rules ────────────────────────────────────────────────

describe('readAccounting', () => {
  it('reports an artifact with no accounting block as unverified, never complete', () => {
    const read = readAccounting(run('legacy', undefined, 0.42));
    expect(read.completeness).toBe('unverified');
    expect(read.knownCost).toBe(0.42);
  });

  it('returns the recorded accounting unchanged when present', () => {
    const acc = accounting({
      knownCost: 1.25,
      completeness: 'incomplete',
      reasons: { usage_missing: 1 },
    });
    expect(readAccounting(run('r', acc))).toBe(acc);
  });

  it('reads a legacy item cost as unverified and splits it by purpose', () => {
    const read = readItemAccounting({
      input: {},
      output: {},
      scores: {},
      cost: 0.3,
      scorerCost: 0.1,
    });
    expect(read.completeness).toBe('unverified');
    expect(read.knownCost).toBeCloseTo(0.4);
    expect(read.breakdown).toEqual({ generation: 0.3, judging: 0.1, external: 0 });
  });
});

describe('worseCompleteness', () => {
  it('ranks unverified above incomplete above complete', () => {
    expect(worseCompleteness('complete', 'incomplete')).toBe('incomplete');
    expect(worseCompleteness('incomplete', 'unverified')).toBe('unverified');
    expect(worseCompleteness('complete', 'complete')).toBe('complete');
  });
});

// ── A16.18 — the client reducer unions rather than inheriting ────

describe('A16.18 — buildMultiRunResult unions accounting', () => {
  it('does not inherit run[0]: one incomplete run makes the group incomplete', () => {
    const group = buildMultiRunResult([
      run('r0', accounting({ knownCost: 1 })),
      run(
        'r1',
        accounting({ knownCost: 0.5, completeness: 'incomplete', reasons: { unpriced_model: 2 } }),
      ),
    ])!;
    expect(group.accounting!.completeness).toBe('incomplete');
    expect(group.accounting!.knownCost).toBeCloseTo(1.5);
    expect(group.accounting!.reasons).toEqual({ unpriced_model: 2 });
    // The compatibility view can never disagree with the record it mirrors.
    expect(group.totalCost).toBeCloseTo(1.5);
    expect(group.unpriced).toBe(true);
  });

  it('one legacy run makes the whole group unverified', () => {
    const group = buildMultiRunResult([
      run('r0', accounting({ knownCost: 1 })),
      run('r1', undefined, 2),
    ])!;
    expect(group.accounting!.completeness).toBe('unverified');
    expect(group.accounting!.knownCost).toBeCloseTo(3);
  });

  it('reports a group of complete runs as complete', () => {
    const group = buildMultiRunResult([
      run('r0', accounting({ knownCost: 1 })),
      run('r1', accounting({ knownCost: 2 })),
    ])!;
    expect(group.accounting!.completeness).toBe('complete');
    expect(
      group.aggregate?.accounting?.completeness ??
        group._multiRun!.aggregate.accounting!.completeness,
    ).toBe('complete');
  });

  it('counts budget-stopped runs on the aggregate instead of calling them failures', () => {
    const stopped = accounting({
      knownCost: 1.5,
      budget: { limit: 1, status: 'closed', knownSpend: 1.5, knownOvershoot: 0.5 },
    });
    const group = buildMultiRunResult([
      run('r0', accounting({ knownCost: 1 })),
      run('r1', stopped),
    ])!;
    expect(group._multiRun!.aggregate.budgetStoppedRuns).toBe(1);
    expect(group.summary.failures).toBe(0);
  });

  it('sums per-outcome coverage across the group', () => {
    const withCoverage = (id: string, completed: number, skipped: number): EvalResultData => ({
      ...run(id, accounting({ knownCost: 0 })),
      summary: {
        count: completed + skipped,
        failures: skipped,
        coverage: {
          items: {
            completed,
            failed: 0,
            cancelled: 0,
            budget_skipped: skipped,
            budget_interrupted: 0,
          },
          scorers: {},
        },
        scorers: {},
      },
    });
    const group = buildMultiRunResult([withCoverage('r0', 2, 1), withCoverage('r1', 3, 2)])!;
    expect(group.summary.coverage!.items).toEqual({
      completed: 5,
      failed: 0,
      cancelled: 0,
      budget_skipped: 3,
      budget_interrupted: 0,
    });
  });

  it('omits coverage entirely when no run recorded any', () => {
    // A fabricated row of zeros would claim "0 budget-skipped" about runs that
    // never recorded the fact.
    const group = buildMultiRunResult([run('r0', undefined, 1), run('r1', undefined, 2)])!;
    expect(group.summary.coverage).toBeUndefined();
  });
});

describe('aggregateGroupAccounting', () => {
  it('matches the same conservative rules as the shared fold', () => {
    const inputs: Accounting[] = [
      accounting({ knownCost: 1 }),
      accounting({ knownCost: 2, completeness: 'incomplete', reasons: { abandoned: 1 } }),
    ];
    const folded = aggregateAccounting(inputs);
    const viaGroup = aggregateGroupAccounting([
      run('a', inputs[0] as EvalAccounting),
      run('b', inputs[1] as EvalAccounting),
    ]);
    expect(viaGroup.completeness).toBe(folded.completeness);
    expect(viaGroup.knownCost).toBe(folded.knownCost);
    expect(viaGroup.reasons).toEqual(folded.reasons);
  });

  it('reports an empty group as complete at $0 — nothing contributed an unknown', () => {
    expect(aggregateGroupAccounting([])).toMatchObject({ knownCost: 0, completeness: 'complete' });
  });
});

// ── A16.17 — trends reducer carries a conservative status ────────

describe('A16.17 — reduceEvalTrends completeness', () => {
  const entry = (id: string, data: unknown, timestamp = 1): EvalHistoryEntry =>
    ({ id, eval: 'e1', timestamp, data }) as unknown as EvalHistoryEntry;

  it('marks a window containing an unverified (legacy) run as unverified', () => {
    let state = emptyEvalTrendData();
    state = reduceEvalTrends(state, entry('a', run('a', accounting({ knownCost: 1 }))));
    expect(state.totalCostCompleteness).toBe('complete');
    state = reduceEvalTrends(state, entry('b', run('b', undefined, 2), 2));
    expect(state.totalCostCompleteness).toBe('unverified');
    expect(state.byEval.e1.costCompleteness).toBe('unverified');
    expect(state.byEval.e1.costTotal).toBeCloseTo(3);
  });

  it('marks a window containing an incomplete run as incomplete', () => {
    let state = emptyEvalTrendData();
    state = reduceEvalTrends(state, entry('a', run('a', accounting({ knownCost: 1 }))));
    state = reduceEvalTrends(
      state,
      entry(
        'b',
        run(
          'b',
          accounting({ knownCost: 0, completeness: 'incomplete', reasons: { unpriced_model: 1 } }),
        ),
        2,
      ),
    );
    expect(state.byEval.e1.costCompleteness).toBe('incomplete');
    expect(state.totalCostCompleteness).toBe('incomplete');
  });

  it('stamps per-run completeness and cost from accounting, not raw totalCost', () => {
    // `knownCost` is authoritative even when a stale `totalCost` disagrees.
    const data = { ...run('a', accounting({ knownCost: 1.25 })), totalCost: 99 };
    const state = reduceEvalTrends(emptyEvalTrendData(), entry('a', data));
    expect(state.byEval.e1.runs[0].cost).toBe(1.25);
    expect(state.byEval.e1.runs[0].completeness).toBe('complete');
  });

  it('flags a budget-stopped run on its trend point and counts it for the window', () => {
    const stopped = accounting({
      knownCost: 1.5,
      budget: { limit: 1, status: 'closed', knownSpend: 1.5, knownOvershoot: 0.5 },
    });
    const state = reduceEvalTrends(emptyEvalTrendData(), entry('a', run('a', stopped)));
    expect(state.byEval.e1.runs[0].budgetStopped).toBe(true);
    expect(state.byEval.e1.budgetStoppedRuns).toBe(1);
  });

  it('keeps the window flag conservative after the run cap evicts the bad run', () => {
    // `costTotal` still counts evicted runs, so recomputing the flag from the
    // visible window would silently re-certify a total containing a legacy run.
    let state = reduceEvalTrends(
      emptyEvalTrendData(),
      entry('legacy', run('legacy', undefined, 5)),
    );
    for (let i = 0; i < 60; i++) {
      state = reduceEvalTrends(
        state,
        entry(`ok-${i}`, run(`ok-${i}`, accounting({ knownCost: 0.01 })), i + 2),
      );
    }
    expect(state.byEval.e1.runs.length).toBe(50);
    expect(state.byEval.e1.runs.some((r) => r.id === 'legacy')).toBe(false);
    expect(state.byEval.e1.costCompleteness).toBe('unverified');
    expect(state.totalCostCompleteness).toBe('unverified');
  });

  it('treats a malformed completeness value as unverified rather than trusting it', () => {
    const data = { ...run('a'), accounting: { knownCost: 1, completeness: 'totally-fine' } };
    const state = reduceEvalTrends(emptyEvalTrendData(), entry('a', data));
    expect(state.byEval.e1.runs[0].completeness).toBe('unverified');
  });
});

// ── S1 — no eval panel renders a bare cost ───────────────────────

describe('S1 tripwire — eval panels route cost through a completeness helper', () => {
  const panelDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../client/panels/eval-runner',
  );

  /**
   * The compatibility spend fields on the eval result shape. Reading one in a
   * view means deriving a figure without its completeness — exactly the render
   * `SpendBadge` / `readAccounting` exist to replace.
   *
   * `accounting.ts` is the one legitimate reader (it is the compat reader), and
   * `types.ts` declares the fields.
   */
  const COMPAT_FIELDS = /\.totalCost\b|\.scorerCost\b/g;
  const READER_MODULES = new Set(['accounting.ts', 'types.ts']);

  /**
   * Reads that are NOT the defect, each with the statement that travels with
   * it. Every entry here is a deliberate decision; a new direct render trips
   * the test and has to be argued into this list or routed through the badge.
   */
  const ALLOWED: Record<string, string[]> = {
    // The trend payload's own total, rendered beside
    // `completenessText(trends.totalCostCompleteness)` in the same StatCard.
    'EvalTrendsView.tsx': ['trends.totalCost'],
  };

  it('reads no eval compat spend field outside the reader module', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(panelDir)) {
      if (READER_MODULES.has(file) || !/\.(ts|tsx)$/.test(file)) continue;
      const source = readFileSync(path.join(panelDir, file), 'utf8');
      const lines = source.split('\n');
      for (const match of source.matchAll(COMPAT_FIELDS)) {
        const lineIndex = source.slice(0, match.index).split('\n').length - 1;
        const line = lines[lineIndex].trim();
        // Prose in a comment is not a render.
        if (line.startsWith('*') || line.startsWith('//')) continue;
        const allowed = ALLOWED[file] ?? [];
        if (allowed.some((snippet) => line.includes(snippet))) continue;
        offenders.push(`${file}: ${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never passes an item or scorer compat cost straight to formatCost', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(panelDir)) {
      if (READER_MODULES.has(file) || !/\.(ts|tsx)$/.test(file)) continue;
      const source = readFileSync(path.join(panelDir, file), 'utf8');
      for (const match of source.matchAll(/formatCost\(([^)]*)\)/g)) {
        if (
          /\b(?:item|detail|entry|data|result|r)\.(?:cost|scorerCost|totalCost)\b/.test(match[1])
        ) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
