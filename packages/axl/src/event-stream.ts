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
  'tool_approval',
  'tool_denied',
  'handoff_start',
  'handoff_return',
  'delegate',
  'pipeline',
  'verify',
  'workflow_start',
  'workflow_end',
  'checkpoint_save',
  'checkpoint_replay',
  'await_human',
  'await_human_resolved',
]);

/** Options shared between `AxlEventBus` (and therefore `AxlStream` and
 *  `ctx.events`). Controls the overflow safety net on the iterator queue. */
export interface EventStreamOptions {
  /** Soft cap on the number of events held in the iterator queue while
   *  waiting for a consumer. Terminal events (`done`, `error`,
   *  `workflow_end`) are exempt and always pass through. Default 10_000.
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

  constructor(options?: EventStreamOptions) {
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
    // Prevent unhandled 'error' events on the inner emitter from crashing
    // the process. AxlStream subclasses re-emit through their Readable
    // 'error' channel for the standard Node stream contract; bus-level
    // 'error' subscribers (if any) get the AxlEvent payload directly.
    this.bus.on('error', () => {});
  }

  /** Subscribe to an `AxlEvent` variant by type. Names outside `AXL_EVENT_TYPES`
   *  are silently dropped — the bus only ever emits those names. Subclasses
   *  may override to fall through to a wider emitter (e.g., `AxlStream`
   *  routes non-`AxlEvent` names like `'close'` to its underlying Readable). */
  on<T extends AxlEventType>(event: T, handler: (e: AxlEventOf<T>) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (event: any) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (event: any) => void): this {
    if (STREAM_EVENTS.has(event as AxlEventType)) {
      this.bus.on(event, handler as (...args: unknown[]) => void);
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
    }
    return this;
  }

  // No explicit return-type annotation: structural inference yields a type
  // assignable to Readable's `() => AsyncIterator<any, undefined, any>` when
  // AxlStream delegates here, while preserving the richer iterator-with-dispose
  // shape for direct AxlEventBus consumers.
  [Symbol.asyncIterator]() {
    const self = this;
    return {
      next: (): Promise<IteratorResult<AxlEvent>> => {
        if (self.eventQueue.length > 0) {
          return Promise.resolve({ value: self.eventQueue.shift()!, done: false });
        }
        if (self.finished && self.eventQueue.length === 0) {
          return Promise.resolve({ value: undefined as unknown as AxlEvent, done: true });
        }
        return new Promise((resolve) => {
          self.waiters.push(resolve);
        });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      [Symbol.asyncDispose]: () => self._disposeIterator(),
    };
  }

  /** Hook for iterator disposal. AxlStream overrides to call `destroy()`
   *  on the underlying Readable. The default implementation is a no-op
   *  because a plain bus has no Node-stream resource to release. */
  protected _disposeIterator(): Promise<void> {
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
  get partialObjects(): AsyncIterable<{
    askId: string;
    agent?: string;
    object: unknown;
    attempt: number;
  }> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        type Coalesced = {
          askId: string;
          agent?: string;
          object: unknown;
          /** The 1-indexed attempt number this snapshot belongs to. Surfaces
           *  schema-retry transitions to the consumer — UIs can flash a
           *  "regenerating" indicator when the value jumps from `attempt: 1`
           *  to `attempt: 2`. Failed attempts are also discarded by the
           *  pipeline-listener below before they can leak across the
           *  retry boundary. */
          attempt: number;
        };
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

        // Snapshot any relevant events ALREADY in the bus's queue at
        // subscription time. Without this, a consumer that calls
        // `for await (const p of bus.partialObjects)` AFTER events have
        // been pushed would see nothing — the listener-based path only
        // catches future emissions. The snapshot is read-only (does not
        // mutate `eventQueue`), so the main iterator can still drain
        // those same events via its own iteration. Coalescing happens
        // here too: if multiple snapshots exist for the same askId, only
        // the last one wins.
        //
        // We replay BOTH partial_object AND pipeline(failed) events from
        // the queue in original emission order so the same
        // attempt-discard semantics apply to historical events as to
        // future ones — without this, a consumer that subscribed after
        // attempt-N's partial AND a subsequent pipeline(failed) would
        // still see the discarded snapshot in its first .next() call.
        //
        // Snapshot + subscribe together is atomic under the JS
        // run-to-completion model: no `_push` can interleave between the
        // synchronous loop below and the `bus.on(...)` call. If a future
        // refactor ever introduces async between them, an event could be
        // missed; pin the invariant if you change the surrounding code.
        for (const event of self.eventQueue) {
          if (event.type === 'partial_object') {
            recordPartial(event);
          } else if (event.type === 'pipeline' && event.status === 'failed') {
            const askId = event.askId ?? '';
            pending.delete(askId);
          }
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
    this.bus.emit(event.type, event);
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
    // the new event anyway and let the queue exceed the cap by one — losing
    // a terminal event would be worse than a brief overrun.
    let droppedIdx = -1;
    for (let i = 0; i < this.eventQueue.length; i++) {
      if (!TERMINAL_TYPES.has(this.eventQueue[i].type)) {
        droppedIdx = i;
        break;
      }
    }
    if (droppedIdx >= 0) {
      this.eventQueue.splice(droppedIdx, 1);
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        // One-shot per bus instance — saturating producers shouldn't spam
        // the console. Subsequent drops are silent.
        console.warn(
          `[axl] AxlEventBus queue exceeded maxQueued=${this.maxQueued}; ` +
            `dropping oldest non-terminal events (consumer is slower than producer). ` +
            `This warning fires once per bus instance.`,
        );
      }
    }
    this.eventQueue.push(event);
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
