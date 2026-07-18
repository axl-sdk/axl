import { Readable } from 'node:stream';
import {
  AxlEventBus,
  type CoalescedPartialObject,
  type EventStreamOptions,
  type StringStreamEvent,
  type StringStreamFilter,
} from './event-stream.js';
import {
  type AxlEvent,
  type AxlEventOf,
  type AxlEventType,
  type ObservationStatus,
} from './types.js';
import { isRootLevel } from './event-utils.js';

/**
 * A streamable workflow execution.
 *
 * Extends Node's `Readable` and implements `AsyncIterable<AxlEvent>` via a
 * composed `AxlEventBus`. Supports `.on()` events, `for-await-of`, the
 * `.text` iterator (root-only tokens), the `.lifecycle` iterator (structural
 * events only), the `.textByAsk` iterator (per-ask token chunks), and `.pipe()`.
 *
 * The wire carries `AxlEvent` directly — there is no per-stream synthesized
 * shape. Consumers narrow on `event.type` and use `AskScoped` fields
 * (`askId`, `parentAskId`, `depth`) for routing/filtering.
 *
 * The underlying `AxlEventBus` is shared with `ctx.events` — both surfaces
 * expose the same iterator/EventEmitter contract over the same `AxlEvent`
 * union. AxlStream layers on top: Readable backpressure shape, terminal
 * `done`/`error` synthesis, `.pipe()`, and per-ask `fullText` token
 * accounting (which is stream-specific because the runtime emits the
 * structured `pipeline` events that drive commit/discard).
 */
export class AxlStream extends Readable implements AsyncIterable<AxlEvent> {
  /** Composed event bus — owns iterator queue, EventEmitter gating, and
   *  curated views (`.text`, `.lifecycle`, `.textByAsk`). Private; the
   *  public surface is via the delegating methods below. */
  private readonly events: AxlEventBus;

  /**
   * Per-ask token buffers split into "in-progress" and "committed" halves
   * so `fullText` only includes tokens from attempts that actually won.
   * Scoping is per-`askId` so concurrent root-level asks
   * (`ctx.parallel`, `ctx.spawn`, `ctx.race`, `ctx.map`) don't interleave
   * each other's tokens — each branch's chunks stay contiguous, and a
   * `pipeline(failed)` on one branch only discards THAT branch's
   * in-progress buffer (previously: shared buffer caused a failure on
   * one branch to discard a peer's in-flight successful tokens).
   * Insertion order in the Maps reflects which ask emitted its first
   * token first, which is what `fullText` joins on.
   *
   * On `pipeline(status: 'committed')` for an ask, that ask's
   * in-progress entry flushes to its committed entry. On
   * `pipeline(status: 'failed')` or `ask_end({ok:false})` for an ask,
   * that ask's in-progress entry is discarded. Spec/16 §4.3.
   *
   * Tokens emitted outside any ask (synthesized test fixtures with no
   * `askId`) fall back to an empty-string sentinel key — preserves the
   * single-buffer behavior for that legacy case.
   */
  private attemptByAsk = new Map<string, string[]>();
  private committedByAsk = new Map<string, string>();
  private result: unknown = undefined;
  readonly promise: Promise<unknown>;
  private resolvePromise!: (value: unknown) => void;
  private rejectPromise!: (error: Error) => void;

  constructor(options?: EventStreamOptions) {
    super({ objectMode: true, read() {} });

    // Inject the iterator-dispose hook so `await using` on a bus
    // iterator cascades to `Readable.destroy()`. Replaces the previous
    // private subclass that only existed to override `_disposeIterator`.
    this.events = new AxlEventBus(options, () => this.destroy());

    this.promise = new Promise((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });

    // Prevent unhandled promise rejection when _error rejects the promise
    // and no consumer has called stream.promise.catch(). Errors are
    // delivered through the promise rejection and the EventEmitter 'error'
    // event.
    this.promise.catch(() => {});
  }

  on<T extends AxlEventType>(event: T, handler: (e: AxlEventOf<T>) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): this {
    if (this.events.knowsEventName(event)) {
      this.events.on(event, handler);
    } else {
      // Fall through to Readable's EventEmitter for stream-level events
      // ('close', 'data', 'end', 'readable', 'error', 'pause', 'resume').
      super.on(event, handler);
    }
    return this;
  }

  off<T extends AxlEventType>(event: T, handler: (e: AxlEventOf<T>) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: (...args: any[]) => void): this {
    if (this.events.knowsEventName(event)) {
      this.events.off(event, handler);
    } else {
      super.off(event, handler);
    }
    return this;
  }

  // Override Readable's [Symbol.asyncIterator] to delegate to the bus.
  // No explicit return type — structural inference keeps it compatible
  // with Readable's own signature while preserving the richer
  // iterator-with-dispose shape for direct consumers.
  [Symbol.asyncIterator]() {
    return this.events[Symbol.asyncIterator]();
  }

  get text(): AsyncIterable<string> {
    return this.events.text;
  }

  get textByAsk(): AsyncIterable<{ askId: string; agent?: string; text: string }> {
    return this.events.textByAsk;
  }

  get lifecycle(): AsyncIterable<AxlEvent> {
    return this.events.lifecycle;
  }

  /** Completeness of this stream's iterator queue. Check after consumption
   *  before treating an unmatched lifecycle event as a producer defect. */
  get observationStatus(): ObservationStatus {
    return this.events.observationStatus;
  }

  /** Coalescing iterator over `partial_object` events — yields the latest
   *  object payload per `askId`. Designed for streaming-structured-output
   *  UIs: when the producer outpaces the consumer, intermediate snapshots
   *  are silently superseded and the next `.next()` await sees only the
   *  most recent state per ask. Listener-based, so does NOT race with the
   *  main `for await (const e of stream)` iterator. See
   *  `AxlEventBus.partialObjects` for full semantics. The yielded
   *  `CoalescedPartialObject` shape is shared with the bus so the two
   *  surfaces can never drift on the `attempt` field. */
  get partialObjects(): AsyncIterable<CoalescedPartialObject> {
    return this.events.partialObjects;
  }

  /** Listener-based view over `string_delta` events, with optional filter
   *  on `path` and/or `askId`. Yields `StringStreamEvent`s carrying the new
   *  `delta` and full text-so-far `accumulated`. Designed for chat-style
   *  typewriter rendering of long string fields — bind a UI component to
   *  one path and set its text to `event.accumulated` per yield.
   *
   *  Late subscribers receive a synthetic event seeded from the bus's
   *  per-ask accumulator (so the field's current state renders on the
   *  first iteration, not after the next char arrives). Doesn't race the
   *  main async iterator. See `AxlEventBus.stringStream` for full
   *  semantics. */
  stringStream(opts?: StringStreamFilter): AsyncIterable<StringStreamEvent> {
    return this.events.stringStream(opts);
  }

  pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T {
    const shouldEnd = options?.end !== false;
    this.events.on('token', (event: AxlEvent) => {
      if (event.type === 'token') destination.write(event.data);
    });
    this.events.on('done', () => {
      if (shouldEnd) destination.end();
    });
    this.events.on('error', () => {
      if (shouldEnd) destination.end();
    });
    return destination;
  }

  /** Push an event onto the stream. Called by the runtime.
   *
   *  Side-effect ordering: `accountForToken` (fullText buffers) →
   *  `events._push` (bus.emit + iterator waiter/queue) → `Readable.push`
   *  (object-mode buffer for `.pipe()` consumers and `'data'` listeners).
   *  Pre-refactor the order was `bus.emit → Readable.push → waiter/queue`;
   *  the new order resolves async iterators before Readable.push. The
   *  difference is invisible to all in-tree consumers — `.pipe()` here
   *  routes through the bus's `'token'` listener (line 129), and existing
   *  tests pass — but it's intentional rather than accidental. */
  _push(event: AxlEvent): void {
    if (this.events.isFinished) return;
    this.accountForToken(event);
    this.events._push(event);
    this.push(event);
  }

  /** Token accumulation and pipeline commit/discard accounting for
   *  `fullText`. Extracted from `_push` so the bus delegation reads cleanly. */
  private accountForToken(event: AxlEvent): void {
    // Token accumulation for `fullText`. Root-only by default to preserve the
    // canonical "render this in a chat bubble" use case; nested-ask tokens
    // still flow through the iterator so consumers that want them can filter.
    // Scoped by askId so concurrent root asks don't interleave.
    if (event.type === 'token' && isRootLevel(event)) {
      const key = event.askId ?? '';
      const attempt = this.attemptByAsk.get(key);
      if (attempt) {
        attempt.push(event.data);
      } else {
        this.attemptByAsk.set(key, [event.data]);
      }
      return;
    }
    // Pipeline lifecycle: commit on success, discard on failure. Spec §4.3.
    // Reading `fullText` between `committed` and `done` sees the correct
    // text — that's why we commit on `committed` (which fires before
    // `done`) rather than on `done`. Per-ask scoping ensures a failed
    // attempt on one branch doesn't discard a sibling branch's tokens.
    if (event.type === 'pipeline' && isRootLevel(event)) {
      const key = event.askId ?? '';
      if (event.status === 'committed') {
        const attempt = this.attemptByAsk.get(key);
        if (attempt && attempt.length > 0) {
          const prev = this.committedByAsk.get(key) ?? '';
          this.committedByAsk.set(key, prev + attempt.join(''));
          this.attemptByAsk.set(key, []);
        }
      } else if (event.status === 'failed') {
        this.attemptByAsk.set(key, []);
      }
      return;
    }
    // Terminal-throw safety net: `ctx.ask()` exit paths that throw
    // (max-turns, guardrail exhaustion, verify-throw, validate-throw) do
    // NOT emit `pipeline(failed)` — they emit `ask_end({ok:false})` and
    // propagate the error. Without this reset, the failed ask's
    // in-progress tokens would stay buffered and flush into the NEXT
    // ask's `pipeline(committed)`, corrupting `fullText`. Reviewer bug
    // B2. Only applies to root asks; nested asks don't enter the
    // per-ask buffer (they're filtered out by `isRootLevel` on the
    // token-accumulation path above). Per-ask scoping means a failure
    // on one root branch only clears its own buffer.
    if (event.type === 'ask_end' && isRootLevel(event) && !event.outcome.ok) {
      this.attemptByAsk.set(event.askId ?? '', []);
    }
  }

  /**
   * Signal successful completion.
   *
   * `executionId` is required — the runtime must allocate it before
   * calling `stream()` so terminal events always carry a real id.
   * Previously the default-empty parameter surfaced blank executionIds
   * on error paths that threw before `execInfo` was assigned (review S4).
   */
  _done(result: unknown, executionId: string): void {
    if (this.events.isFinished) return;
    this.result = result;
    // Synthesize a terminal `done` AxlEvent. The stream itself is the
    // emission source (no WorkflowContext frame to read), so `step` is set
    // to `Number.MAX_SAFE_INTEGER` as a sentinel meaning "after all
    // numbered events" — consumers ordering by step still see `done` last.
    const doneEvent: AxlEvent = {
      schemaVersion: 2,
      type: 'done',
      executionId,
      step: Number.MAX_SAFE_INTEGER,
      timestamp: Date.now(),
      data: { result },
    };
    this.events._push(doneEvent);
    this.push(doneEvent);
    this.push(null);
    this.events._finish();
    this.resolvePromise(result);
  }

  /** Signal an error. `executionId` is required for the same reason as
   *  `_done`: terminal events must carry a real id even when the
   *  failure happens before any real trace event fires (review S4). */
  _error(error: Error, executionId: string): void {
    if (this.events.isFinished) return;
    const errorEvent: AxlEvent = {
      schemaVersion: 2,
      type: 'error',
      executionId,
      step: Number.MAX_SAFE_INTEGER,
      timestamp: Date.now(),
      data: { message: error.message, name: error.name },
    };
    this.events._push(errorEvent);
    this.push(errorEvent);
    this.push(null);
    this.events._finish();
    this.rejectPromise(error);
  }

  /** Concatenated root-only text from committed attempts plus the
   *  current in-flight attempt(s). Retried (gate-rejected) attempts
   *  are excluded — see spec/16 §4.3. Reading mid-attempt returns the
   *  in-progress text; reading after `pipeline(committed)` (which
   *  fires before `done`) returns the canonical winning text.
   *
   *  With concurrent root-level asks (`ctx.parallel`, `ctx.spawn`,
   *  `ctx.race`, `ctx.map`), each branch's tokens are scoped per-`askId`
   *  and emitted contiguously in the order each ask first started
   *  emitting tokens. A `pipeline(failed)` or `ask_end({ok:false})` on
   *  one branch only discards THAT branch's in-progress buffer —
   *  sibling branches are unaffected. For UIs that want each sub-agent
   *  in its own lane, prefer `textByAsk`. */
  get fullText(): string {
    let out = '';
    // Iterate in insertion order. Map preserves it so `fullText` is
    // deterministic given the same emission order.
    for (const [key, committed] of this.committedByAsk) {
      out += committed;
      const attempt = this.attemptByAsk.get(key);
      if (attempt && attempt.length > 0) out += attempt.join('');
    }
    // Asks that have emitted tokens but never committed (still in-flight,
    // or failed) — append their in-progress buffers in insertion order
    // after all committed text.
    for (const [key, attempt] of this.attemptByAsk) {
      if (this.committedByAsk.has(key)) continue;
      if (attempt.length > 0) out += attempt.join('');
    }
    return out;
  }
}
