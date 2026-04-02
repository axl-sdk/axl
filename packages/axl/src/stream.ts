import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { StreamEvent } from './types.js';

/**
 * A streamable workflow execution.
 *
 * Extends Node's Readable and implements AsyncIterable<StreamEvent>.
 * Supports .on() events, for-await-of, .text iterator, and .pipe().
 */
export class AxlStream extends Readable {
  private bus = new EventEmitter();
  private tokens: string[] = [];
  private result: unknown = undefined;
  private finished = false;
  readonly promise: Promise<unknown>;
  private eventQueue: StreamEvent[] = [];
  private waiters: Array<(value: IteratorResult<StreamEvent>) => void> = [];

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

  private static readonly STREAM_EVENTS = new Set([
    'token',
    'tool_call',
    'tool_result',
    'tool_approval',
    'agent_start',
    'agent_end',
    'handoff',
    'step',
    'done',
    'error',
  ]);

  on(event: string, handler: (...args: unknown[]) => void): this {
    if (AxlStream.STREAM_EVENTS.has(event)) {
      this.bus.on(event, handler);
    } else {
      super.on(event, handler);
    }
    return this;
  }

  off(event: string, handler: (...args: unknown[]) => void): this {
    if (AxlStream.STREAM_EVENTS.has(event)) {
      this.bus.off(event, handler);
    } else {
      super.off(event, handler);
    }
    return this;
  }

  [Symbol.asyncIterator]() {
    const self = this;
    return {
      next: (): Promise<IteratorResult<StreamEvent>> => {
        if (self.eventQueue.length > 0) {
          return Promise.resolve({ value: self.eventQueue.shift()!, done: false });
        }
        if (self.finished && self.eventQueue.length === 0) {
          return Promise.resolve({ value: undefined as unknown as StreamEvent, done: true });
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
              if (value.type === 'token') return { value: value.data, done: false };
            }
          },
        };
      },
    };
  }

  get steps(): AsyncIterable<StreamEvent> {
    const stepTypes = new Set([
      'agent_start',
      'agent_end',
      'tool_call',
      'tool_result',
      'tool_approval',
      'handoff',
    ]);
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        const iter = self[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<StreamEvent>> {
            while (true) {
              const { value, done } = await iter.next();
              if (done) return { value: undefined as unknown as StreamEvent, done: true };
              if (stepTypes.has(value.type)) return { value, done: false };
            }
          },
        };
      },
    };
  }

  pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T {
    const shouldEnd = options?.end !== false;
    this.bus.on('token', (event: StreamEvent) => {
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

  /** Push a stream event. Called by the runtime. */
  _push(event: StreamEvent): void {
    if (this.finished) return;
    if (event.type === 'token') this.tokens.push(event.data);
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
  _done(result: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.result = result;
    const doneEvent: StreamEvent = { type: 'done', data: result };
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
      w({ value: undefined as unknown as StreamEvent, done: true });
    }
    this.waiters.length = 0;
    this.bus.emit('__resolve', result);
  }

  /** Signal an error. */
  _error(error: Error): void {
    if (this.finished) return;
    this.finished = true;
    const errorEvent: StreamEvent = { type: 'error', message: error.message };
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
      w({ value: undefined as unknown as StreamEvent, done: true });
    }
    this.waiters.length = 0;
    this.bus.emit('__reject', error);
  }

  get fullText(): string {
    return this.tokens.join('');
  }
}
