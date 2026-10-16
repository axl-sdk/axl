import type {
  SpanAttributeValue,
  SpanAttributes,
  SpanHandle,
  SpanManager,
  TelemetryConfig,
} from './types.js';

/** Minimal interface for an OTel span. */
interface OTelSpan {
  setAttribute(key: string, value: SpanAttributeValue): void;
  addEvent(name: string, attributes?: SpanAttributes): void;
  setStatus(status: { code: unknown; message?: string }): void;
  end(): void;
}

/** Minimal interface for an OTel tracer. */
interface OTelTracer {
  startSpan(name: string, options: { attributes: SpanAttributes; kind?: number }): OTelSpan;
  startActiveSpan<T>(
    name: string,
    options: { attributes: SpanAttributes },
    fn: (span: OTelSpan) => Promise<T>,
  ): Promise<T>;
}

/** Minimal interface for an OTel tracer provider. */
interface OTelTracerProvider {
  getTracer(name: string): OTelTracer;
}

/** Minimal interface for the @opentelemetry/api module. */
interface OTelApi {
  SpanKind: { CLIENT: number };
  SpanStatusCode: { UNSET: unknown; OK: unknown; ERROR: unknown };
  trace: {
    getTracerProvider(): OTelTracerProvider;
    getActiveSpan?(): OTelSpan | undefined;
  };
}

/**
 * OpenTelemetry-backed SpanManager.
 * Dynamically imports @opentelemetry/api to avoid hard dependency.
 */
export class OTelSpanManager implements SpanManager {
  private tracer: OTelTracer;
  private otelApi: OTelApi;

  private constructor(otelApi: OTelApi, tracer: OTelTracer) {
    this.otelApi = otelApi;
    this.tracer = tracer;
  }

  static async create(config: TelemetryConfig): Promise<OTelSpanManager> {
    let otelApi: OTelApi;
    try {
      otelApi = (await import('@opentelemetry/api')) as unknown as OTelApi;
    } catch {
      throw new Error(
        '@opentelemetry/api is required for telemetry. Install it with: npm install @opentelemetry/api',
      );
    }

    const tracerProvider =
      (config.tracerProvider as OTelTracerProvider | undefined) ??
      otelApi.trace.getTracerProvider();
    const serviceName = config.serviceName ?? 'axl';
    const tracer = tracerProvider.getTracer(serviceName);

    return new OTelSpanManager(otelApi, tracer);
  }

  async withSpanAsync<T>(
    name: string,
    attributes: SpanAttributes,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, { attributes }, async (otelSpan: OTelSpan) => {
      let statusWasSet = false;
      const handle = this.handle(otelSpan, () => {
        statusWasSet = true;
      });

      try {
        const result = await fn(handle);
        if (!statusWasSet) handle.setStatus('ok');
        return result;
      } catch (err) {
        // Error text can contain provider, prompt, or sensitive tool data.
        // Keep exported status structural; host diagnostics remain in Axl's
        // own error and redacted event channels.
        handle.setStatus('error');
        throw err;
      } finally {
        handle.end();
      }
    });
  }

  /** Start a CLIENT inference span under the current OTel context. The caller ends it. */
  startSpan(name: string, attributes: SpanAttributes, options?: { kind?: 'client' }): SpanHandle {
    const span = this.tracer.startSpan(name, {
      attributes,
      ...(options?.kind === 'client' ? { kind: this.otelApi.SpanKind.CLIENT } : {}),
    });
    return this.handle(span);
  }

  private handle(span: OTelSpan, onStatus?: () => void): SpanHandle {
    const otelApi = this.otelApi;
    let ended = false;
    return {
      setAttribute(key, value) {
        if (!ended) span.setAttribute(key, value);
      },
      addEvent(name, attributes) {
        if (!ended) span.addEvent(name, attributes);
      },
      setStatus(code, message) {
        if (ended) return;
        onStatus?.();
        const statusCode =
          code === 'ok'
            ? otelApi.SpanStatusCode.OK
            : code === 'error'
              ? otelApi.SpanStatusCode.ERROR
              : otelApi.SpanStatusCode.UNSET;
        span.setStatus({ code: statusCode, message });
      },
      end() {
        if (ended) return;
        ended = true;
        span.end();
      },
    };
  }

  addEventToActiveSpan(name: string, attributes?: SpanAttributes): void {
    const activeSpan = this.otelApi.trace.getActiveSpan?.();
    if (activeSpan) {
      activeSpan.addEvent(name, attributes);
    }
  }

  // Axl uses an application-owned provider, whether supplied or global.
  // Its lifecycle, including flush and shutdown, belongs to the application.
  async shutdown(): Promise<void> {}
}
