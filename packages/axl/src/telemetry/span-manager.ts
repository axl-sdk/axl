import type { SpanHandle, SpanManager, TelemetryConfig } from './types.js';

/** Minimal interface for an OTel span. */
interface OTelSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  setStatus(status: { code: unknown; message?: string }): void;
  end(): void;
}

/** Minimal interface for an OTel tracer. */
interface OTelTracer {
  startActiveSpan<T>(
    name: string,
    options: { attributes: Record<string, string | number | boolean> },
    fn: (span: OTelSpan) => Promise<T>,
  ): Promise<T>;
}

/** Minimal interface for an OTel tracer provider. */
interface OTelTracerProvider {
  getTracer(name: string): OTelTracer;
  shutdown?(): Promise<void>;
}

/** Minimal interface for the @opentelemetry/api module. */
interface OTelApi {
  SpanStatusCode: { OK: unknown; ERROR: unknown };
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
  private tracerProvider: OTelTracerProvider;

  private constructor(otelApi: OTelApi, tracer: OTelTracer, tracerProvider: OTelTracerProvider) {
    this.otelApi = otelApi;
    this.tracer = tracer;
    this.tracerProvider = tracerProvider;
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

    return new OTelSpanManager(otelApi, tracer, tracerProvider);
  }

  async withSpanAsync<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    const otelApi = this.otelApi;

    return this.tracer.startActiveSpan(name, { attributes }, async (otelSpan: OTelSpan) => {
      const handle: SpanHandle = {
        setAttribute(key: string, value: string | number | boolean) {
          otelSpan.setAttribute(key, value);
        },
        addEvent(eventName: string, attrs?: Record<string, string | number | boolean>) {
          otelSpan.addEvent(eventName, attrs);
        },
        setStatus(code: 'ok' | 'error', message?: string) {
          const statusCode =
            code === 'ok' ? otelApi.SpanStatusCode.OK : otelApi.SpanStatusCode.ERROR;
          otelSpan.setStatus({ code: statusCode, message });
        },
        end() {
          otelSpan.end();
        },
      };

      try {
        const result = await fn(handle);
        handle.setStatus('ok');
        return result;
      } catch (err) {
        handle.setStatus('error', err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        handle.end();
      }
    });
  }

  addEventToActiveSpan(name: string, attributes?: Record<string, string | number | boolean>): void {
    const activeSpan = this.otelApi.trace.getActiveSpan?.();
    if (activeSpan) {
      activeSpan.addEvent(name, attributes);
    }
  }

  async shutdown(): Promise<void> {
    if (this.tracerProvider && typeof this.tracerProvider.shutdown === 'function') {
      await this.tracerProvider.shutdown();
    }
  }
}
