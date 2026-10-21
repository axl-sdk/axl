import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { CoalescedRunner } from '../server/aggregates/coalesced-runner.js';
import { TraceAggregator } from '../server/aggregates/trace-aggregator.js';
import { ExecutionAggregator } from '../server/aggregates/execution-aggregator.js';
import { ConnectionManager } from '../server/ws/connection-manager.js';
import type { WindowId } from '../server/aggregates/aggregate-snapshots.js';

type Count = { count: number };
const emptyState = (): Count => ({ count: 0 });
const windows: WindowId[] = ['all'];
const DELETES = 50;

function makeRun(i: number) {
  const executionId = `exec-${i}`;
  return {
    executionId,
    workflow: 'wf',
    status: 'completed',
    startedAt: Date.now() - i,
    events: [{ type: 'log', executionId, step: 0, timestamp: Date.now() - i, data: {} }],
  };
}

/** A runtime whose store reads can be held; deleting a run removes it from the store. */
function createRuntime(total: number) {
  const store = new Map(Array.from({ length: total }, (_, i) => [`exec-${i}`, makeRun(i)]));
  const gates: Array<() => void> = [];
  let hold = false;
  const runtime = Object.assign(new EventEmitter(), {
    getExecutions: vi.fn(async () => {
      const snapshot = [...store.values()];
      if (hold) await new Promise<void>((resolve) => gates.push(resolve));
      return snapshot;
    }),
    getExecution: vi.fn(),
    deleteRun(id: string) {
      store.delete(id);
      runtime.emit('execution_deleted', id);
    },
    holdReads() {
      hold = true;
    },
    releaseReads() {
      hold = false;
      gates.splice(0).forEach((open) => open());
    },
  });
  return runtime;
}

const countReducer = (acc: Count): Count => ({ count: acc.count + 1 });

const aggregators = [
  [
    'TraceAggregator',
    (runtime: ReturnType<typeof createRuntime>) =>
      new TraceAggregator<Count>({
        runtime: runtime as never,
        connMgr: new ConnectionManager(),
        channel: 't',
        reducer: countReducer,
        emptyState,
        windows,
      }),
  ],
  [
    'ExecutionAggregator',
    (runtime: ReturnType<typeof createRuntime>) =>
      new ExecutionAggregator<Count>({
        runtime: runtime as never,
        connMgr: new ConnectionManager(),
        channel: 'w',
        reducer: countReducer,
        emptyState,
        windows,
      }),
  ],
] as const;

describe.each(aggregators)('%s rebuild coalescing', (_name, create) => {
  it('costs two store reads for a burst of deletes, and reflects every delete', async () => {
    const runtime = createRuntime(100);
    const agg = create(runtime);
    await agg.start();
    expect(agg.getSnapshot('all').count).toBe(100);
    runtime.getExecutions.mockClear();

    runtime.holdReads();
    const inFlight = agg.rebuild();
    for (let i = 0; i < DELETES; i++) runtime.deleteRun(`exec-${i}`);
    runtime.releaseReads();
    await inFlight;
    // Let the trailing rebuild finish.
    await vi.waitFor(() => expect(runtime.getExecutions).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(agg.getSnapshot('all').count).toBe(100 - DELETES));
    expect(runtime.getExecutions).toHaveBeenCalledTimes(2);
    agg.close();
  });

  it('keeps rebuilding after a failed read', async () => {
    const runtime = createRuntime(3);
    const agg = create(runtime);
    await agg.start();

    runtime.getExecutions.mockRejectedValueOnce(new Error('store unavailable'));
    await expect(agg.rebuild()).rejects.toThrow('store unavailable');

    runtime.deleteRun('exec-0');
    await agg.rebuild();
    expect(agg.getSnapshot('all').count).toBe(2);
    agg.close();
  });
});

describe('CoalescedRunner', () => {
  it('serves a burst with one in-flight run and one trailing run', async () => {
    let release!: () => void;
    const task = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
      .mockResolvedValue(undefined);
    const runner = new CoalescedRunner(task);

    const first = runner.run();
    const burst = Array.from({ length: 20 }, () => runner.run());
    expect(task).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, ...burst]);

    expect(task).toHaveBeenCalledTimes(2);
  });

  it('does not wedge when the in-flight run fails', async () => {
    let fail!: (err: Error) => void;
    const task = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((_, reject) => (fail = reject)))
      .mockResolvedValue(undefined);
    const runner = new CoalescedRunner(task);

    const first = runner.run();
    const trailing = runner.run();
    fail(new Error('boom'));

    await expect(first).rejects.toThrow('boom');
    await expect(trailing).resolves.toBeUndefined();
    await runner.run();
    expect(task).toHaveBeenCalledTimes(3);
  });
});
