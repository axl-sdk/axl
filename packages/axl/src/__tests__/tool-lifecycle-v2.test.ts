import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { ToolFailure } from '../errors.js';
import { ProviderRegistry } from '../providers/registry.js';
import { tool, type Tool } from '../tool.js';
import type { AxlEvent, ChatMessage, HumanDecision } from '../types.js';
import { createSequenceProvider } from './helpers.js';

function setup(options: {
  configuredTool?: Tool;
  requestedTool?: string;
  arguments?: string;
  decision?: HumanDecision;
  onTrace?: (event: AxlEvent) => void;
  signal?: AbortSignal;
}) {
  const requestedTool = options.requestedTool ?? options.configuredTool?.name ?? 'missing';
  const provider = createSequenceProvider([
    {
      tool_calls: [
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
    onTrace: (event) => {
      events.push(event);
      options.onTrace?.(event);
    },
    ...(options.decision ? { awaitHumanHandler: () => options.decision! } : {}),
  });
  const testAgent = agent({
    name: 'v2-lifecycle',
    model: 'mock:model',
    system: 'test',
    ...(options.configuredTool ? { tools: [options.configuredTool] } : {}),
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
  it('aborts before acceptance without emitting a tool lifecycle event', async () => {
    const controller = new AbortController();
    controller.abort('already cancelled');
    const configuredTool = tool({
      name: 'never_starts',
      description: 'fixture',
      input: z.object({}),
      handler: vi.fn(),
    });
    const harness = setup({ configuredTool, signal: controller.signal });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toBe('already cancelled');
    expect(lifecycle(harness.events)).toEqual([]);
  });

  it('rechecks cancellation after schema validation before acceptance', async () => {
    const controller = new AbortController();
    const configuredTool = tool({
      name: 'cancel_during_validation',
      description: 'fixture',
      input: z.object({}).transform((value) => {
        controller.abort('validation cancelled');
        return value;
      }),
      handler: vi.fn(),
    });
    const harness = setup({ configuredTool, signal: controller.signal });

    await expect(harness.ctx.ask(harness.testAgent, 'go')).rejects.toBe('validation cancelled');
    expect(lifecycle(harness.events)).toEqual([]);
  });

  it.each([
    ['unavailable', { requestedTool: 'missing' }],
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
    ],
  ] as const)('emits one %s rejection with no accepted lifecycle', async (reason, options) => {
    const harness = setup(options);

    await expect(harness.ctx.ask(harness.testAgent, 'go')).resolves.toBe('done');

    expect(lifecycle(harness.events).map((event) => event.type)).toEqual(['tool_call_rejected']);
    expect(lifecycle(harness.events)[0]).toMatchObject({
      schemaVersion: 2,
      type: 'tool_call_rejected',
      callId: 'call-1',
      data: { reason },
    });
    expect(providerToolMessage(harness.provider).content).toBeTruthy();
  });

  it('pairs approval denial and skips hooks and handler', async () => {
    const before = vi.fn();
    const handler = vi.fn();
    const configuredTool = tool({
      name: 'approve_me',
      description: 'fixture',
      input: z.object({}),
      requireApproval: true,
      handler,
      hooks: { before },
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
    expect(handler).not.toHaveBeenCalled();
    expect(providerToolMessage(harness.provider).content).toBe(
      '{"error":"Tool request was denied by human approval."}',
    );
  });

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
