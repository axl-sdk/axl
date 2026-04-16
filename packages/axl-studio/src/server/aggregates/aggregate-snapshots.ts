import type { ConnectionManager } from '../ws/connection-manager.js';

export type WindowId = '24h' | '7d' | '30d' | 'all';

export type AggregateBroadcast<State> = {
  snapshots: Record<WindowId, State>;
  updatedAt: number;
};

const WINDOW_MS: Record<WindowId, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  all: Number.POSITIVE_INFINITY,
};

export function withinWindow(ts: number, window: WindowId, now: number): boolean {
  return ts >= now - WINDOW_MS[window];
}

/** Hardcoded rebuild interval — no env var or config surface in v1. */
export const REBUILD_INTERVAL_MS = 5 * 60_000;

const ALL_WINDOWS = new Set<string>(Object.keys(WINDOW_MS));

/** Parse a `?window=` query param into a validated WindowId, defaulting to `7d`. */
export function parseWindowParam(raw?: string | null, fallback: WindowId = '7d'): WindowId {
  return raw && ALL_WINDOWS.has(raw) ? (raw as WindowId) : fallback;
}

/**
 * Holds per-window snapshots of an aggregate state and handles
 * window-filter logic and WebSocket broadcast.
 */
export class AggregateSnapshots<State> {
  private snapshots: Map<WindowId, State>;

  constructor(
    private windows: WindowId[],
    private emptyState: () => State,
    private connMgr: ConnectionManager,
    private channel: string,
  ) {
    this.snapshots = new Map(windows.map((w) => [w, emptyState()]));
  }

  /** Replace all snapshots atomically — used after a full rebuild. */
  replace(fresh: Map<WindowId, State>): void {
    this.snapshots = fresh;
    this.broadcast();
  }

  /** Apply a reducer update to every window where `ts` falls inside the window. */
  fold(ts: number, update: (prev: State) => State): void {
    const now = Date.now();
    let changed = false;
    for (const window of this.windows) {
      if (withinWindow(ts, window, now)) {
        const prev = this.snapshots.get(window)!;
        this.snapshots.set(window, update(prev));
        changed = true;
      }
    }
    if (changed) this.broadcast();
  }

  get(window: WindowId): State {
    return this.snapshots.get(window) ?? this.emptyState();
  }

  getAll(): Record<WindowId, State> {
    return Object.fromEntries(this.snapshots) as Record<WindowId, State>;
  }

  private broadcast(): void {
    this.connMgr.broadcast(this.channel, {
      snapshots: this.getAll(),
      updatedAt: Date.now(),
    } satisfies AggregateBroadcast<State>);
  }
}
