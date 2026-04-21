import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { AXL_EVENT_TYPES, type AxlEvent, type AxlEventType } from './types.js';

/**
 * A streamable workflow execution.
 *
 * Extends Node's Readable and implements `AsyncIterable<AxlEvent>`. Supports
 * `.on()` events, `for-await-of`, the `.text` iterator (root-only tokens),
 * the `.lifecycle` iterator (structural events only), and `.pipe()`.
 *
 * The wire carries `AxlEvent` directly — there is no per-stream synthesized
 * shape. Consumers narrow on `event.type` and use `AskScoped` fields
 * (`askId`, `parentAskId`, `depth`) for routing/filtering.
 */
export class AxlStream extends Readable {
  private bus = new EventEmitter();
  private tokens: string[] = [];
  private result: unknown = undefined;
  private finished = false;
  readonly promise: Promise<unknown>;
  private eventQueue: AxlEvent[] = [];
  private waiters: Array<(value: IteratorResult<AxlEvent>) => void> = [];

  constructor() {
    super({ objectMode: true, read() {} });

    let resolvePromise: (value: unknown) => void;
    let rejectPromise: (error: Error) => void;
    this.promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    this.bus.on('__resolve', (value: unknown) => resolvePromise!(value));
    this.bus.on('__reject', (error: Error) => rejectPromise!(error));
    // Prevent unhandled 'error' events from crashing the process
    this.bus.on('error', () => {});
    // Prevent unhandled promise rejection when _error() rejects the promise
    // and no consumer has called stream.promise.catch(). Errors are delivered
    // through the promise rejection and the EventEmitter 'error' event.
    this.promise.catch(() => {});
  }

  /** Wire-format event names callers can subscribe to via `.on(name, fn)`.
   *  Derived from the canonical `AXL_EVENT_TYPES` tuple — adding a new
   *  variant in `types.ts` automatically extends the subscribable set. */
  private static readonly STREAM_EVENTS = new Set<AxlEventType>(AXL_EVENT_TYPES);

  on(event: string, handler: (...args: unknown[]) => void): this {
    if (AxlStream.STREAM_EVENTS.has(event as AxlEventType)) {
      this.bus.on(event, handler);
    } else {
      super.on(event, handler);
    }
    return this;
  }

  off(event: string, handler: (...args: unknown[]) => void): this {
    if (AxlStream.STREAM_EVENTS.has(event as AxlEventType)) {
      this.bus.off(event, handler);
    } else {
      super.off(event, handler);
    }
    return this;
  }

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
      [Symbol.asyncDispose]() {
        self.destroy();
        return Promise.resolve();
      },
    };
  }

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
              // Root-only token text by default — consumers wanting nested
              // tokens too should iterate the whole stream and filter on
              // `event.depth >= 1` themselves.
              if (value.type === 'token' && (value.depth ?? 0) === 0) {
                return { value: value.data, done: false };
              }
            }
          },
        };
      },
    };
  }

  /**
   * Iterator over structural lifecycle events only — skips per-token chatter
   * and progressive partial_object emissions. Useful for waterfall UIs and
   * any consumer that wants the "what happened" timeline without per-chunk
   * noise. Renamed from `.steps` in the unified-event-model migration
   * because these are events, not pipeline steps.
   */
  get lifecycle(): AsyncIterable<AxlEvent> {
    const lifecycleTypes = new Set<AxlEventType>([
      'ask_start',
      'ask_end',
      'agent_call_start',
      'agent_call_end',
      'tool_call_start',
      'tool_call_end',
      'tool_approval',
      'tool_denied',
      'handoff',
      'delegate',
      'pipeline',
      'verify',
      'workflow_start',
      'workflow_end',
    ]);
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AxlEvent> {
        const iter = self[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<AxlEvent>> {
            while (true) {
              const { value, done } = await iter.next();
              if (done) return { value: undefined as unknown as AxlEvent, done: true };
              if (lifecycleTypes.has(value.type)) return { value, done: false };
            }
          },
        };
      },
    };
  }

  pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T {
    const shouldEnd = options?.end !== false;
    this.bus.on('token', (event: AxlEvent) => {
      if (event.type === 'token') destination.write(event.data);
    });
    this.bus.on('done', () => {
      if (shouldEnd) destination.end();
    });
    this.bus.on('error', () => {
      if (shouldEnd) destination.end();
    });
    return destination;
  }

  /** Push an event onto the stream. Called by the runtime. */
  _push(event: AxlEvent): void {
    if (this.finished) return;
    // Token accumulation for `fullText`. Root-only by default to preserve the
    // canonical "render this in a chat bubble" use case; nested-ask tokens
    // still flow through the iterator so consumers that want them can filter.
    if (event.type === 'token' && (event.depth ?? 0) === 0) {
      this.tokens.push(event.data);
    }
    this.bus.emit(event.type, event);
    this.push(event);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.eventQueue.push(event);
    }
  }

  /** Signal successful completion. */
  _done(result: unknown, executionId = ''): void {
    if (this.finished) return;
    this.finished = true;
    this.result = result;
    // Synthesize a terminal `done` AxlEvent. The stream itself is the
    // emission source (no WorkflowContext frame to read), so `step` is set
    // to `Number.MAX_SAFE_INTEGER` as a sentinel meaning "after all
    // numbered events" — consumers ordering by step still see `done` last.
    const doneEvent: AxlEvent = {
      type: 'done',
      executionId,
      step: Number.MAX_SAFE_INTEGER,
      timestamp: Date.now(),
      data: { result },
    };
    this.bus.emit('done', doneEvent);
    this.push(doneEvent);
    this.push(null);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: doneEvent, done: false });
    } else {
      this.eventQueue.push(doneEvent);
    }
    for (const w of this.waiters) {
      w({ value: undefined as unknown as AxlEvent, done: true });
    }
    this.waiters.length = 0;
    this.bus.emit('__resolve', result);
  }

  /** Signal an error. */
  _error(error: Error, executionId = ''): void {
    if (this.finished) return;
    this.finished = true;
    const errorEvent: AxlEvent = {
      type: 'error',
      executionId,
      step: Number.MAX_SAFE_INTEGER,
      timestamp: Date.now(),
      data: { message: error.message, name: error.name },
    };
    this.bus.emit('error', errorEvent);
    this.push(errorEvent);
    this.push(null);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: errorEvent, done: false });
    } else {
      this.eventQueue.push(errorEvent);
    }
    for (const w of this.waiters) {
      w({ value: undefined as unknown as AxlEvent, done: true });
    }
    this.waiters.length = 0;
    this.bus.emit('__reject', error);
  }

  /** Concatenated root-only text — what most chat UIs render. */
  get fullText(): string {
    return this.tokens.join('');
  }
}
