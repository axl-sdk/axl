import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxlEventBus } from '../event-stream.js';
import type { AxlEvent } from '../types.js';

let _step = 0;
function ev(partial: Record<string, unknown>): AxlEvent {
  return {
    executionId: 'test-exec',
    step: _step++,
    timestamp: Date.now(),
    ...partial,
  } as unknown as AxlEvent;
}

const ASK = { askId: 'a', depth: 0 } as const;

describe('AxlEventBus — overflow safety net', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('queues events up to maxQueued without dropping', async () => {
    const bus = new AxlEventBus({ maxQueued: 5 });
    for (let i = 0; i < 5; i++) {
      bus._push(ev({ type: 'token', data: `t${i}`, ...ASK }));
    }
    bus._finish();
    const seen: AxlEvent[] = [];
    for await (const e of bus) seen.push(e);
    expect(seen).toHaveLength(5);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('drops oldest non-terminal event when cap is exceeded (default policy)', async () => {
    const bus = new AxlEventBus({ maxQueued: 3 });
    // push 5; after each push past 3 the oldest should be dropped
    for (let i = 0; i < 5; i++) {
      bus._push(ev({ type: 'token', data: `t${i}`, ...ASK }));
    }
    bus._finish();
    const seen: AxlEvent[] = [];
    for await (const e of bus) seen.push(e);
    // Capacity 3, pushed 5 → first 2 dropped → kept t2, t3, t4
    expect(seen).toHaveLength(3);
    expect(seen.map((e) => (e as { data: string }).data)).toEqual(['t2', 't3', 't4']);
  });

  it('preserves terminal events even when cap is exceeded', async () => {
    const bus = new AxlEventBus({ maxQueued: 2 });
    // Saturate with non-terminals, then push a terminal, then more non-terminals.
    bus._push(ev({ type: 'token', data: 'a', ...ASK }));
    bus._push(ev({ type: 'token', data: 'b', ...ASK }));
    bus._push(ev({ type: 'workflow_end', data: { status: 'completed', duration: 1 } }));
    // Queue: [a, b, workflow_end] — over cap. Next push should drop oldest non-terminal (a).
    bus._push(ev({ type: 'token', data: 'c', ...ASK }));
    // Queue should still contain workflow_end.
    bus._finish();
    const types: string[] = [];
    for await (const e of bus) types.push(e.type);
    expect(types).toContain('workflow_end');
    // 'a' should have been dropped.
    expect(types.filter((t) => t === 'token').length).toBeLessThan(3);
  });

  it('warns exactly once per bus instance on first overflow', async () => {
    const bus = new AxlEventBus({ maxQueued: 2 });
    for (let i = 0; i < 10; i++) {
      bus._push(ev({ type: 'token', data: `t${i}`, ...ASK }));
    }
    bus._finish();
    // Drain so the queue empties cleanly.
    for await (const _ of bus) void _;
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/maxQueued=2/);
  });

  it('throws when onOverflow is "throw"', () => {
    const bus = new AxlEventBus({ maxQueued: 1, onOverflow: 'throw' });
    bus._push(ev({ type: 'token', data: 'a', ...ASK }));
    expect(() => bus._push(ev({ type: 'token', data: 'b', ...ASK }))).toThrow(/maxQueued=1/);
  });

  it('"throw" policy does not affect terminal events', () => {
    const bus = new AxlEventBus({ maxQueued: 1, onOverflow: 'throw' });
    bus._push(ev({ type: 'token', data: 'a', ...ASK }));
    // Terminal must pass through, not throw.
    expect(() => bus._push(ev({ type: 'workflow_end', data: {} }))).not.toThrow();
  });

  it('Infinity maxQueued disables the cap entirely', async () => {
    const bus = new AxlEventBus({ maxQueued: Infinity });
    for (let i = 0; i < 1000; i++) {
      bus._push(ev({ type: 'token', data: `t${i}`, ...ASK }));
    }
    bus._finish();
    let count = 0;
    for await (const _e of bus) {
      void _e;
      count++;
    }
    expect(count).toBe(1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('events delivered to active waiters bypass the cap entirely', async () => {
    // Active waiter means the consumer is awaiting; pushed events go
    // straight to the waiter and never enter the queue. Cap shouldn't fire.
    const bus = new AxlEventBus({ maxQueued: 1, onOverflow: 'throw' });
    const collected: AxlEvent[] = [];
    const drainer = (async () => {
      for await (const e of bus) collected.push(e);
    })();
    // Yield so the iterator parks on `next()`.
    await new Promise((r) => setImmediate(r));
    // Push a burst — cap is 1, but since the consumer is awaiting each
    // push hits the waiter directly. No throw, no drops.
    for (let i = 0; i < 50; i++) {
      bus._push(ev({ type: 'token', data: `t${i}`, ...ASK }));
      // Allow microtasks to flush so the consumer re-awaits before the next push.
      await new Promise((r) => setImmediate(r));
    }
    bus._finish();
    await drainer;
    expect(collected).toHaveLength(50);
  });

  it('all-terminal queue: rare edge case lets the queue exceed cap by one rather than drop a terminal', async () => {
    const bus = new AxlEventBus({ maxQueued: 1 });
    // Manually saturate with terminal events (would only happen if a
    // workflow emitted multiple workflow_end events before _finish).
    bus._push(ev({ type: 'workflow_end', data: {} }));
    // Queue now [workflow_end], at cap. Push a non-terminal — there is no
    // non-terminal to drop, so it's pushed anyway and queue exceeds cap.
    bus._push(ev({ type: 'token', data: 'over', ...ASK }));
    // Pin the invariant: queue length exceeded the configured cap by one.
    expect((bus as unknown as { eventQueue: unknown[] }).eventQueue.length).toBe(2);
    bus._finish();
    let count = 0;
    for await (const _e of bus) {
      void _e;
      count++;
    }
    expect(count).toBe(2); // both events delivered, no terminal dropped
  });

  it('drop-oldest-non-terminal preserves FIFO of remaining events (terminals interspersed)', async () => {
    const bus = new AxlEventBus({ maxQueued: 3 });
    // Sequence at cap [a, workflow_end, b]. Push c → drop 'a' (oldest
    // non-terminal), preserve workflow_end → [workflow_end, b, c].
    bus._push(ev({ type: 'token', data: 'a', ...ASK }));
    bus._push(ev({ type: 'workflow_end', data: {} }));
    bus._push(ev({ type: 'token', data: 'b', ...ASK }));
    bus._push(ev({ type: 'token', data: 'c', ...ASK }));
    bus._finish();
    const seen: string[] = [];
    for await (const e of bus) {
      seen.push(e.type === 'token' ? (e as { data: string }).data : e.type);
    }
    expect(seen).toEqual(['workflow_end', 'b', 'c']);
  });
});

describe('AxlEventBus — partialObjects coalescing view', () => {
  it('yields each partial when consumer keeps up', async () => {
    const bus = new AxlEventBus();
    const seen: Array<{ askId: string; object: unknown }> = [];
    const consumer = (async () => {
      for await (const p of bus.partialObjects) {
        seen.push({ askId: p.askId, object: p.object });
        if (seen.length === 3) break;
      }
    })();
    await new Promise((r) => setImmediate(r));
    bus._push(ev({ type: 'partial_object', attempt: 1, data: { object: { v: 1 } }, ...ASK }));
    await new Promise((r) => setImmediate(r));
    bus._push(ev({ type: 'partial_object', attempt: 1, data: { object: { v: 2 } }, ...ASK }));
    await new Promise((r) => setImmediate(r));
    bus._push(ev({ type: 'partial_object', attempt: 1, data: { object: { v: 3 } }, ...ASK }));
    await consumer;
    expect(seen.map((s) => (s.object as { v: number }).v)).toEqual([1, 2, 3]);
  });

  it('coalesces intermediate values per askId when consumer is slow', async () => {
    const bus = new AxlEventBus();
    // Push 5 partials before the consumer awaits. They all coalesce into
    // pending[askId='a'] = latest. The consumer's first await should see
    // the LATEST, not '1'.
    for (let i = 1; i <= 5; i++) {
      bus._push(ev({ type: 'partial_object', attempt: 1, data: { object: { v: i } }, ...ASK }));
    }
    bus._finish();
    const seen: Array<{ v: number }> = [];
    for await (const p of bus.partialObjects) {
      seen.push(p.object as { v: number });
    }
    // Single askId → one yield with the latest value.
    expect(seen).toEqual([{ v: 5 }]);
  });

  it('preserves per-askId latest across multiple asks (parallel)', async () => {
    const bus = new AxlEventBus();
    bus._push(
      ev({ type: 'partial_object', attempt: 1, data: { object: { v: 1 } }, askId: 'a', depth: 0 }),
    );
    bus._push(
      ev({ type: 'partial_object', attempt: 1, data: { object: { v: 2 } }, askId: 'b', depth: 0 }),
    );
    bus._push(
      ev({ type: 'partial_object', attempt: 1, data: { object: { v: 3 } }, askId: 'a', depth: 0 }),
    );
    bus._push(
      ev({ type: 'partial_object', attempt: 1, data: { object: { v: 4 } }, askId: 'b', depth: 0 }),
    );
    bus._finish();
    const seen = new Map<string, unknown>();
    for await (const p of bus.partialObjects) {
      seen.set(p.askId, p.object);
    }
    expect(seen.get('a')).toEqual({ v: 3 });
    expect(seen.get('b')).toEqual({ v: 4 });
    expect(seen.size).toBe(2);
  });

  it('terminates cleanly when bus finishes with no partials', async () => {
    const bus = new AxlEventBus();
    bus._finish();
    const seen: unknown[] = [];
    for await (const p of bus.partialObjects) seen.push(p);
    expect(seen).toHaveLength(0);
  });

  it('terminates after draining pending values when bus finishes', async () => {
    const bus = new AxlEventBus();
    bus._push(ev({ type: 'partial_object', attempt: 1, data: { object: { v: 1 } }, ...ASK }));
    bus._finish();
    const seen: unknown[] = [];
    for await (const p of bus.partialObjects) seen.push(p);
    // The pending value should be drained before done.
    expect(seen).toHaveLength(1);
    expect((seen[0] as { object: { v: number } }).object).toEqual({ v: 1 });
  });

  it('does NOT race with the main iterator (listener-based)', async () => {
    const bus = new AxlEventBus();
    const main: AxlEvent[] = [];
    const partials: Array<{ object: unknown }> = [];

    const mainConsumer = (async () => {
      for await (const e of bus) main.push(e);
    })();
    const partialsConsumer = (async () => {
      for await (const p of bus.partialObjects) partials.push(p);
    })();

    await new Promise((r) => setImmediate(r));
    bus._push(ev({ type: 'partial_object', attempt: 1, data: { object: { v: 1 } }, ...ASK }));
    bus._push(ev({ type: 'partial_object', attempt: 1, data: { object: { v: 2 } }, ...ASK }));
    bus._push(ev({ type: 'token', data: 'hi', ...ASK }));
    bus._finish();
    await Promise.all([mainConsumer, partialsConsumer]);

    // Main saw EVERY event in queue order — partial_object × 2 + token.
    expect(main.map((e) => e.type)).toEqual(['partial_object', 'partial_object', 'token']);
    // Partials saw the latest value(s) per askId — coalescing collapses
    // both partial_object pushes into one yield with the latest object.
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(partials.length).toBeLessThanOrEqual(2);
    const last = partials[partials.length - 1].object as { v: number };
    expect(last.v).toBe(2);
  });

  it('filters malformed partial_object events (data.object undefined)', async () => {
    // A partial_object with no data.object is a producer bug — the variant
    // shape requires the field. Silently filter so consumers don't have
    // to guard against `undefined` in the yielded value.
    const bus = new AxlEventBus();
    bus._push(ev({ type: 'partial_object', attempt: 1, data: {}, ...ASK }));
    bus._finish();
    const seen: Array<{ object: unknown }> = [];
    for await (const p of bus.partialObjects) seen.push(p);
    expect(seen).toHaveLength(0);
  });

  it('passes through valid falsy object values (null, 0, false, "")', async () => {
    const bus = new AxlEventBus();
    bus._push(
      ev({ type: 'partial_object', attempt: 1, data: { object: null }, askId: 'a', depth: 0 }),
    );
    bus._push(
      ev({ type: 'partial_object', attempt: 1, data: { object: 0 }, askId: 'b', depth: 0 }),
    );
    bus._push(
      ev({ type: 'partial_object', attempt: 1, data: { object: false }, askId: 'c', depth: 0 }),
    );
    bus._push(
      ev({ type: 'partial_object', attempt: 1, data: { object: '' }, askId: 'd', depth: 0 }),
    );
    bus._finish();
    const seen = new Map<string, unknown>();
    for await (const p of bus.partialObjects) seen.set(p.askId, p.object);
    expect(seen.size).toBe(4);
    expect(seen.get('a')).toBeNull();
    expect(seen.get('b')).toBe(0);
    expect(seen.get('c')).toBe(false);
    expect(seen.get('d')).toBe('');
  });

  it('two concurrent partialObjects iterators on the same bus do not interfere', async () => {
    const bus = new AxlEventBus();
    const seenA: number[] = [];
    const seenB: number[] = [];

    const consumerA = (async () => {
      for await (const p of bus.partialObjects) {
        seenA.push((p.object as { v: number }).v);
        if (seenA.length === 2) break;
      }
    })();
    const consumerB = (async () => {
      for await (const p of bus.partialObjects) {
        seenB.push((p.object as { v: number }).v);
        if (seenB.length === 2) break;
      }
    })();

    await new Promise((r) => setImmediate(r));
    bus._push(
      ev({ type: 'partial_object', attempt: 1, data: { object: { v: 1 } }, askId: 'a', depth: 0 }),
    );
    await new Promise((r) => setImmediate(r));
    bus._push(
      ev({ type: 'partial_object', attempt: 1, data: { object: { v: 2 } }, askId: 'b', depth: 0 }),
    );
    await Promise.all([consumerA, consumerB]);

    // Both iterators are independent listeners — each must see both events.
    expect(seenA).toEqual([1, 2]);
    expect(seenB).toEqual([1, 2]);
  });

  it('producer in tight sync loop while consumer is parked: pending coalesces correctly', async () => {
    const bus = new AxlEventBus();
    const seen: number[] = [];
    const consumer = (async () => {
      for await (const p of bus.partialObjects) {
        seen.push((p.object as { v: number }).v);
        // Stop after we have the latest value.
        if ((p.object as { v: number }).v === 100) break;
      }
    })();
    // Park the consumer.
    await new Promise((r) => setImmediate(r));
    // Tight synchronous burst — consumer's microtask cannot run between pushes.
    for (let i = 1; i <= 100; i++) {
      bus._push(ev({ type: 'partial_object', attempt: 1, data: { object: { v: i } }, ...ASK }));
    }
    await consumer;
    // Coalescing collapses 100 sync pushes into 1 yield with the latest
    // value. The consumer wakes once, drains pending (size 1), yields v=100.
    expect(seen).toEqual([100]);
  });

  it('coalescing across many askIds (100 asks × 100 partials each)', async () => {
    const bus = new AxlEventBus();
    // Push 100 partials per ask × 100 asks = 10_000 events. Latest per
    // ask should remain (v=100 for each).
    for (let askIdx = 0; askIdx < 100; askIdx++) {
      const askId = `ask-${askIdx}`;
      for (let v = 1; v <= 100; v++) {
        bus._push(
          ev({ type: 'partial_object', attempt: 1, data: { object: { v } }, askId, depth: 0 }),
        );
      }
    }
    bus._finish();
    const seen = new Map<string, number>();
    for await (const p of bus.partialObjects) {
      seen.set(p.askId, (p.object as { v: number }).v);
    }
    expect(seen.size).toBe(100);
    for (const v of seen.values()) expect(v).toBe(100);
  });

  it('return() unsubscribes the listener (no leak after early break)', async () => {
    const bus = new AxlEventBus();
    bus._push(ev({ type: 'partial_object', attempt: 1, data: { object: { v: 1 } }, ...ASK }));
    bus._push(
      ev({ type: 'partial_object', attempt: 1, data: { object: { v: 2 } }, askId: 'b', depth: 0 }),
    );
    let yielded = 0;
    for await (const _p of bus.partialObjects) {
      void _p;
      yielded++;
      break; // triggers iterator return()
    }
    expect(yielded).toBe(1);
    // No listener should remain — pushing more events shouldn't be observed.
    bus._push(ev({ type: 'partial_object', attempt: 1, data: { object: { v: 3 } }, ...ASK }));
    bus._finish();
    // Drain the bus directly to ensure no partials leak through any side channel.
    let mainCount = 0;
    for await (const _e of bus) {
      void _e;
      mainCount++;
    }
    // Three partial_objects pushed total + nothing else. The bus iterator
    // sees them all (independent of the partialObjects view).
    expect(mainCount).toBe(3);
  });
});

describe('AxlEventBus — defaults', () => {
  it('default maxQueued is 10_000', () => {
    const bus = new AxlEventBus();
    // Internal access via reflection — checking the configured default
    // surfaces the contract documented on EventStreamOptions.
    expect((bus as unknown as { maxQueued: number }).maxQueued).toBe(10_000);
  });

  it('default onOverflow is "drop-oldest-non-terminal"', () => {
    const bus = new AxlEventBus();
    expect((bus as unknown as { onOverflow: string }).onOverflow).toBe('drop-oldest-non-terminal');
  });
});

describe('AxlEventBus — _onFinish callbacks', () => {
  it('fires registered callbacks on _finish', () => {
    const bus = new AxlEventBus();
    let fired = 0;
    bus._onFinish(() => fired++);
    bus._onFinish(() => fired++);
    bus._finish();
    expect(fired).toBe(2);
  });

  it('fires synchronously if bus is already finished', () => {
    const bus = new AxlEventBus();
    bus._finish();
    let fired = 0;
    bus._onFinish(() => fired++);
    expect(fired).toBe(1);
  });

  it('unsubscribe prevents the callback from firing', () => {
    const bus = new AxlEventBus();
    let fired = 0;
    const unsub = bus._onFinish(() => fired++);
    unsub();
    bus._finish();
    expect(fired).toBe(0);
  });

  it('throwing callback does not crash the bus', () => {
    const bus = new AxlEventBus();
    bus._onFinish(() => {
      throw new Error('boom');
    });
    let after = 0;
    bus._onFinish(() => after++);
    // _finish must NOT throw; subsequent callbacks still fire.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus._finish();
    expect(after).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('_finish is idempotent — callbacks fire at most once', () => {
    const bus = new AxlEventBus();
    let fired = 0;
    bus._onFinish(() => fired++);
    bus._finish();
    bus._finish();
    expect(fired).toBe(1);
  });
});
