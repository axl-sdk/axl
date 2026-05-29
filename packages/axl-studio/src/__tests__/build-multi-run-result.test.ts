import { describe, it, expect } from 'vitest';
import {
  buildMultiRunResult,
  getResultDroppedAnnotationKeys,
  type EvalResultData,
} from '../client/panels/eval-runner/types.js';

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

  it('carries droppedAnnotationKeys onto the aggregate (read via getResultDroppedAnnotationKeys)', () => {
    // Dropped keys are dataset-level — identical across runs — so the aggregate
    // (which spreads `...first`) must expose them for the panel banner to show
    // in the default multi-run aggregate view, not just per-run.
    const result = buildMultiRunResult([
      makeRun(0, { droppedAnnotationKeys: ['expectedTone', 'persona.role'] }),
      makeRun(1, { droppedAnnotationKeys: ['expectedTone', 'persona.role'] }),
    ]);
    expect(getResultDroppedAnnotationKeys(result!)).toEqual(['expectedTone', 'persona.role']);
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

  it('sums scored/failed across runs in the aggregate', () => {
    const withCounts = (id: string, scored: number, failed: number): EvalResultData => ({
      id,
      dataset: 'ds',
      timestamp: '2026-04-30T00:00:00.000Z',
      duration: 1000,
      totalCost: 0.01,
      items: [],
      summary: {
        count: 1,
        failures: 0,
        scorers: { acc: { mean: 0.8, min: 0.8, max: 0.8, p50: 0.8, p95: 0.8, scored, failed } },
      },
      metadata: { runGroupId: 'g1' },
    });
    const result = buildMultiRunResult([withCounts('r0', 8, 2), withCounts('r1', 9, 1)]);
    expect(result!._multiRun?.aggregate.scorers.acc.scored).toBe(17);
    expect(result!._multiRun?.aggregate.scorers.acc.failed).toBe(3);
  });

  it('treats missing scored/failed as 0 (pre-0.17.10 runs)', () => {
    const result = buildMultiRunResult([makeRun(0), makeRun(1)]);
    expect(result!._multiRun?.aggregate.scorers.acc.scored).toBe(0);
    expect(result!._multiRun?.aggregate.scorers.acc.failed).toBe(0);
  });

  it('excludes a 100%-failed run from the mean but counts it in failed', () => {
    // Two runs: the first scored 10 items at mean 0.9; the second scored ZERO
    // items (all 10 failed) and reports `computeStats([]).mean === 0`. The
    // mean-of-means must be 0.9 (the contributing run only), NOT 0.45 (which
    // the old all-runs average produced). The summed `failed`/`scored` still
    // describe the whole group.
    const withCounts = (
      id: string,
      mean: number,
      scored: number,
      failed: number,
    ): EvalResultData => ({
      id,
      dataset: 'ds',
      timestamp: '2026-04-30T00:00:00.000Z',
      duration: 1000,
      totalCost: 0.01,
      items: [],
      summary: {
        count: 1,
        failures: 0,
        scorers: {
          acc: { mean, min: mean, max: mean, p50: mean, p95: mean, scored, failed },
        },
      },
      metadata: { runGroupId: 'g1' },
    });
    const result = buildMultiRunResult([
      withCounts('r0', 0.9, 10, 0),
      withCounts('r1', 0, 0, 10), // 100% failed — empty-sample mean of 0
    ]);
    const acc = result!._multiRun!.aggregate.scorers.acc;
    expect(acc.mean).toBe(0.9); // contributing run only
    expect(acc.std).toBe(0); // single contributing run ⇒ no spread
    expect(acc.min).toBe(0.9);
    expect(acc.max).toBe(0.9);
    // Summed over ALL runs — the whole-group thinning is still reported.
    expect(acc.scored).toBe(10);
    expect(acc.failed).toBe(10);
  });

  it('falls back to all-runs mean when every run scored zero (no divide-by-zero)', () => {
    // Degenerate case: every run scored nothing. The contributing subset is
    // empty, so we fall back to the all-runs means (each 0) rather than
    // dividing by zero. Mean stays 0, the thinning is still summed.
    const allFailed = (id: string): EvalResultData => ({
      id,
      dataset: 'ds',
      timestamp: '2026-04-30T00:00:00.000Z',
      duration: 1000,
      totalCost: 0.01,
      items: [],
      summary: {
        count: 1,
        failures: 0,
        scorers: { acc: { mean: 0, min: 0, max: 0, p50: 0, p95: 0, scored: 0, failed: 5 } },
      },
      metadata: { runGroupId: 'g1' },
    });
    const result = buildMultiRunResult([allFailed('r0'), allFailed('r1')]);
    const acc = result!._multiRun!.aggregate.scorers.acc;
    expect(acc.mean).toBe(0);
    expect(Number.isNaN(acc.mean)).toBe(false);
    expect(acc.scored).toBe(0);
    expect(acc.failed).toBe(10);
  });

  it('keeps a zero-sample run in the mean when scored is absent (pre-0.17.10)', () => {
    // Without `scored` we can't distinguish a true 0.0 mean from an
    // empty-sample 0 — keep the old behavior (include the run) so legacy
    // artifacts render unchanged.
    const result = buildMultiRunResult([
      makeRun(0, {}, { acc: 0.8 }),
      makeRun(1, {}, { acc: 0 }), // no scored/failed fields
    ]);
    const acc = result!._multiRun!.aggregate.scorers.acc;
    expect(acc.mean).toBe(0.4); // (0.8 + 0) / 2 — both runs counted
  });
});
