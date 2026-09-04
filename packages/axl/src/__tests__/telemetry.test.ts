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
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { tool } from '../tool.js';
import { createSequenceProvider } from './helpers.js';

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
    expect(spans[0].status.message).toBeUndefined();
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

  it('parents an agent-as-tool inner ask under the outer tool span', async () => {
    const inner = agent({ name: 'otel-inner', model: 'mock:test', system: 'inner' });
    const agentTool = tool({
      name: 'ask_otel_inner',
      description: 'invoke an inner agent',
      input: z.object({ question: z.string() }),
      handler: ({ question }, ctx) => ctx.ask(inner, question),
    });
    const outer = agent({
      name: 'otel-outer',
      model: 'mock:test',
      system: 'outer',
      tools: [agentTool],
    });
    const mock = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'otel-tool-call',
            type: 'function',
            function: { name: 'ask_otel_inner', arguments: '{"question":"go"}' },
          },
        ],
      },
      'inner answer',
      'outer answer',
    ]);
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', mock);
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: {},
      providerRegistry: registry,
      spanManager: manager,
    });

    await expect(ctx.ask(outer, 'go')).resolves.toBe('outer answer');

    const spans = exporter.getFinishedSpans();
    const outerAsk = spans.find(
      (span) => span.name === 'axl.agent.ask' && span.attributes['axl.agent.name'] === 'otel-outer',
    );
    const toolSpan = spans.find(
      (span) =>
        span.name === 'axl.tool.call' && span.attributes['axl.tool.name'] === 'ask_otel_inner',
    );
    const innerAsk = spans.find(
      (span) => span.name === 'axl.agent.ask' && span.attributes['axl.agent.name'] === 'otel-inner',
    );
    expect(toolSpan?.parentSpanContext?.spanId).toBe(outerAsk?.spanContext().spanId);
    expect(innerAsk?.parentSpanContext?.spanId).toBe(toolSpan?.spanContext().spanId);
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

  // -------------------------------------------------------------------------
  // Per-call latency on the ask span. `axl.agent.duration` is ask wall clock;
  // these attributes split the provider call's share of it, so a trace can say
  // "the model was slow" apart from "I was pacing myself".
  // -------------------------------------------------------------------------

  const TIMING = {
    queuedMs: 4200,
    attempts: 2,
    retryMs: 1100,
    ttfbMs: 300,
    firstTokenMs: 850,
    wireMs: 2400,
  };

  function timedProvider(timing?: typeof TIMING) {
    return {
      name: 'mock',
      chat: async () => ({
        content: 'answer',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        cost: 0.001,
        ...(timing ? { timing } : {}),
      }),
      stream: async function* () {
        yield { type: 'done' as const };
      },
    };
  }

  async function askWithSpan(prov: ReturnType<typeof timedProvider>) {
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', prov);
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: {},
      providerRegistry: registry,
      spanManager: manager,
    });
    await ctx.ask(agent({ name: 'timed', model: 'mock:test', system: 's' }), 'go');
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'axl.agent.ask' && s.attributes['axl.agent.name'] === 'timed');
    expect(span, 'no axl.agent.ask span was exported').toBeDefined();
    return span!;
  }

  it('sets per-call timing attributes on axl.agent.ask', async () => {
    const span = await askWithSpan(timedProvider(TIMING));

    expect(span.attributes['axl.agent.queued_ms']).toBe(TIMING.queuedMs);
    expect(span.attributes['axl.agent.retry_ms']).toBe(TIMING.retryMs);
    expect(span.attributes['axl.agent.attempts']).toBe(TIMING.attempts);
    expect(span.attributes['axl.agent.ttfb_ms']).toBe(TIMING.ttfbMs);
    expect(span.attributes['axl.agent.wire_ms']).toBe(TIMING.wireMs);
    expect(span.attributes['axl.agent.first_token_ms']).toBe(TIMING.firstTokenMs);
    // Additive: the pre-existing ask-level attributes are unchanged.
    expect(span.attributes['axl.agent.duration']).toBeDefined();
    expect(span.attributes['axl.agent.prompt_tokens']).toBe(10);
  });

  it('omits first_token_ms when the call reported none', async () => {
    // A non-streamed call has no content delta to time. Zero would read as an
    // instantaneous first token, which no call achieved.
    const noFirstToken: typeof TIMING = { ...TIMING };
    delete (noFirstToken as { firstTokenMs?: number }).firstTokenMs;
    const span = await askWithSpan(timedProvider(noFirstToken));

    expect(span.attributes['axl.agent.wire_ms']).toBe(TIMING.wireMs);
    expect('axl.agent.first_token_ms' in span.attributes).toBe(false);
  });

  it('sets NO timing attributes for an uninstrumented provider', async () => {
    // The whole point of the presence check: an adapter that never measured
    // must not appear on a latency dashboard as a zero-latency call.
    const span = await askWithSpan(timedProvider());

    for (const key of [
      'axl.agent.queued_ms',
      'axl.agent.retry_ms',
      'axl.agent.attempts',
      'axl.agent.ttfb_ms',
      'axl.agent.wire_ms',
      'axl.agent.first_token_ms',
    ]) {
      expect(key in span.attributes, `${key} must be absent`).toBe(false);
    }
    // The ask still ran and still reports its wall clock.
    expect(span.attributes['axl.agent.duration']).toBeDefined();
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
