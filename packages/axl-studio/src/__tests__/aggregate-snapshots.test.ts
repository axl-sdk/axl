import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AggregateSnapshots,
  withinWindow,
  REBUILD_INTERVAL_MS,
} from '../server/aggregates/aggregate-snapshots.js';
import { ConnectionManager } from '../server/ws/connection-manager.js';
import type { WindowId } from '../server/aggregates/aggregate-snapshots.js';

// ── withinWindow ──────────────────────────────────────────────────────

describe('withinWindow', () => {
  const NOW = 1_700_000_000_000;

  it('returns true for timestamps inside 24h window', () => {
    const oneHourAgo = NOW - 60 * 60 * 1000;
    expect(withinWindow(oneHourAgo, '24h', NOW)).toBe(true);
  });

  it('returns false for timestamps outside 24h window', () => {
    const twoDaysAgo = NOW - 2 * 24 * 60 * 60 * 1000;
    expect(withinWindow(twoDaysAgo, '24h', NOW)).toBe(false);
  });

  it('returns true at the exact boundary (inclusive)', () => {
    const exactBoundary = NOW - 24 * 60 * 60 * 1000;
    expect(withinWindow(exactBoundary, '24h', NOW)).toBe(true);
  });

  it('returns false 1ms before the boundary', () => {
    const justOutside = NOW - 24 * 60 * 60 * 1000 - 1;
    expect(withinWindow(justOutside, '24h', NOW)).toBe(false);
  });

  it('returns true for all windows when ts === now', () => {
    const windows: WindowId[] = ['24h', '7d', '30d', 'all'];
    for (const w of windows) {
      expect(withinWindow(NOW, w, NOW)).toBe(true);
    }
  });

  it('returns true for future timestamps in all windows', () => {
    const future = NOW + 1000;
    const windows: WindowId[] = ['24h', '7d', '30d', 'all'];
    for (const w of windows) {
      expect(withinWindow(future, w, NOW)).toBe(true);
    }
  });

  it('all window accepts any non-negative timestamp', () => {
    expect(withinWindow(0, 'all', NOW)).toBe(true);
    expect(withinWindow(1, 'all', NOW)).toBe(true);
  });

  it('7d window rejects 8-day-old timestamps', () => {
    const eightDays = NOW - 8 * 24 * 60 * 60 * 1000;
    expect(withinWindow(eightDays, '7d', NOW)).toBe(false);
  });

  it('30d window accepts 29-day-old timestamps', () => {
    const twentyNineDays = NOW - 29 * 24 * 60 * 60 * 1000;
    expect(withinWindow(twentyNineDays, '30d', NOW)).toBe(true);
  });

  it('30d window rejects 31-day-old timestamps', () => {
    const thirtyOneDays = NOW - 31 * 24 * 60 * 60 * 1000;
    expect(withinWindow(thirtyOneDays, '30d', NOW)).toBe(false);
  });

  it('all window accepts negative timestamps (edge case)', () => {
    // POSITIVE_INFINITY subtracted from now still returns true for any real ts
    expect(withinWindow(-1_000_000, 'all', NOW)).toBe(true);
  });
});

// ── REBUILD_INTERVAL_MS ───────────────────────────────────────────────

describe('REBUILD_INTERVAL_MS', () => {
  it('is 5 minutes', () => {
    expect(REBUILD_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});

// ── AggregateSnapshots ────────────────────────────────────────────────

type Counter = { count: number };

describe('AggregateSnapshots', () => {
  let connMgr: ConnectionManager;
  let snaps: AggregateSnapshots<Counter>;
  const windows: WindowId[] = ['24h', '7d', '30d', 'all'];
  const emptyState = (): Counter => ({ count: 0 });

  beforeEach(() => {
    connMgr = new ConnectionManager();
    snaps = new AggregateSnapshots(windows, emptyState, connMgr, 'test-channel');
  });

  it('initializes all windows with empty state', () => {
    for (const w of windows) {
      expect(snaps.get(w)).toEqual({ count: 0 });
    }
  });

  it('getAll returns all windows', () => {
    const all = snaps.getAll();
    expect(Object.keys(all)).toEqual(windows);
    for (const w of windows) {
      expect(all[w]).toEqual({ count: 0 });
    }
  });

  it('get returns empty state for unknown window', () => {
    // Shouldn't happen in practice, but safe fallback
    expect(snaps.get('24h')).toEqual({ count: 0 });
  });

  describe('replace', () => {
    it('atomically replaces all snapshots', () => {
      const fresh = new Map<WindowId, Counter>([
        ['24h', { count: 10 }],
        ['7d', { count: 20 }],
        ['30d', { count: 30 }],
        ['all', { count: 40 }],
      ]);
      snaps.replace(fresh);
      expect(snaps.get('24h')).toEqual({ count: 10 });
      expect(snaps.get('7d')).toEqual({ count: 20 });
      expect(snaps.get('30d')).toEqual({ count: 30 });
      expect(snaps.get('all')).toEqual({ count: 40 });
    });

    it('broadcasts after replace', () => {
      const broadcastSpy = vi.spyOn(connMgr, 'broadcast');
      const fresh = new Map<WindowId, Counter>(windows.map((w) => [w, { count: 1 }]));
      snaps.replace(fresh);
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect(broadcastSpy).toHaveBeenCalledWith(
        'test-channel',
        expect.objectContaining({
          snapshots: expect.any(Object),
          updatedAt: expect.any(Number),
        }),
      );
    });
  });

  describe('fold', () => {
    it('updates windows where timestamp falls inside', () => {
      const now = Date.now();
      // A recent timestamp should match all windows
      snaps.fold(now, (prev) => ({ count: prev.count + 1 }));
      expect(snaps.get('24h').count).toBe(1);
      expect(snaps.get('7d').count).toBe(1);
      expect(snaps.get('30d').count).toBe(1);
      expect(snaps.get('all').count).toBe(1);
    });

    it('only updates matching windows for an old timestamp', () => {
      const now = Date.now();
      // 3 days ago — should hit 7d, 30d, all but not 24h
      const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
      snaps.fold(threeDaysAgo, (prev) => ({ count: prev.count + 1 }));
      expect(snaps.get('24h').count).toBe(0);
      expect(snaps.get('7d').count).toBe(1);
      expect(snaps.get('30d').count).toBe(1);
      expect(snaps.get('all').count).toBe(1);
    });

    it('only updates all window for very old timestamp', () => {
      // 60 days ago — only 'all' window
      const now = Date.now();
      const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;
      snaps.fold(sixtyDaysAgo, (prev) => ({ count: prev.count + 1 }));
      expect(snaps.get('24h').count).toBe(0);
      expect(snaps.get('7d').count).toBe(0);
      expect(snaps.get('30d').count).toBe(0);
      expect(snaps.get('all').count).toBe(1);
    });

    it('broadcasts when at least one window matches', () => {
      const broadcastSpy = vi.spyOn(connMgr, 'broadcast');
      snaps.fold(Date.now(), (prev) => ({ count: prev.count + 1 }));
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
    });

    it('does not broadcast when no windows match', () => {
      // Construct an AggregateSnapshots with only '24h' window, then fold
      // a very old timestamp that doesn't match
      const narrowSnaps = new AggregateSnapshots(
        ['24h'] as WindowId[],
        emptyState,
        connMgr,
        'test-channel',
      );
      const broadcastSpy = vi.spyOn(connMgr, 'broadcast');
      const veryOld = Date.now() - 100 * 24 * 60 * 60 * 1000;
      narrowSnaps.fold(veryOld, (prev) => ({ count: prev.count + 1 }));
      expect(broadcastSpy).not.toHaveBeenCalled();
    });

    it('accumulates across multiple folds', () => {
      const now = Date.now();
      snaps.fold(now, (prev) => ({ count: prev.count + 1 }));
      snaps.fold(now, (prev) => ({ count: prev.count + 1 }));
      snaps.fold(now, (prev) => ({ count: prev.count + 1 }));
      expect(snaps.get('all').count).toBe(3);
    });

    it('returns new state object, not mutated original', () => {
      const now = Date.now();
      const before = snaps.get('all');
      snaps.fold(now, (prev) => ({ count: prev.count + 1 }));
      const after = snaps.get('all');
      expect(before.count).toBe(0);
      expect(after.count).toBe(1);
      expect(before).not.toBe(after);
    });
  });

  describe('broadcast payload shape', () => {
    it('includes snapshots record and updatedAt timestamp', () => {
      const broadcastSpy = vi.spyOn(connMgr, 'broadcast');
      snaps.fold(Date.now(), (prev) => ({ count: prev.count + 1 }));

      const [channel, payload] = broadcastSpy.mock.calls[0];
      expect(channel).toBe('test-channel');
      const broadcast = payload as { snapshots: Record<WindowId, Counter>; updatedAt: number };
      expect(broadcast.snapshots).toBeDefined();
      expect(broadcast.updatedAt).toBeGreaterThan(0);
      expect(broadcast.snapshots['24h'].count).toBe(1);
      expect(broadcast.snapshots['all'].count).toBe(1);
    });
  });

  describe('subset of windows', () => {
    it('works with a subset of windows', () => {
      const smallSnaps = new AggregateSnapshots(
        ['7d', 'all'] as WindowId[],
        emptyState,
        connMgr,
        'test-channel',
      );
      smallSnaps.fold(Date.now(), (prev) => ({ count: prev.count + 1 }));
      const all = smallSnaps.getAll();
      expect(Object.keys(all)).toEqual(['7d', 'all']);
      expect(all['7d'].count).toBe(1);
      expect(all['all'].count).toBe(1);
    });
  });
});
