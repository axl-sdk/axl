import type { AxlRuntime, EvalHistoryEntry } from '@axlsdk/axl';
import type { ConnectionManager } from '../ws/connection-manager.js';
import { AggregateSnapshots, REBUILD_INTERVAL_MS, withinWindow } from './aggregate-snapshots.js';
import type { WindowId } from './aggregate-snapshots.js';

export type EvalReducer<State> = (acc: State, entry: EvalHistoryEntry) => State;

export type EvalAggregatorOptions<State> = {
  runtime: AxlRuntime;
  connMgr: ConnectionManager;
  channel: string;
  reducer: EvalReducer<State>;
  emptyState: () => State;
  windows: WindowId[];
  /** Max eval entries to replay on rebuild. Default 500. */
  entryCap?: number;
  /** Optional transform applied to each window's state before WS broadcast. */
  broadcastTransform?: (state: State) => unknown;
};

/**
 * Consumes EvalHistoryEntry. Rebuilds from runtime.getEvalHistory().
 * Live updates arrive via runtime.on('eval_result', entry).
 */
export class EvalAggregator<State> {
  private snaps: AggregateSnapshots<State>;
  private interval?: ReturnType<typeof setInterval>;
  private listener?: (entry: EvalHistoryEntry) => void;
  private options: EvalAggregatorOptions<State>;

  constructor(options: EvalAggregatorOptions<State>) {
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
    this.listener = (entry: EvalHistoryEntry) => {
      this.snaps.fold(entry.timestamp, (prev) => this.options.reducer(prev, entry));
    };
    this.options.runtime.on('eval_result', this.listener);
    this.interval = setInterval(
      () => this.rebuild().catch((err) => console.error('[axl-studio] rebuild failed:', err)),
      REBUILD_INTERVAL_MS,
    );
  }

  async rebuild(): Promise<void> {
    const history: EvalHistoryEntry[] = await this.options.runtime.getEvalHistory();
    const cap = this.options.entryCap ?? 500;
    const capped = history.slice(0, cap);
    const now = Date.now();
    const fresh = new Map<WindowId, State>(
      this.options.windows.map((w) => [w, this.options.emptyState()]),
    );
    for (const entry of capped) {
      for (const window of this.options.windows) {
        if (withinWindow(entry.timestamp, window, now)) {
          fresh.set(window, this.options.reducer(fresh.get(window)!, entry));
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
    if (this.listener) this.options.runtime.off('eval_result', this.listener);
    if (this.interval) clearInterval(this.interval);
  }
}
