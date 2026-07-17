import { describe, expect, it, vi } from 'vitest';
import {
  captureLegacyToolExecution,
  executeAcceptedToolV1,
  finalizeLegacyToolResult,
  parseToolInvocationV1,
  parseLegacyToolArguments,
  recordLegacyToolSpanResult,
} from '../tool-invocation.js';
import { tool } from '../tool.js';
import { z } from 'zod';
import type { WorkflowContext } from '../context.js';

describe('legacy tool invocation seams', () => {
  it('parses valid JSON and returns a generic message for malformed JSON', () => {
    expect(parseLegacyToolArguments('{"value":1}')).toEqual({ ok: true, args: { value: 1 } });
    expect(parseLegacyToolArguments('{secret')).toEqual({
      ok: false,
      modelMessage: 'Error: Invalid JSON in tool arguments. Please provide valid JSON.',
    });
  });

  it('locks override precedence over availability and malformed-input rejection', () => {
    const override = vi.fn(async () => 'mocked');
    const accepted = parseToolInvocationV1({
      toolCall: {
        id: 'call-1',
        type: 'function',
        function: { name: 'unconfigured', arguments: '{}' },
      },
      override,
      availableTools: [],
    });
    expect('kind' in accepted).toBe(false);
    if ('kind' in accepted) throw new Error('Expected accepted override');
    expect(accepted.source.kind).toBe('override');

    expect(
      parseToolInvocationV1({
        toolCall: {
          id: 'call-2',
          type: 'function',
          function: { name: 'missing', arguments: '{bad' },
        },
        availableTools: [],
      }),
    ).toEqual({ kind: 'unavailable', requestedTool: 'missing', availableTools: [] });
  });

  it('invokes an override without an implicit receiver', async () => {
    let receiver: unknown = 'not-called';
    const override = function (this: unknown): Promise<unknown> {
      receiver = this;
      return Promise.resolve('mocked');
    };
    const invocation = parseToolInvocationV1({
      toolCall: {
        id: 'call-1',
        type: 'function',
        function: { name: 'unconfigured', arguments: '{}' },
      },
      override,
      availableTools: [],
    });
    if ('kind' in invocation) throw new Error('Expected accepted override');

    await executeAcceptedToolV1({
      invocation,
      context: {} as WorkflowContext,
      requestApproval: vi.fn(),
      createChildContext: vi.fn(),
      observeExecution: (execute) => execute(),
    });

    expect(receiver).toBeUndefined();
  });

  it('captures thrown values without changing v1 continuation semantics', async () => {
    await expect(captureLegacyToolExecution(() => ({ error: 'returned' }))).resolves.toEqual({
      kind: 'returned',
      value: { error: 'returned' },
    });
    await expect(
      captureLegacyToolExecution(() => Promise.reject(new Error('thrown'))),
    ).resolves.toEqual({ kind: 'thrown', value: { error: 'thrown' } });
  });

  it('keeps v1 projection and serialization event ordering distinct', () => {
    const emitEnd = vi.fn();
    const projected = tool({
      name: 'projected',
      description: 'fixture',
      input: z.object({}),
      handler: () => ({ complete: true }),
      toModelOutput: () => 'safe',
    });

    expect(
      finalizeLegacyToolResult({
        toolName: 'projected',
        configuredTool: projected,
        outcome: { kind: 'returned', value: { complete: true } },
        legacyContent: () => {
          throw new Error('legacy serializer must not run');
        },
        emitEnd,
        beforeProjection: () => expect(emitEnd).toHaveBeenCalledOnce(),
      }),
    ).toBe('safe');

    const order: string[] = [];
    expect(
      finalizeLegacyToolResult({
        toolName: 'legacy',
        configuredTool: undefined,
        outcome: { kind: 'returned', value: { ok: true } },
        legacyContent: () => {
          order.push('serialize');
          return '{"ok":true}';
        },
        emitEnd: () => order.push('emit'),
        beforeProjection: vi.fn(),
      }),
    ).toBe('{"ok":true}');
    expect(order).toEqual(['serialize', 'emit']);
  });

  it('locks the v1 error-property span heuristic behind one seam', () => {
    const span = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      addEvent: vi.fn(),
      end: vi.fn(),
    };

    recordLegacyToolSpanResult(span, { error: 'business value' }, false);

    expect(span.setAttribute).toHaveBeenCalledWith('axl.tool.success', false);
    expect(span.setStatus).toHaveBeenCalledWith('error', 'business value');
  });
});
