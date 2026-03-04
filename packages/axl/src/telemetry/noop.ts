import type { SpanHandle, SpanManager } from './types.js';

const NOOP_SPAN: SpanHandle = {
  setAttribute() {},
  addEvent() {},
  setStatus() {},
  end() {},
};

/**
 * No-op span manager. Zero overhead when OTel is not configured.
 * All methods are synchronous no-ops that return immediately.
 */
export class NoopSpanManager implements SpanManager {
  async withSpanAsync<T>(
    _name: string,
    _attributes: Record<string, string | number | boolean>,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    return fn(NOOP_SPAN);
  }

  addEventToActiveSpan(): void {}

  async shutdown(): Promise<void> {}
}
