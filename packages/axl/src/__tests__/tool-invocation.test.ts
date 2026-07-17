import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolFailure } from '../errors.js';
import { EventStreamOverflowError } from '../event-stream.js';
import {
  executeAcceptedTool,
  parseToolInvocation,
  recordToolSpanOutcome,
  settleAcceptedTool,
} from '../tool-invocation.js';
import { tool } from '../tool.js';
import type { WorkflowContext } from '../context.js';
import type { ToolCallMessage } from '../types.js';

const context = {} as WorkflowContext;
const createChildContext = () => context;
const approved = async () => ({ approved: true });

function call(name: string, args = '{}'): ToolCallMessage {
  return {
    id: 'call-1',
    type: 'function',
    function: { name, arguments: args },
  };
}

function accepted(
  configuredTool: ReturnType<typeof tool>,
  args = '{}',
): Exclude<ReturnType<typeof parseToolInvocation>, { kind: 'rejected' }> {
  const invocation = parseToolInvocation({
    toolCall: call(configuredTool.name, args),
    configuredTool,
    availableTools: [configuredTool.name],
  });
  if ('kind' in invocation) throw new Error('Expected accepted invocation');
  return invocation;
}

describe('v2 tool invocation seams', () => {
  it('rejects unavailable, malformed, and invalid requests before acceptance', () => {
    expect(
      parseToolInvocation({
        toolCall: call('missing', '{bad'),
        availableTools: ['lookup'],
      }),
    ).toMatchObject({
      kind: 'rejected',
      toolName: 'missing',
      data: { reason: 'unavailable', requestedTool: 'missing', availableTools: ['lookup'] },
    });

    const lookup = tool({
      name: 'lookup',
      description: 'fixture',
      input: z.object({ id: z.string() }),
      handler: ({ id }) => id,
    });
    expect(
      parseToolInvocation({
        toolCall: call('lookup', '{bad'),
        configuredTool: lookup,
        availableTools: ['lookup'],
      }),
    ).toMatchObject({ kind: 'rejected', data: { reason: 'invalid_json' } });
    expect(
      parseToolInvocation({
        toolCall: call('lookup', '{"id":1}'),
        configuredTool: lookup,
        availableTools: ['lookup'],
      }),
    ).toMatchObject({
      kind: 'rejected',
      data: {
        reason: 'invalid_arguments',
        args: { id: 1 },
        issues: [{ path: ['id'], code: 'invalid_type' }],
      },
    });
  });

  it('keeps configured overrides schema-agnostic and invokes them without a receiver', async () => {
    let receiver: unknown = 'not-called';
    const override = function (this: unknown): Promise<unknown> {
      receiver = this;
      return Promise.resolve({ mocked: true });
    };
    const invocation = parseToolInvocation({
      toolCall: call('unconfigured', '{"anything":true}'),
      override,
      availableTools: [],
    });
    if ('kind' in invocation) throw new Error('Expected accepted override');

    const outcome = await executeAcceptedTool({
      invocation,
      context,
      requestApproval: approved,
      createChildContext,
    });

    expect(receiver).toBeUndefined();
    expect(outcome).toEqual({ kind: 'succeeded', result: { mocked: true } });
  });

  it('treats returned error-shaped values as success and runs after hooks', async () => {
    const after = vi.fn((value: { error: string }) => ({ ...value, observed: true }));
    const configuredTool = tool({
      name: 'business_result',
      description: 'fixture',
      input: z.object({}),
      handler: () => ({ error: 'declined' }),
      hooks: { after },
    });

    const settlement = await settleAcceptedTool({
      invocation: accepted(configuredTool),
      context,
      requestApproval: approved,
      createChildContext,
    });

    expect(after).toHaveBeenCalledWith({ error: 'declined' }, context);
    expect(settlement).toEqual({
      outcome: { status: 'succeeded', result: { error: 'declined', observed: true } },
      providerContent: '{"error":"declined","observed":true}',
    });
  });

  it('continues only explicit ToolFailure and retains host diagnostics', async () => {
    const cause = new Error('database secret');
    const configuredTool = tool({
      name: 'recoverable',
      description: 'fixture',
      input: z.object({}),
      handler: () => {
        throw new ToolFailure({
          message: 'host diagnostic',
          modelMessage: 'Choose another account.',
          code: 'ACCOUNT_UNAVAILABLE',
          cause,
        });
      },
    });

    const settlement = await settleAcceptedTool({
      invocation: accepted(configuredTool),
      context,
      requestApproval: approved,
      createChildContext,
    });

    expect(settlement.providerContent).toBe('Choose another account.');
    expect(settlement.abortError).toBeUndefined();
    expect(settlement.outcome).toMatchObject({
      status: 'failed',
      failure: {
        phase: 'handler',
        kind: 'tool_failure',
        disposition: 'continue',
        attempts: 1,
        error: {
          name: 'ToolFailure',
          message: 'host diagnostic',
          code: 'ACCOUNT_UNAVAILABLE',
          cause,
        },
      },
    });
  });

  it('distinguishes approval infrastructure failure and aborts without provider content', async () => {
    const configuredTool = tool({
      name: 'approval_failure',
      description: 'fixture',
      input: z.object({}),
      requireApproval: true,
      handler: vi.fn(),
    });
    const infrastructureError = new Error('approval service unavailable');

    const settlement = await settleAcceptedTool({
      invocation: accepted(configuredTool),
      context,
      requestApproval: async () => {
        throw infrastructureError;
      },
      createChildContext,
    });

    expect(settlement).toMatchObject({
      outcome: {
        status: 'failed',
        failure: { phase: 'approval', kind: 'infrastructure', disposition: 'abort' },
      },
      abortError: infrastructureError,
    });
    expect(settlement.providerContent).toBeUndefined();
  });

  it('aborts unexpected handler and output failures without provider content', async () => {
    const handlerError = new Error('handler secret');
    const throws = tool({
      name: 'throws',
      description: 'fixture',
      input: z.object({}),
      handler: () => {
        throw handlerError;
      },
    });
    const handlerSettlement = await settleAcceptedTool({
      invocation: accepted(throws),
      context,
      requestApproval: approved,
      createChildContext,
    });
    expect(handlerSettlement).toMatchObject({
      outcome: {
        status: 'failed',
        failure: { phase: 'handler', kind: 'unexpected', disposition: 'abort' },
      },
      abortError: handlerError,
    });
    expect(handlerSettlement.providerContent).toBeUndefined();

    const projectionError = new Error('projection secret');
    const projected = tool({
      name: 'projected',
      description: 'fixture',
      input: z.object({}),
      handler: () => ({ private: true }),
      toModelOutput: () => {
        throw projectionError;
      },
    });
    const projectionSettlement = await settleAcceptedTool({
      invocation: accepted(projected),
      context,
      requestApproval: approved,
      createChildContext,
    });
    expect(projectionSettlement).toMatchObject({
      outcome: {
        status: 'failed',
        failure: { phase: 'projection', kind: 'output', disposition: 'abort' },
      },
    });
    expect(projectionSettlement.abortError).toBeInstanceOf(Error);
    expect(projectionSettlement.providerContent).toBeUndefined();
  });

  it('maps terminal outcomes to structural span attributes only', () => {
    const span = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      addEvent: vi.fn(),
      end: vi.fn(),
    };
    recordToolSpanOutcome(span, {
      status: 'failed',
      failure: {
        phase: 'handler',
        kind: 'unexpected',
        disposition: 'abort',
        attempts: 1,
        error: { name: 'Error', message: 'must not reach telemetry' },
      },
    });

    expect(span.setAttribute).toHaveBeenCalledWith('axl.tool.outcome', 'failed');
    expect(span.setAttribute).toHaveBeenCalledWith('axl.tool.phase', 'handler');
    expect(span.setStatus).toHaveBeenCalledWith('error');
    expect(JSON.stringify(span.setAttribute.mock.calls)).not.toContain('must not reach telemetry');
  });

  it.each([
    'approval',
    'before_hook',
    'handler',
    'after_handler',
    'after_hook',
    'projection',
    'serialization',
  ] as const)('classifies cancellation during %s and returns an AbortError', async (phase) => {
    const controller = new AbortController();
    const abort = () => controller.abort(`${phase} cancelled`);
    const mapper = vi.fn(() => {
      if (phase === 'projection') abort();
      return 'safe';
    });
    const configuredTool = tool({
      name: `cancel_${phase}`,
      description: 'cancellation fixture',
      input: z.object({}),
      requireApproval: phase === 'approval',
      retry: { attempts: 3, backoff: 'none' },
      hooks: {
        ...(phase === 'before_hook'
          ? {
              before: (input: Record<string, never>) => {
                abort();
                return input;
              },
            }
          : {}),
        ...(phase === 'after_hook'
          ? {
              after: (result: unknown) => {
                abort();
                return result;
              },
            }
          : {}),
      },
      handler: () => {
        if (phase === 'handler') throw new DOMException('cancelled', 'AbortError');
        if (phase === 'after_handler') abort();
        if (phase === 'serialization') {
          return {
            toJSON: () => {
              abort();
              return { safe: true };
            },
          };
        }
        return { raw: true };
      },
      ...(phase === 'projection' ? { toModelOutput: mapper } : {}),
    });

    const settlement = await settleAcceptedTool({
      invocation: accepted(configuredTool),
      context,
      signal: controller.signal,
      requestApproval: async () => {
        abort();
        return { approved: true };
      },
      createChildContext,
    });

    expect(settlement.outcome).toMatchObject({
      status: 'cancelled',
      cancellation: { phase },
    });
    expect(settlement.abortError).toMatchObject({ name: 'AbortError' });
    expect(settlement.providerContent).toBeUndefined();
  });

  it('never retries AbortError or an abort triggered by the retry predicate', async () => {
    const abortHandler = vi.fn(() => {
      throw new DOMException('cancelled', 'AbortError');
    });
    const abortTool = tool({
      name: 'abort_retry',
      description: 'fixture',
      input: z.object({}),
      retry: { attempts: 3, backoff: 'none' },
      handler: abortHandler,
    });
    const first = await settleAcceptedTool({
      invocation: accepted(abortTool),
      context,
      requestApproval: approved,
      createChildContext,
    });
    expect(first.outcome).toMatchObject({
      status: 'cancelled',
      cancellation: { phase: 'handler' },
    });
    expect(abortHandler).toHaveBeenCalledOnce();

    const controller = new AbortController();
    const retryingHandler = vi.fn(() => {
      throw new Error('retryable');
    });
    const backoffTool = tool({
      name: 'abort_backoff',
      description: 'fixture',
      input: z.object({}),
      retry: {
        attempts: 3,
        backoff: 'linear',
        on: () => {
          controller.abort('stop backoff');
          return true;
        },
      },
      handler: retryingHandler,
    });
    const second = await settleAcceptedTool({
      invocation: accepted(backoffTool),
      context,
      signal: controller.signal,
      requestApproval: approved,
      createChildContext,
    });
    expect(second.outcome).toMatchObject({
      status: 'cancelled',
      cancellation: { phase: 'handler' },
    });
    expect(retryingHandler).toHaveBeenCalledOnce();
  });

  it('preserves cancellation precedence over an MCP protocol error', async () => {
    const controller = new AbortController();
    const invocation = parseToolInvocation({
      toolCall: call('remote'),
      mcpCall: async () => {
        controller.abort('cancel MCP');
        return { isError: true, content: [{ type: 'text', text: 'protocol failure' }] };
      },
      mcpTraceName: 'server:remote',
      availableTools: ['remote'],
    });
    if ('kind' in invocation) throw new Error('Expected accepted MCP invocation');

    const settlement = await settleAcceptedTool({
      invocation,
      context,
      signal: controller.signal,
      requestApproval: approved,
      createChildContext,
    });

    expect(settlement.outcome).toMatchObject({
      status: 'cancelled',
      cancellation: { phase: 'after_handler' },
    });
    expect(settlement.providerContent).toBeUndefined();
  });

  it('does not reinterpret strict observation overflow as approval failure', async () => {
    const configuredTool = tool({
      name: 'approval_overflow',
      description: 'fixture',
      input: z.object({}),
      requireApproval: true,
      handler: () => 'unused',
    });
    const overflow = new EventStreamOverflowError(1, 'tool_approval');

    await expect(
      settleAcceptedTool({
        invocation: accepted(configuredTool),
        context,
        requestApproval: async () => {
          throw overflow;
        },
        createChildContext,
      }),
    ).rejects.toBe(overflow);
  });
});
