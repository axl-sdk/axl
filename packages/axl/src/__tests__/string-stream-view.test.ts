/**
 * Tests for `AxlEventBus.stringStream(opts?)` and the `AxlStream`
 * mirror — the listener-based view over `string_delta` events.
 *
 * These tests exercise the bus directly with synthetic events (no
 * MockProvider, no walker) to pin the view's filter / seed / retry
 * semantics independently of the upstream emission path. End-to-end
 * coverage with the walker lives in `string-delta.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { AxlEventBus } from '../event-stream.js';
import type { AxlEvent } from '../types.js';

const ASK = 'ask-1';
const ASK2 = 'ask-2';

function delta(askId: string, path: string, delta: string, attempt = 1): AxlEvent {
  return {
    type: 'string_delta',
    askId,
    depth: 0,
    agent: 'a',
    attempt,
    data: { path, delta },
  } as unknown as AxlEvent;
}

function pipelineFailed(askId: string): AxlEvent {
  return {
    type: 'pipeline',
    status: 'failed',
    stage: 'schema',
    attempt: 1,
    maxAttempts: 2,
    askId,
    depth: 0,
    reason: 'test',
  } as unknown as AxlEvent;
}

function askEnd(askId: string): AxlEvent {
  return {
    type: 'ask_end',
    askId,
    depth: 0,
    outcome: { ok: true, result: null },
    cost: 0,
    duration: 0,
  } as unknown as AxlEvent;
}

/**
 * Subscribe + drive helper: starts consumption asynchronously so the
 * iterator's `[Symbol.asyncIterator]()` (which attaches the listener)
 * runs BEFORE the driver pushes events. Without this, push-then-iterate
 * tests only see seeded events from the bus accumulator, missing live
 * listener fires.
 */
async function consumeWhileDriving<T>(iter: AsyncIterable<T>, drive: () => void): Promise<T[]> {
  const out: T[] = [];
  const consumer = (async () => {
    for await (const e of iter) out.push(e);
  })();
  // The async body above ran synchronously up to the first `await it.next()`,
  // so the listener is now attached. Drive can fire events safely.
  drive();
  await consumer;
  return out;
}

describe('AxlEventBus.stringStream', () => {
  it('yields live deltas with running `accumulated`', async () => {
    const bus = new AxlEventBus();
    const events = await consumeWhileDriving(bus.stringStream(), () => {
      bus._push(delta(ASK, '/summary', 'Hello'));
      bus._push(delta(ASK, '/summary', ' world'));
      bus._push(delta(ASK, '/summary', '!'));
      bus._finish();
    });

    expect(events.map((e) => ({ delta: e.delta, accumulated: e.accumulated }))).toEqual([
      { delta: 'Hello', accumulated: 'Hello' },
      { delta: ' world', accumulated: 'Hello world' },
      { delta: '!', accumulated: 'Hello world!' },
    ]);
  });

  it('filters by path', async () => {
    const bus = new AxlEventBus();
    const events = await consumeWhileDriving(bus.stringStream({ path: '/summary' }), () => {
      bus._push(delta(ASK, '/summary', 'A'));
      bus._push(delta(ASK, '/notes', 'B'));
      bus._push(delta(ASK, '/summary', 'C'));
      bus._finish();
    });
    expect(events.map((e) => e.path + '=' + e.delta)).toEqual(['/summary=A', '/summary=C']);
  });

  it('filters by askId', async () => {
    const bus = new AxlEventBus();
    const events = await consumeWhileDriving(bus.stringStream({ askId: ASK }), () => {
      bus._push(delta(ASK, '/x', 'a'));
      bus._push(delta(ASK2, '/x', 'b'));
      bus._push(delta(ASK, '/x', 'c'));
      bus._finish();
    });
    expect(events.map((e) => e.askId + '=' + e.delta)).toEqual([ASK + '=a', ASK + '=c']);
  });

  it('filters by both path and askId', async () => {
    const bus = new AxlEventBus();
    const events = await consumeWhileDriving(bus.stringStream({ askId: ASK, path: '/p' }), () => {
      bus._push(delta(ASK, '/p', '1'));
      bus._push(delta(ASK, '/q', '2'));
      bus._push(delta(ASK2, '/p', '3'));
      bus._finish();
    });
    expect(events.map((e) => e.delta)).toEqual(['1']);
  });

  it('seeds late subscribers with current accumulated text', async () => {
    const bus = new AxlEventBus();
    // Pre-subscribe deltas — accumulator builds up before the iterator
    // attaches its listener.
    bus._push(delta(ASK, '/summary', 'Hello'));
    bus._push(delta(ASK, '/summary', ' world'));

    // Subscribe via consumeWhileDriving — `[Symbol.asyncIterator]()`
    // runs synchronously (seeds from accumulator: 'Hello world'),
    // listener attaches, then driver fires the live `!`.
    const events = await consumeWhileDriving(bus.stringStream({ path: '/summary' }), () => {
      bus._push(delta(ASK, '/summary', '!'));
      bus._finish();
    });

    expect(events.map((e) => ({ delta: e.delta, accumulated: e.accumulated }))).toEqual([
      // Synthetic seed.
      { delta: 'Hello world', accumulated: 'Hello world' },
      // Live delta.
      { delta: '!', accumulated: 'Hello world!' },
    ]);
  });

  it('seeds across multiple paths in insertion order', async () => {
    const bus = new AxlEventBus();
    bus._push(delta(ASK, '/a', 'X'));
    bus._push(delta(ASK, '/b', 'Y'));

    const iter = bus.stringStream();
    bus._finish();

    const out: string[] = [];
    for await (const e of iter) out.push(e.path + '=' + e.delta);
    // Insertion order: /a was first.
    expect(out).toEqual(['/a=X', '/b=Y']);
  });

  it('clears accumulator on pipeline(failed) — late subscriber after retry sees fresh state', async () => {
    const bus = new AxlEventBus();
    bus._push(delta(ASK, '/x', 'attempt1', 1));
    bus._push(delta(ASK, '/x', '-bad', 1));
    bus._push(pipelineFailed(ASK));
    bus._push(delta(ASK, '/x', 'attempt2', 2));

    // Subscribe after retry. Should NOT see attempt-1 text.
    const iter = bus.stringStream({ path: '/x' });
    bus._finish();

    const events: Array<{ delta: string; accumulated: string; attempt: number }> = [];
    for await (const e of iter)
      events.push({ delta: e.delta, accumulated: e.accumulated, attempt: e.attempt });

    expect(events).toEqual([{ delta: 'attempt2', accumulated: 'attempt2', attempt: 2 }]);
  });

  it('drops pending events on pipeline(failed) for ongoing subscribers', async () => {
    const bus = new AxlEventBus();
    // Drive synchronously: the EventEmitter dispatches listeners
    // synchronously, so all events land in `pending` before the
    // consumer's first `await next()` resumes. pipeline(failed) in
    // the middle of the burst splices out the prior delta.
    const events = await consumeWhileDriving(bus.stringStream({ path: '/x' }), () => {
      bus._push(delta(ASK, '/x', 'bad'));
      bus._push(pipelineFailed(ASK));
      bus._push(delta(ASK, '/x', 'good', 2));
      bus._finish();
    });
    // 'bad' was dropped on pipeline(failed). Only attempt-2 'good' yields.
    expect(events.map((e) => e.delta + '@' + e.attempt)).toEqual(['good@2']);
  });

  it('clears accumulator for BOTH asks on multi-ask termination (abort regression guard)', async () => {
    // Researcher gap: signal.abort() + Promise.all([ctx.ask, ctx.ask])
    // must clean up `stringStreamByAsk` for every concurrent ask. Both
    // asks emit `ask_end` via finally on abort; the bus deletes their
    // accumulator entries; a fresh subscriber after termination sees
    // nothing seeded. If a future refactor accidentally moved the
    // ask_end clear into a path that didn't fire on abort, this test
    // would catch the leak via the seed mechanism.
    const bus = new AxlEventBus();
    bus._push(delta('A1', '/x', 'A1-text'));
    bus._push(delta('A2', '/x', 'A2-text'));
    bus._push(delta('A1', '/x', '-more'));
    // Both asks abort: both `ask_end` events emit via finally.
    bus._push(askEnd('A1'));
    bus._push(askEnd('A2'));

    // A fresh subscriber AFTER both asks ended sees no seeded events —
    // both accumulator entries were cleared. If either ask_end had been
    // skipped, the subscriber would see a synthetic seed for that askId.
    const iter = bus.stringStream();
    bus._finish();
    const out: Array<{ askId: string }> = [];
    for await (const e of iter) out.push({ askId: e.askId });
    expect(out).toEqual([]);
  });

  it('clears accumulator on ask_end (memory hygiene)', async () => {
    const bus = new AxlEventBus();
    bus._push(delta(ASK, '/x', 'done text'));
    bus._push(askEnd(ASK));

    // Subscribe after ask_end — accumulator should already be cleared.
    const iter = bus.stringStream();
    bus._finish();

    const out: string[] = [];
    for await (const e of iter) out.push(e.delta);
    expect(out).toEqual([]);
  });

  it('does NOT race the main async iterator (both see every event)', async () => {
    const bus = new AxlEventBus();

    const allEvents: AxlEvent[] = [];
    const stringEvents: string[] = [];

    // Run both consumers concurrently. Each must observe its own copy
    // of the events — listener-based views don't pull from the FIFO
    // queue, so they coexist with the main iterator.
    await Promise.all([
      (async () => {
        for await (const e of bus) {
          allEvents.push(e);
          if (allEvents.length >= 4) break;
        }
      })(),
      (async () => {
        for await (const e of bus.stringStream()) {
          stringEvents.push(e.delta);
          if (stringEvents.length >= 2) break;
        }
      })(),
      (async () => {
        // Driver: emit while consumers iterate.
        bus._push(delta(ASK, '/x', 'A'));
        bus._push(delta(ASK, '/x', 'B'));
        bus._push({
          type: 'token',
          askId: ASK,
          depth: 0,
          data: 'tok',
        } as unknown as AxlEvent);
        bus._push(askEnd(ASK));
      })(),
    ]);

    expect(stringEvents).toEqual(['A', 'B']);
    expect(allEvents.map((e) => e.type)).toEqual([
      'string_delta',
      'string_delta',
      'token',
      'ask_end',
    ]);
  });

  it('agent is preserved on seeded events', async () => {
    const bus = new AxlEventBus();
    bus._push(delta(ASK, '/x', 'hi'));

    const iter = bus.stringStream();
    bus._finish();

    const events: Array<{ agent?: string }> = [];
    for await (const e of iter) events.push({ agent: e.agent });
    expect(events[0].agent).toBe('a');
  });

  it('two concurrent asks have isolated accumulators', async () => {
    const bus = new AxlEventBus();
    const events = await consumeWhileDriving(bus.stringStream({ path: '/x' }), () => {
      bus._push(delta(ASK, '/x', 'A1'));
      bus._push(delta(ASK2, '/x', 'B1'));
      bus._push(delta(ASK, '/x', 'A2'));
      bus._push(delta(ASK2, '/x', 'B2'));
      bus._finish();
    });
    expect(events.map((e) => ({ askId: e.askId, accumulated: e.accumulated }))).toEqual([
      { askId: ASK, accumulated: 'A1' },
      { askId: ASK2, accumulated: 'B1' },
      { askId: ASK, accumulated: 'A1A2' },
      { askId: ASK2, accumulated: 'B1B2' },
    ]);
  });

  it('rejects malformed path (no leading slash) with a clear error', () => {
    // Defensive validation — without this, `path: 'summary'` silently
    // never matches and the consumer's UI stays blank with no signal.
    const bus = new AxlEventBus();
    expect(() => bus.stringStream({ path: 'summary' })).toThrow(/must start with/);
    expect(() => bus.stringStream({ path: 'no-slash' })).toThrow(/JSON Pointer/);
    // Valid paths and undefined path still work.
    expect(() => bus.stringStream({ path: '/summary' })).not.toThrow();
    expect(() => bus.stringStream({ path: '' })).not.toThrow(); // RFC 6901 root (matches nothing in practice but syntactically valid)
    expect(() => bus.stringStream()).not.toThrow();
    expect(() => bus.stringStream({ askId: 'x' })).not.toThrow();
  });

  it('terminates with done:true after _finish() with no events', async () => {
    const bus = new AxlEventBus();
    bus._finish();

    const iter = bus.stringStream();
    const result = await iter[Symbol.asyncIterator]().next();
    expect(result.done).toBe(true);
  });

  it('iterator return() lets bus push string_deltas without buffering them in the disposed iterator', async () => {
    // Smoke test for listener cleanup: after `iter.return()`, push more
    // events and confirm we don't keep accumulating in the now-defunct
    // iterator's `pending`. We don't have public listener-count introspection,
    // so we verify behavior: a fresh subscriber AFTER return sees only
    // post-return events (modulo seed).
    const bus = new AxlEventBus();
    const iter = bus.stringStream();
    const it = iter[Symbol.asyncIterator]();

    bus._push(delta(ASK, '/x', 'a'));
    const first = await it.next();
    expect(first.done).toBe(false);
    expect((first.value as { delta: string }).delta).toBe('a');

    await it.return?.();
    bus._push(delta(ASK, '/x', 'b'));
    bus._finish();

    // Drain a fresh subscriber. It should see the seeded full text 'ab'
    // — accumulator was updated even after the disposed iterator returned.
    const iter2 = bus.stringStream();
    const out: string[] = [];
    for await (const e of iter2) out.push(e.accumulated);
    expect(out).toEqual(['ab']);
  });
});
