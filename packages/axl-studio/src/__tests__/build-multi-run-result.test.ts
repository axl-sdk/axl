import { describe, it, expect } from 'vitest';
import { buildMultiRunResult, type EvalResultData } from '../client/panels/eval-runner/types.js';

/**
 * Unit coverage for the partial-batch derivation path. The integration test
 * (`tests/studio/api/evals.test.ts`) verifies the server stamps
 * `metadata.batchAttempted` on persisted runs; this file verifies the
 * client-side aggregator turns that into the right `_multiRun.partial` /
 * `batchCompleted` / `batchAttempted` / `batchFailure` shape so the panel
 * banner renders correctly when a group is loaded from history.
 */

function makeRun(
  runIndex: number,
  metadata: Record<string, unknown> = {},
  scorers: Record<string, number> = { acc: 0.8 },
): EvalResultData {
  return {
    id: `run-${runIndex}`,
    dataset: 'ds',
    timestamp: '2026-04-30T00:00:00.000Z',
    duration: 1000,
    totalCost: 0.01,
    items: [],
    summary: {
      count: 1,
      failures: 0,
      scorers: Object.fromEntries(
        Object.entries(scorers).map(([k, v]) => [k, { mean: v, min: v, max: v, p50: v, p95: v }]),
      ),
    },
    metadata: { runGroupId: 'g1', runIndex, ...metadata },
  };
}

describe('buildMultiRunResult', () => {
  it('returns null on empty input', () => {
    expect(buildMultiRunResult([])).toBeNull();
  });

  it('produces no partial markers on a complete batch (no batchAttempted set)', () => {
    const result = buildMultiRunResult([makeRun(0), makeRun(1), makeRun(2)]);
    expect(result).not.toBeNull();
    expect(result!._multiRun?.partial).toBeUndefined();
    expect(result!._multiRun?.batchCompleted).toBeUndefined();
    expect(result!._multiRun?.batchAttempted).toBeUndefined();
    expect(result!._multiRun?.aggregate.runCount).toBe(3);
  });

  it('produces no partial markers when batchAttempted equals run count', () => {
    // A multi-run group where every planned run completed. Each persisted
    // run has batchAttempted stamped (Studio's run endpoint always stamps),
    // but allRuns.length === batchAttempted, so it's NOT partial.
    const result = buildMultiRunResult([
      makeRun(0, { batchAttempted: 3 }),
      makeRun(1, { batchAttempted: 3 }),
      makeRun(2, { batchAttempted: 3 }),
    ]);
    expect(result!._multiRun?.partial).toBeUndefined();
    expect(result!._multiRun?.batchCompleted).toBeUndefined();
    expect(result!._multiRun?.batchAttempted).toBeUndefined();
  });

  it('marks partial when allRuns.length < metadata.batchAttempted', () => {
    const result = buildMultiRunResult([
      makeRun(0, { batchAttempted: 5 }),
      makeRun(1, { batchAttempted: 5 }),
    ]);
    expect(result!._multiRun?.partial).toBe(true);
    expect(result!._multiRun?.batchCompleted).toBe(2);
    expect(result!._multiRun?.batchAttempted).toBe(5);
    expect(result!._multiRun?.aggregate.runCount).toBe(2);
  });

  it('propagates batchFailure from per-run metadata onto _multiRun.batchFailure', () => {
    // Either the first or any subsequent run can carry the failure message
    // — buildMultiRunResult takes the first non-empty string it finds. The
    // panel's banner uses this to show the "Stopped after: ..." line.
    const result = buildMultiRunResult([
      makeRun(0, { batchAttempted: 5, batchFailure: 'Provider returned 503' }),
      makeRun(1, { batchAttempted: 5, batchFailure: 'Provider returned 503' }),
    ]);
    expect(result!._multiRun?.batchFailure).toBe('Provider returned 503');
  });

  it('omits batchFailure when no run carries one', () => {
    // Possible if the persisted records came from a run-not-completed-due-to-
    // cancellation rather than a thrown failure.
    const result = buildMultiRunResult([
      makeRun(0, { batchAttempted: 5 }),
      makeRun(1, { batchAttempted: 5 }),
    ]);
    expect(result!._multiRun?.partial).toBe(true);
    expect(result!._multiRun?.batchFailure).toBeUndefined();
  });

  it('finds batchFailure even if only later runs carry it', () => {
    // CLI artifacts stamp every completed run; Studio stamps only on the
    // server response (not persisted on each run). buildMultiRunResult
    // walks every run looking for a string field, so order doesn't matter.
    const result = buildMultiRunResult([
      makeRun(0, { batchAttempted: 5 }),
      makeRun(1, { batchAttempted: 5, batchFailure: 'Network timeout' }),
    ]);
    expect(result!._multiRun?.batchFailure).toBe('Network timeout');
  });

  it('ignores empty-string batchFailure values', () => {
    // Defensive: `'' && 'Network timeout'` style bugs in upstream code
    // shouldn't poison the banner with an empty failure line.
    const result = buildMultiRunResult([
      makeRun(0, { batchAttempted: 5, batchFailure: '' }),
      makeRun(1, { batchAttempted: 5, batchFailure: 'Real failure' }),
    ]);
    expect(result!._multiRun?.batchFailure).toBe('Real failure');
  });

  it('finds batchAttempted even if only later runs carry it', () => {
    // Mirror of the batchFailure walk: if persistence ever ends up with a
    // legacy single-run at index 0 (no batch metadata) followed by a
    // partial-batch run, we must still detect the partial-ness. The
    // pre-fix behavior read `runs[0].metadata.batchAttempted` only and
    // would silently treat this as "complete," reintroducing the
    // silent-partial UX failure mode the artifact-side fix prevented.
    const result = buildMultiRunResult([
      makeRun(0), // No batchAttempted — legacy single run
      makeRun(1, { batchAttempted: 5 }),
    ]);
    expect(result!._multiRun?.partial).toBe(true);
    expect(result!._multiRun?.batchAttempted).toBe(5);
    expect(result!._multiRun?.batchCompleted).toBe(2);
  });

  it('handles batchAttempted: 0 without falsely marking as partial', () => {
    // A run with `batchAttempted: 0` is almost certainly bad metadata,
    // but treating it as partial (because `runs.length > 0`) would be
    // wrong: 1-of-0 partial doesn't make sense. The current heuristic
    // (`allRuns.length < batchAttempted`) returns false here since
    // `1 < 0` is false. Pin the behavior explicitly.
    const result = buildMultiRunResult([makeRun(0, { batchAttempted: 0 })]);
    expect(result!._multiRun?.partial).toBeUndefined();
  });

  it('ignores non-finite batchAttempted values', () => {
    // Defensive against NaN/Infinity from corrupted artifacts; same
    // guard the runtime detectPartial uses.
    const result = buildMultiRunResult([
      makeRun(0, { batchAttempted: NaN }),
      makeRun(1, { batchAttempted: NaN }),
    ]);
    expect(result!._multiRun?.partial).toBeUndefined();
  });
});
