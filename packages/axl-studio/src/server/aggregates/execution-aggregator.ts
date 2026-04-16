import type { AxlRuntime, TraceEvent, ExecutionInfo } from '@axlsdk/axl';
import type { ConnectionManager } from '../ws/connection-manager.js';
import { AggregateSnapshots, REBUILD_INTERVAL_MS, withinWindow } from './aggregate-snapshots.js';
import type { WindowId } from './aggregate-snapshots.js';

export type ExecutionReducer<State> = (acc: State, execution: ExecutionInfo) => State;

export type ExecutionAggregatorOptions<State> = {
  runtime: AxlRuntime;
  connMgr: ConnectionManager;
  channel: string;
  reducer: ExecutionReducer<State>;
  emptyState: () => State;
  windows: WindowId[];
  /** Max executions to replay on rebuild. Default 2000. */
  executionCap?: number;
};

/**
 * Consumes ExecutionInfo at the execution granularity (not individual trace events).
 * Live updates arrive via workflow_end trace events — the aggregator fetches the
 * finalized ExecutionInfo and folds it.
 */
export class ExecutionAggregator<State> {
  private snaps: AggregateSnapshots<State>;
  private interval?: ReturnType<typeof setInterval>;
  private listener?: (event: TraceEvent) => void;
  private options: ExecutionAggregatorOptions<State>;

  constructor(options: ExecutionAggregatorOptions<State>) {
    this.options = options;
    this.snaps = new AggregateSnapshots(
      options.windows,
      options.emptyState,
      options.connMgr,
      options.channel,
    );
  }

  async start(): Promise<void> {
    await this.rebuild();
    this.listener = (event: TraceEvent) => {
      if (event.type !== 'workflow_end') return;
      // Fetch the finalized ExecutionInfo and fold it
      this.options.runtime
        .getExecution(event.executionId)
        .then((exec) => {
          if (exec) {
            this.snaps.fold(exec.startedAt, (prev) => this.options.reducer(prev, exec));
          }
        })
        .catch((err) => console.error('[axl-studio] execution fold failed:', err));
    };
    this.options.runtime.on('trace', this.listener);
    this.interval = setInterval(
      () => this.rebuild().catch((err) => console.error('[axl-studio] rebuild failed:', err)),
      REBUILD_INTERVAL_MS,
    );
  }

  async rebuild(): Promise<void> {
    const executions: ExecutionInfo[] = await this.options.runtime.getExecutions();
    const cap = this.options.executionCap ?? 2000;
    const capped = executions.slice(0, cap);
    const now = Date.now();
    const fresh = new Map<WindowId, State>(
      this.options.windows.map((w) => [w, this.options.emptyState()]),
    );
    for (const exec of capped) {
      for (const window of this.options.windows) {
        if (withinWindow(exec.startedAt, window, now)) {
          fresh.set(window, this.options.reducer(fresh.get(window)!, exec));
        }
      }
    }
    this.snaps.replace(fresh);
  }

  getSnapshot(window: WindowId): State {
    return this.snaps.get(window);
  }

  getAllSnapshots(): Record<WindowId, State> {
    return this.snaps.getAll();
  }

  close(): void {
    if (this.listener) this.options.runtime.off('trace', this.listener);
    if (this.interval) clearInterval(this.interval);
  }
}
