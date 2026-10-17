import type { SpanManager, SpanHandle } from '../telemetry/types.js';

// A pre-P4 application implementation must remain assignable: startSpan is
// optional and the old scalar method signatures still satisfy the interface.
interface LegacyHandle {
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  setStatus(code: 'unset' | 'ok' | 'error', message?: string): void;
  end(): void;
}
declare const legacy: {
  withSpanAsync<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: LegacyHandle) => Promise<T>,
  ): Promise<T>;
  addEventToActiveSpan(name: string, attributes?: Record<string, string | number | boolean>): void;
  shutdown(): Promise<void>;
};
const compatible: SpanManager = legacy;
const optionalStart: SpanManager['startSpan'] = compatible.startSpan;
declare const handle: SpanHandle;
handle.setAttribute('gen_ai.response.finish_reasons', ['stop']);
void optionalStart;
