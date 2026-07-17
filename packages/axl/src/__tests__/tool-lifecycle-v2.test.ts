import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { ToolFailure } from '../errors.js';
import { ProviderRegistry } from '../providers/registry.js';
import { tool, type Tool } from '../tool.js';
import type {
  AxlEvent,
  AwaitHumanOptions,
  ChatMessage,
  HumanDecision,
  ToolCallMessage,
} from '../types.js';
import type { SpanHandle, SpanManager } from '../telemetry/types.js';
import { createSequenceProvider } from './helpers.js';

type RecordedSpan = {
  name: string;
  attributes: Record<string, string | number | boolean>;
  status?: { code: 'unset' | 'ok' | 'error'; message?: string };
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
      record.status = { code: 'error' };
      throw error;
    }
  }

  addEventToActiveSpan(): void {}
  async shutdown(): Promise<void> {}
}

function setup(options: {
  configuredTool?: Tool;
  configuredTools?: Tool[];
  requestedTool?: string;
  toolCalls?: ToolCallMessage[];
  arguments?: string;
  decision?: HumanDecision;
  awaitHumanHandler?: (options: AwaitHumanOptions) => Promise<HumanDecision>;
  onTrace?: (event: AxlEvent) => void;
  signal?: AbortSignal;
  spanManager?: SpanManager;
  toolOverrides?: Map<string, (args: unknown) => Promise<unknown>>;
}) {
  const configuredTools =
    options.configuredTools ?? (options.configuredTool ? [options.configuredTool] : []);
  const requestedTool = options.requestedTool ?? configuredTools[0]?.name ?? 'missing';
  const provider = createSequenceProvider([
    {
      tool_calls: options.toolCalls ?? [
        {
          id: 'call-1',
          type: 'function',
          function: { name: requestedTool, arguments: options.arguments ?? '{}' },
        },
      ],
    },
    'done',
  ]);
  const registry = new ProviderRegistry();
  registry.registerInstance('mock', provider);
  const events: AxlEvent[] = [];
  const ctx = new WorkflowContext({
    input: 'test',
    executionId: randomUUID(),
    config: {},
    providerRegistry: registry,
    signal: options.signal,
    spanManager: options.spanManager,
    toolOverrides: options.toolOverrides,
    onTrace: (event) => {
      events.push(event);
      options.onTrace?.(event);
    },
    ...(options.awaitHumanHandler
      ? { awaitHumanHandler: options.awaitHumanHandler }
      : options.decision
        ? { awaitHumanHandler: () => options.decision! }
        : {}),
  });
  const testAgent = agent({
    name: 'v2-lifecycle',
    model: 'mock:model',
    system: 'test',
    ...(configuredTools.length > 0 ? { tools: configuredTools } : {}),
  });
  return { ctx, testAgent, provider, events };
}

function lifecycle(events: AxlEvent[]): AxlEvent[] {
  return events.filter((event) =>
    ['tool_call_start', 'tool_call_end', 'tool_call_rejected', 'tool_approval'].includes(
      event.type,
    ),
  );
}

function providerToolMessage(provider: ReturnType<typeof createSequenceProvider>): ChatMessage {
  const message = (provider.calls[1].messages as ChatMessage[]).find(
    (candidate) => candidate.role === 'tool',
  );
  if (!message) throw new Error('Expected continued provider tool message');
  return message;
}

describe('v2 tool lifecycle integration', () => {
  it.each([
    {
      label: 'pre-start',
      reason: 'already cancelled',
      create(controller: AbortController) {
        controller.abort('already cancelled');
        return tool({
          name: 'never_starts',
          description: 'fixture',
          input: z.object({}),
          handler: vi.fn(),
        });
      },
    },
    {
      label: 'after schema validation',
      reason: 'validation cancelled',
      create(controller: AbortController) {
        return tool({
          name: 'cancel_during_validation',
          description: 'fixture',
          input: z.object({}).transform((value) => {
            controller.abort('validation cancelled');
            return value;
          }),
          handler: vi.fn(),
        });
      },
    },
  ])('cancels $label before acceptance without lifecycle events', async ({ reason, create }) => {
    const controller = new AbortController();
    const configuredTool = create(controller);
    const harness = setup({ configuredTool, signal: controller.signal });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toBe(reason);
    expect(lifecycle(harness.events)).toEqual([]);
  });

  it.each([
    [
      'unavailable',
      { requestedTool: 'missing' },
      'Tool "missing" is not available. Available tools: none',
    ],
    [
      'invalid_json',
      {
        configuredTool: tool({
          name: 'parse_me',
          description: 'fixture',
          input: z.object({}),
          handler: () => 'unused',
        }),
        arguments: '{bad',
      },
      'Error: Invalid JSON in tool arguments. Please provide valid JSON.',
    ],
    [
      'invalid_arguments',
      {
        configuredTool: tool({
          name: 'validate_me',
          description: 'fixture',
          input: z.object({ id: z.string() }),
          handler: () => 'unused',
        }),
        arguments: '{"id":1}',
      },
      'Error: Tool arguments are invalid. Correct the arguments and try again.',
    ],
    [
      'invalid_arguments',
      {
        configuredTool: tool({
          name: 'bounded_string',
          description: 'fixture',
          input: z.object({ value: z.string() }),
          maxStringLength: 2,
          handler: () => 'unused',
        }),
        arguments: '{"value":"too long"}',
      },
      'Error: Tool arguments are invalid. Correct the arguments and try again.',
    ],
  ] as const)(
    'emits one %s rejection with no accepted lifecycle or tool span',
    async (reason, options, expectedMessage) => {
      const spans = new RecordingSpanManager();
      const harness = setup({ ...options, spanManager: spans });

      await expect(harness.ctx.ask(harness.testAgent, 'go')).resolves.toBe('done');

      expect(lifecycle(harness.events).map((event) => event.type)).toEqual(['tool_call_rejected']);
      expect(lifecycle(harness.events)[0]).toMatchObject({
        schemaVersion: 2,
        type: 'tool_call_rejected',
        callId: 'call-1',
        data: { reason },
      });
      expect(providerToolMessage(harness.provider).content).toBe(expectedMessage);
      expect(spans.spans.filter((span) => span.name === 'axl.tool.call')).toEqual([]);
    },
  );

  it('pairs approval denial and skips hooks and handler', async () => {
    const before = vi.fn();
    const after = vi.fn();
    const handler = vi.fn();
    const configuredTool = tool({
      name: 'approve_me',
      description: 'fixture',
      input: z.object({}),
      requireApproval: true,
      handler,
      hooks: { before, after },
    });
    const harness = setup({
      configuredTool,
      decision: { approved: false, reason: 'not now' },
    });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).resolves.toBe('done');

    expect(lifecycle(harness.events).map((event) => event.type)).toEqual([
      'tool_call_start',
      'tool_approval',
      'tool_call_end',
    ]);
    expect(lifecycle(harness.events)[2]).toMatchObject({
      type: 'tool_call_end',
      callId: 'call-1',
      data: { outcome: { status: 'denied', reason: 'not now' } },
    });
    expect(before).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(providerToolMessage(harness.provider).content).toBe(
      '{"error":"Tool request was denied by human approval."}',
    );
  });

  it('includes a controlled approval wait in the paired terminal duration', async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const handler = vi.fn(() => ({ ok: true }));
    const configuredTool = tool({
      name: 'approved_with_wait',
      description: 'fixture',
      input: z.object({}),
      requireApproval: true,
      handler,
    });
    const harness = setup({
      configuredTool,
      awaitHumanHandler: async () => {
        now = 1_425;
        return { approved: true };
      },
    });

    try {
      await expect(harness.ctx.ask(harness.testAgent, 'go')).resolves.toBe('done');
    } finally {
      clock.mockRestore();
    }

    expect(lifecycle(harness.events).map((event) => event.type)).toEqual([
      'tool_call_start',
      'tool_approval',
      'tool_call_end',
    ]);
    const ends = harness.events.filter((event) => event.type === 'tool_call_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      duration: 425,
      data: { outcome: { status: 'succeeded', result: { ok: true } } },
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('pairs an approval infrastructure failure before aborting the ask', async () => {
    const failure = new Error('approval transport secret');
    const handler = vi.fn();
    const before = vi.fn();
    const configuredTool = tool({
      name: 'approval_failure',
      description: 'fixture',
      input: z.object({}),
      requireApproval: true,
      handler,
      hooks: { before },
    });
    const laterHandler = vi.fn();
    const later = tool({
      name: 'later_after_approval_failure',
      description: 'must not execute',
      input: z.object({}),
      handler: laterHandler,
    });
    const harness = setup({
      configuredTools: [configuredTool, later],
      toolCalls: [
        {
          id: 'approval-failure',
          type: 'function',
          function: { name: configuredTool.name, arguments: '{}' },
        },
        {
          id: 'later-approval-failure',
          type: 'function',
          function: { name: later.name, arguments: '{}' },
        },
      ],
      awaitHumanHandler: async () => {
        throw failure;
      },
    });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toBe(failure);

    expect(lifecycle(harness.events).map((event) => event.type)).toEqual([
      'tool_call_start',
      'tool_call_end',
    ]);
    expect(lifecycle(harness.events)[1]).toMatchObject({
      data: {
        outcome: {
          status: 'failed',
          failure: { phase: 'approval', kind: 'infrastructure', disposition: 'abort' },
        },
      },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(before).not.toHaveBeenCalled();
    expect(laterHandler).not.toHaveBeenCalled();
    expect(harness.provider.calls).toHaveLength(1);
  });

  it('pairs missing approval infrastructure and aborts before later siblings', async () => {
    const handler = vi.fn();
    const configuredTool = tool({
      name: 'approval_handler_missing',
      description: 'fixture',
      input: z.object({}),
      requireApproval: true,
      handler,
    });
    const laterHandler = vi.fn();
    const later = tool({
      name: 'later_after_missing_approval',
      description: 'must not execute',
      input: z.object({}),
      handler: laterHandler,
    });
    const harness = setup({
      configuredTools: [configuredTool, later],
      toolCalls: [
        {
          id: 'approval-missing',
          type: 'function',
          function: { name: configuredTool.name, arguments: '{}' },
        },
        {
          id: 'later-approval-missing',
          type: 'function',
          function: { name: later.name, arguments: '{}' },
        },
      ],
    });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toThrow(
      /requires approval but no approval handler is configured/,
    );

    expect(lifecycle(harness.events).map((event) => event.type)).toEqual([
      'tool_call_start',
      'tool_call_end',
    ]);
    expect(lifecycle(harness.events)[1]).toMatchObject({
      callId: 'approval-missing',
      data: {
        outcome: {
          status: 'failed',
          failure: { phase: 'approval', kind: 'infrastructure', disposition: 'abort' },
        },
      },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(laterHandler).not.toHaveBeenCalled();
    expect(harness.provider.calls).toHaveLength(1);
  });

  it('exhausts ordinary handler retries, skips later phases, and fails the tool span safely', async () => {
    const secret = 'ordinary handler secret';
    const handler = vi.fn(() => {
      throw new Error(secret);
    });
    const after = vi.fn();
    const mapper = vi.fn();
    const spans = new RecordingSpanManager();
    const configuredTool = tool({
      name: 'retry_exhausted',
      description: 'fixture',
      input: z.object({}),
      retry: { attempts: 3, backoff: 'none' },
      handler,
      hooks: { after },
      toModelOutput: mapper,
    });
    const harness = setup({ configuredTool, spanManager: spans });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toThrow(secret);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(after).not.toHaveBeenCalled();
    expect(mapper).not.toHaveBeenCalled();
    expect(harness.provider.calls).toHaveLength(1);
    expect(lifecycle(harness.events).map((event) => event.type)).toEqual([
      'tool_call_start',
      'tool_call_end',
    ]);
    expect(lifecycle(harness.events)[1]).toMatchObject({
      data: {
        outcome: {
          status: 'failed',
          failure: {
            phase: 'handler',
            kind: 'unexpected',
            disposition: 'abort',
            attempts: 3,
          },
        },
      },
    });
    const toolSpan = spans.spans.find((span) => span.name === 'axl.tool.call');
    expect(toolSpan).toMatchObject({
      attributes: {
        'axl.tool.outcome': 'failed',
        'axl.tool.phase': 'handler',
        'axl.tool.success': false,
      },
      status: { code: 'error' },
    });
    expect(JSON.stringify(spans.spans)).not.toContain(secret);
  });

  it('fails an ordinary mock override with a safe span and skips all configured phases and siblings', async () => {
    const secret = 'ordinary mock secret';
    const before = vi.fn();
    const realHandler = vi.fn();
    const after = vi.fn();
    const mapper = vi.fn();
    const override = vi.fn(async () => {
      throw new Error(secret);
    });
    const configuredTool = tool({
      name: 'mock_retry_exhausted',
      description: 'fixture',
      input: z.object({}),
      retry: { attempts: 3, backoff: 'none' },
      hooks: { before, after },
      handler: realHandler,
      toModelOutput: mapper,
    });
    const laterHandler = vi.fn();
    const later = tool({
      name: 'later_after_mock_failure',
      description: 'must not execute',
      input: z.object({}),
      handler: laterHandler,
    });
    const spans = new RecordingSpanManager();
    const harness = setup({
      configuredTools: [configuredTool, later],
      toolCalls: [
        {
          id: 'mock-failure',
          type: 'function',
          function: { name: configuredTool.name, arguments: '{}' },
        },
        {
          id: 'later-mock-failure',
          type: 'function',
          function: { name: later.name, arguments: '{}' },
        },
      ],
      spanManager: spans,
      toolOverrides: new Map([[configuredTool.name, override]]),
    });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toThrow(secret);

    expect(override).toHaveBeenCalledOnce();
    expect(before).not.toHaveBeenCalled();
    expect(realHandler).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(mapper).not.toHaveBeenCalled();
    expect(laterHandler).not.toHaveBeenCalled();
    expect(harness.provider.calls).toHaveLength(1);
    expect(lifecycle(harness.events).map((event) => event.type)).toEqual([
      'tool_call_start',
      'tool_call_end',
    ]);
    expect(lifecycle(harness.events)[1]).toMatchObject({
      callId: 'mock-failure',
      data: {
        outcome: {
          status: 'failed',
          failure: {
            phase: 'handler',
            kind: 'unexpected',
            disposition: 'abort',
            attempts: 1,
          },
        },
      },
    });
    expect(spans.spans.find((span) => span.name === 'axl.tool.call')).toMatchObject({
      attributes: {
        'axl.tool.outcome': 'failed',
        'axl.tool.phase': 'handler',
        'axl.tool.success': false,
      },
      status: { code: 'error' },
    });
    expect(JSON.stringify(spans.spans)).not.toContain(secret);
  });

  it.each(['before_hook', 'after_hook'] as const)(
    'pairs an ordinary %s failure, skips projection, and aborts later siblings',
    async (phase) => {
      const sequence: string[] = [];
      const mapper = vi.fn();
      const laterHandler = vi.fn();
      const rawResult = { complete: true };
      const failure = new Error(`${phase} secret`);
      const failing = tool({
        name: `ordinary_${phase}`,
        description: 'fixture',
        input: z.object({}),
        handler: () => {
          sequence.push('handler');
          return rawResult;
        },
        hooks: {
          before: () => {
            sequence.push('before');
            if (phase === 'before_hook') throw failure;
            return {};
          },
          after: (result) => {
            sequence.push('after');
            if (phase === 'after_hook') throw failure;
            return result;
          },
        },
        toModelOutput: mapper,
      });
      const later = tool({
        name: 'later_hook_sibling',
        description: 'fixture',
        input: z.object({}),
        handler: laterHandler,
      });
      const harness = setup({
        configuredTools: [failing, later],
        toolCalls: [
          {
            id: 'hook-failure',
            type: 'function',
            function: { name: failing.name, arguments: '{}' },
          },
          {
            id: 'later-hook',
            type: 'function',
            function: { name: later.name, arguments: '{}' },
          },
        ],
      });

      await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toBe(failure);

      expect(sequence).toEqual(
        phase === 'before_hook' ? ['before'] : ['before', 'handler', 'after'],
      );
      expect(mapper).not.toHaveBeenCalled();
      expect(laterHandler).not.toHaveBeenCalled();
      expect(harness.provider.calls).toHaveLength(1);
      expect(lifecycle(harness.events).map((event) => event.type)).toEqual([
        'tool_call_start',
        'tool_call_end',
      ]);
      expect(lifecycle(harness.events)[1]).toMatchObject({
        callId: 'hook-failure',
        data: {
          outcome: {
            status: 'failed',
            failure: {
              phase,
              kind: 'unexpected',
              disposition: 'abort',
              ...(phase === 'after_hook' ? { result: rawResult } : {}),
            },
          },
        },
      });
    },
  );

  it.each(['before_hook', 'after_hook'] as const)(
    'continues an explicit %s ToolFailure with its exact terminal phase',
    async (phase) => {
      const mapper = vi.fn();
      const rawResult = { complete: true };
      const handler = vi.fn(() => rawResult);
      const configuredTool = tool({
        name: `recoverable_${phase}`,
        description: 'fixture',
        input: z.object({}),
        handler,
        hooks: {
          before: (args) => {
            if (phase === 'before_hook') {
              throw new ToolFailure({ message: 'host before', modelMessage: 'safe before' });
            }
            return args;
          },
          after: (result) => {
            if (phase === 'after_hook') {
              throw new ToolFailure({ message: 'host after', modelMessage: 'safe after' });
            }
            return result;
          },
        },
        toModelOutput: mapper,
      });
      const harness = setup({ configuredTool });

      await expect(harness.ctx.ask(harness.testAgent, 'go')).resolves.toBe('done');

      expect(lifecycle(harness.events).map((event) => event.type)).toEqual([
        'tool_call_start',
        'tool_call_end',
      ]);
      expect(lifecycle(harness.events)[1]).toMatchObject({
        data: {
          outcome: {
            status: 'failed',
            failure: {
              phase,
              kind: 'tool_failure',
              disposition: 'continue',
              ...(phase === 'after_hook' ? { result: rawResult } : {}),
            },
          },
        },
      });
      expect(providerToolMessage(harness.provider).content).toBe(
        phase === 'before_hook' ? 'safe before' : 'safe after',
      );
      expect(handler).toHaveBeenCalledTimes(phase === 'before_hook' ? 0 : 1);
      expect(mapper).not.toHaveBeenCalled();
    },
  );

  it('continues after ToolFailure and exposes only its explicit safe message', async () => {
    const after = vi.fn();
    const configuredTool = tool({
      name: 'recoverable',
      description: 'fixture',
      input: z.object({}),
      handler: () => {
        throw new ToolFailure({
          message: 'private host diagnostic',
          modelMessage: 'Try another account.',
          cause: 'private cause',
        });
      },
      hooks: { after },
    });
    const harness = setup({ configuredTool });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).resolves.toBe('done');

    expect(lifecycle(harness.events).map((event) => event.type)).toEqual([
      'tool_call_start',
      'tool_call_end',
    ]);
    expect(lifecycle(harness.events)[1]).toMatchObject({
      data: {
        outcome: {
          status: 'failed',
          failure: {
            phase: 'handler',
            kind: 'tool_failure',
            disposition: 'continue',
          },
        },
      },
    });
    expect(after).not.toHaveBeenCalled();
    expect(providerToolMessage(harness.provider).content).toBe('Try another account.');
    expect(JSON.stringify(harness.provider.calls[1].messages)).not.toContain('private');
  });

  it('emits a failed end before an unexpected error aborts the ask', async () => {
    const failure = new Error('handler failed');
    const configuredTool = tool({
      name: 'unexpected',
      description: 'fixture',
      input: z.object({}),
      handler: () => {
        throw failure;
      },
    });
    const harness = setup({ configuredTool });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toBe(failure);

    expect(lifecycle(harness.events).map((event) => event.type)).toEqual([
      'tool_call_start',
      'tool_call_end',
    ]);
    expect(lifecycle(harness.events)[1]).toMatchObject({
      data: {
        outcome: {
          status: 'failed',
          failure: { phase: 'handler', kind: 'unexpected', disposition: 'abort' },
        },
      },
    });
    expect(harness.provider.calls).toHaveLength(1);
  });

  it('pairs every accepted cancellation checkpoint and suppresses later siblings', async () => {
    const scenarios = [
      {
        label: 'approval',
        phase: 'approval',
        create(controller: AbortController) {
          const handler = vi.fn();
          return {
            configuredTool: tool({
              name: 'cancel_approval',
              description: 'fixture',
              input: z.object({}),
              requireApproval: true,
              handler,
            }),
            handler,
            awaitHumanHandler: async () => {
              controller.abort('approval cancelled');
              return { approved: true };
            },
          };
        },
      },
      {
        label: 'before hook',
        phase: 'before_hook',
        create(controller: AbortController) {
          const handler = vi.fn();
          return {
            configuredTool: tool({
              name: 'cancel_before_hook',
              description: 'fixture',
              input: z.object({}),
              handler,
              hooks: {
                before: (args) => {
                  controller.abort('before hook cancelled');
                  return args;
                },
              },
            }),
            handler,
          };
        },
      },
      {
        label: 'retry backoff',
        phase: 'handler',
        create(controller: AbortController) {
          const handler = vi.fn(() => {
            throw new Error('retryable');
          });
          return {
            configuredTool: tool({
              name: 'cancel_retry_backoff',
              description: 'fixture',
              input: z.object({}),
              retry: {
                attempts: 3,
                backoff: 'linear',
                on: () => {
                  controller.abort('retry cancelled');
                  return true;
                },
              },
              handler,
            }),
            handler,
            expectedHandlerCalls: 1,
          };
        },
      },
      {
        label: 'handler AbortError',
        phase: 'handler',
        create(_controller: AbortController) {
          const handler = vi.fn(() => {
            throw new DOMException('handler cancelled', 'AbortError');
          });
          return {
            configuredTool: tool({
              name: 'cancel_handler',
              description: 'fixture',
              input: z.object({}),
              retry: { attempts: 3, backoff: 'none' },
              handler,
            }),
            handler,
            expectedHandlerCalls: 1,
          };
        },
      },
      {
        label: 'after raw completion',
        phase: 'after_handler',
        create(controller: AbortController) {
          const handler = vi.fn(() => {
            controller.abort('raw completion cancelled');
            return { complete: true };
          });
          return {
            configuredTool: tool({
              name: 'cancel_after_handler',
              description: 'fixture',
              input: z.object({}),
              handler,
            }),
            handler,
          };
        },
      },
      {
        label: 'during after hook',
        phase: 'after_hook',
        create(_controller: AbortController) {
          const handler = vi.fn(() => ({ complete: true }));
          return {
            configuredTool: tool({
              name: 'cancel_during_after_hook',
              description: 'fixture',
              input: z.object({}),
              handler,
              hooks: {
                after: () => {
                  throw new DOMException('after hook cancelled', 'AbortError');
                },
              },
              toModelOutput: () => 'must not project',
            }),
            handler,
          };
        },
      },
      {
        label: 'before projection',
        phase: 'after_hook',
        create(controller: AbortController) {
          const handler = vi.fn(() => ({ complete: true }));
          return {
            configuredTool: tool({
              name: 'cancel_after_hook',
              description: 'fixture',
              input: z.object({}),
              handler,
              hooks: {
                after: (result) => {
                  controller.abort('after hook cancelled');
                  return result;
                },
              },
              toModelOutput: () => 'must not project',
            }),
            handler,
          };
        },
      },
      {
        label: 'after projection',
        phase: 'projection',
        create(controller: AbortController) {
          const handler = vi.fn(() => ({ complete: true }));
          return {
            configuredTool: tool({
              name: 'cancel_projection',
              description: 'fixture',
              input: z.object({}),
              handler,
              toModelOutput: () => {
                controller.abort('projection cancelled');
                return 'projected';
              },
            }),
            handler,
          };
        },
      },
      {
        label: 'serialization',
        phase: 'serialization',
        create(controller: AbortController) {
          const handler = vi.fn(() => ({
            toJSON: () => {
              controller.abort('serialization cancelled');
              return { complete: true };
            },
          }));
          return {
            configuredTool: tool({
              name: 'cancel_serialization',
              description: 'fixture',
              input: z.object({}),
              handler,
            }),
            handler,
          };
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const controller = new AbortController();
      const laterHandler = vi.fn();
      const configured = scenario.create(controller);
      const later = tool({
        name: `later_${scenario.phase}`,
        description: 'must not execute',
        input: z.object({}),
        handler: laterHandler,
      });
      const harness = setup({
        configuredTools: [configured.configuredTool, later],
        toolCalls: [
          {
            id: `cancel-${scenario.phase}`,
            type: 'function',
            function: { name: configured.configuredTool.name, arguments: '{}' },
          },
          {
            id: `later-${scenario.phase}`,
            type: 'function',
            function: { name: later.name, arguments: '{}' },
          },
        ],
        signal: controller.signal,
        awaitHumanHandler:
          'awaitHumanHandler' in configured
            ? configured.awaitHumanHandler
            : async () => ({ approved: true }),
      });

      await expect(harness.ctx.ask(harness.testAgent, scenario.label)).rejects.toMatchObject({
        name: 'AbortError',
      });

      expect(harness.provider.calls, scenario.label).toHaveLength(1);
      expect(laterHandler, scenario.label).not.toHaveBeenCalled();
      expect(
        harness.events.filter((event) => event.type === 'tool_call_start'),
        scenario.label,
      ).toHaveLength(1);
      const ends = harness.events.filter((event) => event.type === 'tool_call_end');
      expect(ends, scenario.label).toHaveLength(1);
      expect(ends[0], scenario.label).toMatchObject({
        callId: `cancel-${scenario.phase}`,
        data: { outcome: { status: 'cancelled', cancellation: { phase: scenario.phase } } },
      });
      if ('expectedHandlerCalls' in configured) {
        expect(configured.handler, scenario.label).toHaveBeenCalledTimes(
          configured.expectedHandlerCalls,
        );
      }
    }
  });

  it('isolates ordinary trace listener throws from the lifecycle outcome', async () => {
    const configuredTool = tool({
      name: 'stable',
      description: 'fixture',
      input: z.object({}),
      handler: () => ({ ok: true }),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = setup({
      configuredTool,
      onTrace: (event) => {
        if (event.type === 'tool_call_start' || event.type === 'tool_call_end') {
          throw new Error('listener failed');
        }
      },
    });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).resolves.toBe('done');
    expect(lifecycle(harness.events).map((event) => event.type)).toEqual([
      'tool_call_start',
      'tool_call_end',
    ]);
    expect(providerToolMessage(harness.provider).content).toBe('{"ok":true}');
    error.mockRestore();
  });

  it('isolates execution arguments from synchronous trace mutation', async () => {
    const handler = vi.fn((input: { value: string }) => input);
    const configuredTool = tool({
      name: 'isolated_args',
      description: 'fixture',
      input: z.object({ value: z.string() }),
      handler,
    });
    const harness = setup({
      configuredTool,
      arguments: '{"value":"original"}',
      onTrace: (event) => {
        if (event.type === 'tool_call_start') {
          (event.data.args as { value: unknown }).value = () => 'hostile';
        }
      },
    });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).resolves.toBe('done');
    expect(handler).toHaveBeenCalledWith({ value: 'original' }, expect.any(WorkflowContext));
    expect(lifecycle(harness.events).at(-1)).toMatchObject({
      type: 'tool_call_end',
      data: {
        args: { value: 'original' },
        outcome: { status: 'succeeded', result: { value: 'original' } },
      },
    });
  });

  it('settles hostile thrown values whose diagnostic getters throw', async () => {
    const hostile = new Error('hidden');
    Object.defineProperties(hostile, {
      name: {
        get: () => {
          throw new Error('name getter');
        },
        configurable: true,
      },
      message: {
        get: () => {
          throw new Error('message getter');
        },
        configurable: true,
      },
    });
    const configuredTool = tool({
      name: 'hostile_error',
      description: 'fixture',
      input: z.object({}),
      handler: () => {
        throw hostile;
      },
    });
    const harness = setup({ configuredTool });

    await harness.ctx.ask(harness.testAgent, 'go').catch(() => undefined);
    expect(lifecycle(harness.events)).toHaveLength(2);
    expect(lifecycle(harness.events)[1]).toMatchObject({
      type: 'tool_call_end',
      data: {
        outcome: {
          status: 'failed',
          failure: { error: { name: 'Error', message: 'Unknown error' } },
        },
      },
    });
  });
});
