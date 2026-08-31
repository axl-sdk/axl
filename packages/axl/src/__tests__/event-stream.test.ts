import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxlEventBus, EventStreamOverflowError } from '../event-stream.js';
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

function toolStart(callId = 'c1'): AxlEvent {
  return ev({
    schemaVersion: 2,
    type: 'tool_call_start',
    agent: 'agent',
    tool: 'lookup',
    callId,
    data: { args: {} },
    ...ASK,
  });
}

function toolEnd(callId = 'c1'): AxlEvent {
  return ev({
    schemaVersion: 2,
    type: 'tool_call_end',
    agent: 'agent',
    tool: 'lookup',
    callId,
    duration: 1,
    data: { args: {}, outcome: { status: 'succeeded', result: 'ok' } },
    ...ASK,
  });
}

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
    expect(bus.observationStatus).toEqual({
      complete: false,
      reason: 'queue_overflow',
      droppedEvents: 2,
    });
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

  it('throws an EventStreamOverflowError when onOverflow is "throw"', () => {
    const bus = new AxlEventBus({ maxQueued: 1, onOverflow: 'throw' });
    bus._push(ev({ type: 'token', data: 'a', ...ASK }));
    let caught: unknown;
    try {
      bus._push(ev({ type: 'token', data: 'b', ...ASK }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EventStreamOverflowError);
    expect((caught as EventStreamOverflowError).maxQueued).toBe(1);
    expect((caught as EventStreamOverflowError).eventType).toBe('token');
    expect((caught as Error).message).toMatch(/maxQueued=1/);
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

  it('keeps lifecycle delivery independent from pairing when the queue overflows', async () => {
    const bus = new AxlEventBus({ maxQueued: 1 });
    const iterator = bus[Symbol.asyncIterator]();
    const pendingStart = iterator.next();
    bus._push(toolStart());
    await expect(pendingStart).resolves.toMatchObject({ value: { type: 'tool_call_start' } });

    bus._push(ev({ type: 'token', data: 'queued', ...ASK }));
    bus._push(toolEnd());
    bus._finish();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'tool_call_end' } });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('does not let many transcription terminals bypass maxQueued', async () => {
    const bus = new AxlEventBus({ maxQueued: 2 });
    for (let index = 0; index < 8; index++) {
      bus._push(
        ev({
          type: 'transcription_end',
          transcriptionId: `tr-${index}`,
          duration: 1,
          data: { status: 'completed' },
        }),
      );
    }
    bus._finish();
    const seen: AxlEvent[] = [];
    for await (const event of bus) seen.push(event);
    expect(seen).toHaveLength(2);
    expect(seen.every((event) => event.type === 'transcription_end')).toBe(true);
  });

  it('allows an explicitly incomplete lifecycle view without exceeding maxQueued', async () => {
    const bus = new AxlEventBus({ maxQueued: 1 });
    bus._push(toolStart());
    bus._push(ev({ type: 'token', data: 'replacement', ...ASK }));
    bus._push(toolEnd());
    bus._finish();

    const seen: AxlEvent[] = [];
    for await (const event of bus) seen.push(event);
    expect(seen.map((event) => event.type)).toEqual(['tool_call_end']);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('keeps a stalled lifecycle queue bounded without pair-tracking state', () => {
    const maxQueued = 3;
    const bus = new AxlEventBus({ maxQueued });

    for (let index = 0; index < 1_000; index++) {
      const callId = `call-${index}`;
      bus._push(toolStart(callId));
      expect((bus as unknown as { eventQueue: unknown[] }).eventQueue.length).toBeLessThanOrEqual(
        maxQueued,
      );
      bus._push(toolEnd(callId));
      expect((bus as unknown as { eventQueue: unknown[] }).eventQueue.length).toBeLessThanOrEqual(
        maxQueued,
      );
    }

    expect(Object.keys(bus)).not.toEqual(
      expect.arrayContaining(['consumedToolStarts', 'droppedToolStarts']),
    );
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

  it('drops pending partial on pipeline(failed) so attempt-N snapshots do not leak across retries', async () => {
    // The customer hazard: a fast consumer renders attempt-1's last
    // partial, then schema validation fails and attempt-2 starts. Without
    // this fix, the consumer would render attempt-1 final → attempt-2
    // partials, mixing two different streamed objects (with potentially
    // different shapes if the model regenerated more carefully). The
    // pipeline-failed listener clears `pending` for the askId so an
    // undrained attempt-1 snapshot doesn't reach the consumer.
    const bus = new AxlEventBus();
    bus._push(
      ev({
        type: 'partial_object',
        attempt: 1,
        data: { object: { v: 'attempt-1-final' } },
        ...ASK,
      }),
    );
    // Simulate schema validation failure → retry begins.
    bus._push(
      ev({
        type: 'pipeline',
        status: 'failed',
        stage: 'schema',
        attempt: 1,
        maxAttempts: 4,
        ...ASK,
      }),
    );
    // attempt-2 begins emitting.
    bus._push(
      ev({
        type: 'partial_object',
        attempt: 2,
        data: { object: { v: 'attempt-2-start' } },
        ...ASK,
      }),
    );
    bus._finish();
    const seen: Array<{ v: string; attempt: number }> = [];
    for await (const p of bus.partialObjects) {
      seen.push({ v: (p.object as { v: string }).v, attempt: p.attempt });
    }
    // Only attempt-2 should be visible. attempt-1's pending entry was
    // dropped on pipeline(failed) before the consumer drained it.
    expect(seen).toEqual([{ v: 'attempt-2-start', attempt: 2 }]);
  });

  it('yields attempt number on each coalesced value (UI can flag retries)', async () => {
    const bus = new AxlEventBus();
    bus._push(
      ev({ type: 'partial_object', attempt: 1, data: { object: { x: 1 } }, askId: 'a', depth: 0 }),
    );
    bus._push(
      ev({ type: 'partial_object', attempt: 2, data: { object: { x: 2 } }, askId: 'b', depth: 0 }),
    );
    bus._finish();
    const seen = new Map<string, number>();
    for await (const p of bus.partialObjects) seen.set(p.askId, p.attempt);
    expect(seen.get('a')).toBe(1);
    expect(seen.get('b')).toBe(2);
  });

  it("pipeline(failed) on a different askId does not affect another ask's pending partial", async () => {
    const bus = new AxlEventBus();
    bus._push(
      ev({
        type: 'partial_object',
        attempt: 1,
        data: { object: { who: 'a' } },
        askId: 'a',
        depth: 0,
      }),
    );
    bus._push(
      ev({
        type: 'partial_object',
        attempt: 1,
        data: { object: { who: 'b' } },
        askId: 'b',
        depth: 0,
      }),
    );
    // pipeline(failed) for askId='a' ONLY.
    bus._push(
      ev({
        type: 'pipeline',
        status: 'failed',
        stage: 'schema',
        attempt: 1,
        maxAttempts: 4,
        askId: 'a',
        depth: 0,
      }),
    );
    bus._finish();
    const seen = new Map<string, unknown>();
    for await (const p of bus.partialObjects) seen.set(p.askId, p.object);
    // ask 'a' was cleared, ask 'b' survives.
    expect(seen.has('a')).toBe(false);
    expect(seen.get('b')).toEqual({ who: 'b' });
  });

  it('clears pending on pipeline(failed) at validate stage (not just schema)', async () => {
    // The pending-clear listener gates on `status === 'failed'` (any
    // stage), because validate-stage retries also re-enter the streaming
    // loop and can re-emit partial_object events for the same askId.
    // Without this, attempt-1's final partial would leak across a
    // validate retry boundary the same way it would across schema.
    const bus = new AxlEventBus();
    bus._push(ev({ type: 'partial_object', attempt: 1, data: { object: { v: 'a1' } }, ...ASK }));
    bus._push(
      ev({
        type: 'pipeline',
        status: 'failed',
        stage: 'validate',
        attempt: 1,
        maxAttempts: 4,
        ...ASK,
      }),
    );
    bus._push(ev({ type: 'partial_object', attempt: 2, data: { object: { v: 'a2' } }, ...ASK }));
    bus._finish();
    const seen: string[] = [];
    for await (const p of bus.partialObjects) seen.push((p.object as { v: string }).v);
    expect(seen).toEqual(['a2']);
  });

  it('clears pending on pipeline(failed) at guardrail stage (not just schema)', async () => {
    // Same rationale as the validate-stage test — guardrail retries
    // re-enter the streaming loop too. Pinning all three retry stages
    // (schema/validate/guardrail) protects against a future change to
    // gate ordering or partial-emission gating from silently regressing
    // attempt isolation.
    const bus = new AxlEventBus();
    bus._push(ev({ type: 'partial_object', attempt: 1, data: { object: { v: 'a1' } }, ...ASK }));
    bus._push(
      ev({
        type: 'pipeline',
        status: 'failed',
        stage: 'guardrail',
        attempt: 1,
        maxAttempts: 4,
        ...ASK,
      }),
    );
    bus._push(ev({ type: 'partial_object', attempt: 2, data: { object: { v: 'a2' } }, ...ASK }));
    bus._finish();
    const seen: string[] = [];
    for await (const p of bus.partialObjects) seen.push((p.object as { v: string }).v);
    expect(seen).toEqual(['a2']);
  });

  it('pipeline(committed) does NOT clear pending — the attempt won, its final partial is canonical', async () => {
    const bus = new AxlEventBus();
    bus._push(ev({ type: 'partial_object', attempt: 1, data: { object: { v: 'final' } }, ...ASK }));
    bus._push(
      ev({
        type: 'pipeline',
        status: 'committed',
        stage: 'schema',
        attempt: 1,
        maxAttempts: 4,
        ...ASK,
      }),
    );
    bus._finish();
    const seen: unknown[] = [];
    for await (const p of bus.partialObjects) seen.push(p.object);
    expect(seen).toEqual([{ v: 'final' }]);
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

describe('AxlEventBus — constructor validation', () => {
  it('rejects maxQueued: 0', () => {
    expect(() => new AxlEventBus({ maxQueued: 0 })).toThrow(/must be >= 1 or Infinity/);
  });

  it('rejects negative maxQueued', () => {
    expect(() => new AxlEventBus({ maxQueued: -10 })).toThrow(/must be >= 1 or Infinity/);
  });

  it('rejects NaN maxQueued', () => {
    expect(() => new AxlEventBus({ maxQueued: Number.NaN })).toThrow(/must be >= 1 or Infinity/);
  });

  it('accepts maxQueued: 1 (smallest valid cap)', () => {
    expect(() => new AxlEventBus({ maxQueued: 1 })).not.toThrow();
  });

  it('accepts maxQueued: Infinity', () => {
    expect(() => new AxlEventBus({ maxQueued: Infinity })).not.toThrow();
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

// ─── Iterator cleanup on early break (regression for commit bf17409) ───
// Without `return()`, breaking out of `for await` orphaned the parked
// resolver in `self.waiters`. The next `_push` would then `shift()`
// that dead resolver, deliver an event to a Promise nobody awaits, and
// the event would be lost. These tests would hang or assert wrong
// counts under the broken implementation.

describe('AxlEventBus — iterator return() cleanup', () => {
  it('main iterator early-break does not orphan its waiter (no event loss)', async () => {
    const bus = new AxlEventBus();
    const seen: AxlEvent[] = [];
    // Park a consumer that breaks after the first event.
    const consumer = (async () => {
      for await (const e of bus) {
        seen.push(e);
        break;
      }
    })();
    // Wait for the consumer to park inside `next()`.
    await new Promise((r) => setImmediate(r));
    bus._push(ev({ type: 'token', data: 'a', ...ASK }));
    await consumer;
    // Push two more events. Under the buggy implementation, the next
    // `_push` would shift the dead resolver and deliver the event to
    // a Promise nobody awaits; here it should queue normally.
    bus._push(ev({ type: 'token', data: 'b', ...ASK }));
    bus._push(ev({ type: 'token', data: 'c', ...ASK }));
    bus._finish();
    const remaining: AxlEvent[] = [];
    for await (const e of bus) remaining.push(e);
    // Total events seen across both consumers should equal what was
    // pushed. Under the bug, 'b' would be lost to the dead waiter.
    expect(seen.length + remaining.length).toBe(3);
    expect(remaining.map((e) => (e as { data: string }).data)).toEqual(['b', 'c']);
  });

  it('curated views (text, lifecycle, textByAsk) propagate return() to underlying iterator', async () => {
    // Each view wraps `bus[Symbol.asyncIterator]()`. If view.return() doesn't
    // call the underlying iter.return(), the inner waiter leaks and the next
    // _push sends to a dead consumer. Verify by interleaving a break in each
    // view with subsequent pushes that must still reach a fresh consumer.
    for (const view of ['text', 'lifecycle', 'textByAsk'] as const) {
      const bus = new AxlEventBus();
      const consumer = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _v of bus[view]) {
          break;
        }
      })();
      await new Promise((r) => setImmediate(r));
      // Trigger a value through the view so its inner loop awaits the bus.
      // text/textByAsk filter on type 'token'; lifecycle filters on
      // structural events. Push something that matches and then breaks.
      const matching: AxlEvent =
        view === 'lifecycle'
          ? ev({ type: 'agent_call_start', data: { agent: 'x', model: 'y', turn: 1 }, ...ASK })
          : ev({ type: 'token', data: 'a', ...ASK });
      bus._push(matching);
      await consumer;
      // Subsequent pushes after the break must still queue, not be
      // delivered to a dead resolver.
      bus._push(ev({ type: 'token', data: 'b', ...ASK }));
      bus._finish();
      const tail: AxlEvent[] = [];
      for await (const e of bus) tail.push(e);
      // Under the bug we'd see 0 here (the 'b' delivered to a dead
      // waiter). Should see exactly 1 ('b' — the matching event was
      // already consumed by the broken-out view).
      expect(tail.map((e) => (e as { data: string }).data ?? e.type)).toEqual(['b']);
    }
  });
});

// ─── Listener exception isolation (regression for commit bf17409) ───
// `bus.emit` propagates listener throws synchronously. Without isolation,
// a buggy `.on('agent_call_end', () => { throw … })` would unwind the
// active ctx.* primitive and fail the workflow.

describe('AxlEventBus — listener exception isolation', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it('throwing listener does not propagate from _push', () => {
    const bus = new AxlEventBus();
    bus.on('agent_call_end', () => {
      throw new Error('listener bug');
    });
    // _push must not throw.
    expect(() => {
      bus._push(
        ev({
          type: 'agent_call_end',
          data: { agent: 'x', model: 'y', cost: 0, duration: 0, response: '' },
          ...ASK,
        }),
      );
    }).not.toThrow();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toMatch(/listener for "agent_call_end" threw/);
  });

  it('throwing listener does not block iterator queue delivery', async () => {
    // Node's EventEmitter stops calling subsequent listeners once one
    // throws (the throw propagates through `emit`). Our isolation
    // catches that throw before it reaches `_push`'s caller, so the
    // queue/waiter logic that follows in `_push` still runs and the
    // workflow keeps moving. We don't promise to restart the listener
    // chain — that's the user's responsibility — but the workflow IS
    // protected.
    const bus = new AxlEventBus();
    bus.on('token', () => {
      throw new Error('listener bug');
    });
    bus._push(ev({ type: 'token', data: 'x', ...ASK }));
    bus._finish();
    const seen: AxlEvent[] = [];
    for await (const e of bus) seen.push(e);
    expect(seen).toHaveLength(1);
  });

  it('EventStreamOverflowError still propagates (handleOverflow is on a different code path)', () => {
    const bus = new AxlEventBus({ maxQueued: 1, onOverflow: 'throw' });
    bus._push(ev({ type: 'token', data: 'a', ...ASK }));
    // Queue at cap; non-terminal arrives → handleOverflow throws.
    // The listener-isolation try/catch is around `bus.emit`, not
    // around handleOverflow, so this throw must propagate.
    expect(() => {
      bus._push(ev({ type: 'token', data: 'b', ...ASK }));
    }).toThrow(EventStreamOverflowError);
    expect(bus.observationStatus).toEqual({
      complete: false,
      reason: 'queue_overflow',
      droppedEvents: 1,
    });
  });
});

describe('AxlEventBus — stringStream overflow completeness', () => {
  it('marks observation incomplete when a slow stringStream subscriber drops a field', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new AxlEventBus({ maxQueued: 1 });
    bus.stringStream()[Symbol.asyncIterator]();
    const rawEvents: AxlEvent[] = [];
    const rawDrainer = (async () => {
      for await (const event of bus) rawEvents.push(event);
    })();
    await new Promise((resolve) => setImmediate(resolve));

    bus._push(
      ev({
        type: 'string_delta',
        data: { path: '/a', delta: 'a' },
        attempt: 1,
        ...ASK,
      }),
    );
    bus._push(
      ev({
        type: 'string_delta',
        data: { path: '/b', delta: 'b' },
        attempt: 1,
        ...ASK,
      }),
    );

    expect(bus.observationStatus).toEqual({
      complete: false,
      reason: 'queue_overflow',
      droppedEvents: 1,
    });
    bus._finish();
    await rawDrainer;
    expect(rawEvents).toHaveLength(2);
    warn.mockRestore();
  });

  it('strict stringStream overflow still delivers the event to a healthy raw iterator', async () => {
    const bus = new AxlEventBus({ maxQueued: 1, onOverflow: 'throw' });
    bus.stringStream()[Symbol.asyncIterator]();
    const rawEvents: AxlEvent[] = [];
    const rawDrainer = (async () => {
      for await (const event of bus) rawEvents.push(event);
    })();
    await new Promise((resolve) => setImmediate(resolve));

    bus._push(
      ev({
        type: 'string_delta',
        data: { path: '/a', delta: 'a' },
        attempt: 1,
        ...ASK,
      }),
    );
    expect(() =>
      bus._push(
        ev({
          type: 'string_delta',
          data: { path: '/b', delta: 'b' },
          attempt: 1,
          ...ASK,
        }),
      ),
    ).toThrow(EventStreamOverflowError);

    bus._finish();
    await rawDrainer;
    expect(rawEvents).toHaveLength(2);
    expect(bus.observationStatus).toEqual({
      complete: false,
      reason: 'queue_overflow',
      droppedEvents: 1,
    });
  });
});

// ─── partialObjects late-subscriber via latestPartialByAsk
// (regression for commit aed6b98) ───
// Pre-fix the snapshot walked `eventQueue`. Events delivered to past
// waiters are no longer in the queue, so a late subscriber missed
// them. The `latestPartialByAsk` map fixes this — updated on every
// `_push` regardless of consumer state.

describe('AxlEventBus — partialObjects late subscriber after past delivery', () => {
  it('seeds from latestPartialByAsk so events drained by another iterator are still recovered', async () => {
    const bus = new AxlEventBus();

    // First consumer drains the bus so partial_object events leave
    // `eventQueue` (they're shifted into a resolver and then a
    // Promise). Run concurrently with the producer.
    const drained: AxlEvent[] = [];
    const drainer = (async () => {
      for await (const e of bus) drained.push(e);
    })();

    // Producer.
    await new Promise((r) => setImmediate(r));
    bus._push(
      ev({
        type: 'partial_object',
        data: { object: { v: 1 } },
        attempt: 1,
        ...ASK,
      }),
    );
    bus._push(
      ev({
        type: 'partial_object',
        data: { object: { v: 2 } },
        attempt: 1,
        ...ASK,
      }),
    );

    // Wait so the drainer pulls both events out of the queue.
    await new Promise((r) => setImmediate(r));
    expect(drained.length).toBe(2);

    // Now subscribe a SECOND consumer to partialObjects. Pre-fix it
    // would walk an empty eventQueue and yield nothing. Post-fix it
    // seeds from `latestPartialByAsk` and yields the latest snapshot.
    const seen: Array<{ object: unknown; attempt: number }> = [];
    const late = (async () => {
      for await (const p of bus.partialObjects) {
        seen.push({ object: p.object, attempt: p.attempt });
        break;
      }
    })();
    await new Promise((r) => setImmediate(r));
    bus._finish();
    await late;
    await drainer;

    expect(seen).toEqual([{ object: { v: 2 }, attempt: 1 }]);
  });

  it('pipeline(failed) clears the latestPartialByAsk entry so late subscriber does not see discarded attempt', async () => {
    const bus = new AxlEventBus();
    bus._push(ev({ type: 'partial_object', data: { object: { v: 1 } }, attempt: 1, ...ASK }));
    bus._push(ev({ type: 'pipeline', status: 'failed', stage: 'schema', ...ASK }));
    bus._finish();
    const seen: Array<{ object: unknown; attempt: number }> = [];
    for await (const p of bus.partialObjects) {
      seen.push({ object: p.object, attempt: p.attempt });
    }
    // Discarded attempt: late subscriber should see nothing.
    expect(seen).toEqual([]);
  });

  it('multiple subscribers each see the latest snapshot independently (map is shared but pending is per-subscriber)', async () => {
    const bus = new AxlEventBus();
    bus._push(ev({ type: 'partial_object', data: { object: { v: 7 } }, attempt: 1, ...ASK }));
    bus._finish();

    const a: unknown[] = [];
    const b: unknown[] = [];
    for await (const p of bus.partialObjects) a.push(p.object);
    for await (const p of bus.partialObjects) b.push(p.object);
    expect(a).toEqual([{ v: 7 }]);
    expect(b).toEqual([{ v: 7 }]);
  });
});

// ─── _push after _finish silently dropped ───
// Documented contract; pin so a future refactor doesn't regress it.

describe('AxlEventBus — _push after _finish', () => {
  it('silently drops events pushed after _finish (no throw, no enqueue)', async () => {
    const bus = new AxlEventBus();
    bus._finish();
    expect(() => bus._push(ev({ type: 'token', data: 'late', ...ASK }))).not.toThrow();
    const seen: AxlEvent[] = [];
    for await (const e of bus) seen.push(e);
    expect(seen).toHaveLength(0);
  });
});

// ─── Multi-iterator FIFO contract ───
// Documented at AxlEventBus class JSDoc: multiple `for await` consumers
// share the FIFO queue (each event is consumed by exactly one).
// Pinned so a refactor doesn't accidentally turn the iterator into a
// broadcast.

describe('AxlEventBus — multi-iterator FIFO contract', () => {
  it('two iterators share the FIFO queue (each event seen by exactly one)', async () => {
    const bus = new AxlEventBus();
    const a: AxlEvent[] = [];
    const b: AxlEvent[] = [];
    const consumeA = (async () => {
      for await (const e of bus) a.push(e);
    })();
    const consumeB = (async () => {
      for await (const e of bus) b.push(e);
    })();
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 4; i++) {
      bus._push(ev({ type: 'token', data: `t${i}`, ...ASK }));
    }
    bus._finish();
    await Promise.all([consumeA, consumeB]);
    // Each event seen exactly once across both consumers.
    expect(a.length + b.length).toBe(4);
    // Neither saw all of them (the iteration is shared FIFO).
    expect(a.length).toBeLessThan(4);
    expect(b.length).toBeLessThan(4);
  });
});

// ─── Unknown event-name warn (regression for commit 54c24ae) ───

describe('AxlEventBus — unknown event-name warn', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns once per bus when on() is called with a name outside AXL_EVENT_TYPES', () => {
    const bus = new AxlEventBus();
    bus.on('agent_call_ended', () => {}); // typo
    bus.on('totally_made_up', () => {}); // also unknown
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/agent_call_ended/);
  });

  it('does NOT warn for valid AxlEventType names', () => {
    const bus = new AxlEventBus();
    bus.on('agent_call_end', () => {});
    bus.on('token', () => {});
    bus.on('workflow_end', () => {});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('off() also warns for unknown names (same one-shot flag)', () => {
    const bus = new AxlEventBus();
    bus.off('typo', () => {});
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
