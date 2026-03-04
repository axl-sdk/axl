import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NoopSpanManager } from '../telemetry/noop.js';
import { createSpanManager } from '../telemetry/index.js';
import { OTelSpanManager } from '../telemetry/span-manager.js';

// OTel SDK imports for testing
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { context, trace } from '@opentelemetry/api';

describe('telemetry', () => {
  describe('NoopSpanManager', () => {
    it('executes fn and returns result', async () => {
      const mgr = new NoopSpanManager();
      const result = await mgr.withSpanAsync('test', {}, async () => 42);
      expect(result).toBe(42);
    });

    it('addEventToActiveSpan is a no-op', () => {
      const mgr = new NoopSpanManager();
      mgr.addEventToActiveSpan('event', { key: 'value' });
      // no error thrown
    });

    it('shutdown resolves', async () => {
      const mgr = new NoopSpanManager();
      await mgr.shutdown();
    });

    it('propagates errors from fn', async () => {
      const mgr = new NoopSpanManager();
      await expect(
        mgr.withSpanAsync('test', {}, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    });
  });

  describe('createSpanManager', () => {
    it('returns NoopSpanManager when disabled', async () => {
      const mgr = await createSpanManager();
      expect(mgr).toBeInstanceOf(NoopSpanManager);
    });

    it('returns NoopSpanManager when enabled is false', async () => {
      const mgr = await createSpanManager({ enabled: false });
      expect(mgr).toBeInstanceOf(NoopSpanManager);
    });
  });
});

describe('OTelSpanManager', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let manager: OTelSpanManager;
  let contextManager: AsyncLocalStorageContextManager;

  beforeEach(async () => {
    // Set up context propagation for Node.js (required for nesting and getActiveSpan)
    contextManager = new AsyncLocalStorageContextManager();
    context.setGlobalContextManager(contextManager);

    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    // Register provider globally so trace.getActiveSpan() works
    trace.setGlobalTracerProvider(provider);

    manager = await OTelSpanManager.create({
      enabled: true,
      tracerProvider: provider,
      serviceName: 'axl-test',
    });
  });

  afterEach(async () => {
    // Disable globals to avoid cross-test pollution
    context.disable();
    trace.disable();
    await provider.shutdown();
  });

  it('creates spans with correct name and attributes', async () => {
    await manager.withSpanAsync(
      'test.span',
      { 'test.key': 'value', 'test.num': 42 },
      async (_span) => {
        return 'result';
      },
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('test.span');
    expect(spans[0].attributes['test.key']).toBe('value');
    expect(spans[0].attributes['test.num']).toBe(42);
  });

  it('returns the function result', async () => {
    const result = await manager.withSpanAsync('test', {}, async () => 'hello');
    expect(result).toBe('hello');
  });

  it('sets error status on exception', async () => {
    await expect(
      manager.withSpanAsync('test.error', {}, async () => {
        throw new Error('test error');
      }),
    ).rejects.toThrow('test error');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    // OTel SpanStatusCode.ERROR = 2
    expect(spans[0].status.code).toBe(2);
    expect(spans[0].status.message).toBe('test error');
  });

  it('sets ok status on success', async () => {
    await manager.withSpanAsync('test.ok', {}, async () => 'ok');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    // OTel SpanStatusCode.OK = 1
    expect(spans[0].status.code).toBe(1);
  });

  it('nests child spans correctly', async () => {
    await manager.withSpanAsync('parent', { level: 'parent' }, async () => {
      await manager.withSpanAsync('child', { level: 'child' }, async () => {
        return 'inner';
      });
      return 'outer';
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);

    const child = spans.find((s) => s.name === 'child')!;
    const parent = spans.find((s) => s.name === 'parent')!;

    expect(child).toBeDefined();
    expect(parent).toBeDefined();
    // Child's parent span ID should match parent's span ID
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it('setAttribute adds attributes after creation', async () => {
    await manager.withSpanAsync('test.attrs', {}, async (span) => {
      span.setAttribute('dynamic.key', 'dynamic_value');
      span.setAttribute('dynamic.num', 123);
      return 'done';
    });

    const spans = exporter.getFinishedSpans();
    expect(spans[0].attributes['dynamic.key']).toBe('dynamic_value');
    expect(spans[0].attributes['dynamic.num']).toBe(123);
  });

  it('addEvent records events on the span', async () => {
    await manager.withSpanAsync('test.events', {}, async (span) => {
      span.addEvent('my.event', { 'event.key': 'event_value' });
      return 'done';
    });

    const spans = exporter.getFinishedSpans();
    expect(spans[0].events).toHaveLength(1);
    expect(spans[0].events[0].name).toBe('my.event');
    expect(spans[0].events[0].attributes?.['event.key']).toBe('event_value');
  });

  it('addEventToActiveSpan adds events to the current active span', async () => {
    await manager.withSpanAsync('test.active', {}, async () => {
      manager.addEventToActiveSpan('active.event', { key: 'val' });
      return 'done';
    });

    const spans = exporter.getFinishedSpans();
    expect(spans[0].events).toHaveLength(1);
    expect(spans[0].events[0].name).toBe('active.event');
  });

  it('shutdown flushes provider', async () => {
    await manager.withSpanAsync('test.shutdown', {}, async () => 'done');
    // Spans are recorded before shutdown
    const spansBefore = exporter.getFinishedSpans();
    expect(spansBefore.length).toBeGreaterThanOrEqual(1);
    // shutdown should resolve without error
    await manager.shutdown();
  });

  it('emits axl.agent.handoff span with source and target attributes', async () => {
    // Use the OTelSpanManager directly to verify handoff span creation
    const handoffStart = Date.now();
    await manager.withSpanAsync(
      'axl.agent.handoff',
      {
        'axl.handoff.source': 'triage',
        'axl.handoff.target': 'math_expert',
      },
      async (span) => {
        // Simulate handoff execution
        span.setAttribute('axl.handoff.duration', Date.now() - handoffStart);
        return 'handoff result';
      },
    );

    const spans = exporter.getFinishedSpans();
    const handoffSpan = spans.find((s) => s.name === 'axl.agent.handoff');
    expect(handoffSpan).toBeDefined();
    expect(handoffSpan!.attributes['axl.handoff.source']).toBe('triage');
    expect(handoffSpan!.attributes['axl.handoff.target']).toBe('math_expert');
    expect(handoffSpan!.attributes['axl.handoff.duration']).toBeDefined();
  });

  it('createSpanManager returns OTelSpanManager when enabled', async () => {
    const { createSpanManager } = await import('../telemetry/index.js');
    const mgr = await createSpanManager({
      enabled: true,
      tracerProvider: provider,
    });
    expect(mgr).toBeInstanceOf(OTelSpanManager);
  });
});
