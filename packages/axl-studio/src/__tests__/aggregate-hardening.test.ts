/**
 * Hardening tests for the aggregate infrastructure.
 * Designed to break things: boundary conditions, race conditions,
 * concurrent fold+rebuild, malformed data, NaN/Infinity/undefined,
 * cap overflow, broadcastTransform, and regression tests for fixed bugs.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  AggregateSnapshots,
  withinWindow,
  parseWindowParam,
} from '../server/aggregates/aggregate-snapshots.js';
import { TraceAggregator } from '../server/aggregates/trace-aggregator.js';
import { ExecutionAggregator } from '../server/aggregates/execution-aggregator.js';
import { EvalAggregator } from '../server/aggregates/eval-aggregator.js';
import { ConnectionManager } from '../server/ws/connection-manager.js';
import {
  reduceCost,
  emptyCostData,
  reduceEvalTrends,
  emptyEvalTrendData,
  reduceWorkflowStats,
  emptyWorkflowStatsData,
  getWorkflowPercentiles,
  enrichWorkflowStats,
  reduceTraceStats,
  emptyTraceStatsData,
} from '../server/aggregates/reducers.js';
import type { WindowId } from '../server/aggregates/aggregate-snapshots.js';
import type { TraceEvent, ExecutionInfo, EvalHistoryEntry } from '@axlsdk/axl';

// ── Helpers ───────────────────────────────────────────────────────────

function makeEvent(overrides: Record<string, unknown> = {}): TraceEvent {
  return {
    executionId: 'exec-1',
    step: 1,
    type: 'agent_call',
    timestamp: Date.now(),
    ...overrides,
  } as unknown as TraceEvent;
}

function makeExecution(overrides: Partial<ExecutionInfo> = {}): ExecutionInfo {
  return {
    executionId: 'exec-1',
    workflow: 'test-wf',
    status: 'completed',
    steps: [],
    totalCost: 0,
    startedAt: Date.now(),
    duration: 100,
    ...overrides,
  };
}

function makeEvalEntry(overrides: Partial<EvalHistoryEntry> = {}): EvalHistoryEntry {
  return {
    id: 'eval-1',
    eval: 'accuracy',
    timestamp: Date.now(),
    data: {
      summary: {
        scores: { exact_match: 0.8 },
        totalCost: 0.05,
      },
    },
    ...overrides,
  };
}

function createMockRuntime(executions: ExecutionInfo[] = [], evalHistory: EvalHistoryEntry[] = []) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getExecutions: vi.fn().mockResolvedValue(executions),
    getExecution: vi
      .fn()
      .mockImplementation(async (id: string) => executions.find((e) => e.executionId === id)),
    getEvalHistory: vi.fn().mockResolvedValue(evalHistory),
  });
}

// ── parseWindowParam edge cases ──────────────────────────────────────

describe('parseWindowParam hardening', () => {
  it('returns fallback for undefined', () => {
    expect(parseWindowParam(undefined)).toBe('7d');
  });

  it('returns fallback for null', () => {
    expect(parseWindowParam(null)).toBe('7d');
  });

  it('returns fallback for empty string', () => {
    expect(parseWindowParam('')).toBe('7d');
  });

  it('returns fallback for random garbage', () => {
    expect(parseWindowParam('1y')).toBe('7d');
    expect(parseWindowParam('24H')).toBe('7d'); // case-sensitive
    expect(parseWindowParam('7D')).toBe('7d');
    expect(parseWindowParam('ALL')).toBe('7d');
  });

  it('accepts custom fallback', () => {
    expect(parseWindowParam('bogus', 'all')).toBe('all');
    expect(parseWindowParam(undefined, '30d')).toBe('30d');
  });

  it('accepts all valid windows', () => {
    expect(parseWindowParam('24h')).toBe('24h');
    expect(parseWindowParam('7d')).toBe('7d');
    expect(parseWindowParam('30d')).toBe('30d');
    expect(parseWindowParam('all')).toBe('all');
  });
});

// ── withinWindow extreme inputs ──────────────────────────────────────

describe('withinWindow hardening', () => {
  const NOW = 1_700_000_000_000;

  it('handles ts = 0 correctly for bounded windows', () => {
    expect(withinWindow(0, '24h', NOW)).toBe(false);
    expect(withinWindow(0, '7d', NOW)).toBe(false);
    expect(withinWindow(0, '30d', NOW)).toBe(false);
    expect(withinWindow(0, 'all', NOW)).toBe(true);
  });

  it('handles now = 0', () => {
    // ts >= 0 - window_ms should be true for recent ts, false for everything when now=0
    expect(withinWindow(0, '24h', 0)).toBe(true); // 0 >= 0 - 86400000 is true
    expect(withinWindow(-1, '24h', 0)).toBe(true); // -1 >= -86400000 is true
  });

  it('handles NaN timestamp gracefully', () => {
    // NaN >= anything is false
    expect(withinWindow(NaN, '24h', NOW)).toBe(false);
    expect(withinWindow(NaN, 'all', NOW)).toBe(false);
  });

  it('handles NaN now gracefully', () => {
    // anything >= NaN is false
    expect(withinWindow(NOW, '24h', NaN)).toBe(false);
  });
});

// ── AggregateSnapshots broadcastTransform ────────────────────────────

describe('AggregateSnapshots broadcastTransform', () => {
  let connMgr: ConnectionManager;
  const windows: WindowId[] = ['24h', '7d', 'all'];

  beforeEach(() => {
    connMgr = new ConnectionManager();
  });

  it('applies transform to each window in broadcast', () => {
    const broadcastSpy = vi.spyOn(connMgr, 'broadcast');
    type Inner = { count: number; internal: number[] };
    type Outer = { count: number };

    const snaps = new AggregateSnapshots<Inner>(
      windows,
      () => ({ count: 0, internal: [] }),
      connMgr,
      'test',
      (state) => ({ count: state.count }) as Outer,
    );

    snaps.fold(Date.now(), (prev) => ({
      count: prev.count + 1,
      internal: [...prev.internal, 42],
    }));

    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const payload = broadcastSpy.mock.calls[0][1] as {
      snapshots: Record<string, Outer>;
    };
    // Transform should strip 'internal' field
    for (const w of windows) {
      expect(payload.snapshots[w]).toEqual({ count: 1 });
      expect((payload.snapshots[w] as unknown as Inner).internal).toBeUndefined();
    }
  });

  it('does not affect getSnapshot (returns raw state)', () => {
    type Inner = { count: number; internal: number[] };

    const snaps = new AggregateSnapshots<Inner>(
      windows,
      () => ({ count: 0, internal: [] }),
      connMgr,
      'test',
      (state) => ({ count: state.count }),
    );

    snaps.fold(Date.now(), (prev) => ({
      count: prev.count + 1,
      internal: [...prev.internal, 42],
    }));

    // get() should return the raw (untransformed) state
    const raw = snaps.get('all');
    expect(raw.internal).toEqual([42]);
    expect(raw.count).toBe(1);
  });

  it('transform is applied on replace as well', () => {
    const broadcastSpy = vi.spyOn(connMgr, 'broadcast');
    type Inner = { val: number; secret: string };

    const snaps = new AggregateSnapshots<Inner>(
      ['all'] as WindowId[],
      () => ({ val: 0, secret: 'hidden' }),
      connMgr,
      'test',
      (state) => ({ val: state.val }),
    );

    const fresh = new Map<WindowId, Inner>([['all', { val: 42, secret: 'top-secret' }]]);
    snaps.replace(fresh);

    const payload = broadcastSpy.mock.calls[0][1] as {
      snapshots: Record<string, unknown>;
    };
    expect(payload.snapshots['all']).toEqual({ val: 42 });
    expect((payload.snapshots['all'] as Inner).secret).toBeUndefined();
  });
});

// ── Regression: runCount diverges from actual total at cap ───────────

describe('reduceEvalTrends runCount cap regression', () => {
  it('runCount tracks actual total, not capped array length', () => {
    let state = emptyEvalTrendData();

    // Add 60 runs (cap is 50)
    for (let i = 0; i < 60; i++) {
      state = reduceEvalTrends(
        state,
        makeEvalEntry({
          id: `run-${i}`,
          eval: 'accuracy',
          timestamp: Date.now() + i * 1000,
          data: { summary: { scores: { acc: 0.8 }, totalCost: 0.01 } },
        }),
      );
    }

    // runs array should be capped at 50
    expect(state.byEval['accuracy'].runs.length).toBe(50);
    // but runCount should reflect all 60
    expect(state.byEval['accuracy'].runCount).toBe(60);
    // totalRuns should also be 60
    expect(state.totalRuns).toBe(60);
  });

  it('runCount is correct for exactly 50 runs (at cap boundary)', () => {
    let state = emptyEvalTrendData();

    for (let i = 0; i < 50; i++) {
      state = reduceEvalTrends(
        state,
        makeEvalEntry({
          id: `run-${i}`,
          eval: 'accuracy',
          timestamp: Date.now() + i * 1000,
          data: { summary: { scores: { acc: 0.8 }, totalCost: 0.01 } },
        }),
      );
    }

    expect(state.byEval['accuracy'].runs.length).toBe(50);
    expect(state.byEval['accuracy'].runCount).toBe(50);
  });

  it('costTotal reflects all runs, not just capped ones', () => {
    let state = emptyEvalTrendData();

    for (let i = 0; i < 60; i++) {
      state = reduceEvalTrends(
        state,
        makeEvalEntry({
          id: `run-${i}`,
          eval: 'accuracy',
          timestamp: Date.now() + i * 1000,
          data: { summary: { scores: {}, totalCost: 0.1 } },
        }),
      );
    }

    // costTotal should reflect all 60 runs
    expect(state.byEval['accuracy'].costTotal).toBeCloseTo(6.0);
    expect(state.totalCost).toBeCloseTo(6.0);
  });
});

// ── Regression: tool_approval events now counted ─────────────────────

describe('reduceTraceStats tool_approval regression', () => {
  it('tool_approval with data.approved=true increments approved counter', () => {
    let state = emptyTraceStatsData();
    state = reduceTraceStats(
      state,
      makeEvent({
        type: 'tool_approval',
        tool: 'dangerous-tool',
        data: { approved: true },
      }),
    );

    expect(state.byTool['dangerous-tool'].approved).toBe(1);
    expect(state.byTool['dangerous-tool'].denied).toBe(0);
    expect(state.byTool['dangerous-tool'].calls).toBe(0);
  });

  it('tool_approval with data.approved=false increments denied counter', () => {
    let state = emptyTraceStatsData();
    state = reduceTraceStats(
      state,
      makeEvent({
        type: 'tool_approval',
        tool: 'dangerous-tool',
        data: { approved: false },
      }),
    );

    expect(state.byTool['dangerous-tool'].denied).toBe(1);
    expect(state.byTool['dangerous-tool'].approved).toBe(0);
  });

  it('tool_approval with no data increments neither approved nor denied', () => {
    let state = emptyTraceStatsData();
    state = reduceTraceStats(
      state,
      makeEvent({
        type: 'tool_approval',
        tool: 'dangerous-tool',
        // no data — eventData?.approved is undefined, which is neither true nor false
      }),
    );

    // With no data, approved is undefined (not true, not false).
    // isDenied requires eventData?.approved === false (strict), so undefined doesn't match.
    // isApproved requires eventData?.approved === true, so undefined doesn't match.
    expect(state.byTool['dangerous-tool'].approved).toBe(0);
    expect(state.byTool['dangerous-tool'].denied).toBe(0);
  });

  it('mixed tool events accumulate correctly', () => {
    let state = emptyTraceStatsData();
    const tool = 'search';

    // 3 calls
    for (let i = 0; i < 3; i++) {
      state = reduceTraceStats(state, makeEvent({ type: 'tool_call', tool }));
    }
    // 2 approvals
    state = reduceTraceStats(
      state,
      makeEvent({ type: 'tool_approval', tool, data: { approved: true } }),
    );
    state = reduceTraceStats(
      state,
      makeEvent({ type: 'tool_approval', tool, data: { approved: true } }),
    );
    // 1 denial via tool_approval
    state = reduceTraceStats(
      state,
      makeEvent({ type: 'tool_approval', tool, data: { approved: false } }),
    );
    // 1 denial via tool_denied
    state = reduceTraceStats(state, makeEvent({ type: 'tool_denied', tool }));
    // 1 approval via tool_denied (legacy approved=true on tool_denied)
    state = reduceTraceStats(
      state,
      makeEvent({ type: 'tool_denied', tool, data: { approved: true } }),
    );

    expect(state.byTool[tool].calls).toBe(3);
    expect(state.byTool[tool].approved).toBe(3); // 2 from tool_approval + 1 from tool_denied
    expect(state.byTool[tool].denied).toBe(2); // 1 from tool_approval + 1 from tool_denied
  });
});

// ── Regression: WS broadcast for workflow-stats uses enriched format ─

describe('enrichWorkflowStats', () => {
  it('strips durations and durationSum, adds percentiles', () => {
    let state = emptyWorkflowStatsData();
    for (let i = 1; i <= 10; i++) {
      state = reduceWorkflowStats(state, makeExecution({ workflow: 'wf', duration: i * 100 }));
    }

    const enriched = enrichWorkflowStats(state);

    // Should have percentiles
    expect(enriched.byWorkflow['wf'].durationP50).toBeGreaterThan(0);
    expect(enriched.byWorkflow['wf'].durationP95).toBeGreaterThan(0);
    // Should not have internal fields
    expect(
      (enriched.byWorkflow['wf'] as unknown as Record<string, unknown>).durations,
    ).toBeUndefined();
    expect(
      (enriched.byWorkflow['wf'] as unknown as Record<string, unknown>).durationSum,
    ).toBeUndefined();
    // Top-level fields preserved
    expect(enriched.totalExecutions).toBe(10);
    expect(enriched.failureRate).toBe(0);
  });

  it('handles empty state', () => {
    const enriched = enrichWorkflowStats(emptyWorkflowStatsData());
    expect(enriched.byWorkflow).toEqual({});
    expect(enriched.totalExecutions).toBe(0);
    expect(enriched.failureRate).toBe(0);
  });
});

// ── reduceCost edge cases ────────────────────────────────────────────

describe('reduceCost hardening', () => {
  it('handles negative cost gracefully', () => {
    const event = makeEvent({ cost: -0.01, agent: 'a', tokens: { input: 10, output: 5 } });
    const result = reduceCost(emptyCostData(), event);
    // Negative cost is finite, so it's accepted (not clamped)
    // This is consistent with the old CostAggregator behavior
    expect(result.totalCost).toBe(-0.01);
  });

  it('handles undefined agent/model/workflow without crashing', () => {
    const event = makeEvent({ cost: 0.01, tokens: { input: 10, output: 5 } });
    const result = reduceCost(emptyCostData(), event);
    expect(result.totalCost).toBe(0.01);
    expect(Object.keys(result.byAgent)).toHaveLength(0);
    expect(Object.keys(result.byModel)).toHaveLength(0);
  });

  it('handles event with cost but no tokens', () => {
    const event = makeEvent({ cost: 0.01, agent: 'a' });
    const result = reduceCost(emptyCostData(), event);
    expect(result.totalCost).toBe(0.01);
    expect(result.byAgent['a'].cost).toBe(0.01);
  });

  it('handles event with tokens but cost=undefined (only tokens present)', () => {
    const event = makeEvent({ tokens: { input: 10, output: 5 } });
    // cost == null && !event.tokens → skip. But tokens is present so not skipped.
    const result = reduceCost(emptyCostData(), event);
    expect(result.totalCost).toBe(0); // finite(undefined) = 0
    expect(result.totalTokens.input).toBe(10);
  });

  it('embedder cost with missing usage data does not crash', () => {
    const event = makeEvent({
      type: 'log',
      cost: 0.001,
      data: { event: 'memory_remember' }, // no usage field
    });
    const result = reduceCost(emptyCostData(), event);
    expect(result.byEmbedder['unknown'].cost).toBe(0.001);
    expect(result.byEmbedder['unknown'].tokens).toBe(0);
  });

  it('embedder cost with NaN tokens clamps to 0', () => {
    const event = makeEvent({
      type: 'log',
      cost: 0.001,
      data: { event: 'memory_recall', usage: { model: 'ada', tokens: NaN } },
    });
    const result = reduceCost(emptyCostData(), event);
    expect(result.byEmbedder['ada'].tokens).toBe(0);
    expect(result.byEmbedder['ada'].cost).toBe(0.001);
  });

  it('workflow_start without workflow name is a no-op', () => {
    const acc = emptyCostData();
    const event = makeEvent({ type: 'workflow_start' }); // no workflow field
    const result = reduceCost(acc, event);
    // isWorkflowStart is true, but !event.workflow, so falls through.
    // Then cost==null && !tokens → returns acc (same reference)
    expect(result).toBe(acc); // identity return
    expect(Object.keys(result.byWorkflow)).toHaveLength(0);
  });

  it('accumulates across 1000 events without precision loss', () => {
    let state = emptyCostData();
    for (let i = 0; i < 1000; i++) {
      state = reduceCost(
        state,
        makeEvent({
          type: 'agent_call',
          agent: 'agent-a',
          model: 'gpt-4',
          cost: 0.001,
          tokens: { input: 1, output: 1 },
        }),
      );
    }
    expect(state.totalCost).toBeCloseTo(1.0, 5);
    expect(state.totalTokens.input).toBe(1000);
    expect(state.byAgent['agent-a'].calls).toBe(1000);
  });
});

// ── reduceEvalTrends edge cases ──────────────────────────────────────

describe('reduceEvalTrends hardening', () => {
  it('handles entry with completely empty data', () => {
    let state = emptyEvalTrendData();
    state = reduceEvalTrends(state, makeEvalEntry({ data: {} }));
    expect(state.totalRuns).toBe(1);
    expect(state.byEval['accuracy'].runs[0].scores).toEqual({});
    expect(state.byEval['accuracy'].runs[0].cost).toBe(0);
  });

  it('handles entry with data = "string" (wrong type)', () => {
    let state = emptyEvalTrendData();
    state = reduceEvalTrends(state, makeEvalEntry({ data: 'not-an-object' }));
    expect(state.totalRuns).toBe(1);
    expect(state.byEval['accuracy'].runs[0].scores).toEqual({});
  });

  it('handles entry with data = number (wrong type)', () => {
    let state = emptyEvalTrendData();
    state = reduceEvalTrends(state, makeEvalEntry({ data: 42 }));
    expect(state.totalRuns).toBe(1);
  });

  it('latestScores reflects newest run when entries arrive chronologically (live path)', () => {
    const now = Date.now();
    let state = emptyEvalTrendData();

    // Live path: entries arrive in chronological order (oldest first)
    state = reduceEvalTrends(
      state,
      makeEvalEntry({
        id: 'older',
        eval: 'accuracy',
        timestamp: now - 60_000,
        data: { summary: { scores: { acc: 0.7 }, totalCost: 0 } },
      }),
    );
    state = reduceEvalTrends(
      state,
      makeEvalEntry({
        id: 'newest',
        eval: 'accuracy',
        timestamp: now,
        data: { summary: { scores: { acc: 0.95 }, totalCost: 0 } },
      }),
    );

    expect(state.byEval['accuracy'].latestScores).toEqual({ acc: 0.95 });
  });

  it('score std is 0 for a single run', () => {
    let state = emptyEvalTrendData();
    state = reduceEvalTrends(
      state,
      makeEvalEntry({
        data: { summary: { scores: { acc: 0.8 }, totalCost: 0 } },
      }),
    );
    expect(state.byEval['accuracy'].scoreStd['acc']).toBe(0);
  });

  it('handles NaN scores by including them in stats', () => {
    let state = emptyEvalTrendData();
    state = reduceEvalTrends(
      state,
      makeEvalEntry({
        data: { summary: { scores: { acc: NaN }, totalCost: 0 } },
      }),
    );
    // NaN is not null, so it passes the filter
    expect(state.byEval['accuracy'].scoreMean['acc']).toBeNaN();
  });

  it('multiple evals with different names are independent', () => {
    let state = emptyEvalTrendData();
    state = reduceEvalTrends(state, makeEvalEntry({ eval: 'accuracy', id: 'a1' }));
    state = reduceEvalTrends(state, makeEvalEntry({ eval: 'accuracy', id: 'a2' }));
    state = reduceEvalTrends(state, makeEvalEntry({ eval: 'fluency', id: 'f1' }));

    expect(state.byEval['accuracy'].runCount).toBe(2);
    expect(state.byEval['fluency'].runCount).toBe(1);
    expect(state.totalRuns).toBe(3);
  });
});

// ── reduceWorkflowStats edge cases ───────────────────────────────────

describe('reduceWorkflowStats hardening', () => {
  it('handles execution with duration=0', () => {
    let state = emptyWorkflowStatsData();
    state = reduceWorkflowStats(state, makeExecution({ duration: 0 }));
    expect(state.byWorkflow['test-wf'].avgDuration).toBe(0);
    const { durationP50 } = getWorkflowPercentiles(state.byWorkflow['test-wf']);
    expect(durationP50).toBe(0);
  });

  it('handles execution with NaN duration (clamped to 0 by finite)', () => {
    let state = emptyWorkflowStatsData();
    state = reduceWorkflowStats(state, makeExecution({ duration: NaN }));
    expect(state.byWorkflow['test-wf'].avgDuration).toBe(0);
  });

  it('handles execution with Infinity duration (clamped to 0 by finite)', () => {
    let state = emptyWorkflowStatsData();
    state = reduceWorkflowStats(state, makeExecution({ duration: Infinity }));
    expect(state.byWorkflow['test-wf'].avgDuration).toBe(0);
  });

  it('handles execution with negative duration', () => {
    let state = emptyWorkflowStatsData();
    state = reduceWorkflowStats(state, makeExecution({ duration: -100 }));
    // -100 is finite, so it's accepted. Not ideal but matches behavior.
    expect(state.byWorkflow['test-wf'].avgDuration).toBe(-100);
  });

  it('getWorkflowPercentiles returns 0 for empty durations', () => {
    const { durationP50, durationP95 } = getWorkflowPercentiles({
      total: 0,
      completed: 0,
      failed: 0,
      durations: [],
      durationSum: 0,
      avgDuration: 0,
    });
    expect(durationP50).toBe(0);
    expect(durationP95).toBe(0);
  });

  it('getWorkflowPercentiles returns exact value for single entry', () => {
    const { durationP50, durationP95 } = getWorkflowPercentiles({
      total: 1,
      completed: 1,
      failed: 0,
      durations: [500],
      durationSum: 500,
      avgDuration: 500,
    });
    expect(durationP50).toBe(500);
    expect(durationP95).toBe(500);
  });

  it('failure rate is correct across many workflows', () => {
    let state = emptyWorkflowStatsData();
    // 10 successful, 2 failed across 3 workflows
    for (let i = 0; i < 10; i++) {
      state = reduceWorkflowStats(
        state,
        makeExecution({ workflow: `wf-${i % 3}`, status: 'completed' }),
      );
    }
    state = reduceWorkflowStats(state, makeExecution({ workflow: 'wf-0', status: 'failed' }));
    state = reduceWorkflowStats(state, makeExecution({ workflow: 'wf-1', status: 'failed' }));

    expect(state.totalExecutions).toBe(12);
    expect(state.failureRate).toBeCloseTo(2 / 12);
  });
});

// ── ExecutionAggregator: rapid-fire workflow_end events ──────────────

describe('ExecutionAggregator rapid-fire events', () => {
  let connMgr: ConnectionManager;
  const windows: WindowId[] = ['all'];

  beforeEach(() => {
    connMgr = new ConnectionManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles multiple concurrent workflow_end events without lost updates', async () => {
    const now = Date.now();
    const executions = Array.from({ length: 5 }, (_, i) =>
      makeExecution({
        executionId: `exec-${i}`,
        startedAt: now,
        totalCost: 0.01 * (i + 1),
      }),
    );

    const runtime = createMockRuntime([]);
    runtime.getExecution.mockImplementation(async (id: string) =>
      executions.find((e) => e.executionId === id),
    );

    type Counter = { count: number; totalCost: number };
    const agg = new ExecutionAggregator<Counter>({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: (acc, exec) => ({
        count: acc.count + 1,
        totalCost: acc.totalCost + exec.totalCost,
      }),
      emptyState: () => ({ count: 0, totalCost: 0 }),
      windows,
    });

    await agg.start();

    // Fire 5 workflow_end events rapidly
    for (let i = 0; i < 5; i++) {
      runtime.emit('trace', {
        executionId: `exec-${i}`,
        step: 1,
        type: 'workflow_end',
        timestamp: now,
      } as TraceEvent);
    }

    // Flush all microtasks
    await vi.advanceTimersByTimeAsync(0);

    // All 5 should have been folded
    const snapshot = agg.getSnapshot('all');
    expect(snapshot.count).toBe(5);
    expect(snapshot.totalCost).toBeCloseTo(0.01 + 0.02 + 0.03 + 0.04 + 0.05);
    agg.close();
  });

  it('handles getExecution rejection without crashing other pending folds', async () => {
    const now = Date.now();
    const goodExec = makeExecution({
      executionId: 'good',
      startedAt: now,
      totalCost: 0.05,
    });

    const runtime = createMockRuntime([]);
    runtime.getExecution.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('store error');
      return goodExec;
    });

    type Counter = { count: number };
    const agg = new ExecutionAggregator<Counter>({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: (acc) => ({ count: acc.count + 1 }),
      emptyState: () => ({ count: 0 }),
      windows,
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await agg.start();

    // Emit: good, bad, good — the bad one should not prevent the others
    runtime.emit('trace', {
      executionId: 'good',
      step: 1,
      type: 'workflow_end',
      timestamp: now,
    } as TraceEvent);
    runtime.emit('trace', {
      executionId: 'bad',
      step: 1,
      type: 'workflow_end',
      timestamp: now,
    } as TraceEvent);
    runtime.emit('trace', {
      executionId: 'good',
      step: 1,
      type: 'workflow_end',
      timestamp: now,
    } as TraceEvent);

    await vi.advanceTimersByTimeAsync(0);

    expect(agg.getSnapshot('all').count).toBe(2); // both good ones
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
    agg.close();
  });
});

// ── TraceAggregator: reducer that returns identity on no-op ──────────

describe('TraceAggregator with identity-returning reducer', () => {
  let connMgr: ConnectionManager;
  const windows: WindowId[] = ['all'];

  beforeEach(() => {
    connMgr = new ConnectionManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('still broadcasts even when reducer returns identity', async () => {
    const runtime = createMockRuntime([]);
    const broadcastSpy = vi.spyOn(connMgr, 'broadcast');

    const agg = new TraceAggregator({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: (acc) => acc, // identity — returns same reference
      emptyState: () => ({ count: 0 }),
      windows,
    });

    await agg.start();
    broadcastSpy.mockClear();

    // The fold still happens even with identity reducer, because the fold
    // function checks withinWindow, not reducer output identity
    runtime.emit('trace', makeEvent({ timestamp: Date.now() }));

    // AggregateSnapshots.fold calls the update function and broadcasts
    // It does NOT check if the state reference changed
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    agg.close();
  });
});

// ── EvalAggregator: verify window filtering ──────────────────────────

describe('EvalAggregator window filtering', () => {
  let connMgr: ConnectionManager;
  const windows: WindowId[] = ['24h', '7d', 'all'];

  beforeEach(() => {
    connMgr = new ConnectionManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('old eval entries only appear in wider windows', async () => {
    const now = Date.now();
    const history = [
      makeEvalEntry({ id: 'recent', timestamp: now - 1000 }),
      makeEvalEntry({ id: '3-days-ago', timestamp: now - 3 * 24 * 60 * 60 * 1000 }),
      makeEvalEntry({ id: '10-days-ago', timestamp: now - 10 * 24 * 60 * 60 * 1000 }),
    ];

    type Counter = { count: number };
    const runtime = createMockRuntime([], history);
    const agg = new EvalAggregator<Counter>({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: (acc) => ({ count: acc.count + 1 }),
      emptyState: () => ({ count: 0 }),
      windows,
    });

    await agg.start();

    expect(agg.getSnapshot('24h').count).toBe(1); // only recent
    expect(agg.getSnapshot('7d').count).toBe(2); // recent + 3-days-ago
    expect(agg.getSnapshot('all').count).toBe(3); // all
    agg.close();
  });
});

// ── Reducer purity: verify no shared mutable state ───────────────────

describe('reducer purity across independent reduce chains', () => {
  it('two independent reduce chains do not interfere', () => {
    const events: TraceEvent[] = [
      makeEvent({ type: 'agent_call', agent: 'a', cost: 0.01, tokens: { input: 10, output: 5 } }),
      makeEvent({ type: 'agent_call', agent: 'b', cost: 0.02, tokens: { input: 20, output: 10 } }),
    ];

    // Chain 1: both events
    let chain1 = emptyCostData();
    for (const e of events) chain1 = reduceCost(chain1, e);

    // Chain 2: only second event
    let chain2 = emptyCostData();
    chain2 = reduceCost(chain2, events[1]);

    // They should be independent
    expect(chain1.totalCost).toBeCloseTo(0.03);
    expect(chain2.totalCost).toBeCloseTo(0.02);
    expect(chain1.byAgent['a']).toBeDefined();
    expect(chain2.byAgent['a']).toBeUndefined();
  });
});
