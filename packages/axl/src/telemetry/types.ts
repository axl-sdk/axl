/** Configuration for OpenTelemetry integration. */
export type TelemetryConfig = {
  /** Whether telemetry is enabled. Defaults to false. */
  enabled?: boolean;
  /** Custom TracerProvider. If not provided, uses the global OTel provider. */
  tracerProvider?: unknown;
  /** Tracer name. Defaults to 'axl'. */
  serviceName?: string;
  /** Opt in to GenAI message and tool content on spans. Defaults to false. Trace redaction wins. */
  captureContent?: boolean;
};

/** OpenTelemetry-compatible scalar and native array attribute values. */
export type SpanAttributeValue = string | number | boolean | string[] | number[] | boolean[];
export type SpanAttributes = Record<string, SpanAttributeValue>;

/** A handle to an active span for adding events and attributes. */
export interface SpanHandle {
  setAttribute(key: string, value: SpanAttributeValue): void;
  addEvent(name: string, attributes?: SpanAttributes): void;
  setStatus(code: 'unset' | 'ok' | 'error', message?: string): void;
  end(): void;
}

/** Manages span creation and context propagation. */
export interface SpanManager {
  /** Wrap an async function in a span. Child spans created inside auto-nest. */
  withSpanAsync<T>(
    name: string,
    attributes: SpanAttributes,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T>;
  /** Start a span whose lifetime is controlled by the caller (for streamed calls). Optional for legacy managers. */
  startSpan?(
    name: string,
    attributes: SpanAttributes,
    options?: {
      kind?: 'client';
      /** Epoch milliseconds at logical call initiation. */
      startTime?: number;
    },
  ): SpanHandle;
  /** Add an event to the currently active span (if any). */
  addEventToActiveSpan(name: string, attributes?: SpanAttributes): void;
  /** Release manager-owned resources. External tracer providers remain application-owned. */
  shutdown(): Promise<void>;
}
