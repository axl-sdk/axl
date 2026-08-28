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
import { zodToJsonSchema, type WorkflowContext } from '../context.js';
import type { ToolCallMessage, ToolCallOutcome } from '../types.js';

const context = {} as WorkflowContext;
const createChildContext = () => context;
const approved = async () => ({ approved: true });

function localParserOptions(configuredTool: ReturnType<typeof tool>) {
  return {
    configuredTool,
    providerVisibleSchema: zodToJsonSchema(configuredTool.inputSchema),
  };
}

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
    ...localParserOptions(configuredTool),
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
        ...localParserOptions(lookup),
        availableTools: ['lookup'],
      }),
    ).toMatchObject({ kind: 'rejected', data: { reason: 'invalid_json' } });
    expect(
      parseToolInvocation({
        toolCall: call('lookup', '{"id":1}'),
        ...localParserOptions(lookup),
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

    for (const argumentsJson of ['null', '[]', '"text"', '42']) {
      expect(
        parseToolInvocation({
          toolCall: call('unconfigured', argumentsJson),
          override: async () => ({ mocked: true }),
          availableTools: [],
        }),
      ).toMatchObject({
        kind: 'rejected',
        data: { reason: 'invalid_json' },
      });
    }
  });

  it('renders actionable structural feedback for common schema mismatches', () => {
    const optionalNull = tool({
      name: 'optional_null',
      description: 'fixture',
      input: z.object({ note: z.string().optional() }),
      handler: () => 'unused',
    });
    const nullRejection = parseToolInvocation({
      toolCall: call(optionalNull.name, '{"note":null}'),
      ...localParserOptions(optionalNull),
      availableTools: [optionalNull.name],
    });
    expect('kind' in nullRejection ? nullRejection.modelMessage : '').toMatch(/\/note/);
    expect('kind' in nullRejection ? nullRejection.modelMessage : '').toMatch(/string/i);

    const numberTool = tool({
      name: 'number_input',
      description: 'fixture',
      input: z.object({ count: z.number() }),
      handler: () => 'unused',
    });
    const numberRejection = parseToolInvocation({
      toolCall: call(numberTool.name, '{"count":"12"}'),
      ...localParserOptions(numberTool),
      availableTools: [numberTool.name],
    });
    expect('kind' in numberRejection ? numberRejection.modelMessage : '').toMatch(/\/count/);
    expect('kind' in numberRejection ? numberRejection.modelMessage : '').toMatch(/number/i);
    expect('kind' in numberRejection ? numberRejection.modelMessage : '').not.toContain('12');

    const choiceTool = tool({
      name: 'choice_input',
      description: 'fixture',
      input: z.object({
        unit: z.union([z.literal('km'), z.literal('mi')]),
        value: z.union([z.string(), z.number()]),
      }),
      handler: () => 'unused',
    });
    const choiceRejection = parseToolInvocation({
      toolCall: call(choiceTool.name, '{"unit":"yards","value":{}}'),
      ...localParserOptions(choiceTool),
      availableTools: [choiceTool.name],
    });
    const choiceMessage = 'kind' in choiceRejection ? choiceRejection.modelMessage : '';
    expect(choiceMessage).toMatch(/\/unit/);
    expect(choiceMessage).toMatch(/km/);
    expect(choiceMessage).toMatch(/mi/);
    expect(choiceMessage).toMatch(/\/value/);
    expect(choiceMessage).toMatch(/string/i);
    expect(choiceMessage).toMatch(/number/i);
    expect(choiceMessage).not.toContain('yards');
  });

  it('escapes nested RFC 6901 paths and excludes rejected values and custom diagnostics', () => {
    const rejectedValue = 'REJECTED_ARGUMENT_SECRET';
    const customMessage = 'CUSTOM_VALIDATION_SECRET';
    const pattern = 'REGEX_PATTERN_SECRET';
    const pathKey = 'a/b~c\nline';
    const configuredTool = tool({
      name: 'nested_diagnostics',
      description: 'fixture',
      input: z.object({
        items: z.array(
          z.object({
            [pathKey]: z.string().regex(new RegExp(pattern), customMessage),
          }),
        ),
      }),
      handler: () => 'unused',
    });
    const rejection = parseToolInvocation({
      toolCall: call(
        configuredTool.name,
        JSON.stringify({ items: [{ [pathKey]: rejectedValue }] }),
      ),
      ...localParserOptions(configuredTool),
      availableTools: [configuredTool.name],
    });
    const message = 'kind' in rejection ? rejection.modelMessage : '';

    expect(message).toContain('/items/<index>/a~1b~0c\\nline');
    expect(message).not.toContain(rejectedValue);
    expect(message).not.toContain(customMessage);
    expect(message).not.toContain(pattern);
    expect(message).not.toContain(pathKey);
  });

  it('derives feedback only from the provider-visible schema when Zod issues are forged', () => {
    const issueSecret = 'FORGED_ZOD_ISSUE_SECRET';
    const forgedPath = 'FORGED_ZOD_PATH_SECRET';
    const configuredTool = tool({
      name: 'forged_diagnostics',
      description: 'fixture',
      input: z
        .object({
          unit: z.enum(['km', 'mi']),
          amount: z.number().multipleOf(4),
          name: z.string().min(3),
          value: z.union([z.string(), z.number()]),
        })
        .superRefine((_value, ctx) => {
          ctx.addIssue({ code: 'invalid_value', path: ['unit'], values: [issueSecret] } as never);
          ctx.addIssue({
            code: 'too_small',
            path: ['name'],
            origin: 'number',
            minimum: 999_999,
          } as never);
          ctx.addIssue({
            code: 'not_multiple_of',
            path: ['amount'],
            divisor: 999_999,
          } as never);
          ctx.addIssue({
            code: 'invalid_union',
            path: ['value'],
            errors: [[{ code: 'custom', path: [issueSecret], message: issueSecret }]],
          } as never);
          ctx.addIssue({ code: 'custom', path: [forgedPath], params: { issueSecret } } as never);
        }),
      handler: () => 'unused',
    });
    const rejection = parseToolInvocation({
      toolCall: call(configuredTool.name, '{"unit":"km","amount":4,"name":"valid","value":"ok"}'),
      ...localParserOptions(configuredTool),
      availableTools: [configuredTool.name],
    });
    const message = 'kind' in rejection ? rejection.modelMessage : '';

    expect(message).toMatch(/\/unit/);
    expect(message).toMatch(/km/);
    expect(message).toMatch(/mi/);
    expect(message).toMatch(/\/name/);
    expect(message).toMatch(/3/);
    expect(message).toMatch(/\/amount/);
    expect(message).toMatch(/multiple of 4/);
    expect(message).toMatch(/\/value/);
    expect(message).toMatch(/string/);
    expect(message).toMatch(/number/);
    expect(message).toContain('<path omitted>');
    expect(message).not.toContain(issueSecret);
    expect(message).not.toContain(forgedPath);
    expect(message).not.toContain('999999');
  });

  it('masks dynamic record keys and escapes provider-visible controls', () => {
    const dynamicKey = 'DYNAMIC_RECORD_KEY_SECRET';
    const recordTool = tool({
      name: 'record_key',
      description: 'fixture',
      input: z.record(z.string(), z.string()),
      handler: () => 'unused',
    });
    const recordRejection = parseToolInvocation({
      toolCall: call(recordTool.name, JSON.stringify({ [dynamicKey]: 1 })),
      ...localParserOptions(recordTool),
      availableTools: [recordTool.name],
    });
    const recordMessage = 'kind' in recordRejection ? recordRejection.modelMessage : '';
    expect(recordMessage).toContain('/<key>');
    expect(recordMessage).not.toContain(dynamicKey);

    const dynamicIndex = 123_456_789;
    const arrayTool = tool({
      name: 'array_index',
      description: 'fixture',
      input: z.object({ items: z.array(z.string()) }).superRefine((_value, ctx) => {
        ctx.addIssue({ code: 'custom', path: ['items', dynamicIndex] });
      }),
      handler: () => 'unused',
    });
    const arrayRejection = parseToolInvocation({
      toolCall: call(arrayTool.name, '{"items":[]}'),
      ...localParserOptions(arrayTool),
      availableTools: [arrayTool.name],
    });
    const arrayMessage = 'kind' in arrayRejection ? arrayRejection.modelMessage : '';
    expect(arrayMessage).toContain('/items/<index>');
    expect(arrayMessage).not.toContain(String(dynamicIndex));

    const controlledPath = `safe\u2028path\u2029\u202e`;
    const controlledLiteral = `safe\u061cvalue\u2069`;
    const controlsTool = tool({
      name: 'schema_controls',
      description: 'fixture',
      input: z.object({ [controlledPath]: z.enum([controlledLiteral]) }),
      handler: () => 'unused',
    });
    const controlsRejection = parseToolInvocation({
      toolCall: call(controlsTool.name, JSON.stringify({ [controlledPath]: 'wrong' })),
      ...localParserOptions(controlsTool),
      availableTools: [controlsTool.name],
    });
    const controlsMessage = 'kind' in controlsRejection ? controlsRejection.modelMessage : '';
    expect(controlsMessage).toContain('\\u2028');
    expect(controlsMessage).toContain('\\u2029');
    expect(controlsMessage).toContain('\\u202e');
    expect(controlsMessage).toContain('\\u061c');
    expect(controlsMessage).toContain('\\u2069');
    expect(controlsMessage).not.toContain('\u2028');
    expect(controlsMessage).not.toContain('\u2029');
    expect(controlsMessage).not.toContain('\u202e');
    expect(controlsMessage).not.toContain('\u061c');
    expect(controlsMessage).not.toContain('\u2069');
  });

  it('bounds multiple structural issues and marks omitted issues', () => {
    const input = z.object(
      Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field${index}`, z.string()])),
    );
    const configuredTool = tool({
      name: 'many_issues',
      description: 'fixture',
      input,
      handler: () => 'unused',
    });
    const rejection = parseToolInvocation({
      toolCall: call(configuredTool.name, '{}'),
      ...localParserOptions(configuredTool),
      availableTools: [configuredTool.name],
    });
    const message = 'kind' in rejection ? rejection.modelMessage : '';
    const issueLines = message.split('\n').filter((line) => /^\s*-\s/.test(line));

    expect(issueLines.length).toBeLessThanOrEqual(8);
    expect(message.length).toBeLessThanOrEqual(2_000);
    expect(message).toMatch(/additional|omitted|more/i);
  });

  it('reports string-length limits by path and keeps clone and unknown failures generic', () => {
    const boundedTool = tool({
      name: 'bounded_nested_string',
      description: 'fixture',
      input: z.object({ items: z.array(z.string()) }),
      maxStringLength: 4,
      handler: () => 'unused',
    });
    const boundedRejection = parseToolInvocation({
      toolCall: call(
        boundedTool.name,
        JSON.stringify({ items: ['ok', 'TOO_LONG_REJECTED_VALUE'] }),
      ),
      ...localParserOptions(boundedTool),
      availableTools: [boundedTool.name],
    });
    const boundedMessage = 'kind' in boundedRejection ? boundedRejection.modelMessage : '';
    expect(boundedMessage).toMatch(/\/items\/<index>/);
    expect(boundedMessage).toMatch(/4/);
    expect(boundedMessage).toMatch(/maximum|max|limit/i);
    expect(boundedMessage).not.toContain('TOO_LONG_REJECTED_VALUE');

    const cloneTool = tool({
      name: 'clone_failure',
      description: 'fixture',
      input: z.object({}).transform(() => ({ nonCloneable: () => 'private' })),
      handler: () => 'unused',
    });
    const cloneRejection = parseToolInvocation({
      toolCall: call(cloneTool.name),
      ...localParserOptions(cloneTool),
      availableTools: [cloneTool.name],
    });
    expect('kind' in cloneRejection ? cloneRejection.modelMessage : '').toBe(
      'Error: Tool arguments are invalid. Correct the arguments and try again.',
    );

    const unknownTool = tool({
      name: 'unknown_failure',
      description: 'fixture',
      input: z.object({}).transform(() => {
        throw new Error('UNKNOWN_FAILURE_SECRET');
      }),
      handler: () => 'unused',
    });
    const unknownRejection = parseToolInvocation({
      toolCall: call(unknownTool.name),
      ...localParserOptions(unknownTool),
      availableTools: [unknownTool.name],
    });
    const unknownMessage = 'kind' in unknownRejection ? unknownRejection.modelMessage : '';
    expect(unknownMessage).toBe(
      'Error: Tool arguments are invalid. Correct the arguments and try again.',
    );
    expect(unknownMessage).not.toContain('UNKNOWN_FAILURE_SECRET');
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

  it.each([
    {
      phase: 'approval',
      kind: 'infrastructure',
      disposition: 'abort',
      error: { name: 'Error', message: 'private approval', cause: 'private cause' },
    },
    {
      phase: 'before_hook',
      kind: 'tool_failure',
      disposition: 'continue',
      error: { name: 'ToolFailure', message: 'private before', cause: 'private cause' },
    },
    {
      phase: 'before_hook',
      kind: 'unexpected',
      disposition: 'abort',
      error: { name: 'Error', message: 'private before', cause: 'private cause' },
    },
    {
      phase: 'handler',
      kind: 'tool_failure',
      disposition: 'continue',
      attempts: 1,
      error: { name: 'ToolFailure', message: 'private handler', cause: 'private cause' },
    },
    {
      phase: 'handler',
      kind: 'mcp_error',
      disposition: 'continue',
      attempts: 1,
      error: { name: 'McpToolError', message: 'private remote', cause: 'private cause' },
    },
    {
      phase: 'handler',
      kind: 'unexpected',
      disposition: 'abort',
      attempts: 3,
      error: { name: 'Error', message: 'private handler', cause: 'private cause' },
    },
    {
      phase: 'after_hook',
      kind: 'tool_failure',
      disposition: 'continue',
      result: { private: 'result' },
      error: { name: 'ToolFailure', message: 'private after', cause: 'private cause' },
    },
    {
      phase: 'after_hook',
      kind: 'unexpected',
      disposition: 'abort',
      result: { private: 'result' },
      error: { name: 'Error', message: 'private after', cause: 'private cause' },
    },
    {
      phase: 'projection',
      kind: 'output',
      disposition: 'abort',
      result: { private: 'result' },
      error: {
        name: 'ToolModelOutputError',
        message: 'private projection',
        cause: 'private cause',
      },
    },
    {
      phase: 'serialization',
      kind: 'output',
      disposition: 'abort',
      result: { private: 'result' },
      error: { name: 'TypeError', message: 'private serialization', cause: 'private cause' },
    },
  ] as const)(
    'maps $phase/$kind failures to structural span attributes without disclosure',
    (failure) => {
      const span = {
        setAttribute: vi.fn(),
        setStatus: vi.fn(),
        addEvent: vi.fn(),
        end: vi.fn(),
      };
      const outcome = { status: 'failed', failure } as ToolCallOutcome;

      recordToolSpanOutcome(span, outcome);

      expect(span.setAttribute).toHaveBeenCalledWith('axl.tool.outcome', 'failed');
      expect(span.setAttribute).toHaveBeenCalledWith('axl.tool.success', false);
      expect(span.setAttribute).toHaveBeenCalledWith('axl.tool.phase', failure.phase);
      expect(span.setStatus).toHaveBeenCalledWith('error');
      expect(span.setAttribute.mock.calls).toEqual([
        ['axl.tool.outcome', 'failed'],
        ['axl.tool.success', false],
        ['axl.tool.phase', failure.phase],
      ]);
      expect(span.addEvent.mock.calls).toEqual([]);
      expect(
        JSON.stringify({
          attributes: span.setAttribute.mock.calls,
          status: span.setStatus.mock.calls,
          events: span.addEvent.mock.calls,
        }),
      ).not.toContain('private');
    },
  );

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

  it.each(['projection', 'serialization'] as const)(
    'preserves a directly thrown AbortError as %s cancellation',
    async (phase) => {
      const abort = new DOMException(`${phase} cancelled`, 'AbortError');
      const configuredTool = tool({
        name: `throw_abort_${phase}`,
        description: 'throw AbortError while preparing provider output',
        input: z.object({}),
        handler: () =>
          phase === 'serialization'
            ? {
                toJSON: () => {
                  throw abort;
                },
              }
            : { raw: true },
        ...(phase === 'projection'
          ? {
              toModelOutput: () => {
                throw abort;
              },
            }
          : {}),
      });

      const settlement = await settleAcceptedTool({
        invocation: accepted(configuredTool),
        context,
        requestApproval: approved,
        createChildContext,
      });

      expect(settlement.outcome).toMatchObject({
        status: 'cancelled',
        cancellation: { phase, result: expect.anything() },
      });
      expect(settlement.abortError).toBe(abort);
      expect(settlement.providerContent).toBeUndefined();
    },
  );

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

  it.each(['before', 'handler', 'after', 'projection', 'serialization'] as const)(
    'does not reinterpret strict observation overflow in the %s phase',
    async (phase) => {
      const overflow = new EventStreamOverflowError(1, 'log');
      const configuredTool = tool({
        name: `overflow_${phase}`,
        description: 'fixture',
        input: z.object({}),
        ...(phase === 'before'
          ? { hooks: { before: () => Promise.reject(overflow) } }
          : phase === 'after'
            ? { hooks: { after: () => Promise.reject(overflow) } }
            : {}),
        handler: () => {
          if (phase === 'handler') throw overflow;
          if (phase === 'serialization') {
            return {
              toJSON: () => {
                throw overflow;
              },
            };
          }
          return 'result';
        },
        ...(phase === 'projection'
          ? {
              toModelOutput: () => {
                throw overflow;
              },
            }
          : {}),
      });

      await expect(
        settleAcceptedTool({
          invocation: accepted(configuredTool),
          context,
          requestApproval: approved,
          createChildContext,
        }),
      ).rejects.toBe(overflow);
    },
  );
});
