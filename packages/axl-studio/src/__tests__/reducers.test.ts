import { describe, it, expect } from 'vitest';
import { CostAggregator } from '../server/cost-aggregator.js';
import { ConnectionManager } from '../server/ws/connection-manager.js';
import {
  reduceCost,
  emptyCostData,
  reduceEvalTrends,
  emptyEvalTrendData,
  reduceWorkflowStats,
  emptyWorkflowStatsData,
  getWorkflowPercentiles,
  reduceTraceStats,
  emptyTraceStatsData,
} from '../server/aggregates/reducers.js';
import type { TraceEvent, ExecutionInfo, EvalHistoryEntry } from '@axlsdk/axl';

// ── Helpers ───────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    executionId: 'exec-1',
    step: 1,
    type: 'agent_call',
    timestamp: Date.now(),
    ...overrides,
  };
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

/** Build a data blob matching the real EvalResult shape:
 *  top-level `totalCost`, and `summary.scorers[name] = { mean, min, max, p50, p95 }`. */
function makeEvalData(scores: Record<string, number>, totalCost: number) {
  const scorers: Record<
    string,
    { mean: number; min: number; max: number; p50: number; p95: number }
  > = {};
  for (const [name, score] of Object.entries(scores)) {
    scorers[name] = { mean: score, min: score, max: score, p50: score, p95: score };
  }
  return { totalCost, summary: { scorers } };
}

function makeEvalEntry(overrides: Partial<EvalHistoryEntry> = {}): EvalHistoryEntry {
  return {
    id: 'eval-1',
    eval: 'accuracy',
    timestamp: Date.now(),
    data: makeEvalData({ exact_match: 0.8, f1: 0.9 }, 0.05),
    ...overrides,
  };
}

// ── reduceCost parity with CostAggregator ─────────────────────────────

describe('reduceCost', () => {
  describe('parity with CostAggregator', () => {
    it('produces identical output for a sequence of events', () => {
      const events: TraceEvent[] = [
        makeEvent({
          type: 'workflow_start',
          agent: 'agent-a',
          model: 'gpt-4',
          workflow: 'wf-1',
          cost: 0,
        }),
        makeEvent({
          type: 'agent_call',
          agent: 'agent-a',
          model: 'gpt-4',
          workflow: 'wf-1',
          cost: 0.05,
          tokens: { input: 100, output: 50, reasoning: 10 },
        }),
        makeEvent({
          type: 'agent_call',
          agent: 'agent-b',
          model: 'claude-3-opus',
          workflow: 'wf-1',
          cost: 0.03,
          tokens: { input: 80, output: 40 },
        }),
        makeEvent({
          type: 'workflow_start',
          workflow: 'wf-2',
          cost: 0,
        }),
        makeEvent({
          type: 'agent_call',
          agent: 'agent-a',
          model: 'gpt-4',
          workflow: 'wf-2',
          cost: 0.02,
          tokens: { input: 50, output: 25, reasoning: 5 },
        }),
      ];

      // Old path: CostAggregator
      const connMgr = new ConnectionManager();
      const oldAgg = new CostAggregator(connMgr);
      for (const e of events) oldAgg.onTrace(e);
      const oldData = oldAgg.getData();

      // New path: pure reducer
      let newData = emptyCostData();
      for (const e of events) newData = reduceCost(newData, e);

      expect(newData.totalCost).toBeCloseTo(oldData.totalCost);
      expect(newData.totalTokens).toEqual(oldData.totalTokens);
      expect(newData.byAgent).toEqual(oldData.byAgent);
      expect(newData.byModel).toEqual(oldData.byModel);
      expect(newData.byWorkflow).toEqual(oldData.byWorkflow);
    });

    it('matches on events with no cost or tokens (skip path)', () => {
      const events: TraceEvent[] = [
        makeEvent({ type: 'log' }), // no cost, no tokens → skip
        makeEvent({ type: 'agent_call', cost: 0.01, tokens: { input: 10, output: 5 } }),
      ];

      const connMgr = new ConnectionManager();
      const oldAgg = new CostAggregator(connMgr);
      for (const e of events) oldAgg.onTrace(e);

      let newData = emptyCostData();
      for (const e of events) newData = reduceCost(newData, e);

      expect(newData.totalCost).toBeCloseTo(oldAgg.getData().totalCost);
      expect(newData.totalTokens).toEqual(oldAgg.getData().totalTokens);
    });

    it('matches on cost: 0 with tokens (should process, not skip)', () => {
      const event = makeEvent({
        agent: 'test',
        cost: 0,
        tokens: { input: 10, output: 5 },
      });

      const connMgr = new ConnectionManager();
      const oldAgg = new CostAggregator(connMgr);
      oldAgg.onTrace(event);

      let newData = emptyCostData();
      newData = reduceCost(newData, event);

      expect(newData.totalCost).toBe(0);
      expect(newData.totalTokens.input).toBe(10);
      expect(newData.byAgent['test']).toBeDefined();
      expect(newData).toEqual(oldAgg.getData());
    });

    it('matches on workflow_start execution counting', () => {
      const events: TraceEvent[] = [
        makeEvent({ type: 'workflow_start', workflow: 'wf-1', cost: 0 }),
        makeEvent({
          type: 'agent_call',
          workflow: 'wf-1',
          cost: 0.01,
          tokens: { input: 10, output: 5 },
        }),
        makeEvent({ type: 'workflow_start', workflow: 'wf-1', cost: 0 }),
      ];

      const connMgr = new ConnectionManager();
      const oldAgg = new CostAggregator(connMgr);
      for (const e of events) oldAgg.onTrace(e);

      let newData = emptyCostData();
      for (const e of events) newData = reduceCost(newData, e);

      expect(newData.byWorkflow['wf-1'].executions).toBe(2);
      expect(newData.byWorkflow).toEqual(oldAgg.getData().byWorkflow);
    });
  });

  describe('workflow_start log-form detection', () => {
    it('counts executions from log-form workflow_start (production runtime)', () => {
      const events: TraceEvent[] = [
        // Production runtime emits type: 'log' with data.event: 'workflow_start'
        makeEvent({
          type: 'log',
          workflow: 'wf-1',
          data: { event: 'workflow_start', input: {} },
        }),
        makeEvent({
          type: 'agent_call',
          workflow: 'wf-1',
          cost: 0.01,
          tokens: { input: 10, output: 5 },
        }),
        makeEvent({
          type: 'log',
          workflow: 'wf-1',
          data: { event: 'workflow_start', input: {} },
        }),
      ];

      let data = emptyCostData();
      for (const e of events) data = reduceCost(data, e);

      expect(data.byWorkflow['wf-1'].executions).toBe(2);
      expect(data.byWorkflow['wf-1'].cost).toBeCloseTo(0.01);
    });

    it('counts executions from both log-form and direct workflow_start', () => {
      const events: TraceEvent[] = [
        makeEvent({ type: 'workflow_start', workflow: 'wf-1', cost: 0 }),
        makeEvent({
          type: 'log',
          workflow: 'wf-1',
          data: { event: 'workflow_start', input: {} },
        }),
      ];

      let data = emptyCostData();
      for (const e of events) data = reduceCost(data, e);
      expect(data.byWorkflow['wf-1'].executions).toBe(2);
    });
  });

  describe('pure function properties', () => {
    it('does not mutate the accumulator', () => {
      const acc = emptyCostData();
      const event = makeEvent({ cost: 0.01, agent: 'a', tokens: { input: 10, output: 5 } });
      const result = reduceCost(acc, event);

      expect(acc.totalCost).toBe(0); // original unchanged
      expect(result.totalCost).toBeCloseTo(0.01);
      expect(acc.byAgent).toEqual({});
      expect(result.byAgent).toHaveProperty('a');
    });

    it('returns the same accumulator for no-op events', () => {
      const acc = emptyCostData();
      const event = makeEvent({ type: 'log' }); // no cost, no tokens
      const result = reduceCost(acc, event);
      expect(result).toBe(acc); // same reference — identity return
    });
  });

  describe('finite clamping', () => {
    it('clamps NaN cost to 0', () => {
      const acc = emptyCostData();
      const event = makeEvent({
        cost: NaN,
        agent: 'a',
        model: 'gpt-4',
        tokens: { input: 10, output: 5 },
      });
      const result = reduceCost(acc, event);

      expect(result.totalCost).toBe(0);
      expect(result.byAgent['a'].cost).toBe(0);
      expect(result.byModel['gpt-4'].cost).toBe(0);
    });

    it('clamps Infinity cost to 0', () => {
      const acc = emptyCostData();
      const event = makeEvent({
        cost: Infinity,
        agent: 'a',
        model: 'gpt-4',
        tokens: { input: 10, output: 5 },
      });
      const result = reduceCost(acc, event);

      expect(result.totalCost).toBe(0);
      expect(result.byAgent['a'].cost).toBe(0);
      expect(result.byModel['gpt-4'].cost).toBe(0);
    });
  });
});

// ── reduceEvalTrends ──────────────────────────────────────────────────

describe('reduceEvalTrends', () => {
  it('accumulates runs per eval name', () => {
    let state = emptyEvalTrendData();
    state = reduceEvalTrends(state, makeEvalEntry({ id: 'r1', eval: 'accuracy' }));
    state = reduceEvalTrends(state, makeEvalEntry({ id: 'r2', eval: 'accuracy' }));
    state = reduceEvalTrends(state, makeEvalEntry({ id: 'r3', eval: 'fluency' }));

    expect(state.totalRuns).toBe(3);
    expect(state.byEval['accuracy'].runCount).toBe(2);
    expect(state.byEval['fluency'].runCount).toBe(1);
  });

  it('computes score mean and std correctly', () => {
    let state = emptyEvalTrendData();
    state = reduceEvalTrends(
      state,
      makeEvalEntry({
        id: 'r1',
        data: makeEvalData({ acc: 0.8 }, 0),
      }),
    );
    state = reduceEvalTrends(
      state,
      makeEvalEntry({
        id: 'r2',
        data: makeEvalData({ acc: 0.6 }, 0),
      }),
    );

    expect(state.byEval['accuracy'].scoreMean['acc']).toBeCloseTo(0.7);
    // std of [0.8, 0.6] = sqrt(((0.1)^2 + (0.1)^2)/2) = 0.1
    expect(state.byEval['accuracy'].scoreStd['acc']).toBeCloseTo(0.1);
  });

  it('handles entries with no summary data', () => {
    let state = emptyEvalTrendData();
    state = reduceEvalTrends(state, makeEvalEntry({ data: null }));
    expect(state.totalRuns).toBe(1);
    expect(state.byEval['accuracy'].runs[0].scores).toEqual({});
    expect(state.byEval['accuracy'].runs[0].cost).toBe(0);
  });

  it('tracks total cost across evals', () => {
    let state = emptyEvalTrendData();
    state = reduceEvalTrends(
      state,
      makeEvalEntry({
        eval: 'a',
        data: makeEvalData({}, 0.1),
      }),
    );
    state = reduceEvalTrends(
      state,
      makeEvalEntry({
        eval: 'b',
        data: makeEvalData({}, 0.2),
      }),
    );
    expect(state.totalCost).toBeCloseTo(0.3);
  });

  it('does not mutate the accumulator', () => {
    const acc = emptyEvalTrendData();
    const result = reduceEvalTrends(acc, makeEvalEntry());
    expect(acc.totalRuns).toBe(0);
    expect(result.totalRuns).toBe(1);
  });

  it('latestScores reflects newest run when entries arrive newest-first', () => {
    const now = Date.now();
    let state = emptyEvalTrendData();

    // During rebuild, entries arrive newest-first (most recent first)
    state = reduceEvalTrends(
      state,
      makeEvalEntry({
        id: 'newest',
        eval: 'accuracy',
        timestamp: now,
        data: makeEvalData({ acc: 0.95 }, 0),
      }),
    );
    state = reduceEvalTrends(
      state,
      makeEvalEntry({
        id: 'older',
        eval: 'accuracy',
        timestamp: now - 60_000,
        data: makeEvalData({ acc: 0.7 }, 0),
      }),
    );

    // latestScores should reflect the newest run (timestamp: now), not the
    // last-processed entry (timestamp: now - 60000)
    expect(state.byEval['accuracy'].latestScores).toEqual({ acc: 0.95 });
  });
});

// ── reduceWorkflowStats ───────────────────────────────────────────────

describe('reduceWorkflowStats', () => {
  it('counts total, completed, and failed executions', () => {
    let state = emptyWorkflowStatsData();
    state = reduceWorkflowStats(state, makeExecution({ status: 'completed', workflow: 'wf' }));
    state = reduceWorkflowStats(state, makeExecution({ status: 'failed', workflow: 'wf' }));
    state = reduceWorkflowStats(state, makeExecution({ status: 'completed', workflow: 'wf' }));

    expect(state.totalExecutions).toBe(3);
    expect(state.byWorkflow['wf'].total).toBe(3);
    expect(state.byWorkflow['wf'].completed).toBe(2);
    expect(state.byWorkflow['wf'].failed).toBe(1);
  });

  it('computes failure rate', () => {
    let state = emptyWorkflowStatsData();
    state = reduceWorkflowStats(state, makeExecution({ status: 'completed' }));
    state = reduceWorkflowStats(state, makeExecution({ status: 'failed' }));
    expect(state.failureRate).toBeCloseTo(0.5);
  });

  it('computes failure rate across workflows', () => {
    let state = emptyWorkflowStatsData();
    state = reduceWorkflowStats(state, makeExecution({ status: 'failed', workflow: 'a' }));
    state = reduceWorkflowStats(state, makeExecution({ status: 'completed', workflow: 'b' }));
    state = reduceWorkflowStats(state, makeExecution({ status: 'completed', workflow: 'b' }));
    // 1 failure out of 3 total
    expect(state.failureRate).toBeCloseTo(1 / 3);
  });

  it('tracks durations and computes average', () => {
    let state = emptyWorkflowStatsData();
    state = reduceWorkflowStats(state, makeExecution({ duration: 100, workflow: 'wf' }));
    state = reduceWorkflowStats(state, makeExecution({ duration: 200, workflow: 'wf' }));
    state = reduceWorkflowStats(state, makeExecution({ duration: 300, workflow: 'wf' }));

    expect(state.byWorkflow['wf'].avgDuration).toBeCloseTo(200);
  });

  it('computes p50 and p95 percentiles', () => {
    let state = emptyWorkflowStatsData();
    // Add 20 executions with durations 1..20
    for (let i = 1; i <= 20; i++) {
      state = reduceWorkflowStats(state, makeExecution({ duration: i * 100, workflow: 'wf' }));
    }
    const { durationP50, durationP95 } = getWorkflowPercentiles(state.byWorkflow['wf']);
    // p50 of 1..20 (×100): index 9.5 → (1000+1100)/2 = 1050
    expect(durationP50).toBeCloseTo(1050);
    // p95 of 1..20 (×100): index 19×0.95=18.05 → close to 1905
    expect(durationP95).toBeGreaterThan(1800);
  });

  it('does not mutate the accumulator', () => {
    const acc = emptyWorkflowStatsData();
    const result = reduceWorkflowStats(acc, makeExecution());
    expect(acc.totalExecutions).toBe(0);
    expect(result.totalExecutions).toBe(1);
  });

  it('handles running/waiting statuses without counting as completed or failed', () => {
    let state = emptyWorkflowStatsData();
    state = reduceWorkflowStats(state, makeExecution({ status: 'running', workflow: 'wf' }));
    state = reduceWorkflowStats(state, makeExecution({ status: 'waiting', workflow: 'wf' }));
    expect(state.byWorkflow['wf'].total).toBe(2);
    expect(state.byWorkflow['wf'].completed).toBe(0);
    expect(state.byWorkflow['wf'].failed).toBe(0);
  });

  it('evicts the smallest duration when MAX_DURATIONS (200) exceeded', () => {
    let state = emptyWorkflowStatsData();
    // Insert 200 executions with duration 100..299
    for (let i = 0; i < 200; i++) {
      state = reduceWorkflowStats(state, makeExecution({ duration: 100 + i, workflow: 'wf' }));
    }
    expect(state.byWorkflow['wf'].durations).toHaveLength(200);
    expect(state.byWorkflow['wf'].durations[0]).toBe(100);

    // Insert a value smaller than all existing — it gets inserted at front
    // then immediately evicted by shift(), so the array is unchanged
    state = reduceWorkflowStats(state, makeExecution({ duration: 50, workflow: 'wf' }));
    expect(state.byWorkflow['wf'].durations).toHaveLength(200);
    expect(state.byWorkflow['wf'].durations[0]).toBe(100);

    // Insert a large value — goes to the end, smallest (100) evicted
    state = reduceWorkflowStats(state, makeExecution({ duration: 10000, workflow: 'wf' }));
    expect(state.byWorkflow['wf'].durations).toHaveLength(200);
    expect(state.byWorkflow['wf'].durations[0]).toBe(101);
    expect(state.byWorkflow['wf'].durations[199]).toBe(10000);

    // Insert a mid-range value — goes in sorted position, smallest (101) evicted
    state = reduceWorkflowStats(state, makeExecution({ duration: 200, workflow: 'wf' }));
    expect(state.byWorkflow['wf'].durations).toHaveLength(200);
    expect(state.byWorkflow['wf'].durations[0]).toBe(102);
  });
});

// ── reduceTraceStats ──────────────────────────────────────────────────

describe('reduceTraceStats', () => {
  it('counts events by type', () => {
    let state = emptyTraceStatsData();
    state = reduceTraceStats(state, makeEvent({ type: 'agent_call' }));
    state = reduceTraceStats(state, makeEvent({ type: 'agent_call' }));
    state = reduceTraceStats(state, makeEvent({ type: 'tool_call', tool: 'search' }));
    state = reduceTraceStats(state, makeEvent({ type: 'log' }));

    expect(state.eventTypeCounts['agent_call']).toBe(2);
    expect(state.eventTypeCounts['tool_call']).toBe(1);
    expect(state.eventTypeCounts['log']).toBe(1);
    expect(state.totalEvents).toBe(4);
  });

  it('tracks tool calls, approvals, and denials', () => {
    let state = emptyTraceStatsData();
    state = reduceTraceStats(state, makeEvent({ type: 'tool_call', tool: 'search' }));
    state = reduceTraceStats(state, makeEvent({ type: 'tool_call', tool: 'search' }));
    state = reduceTraceStats(state, makeEvent({ type: 'tool_denied', tool: 'search' }));

    expect(state.byTool['search'].calls).toBe(2);
    expect(state.byTool['search'].denied).toBe(1);
  });

  it('tracks retry reasons by agent', () => {
    let state = emptyTraceStatsData();
    state = reduceTraceStats(
      state,
      makeEvent({
        type: 'agent_call',
        agent: 'agent-a',
        data: { retryReason: 'schema' },
      }),
    );
    state = reduceTraceStats(
      state,
      makeEvent({
        type: 'agent_call',
        agent: 'agent-a',
        data: { retryReason: 'validate' },
      }),
    );
    state = reduceTraceStats(
      state,
      makeEvent({
        type: 'agent_call',
        agent: 'agent-a',
        data: { retryReason: 'guardrail' },
      }),
    );
    state = reduceTraceStats(
      state,
      makeEvent({
        type: 'agent_call',
        agent: 'agent-a',
        // no retryReason — primary call
      }),
    );

    expect(state.retryByAgent['agent-a']).toEqual({ schema: 1, validate: 1, guardrail: 1 });
  });

  it('does not count retry for non-agent_call events', () => {
    let state = emptyTraceStatsData();
    state = reduceTraceStats(
      state,
      makeEvent({
        type: 'tool_call',
        tool: 'search',
        agent: 'agent-a',
        data: { retryReason: 'schema' },
      }),
    );
    expect(state.retryByAgent['agent-a']).toBeUndefined();
  });

  it('does not mutate the accumulator', () => {
    const acc = emptyTraceStatsData();
    const result = reduceTraceStats(acc, makeEvent());
    expect(acc.totalEvents).toBe(0);
    expect(result.totalEvents).toBe(1);
  });

  it('ignores unknown retry reasons', () => {
    let state = emptyTraceStatsData();
    state = reduceTraceStats(
      state,
      makeEvent({
        type: 'agent_call',
        agent: 'agent-a',
        data: { retryReason: 'unknown_reason' },
      }),
    );
    // Should not create an entry since 'unknown_reason' is not in the schema
    expect(state.retryByAgent['agent-a']).toBeUndefined();
  });

  it('counts tool_denied with data.approved=true as approved, not denied', () => {
    let state = emptyTraceStatsData();
    state = reduceTraceStats(
      state,
      makeEvent({
        type: 'tool_denied',
        tool: 'dangerous-tool',
        data: { approved: true },
      }),
    );

    expect(state.byTool['dangerous-tool'].approved).toBe(1);
    expect(state.byTool['dangerous-tool'].denied).toBe(0);
    expect(state.byTool['dangerous-tool'].calls).toBe(0);
  });
});
