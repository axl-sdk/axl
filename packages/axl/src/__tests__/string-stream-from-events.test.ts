/**
 * Tests for `stringStreamFromEvents` — the browser-safe reconstructor
 * for raw `AxlEvent` streams arriving over the wire (WS / SSE).
 *
 * Behaviour must match `AxlEventBus.stringStream` for the same event
 * sequence (modulo late-subscriber seeding, which the wire helper
 * cannot do because it has no shared accumulator). These tests focus on
 * the parts that ARE comparable: filter, retry-clear, ask_end-clear,
 * path encoding pass-through, accumulator correctness across multiple
 * paths and asks.
 */
import { describe, it, expect } from 'vitest';
import { stringStreamFromEvents } from '../event-stream.js';
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

/** Wrap a sync array in an async iterable, mirroring the WS-firehose shape. */
async function* fromArray(events: AxlEvent[]): AsyncIterable<AxlEvent> {
  for (const e of events) yield e;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('stringStreamFromEvents (wire-side reconstructor)', () => {
  it('yields running accumulated text per delta', async () => {
    const events = [
      delta(ASK, '/summary', 'Hello'),
      delta(ASK, '/summary', ' world'),
      delta(ASK, '/summary', '!'),
    ];
    const out = await collect(stringStreamFromEvents(fromArray(events)));
    expect(out.map((e) => ({ delta: e.delta, accumulated: e.accumulated }))).toEqual([
      { delta: 'Hello', accumulated: 'Hello' },
      { delta: ' world', accumulated: 'Hello world' },
      { delta: '!', accumulated: 'Hello world!' },
    ]);
  });

  it('filters by path while still accumulating non-matching paths internally', async () => {
    const events = [
      delta(ASK, '/notes', 'noise'),
      delta(ASK, '/summary', 'A'),
      delta(ASK, '/summary', 'B'),
    ];
    const out = await collect(stringStreamFromEvents(fromArray(events), { path: '/summary' }));
    expect(out.map((e) => `${e.path}=${e.delta}`)).toEqual(['/summary=A', '/summary=B']);
    expect(out[out.length - 1].accumulated).toBe('AB');
  });

  it('filters by askId', async () => {
    const events = [delta(ASK, '/x', 'a'), delta(ASK2, '/x', 'b'), delta(ASK, '/x', 'c')];
    const out = await collect(stringStreamFromEvents(fromArray(events), { askId: ASK }));
    expect(out.map((e) => e.askId + '=' + e.delta)).toEqual([ASK + '=a', ASK + '=c']);
  });

  it('isolates concurrent asks (each accumulates independently)', async () => {
    const events = [
      delta(ASK, '/x', 'A1'),
      delta(ASK2, '/x', 'B1'),
      delta(ASK, '/x', 'A2'),
      delta(ASK2, '/x', 'B2'),
    ];
    const out = await collect(stringStreamFromEvents(fromArray(events)));
    expect(out.map((e) => ({ askId: e.askId, accumulated: e.accumulated }))).toEqual([
      { askId: ASK, accumulated: 'A1' },
      { askId: ASK2, accumulated: 'B1' },
      { askId: ASK, accumulated: 'A1A2' },
      { askId: ASK2, accumulated: 'B1B2' },
    ]);
  });

  it('clears accumulator on pipeline(failed) — attempt 2 starts fresh', async () => {
    const events = [
      delta(ASK, '/x', 'attempt1', 1),
      delta(ASK, '/x', '-bad', 1),
      pipelineFailed(ASK),
      delta(ASK, '/x', 'attempt2', 2),
    ];
    const out = await collect(stringStreamFromEvents(fromArray(events)));
    // 3 attempt-1 deltas yield, then attempt-2 yields 'attempt2'.
    expect(out.map((e) => `${e.delta}@${e.attempt}=${e.accumulated}`)).toEqual([
      'attempt1@1=attempt1',
      '-bad@1=attempt1-bad',
      'attempt2@2=attempt2', // accumulator was cleared on pipeline.failed
    ]);
  });

  it('clears accumulator on ask_end (so a later same-askId stream restarts)', async () => {
    // Same askId reused across two asks (rare but defensible) — accumulator
    // should not leak across the boundary.
    const events = [delta(ASK, '/x', 'first'), askEnd(ASK), delta(ASK, '/x', 'second')];
    const out = await collect(stringStreamFromEvents(fromArray(events)));
    expect(out.map((e) => e.accumulated)).toEqual(['first', 'second']);
  });

  it('preserves agent name on each yielded event', async () => {
    const events = [delta(ASK, '/x', 'hi')];
    const out = await collect(stringStreamFromEvents(fromArray(events)));
    expect(out[0].agent).toBe('a');
  });

  it('ignores events that are not string_delta / pipeline / ask_end', async () => {
    const tokenEvent = {
      type: 'token',
      askId: ASK,
      depth: 0,
      data: 'tok',
    } as unknown as AxlEvent;
    const events = [tokenEvent, delta(ASK, '/x', 'a'), tokenEvent, delta(ASK, '/x', 'b')];
    const out = await collect(stringStreamFromEvents(fromArray(events)));
    expect(out.map((e) => e.delta)).toEqual(['a', 'b']);
    expect(out[out.length - 1].accumulated).toBe('ab');
  });

  it('produces RFC 6901 paths verbatim from the wire (no re-encoding)', async () => {
    // Walker on the server has already encoded the path. Wire helper
    // must NOT touch the path — it just passes through.
    const events = [delta(ASK, '/a~1b~0c', 'value')];
    const out = await collect(stringStreamFromEvents(fromArray(events)));
    expect(out[0].path).toBe('/a~1b~0c');
  });

  it('emits zero events for an empty source', async () => {
    const out = await collect(stringStreamFromEvents(fromArray([])));
    expect(out).toEqual([]);
  });

  it('attempt-2 accumulated text starts fresh after pipeline.failed (typewriter UX)', async () => {
    // Documents the customer-facing behaviour: a UI re-rendering
    // `event.accumulated` correctly resets on retry without explicit
    // pipeline-event handling. The accumulator clear means the first
    // attempt-2 event has `accumulated === delta`, so a re-render
    // overwrites the attempt-1 text in place.
    const events = [
      delta(ASK, '/summary', 'Wrong attempt one', 1),
      pipelineFailed(ASK),
      delta(ASK, '/summary', 'Right ', 2),
      delta(ASK, '/summary', 'attempt two', 2),
    ];
    const out = await collect(stringStreamFromEvents(fromArray(events)));
    expect(out.map((e) => ({ accumulated: e.accumulated, attempt: e.attempt }))).toEqual([
      { accumulated: 'Wrong attempt one', attempt: 1 },
      { accumulated: 'Right ', attempt: 2 }, // accumulator was cleared
      { accumulated: 'Right attempt two', attempt: 2 },
    ]);
  });

  it('semantic note: wire helper does NOT retroactively drop yielded events on pipeline.failed', async () => {
    // Unlike the bus-side `stringStream` view (which splices pending
    // events out on pipeline.failed for buffered consumers), the wire
    // helper has no buffer — events are yielded as they arrive. Once
    // an attempt-1 delta has been yielded to the consumer, it stays
    // yielded. Customers re-render `event.accumulated` per yield, so
    // attempt-2's first event (with cleared accumulator) overwrites
    // attempt-1's text in the UI without needing explicit retry
    // handling. This test pins the contract.
    const events = [delta(ASK, '/x', 'attempt-one-bad'), pipelineFailed(ASK)];
    const out = await collect(stringStreamFromEvents(fromArray(events)));
    // The attempt-1 event WAS yielded.
    expect(out.length).toBe(1);
    expect(out[0].delta).toBe('attempt-one-bad');
  });
});
