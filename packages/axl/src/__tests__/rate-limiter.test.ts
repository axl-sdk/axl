import { describe, it, expect, vi } from 'vitest';
import { RateLimiter } from '../providers/rate-limiter.js';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Flush the microtask queue so synchronously-resolved acquires run their `.then`. */
const tick = () => Promise.resolve();

describe('RateLimiter', () => {
  it('never exceeds maxConcurrent under a burst', async () => {
    const rl = new RateLimiter({ maxConcurrent: 3 });
    let inFlight = 0;
    let peak = 0;
    const task = async () => {
      await rl.acquire();
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(8);
      inFlight--;
      rl.release();
    };
    await Promise.all(Array.from({ length: 20 }, task));
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually parallelized, not serialized
    expect(inFlight).toBe(0);
  });

  it('grants queued waiters in FIFO order', async () => {
    const rl = new RateLimiter({ maxConcurrent: 1 });
    const order: number[] = [];
    await rl.acquire(); // hold the only permit
    const ps = [1, 2, 3].map((id) =>
      rl.acquire().then(() => {
        order.push(id);
        rl.release();
      }),
    );
    rl.release(); // release the held permit → cascade through the queue
    await Promise.all(ps);
    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects a pre-aborted signal without taking a permit', async () => {
    const rl = new RateLimiter({ maxConcurrent: 2 });
    const ac = new AbortController();
    const reason = new Error('pre-aborted limiter identity');
    ac.abort(reason);
    await expect(rl.acquire(ac.signal)).rejects.toBe(reason);
    // No permit leaked: two fresh acquires (cap 2) both resolve immediately.
    await expect(Promise.all([rl.acquire(), rl.acquire()])).resolves.toBeDefined();
  });

  it('dequeues an aborted waiter without leaking its slot', async () => {
    const rl = new RateLimiter({ maxConcurrent: 1 });
    await rl.acquire(); // hold
    const ac = new AbortController();
    const aborted = rl.acquire(ac.signal); // queued first
    let afterGranted = false;
    const after = rl.acquire().then(() => {
      afterGranted = true;
    }); // queued behind
    const reason = new Error('queued limiter identity');
    ac.abort(reason);
    await expect(aborted).rejects.toBe(reason);
    expect(afterGranted).toBe(false); // still waiting on the held permit
    rl.release(); // → should grant `after`, not the aborted (removed) waiter
    await after;
    expect(afterGranted).toBe(true);
  });

  it('does not over-release when a granted waiter is later aborted', async () => {
    const rl = new RateLimiter({ maxConcurrent: 1 });
    const ac = new AbortController();
    await rl.acquire(ac.signal); // granted immediately; listener removed on grant
    ac.abort(); // must be a no-op for the governor (caller owns the permit now)
    await tick();
    // A second acquire should still queue (the granted permit is held), proving
    // the abort didn't spuriously free a slot.
    let granted = false;
    const next = rl.acquire().then(() => {
      granted = true;
    });
    await tick();
    expect(granted).toBe(false);
    rl.release();
    await next;
    expect(granted).toBe(true);
  });

  it('rejects with a timeout when a waiter queues longer than acquireTimeoutMs', async () => {
    const rl = new RateLimiter({ maxConcurrent: 1, acquireTimeoutMs: 25 });
    await rl.acquire(); // hold, never release
    await expect(rl.acquire()).rejects.toThrow(/timed out after 25ms/);
  });

  it('spaces grants by at least minIntervalMs', async () => {
    const rl = new RateLimiter({ minIntervalMs: 40 }); // no concurrency cap
    const start = Date.now();
    const times: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async () => {
        await rl.acquire();
        times.push(Date.now() - start);
        rl.release();
      }),
    );
    times.sort((a, b) => a - b);
    // First grant ~immediate; subsequent grants spaced ~40ms apart (slack for timer jitter).
    expect(times[1]).toBeGreaterThanOrEqual(33);
    expect(times[2]).toBeGreaterThanOrEqual(72);
  });

  it('grants the first request immediately even with minIntervalMs under a low clock', async () => {
    // Regression guard: lastGrantAt is -Infinity, not 0, so the very first grant
    // is immediate regardless of the wall clock. With a 0 init and a low/mocked
    // clock, the first grant would wrongly wait a full interval.
    vi.useFakeTimers();
    vi.setSystemTime(5);
    try {
      const rl = new RateLimiter({ minIntervalMs: 100 });
      let resolved = false;
      void rl.acquire().then(() => {
        resolved = true;
      });
      await Promise.resolve(); // flush the grant's microtask
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns (does not silently swallow) a release with no active permits', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rl = new RateLimiter({ maxConcurrent: 2 });
      rl.release(); // nothing was acquired → likely a double-release bug
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('double-release'));
    } finally {
      warn.mockRestore();
    }
  });

  it('warns that maxConcurrent < 2 serializes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      new RateLimiter({ maxConcurrent: 1 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('serializes'));
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores an invalid maxConcurrent (no cap) with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rl = new RateLimiter({ maxConcurrent: 0 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignoring invalid maxConcurrent'));
      // No cap → 5 concurrent acquires all resolve without any release.
      await expect(
        Promise.all(Array.from({ length: 5 }, () => rl.acquire())),
      ).resolves.toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('warns only once when calls queue', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rl = new RateLimiter({ maxConcurrent: 1 });
      warn.mockClear(); // drop the constructor's serialize warning
      await rl.acquire(); // hold
      const q1 = rl.acquire().then(() => rl.release());
      const q2 = rl.acquire().then(() => rl.release());
      const queueWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('request queued'));
      expect(queueWarnings).toHaveLength(1);
      rl.release(); // drain
      await Promise.all([q1, q2]);
    } finally {
      warn.mockRestore();
    }
  });
});
