/** Configuration for OpenTelemetry integration. */
export type TelemetryConfig = {
  /** Whether telemetry is enabled. Defaults to false. */
  enabled?: boolean;
  /** Custom TracerProvider. If not provided, uses the global OTel provider. */
  tracerProvider?: unknown;
  /** Tracer name. Defaults to 'axl'. */
  serviceName?: string;
};

/** A handle to an active span for adding events and attributes. */
export interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  setStatus(code: 'ok' | 'error', message?: string): void;
  end(): void;
}

/** Manages span creation and context propagation. */
export interface SpanManager {
  /** Wrap an async function in a span. Child spans created inside auto-nest. */
  withSpanAsync<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T>;
  /** Add an event to the currently active span (if any). */
  addEventToActiveSpan(name: string, attributes?: Record<string, string | number | boolean>): void;
  /** Gracefully shut down (flush pending spans). */
  shutdown(): Promise<void>;
}
