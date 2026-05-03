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

  constructor() {
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
    } else {
      this.eventQueue.push(event);
    }
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
