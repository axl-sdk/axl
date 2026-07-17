import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { ToolModelOutputError } from '../errors.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { ChatMessage } from '../types.js';
import type { Tool } from '../tool.js';
import { tool } from '../tool.js';
import type { AxlEvent, ToolCallMessage } from '../types.js';
import type { SpanHandle, SpanManager } from '../telemetry/types.js';
import { MockProvider } from '../../../axl-testing/src/mock-provider.js';
import { createSequenceProvider } from './helpers.js';
import type { SequenceProvider } from './helpers.js';

type RecordedSpan = {
  name: string;
  attributes: Record<string, string | number | boolean>;
  status?: { code: 'ok' | 'error'; message?: string };
};

class RecordingSpanManager implements SpanManager {
  readonly spans: RecordedSpan[] = [];

  async withSpanAsync<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    const record: RecordedSpan = { name, attributes: { ...attributes } };
    this.spans.push(record);
    const span: SpanHandle = {
      setAttribute: (key, value) => {
        record.attributes[key] = value;
      },
      addEvent: () => undefined,
      setStatus: (code, message) => {
        record.status = { code, ...(message === undefined ? {} : { message }) };
      },
      end: () => undefined,
    };
    try {
      const result = await fn(span);
      record.status ??= { code: 'ok' };
      return result;
    } catch (error) {
      record.status = {
        code: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  addEventToActiveSpan(): void {}
  async shutdown(): Promise<void> {}
}

function call(name: string, id = `call-${name}`): ToolCallMessage {
  return {
    id,
    type: 'function',
    function: { name, arguments: '{}' },
  };
}

function setup(
  tools: Tool<any, any>[],
  toolCalls: ToolCallMessage[] = [call(tools[0].name)],
  options: {
    onAgentStart?: () => void;
    redact?: boolean;
    provider?: SequenceProvider;
    signal?: AbortSignal;
    streaming?: boolean;
    toolOverrides?: Map<string, (args: unknown) => Promise<unknown>>;
    spanManager?: SpanManager;
  } = {},
) {
  const provider = options.provider ?? createSequenceProvider([{ tool_calls: toolCalls }, 'done']);
  const registry = new ProviderRegistry();
  registry.registerInstance('mock', provider);
  const traces: AxlEvent[] = [];
  const ctx = new WorkflowContext({
    input: 'test',
    executionId: randomUUID(),
    config: { trace: { level: 'full', redact: options.redact } },
    onAgentStart: options.onAgentStart,
    providerRegistry: registry,
    signal: options.signal,
    toolOverrides: options.toolOverrides,
    spanManager: options.spanManager,
    onTrace: (event) => traces.push(event),
  });
  if (options.streaming) void ctx.events;
  const testAgent = agent({
    name: 'projection-test',
    model: 'mock:model',
    system: 'test',
    tools,
  });

  return { ctx, provider, traces, testAgent };
}

function toolMessage(messages: unknown[]): ChatMessage {
  const message = (messages as ChatMessage[]).find((item) => item.role === 'tool');
  if (!message) throw new Error('Expected a tool message');
  return message;
}

describe('model-facing tool output projection', () => {
  it('projects the post-after-hook value while retaining the complete host result', async () => {
    const tracesSeenByMapper: AxlEvent[] = [];
    let traces: AxlEvent[] = tracesSeenByMapper;
    let mapperOutput: unknown;
    const projected = tool({
      name: 'rich_result',
      description: 'Return a rich application result',
      input: z.object({}),
      handler: () => ({
        action: { label: 'Open', internalId: 'action-1' },
        humanMessage: 'Original',
        payload: { rows: [1, 2, 3] },
      }),
      hooks: {
        after: (output) => ({ ...output, humanMessage: 'Ready for the user' }),
      },
      toModelOutput(output) {
        expect(traces.some((event) => event.type === 'tool_call_end')).toBe(true);
        mapperOutput = output;
        return { message: output.humanMessage };
      },
    });
    const harness = setup([projected]);
    traces = harness.traces;

    await harness.ctx.ask(harness.testAgent, 'go');

    const end = harness.traces.find((event) => event.type === 'tool_call_end');
    expect(end?.data.result).toEqual({
      action: { label: 'Open', internalId: 'action-1' },
      humanMessage: 'Ready for the user',
      payload: { rows: [1, 2, 3] },
    });
    expect(end?.data.result).toBe(mapperOutput);
    expect(Object.keys(end?.data ?? {})).toEqual(['args', 'result', 'callId']);
    expect(toolMessage(harness.provider.calls[1].messages).content).toBe(
      '{"message":"Ready for the user"}',
    );
  });

  it.each([
    ['string', 'plain text', 'plain text'],
    ['empty string', '', ''],
    ['record', { answer: 42, omitted: undefined }, '{"answer":42}'],
    ['empty record', {}, '{}'],
    ['array', [1, 'two', false, null], '[1,"two",false,null]'],
    ['empty array', [], '[]'],
    ['number', 42, '42'],
    ['zero', 0, '0'],
    ['boolean', false, 'false'],
    ['null', null, 'null'],
  ])('renders projected %s output exactly once', async (_label, projection, expected) => {
    const projected = tool({
      name: 'render',
      description: 'Render projected output',
      input: z.object({}),
      handler: () => ({ raw: true }),
      toModelOutput: () => projection as never,
    });
    const harness = setup([projected]);

    await harness.ctx.ask(harness.testAgent, 'go');

    expect(toolMessage(harness.provider.calls[1].messages).content).toBe(expected);
  });

  it('invokes projection without an implicit receiver', async () => {
    const projected = tool({
      name: 'detached_projection',
      description: 'Invoke projection as a result-only callback',
      input: z.object({}),
      handler: () => ({ raw: true }),
      toModelOutput: function (this: unknown) {
        return this === undefined ? 'detached' : 'bound';
      } as never,
    });
    const harness = setup([projected]);

    await harness.ctx.ask(harness.testAgent, 'go');

    expect(toolMessage(harness.provider.calls[1].messages).content).toBe('detached');
  });

  it.each([
    ['string', 'plain text', '"plain text"'],
    ['record', { answer: 42, omitted: undefined }, '{"answer":42}'],
    ['array', [1, 'two', false, null], '[1,"two",false,null]'],
    ['number', 42, '42'],
    ['boolean', false, 'false'],
    ['null', null, 'null'],
  ])(
    'preserves legacy %s serialization when no mapper is configured',
    async (_label, raw, expected) => {
      const legacyTool = tool({
        name: 'legacy_result',
        description: 'Return a legacy result',
        input: z.object({}),
        handler: () => raw,
      });
      const harness = setup([legacyTool]);

      await harness.ctx.ask(harness.testAgent, 'go');

      expect(toolMessage(harness.provider.calls[1].messages).content).toBe(expected);
    },
  );

  it('preserves legacy unserializable-result failure and event ordering', async () => {
    const legacyTool = tool({
      name: 'legacy_unserializable',
      description: 'Return a legacy unserializable result',
      input: z.object({}),
      handler: () => 1n,
    });
    const harness = setup([legacyTool]);

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toBeInstanceOf(TypeError);

    expect(harness.provider.calls).toHaveLength(1);
    expect(harness.traces.filter((event) => event.type === 'tool_call_end')).toHaveLength(0);
  });

  it.each([
    ['top-level undefined', () => undefined],
    ['array undefined', () => [undefined]],
    ['array hole', () => new Array(1)],
    ['bigint', () => 1n],
    ['function', () => () => 'no'],
    ['symbol', () => Symbol('no')],
    ['non-finite number', () => Infinity],
    ['NaN', () => Number.NaN],
    [
      'cycle',
      () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
    ],
    ['custom toJSON', () => ({ toJSON: () => ({ leaked: true }) })],
    ['accessor', () => Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'x' })],
    [
      'non-enumerable accessor',
      () => Object.defineProperty({}, 'secret', { enumerable: false, get: () => 'x' }),
    ],
    [
      'symbol accessor',
      () => Object.defineProperty({}, Symbol('secret'), { enumerable: false, get: () => 'x' }),
    ],
    ['Date', () => new Date()],
    ['Map', () => new Map([['secret', 'value']])],
    ['Set', () => new Set(['secret'])],
    ['Promise', () => Promise.resolve('secret')],
    [
      'non-enumerable thenable',
      () => Object.defineProperty({}, 'then', { value: () => undefined }),
    ],
    [
      'throwing proxy',
      () =>
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error('proxy trap');
            },
          },
        ),
    ],
    [
      'enumerable symbol key',
      () => {
        const value: Record<PropertyKey, unknown> = {};
        Object.defineProperty(value, Symbol('secret'), { enumerable: true, value: 'x' });
        return value;
      },
    ],
  ])('fails closed for %s without a raw fallback', async (_label, makeProjection) => {
    const projected = tool({
      name: 'invalid_projection',
      description: 'Return invalid projected output',
      input: z.object({}),
      handler: () => ({ rawSecret: 'host-only' }),
      toModelOutput: () => makeProjection() as never,
    });
    const harness = setup([projected]);

    let caught: unknown;
    try {
      await harness.ctx.ask(harness.testAgent, 'go');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ToolModelOutputError);
    expect(caught).toMatchObject({
      name: 'ToolModelOutputError',
      code: 'TOOL_MODEL_OUTPUT_ERROR',
      toolName: 'invalid_projection',
      message: 'Failed to prepare model output for tool "invalid_projection"',
    });
    expect(harness.provider.calls).toHaveLength(1);
    const ends = harness.traces.filter((event) => event.type === 'tool_call_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].data.result).toEqual({ rawSecret: 'host-only' });
    const askEnd = harness.traces.find((event) => event.type === 'ask_end');
    expect(askEnd?.outcome).toEqual({
      ok: false,
      error: 'Failed to prepare model output for tool "invalid_projection"',
    });
    expect(JSON.stringify(harness.traces)).not.toContain('leaked');
  });

  it('accepts shared references that are not cyclic', async () => {
    const shared = { visible: true };
    const projected = tool({
      name: 'shared',
      description: 'Use a shared object twice',
      input: z.object({}),
      handler: () => 'complete',
      toModelOutput: () => ({ first: shared, second: shared }),
    });
    const harness = setup([projected]);

    await harness.ctx.ask(harness.testAgent, 'go');

    expect(toolMessage(harness.provider.calls[1].messages).content).toBe(
      '{"first":{"visible":true},"second":{"visible":true}}',
    );
  });

  it('observes a rejected Promise from an unsupported async projector', async () => {
    const secret = 'async-projector-secret';
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const projected = tool({
      name: 'async_rejection',
      description: 'Reject asynchronously despite the synchronous contract',
      input: z.object({}),
      handler: () => ({ raw: 'host-only' }),
      toModelOutput: (async () => {
        throw new Error(secret);
      }) as never,
    });
    const harness = setup([projected]);

    try {
      await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toMatchObject({
        name: 'ToolModelOutputError',
        toolName: 'async_rejection',
        message: 'Failed to prepare model output for tool "async_rejection"',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.traces)).not.toContain(secret);
    expect(harness.provider.calls).toHaveLength(1);
  });

  it('accepts null-prototype records and preserves a literal __proto__ key', async () => {
    const record = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(record, '__proto__', {
      enumerable: true,
      value: 'visible',
    });
    record.answer = 42;
    const projected = tool({
      name: 'null_prototype',
      description: 'Return a null-prototype record',
      input: z.object({}),
      handler: () => 'complete',
      toModelOutput: () => record as never,
    });
    const harness = setup([projected]);

    await harness.ctx.ask(harness.testAgent, 'go');

    expect(toolMessage(harness.provider.calls[1].messages).content).toBe(
      '{"__proto__":"visible","answer":42}',
    );
  });

  it.each([
    [{ toJSON: undefined, answer: 42 }, '{"answer":42}'],
    [{ toJSON: 'ordinary data', answer: 42 }, '{"toJSON":"ordinary data","answer":42}'],
  ])('treats a non-callable toJSON record field as ordinary data', async (projection, expected) => {
    const projected = tool({
      name: 'to_json_data',
      description: 'Use toJSON as an ordinary field',
      input: z.object({}),
      handler: () => 'complete',
      toModelOutput: () => projection,
    });
    const harness = setup([projected]);

    await harness.ctx.ask(harness.testAgent, 'go');

    expect(toolMessage(harness.provider.calls[1].messages).content).toBe(expected);
  });

  it('rejects without executing an inherited Array.prototype.toJSON', async () => {
    const original = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    const hook = vi.fn(() => ({ injected: 'prototype' }));
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value: hook,
    });
    try {
      const projected = tool({
        name: 'array_prototype',
        description: 'Project an array safely',
        input: z.object({}),
        handler: () => 'complete',
        toModelOutput: () => ['expected'],
      });
      const harness = setup([projected]);

      await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toMatchObject({
        toolName: 'array_prototype',
        message: 'Failed to prepare model output for tool "array_prototype"',
      });
      expect(hook).not.toHaveBeenCalled();
      expect(harness.provider.calls).toHaveLength(1);
    } finally {
      if (original) Object.defineProperty(Array.prototype, 'toJSON', original);
      else delete (Array.prototype as { toJSON?: unknown }).toJSON;
    }
  });

  it('rejects sparse arrays despite Object.prototype descriptor pollution', async () => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, '0');
    Object.defineProperty(Object.prototype, '0', {
      configurable: true,
      writable: true,
      value: { enumerable: true, value: 'injected' },
    });
    try {
      const projected = tool({
        name: 'polluted_descriptor_map',
        description: 'Reject a sparse array under prototype pollution',
        input: z.object({}),
        handler: () => 'complete',
        toModelOutput: () => new Array(1) as never,
      });
      const harness = setup([projected]);

      await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toBeInstanceOf(
        ToolModelOutputError,
      );
      expect(harness.provider.calls).toHaveLength(1);
    } finally {
      if (original) Object.defineProperty(Object.prototype, '0', original);
      else delete (Object.prototype as Record<string, unknown>)['0'];
    }
  });

  it('does not execute an inherited toJSON that could spoof a typed error', async () => {
    const original = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value: () => {
        throw new ToolModelOutputError('spoofed_tool', new Error('nested'));
      },
    });
    try {
      const projected = tool({
        name: 'serializer_tool',
        description: 'Bind serializer behavior to this tool',
        input: z.object({}),
        handler: () => 'complete',
        toModelOutput: () => ['expected'],
      });
      const harness = setup([projected]);

      await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toMatchObject({
        toolName: 'serializer_tool',
        message: 'Failed to prepare model output for tool "serializer_tool"',
        cause: expect.objectContaining({
          message: expect.stringContaining('inherited custom toJSON is not supported'),
        }),
      });
      expect(harness.provider.calls).toHaveLength(1);
    } finally {
      if (original) Object.defineProperty(Array.prototype, 'toJSON', original);
      else delete (Array.prototype as { toJSON?: unknown }).toJSON;
    }
  });

  it('wraps mapper throws without exposing the mapper message in events', async () => {
    const projected = tool({
      name: 'throwing_mapper',
      description: 'Throw while projecting',
      input: z.object({}),
      handler: () => ({ rawSecret: 'raw-value' }),
      toModelOutput: () => {
        throw new Error('mapper-secret-value');
      },
    });
    const harness = setup([projected]);

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'mapper-secret-value' }),
    });
    const serialized = JSON.stringify(harness.traces);
    expect(serialized).not.toContain('mapper-secret-value');
    expect(serialized).toContain('raw-value');
  });

  it('keeps the host-visible cause out of ordinary error serialization', () => {
    const cause = new Error('mapper-secret-value');
    const error = new ToolModelOutputError('projected_tool', cause);

    expect(error.cause).toBe(cause);
    expect(Object.keys(error)).not.toContain('cause');
    expect(JSON.stringify(error)).not.toContain('mapper-secret-value');
  });

  it('rewraps a ToolModelOutputError thrown by the mapper for the current tool', async () => {
    const nested = new ToolModelOutputError('spoofed_tool', new Error('nested'));
    const projected = tool({
      name: 'current_tool',
      description: 'Throw a typed error from the mapper',
      input: z.object({}),
      handler: () => ({ raw: true }),
      toModelOutput: () => {
        throw nested;
      },
    });
    const harness = setup([projected]);

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toMatchObject({
      toolName: 'current_tool',
      message: 'Failed to prepare model output for tool "current_tool"',
      cause: nested,
    });
  });

  it('lets sensitive policy win over projection on success and failure', async () => {
    const mapper = vi.fn(() => 'should not run');
    const sensitiveSuccess = tool({
      name: 'sensitive_success',
      description: 'Sensitive success',
      input: z.object({}),
      sensitive: true,
      handler: () => ({ secret: 'complete' }),
      toModelOutput: mapper,
    });
    const success = setup([sensitiveSuccess]);
    await success.ctx.ask(success.testAgent, 'go');
    expect(toolMessage(success.provider.calls[1].messages).content).toBe(
      '[REDACTED - sensitive tool output]',
    );

    const sensitiveFailure = tool({
      name: 'sensitive_failure',
      description: 'Sensitive failure',
      input: z.object({}),
      sensitive: true,
      handler: () => {
        throw new Error('handler-secret');
      },
      toModelOutput: mapper,
    });
    const failure = setup([sensitiveFailure]);
    await failure.ctx.ask(failure.testAgent, 'go');
    expect(toolMessage(failure.provider.calls[1].messages).content).toBe(
      '[REDACTED - sensitive tool output]',
    );
    expect(mapper).not.toHaveBeenCalled();
  });

  it('bypasses projection for handler and after-hook failures', async () => {
    const mapper = vi.fn(() => 'should not run');
    const handlerFailure = tool({
      name: 'handler_failure',
      description: 'Handler failure',
      input: z.object({}),
      handler: () => {
        throw new Error('handler failed');
      },
      toModelOutput: mapper,
    });
    const first = setup([handlerFailure]);
    await first.ctx.ask(first.testAgent, 'go');
    expect(toolMessage(first.provider.calls[1].messages).content).toBe(
      '{"error":"handler failed"}',
    );

    const afterFailure = tool({
      name: 'after_failure',
      description: 'After failure',
      input: z.object({}),
      handler: () => ({ ok: true }),
      hooks: {
        after: () => {
          throw new Error('after failed');
        },
      },
      toModelOutput: mapper,
    });
    const second = setup([afterFailure]);
    await second.ctx.ask(second.testAgent, 'go');
    expect(toolMessage(second.provider.calls[1].messages).content).toBe(
      '{"error":"After hook error: after failed"}',
    );
    expect(mapper).not.toHaveBeenCalled();
  });

  it('projects a normally returned error-shaped result while preserving legacy hook treatment', async () => {
    const after = vi.fn((output) => output);
    const projected = tool({
      name: 'returned_error',
      description: 'Return an error-shaped value normally',
      input: z.object({}),
      handler: () => ({ error: 'declined', internal: 'host-only' }),
      hooks: { after },
      toModelOutput: (output) => ({ message: output.error }),
    });
    const harness = setup([projected]);

    await harness.ctx.ask(harness.testAgent, 'go');

    expect(after).not.toHaveBeenCalled();
    expect(toolMessage(harness.provider.calls[1].messages).content).toBe('{"message":"declined"}');
  });

  it('does not let legacy error-shape proxy traps bypass configured projection', async () => {
    const secret = 'error-sentinel-secret';
    const rawResult = new Proxy(
      {},
      {
        has: (_target, key) => {
          if (key === 'error') throw new Error(secret);
          return false;
        },
      },
    );
    const after = vi.fn((output) => output);
    const mapper = vi.fn(() => 'safe projection');
    const spans = new RecordingSpanManager();
    const projected = tool({
      name: 'proxy_sentinel',
      description: 'Project despite a hostile legacy error sentinel',
      input: z.object({}),
      handler: () => rawResult,
      hooks: { after },
      toModelOutput: mapper,
    });
    const harness = setup([projected], undefined, { spanManager: spans });

    await harness.ctx.ask(harness.testAgent, 'go');

    expect(after).toHaveBeenCalledOnce();
    expect(mapper).toHaveBeenCalledWith(rawResult);
    expect(harness.traces.find((event) => event.type === 'tool_call_end')?.data.result).toBe(
      rawResult,
    );
    expect(toolMessage(harness.provider.calls[1].messages).content).toBe('safe projection');
    expect(spans.spans.find((span) => span.name === 'axl.tool.call')).toMatchObject({
      attributes: { 'axl.tool.success': true },
      status: { code: 'ok' },
    });
    expect(JSON.stringify(harness.traces)).not.toContain(secret);
  });

  it('redacts the authoritative host event without changing projected model content', async () => {
    const projected = tool({
      name: 'redacted_trace',
      description: 'Project with trace redaction',
      input: z.object({}),
      handler: () => ({ secret: 'raw', visible: 'model' }),
      toModelOutput: (output) => output.visible,
    });
    const harness = setup([projected], undefined, { redact: true });

    await harness.ctx.ask(harness.testAgent, 'go');

    const end = harness.traces.find((event) => event.type === 'tool_call_end');
    expect(end?.data.result).toBe('[redacted]');
    expect(toolMessage(harness.provider.calls[1].messages).content).toBe('model');
    const nextStart = harness.traces.filter((event) => event.type === 'agent_call_start')[1];
    expect(nextStart.data.messages).toEqual([
      expect.objectContaining({ role: 'system', content: expect.stringContaining('redacted') }),
    ]);
  });

  it('aborts a multi-tool response immediately when projection fails', async () => {
    const laterHandler = vi.fn(() => ({ later: true }));
    const first = tool({
      name: 'first',
      description: 'First tool',
      input: z.object({}),
      handler: () => ({ first: true }),
      toModelOutput: () => 'first projection',
    });
    const failing = tool({
      name: 'failing',
      description: 'Failing projection',
      input: z.object({}),
      handler: () => ({ second: true }),
      toModelOutput: () => undefined as never,
    });
    const later = tool({
      name: 'later',
      description: 'Later tool',
      input: z.object({}),
      handler: laterHandler,
    });
    const harness = setup(
      [first, failing, later],
      [call('first', 'call-1'), call('failing', 'call-2'), call('later', 'call-3')],
    );

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toBeInstanceOf(
      ToolModelOutputError,
    );

    expect(laterHandler).not.toHaveBeenCalled();
    expect(
      harness.traces.filter((event) => event.type === 'tool_call_end').map((event) => event.tool),
    ).toEqual(['first', 'failing']);
    expect(harness.provider.calls).toHaveLength(1);
  });

  it('keeps projection policy and call IDs isolated in a successful mixed batch', async () => {
    const projected = tool({
      name: 'projected_batch',
      description: 'Project one result in a mixed batch',
      input: z.object({}),
      handler: () => ({ visible: 'projected', secret: 'projected-host-only' }),
      toModelOutput: (output) => output.visible,
    });
    const legacy = tool({
      name: 'legacy_batch',
      description: 'Keep one result on the legacy path',
      input: z.object({}),
      handler: () => 'legacy',
    });
    const harness = setup(
      [projected, legacy],
      [call('projected_batch', 'call-projected'), call('legacy_batch', 'call-legacy')],
    );

    await harness.ctx.ask(harness.testAgent, 'go');

    expect(
      harness.provider.calls[1].messages.filter((message: any) => message.role === 'tool'),
    ).toEqual([
      expect.objectContaining({
        content: 'projected',
        tool_call_id: 'call-projected',
      }),
      expect.objectContaining({
        content: '"legacy"',
        tool_call_id: 'call-legacy',
      }),
    ]);
    expect(
      harness.traces
        .filter((event) => event.type === 'tool_call_end')
        .map((event) => [event.data.callId, event.data.result]),
    ).toEqual([
      ['call-projected', { visible: 'projected', secret: 'projected-host-only' }],
      ['call-legacy', 'legacy'],
    ]);
  });

  it('keeps serialized projections isolated through later turns and source mutation', async () => {
    const firstProjection = { visible: 'first' };
    const provider = createSequenceProvider([
      { tool_calls: [call('repeated_projection', 'call-first')] },
      { tool_calls: [call('repeated_projection', 'call-second')] },
      'done',
    ]);
    const originalChat = provider.chat.bind(provider);
    provider.chat = async (messages, options) => {
      if (provider.calls.length === 1) firstProjection.visible = 'mutated-after-serialization';
      return originalChat(messages, options);
    };
    let execution = 0;
    const projected = tool({
      name: 'repeated_projection',
      description: 'Project repeated results independently',
      input: z.object({}),
      handler: () => {
        execution++;
        return { visible: execution === 1 ? 'first' : 'second', secret: `host-only-${execution}` };
      },
      toModelOutput: (output) =>
        output.visible === 'first' ? firstProjection : { visible: 'second' },
    });
    const harness = setup([projected], undefined, { provider });

    await harness.ctx.ask(harness.testAgent, 'go');

    expect(
      harness.provider.calls[2].messages.filter((message: any) => message.role === 'tool'),
    ).toEqual([
      expect.objectContaining({ content: '{"visible":"first"}', tool_call_id: 'call-first' }),
      expect.objectContaining({ content: '{"visible":"second"}', tool_call_id: 'call-second' }),
    ]);
    expect(JSON.stringify(harness.provider.calls[2].messages)).not.toContain('host-only');
  });

  it('propagates provider rejection without retrying with the complete result', async () => {
    const calls: SequenceProvider['calls'] = [];
    const provider: SequenceProvider = {
      name: 'mock',
      calls,
      chat: async (messages, options) => {
        calls.push({ messages, options });
        if (calls.length === 1) {
          return { content: '', tool_calls: [call('provider_rejection')] };
        }
        throw new Error('provider rejected projected content');
      },
      stream: async function* () {
        yield { type: 'done' as const };
      },
    };
    const handler = vi.fn(() => ({ visible: 'safe', secret: 'host-only' }));
    const mapper = vi.fn((output: { visible: string }) => output.visible);
    const projected = tool({
      name: 'provider_rejection',
      description: 'Keep provider rejection fail-closed',
      input: z.object({}),
      handler,
      toModelOutput: mapper,
    });
    const harness = setup([projected], undefined, { provider });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toThrow(
      'provider rejected projected content',
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(mapper).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
    expect(toolMessage(calls[1].messages).content).toBe('safe');
    expect(JSON.stringify(calls[1].messages)).not.toContain('host-only');
  });

  it('projects once after a handler retry succeeds', async () => {
    const handler = vi
      .fn<() => { visible: string; secret: string }>()
      .mockImplementationOnce(() => {
        throw new Error('retry me');
      })
      .mockReturnValue({ visible: 'safe', secret: 'host-only' });
    const mapper = vi.fn((output: { visible: string }) => output.visible);
    const projected = tool({
      name: 'retried_handler',
      description: 'Project only the successful handler result',
      input: z.object({}),
      retry: { attempts: 2, backoff: 'none' },
      handler,
      toModelOutput: mapper,
    });
    const harness = setup([projected]);

    await harness.ctx.ask(harness.testAgent, 'go');

    expect(handler).toHaveBeenCalledTimes(2);
    expect(mapper).toHaveBeenCalledOnce();
    expect(toolMessage(harness.provider.calls[1].messages).content).toBe('safe');
  });

  it('keeps real-tool projection equivalent in streaming and non-streaming asks', async () => {
    const projected = tool({
      name: 'streaming_projection',
      description: 'Project the same real result in both modes',
      input: z.object({}),
      handler: () => ({ visible: 'safe', secret: 'host-only' }),
      toModelOutput: (output) => output.visible,
    });
    const makeProvider = () =>
      MockProvider.sequence([
        { content: '', tool_calls: [call('streaming_projection')] },
        { content: 'done' },
      ]) as SequenceProvider;
    const nonStreaming = setup([projected], undefined, { provider: makeProvider() });
    const streaming = setup([projected], undefined, {
      provider: makeProvider(),
      streaming: true,
    });

    await nonStreaming.ctx.ask(nonStreaming.testAgent, 'go');
    await streaming.ctx.ask(streaming.testAgent, 'go');

    expect(toolMessage(nonStreaming.provider.calls[1].messages).content).toBe('safe');
    expect(toolMessage(streaming.provider.calls[1].messages).content).toBe('safe');
    expect(JSON.stringify(streaming.provider.calls[1].messages)).not.toContain('host-only');
  });

  it('does not continue to the provider after a tool aborts the ask signal', async () => {
    const controller = new AbortController();
    const mapper = vi.fn(() => 'safe projection');
    const projected = tool({
      name: 'abort_after_execution',
      description: 'Abort after completing a local side effect',
      input: z.object({}),
      handler: () => {
        controller.abort();
        return { raw: 'host-only' };
      },
      toModelOutput: mapper,
    });
    const harness = setup([projected], undefined, { signal: controller.signal });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(harness.provider.calls).toHaveLength(1);
    expect(mapper).not.toHaveBeenCalled();
    expect(harness.traces.filter((event) => event.type === 'tool_call_end')).toHaveLength(1);
    expect(harness.traces.find((event) => event.type === 'ask_end')?.outcome).toMatchObject({
      ok: false,
    });
  });

  it('rechecks cancellation after start callbacks before provider continuation', async () => {
    const controller = new AbortController();
    let starts = 0;
    const projected = tool({
      name: 'abort_from_start_callback',
      description: 'Abort from the continuation start callback',
      input: z.object({}),
      handler: () => ({ raw: 'host-only' }),
      toModelOutput: () => 'safe projection',
    });
    const harness = setup([projected], undefined, {
      signal: controller.signal,
      onAgentStart: () => {
        starts++;
        if (starts === 2) controller.abort();
      },
    });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(harness.provider.calls).toHaveLength(1);
    expect(harness.traces.filter((event) => event.type === 'agent_call_start')).toHaveLength(2);
    expect(harness.traces.filter((event) => event.type === 'agent_call_end')).toHaveLength(2);
    expect(harness.traces.find((event) => event.type === 'ask_end')?.outcome).toMatchObject({
      ok: false,
    });
  });

  it('closes tool telemetry before projection and keeps a failed projection span successful', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const spans = new RecordingSpanManager();
    const projected = tool({
      name: 'telemetry_projection',
      description: 'Project after execution telemetry closes',
      input: z.object({}),
      handler: () => ({ raw: 'host-only' }),
      toModelOutput: () => {
        clock.mockReturnValue(1_000);
        throw new Error('mapper-secret');
      },
    });
    const harness = setup([projected], undefined, { spanManager: spans });

    try {
      await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toBeInstanceOf(
        ToolModelOutputError,
      );
    } finally {
      clock.mockRestore();
    }

    const toolSpan = spans.spans.find((span) => span.name === 'axl.tool.call');
    expect(toolSpan).toMatchObject({
      attributes: {
        'axl.tool.duration': 0,
        'axl.tool.success': true,
      },
      status: { code: 'ok' },
    });
    const toolEnd = harness.traces.find((event) => event.type === 'tool_call_end');
    expect(toolEnd?.duration).toBe(0);
    const askSpan = spans.spans.find((span) => span.name === 'axl.agent.ask');
    expect(askSpan?.status).toEqual({
      code: 'error',
      message: 'Failed to prepare model output for tool "telemetry_projection"',
    });
    expect(JSON.stringify(spans.spans)).not.toContain('mapper-secret');
    expect(JSON.stringify(spans.spans)).not.toContain('host-only');
  });

  it('keeps legacy failed-span classification for a projected returned error-shaped value', async () => {
    const spans = new RecordingSpanManager();
    const projected = tool({
      name: 'error_span',
      description: 'Return an error-shaped result',
      input: z.object({}),
      handler: () => ({ error: 'declined', internal: 'host-only' }),
      toModelOutput: (output) => output.error,
    });
    const harness = setup([projected], undefined, { spanManager: spans });

    await harness.ctx.ask(harness.testAgent, 'go');

    expect(spans.spans.find((span) => span.name === 'axl.tool.call')).toMatchObject({
      attributes: { 'axl.tool.success': false },
      status: { code: 'error', message: 'declined' },
    });
  });

  it('preserves legacy returned error-shaped output, hook treatment, and span classification', async () => {
    const spans = new RecordingSpanManager();
    const after = vi.fn((output) => output);
    const legacyTool = tool({
      name: 'legacy_error_span',
      description: 'Return an error-shaped result without projection',
      input: z.object({}),
      handler: () => ({ error: 'declined', internal: 'host-only' }),
      hooks: { after },
    });
    const harness = setup([legacyTool], undefined, { spanManager: spans });

    await harness.ctx.ask(harness.testAgent, 'go');

    expect(after).not.toHaveBeenCalled();
    expect(toolMessage(harness.provider.calls[1].messages).content).toBe(
      '{"error":"declined","internal":"host-only"}',
    );
    expect(spans.spans.find((span) => span.name === 'axl.tool.call')).toMatchObject({
      attributes: { 'axl.tool.success': false },
      status: { code: 'error', message: 'declined' },
    });
  });

  it('keeps legacy failed-span classification for a projected returned error-shaped override', async () => {
    const spans = new RecordingSpanManager();
    const configured = tool({
      name: 'error_override_span',
      description: 'Project an override result',
      input: z.object({}),
      handler: () => ({ error: 'real', internal: 'real-only' }),
      toModelOutput: (output) => output.error,
    });
    const overrides = new Map<string, (args: unknown) => Promise<unknown>>([
      ['error_override_span', async () => ({ error: 'mock declined', internal: 'host-only' })],
    ]);
    const harness = setup([configured], undefined, {
      toolOverrides: overrides,
      spanManager: spans,
    });

    await harness.ctx.ask(harness.testAgent, 'go');

    expect(toolMessage(harness.provider.calls[1].messages).content).toBe('mock declined');
    expect(harness.traces.find((event) => event.type === 'tool_call_end')?.data.result).toEqual({
      error: 'mock declined',
      internal: 'host-only',
    });
    expect(spans.spans.find((span) => span.name === 'axl.tool.call')).toMatchObject({
      attributes: { 'axl.tool.success': false },
      status: { code: 'error', message: 'mock declined' },
    });
  });

  it('closes override telemetry before a configured projection failure', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const spans = new RecordingSpanManager();
    const configured = tool({
      name: 'failing_override_projection',
      description: 'Fail after an override returns',
      input: z.object({}),
      handler: () => ({ raw: 'real' }),
      toModelOutput: () => {
        clock.mockReturnValue(1_000);
        throw new Error('override-mapper-secret');
      },
    });
    const overrides = new Map<string, (args: unknown) => Promise<unknown>>([
      ['failing_override_projection', async () => ({ raw: 'host-only' })],
    ]);
    const harness = setup([configured], undefined, {
      toolOverrides: overrides,
      spanManager: spans,
    });

    try {
      await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toBeInstanceOf(
        ToolModelOutputError,
      );
    } finally {
      clock.mockRestore();
    }

    expect(spans.spans.find((span) => span.name === 'axl.tool.call')).toMatchObject({
      attributes: {
        'axl.tool.duration': 0,
        'axl.tool.success': true,
      },
      status: { code: 'ok' },
    });
    expect(harness.traces.find((event) => event.type === 'tool_call_end')?.duration).toBe(0);
    expect(JSON.stringify(spans.spans)).not.toContain('override-mapper-secret');
    expect(JSON.stringify(spans.spans)).not.toContain('host-only');
  });

  it('preserves legacy override event duration through result serialization', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const spans = new RecordingSpanManager();
    const legacyTool = tool({
      name: 'legacy_override_duration',
      description: 'Retain legacy override duration semantics',
      input: z.object({}),
      handler: () => ({ real: true }),
    });
    const overrideResult = {
      toJSON: () => {
        clock.mockReturnValue(1_000);
        return { mocked: true };
      },
    };
    const overrides = new Map<string, (args: unknown) => Promise<unknown>>([
      ['legacy_override_duration', async () => overrideResult],
    ]);
    const harness = setup([legacyTool], undefined, {
      toolOverrides: overrides,
      spanManager: spans,
    });

    try {
      await harness.ctx.ask(harness.testAgent, 'go');
    } finally {
      clock.mockRestore();
    }

    expect(toolMessage(harness.provider.calls[1].messages).content).toBe('{"mocked":true}');
    expect(harness.traces.find((event) => event.type === 'tool_call_end')?.duration).toBe(1_000);
    expect(spans.spans.find((span) => span.name === 'axl.tool.call')).toMatchObject({
      attributes: { 'axl.tool.duration': 0 },
    });
  });

  it('projects an agent-as-tool result while retaining its complete nested result', async () => {
    const provider = createSequenceProvider([
      { tool_calls: [call('ask_specialist')] },
      'specialist answer',
      'outer done',
    ]);
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', provider);
    const traces: AxlEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { level: 'full' } },
      providerRegistry: registry,
      onTrace: (event) => traces.push(event),
    });
    const specialist = agent({ name: 'specialist', model: 'mock:model', system: 'specialist' });
    const agentTool = tool({
      name: 'ask_specialist',
      description: 'Ask a nested agent',
      input: z.object({}),
      handler: async (_input, childCtx) => ({
        answer: await childCtx.ask(specialist, 'question'),
        internalId: 'host-only',
      }),
      toModelOutput: (output) => output.answer,
    });
    const outer = agent({
      name: 'outer',
      model: 'mock:model',
      system: 'outer',
      tools: [agentTool],
    });

    await ctx.ask(outer, 'go');

    const end = traces.find(
      (event) => event.type === 'tool_call_end' && event.tool === 'ask_specialist',
    );
    expect(end?.data.result).toEqual({ answer: 'specialist answer', internalId: 'host-only' });
    expect(toolMessage(provider.calls[2].messages).content).toBe('specialist answer');
  });

  it.each([
    ['projected outer boundary', true, 'inner answer'],
    ['legacy outer boundary', false, '{"answer":"inner answer","outerSecret":"outer-host-only"}'],
  ])(
    'keeps nested inner projection independent with a %s',
    async (_label, projectOuter, expectedOuterContent) => {
      const provider = createSequenceProvider([
        { tool_calls: [call('ask_nested_specialist', 'call-outer')] },
        { tool_calls: [call('inner_lookup', 'call-inner')] },
        'inner answer',
        'outer done',
      ]);
      const registry = new ProviderRegistry();
      registry.registerInstance('mock', provider);
      const traces: AxlEvent[] = [];
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: { trace: { level: 'full' } },
        providerRegistry: registry,
        onTrace: (event) => traces.push(event),
      });
      const innerLookup = tool({
        name: 'inner_lookup',
        description: 'Return rich inner data',
        input: z.object({}),
        handler: () => ({ visible: 'inner-visible', secret: 'inner-host-only' }),
        toModelOutput: (output) => output.visible,
      });
      const specialist = agent({
        name: 'nested-specialist',
        model: 'mock:model',
        system: 'specialist',
        tools: [innerLookup],
      });
      const outerConfig = {
        name: 'ask_nested_specialist',
        description: 'Ask a specialist that uses another tool',
        input: z.object({}),
        handler: async (_input: unknown, childCtx: WorkflowContext) => ({
          answer: await childCtx.ask(specialist, 'question'),
          outerSecret: 'outer-host-only',
        }),
      };
      const agentTool = projectOuter
        ? tool({ ...outerConfig, toModelOutput: (output) => output.answer })
        : tool(outerConfig);
      const outer = agent({
        name: 'nested-outer',
        model: 'mock:model',
        system: 'outer',
        tools: [agentTool],
      });

      await ctx.ask(outer, 'go');

      expect(toolMessage(provider.calls[2].messages).content).toBe('inner-visible');
      expect(JSON.stringify(provider.calls[2].messages)).not.toContain('inner-host-only');
      expect(toolMessage(provider.calls[3].messages).content).toBe(expectedOuterContent);
      expect(JSON.stringify(provider.calls[3].messages)).not.toContain('inner-host-only');
      expect(
        traces.find((event) => event.type === 'tool_call_end' && event.tool === 'inner_lookup')
          ?.data.result,
      ).toEqual({ visible: 'inner-visible', secret: 'inner-host-only' });
      expect(
        traces.find(
          (event) => event.type === 'tool_call_end' && event.tool === 'ask_nested_specialist',
        )?.data.result,
      ).toEqual({ answer: 'inner answer', outerSecret: 'outer-host-only' });
    },
  );
});
