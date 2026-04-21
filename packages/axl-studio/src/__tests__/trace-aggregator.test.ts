import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { TraceAggregator } from '../server/aggregates/trace-aggregator.js';
import { ConnectionManager } from '../server/ws/connection-manager.js';
import type { WindowId } from '../server/aggregates/aggregate-snapshots.js';
import type { AxlEvent, ExecutionInfo } from '@axlsdk/axl';

// ── Helpers ───────────────────────────────────────────────────────────

type Counter = { count: number; totalCost: number };
const emptyState = (): Counter => ({ count: 0, totalCost: 0 });
const reducer = (acc: Counter, event: AxlEvent): Counter => ({
  count: acc.count + 1,
  totalCost: acc.totalCost + (event.cost ?? 0),
});

function makeEvent(overrides: Partial<AxlEvent> = {}): AxlEvent {
  return {
    executionId: 'exec-1',
    step: 1,
    type: 'agent_call_end',
    timestamp: Date.now(),
    ...overrides,
  } as AxlEvent;
}

function makeExecution(events: AxlEvent[], overrides: Partial<ExecutionInfo> = {}): ExecutionInfo {
  return {
    executionId: overrides.executionId ?? 'exec-1',
    workflow: 'test-wf',
    status: 'completed',
    events,
    totalCost: events.reduce((sum, s) => sum + (s.cost ?? 0), 0),
    startedAt: events[0]?.timestamp ?? Date.now(),
    duration: 100,
    ...overrides,
  };
}

/** Minimal mock of AxlRuntime with EventEmitter + getExecutions */
function createMockRuntime(executions: ExecutionInfo[] = []) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getExecutions: vi.fn().mockResolvedValue(executions),
    getExecution: vi
      .fn()
      .mockImplementation(async (id: string) => executions.find((e) => e.executionId === id)),
    getEvalHistory: vi.fn().mockResolvedValue([]),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('TraceAggregator', () => {
  let connMgr: ConnectionManager;
  const windows: WindowId[] = ['24h', '7d', '30d', 'all'];

  beforeEach(() => {
    connMgr = new ConnectionManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start and rebuild', () => {
    it('rebuilds from execution history on start', async () => {
      const now = Date.now();
      const events = [
        makeEvent({ timestamp: now - 1000, cost: 0.01 }),
        makeEvent({ timestamp: now - 2000, cost: 0.02 }),
      ];
      const runtime = createMockRuntime([makeExecution(events)]);
      const agg = new TraceAggregator({
        runtime: runtime as any,
        connMgr,
        channel: 'test',
        reducer,
        emptyState,
        windows,
      });

      await agg.start();

      const snapshot = agg.getSnapshot('all');
      expect(snapshot.count).toBe(2);
      expect(snapshot.totalCost).toBeCloseTo(0.03);
      agg.close();
    });

    it('separates events by window based on timestamp', async () => {
      const now = Date.now();
      const events = [
        makeEvent({ timestamp: now - 1000, cost: 0.01 }), // in all windows
        makeEvent({ timestamp: now - 2 * 24 * 60 * 60 * 1000, cost: 0.02 }), // not in 24h
        makeEvent({ timestamp: now - 10 * 24 * 60 * 60 * 1000, cost: 0.04 }), // not in 24h or 7d
      ];
      const runtime = createMockRuntime([makeExecution(events)]);
      const agg = new TraceAggregator({
        runtime: runtime as any,
        connMgr,
        channel: 'test',
        reducer,
        emptyState,
        windows,
      });

      await agg.start();

      expect(agg.getSnapshot('24h').count).toBe(1);
      expect(agg.getSnapshot('7d').count).toBe(2);
      expect(agg.getSnapshot('30d').count).toBe(3);
      expect(agg.getSnapshot('all').count).toBe(3);
      agg.close();
    });

    it('replays events from multiple executions', async () => {
      const now = Date.now();
      const exec1 = makeExecution([makeEvent({ timestamp: now - 1000, cost: 0.01 })], {
        executionId: 'exec-1',
      });
      const exec2 = makeExecution([makeEvent({ timestamp: now - 2000, cost: 0.02 })], {
        executionId: 'exec-2',
      });
      const runtime = createMockRuntime([exec1, exec2]);
      const agg = new TraceAggregator({
        runtime: runtime as any,
        connMgr,
        channel: 'test',
        reducer,
        emptyState,
        windows,
      });

      await agg.start();
      expect(agg.getSnapshot('all').count).toBe(2);
      agg.close();
    });

    it('handles empty execution history gracefully', async () => {
      const runtime = createMockRuntime([]);
      const agg = new TraceAggregator({
        runtime: runtime as any,
        connMgr,
        channel: 'test',
        reducer,
        emptyState,
        windows,
      });

      await agg.start();
      expect(agg.getSnapshot('all').count).toBe(0);
      agg.close();
    });
  });

  describe('live updates', () => {
    it('folds live trace events into snapshots', async () => {
      const runtime = createMockRuntime([]);
      const agg = new TraceAggregator({
        runtime: runtime as any,
        connMgr,
        channel: 'test',
        reducer,
        emptyState,
        windows,
      });

      await agg.start();
      expect(agg.getSnapshot('all').count).toBe(0);

      // Emit a live trace event
      const liveEvent = makeEvent({ timestamp: Date.now(), cost: 0.05 });
      runtime.emit('trace', liveEvent);

      expect(agg.getSnapshot('all').count).toBe(1);
      expect(agg.getSnapshot('all').totalCost).toBeCloseTo(0.05);
      agg.close();
    });

    it('does not receive events after close', async () => {
      const runtime = createMockRuntime([]);
      const agg = new TraceAggregator({
        runtime: runtime as any,
        connMgr,
        channel: 'test',
        reducer,
        emptyState,
        windows,
      });

      await agg.start();
      agg.close();

      runtime.emit('trace', makeEvent({ cost: 0.05 }));
      expect(agg.getSnapshot('all').count).toBe(0);
    });
  });

  describe('execution cap', () => {
    it('caps replay at executionCap (default 2000)', async () => {
      const now = Date.now();
      // Create 5 executions, each with 1 event
      const executions = Array.from({ length: 5 }, (_, i) =>
        makeExecution(
          [makeEvent({ timestamp: now - i * 1000, cost: 0.01, executionId: `exec-${i}` })],
          { executionId: `exec-${i}` },
        ),
      );
      const runtime = createMockRuntime(executions);
      const agg = new TraceAggregator({
        runtime: runtime as any,
        connMgr,
        channel: 'test',
        reducer,
        emptyState,
        windows,
        executionCap: 3, // only replay first 3
      });

      await agg.start();
      // Only first 3 executions should be replayed
      expect(agg.getSnapshot('all').count).toBe(3);
      agg.close();
    });

    it('live events are not affected by cap', async () => {
      const runtime = createMockRuntime([]);
      const agg = new TraceAggregator({
        runtime: runtime as any,
        connMgr,
        channel: 'test',
        reducer,
        emptyState,
        windows,
        executionCap: 0, // cap at 0 — no replay
      });

      await agg.start();
      expect(agg.getSnapshot('all').count).toBe(0);

      // Live events should still work
      runtime.emit('trace', makeEvent({ cost: 0.01 }));
      expect(agg.getSnapshot('all').count).toBe(1);
      agg.close();
    });
  });

  describe('periodic rebuild', () => {
    it('schedules periodic rebuilds', async () => {
      const now = Date.now();
      const events = [makeEvent({ timestamp: now - 1000, cost: 0.01 })];
      const runtime = createMockRuntime([makeExecution(events)]);
      const agg = new TraceAggregator({
        runtime: runtime as any,
        connMgr,
        channel: 'test',
        reducer,
        emptyState,
        windows,
      });

      await agg.start();
      expect(runtime.getExecutions).toHaveBeenCalledTimes(1);

      // Add a new execution to the mock
      const newExec = makeExecution([makeEvent({ timestamp: now, cost: 0.05 })], {
        executionId: 'exec-new',
      });
      runtime.getExecutions.mockResolvedValue([makeExecution(events), newExec]);

      // Advance past the rebuild interval
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(runtime.getExecutions).toHaveBeenCalledTimes(2);
      // After rebuild, snapshot should reflect both executions
      expect(agg.getSnapshot('all').count).toBe(2);
      agg.close();
    });

    it('handles rebuild errors without crashing', async () => {
      const runtime = createMockRuntime([]);
      const agg = new TraceAggregator({
        runtime: runtime as any,
        connMgr,
        channel: 'test',
        reducer,
        emptyState,
        windows,
      });

      await agg.start();

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      runtime.getExecutions.mockRejectedValueOnce(new Error('store unavailable'));

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(consoleSpy).toHaveBeenCalledWith('[axl-studio] rebuild failed:', expect.any(Error));
      consoleSpy.mockRestore();
      agg.close();
    });
  });

  describe('getAllSnapshots', () => {
    it('returns a record with all window snapshots', async () => {
      const now = Date.now();
      const runtime = createMockRuntime([
        makeExecution([makeEvent({ timestamp: now - 1000, cost: 0.01 })]),
      ]);
      const agg = new TraceAggregator({
        runtime: runtime as any,
        connMgr,
        channel: 'test',
        reducer,
        emptyState,
        windows,
      });

      await agg.start();
      const all = agg.getAllSnapshots();
      expect(Object.keys(all).sort()).toEqual(['24h', '30d', '7d', 'all']);
      for (const w of windows) {
        expect(all[w]).toBeDefined();
      }
      agg.close();
    });
  });

  describe('close lifecycle', () => {
    it('clears interval on close', async () => {
      const runtime = createMockRuntime([]);
      const agg = new TraceAggregator({
        runtime: runtime as any,
        connMgr,
        channel: 'test',
        reducer,
        emptyState,
        windows,
      });

      await agg.start();
      agg.close();

      // No rebuild after close
      runtime.getExecutions.mockClear();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(runtime.getExecutions).not.toHaveBeenCalled();
    });

    it('is safe to call close before start', () => {
      const runtime = createMockRuntime([]);
      const agg = new TraceAggregator({
        runtime: runtime as any,
        connMgr,
        channel: 'test',
        reducer,
        emptyState,
        windows,
      });
      // Should not throw
      agg.close();
    });

    it('is safe to call close multiple times', async () => {
      const runtime = createMockRuntime([]);
      const agg = new TraceAggregator({
        runtime: runtime as any,
        connMgr,
        channel: 'test',
        reducer,
        emptyState,
        windows,
      });
      await agg.start();
      agg.close();
      agg.close(); // should not throw
    });
  });
});
