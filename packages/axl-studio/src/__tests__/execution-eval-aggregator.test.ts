import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ExecutionAggregator } from '../server/aggregates/execution-aggregator.js';
import { EvalAggregator } from '../server/aggregates/eval-aggregator.js';
import { ConnectionManager } from '../server/ws/connection-manager.js';
import type { WindowId } from '../server/aggregates/aggregate-snapshots.js';
import type { TraceEvent, ExecutionInfo, EvalHistoryEntry } from '@axlsdk/axl';

// ── Helpers ───────────────────────────────────────────────────────────

type Counter = { count: number; totalCost: number };
const emptyState = (): Counter => ({ count: 0, totalCost: 0 });

const executionReducer = (acc: Counter, exec: ExecutionInfo): Counter => ({
  count: acc.count + 1,
  totalCost: acc.totalCost + exec.totalCost,
});

const evalReducer = (acc: Counter, _entry: EvalHistoryEntry): Counter => ({
  count: acc.count + 1,
  totalCost: acc.totalCost,
});

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

/** Minimal mock of AxlRuntime with EventEmitter + required methods. */
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

// ── ExecutionAggregator ──────────────────────────────────────────────

describe('ExecutionAggregator', () => {
  let connMgr: ConnectionManager;
  const windows: WindowId[] = ['24h', '7d', '30d', 'all'];

  beforeEach(() => {
    connMgr = new ConnectionManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds from execution history on start', async () => {
    const now = Date.now();
    const executions = [
      makeExecution({ executionId: 'e1', startedAt: now - 1000, totalCost: 0.01 }),
      makeExecution({ executionId: 'e2', startedAt: now - 2000, totalCost: 0.02 }),
    ];
    const runtime = createMockRuntime(executions);
    const agg = new ExecutionAggregator({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: executionReducer,
      emptyState,
      windows,
    });

    await agg.start();

    const snapshot = agg.getSnapshot('all');
    expect(snapshot.count).toBe(2);
    expect(snapshot.totalCost).toBeCloseTo(0.03);
    agg.close();
  });

  it('folds execution on workflow_end trace event (direct type)', async () => {
    const now = Date.now();
    const exec = makeExecution({
      executionId: 'e-live',
      startedAt: now,
      totalCost: 0.05,
    });
    const runtime = createMockRuntime([exec]);
    // getExecution returns the live execution
    runtime.getExecution.mockResolvedValue(exec);
    // Start with empty history so rebuild contributes nothing
    runtime.getExecutions.mockResolvedValue([]);

    const agg = new ExecutionAggregator({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: executionReducer,
      emptyState,
      windows,
    });

    await agg.start();
    expect(agg.getSnapshot('all').count).toBe(0);

    // Emit a workflow_end trace event (direct type form)
    const event: TraceEvent = {
      executionId: 'e-live',
      step: 1,
      type: 'workflow_end',
      timestamp: now,
    };
    runtime.emit('trace', event);

    // The fold is async (getExecution is a promise), so flush microtasks
    await vi.advanceTimersByTimeAsync(0);

    expect(agg.getSnapshot('all').count).toBe(1);
    expect(agg.getSnapshot('all').totalCost).toBeCloseTo(0.05);
    agg.close();
  });

  it('detects log-form workflow_end from production runtime', async () => {
    const now = Date.now();
    const exec = makeExecution({
      executionId: 'e-log',
      startedAt: now,
      totalCost: 0.1,
    });
    const runtime = createMockRuntime([]);
    runtime.getExecution.mockResolvedValue(exec);

    const agg = new ExecutionAggregator({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: executionReducer,
      emptyState,
      windows,
    });

    await agg.start();

    // Production runtime emits type: 'log' with data.event: 'workflow_end'
    const event: TraceEvent = {
      executionId: 'e-log',
      step: 1,
      type: 'log',
      timestamp: now,
      data: { event: 'workflow_end', status: 'completed', duration: 100 },
    };
    runtime.emit('trace', event);
    await vi.advanceTimersByTimeAsync(0);

    expect(agg.getSnapshot('all').count).toBe(1);
    expect(agg.getSnapshot('all').totalCost).toBeCloseTo(0.1);
    agg.close();
  });

  it('ignores non-workflow_end events', async () => {
    const runtime = createMockRuntime([]);
    const agg = new ExecutionAggregator({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: executionReducer,
      emptyState,
      windows,
    });

    await agg.start();

    // These should all be ignored by the listener
    runtime.emit('trace', {
      executionId: 'e1',
      step: 1,
      type: 'agent_call',
      timestamp: Date.now(),
    });
    runtime.emit('trace', {
      executionId: 'e1',
      step: 2,
      type: 'tool_call',
      timestamp: Date.now(),
      tool: 'search',
    });
    runtime.emit('trace', {
      executionId: 'e1',
      step: 3,
      type: 'log',
      timestamp: Date.now(),
      data: { event: 'workflow_start', input: {} },
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(agg.getSnapshot('all').count).toBe(0);
    // getExecution should never have been called for these events
    expect(runtime.getExecution).not.toHaveBeenCalled();
    agg.close();
  });

  it('generation counter prevents stale async fold after rebuild', async () => {
    const now = Date.now();
    const exec = makeExecution({
      executionId: 'e-stale',
      startedAt: now,
      totalCost: 0.05,
    });

    // Use a deferred promise to control when getExecution resolves
    let resolveExec: (v: ExecutionInfo) => void;
    const deferredExec = new Promise<ExecutionInfo>((r) => {
      resolveExec = r;
    });

    const runtime = createMockRuntime([]);
    runtime.getExecution.mockReturnValue(deferredExec);

    const agg = new ExecutionAggregator({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: executionReducer,
      emptyState,
      windows,
    });

    await agg.start();

    // Emit a workflow_end — this triggers getExecution but it won't resolve yet
    runtime.emit('trace', {
      executionId: 'e-stale',
      step: 1,
      type: 'workflow_end',
      timestamp: now,
    } as TraceEvent);

    // Before the getExecution resolves, trigger a rebuild (increments generation)
    await agg.rebuild();

    // Now resolve the stale getExecution response
    resolveExec!(exec);
    await vi.advanceTimersByTimeAsync(0);

    // The fold should have been skipped because generation changed
    expect(agg.getSnapshot('all').count).toBe(0);
    agg.close();
  });

  it('handles getExecution returning undefined without crashing', async () => {
    const runtime = createMockRuntime([]);
    runtime.getExecution.mockResolvedValue(undefined);

    const agg = new ExecutionAggregator({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: executionReducer,
      emptyState,
      windows,
    });

    await agg.start();

    runtime.emit('trace', {
      executionId: 'missing',
      step: 1,
      type: 'workflow_end',
      timestamp: Date.now(),
    } as TraceEvent);

    await vi.advanceTimersByTimeAsync(0);

    // Should not crash and should not fold anything
    expect(agg.getSnapshot('all').count).toBe(0);
    agg.close();
  });

  it('does not fold after close', async () => {
    const now = Date.now();
    const exec = makeExecution({
      executionId: 'e-closed',
      startedAt: now,
      totalCost: 0.05,
    });
    const runtime = createMockRuntime([]);
    runtime.getExecution.mockResolvedValue(exec);

    const agg = new ExecutionAggregator({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: executionReducer,
      emptyState,
      windows,
    });

    await agg.start();
    agg.close();

    // Emit after close — listener should have been removed
    runtime.emit('trace', {
      executionId: 'e-closed',
      step: 1,
      type: 'workflow_end',
      timestamp: now,
    } as TraceEvent);

    await vi.advanceTimersByTimeAsync(0);

    expect(agg.getSnapshot('all').count).toBe(0);
  });

  it('caps replay at executionCap', async () => {
    const now = Date.now();
    const executions = Array.from({ length: 10 }, (_, i) =>
      makeExecution({
        executionId: `exec-${i}`,
        startedAt: now - i * 1000,
        totalCost: 0.01,
      }),
    );
    const runtime = createMockRuntime(executions);
    const agg = new ExecutionAggregator({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: executionReducer,
      emptyState,
      windows,
      executionCap: 4,
    });

    await agg.start();

    expect(agg.getSnapshot('all').count).toBe(4);
    expect(agg.getSnapshot('all').totalCost).toBeCloseTo(0.04);
    agg.close();
  });
});

// ── EvalAggregator ───────────────────────────────────────────────────

describe('EvalAggregator', () => {
  let connMgr: ConnectionManager;
  const windows: WindowId[] = ['24h', '7d', '30d', 'all'];

  beforeEach(() => {
    connMgr = new ConnectionManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds from eval history on start', async () => {
    const now = Date.now();
    const history = [
      makeEvalEntry({ id: 'ev1', timestamp: now - 1000 }),
      makeEvalEntry({ id: 'ev2', timestamp: now - 2000 }),
      makeEvalEntry({ id: 'ev3', timestamp: now - 3000 }),
    ];
    const runtime = createMockRuntime([], history);
    const agg = new EvalAggregator({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: evalReducer,
      emptyState,
      windows,
    });

    await agg.start();

    expect(agg.getSnapshot('all').count).toBe(3);
    agg.close();
  });

  it('folds live eval_result events', async () => {
    const runtime = createMockRuntime([], []);
    const agg = new EvalAggregator({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: evalReducer,
      emptyState,
      windows,
    });

    await agg.start();
    expect(agg.getSnapshot('all').count).toBe(0);

    // Emit a live eval_result event
    const entry = makeEvalEntry({ id: 'ev-live', timestamp: Date.now() });
    runtime.emit('eval_result', entry);

    expect(agg.getSnapshot('all').count).toBe(1);
    agg.close();
  });

  it('caps replay at entryCap', async () => {
    const now = Date.now();
    const history = Array.from({ length: 10 }, (_, i) =>
      makeEvalEntry({ id: `ev-${i}`, timestamp: now - i * 1000 }),
    );
    const runtime = createMockRuntime([], history);
    const agg = new EvalAggregator({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: evalReducer,
      emptyState,
      windows,
      entryCap: 3,
    });

    await agg.start();

    expect(agg.getSnapshot('all').count).toBe(3);
    agg.close();
  });

  it('does not receive events after close', async () => {
    const runtime = createMockRuntime([], []);
    const agg = new EvalAggregator({
      runtime: runtime as any,
      connMgr,
      channel: 'test',
      reducer: evalReducer,
      emptyState,
      windows,
    });

    await agg.start();
    agg.close();

    runtime.emit('eval_result', makeEvalEntry({ id: 'ev-after-close' }));
    expect(agg.getSnapshot('all').count).toBe(0);
  });
});
