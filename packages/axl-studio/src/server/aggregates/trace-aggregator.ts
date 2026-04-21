import type { AxlRuntime, AxlEvent, ExecutionInfo } from '@axlsdk/axl';
import type { ConnectionManager } from '../ws/connection-manager.js';
import { AggregateSnapshots, REBUILD_INTERVAL_MS, withinWindow } from './aggregate-snapshots.js';
import type { WindowId } from './aggregate-snapshots.js';

export type TraceReducer<State> = (acc: State, event: AxlEvent) => State;

export type TraceAggregatorOptions<State> = {
  runtime: AxlRuntime;
  connMgr: ConnectionManager;
  channel: string;
  reducer: TraceReducer<State>;
  emptyState: () => State;
  windows: WindowId[];
  /** Max executions to replay on rebuild. Default 2000. */
  executionCap?: number;
  /** Optional transform applied to each window's state before WS broadcast. */
  broadcastTransform?: (state: State) => unknown;
};

/**
 * Consumes AxlEvents from execution history and the live trace stream.
 * Maintains per-window aggregate snapshots via a pure reducer.
 */
export class TraceAggregator<State> {
  private snaps: AggregateSnapshots<State>;
  private interval?: ReturnType<typeof setInterval>;
  private listener?: (event: AxlEvent) => void;
  private options: TraceAggregatorOptions<State>;

  constructor(options: TraceAggregatorOptions<State>) {
    this.options = options;
    this.snaps = new AggregateSnapshots(
      options.windows,
      options.emptyState,
      options.connMgr,
      options.channel,
      options.broadcastTransform,
    );
  }

  async start(): Promise<void> {
    await this.rebuild();
    this.listener = (event: AxlEvent) => {
      this.snaps.fold(event.timestamp, (prev) => this.options.reducer(prev, event));
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
      for (const event of exec.events) {
        for (const window of this.options.windows) {
          if (withinWindow(event.timestamp, window, now)) {
            fresh.set(window, this.options.reducer(fresh.get(window)!, event));
          }
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
