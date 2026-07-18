import { EventEmitter } from 'node:events';
import { AXL_EVENT_TYPES, type AxlEvent, type AxlEventOf, type AxlEventType } from './types.js';
import { isRootLevel } from './event-utils.js';

/** Wire-format event names callers can subscribe to via `.on(name, fn)`.
 *  Derived from the canonical `AXL_EVENT_TYPES` tuple — adding a new
 *  variant in `types.ts` automatically extends the subscribable set. */
const STREAM_EVENTS: ReadonlySet<AxlEventType> = new Set<AxlEventType>(AXL_EVENT_TYPES);

/** Structural events surfaced via `.lifecycle`. Excluded:
 *   - token / partial_object: high-volume content chunks
 *   - log / memory_*: caller-emitted observability rows
 *   - guardrail / schema_check / validate: gate events (subset of `pipeline`)
 *   - done / error: terminal markers synthesized by the stream layer; surface via
 *     `.on('done' | 'error', ...)` and `stream.promise` instead.
 *
 *  Categorization is pinned by the exhaustiveness fixture in
 *  `__tests__/stream.test.ts` — adding a new `AxlEventType` forces a
 *  conscious lifecycle/excluded decision.
 */
/** Terminal event types — never dropped on overflow. `done` / `error` are
 *  synthesized by `AxlStream` for stream-level termination. `workflow_end`
 *  is the runtime's terminal marker for a workflow execution; preserving
 *  it ensures consumers always see "the workflow finished" even if the
 *  queue saturated mid-flight. */
const TERMINAL_TYPES: ReadonlySet<AxlEventType> = new Set<AxlEventType>([
  'done',
  'error',
  'workflow_end',
]);

const LIFECYCLE_TYPES: ReadonlySet<AxlEventType> = new Set<AxlEventType>([
  'ask_start',
  'ask_end',
  'agent_call_start',
  'agent_call_end',
  'tool_call_start',
  'tool_call_end',
  'tool_call_rejected',
  'tool_approval',
  'handoff_start',
  'handoff_return',
  'delegate',
  'pipeline',
  'verify',
  'schema_diagnostic',
  'workflow_start',
  'workflow_end',
  'checkpoint_save',
  'checkpoint_replay',
  'await_human',
  'await_human_resolved',
]);

/** Options shared between `AxlEventBus` (and therefore `AxlStream` and
 *  `ctx.events`). Controls the overflow safety net on the main iterator queue
 *  and each listener-based `stringStream()` subscriber queue. */
export interface EventStreamOptions {
  /** Soft cap on the number of events held while waiting for a consumer,
   *  including distinct pending fields in each `stringStream()` subscriber.
   *  Terminal events (`done`, `error`, `workflow_end`) are exempt from the
   *  main iterator cap and always pass through. Default 10_000.
   *
   *  Set to `Infinity` to disable the cap (matches pre-0.x behavior). */
  maxQueued?: number;
  /** Policy when an event arrives and the queue is at `maxQueued`.
   *
   *  - `'drop-oldest-non-terminal'` (default): scan the queue head-to-tail,
   *    splice out the oldest non-terminal event, push the new one. The first
   *    drop per bus instance fires a one-shot `console.warn` so saturating
   *    consumers see the signal without log spam.
   *  - `'throw'`: throw an `EventStreamOverflowError` at the producer call
   *    site. **This will fail the active workflow** — `_push` is called
   *    from `WorkflowContext.emitEvent`, which runs inside `ctx.ask()` /
   *    `runtime.execute()`. The throw unwinds the agent loop and the
   *    `runtime.execute()` (or `runtime.stream()`) promise rejects with
   *    the typed error. Useful in tests or strict environments where
   *    silent drop would mask a problem; not the right default for
   *    production where a slow consumer should degrade gracefully rather
   *    than abort the workflow. Catch with `instanceof
   *    EventStreamOverflowError` to distinguish from other workflow
   *    errors.
   *
   *  `'block'` is intentionally absent: `_push` is synchronous and there's no
   *  producer to suspend. To bound queue growth via backpressure, the
   *  producer side has to model it explicitly (out of scope for v1). */
  onOverflow?: 'drop-oldest-non-terminal' | 'throw';
}

/**
 * The shape yielded by `AxlEventBus.partialObjects` (and `AxlStream.partialObjects`).
 * Coalesced latest-per-`askId` snapshot of a `partial_object` event.
 *
 * `attempt` is the 1-indexed attempt number from the underlying
 * `partial_object` event — pinned in the public type so consumers can
 * conditionally render a "regenerating" indicator when it jumps from 1
 * to 2. Failed attempts are dropped from the view via the
 * `pipeline(failed)` listener before they leak across the retry
 * boundary.
 */
export type CoalescedPartialObject = {
  askId: string;
  agent?: string;
  object: unknown;
  attempt: number;
};

/**
 * The shape yielded by `AxlEventBus.stringStream` (and `AxlStream.stringStream`).
 *
 * A live `string_delta` event carries `delta` (the new chars since this
 * subscriber's previous yield; slow subscribers may coalesce source chunks)
 * and `accumulated` (every char emitted so far for this ask + path,
 * i.e. `delta1 + delta2 + ...`). Consumers rendering full-field state set
 * their UI text to `accumulated`; consumers rendering incrementally use
 * `delta` and append themselves.
 *
 * For LATE SUBSCRIBERS — those who attach `stringStream(...)` after one or
 * more `string_delta` events have already fired for an askId/path —
 * one synthetic event is yielded at subscribe time with `delta` ===
 * `accumulated` === the full text-so-far. This guarantees the consumer's
 * first render reflects the current state of the field, with no manual
 * catch-up logic.
 *
 * `attempt` matches the underlying `string_delta.attempt` (1-indexed
 * schema-retry counter). `pipeline(failed)` drops the accumulator AND
 * any pending events for that ask before they reach the consumer, so a
 * UI subscribed during attempt-N never sees stale text after attempt-N+1
 * begins.
 */
export type StringStreamEvent = {
  askId: string;
  agent?: string;
  /** RFC 6901 JSON Pointer; matches the source `string_delta.data.path`. */
  path: string;
  /** Chars added since this subscriber's previous yield. May combine several
   *  source chunks when the subscriber is slow. For seeded events, equals
   *  `accumulated` (the full text-so-far). */
  delta: string;
  /** Concatenation of every delta this ask + path has emitted in the
   *  current attempt. Cleared on `pipeline(failed)` and `ask_end`. */
  accumulated: string;
  /** 1-indexed schema-retry attempt; mirrors the source event. */
  attempt: number;
};

/**
 * Optional filter applied at subscribe time. Filtering happens in the bus's
 * listener so non-matching events neither buffer nor wake the consumer's
 * waiter — cheaper than filtering in the consumer.
 *
 * - `path`: yield only events for this exact JSON Pointer. The walker
 *   produces RFC 6901-encoded paths, so callers binding to a key with
 *   special chars must encode (`a/b` → `/a~1b`).
 * - `askId`: yield only events from this ask. Useful when watching a
 *   specific ask in a fan-out workflow.
 *
 * Both fields are AND-combined when both are set. Omit a field to wildcard.
 */
export type StringStreamFilter = {
  path?: string;
  askId?: string;
};

// `stringStreamFromEvents` lives in its own module
// (`string-stream-from-events.ts`) so a browser SPA importing only the
// helper cannot pull `EventEmitter` from this file's `AxlEventBus`. See
// that module for the implementation.

/**
 * Thrown when an `AxlEventBus` queue exceeds `maxQueued` and `onOverflow`
 * is set to `'throw'`. Surfaced as a typed error so the runtime's emit
 * pipeline can distinguish a legitimate overflow signal (which must
 * propagate to fail the workflow) from a buggy trace-listener exception
 * (which gets swallowed).
 *
 * Consumers using `instanceof` to handle overflow specifically:
 * ```typescript
 * try {
 *   await runtime.execute('wf', input, { events: { onOverflow: 'throw' } });
 * } catch (err) {
 *   if (err instanceof EventStreamOverflowError) {
 *     // overflow — back off, retry, or surface to user
 *   }
 * }
 * ```
 */
export class EventStreamOverflowError extends Error {
  readonly maxQueued: number;
  readonly eventType: string;

  constructor(maxQueued: number, eventType: string) {
    super(
      `AxlEventBus queue exceeded maxQueued=${maxQueued} (event type: ${eventType}). ` +
        `Consumer is too slow or the producer is unbounded. Configure ` +
        `\`maxQueued\`/\`onOverflow\` on the runtime, or set maxQueued: Infinity to disable.`,
    );
    this.name = 'EventStreamOverflowError';
    this.maxQueued = maxQueued;
    this.eventType = eventType;
  }
}

/** 10_000 is ~1 MB at typical event sizes (a few hundred bytes per event,
 *  with the structured-output `partial_object` payloads being the largest
 *  outliers at a few KB). High enough that no normal consumer hits it;
 *  low enough that a runaway producer surfaces the warn before OOM. */
const DEFAULT_MAX_QUEUED = 10_000;
const DEFAULT_OVERFLOW: NonNullable<EventStreamOptions['onOverflow']> = 'drop-oldest-non-terminal';

/**
 * Iterable + EventEmitter event bus carrying `AxlEvent`.
 *
 * Public observation surface for `ctx.events` and the underlying machinery
 * for `AxlStream`. Provides:
 *
 *  - `for await (const e of bus)` — sequential iteration over every pushed event
 *  - `.on('agent_call_end', fn)` / `.off(...)` — EventEmitter style, gated on
 *    `AXL_EVENT_TYPES` so unknown event names cannot be subscribed
 *  - Curated views: `.text` (root-only token chunks), `.lifecycle` (structural
 *    events only), `.textByAsk` (per-ask token chunks)
 *
 * Multiple async iterators on the same bus race for the same FIFO queue —
 * iterating both `bus` and `bus.text` (or `bus.lifecycle` / `bus.textByAsk`)
 * concurrently will see each event at most once because the views pull from
 * the same underlying iterator. For two independent observers, attach
 * `.on(type, handler)` listeners instead — those each receive every event.
 *
 * Multiple `.on()` listeners on the same event type each receive every
 * matching event. Subscriptions to non-`AxlEventType` names are silently
 * dropped (the bus emits no other event names).
 */
export class AxlEventBus implements AsyncIterable<AxlEvent> {
  protected readonly bus = new EventEmitter();
  protected eventQueue: AxlEvent[] = [];
  protected waiters: Array<(value: IteratorResult<AxlEvent>) => void> = [];
  protected finished = false;

  private readonly maxQueued: number;
  private readonly onOverflow: NonNullable<EventStreamOptions['onOverflow']>;
  private overflowWarned = false;
  /** Callbacks fired exactly once when `_finish()` is called. Used by
   *  curated views (e.g., `partialObjects`) that are listener-based and
   *  need a termination signal independent of any synthetic `done` event. */
  private finishCallbacks: Array<() => void> = [];
  /**
   * Latest coalesced partial-object snapshot per `askId`, maintained on
   * every `_push` regardless of consumer state. Seeds the
   * `partialObjects` view's `pending` map at subscription time so a
   * late subscriber recovers the most recent state per ask even if
   * earlier `partial_object` events were already delivered to a prior
   * iterator's waiter (and thus removed from `eventQueue`).
   *
   * The pre-fix snapshot walked `eventQueue` directly — that misses
   * events already drained by past consumers. The map walks past
   * `_push` calls instead, which is the actual definition of "what's
   * the latest partial per ask". `pipeline(status: 'failed')` clears
   * the entry for the affected askId so a discarded attempt can't
   * surface to a future subscriber.
   *
   * Memory bound: O(active asks holding a pending partial). Cleared
   * on `pipeline(failed)` (per ask) and otherwise grows with the
   * number of distinct askIds that emitted at least one partial.
   */
  private latestPartialByAsk = new Map<string, CoalescedPartialObject>();

  /**
   * Per-ask, per-path running accumulator for `string_delta` events,
   * updated on every `_push(string_delta)` regardless of consumer state.
   * Used to seed late `stringStream` subscribers with the current text-
   * so-far per (askId, path) pair, so a UI binding to `/summary` mid-
   * stream renders the field's current state on first event instead of
   * waiting for the next chunk.
   *
   * Cleared per-askId on `pipeline(failed)` (discarded attempt — old
   * deltas must not leak into the next attempt's view) and on `ask_end`
   * (frees memory; stream-event accumulators don't outlive the ask).
   *
   * Memory bound: O(active asks × distinct paths × total chars per
   * field). For typical chat workflows (1 ask, 1-3 streaming string
   * fields) this is a few KB. The clear-on-`ask_end` cap keeps a
   * long-running runtime from accumulating per-ask entries forever
   * (the way `latestPartialByAsk` does — partial snapshots are tiny by
   * comparison so that map's growth is acceptable; string accumulators
   * can be 4 KB+ each, hence the more aggressive cleanup here).
   */
  private stringStreamByAsk = new Map<
    string,
    Map<string, { agent?: string; text: string; attempt: number }>
  >();

  /** Internal fan-out for `stringStream()` subscribers. Kept separate from
   *  the public EventEmitter so strict curated-view overflow is a runtime
   *  signal, not mistaken for (and swallowed as) a buggy user listener. */
  private stringStreamSubscribers = new Set<{
    push: (event: StringStreamEvent) => void;
    reset: (askId: string) => void;
  }>();

  /**
   * Hook fired when an iterator obtained from `[Symbol.asyncIterator]`
   * is `await using`-disposed. Set via the second constructor argument.
   * Used by `AxlStream` to call `Readable.destroy()` on its owning
   * stream so disposing the iterator cascades to the Readable contract.
   * Set once at construction; never reassigned.
   *
   * Replaces the previous `AxlStreamEventBus extends AxlEventBus`
   * subclass — composition over inheritance for what is essentially a
   * single function-pointer hook.
   *
   * @internal
   */
  protected readonly onIteratorDispose?: () => void;

  /**
   * @param options Public stream options (queue cap, overflow policy).
   * @param onIteratorDispose @internal Invoked from `_disposeIterator`
   *   when an iterator obtained from this bus is `await using`-disposed.
   *   Used by `AxlStream` to forward to `Readable.destroy()`.
   */
  constructor(options?: EventStreamOptions, onIteratorDispose?: () => void) {
    const requestedMax = options?.maxQueued ?? DEFAULT_MAX_QUEUED;
    // Validate `maxQueued`. `0` and negative values silently disabled the
    // cap before this check (every push hit `handleOverflow`, which then
    // found no non-terminal to drop in an empty queue and fell through to
    // a regular push). That's a footgun — callers wanting "no cap" should
    // pass `Infinity`. Reject anything below 1.
    if (
      typeof requestedMax !== 'number' ||
      Number.isNaN(requestedMax) ||
      (requestedMax !== Infinity && requestedMax < 1)
    ) {
      throw new Error(
        `EventStreamOptions.maxQueued must be >= 1 or Infinity (got ${String(requestedMax)}). ` +
          `To disable the cap, pass Infinity.`,
      );
    }
    this.maxQueued = requestedMax;
    this.onOverflow = options?.onOverflow ?? DEFAULT_OVERFLOW;
    this.onIteratorDispose = onIteratorDispose;
    // Prevent unhandled 'error' events on the inner emitter from crashing
    // the process. Bus consumers re-emit through their own surface
    // (e.g., `AxlStream`'s Readable 'error' channel for the Node stream
    // contract); bus-level 'error' subscribers (if any) get the AxlEvent
    // payload directly.
    this.bus.on('error', () => {});
  }

  private unknownEventWarned = false;

  /** Subscribe to an `AxlEvent` variant by type. Names outside
   *  `AXL_EVENT_TYPES` are dropped (the bus only emits those names) but
   *  the first such call per bus instance fires a one-shot
   *  `console.warn` so a typo (`'agent_call_ended'`) doesn't silently
   *  vanish. Subclasses (e.g., `AxlStream`) pre-filter via
   *  `knowsEventName` so their own routing for non-`AxlEvent` names
   *  like `'close'` doesn't trip the warn. */
  on<T extends AxlEventType>(event: T, handler: (e: AxlEventOf<T>) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (event: any) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (event: any) => void): this {
    if (STREAM_EVENTS.has(event as AxlEventType)) {
      this.bus.on(event, handler as (...args: unknown[]) => void);
    } else {
      this.warnUnknownEventName('on', event);
    }
    return this;
  }

  off<T extends AxlEventType>(event: T, handler: (e: AxlEventOf<T>) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: (event: any) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: (event: any) => void): this {
    if (STREAM_EVENTS.has(event as AxlEventType)) {
      this.bus.off(event, handler as (...args: unknown[]) => void);
    } else {
      this.warnUnknownEventName('off', event);
    }
    return this;
  }

  /** One-shot warn on subscribe/unsubscribe for an event name outside
   *  `AXL_EVENT_TYPES`. Pre-fix this branch silently dropped, which
   *  meant a typo like `'agent_call_ended'` produced no signal. */
  private warnUnknownEventName(method: 'on' | 'off', event: string): void {
    if (this.unknownEventWarned) return;
    this.unknownEventWarned = true;
    console.warn(
      `[axl] AxlEventBus.${method}('${event}', ...) — '${event}' is not an AxlEventType; ` +
        `subscription dropped. Valid names: ${AXL_EVENT_TYPES.join(', ')}. ` +
        `This warning fires once per bus instance.`,
    );
  }

  // No explicit return-type annotation: structural inference yields a type
  // assignable to Readable's `() => AsyncIterator<any, undefined, any>` when
  // AxlStream delegates here, while preserving the richer iterator-with-dispose
  // shape for direct AxlEventBus consumers.
  [Symbol.asyncIterator]() {
    const self = this;
    // Track only this iterator's parked resolver so `return()` can pull it
    // out of the bus's shared `waiters` array on early `break`. Without
    // this, an early-break consumer's resolver stays in `waiters`, and the
    // next `_push` shifts that dead resolver off and delivers an event to
    // a Promise nobody awaits — that event is lost. Each iterator owns
    // its own slot, so multi-iterator scenarios (one breaks, the other
    // keeps consuming) clean up independently.
    let myResolver: ((value: IteratorResult<AxlEvent>) => void) | null = null;
    return {
      next: (): Promise<IteratorResult<AxlEvent>> => {
        if (self.eventQueue.length > 0) {
          return Promise.resolve({ value: self.eventQueue.shift()!, done: false });
        }
        if (self.finished && self.eventQueue.length === 0) {
          return Promise.resolve({ value: undefined as unknown as AxlEvent, done: true });
        }
        return new Promise((resolve) => {
          // The same resolver goes into both the bus's waiter queue (for
          // `_push` to wake) and our local `myResolver` slot (for
          // `return()` to splice). When `_push` shifts and resolves, we
          // null out via the wrapper below so `return()` later is a no-op.
          const wrapped = (value: IteratorResult<AxlEvent>) => {
            myResolver = null;
            resolve(value);
          };
          myResolver = wrapped;
          self.waiters.push(wrapped);
        });
      },
      return: (): Promise<IteratorResult<AxlEvent>> => {
        // Called by JS when the consumer breaks out of `for await`. Pull
        // our parked resolver out of `waiters` so a subsequent `_push`
        // doesn't deliver to a dead consumer. Resolve with `done: true`
        // so any in-flight `next()` promise settles.
        if (myResolver) {
          const idx = self.waiters.indexOf(myResolver);
          if (idx >= 0) self.waiters.splice(idx, 1);
          const r = myResolver;
          myResolver = null;
          r({ value: undefined as unknown as AxlEvent, done: true });
        }
        return Promise.resolve({ value: undefined as unknown as AxlEvent, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      [Symbol.asyncDispose]: () => self._disposeIterator(),
    };
  }

  /** Hook for iterator disposal. Calls the constructor-supplied
   *  `onIteratorDispose` callback if any. The default behavior is a
   *  no-op when no callback was passed — a plain bus has no
   *  Node-stream resource to release. */
  protected _disposeIterator(): Promise<void> {
    this.onIteratorDispose?.();
    return Promise.resolve();
  }

  /** Iterator over root-only `token` chunks. Skips nested-ask tokens
   *  (consumers wanting nested can iterate the full bus and filter on
   *  `event.depth >= 1`). */
  get text(): AsyncIterable<string> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        const iter = self[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<string>> {
            while (true) {
              const { value, done } = await iter.next();
              if (done) return { value: undefined as unknown as string, done: true };
              if (value.type === 'token' && isRootLevel(value)) {
                return { value: value.data, done: false };
              }
            }
          },
          // Propagate `return()` to the underlying bus iterator so its
          // parked resolver (if any) is spliced out of `waiters`. Without
          // this, breaking out of `for await (const t of bus.text)` would
          // orphan the inner waiter and lose the next event.
          async return(): Promise<IteratorResult<string>> {
            await iter.return?.();
            return { value: undefined as unknown as string, done: true };
          },
        };
      },
    };
  }

  /** Iterator over `{ askId, agent?, text }` for every token across root and
   *  nested asks. Useful for split-pane UIs that render each sub-agent's
   *  output in its own lane. `agent` is undefined when the token was emitted
   *  outside any ask (rare — synthesized test fixtures). */
  get textByAsk(): AsyncIterable<{ askId: string; agent?: string; text: string }> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<{ askId: string; agent?: string; text: string }> {
        const iter = self[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<{ askId: string; agent?: string; text: string }>> {
            while (true) {
              const { value, done } = await iter.next();
              if (done) {
                return {
                  value: undefined as unknown as { askId: string; agent?: string; text: string },
                  done: true,
                };
              }
              if (value.type === 'token') {
                return {
                  value: { askId: value.askId, agent: value.agent, text: value.data },
                  done: false,
                };
              }
            }
          },
          async return(): Promise<IteratorResult<{ askId: string; agent?: string; text: string }>> {
            await iter.return?.();
            return {
              value: undefined as unknown as { askId: string; agent?: string; text: string },
              done: true,
            };
          },
        };
      },
    };
  }

  /**
   * Coalescing iterator over `partial_object` events — yields the latest
   * payload per `askId`. When a newer `partial_object` arrives for an
   * `askId` while the consumer is busy, the older value is silently
   * superseded; the consumer sees only the most recent state per ask on
   * its next `.next()` await.
   *
   * Memory bound: O(active asks holding a pending partial), not O(events).
   * This is what UIs streaming structured output actually want — rendering
   * every intermediate snapshot just to overwrite it ms later is wasted
   * work, and unbounded queueing of intermediate JSON snapshots is the
   * memory-pressure scenario this view is designed to avoid. In practice
   * "active asks" is small (1-10 even for fan-out workflows); a workflow
   * fanning out to 10k concurrent asks each producing partials would
   * accumulate ≈10k pending entries (~1 MB), which is the realistic
   * ceiling for this view.
   *
   * Schema-retry awareness: each yielded value carries the 1-indexed
   * `attempt` field from the underlying `partial_object` event. When a
   * schema check fails and the agent retries, the runtime emits
   * `pipeline(status: 'failed')`; this view drops any undrained pending
   * partial for the affected ask so the consumer never sees stale
   * attempt-N snapshots after attempt-N+1 has begun. Mirrors the
   * per-attempt buffer reset that `AxlStream.fullText` applies to
   * tokens. (Validate-stage and guardrail retries trigger the same
   * reset.)
   *
   * Malformed `partial_object` events (those missing `data.object`) are
   * silently filtered — the variant shape requires the field, so an
   * undefined value is a producer bug rather than a meaningful state.
   *
   * Implementation note: this is a listener-based view (subscribes to the
   * bus's `partial_object` channel via `.on()`), not an iterator-based
   * filter like `.text` / `.lifecycle` / `.textByAsk`. As a result it does
   * NOT race with the main async iterator — running `for await (const e of bus)`
   * concurrently with `for await (const p of bus.partialObjects)` works
   * cleanly (each `partial_object` event fires the listener AND queues for
   * iterators).
   *
   * Termination: yields any pending coalesced values first, then `done: true`
   * once the bus is finished (via `_finish()`).
   */
  get partialObjects(): AsyncIterable<CoalescedPartialObject> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        type Coalesced = CoalescedPartialObject;
        // Latest-per-askId. Map insertion order = first-seen-askId order
        // when the consumer drains. We delete on yield so a slow consumer
        // gets the freshest value at await time.
        const pending = new Map<string, Coalesced>();
        let resolveWaiter: (() => void) | null = null;
        let finished = self.finished;
        let unsubscribed = false;

        const wakeWaiter = () => {
          const r = resolveWaiter;
          resolveWaiter = null;
          r?.();
        };

        // Update `pending` from a partial_object event. Filters malformed
        // events whose `data.object` is undefined — those are producer
        // bugs (the payload is required by the variant shape), and yielding
        // `{object: undefined}` shifts the burden to consumers. Defined
        // falsy values (`null`, `0`, `false`, `''`) are valid JSON and pass
        // through unchanged.
        const recordPartial = (event: Extract<AxlEvent, { type: 'partial_object' }>): void => {
          if (event.data?.object === undefined) return;
          const askId = event.askId ?? '';
          pending.set(askId, {
            askId,
            agent: event.agent,
            object: event.data.object,
            attempt: event.attempt,
          });
        };

        // Seed `pending` from the bus's `latestPartialByAsk` map.
        // Without this, a consumer that subscribes AFTER `partial_object`
        // events have been emitted sees nothing — the listener-based
        // path only catches future emissions, and the `eventQueue`
        // snapshot misses events already drained by past iterators (a
        // common case when an `AxlStream` consumer started iterating
        // before a Studio-style late subscriber connects, or when the
        // workflow handler iterates `ctx.events` while running).
        //
        // The bus updates `latestPartialByAsk` on every `_push` (in the
        // `_push` method below) and clears entries on
        // `pipeline(status: 'failed')`, so the same attempt-discard
        // semantics apply to historical events as to future ones —
        // without this, a consumer subscribing after attempt-N's
        // partial AND a subsequent pipeline(failed) would still see
        // the discarded snapshot.
        //
        // Seeding + subscribe together is atomic under the JS
        // run-to-completion model: no `_push` can interleave between
        // the synchronous loop below and the `bus.on(...)` call.
        for (const [askId, value] of self.latestPartialByAsk) {
          pending.set(askId, value);
        }

        // Listener subscribes directly to the inner bus (bypassing the
        // public `.on` gate so the same wiring works whether or not the
        // consumer attaches their own `.on('partial_object', ...)`).
        const handler = (event: AxlEvent) => {
          if (event.type !== 'partial_object') return;
          recordPartial(event);
          wakeWaiter();
        };
        self.bus.on('partial_object', handler);

        // Drop pending partials on schema retry. Without this, an undrained
        // attempt-N partial sits in `pending` while the producer kicks off
        // attempt-N+1; the next consumer await would surface attempt-N's
        // (now-superseded) snapshot before the new attempt's first partial
        // arrives, causing UI flicker and potential shape pollution
        // (attempt-N might emit malformed-but-mid-parse JSON that attempt-N+1
        // corrects). Mirrors AxlStream.fullText's per-attempt buffer reset
        // on `pipeline(failed)`. We listen on `pipeline` (any stage) and
        // gate on `status === 'failed'` so the same handler fires for
        // schema, validate, and guardrail retries — a consumer rendering
        // a coalesced view never wants stale partials from a discarded
        // attempt regardless of why it was discarded.
        const pipelineHandler = (event: AxlEvent) => {
          if (event.type !== 'pipeline') return;
          if (event.status !== 'failed') return;
          const askId = event.askId ?? '';
          pending.delete(askId);
        };
        self.bus.on('pipeline', pipelineHandler);

        const unsubscribe = () => {
          if (unsubscribed) return;
          unsubscribed = true;
          self.bus.off('partial_object', handler);
          self.bus.off('pipeline', pipelineHandler);
          unsubscribeFinish();
        };

        // On bus finish, eagerly drop the listeners so they can't leak
        // when the consumer obtains the iterator but never drains it. The
        // iterator's `next()` / `return()` paths still call `unsubscribe`
        // for the iteration-driven case; this handles the
        // never-iterated-but-bus-finished case.
        const unsubscribeFinish = self._onFinish(() => {
          finished = true;
          self.bus.off('partial_object', handler);
          self.bus.off('pipeline', pipelineHandler);
          wakeWaiter();
        });

        return {
          async next(): Promise<IteratorResult<Coalesced>> {
            while (true) {
              if (pending.size > 0) {
                // Drain in insertion order — oldest pending askId first.
                const it = pending.entries().next();
                if (!it.done) {
                  const [key, value] = it.value;
                  pending.delete(key);
                  return { value, done: false };
                }
              }
              if (finished) {
                unsubscribe();
                return { value: undefined as unknown as Coalesced, done: true };
              }
              await new Promise<void>((res) => {
                resolveWaiter = res;
              });
            }
          },
          async return(): Promise<IteratorResult<Coalesced>> {
            unsubscribe();
            return { value: undefined as unknown as Coalesced, done: true };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };
  }

  /**
   * Listener-based view over `string_delta` events with optional
   * filtering by `path` and/or `askId`. Yields `StringStreamEvent`s
   * carrying `delta` (the new chars) and `accumulated` (the full text-
   * so-far for that ask + path).
   *
   * Designed for chat-style typewriter rendering of long string fields:
   * a React component binding to `path: '/summary'` sets its text to
   * `event.accumulated` on every yield, getting smooth char-by-char
   * progression with no parser of its own.
   *
   * Late-subscriber seeding: at subscribe time, the bus's per-ask
   * accumulator is walked and one synthetic `StringStreamEvent` is
   * yielded per matching (askId, path) entry, with `delta ===
   * accumulated === <full text-so-far>`. After that, live deltas flow
   * normally. A consumer who attaches mid-ask sees the field's current
   * state on first iteration, then incremental updates.
   *
   * Like `partialObjects`, this view is listener-based — it does NOT
   * race the main async iterator (`for await (const e of bus)`).
   * Running both concurrently each receives every matching event.
   *
   * Schema-retry awareness: on `pipeline(status: 'failed')`, the
   * accumulator and any pending events for the affected ask are
   * dropped, so a consumer iterating during attempt-N never observes
   * stale text after attempt-N+1 begins. Mirrors `partialObjects`'
   * per-attempt reset.
   *
   * Termination: yields any pending events first (live + seeded), then
   * `done: true` once the bus is finished via `_finish()`.
   */
  stringStream(opts?: StringStreamFilter): AsyncIterable<StringStreamEvent> {
    const self = this;
    const filterPath = opts?.path;
    const filterAskId = opts?.askId;
    // Validate the filter at subscribe time. The walker emits RFC 6901
    // JSON Pointers — `/summary`, `/sources/0/title` — which always
    // start with `/`. A common typo is `path: 'summary'` (no leading
    // slash); without this guard it silently never matches and the
    // consumer's UI stays blank. Empty string is RFC 6901's root pointer
    // (the whole document); the walker can't emit a string_delta with
    // path `''` (root is the schema object, not a string), so allowing
    // it would also match nothing — but empty is at least syntactically
    // valid, so we don't reject it. Only reject the genuinely malformed
    // case to keep the validator narrow.
    if (filterPath !== undefined && filterPath !== '' && !filterPath.startsWith('/')) {
      throw new Error(
        `AxlEventBus.stringStream({ path }) — path must start with '/' (RFC 6901 JSON Pointer); got ${JSON.stringify(filterPath)}. ` +
          `Examples: '/summary', '/sources/0/title'.`,
      );
    }
    return {
      [Symbol.asyncIterator]() {
        // Insertion-ordered, coalescing buffer. A slow subscriber retains at
        // most one event per ask/path; its `delta` is every character since
        // that subscriber's previous yield, while `accumulated` is the latest
        // canonical field state. Distinct pending fields are capped by the
        // same EventStreamOptions policy as the main iterator queue.
        const pending = new Map<string, StringStreamEvent>();
        let resolveWaiter: (() => void) | null = null;
        let finished = self.finished;
        let unsubscribed = false;

        const wakeWaiter = () => {
          const r = resolveWaiter;
          resolveWaiter = null;
          r?.();
        };

        const matchesFilter = (askId: string, path: string): boolean => {
          if (filterAskId !== undefined && askId !== filterAskId) return false;
          if (filterPath !== undefined && path !== filterPath) return false;
          return true;
        };

        const pendingKey = (askId: string, path: string): string => JSON.stringify([askId, path]);

        const enqueue = (event: StringStreamEvent): void => {
          const key = pendingKey(event.askId, event.path);
          const existing = pending.get(key);
          if (existing) {
            pending.set(key, {
              ...event,
              delta: existing.delta + event.delta,
            });
            wakeWaiter();
            return;
          }
          if (pending.size >= self.maxQueued) {
            if (self.onOverflow === 'throw') {
              throw new EventStreamOverflowError(self.maxQueued, 'string_delta');
            }
            const oldest = pending.keys().next().value as string | undefined;
            if (oldest !== undefined) pending.delete(oldest);
            self.warnOverflow(
              'dropping oldest pending string field (stringStream subscriber is slower than producer)',
            );
          }
          pending.set(key, event);
          wakeWaiter();
        };

        // Seed: walk the bus accumulator, push synthetic events for
        // every matching (askId, path) entry. Iteration is over the
        // outer `Map<string, Map<string, ...>>` in insertion order — so
        // earlier-started asks come first; within an ask, paths come
        // in the order they first emitted.
        for (const [askId, paths] of self.stringStreamByAsk) {
          for (const [path, acc] of paths) {
            if (!matchesFilter(askId, path)) continue;
            enqueue({
              askId,
              agent: acc.agent,
              path,
              delta: acc.text,
              accumulated: acc.text,
              attempt: acc.attempt,
            });
          }
        }

        const subscriber = {
          push(event: StringStreamEvent): void {
            if (matchesFilter(event.askId, event.path)) enqueue(event);
          },
          reset(askId: string): void {
            for (const [key, event] of pending) {
              if (event.askId === askId) pending.delete(key);
            }
          },
        };
        self.stringStreamSubscribers.add(subscriber);

        const unsubscribe = () => {
          if (unsubscribed) return;
          unsubscribed = true;
          self.stringStreamSubscribers.delete(subscriber);
          unsubscribeFinish();
        };

        const unsubscribeFinish = self._onFinish(() => {
          finished = true;
          self.stringStreamSubscribers.delete(subscriber);
          wakeWaiter();
        });

        return {
          async next(): Promise<IteratorResult<StringStreamEvent>> {
            while (true) {
              if (pending.size > 0) {
                const first = pending.entries().next().value as
                  | [string, StringStreamEvent]
                  | undefined;
                if (first) {
                  pending.delete(first[0]);
                  return { value: first[1], done: false };
                }
              }
              if (finished) {
                unsubscribe();
                return { value: undefined as unknown as StringStreamEvent, done: true };
              }
              await new Promise<void>((res) => {
                resolveWaiter = res;
              });
            }
          },
          async return(): Promise<IteratorResult<StringStreamEvent>> {
            unsubscribe();
            return { value: undefined as unknown as StringStreamEvent, done: true };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };
  }

  /** Iterator over structural lifecycle events only — skips per-token chatter
   *  and progressive `partial_object` emissions. Useful for waterfall UIs
   *  and any consumer that wants the "what happened" timeline. */
  get lifecycle(): AsyncIterable<AxlEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AxlEvent> {
        const iter = self[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<AxlEvent>> {
            while (true) {
              const { value, done } = await iter.next();
              if (done) return { value: undefined as unknown as AxlEvent, done: true };
              if (LIFECYCLE_TYPES.has(value.type)) return { value, done: false };
            }
          },
          async return(): Promise<IteratorResult<AxlEvent>> {
            await iter.return?.();
            return { value: undefined as unknown as AxlEvent, done: true };
          },
        };
      },
    };
  }

  /**
   * Push an event onto the bus. Emits on the typed channel (for `.on()`
   * subscribers) and queues for async iterators. No-op once `_finish()` has
   * been called.
   *
   * Subclasses (AxlStream) override to add token accounting and Readable
   * fan-out before delegating to this implementation.
   *
   * @internal — called by the runtime / WorkflowContext / AxlStream.
   */
  _push(event: AxlEvent): void {
    if (this.finished) return;
    // Update late-subscriber accumulators BEFORE emitting to listeners.
    // Listeners (specifically the `stringStream` view) read from these
    // maps to compute `accumulated` for the event they're about to be
    // notified of, so the maps must reflect post-this-event state when
    // listeners run. Order also ensures bookkeeping survives listener
    // throws (the emit() below is wrapped in try/catch).
    //
    // `partial_object`: write the latest snapshot. `pipeline(failed)`:
    // clear both accumulators for the ask. `ask_end`: free the string
    // accumulator (text can be KB+; partial snapshots are tiny so we
    // don't bother for `latestPartialByAsk`).
    if (event.type === 'partial_object' && event.data?.object !== undefined) {
      const askId = event.askId ?? '';
      this.latestPartialByAsk.set(askId, {
        askId,
        agent: event.agent,
        object: event.data.object,
        attempt: event.attempt,
      });
    } else if (event.type === 'string_delta') {
      const askId = event.askId ?? '';
      let paths = this.stringStreamByAsk.get(askId);
      if (!paths) {
        paths = new Map();
        this.stringStreamByAsk.set(askId, paths);
      }
      const existing = paths.get(event.data.path);
      paths.set(event.data.path, {
        agent: event.agent,
        text: (existing?.text ?? '') + event.data.delta,
        attempt: event.attempt,
      });
      const accumulated = paths.get(event.data.path)!.text;
      for (const subscriber of this.stringStreamSubscribers) {
        subscriber.push({
          askId,
          agent: event.agent,
          path: event.data.path,
          delta: event.data.delta,
          accumulated,
          attempt: event.attempt,
        });
      }
    } else if (event.type === 'pipeline' && event.status === 'failed') {
      const askId = event.askId ?? '';
      this.latestPartialByAsk.delete(askId);
      this.stringStreamByAsk.delete(askId);
      for (const subscriber of this.stringStreamSubscribers) subscriber.reset(askId);
    } else if (event.type === 'ask_end') {
      this.stringStreamByAsk.delete(event.askId ?? '');
    }
    // Isolate listener exceptions from the workflow. Node's EventEmitter
    // propagates listener throws to the caller synchronously, so a single
    // buggy `bus.on('agent_call_end', () => { throw … })` would unwind
    // the active `ctx.ask()` and fail the workflow. Mirror the `onTrace`
    // isolation pattern in `WorkflowContext.emitEvent`: swallow + log via
    // `console.error`, keep the workflow running. The
    // `EventStreamOverflowError` thrown by `handleOverflow` (below) is
    // NOT in this try/catch — that's a different code path and must
    // propagate to fail the workflow as the strict-mode policy promises.
    try {
      this.bus.emit(event.type, event);
    } catch (err) {
      console.error(
        `[axl] AxlEventBus listener for "${event.type}" threw; ignoring:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    // No active waiter — queue. Enforce the soft cap on non-terminal events.
    if (this.eventQueue.length >= this.maxQueued && !TERMINAL_TYPES.has(event.type)) {
      this.handleOverflow(event);
      return;
    }
    this.eventQueue.push(event);
  }

  /** Apply the overflow policy when the queue is at `maxQueued` and a
   *  non-terminal event arrives. Terminal events bypass this path entirely
   *  (checked by the caller). */
  private handleOverflow(event: AxlEvent): void {
    if (this.onOverflow === 'throw') {
      throw new EventStreamOverflowError(this.maxQueued, event.type);
    }
    // 'drop-oldest-non-terminal': scan from head for the oldest non-terminal
    // and splice it out. Terminal events queued earlier (rare in practice
    // but possible) are preserved; if every queued event is terminal, push
    // the new event anyway and let the queue exceed the cap — losing a
    // terminal event would be worse than a brief overrun.
    let droppedIdx = -1;
    for (let i = 0; i < this.eventQueue.length; i++) {
      const candidate = this.eventQueue[i];
      if (!TERMINAL_TYPES.has(candidate.type)) {
        droppedIdx = i;
        break;
      }
    }
    // One-shot per bus instance — saturating producers shouldn't spam the
    // console. Warn even on the all-terminal branch (`droppedIdx === -1`)
    // so the cap-exceeded path is visible: a queue full of terminals is
    // rare but possible (e.g., a producer hammering pre-failure events
    // after termination), and silently growing past the cap there would
    // hide a real problem.
    this.warnOverflow(
      droppedIdx >= 0
        ? 'dropping oldest non-terminal events (consumer is slower than producer)'
        : 'queue contains only protected terminal events; preserving them past the cap',
    );
    if (droppedIdx >= 0) {
      this.eventQueue.splice(droppedIdx, 1);
    }
    this.eventQueue.push(event);
  }

  private warnOverflow(detail: string): void {
    if (this.overflowWarned) return;
    this.overflowWarned = true;
    console.warn(
      `[axl] AxlEventBus queue exceeded maxQueued=${this.maxQueued}; ${detail}. ` +
        'This warning fires once per bus instance.',
    );
  }

  /**
   * Mark the bus as finished. Wakes any pending iterators with `done: true`
   * and drops further `_push` calls. Idempotent.
   *
   * Does not synthesize a terminal `done` AxlEvent — callers (AxlStream) that
   * want one push it via `_push` before calling `_finish`.
   *
   * Late iterators that connect after `_finish()` still drain any events
   * remaining in `eventQueue` (the `next()` short-circuit in
   * `[Symbol.asyncIterator]` checks the queue before checking `finished`),
   * then receive `done: true`.
   *
   * @internal
   */
  _finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const w of this.waiters) {
      w({ value: undefined as unknown as AxlEvent, done: true });
    }
    this.waiters.length = 0;
    // Drain finish callbacks. Snapshot first so the iteration is over a
    // fixed list — callbacks registered DURING this loop go through
    // `_onFinish`'s `finished === true` branch and fire synchronously
    // there, NOT from this loop. (See `_onFinish` below.)
    const callbacks = this.finishCallbacks;
    this.finishCallbacks = [];
    for (const cb of callbacks) {
      try {
        cb();
      } catch (err) {
        console.error('[axl] AxlEventBus finish callback threw:', err);
      }
    }
  }

  /** Register a one-shot callback fired when `_finish()` is called.
   *  Returns an unsubscribe function. If the bus is already finished,
   *  the callback is invoked synchronously and the returned unsubscribe
   *  is a no-op.
   *
   *  Used by listener-based curated views (e.g., `partialObjects`) that
   *  need a termination signal independent of any synthesized `done`
   *  event. Iterator consumers don't need this — `[Symbol.asyncIterator]`
   *  resolves with `done: true` automatically.
   *
   *  @internal */
  _onFinish(cb: () => void): () => void {
    if (this.finished) {
      cb();
      return () => {};
    }
    this.finishCallbacks.push(cb);
    return () => {
      const i = this.finishCallbacks.indexOf(cb);
      if (i >= 0) this.finishCallbacks.splice(i, 1);
    };
  }

  /** Whether `event` is one of the `AxlEventType` names this bus emits.
   *  Subclasses (e.g., `AxlStream`) consult this to route AxlEvent names to
   *  the bus and other names (`'close'`, `'data'`, ...) to a wider emitter. */
  knowsEventName(event: string): boolean {
    return STREAM_EVENTS.has(event as AxlEventType);
  }

  /** Whether `_finish()` has been called. */
  get isFinished(): boolean {
    return this.finished;
  }
}
