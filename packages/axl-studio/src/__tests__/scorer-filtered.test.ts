import { describe, it, expect } from 'vitest';
import {
  getResultScorerFiltered,
  type EvalResultData,
} from '../client/panels/eval-runner/types.js';

/**
 * The eval CLI stamps `metadata.scorerFiltered: true` + `metadata.scorersRun`
 * when run with `--scorers`; the Eval Runner panel reads them via this helper
 * to render the amber "filtered scorer subset" banner. This verifies the read
 * is null-safe, gated on the `scorerFiltered` flag, and filters non-string junk
 * — `metadata` is an untyped `Record<string, unknown>` that can carry anything
 * from imported CLI artifacts.
 */
function makeResult(metadata?: Record<string, unknown>): EvalResultData {
  return {
    id: 'r1',
    dataset: 'ds',
    timestamp: '2026-05-29T00:00:00.000Z',
    duration: 1,
    totalCost: 0,
    items: [],
    summary: { count: 0, failures: 0, scorers: {} },
    ...(metadata ? { metadata } : {}),
  };
}

describe('getResultScorerFiltered', () => {
  it('returns the scorers run when scorerFiltered is true', () => {
    const result = makeResult({ scorerFiltered: true, scorersRun: ['accuracy', 'tone'] });
    expect(getResultScorerFiltered(result)).toEqual(['accuracy', 'tone']);
  });

  it('returns [] when scorerFiltered is not true even if scorersRun is present', () => {
    const result = makeResult({ scorersRun: ['accuracy', 'tone'] });
    expect(getResultScorerFiltered(result)).toEqual([]);
  });

  it('returns [] when scorerFiltered is false', () => {
    const result = makeResult({ scorerFiltered: false, scorersRun: ['accuracy'] });
    expect(getResultScorerFiltered(result)).toEqual([]);
  });

  it('returns [] when metadata is absent', () => {
    expect(getResultScorerFiltered(makeResult())).toEqual([]);
  });

  it('filters non-string entries from a malformed/imported payload', () => {
    const result = makeResult({ scorerFiltered: true, scorersRun: ['ok', 42, null, { x: 1 }] });
    expect(getResultScorerFiltered(result)).toEqual(['ok']);
  });

  it('returns [] when scorersRun is not an array', () => {
    expect(
      getResultScorerFiltered(makeResult({ scorerFiltered: true, scorersRun: 'oops' })),
    ).toEqual([]);
  });
});
