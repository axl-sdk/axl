import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { workflow, agent, tool, ToolFailure, ToolModelOutputError } from '@axlsdk/axl';
import type { AxlEvent, Tool } from '@axlsdk/axl';
import { AxlTestRuntime, MockProvider } from '../index.js';
import type { RecordedToolCall } from '../index.js';

// ── Test Fixtures ────────────────────────────────────────────────────────────

const getOrder = tool({
  name: 'get_order',
  description: 'Look up an order',
  input: z.object({ orderId: z.string() }),
  handler: async ({ orderId }) => ({ id: orderId, status: 'delivered', amount: 49.99 }),
});

const SupportBot = agent({
  model: 'openai:gpt-4-turbo',
  system: 'You are a helpful support agent.',
  tools: [getOrder],
  temperature: 0.7,
});

const HandleSupport = workflow({
  name: 'HandleSupport',
  input: z.object({ msg: z.string() }),
  handler: async (ctx) => {
    const response = await ctx.ask(SupportBot, ctx.input.msg);
    return response;
  },
});

function toolCallResponse(name: string, id = `call-${name}`) {
  return {
    content: '',
    tool_calls: [
      {
        id,
        type: 'function' as const,
        function: { name, arguments: '{}' },
      },
    ],
  };
}

function createToolWorkflow(
  name: string,
  tools: Tool<any, any>[],
  options: { streaming?: boolean } = {},
) {
  const testAgent = agent({
    name: `${name}-agent`,
    model: 'openai:gpt-4o-mini',
    system: 'Use the requested tool.',
    tools,
  });

  return workflow({
    name,
    input: z.object({}),
    handler: async (ctx) => {
      if (options.streaming) void ctx.events;
      return ctx.ask(testAgent, 'Run the tool.');
    },
  });
}

function recordedToolContent(provider: MockProvider): string | undefined {
  return provider.calls[1]?.messages.find((message) => message.role === 'tool')?.content;
}

function succeededResult(call: RecordedToolCall): unknown {
  expect(call.outcome.status).toBe('succeeded');
  if (call.outcome.status !== 'succeeded') {
    throw new Error(`Expected a succeeded tool call, received ${call.outcome.status}`);
  }
  return call.outcome.result;
}

// A workflow with output schema for output validation tests
const StrictWorkflow = workflow({
  name: 'StrictWorkflow',
  input: z.object({ value: z.number() }),
  output: z.object({ doubled: z.number() }),
  handler: async (ctx) => {
    // The handler simply returns a computed value
    return { doubled: ctx.input.value * 2 };
  },
});

// A workflow that returns an invalid output (for testing output validation failure)
const BadOutputWorkflow = workflow({
  name: 'BadOutputWorkflow',
  input: z.object({ value: z.number() }),
  output: z.object({ doubled: z.number() }),
  handler: async (_ctx) => {
    // Returns a string instead of the expected object shape
    return 'not an object' as any;
  },
});

// A simple workflow with no agent calls for basic registration tests
const SimpleWorkflow = workflow({
  name: 'SimpleWorkflow',
  input: z.object({ greeting: z.string() }),
  handler: async (ctx) => {
    ctx.log('received_input', { greeting: ctx.input.greeting });
    return `Hello, ${ctx.input.greeting}!`;
  },
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AxlTestRuntime', () => {
  describe('register and execute', () => {
    it('registers workflow and executes with mock provider', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.sequence([{ content: 'I can help you with that!' }]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      const result = await runtime.execute('HandleSupport', { msg: 'Help me!' });

      expect(result).toBe('I can help you with that!');
    });

    it('throws when executing an unregistered workflow', async () => {
      const runtime = new AxlTestRuntime();

      await expect(runtime.execute('NonExistent', {})).rejects.toThrow(
        /Workflow "NonExistent" not registered/,
      );
    });

    it('executes a simple workflow without agent calls', async () => {
      const runtime = new AxlTestRuntime();
      runtime.register(SimpleWorkflow);

      const result = await runtime.execute('SimpleWorkflow', { greeting: 'World' });

      expect(result).toBe('Hello, World!');
    });
  });

  describe('tool calls', () => {
    it('records tool calls when agent returns tool_calls', async () => {
      const runtime = new AxlTestRuntime();

      const provider = MockProvider.sequence([
        {
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'get_order', arguments: '{"orderId": "123"}' },
            },
          ],
        },
        { content: 'Your order 123 is delivered.' },
      ]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      const result = await runtime.execute('HandleSupport', { msg: 'Where is order 123?' });

      expect(result).toBe('Your order 123 is delivered.');

      const toolCalls = runtime.toolCalls();
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe('get_order');
      expect(toolCalls[0].args).toEqual({ orderId: '123' });
      expect(toolCalls[0]).toMatchObject({
        executionId: expect.stringMatching(/^test-/),
        askId: expect.any(String),
        callId: 'call-1',
      });
      expect(succeededResult(toolCalls[0])).toEqual({
        id: '123',
        status: 'delivered',
        amount: 49.99,
      });
    });

    it('filters tool calls by name', async () => {
      const runtime = new AxlTestRuntime();

      const provider = MockProvider.sequence([
        {
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'get_order', arguments: '{"orderId": "abc"}' },
            },
          ],
        },
        { content: 'Done.' },
      ]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      await runtime.execute('HandleSupport', { msg: 'check' });

      expect(runtime.toolCalls('get_order')).toHaveLength(1);
      expect(runtime.toolCalls('non_existent_tool')).toHaveLength(0);
    });

    it('records denied calls without inventing a successful result', async () => {
      const handler = vi.fn(() => ({ shouldNotRun: true }));
      const approvalTool = tool({
        name: 'approval_required',
        description: 'Require an explicit approval decision',
        input: z.object({}),
        requireApproval: true,
        handler,
      });
      const approvalWorkflow = createToolWorkflow('ApprovalDenied', [approvalTool]);
      const provider = MockProvider.sequence([
        toolCallResponse('approval_required', 'call-denied'),
        { content: 'understood' },
      ]);
      const runtime = new AxlTestRuntime({
        humanDecisions: () => ({ approved: false, reason: 'not in this test' }),
      });
      runtime.register(approvalWorkflow);
      runtime.mockProvider('openai', provider);

      await expect(runtime.execute('ApprovalDenied', {})).resolves.toBe('understood');

      expect(handler).not.toHaveBeenCalled();
      expect(runtime.toolCalls('approval_required')).toEqual([
        expect.objectContaining({
          name: 'approval_required',
          callId: 'call-denied',
          args: {},
          outcome: { status: 'denied', reason: 'not in this test' },
        }),
      ]);
    });
  });

  describe('agent calls', () => {
    it('records agent calls', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.sequence([{ content: 'Sure, I can help.' }]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      await runtime.execute('HandleSupport', { msg: 'I need help' });

      const agentCalls = runtime.agentCalls();
      expect(agentCalls).toHaveLength(1);
      expect(agentCalls[0].prompt).toBe('I need help');
      expect(agentCalls[0].response).toBe('Sure, I can help.');
      // Agent name defaults to model string when no name is provided
      expect(agentCalls[0].agent).toBe('openai:gpt-4-turbo');
    });

    it('filters agent calls by name', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.sequence([{ content: 'response' }]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      await runtime.execute('HandleSupport', { msg: 'test' });

      const calls = runtime.agentCalls();
      expect(calls).toHaveLength(1);

      // Filter by the actual name
      const agentName = calls[0].agent;
      expect(runtime.agentCalls(agentName)).toHaveLength(1);
      expect(runtime.agentCalls('NonExistentAgent')).toHaveLength(0);
    });
  });

  describe('totalCost()', () => {
    it('returns 0 for mocked providers', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.sequence([{ content: 'free response' }]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      await runtime.execute('HandleSupport', { msg: 'hello' });

      expect(runtime.totalCost()).toBe(0);
    });

    it('accumulates cost from replay responses', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.replay([
        {
          content: 'r1',
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          cost: 0.05,
        },
      ]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      await runtime.execute('HandleSupport', { msg: 'hi' });

      expect(runtime.totalCost()).toBe(0.05);
    });
  });

  describe('unpriced()', () => {
    it('reports true when a replayed response has usage but no cost', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.replay([
        {
          content: 'unpriced response',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      await runtime.execute('HandleSupport', { msg: 'hello' });

      expect(runtime.totalCost()).toBe(0);
      expect(runtime.unpriced()).toBe(true);
    });

    it('reports false for a known-free response', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.sequence([{ content: 'free response', cost: 0 }]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      await runtime.execute('HandleSupport', { msg: 'hello' });

      expect(runtime.totalCost()).toBe(0);
      expect(runtime.unpriced()).toBe(false);
    });
  });

  describe('steps()', () => {
    it('returns workflow_start and workflow_end steps', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.sequence([{ content: 'done' }]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      await runtime.execute('HandleSupport', { msg: 'check steps' });

      const steps = runtime.steps();
      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(steps[0].type).toBe('workflow_start');
      // `data` shape comes from `WorkflowStartData` — `{ input }` only;
      // the workflow name is a top-level event field, not inside `data`.
      expect(steps[0].data).toMatchObject({ input: { msg: 'check steps' } });

      const last = steps[steps.length - 1];
      expect(last.type).toBe('workflow_end');
      expect(last.data).toMatchObject({ status: 'completed', result: 'done' });
    });

    it('includes agent_call steps', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.sequence([{ content: 'hi' }]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      await runtime.execute('HandleSupport', { msg: 'test' });

      const agentSteps = runtime.steps().filter((s) => s.type === 'agent_call_end');
      expect(agentSteps).toHaveLength(1);
    });

    it('includes tool_call steps when tools are invoked', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.sequence([
        {
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'get_order', arguments: '{"orderId":"x1"}' },
            },
          ],
        },
        { content: 'Order found.' },
      ]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      await runtime.execute('HandleSupport', { msg: 'find order' });

      const toolSteps = runtime.steps().filter((s) => s.type === 'tool_call_end');
      expect(toolSteps).toHaveLength(1);
      expect(toolSteps[0].data).toMatchObject({
        args: { orderId: 'x1' },
      });
    });

    it('assigns incrementing step numbers', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.sequence([{ content: 'ok' }]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      await runtime.execute('HandleSupport', { msg: 'go' });

      const steps = runtime.steps();
      // Steps should be monotonically increasing
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i].step).toBeGreaterThan(steps[i - 1].step);
      }
    });
  });

  describe('traceLog()', () => {
    it('records log events from the workflow', async () => {
      const runtime = new AxlTestRuntime();
      runtime.register(SimpleWorkflow);

      await runtime.execute('SimpleWorkflow', { greeting: 'Test' });

      const logs = runtime.traceLog();
      expect(logs.length).toBeGreaterThanOrEqual(1);

      const receivedLog = logs.find(
        (l): l is Extract<AxlEvent, { type: 'log' }> =>
          l.type === 'log' && (l.data as any)?.event === 'received_input',
      );
      expect(receivedLog).toBeDefined();
      expect((receivedLog!.data as any).greeting).toEqual('Test');
      expect(receivedLog!.timestamp).toBeGreaterThan(0);
    });

    it('resets trace log between executions', async () => {
      const runtime = new AxlTestRuntime();
      runtime.register(SimpleWorkflow);

      await runtime.execute('SimpleWorkflow', { greeting: 'First' });
      const firstLogs = runtime.traceLog();
      expect(firstLogs.length).toBeGreaterThanOrEqual(1);

      await runtime.execute('SimpleWorkflow', { greeting: 'Second' });
      const secondLogs = runtime.traceLog();

      // Second execution should not include first execution's logs
      const inputs = secondLogs
        .filter(
          (l): l is Extract<AxlEvent, { type: 'log' }> =>
            l.type === 'log' && (l.data as any)?.event === 'received_input',
        )
        .map((l) => (l.data as any).greeting);
      expect(inputs).toEqual(['Second']);
    });
  });

  describe('mockTool()', () => {
    it('overrides real tool handlers', async () => {
      const runtime = new AxlTestRuntime();

      const provider = MockProvider.sequence([
        {
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'get_order', arguments: '{"orderId":"999"}' },
            },
          ],
        },
        { content: 'Order is pending.' },
      ]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      // Override the real get_order tool with a mock that returns different data
      runtime.mockTool('get_order', (input: { orderId: string }) => ({
        id: input.orderId,
        status: 'pending',
        amount: 0,
      }));

      await runtime.execute('HandleSupport', { msg: 'check order 999' });

      const toolCalls = runtime.toolCalls('get_order');
      expect(toolCalls).toHaveLength(1);
      expect(succeededResult(toolCalls[0])).toEqual({
        id: '999',
        status: 'pending',
        amount: 0,
      });
    });

    it('mock tool calls are recorded in toolCalls()', async () => {
      const runtime = new AxlTestRuntime();

      const provider = MockProvider.sequence([
        {
          content: '',
          tool_calls: [
            {
              id: 'call-mock',
              type: 'function',
              function: { name: 'get_order', arguments: '{"orderId":"abc"}' },
            },
          ],
        },
        { content: 'done' },
      ]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);
      runtime.mockTool('get_order', () => ({ mocked: true }));

      await runtime.execute('HandleSupport', { msg: 'go' });

      expect(runtime.toolCalls()).toHaveLength(1);
      expect(runtime.toolCalls()[0].name).toBe('get_order');
      expect(succeededResult(runtime.toolCalls()[0])).toEqual({ mocked: true });
    });

    it('applies configured projection policy while retaining the complete mock result for hosts', async () => {
      const projectedTool = tool({
        name: 'projected_mock',
        description: 'Return a rich result',
        input: z.object({}),
        handler: () => ({ humanMessage: 'real', internalId: 'real-id', payload: [1] }),
        toModelOutput: (output) => ({ message: output.humanMessage }),
      });
      const projectedWorkflow = createToolWorkflow('ProjectedMock', [projectedTool]);
      const provider = MockProvider.sequence([
        toolCallResponse('projected_mock'),
        { content: 'done' },
      ]);
      const completeMockResult = {
        humanMessage: 'ready',
        internalId: 'host-only-id',
        payload: [1, 2, 3],
      };
      const runtime = new AxlTestRuntime();
      runtime.register(projectedWorkflow);
      runtime.mockProvider('openai', provider);
      runtime.mockTool('projected_mock', () => completeMockResult);

      await runtime.execute('ProjectedMock', {});

      const recordedCall = runtime.toolCalls('projected_mock')[0];
      expect(recordedCall).toMatchObject({
        name: 'projected_mock',
        args: {},
        outcome: { status: 'succeeded', result: completeMockResult },
      });
      const toolEnd = runtime
        .traceLog()
        .find((event) => event.type === 'tool_call_end' && event.tool === 'projected_mock');
      expect(toolEnd?.data.outcome).toEqual({ status: 'succeeded', result: completeMockResult });
      expect(recordedToolContent(provider)).toBe('{"message":"ready"}');
      expect(recordedToolContent(provider)).not.toContain('host-only-id');
    });

    it('inherits only projection policy from a configured tool when a mock wins', async () => {
      const handler = vi.fn(() => ({ visible: 'real', hidden: 'real-only' }));
      const before = vi.fn((input) => input);
      const after = vi.fn((output) => output);
      const configuredTool = tool({
        name: 'policy_only_mock',
        description: 'Exercise the exact configured mock boundary',
        input: z.object({ required: z.string() }),
        requireApproval: true,
        retry: { attempts: 3 },
        hooks: { before, after },
        handler,
        toModelOutput: (output) => output.visible,
      });
      const configuredWorkflow = createToolWorkflow('PolicyOnlyMock', [configuredTool]);
      const provider = MockProvider.sequence([
        toolCallResponse('policy_only_mock'),
        { content: 'done' },
      ]);
      const runtime = new AxlTestRuntime({
        humanDecisions: () => {
          throw new Error('approval must remain bypassed');
        },
      });
      runtime.register(configuredWorkflow);
      runtime.mockProvider('openai', provider);
      runtime.mockTool('policy_only_mock', () => ({
        visible: 'mock projection',
        hidden: 'host-only',
      }));

      await runtime.execute('PolicyOnlyMock', {});

      expect(handler).not.toHaveBeenCalled();
      expect(before).not.toHaveBeenCalled();
      expect(after).not.toHaveBeenCalled();
      expect(runtime.toolCalls('policy_only_mock')[0].args).toEqual({});
      expect(succeededResult(runtime.toolCalls('policy_only_mock')[0])).toEqual({
        visible: 'mock projection',
        hidden: 'host-only',
      });
      expect(recordedToolContent(provider)).toBe('mock projection');
    });

    it('keeps JSON parsing at the agent-call boundary before invoking a configured mock', async () => {
      const configuredTool = tool({
        name: 'json_boundary_mock',
        description: 'Reject malformed provider arguments before the override',
        input: z.object({ required: z.string() }),
        handler: () => ({ real: true }),
      });
      const configuredWorkflow = createToolWorkflow('JsonBoundaryMock', [configuredTool]);
      const provider = MockProvider.sequence([
        {
          content: '',
          tool_calls: [
            {
              id: 'call-invalid-json',
              type: 'function',
              function: { name: 'json_boundary_mock', arguments: '{not-json' },
            },
          ],
        },
        { content: 'corrected' },
      ]);
      const runtime = new AxlTestRuntime();
      runtime.register(configuredWorkflow);
      runtime.mockProvider('openai', provider);
      const mock = vi.fn(() => ({ mocked: true }));
      runtime.mockTool('json_boundary_mock', mock);

      await expect(runtime.execute('JsonBoundaryMock', {})).resolves.toBe('corrected');

      expect(mock).not.toHaveBeenCalled();
      expect(runtime.toolCalls('json_boundary_mock')).toEqual([]);
      expect(
        runtime
          .traceLog()
          .find(
            (event) => event.type === 'tool_call_rejected' && event.tool === 'json_boundary_mock',
          ),
      ).toMatchObject({
        callId: 'call-invalid-json',
        data: { reason: 'invalid_json', requestedTool: 'json_boundary_mock' },
      });
    });

    it('lets configured sensitive policy win and skips projection for a mock result', async () => {
      const mapper = vi.fn(() => 'must not be sent');
      const sensitiveTool = tool({
        name: 'sensitive_mock',
        description: 'Return sensitive data',
        input: z.object({}),
        sensitive: true,
        handler: () => ({ secret: 'real' }),
        toModelOutput: mapper,
      });
      const sensitiveWorkflow = createToolWorkflow('SensitiveMock', [sensitiveTool]);
      const provider = MockProvider.sequence([
        toolCallResponse('sensitive_mock'),
        { content: 'done' },
      ]);
      const runtime = new AxlTestRuntime();
      runtime.register(sensitiveWorkflow);
      runtime.mockProvider('openai', provider);
      runtime.mockTool('sensitive_mock', () => ({ secret: 'mock-secret' }));

      await runtime.execute('SensitiveMock', {});

      expect(mapper).not.toHaveBeenCalled();
      expect(succeededResult(runtime.toolCalls('sensitive_mock')[0])).toEqual({
        secret: 'mock-secret',
      });
      expect(recordedToolContent(provider)).toBe('[REDACTED - sensitive tool output]');

      const failureProvider = MockProvider.sequence([
        toolCallResponse('sensitive_mock', 'call-sensitive-failure'),
        { content: 'recovered' },
      ]);
      const failureRuntime = new AxlTestRuntime();
      failureRuntime.register(sensitiveWorkflow);
      failureRuntime.mockProvider('openai', failureProvider);
      failureRuntime.mockTool('sensitive_mock', () => {
        throw new ToolFailure({
          message: 'host-only sensitive failure',
          modelMessage: 'model-safe but still hidden by sensitive policy',
        });
      });

      await expect(failureRuntime.execute('SensitiveMock', {})).resolves.toBe('recovered');

      expect(mapper).not.toHaveBeenCalled();
      expect(failureRuntime.toolCalls('sensitive_mock')[0].outcome).toMatchObject({
        status: 'failed',
        failure: {
          phase: 'handler',
          kind: 'tool_failure',
          disposition: 'continue',
        },
      });
      expect(recordedToolContent(failureProvider)).toBe('[REDACTED - sensitive tool failure]');
      expect(recordedToolContent(failureProvider)).not.toContain('model-safe');
    });

    it('records an unexpected mock throw as failed/handler and aborts the ask', async () => {
      const mapper = vi.fn(() => 'must not run');
      const configuredTool = tool({
        name: 'throwing_mock',
        description: 'Throw from a mock',
        input: z.object({}),
        retry: { attempts: 3 },
        handler: () => ({ ok: true }),
        toModelOutput: mapper,
      });
      const throwingWorkflow = createToolWorkflow('ThrowingMock', [configuredTool]);
      const provider = MockProvider.sequence([
        toolCallResponse('throwing_mock'),
        { content: 'recovered' },
      ]);
      const runtime = new AxlTestRuntime();
      runtime.register(throwingWorkflow);
      runtime.mockProvider('openai', provider);
      const throwingMock = vi.fn(() => {
        throw new Error('mock exploded');
      });
      runtime.mockTool('throwing_mock', throwingMock);

      await expect(runtime.execute('ThrowingMock', {})).rejects.toThrow('mock exploded');

      expect(mapper).not.toHaveBeenCalled();
      expect(throwingMock).toHaveBeenCalledOnce();
      expect(provider.calls).toHaveLength(1);
      expect(runtime.toolCalls('throwing_mock')[0].outcome).toMatchObject({
        status: 'failed',
        failure: {
          phase: 'handler',
          kind: 'unexpected',
          disposition: 'abort',
          attempts: 1,
          error: { name: 'Error', message: 'mock exploded' },
        },
      });
    });

    it('records ToolFailure from a mock as failed/handler and continues with model-safe text', async () => {
      const configuredTool = tool({
        name: 'recoverable_mock',
        description: 'Return a recoverable mock failure',
        input: z.object({ required: z.string() }),
        retry: { attempts: 3 },
        handler: () => ({ ok: true }),
        toModelOutput: () => {
          throw new Error('projection must remain bypassed');
        },
      });
      const recoverableWorkflow = createToolWorkflow('RecoverableMock', [configuredTool]);
      const provider = MockProvider.sequence([
        toolCallResponse('recoverable_mock'),
        { content: 'recovered' },
      ]);
      const runtime = new AxlTestRuntime();
      runtime.register(recoverableWorkflow);
      runtime.mockProvider('openai', provider);
      const recoverableMock = vi.fn(() => {
        throw new ToolFailure({
          message: 'host-only failure detail',
          modelMessage: 'Please choose another input.',
          code: 'MOCK_REJECTED',
        });
      });
      runtime.mockTool('recoverable_mock', recoverableMock);

      await expect(runtime.execute('RecoverableMock', {})).resolves.toBe('recovered');

      expect(recoverableMock).toHaveBeenCalledOnce();
      expect(provider.calls).toHaveLength(2);
      expect(recordedToolContent(provider)).toBe('Please choose another input.');
      expect(runtime.toolCalls('recoverable_mock')[0].outcome).toMatchObject({
        status: 'failed',
        failure: {
          phase: 'handler',
          kind: 'tool_failure',
          disposition: 'continue',
          attempts: 1,
          error: {
            name: 'ToolFailure',
            message: 'host-only failure detail',
            code: 'MOCK_REJECTED',
          },
        },
      });
    });

    it('projects a normally returned error-shaped mock result', async () => {
      const configuredTool = tool({
        name: 'returned_error_mock',
        description: 'Return an error-shaped result',
        input: z.object({}),
        handler: () => ({ error: 'real error', internal: 'real-only' }),
        toModelOutput: (output) => ({ message: output.error }),
      });
      const returnedErrorWorkflow = createToolWorkflow('ReturnedErrorMock', [configuredTool]);
      const provider = MockProvider.sequence([
        toolCallResponse('returned_error_mock'),
        { content: 'done' },
      ]);
      const runtime = new AxlTestRuntime();
      runtime.register(returnedErrorWorkflow);
      runtime.mockProvider('openai', provider);
      runtime.mockTool('returned_error_mock', () => ({
        error: 'mock declined',
        internal: 'host-only',
      }));

      await runtime.execute('ReturnedErrorMock', {});

      expect(succeededResult(runtime.toolCalls('returned_error_mock')[0])).toEqual({
        error: 'mock declined',
        internal: 'host-only',
      });
      expect(recordedToolContent(provider)).toBe('{"message":"mock declined"}');
    });

    it('preserves legacy serialization for an override without a configured tool', async () => {
      const unconfiguredWorkflow = createToolWorkflow('UnconfiguredMock', []);
      const provider = MockProvider.sequence([
        toolCallResponse('unconfigured_override'),
        { content: 'done' },
      ]);
      const runtime = new AxlTestRuntime();
      runtime.register(unconfiguredWorkflow);
      runtime.mockProvider('openai', provider);
      runtime.mockTool('unconfigured_override', () => 'legacy string');

      await runtime.execute('UnconfiguredMock', {});

      expect(succeededResult(runtime.toolCalls('unconfigured_override')[0])).toBe('legacy string');
      expect(recordedToolContent(provider)).toBe('"legacy string"');
    });

    it('sends identical projected mock content in streaming and non-streaming asks', async () => {
      const projectedTool = tool({
        name: 'parity_mock',
        description: 'Project the mock result',
        input: z.object({}),
        handler: () => ({ visible: 'real', hidden: 'real-only' }),
        toModelOutput: (output) => output.visible,
      });
      const nonStreamingWorkflow = createToolWorkflow('NonStreamingProjection', [projectedTool]);
      const streamingWorkflow = createToolWorkflow('StreamingProjection', [projectedTool], {
        streaming: true,
      });
      const nonStreamingProvider = MockProvider.sequence([
        toolCallResponse('parity_mock'),
        { content: 'done' },
      ]);
      const streamingProvider = MockProvider.sequence([
        toolCallResponse('parity_mock'),
        { content: 'done' },
      ]);
      const nonStreamingRuntime = new AxlTestRuntime();
      nonStreamingRuntime.register(nonStreamingWorkflow);
      nonStreamingRuntime.mockProvider('openai', nonStreamingProvider);
      nonStreamingRuntime.mockTool('parity_mock', () => ({
        visible: 'projected text',
        hidden: 'host-only',
      }));
      const streamingRuntime = new AxlTestRuntime();
      streamingRuntime.register(streamingWorkflow);
      streamingRuntime.mockProvider('openai', streamingProvider);
      streamingRuntime.mockTool('parity_mock', () => ({
        visible: 'projected text',
        hidden: 'host-only',
      }));

      await nonStreamingRuntime.execute('NonStreamingProjection', {});
      await streamingRuntime.execute('StreamingProjection', {});

      expect(recordedToolContent(nonStreamingProvider)).toBe('projected text');
      expect(recordedToolContent(streamingProvider)).toBe(
        recordedToolContent(nonStreamingProvider),
      );
    });

    it('includes projected mock content in the next full-trace request snapshot', async () => {
      const projectedTool = tool({
        name: 'full_trace_mock',
        description: 'Project the mock result',
        input: z.object({}),
        handler: () => ({ visible: 'real', hidden: 'real-only' }),
        toModelOutput: (output) => ({ visible: output.visible }),
      });
      const fullTraceWorkflow = createToolWorkflow('FullTraceProjection', [projectedTool]);
      const provider = MockProvider.sequence([
        toolCallResponse('full_trace_mock'),
        { content: 'done' },
      ]);
      const runtime = new AxlTestRuntime({ config: { trace: { level: 'full' } } });
      runtime.register(fullTraceWorkflow);
      runtime.mockProvider('openai', provider);
      runtime.mockTool('full_trace_mock', () => ({
        visible: 'model-visible',
        hidden: 'host-only',
      }));

      await runtime.execute('FullTraceProjection', {});

      const starts = runtime.traceLog().filter((event) => event.type === 'agent_call_start');
      expect(starts).toHaveLength(2);
      const messages = (starts[1].data as Record<string, unknown>).messages as Array<
        Record<string, unknown>
      >;
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: 'tool',
          content: '{"visible":"model-visible"}',
        }),
      );
      expect(JSON.stringify(messages)).not.toContain('host-only');
    });

    it('fails closed after recording the complete mock result when projection fails', async () => {
      const mapper = vi.fn(() => {
        throw new Error('mapper-secret');
      });
      const configuredTool = tool({
        name: 'invalid_projection_mock',
        description: 'Return an invalid projection',
        input: z.object({}),
        handler: () => ({ raw: 'real' }),
        toModelOutput: mapper,
      });
      const failureWorkflow = createToolWorkflow('InvalidProjectionMock', [configuredTool]);
      const provider = MockProvider.sequence([
        toolCallResponse('invalid_projection_mock'),
        { content: 'must not be called' },
      ]);
      const runtime = new AxlTestRuntime();
      runtime.register(failureWorkflow);
      runtime.mockProvider('openai', provider);
      runtime.mockTool('invalid_projection_mock', () => ({ raw: 'host-only' }));

      await expect(runtime.execute('InvalidProjectionMock', {})).rejects.toBeInstanceOf(
        ToolModelOutputError,
      );

      expect(mapper).toHaveBeenCalledOnce();
      expect(provider.calls).toHaveLength(1);
      expect(runtime.toolCalls('invalid_projection_mock')).toHaveLength(1);
      expect(runtime.toolCalls('invalid_projection_mock')[0]).toMatchObject({
        name: 'invalid_projection_mock',
        args: {},
        outcome: {
          status: 'failed',
          failure: {
            phase: 'projection',
            kind: 'output',
            disposition: 'abort',
            result: { raw: 'host-only' },
          },
        },
      });
      expect(
        runtime
          .traceLog()
          .filter(
            (event) => event.type === 'tool_call_end' && event.tool === 'invalid_projection_mock',
          ),
      ).toHaveLength(1);
      expect(runtime.traceLog().find((event) => event.type === 'ask_end')?.outcome).toEqual({
        ok: false,
        error: 'Failed to prepare model output for tool "invalid_projection_mock"',
      });
      const workflowEnd = runtime.traceLog().find((event) => event.type === 'workflow_end');
      expect(workflowEnd?.data).toMatchObject({
        status: 'failed',
        error: 'Failed to prepare model output for tool "invalid_projection_mock"',
      });
      expect(JSON.stringify(workflowEnd)).not.toContain('mapper-secret');
      expect(JSON.stringify(workflowEnd)).not.toContain('host-only');
    });
  });

  describe('input validation', () => {
    it('validates workflow input against schema (throws on invalid)', async () => {
      const runtime = new AxlTestRuntime();
      runtime.register(HandleSupport);

      // HandleSupport expects { msg: string }, passing a number should fail
      await expect(runtime.execute('HandleSupport', { msg: 123 })).rejects.toThrow();
    });

    it('throws when required input fields are missing', async () => {
      const runtime = new AxlTestRuntime();
      runtime.register(HandleSupport);

      await expect(runtime.execute('HandleSupport', {})).rejects.toThrow();
    });

    it('passes validation for correct input', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.sequence([{ content: 'valid!' }]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      const result = await runtime.execute('HandleSupport', { msg: 'valid input' });
      expect(result).toBe('valid!');
    });
  });

  describe('output validation', () => {
    it('validates workflow output against schema if provided', async () => {
      const runtime = new AxlTestRuntime();
      runtime.register(StrictWorkflow);

      const result = await runtime.execute('StrictWorkflow', { value: 5 });
      expect(result).toEqual({ doubled: 10 });
    });

    it('throws when output does not match schema', async () => {
      const runtime = new AxlTestRuntime();
      runtime.register(BadOutputWorkflow);

      await expect(runtime.execute('BadOutputWorkflow', { value: 5 })).rejects.toThrow();
    });
  });

  describe('provider resolution', () => {
    it('resolves provider by model prefix', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.sequence([{ content: 'from openai' }]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      const result = await runtime.execute('HandleSupport', { msg: 'test' });
      expect(result).toBe('from openai');
    });

    it('falls back to default provider', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.sequence([{ content: 'from default' }]);

      runtime.register(HandleSupport);
      runtime.mockProvider('default', provider);

      const result = await runtime.execute('HandleSupport', { msg: 'test' });
      expect(result).toBe('from default');
    });

    it('uses single registered provider as fallback', async () => {
      const runtime = new AxlTestRuntime();
      const provider = MockProvider.sequence([{ content: 'only provider' }]);

      runtime.register(HandleSupport);
      // Register under an arbitrary name -- since it is the only one, it should be used
      runtime.mockProvider('anything', provider);

      const result = await runtime.execute('HandleSupport', { msg: 'test' });
      expect(result).toBe('only provider');
    });

    it('throws when no matching provider is found', async () => {
      const runtime = new AxlTestRuntime();
      // Register two providers but neither matches "openai"
      const p1 = MockProvider.sequence([{ content: 'a' }]);
      const p2 = MockProvider.sequence([{ content: 'b' }]);

      runtime.register(HandleSupport);
      runtime.mockProvider('anthropic', p1);
      runtime.mockProvider('google', p2);

      await expect(runtime.execute('HandleSupport', { msg: 'test' })).rejects.toThrow(
        /Unknown provider "openai"/,
      );
    });
  });

  describe('state reset between executions', () => {
    it('resets toolCalls, agentCalls, steps, and traceLog between executions', async () => {
      const runtime = new AxlTestRuntime();

      runtime.register(HandleSupport);

      // First execution
      const provider1 = MockProvider.sequence([
        {
          content: '',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'get_order', arguments: '{"orderId":"1"}' },
            },
          ],
        },
        { content: 'first' },
      ]);
      runtime.mockProvider('openai', provider1);
      await runtime.execute('HandleSupport', { msg: 'first' });

      expect(runtime.toolCalls()).toHaveLength(1);
      expect(runtime.agentCalls()).toHaveLength(1);

      // Second execution (re-register provider since first was exhausted)
      const provider2 = MockProvider.sequence([{ content: 'second' }]);
      runtime.mockProvider('openai', provider2);
      await runtime.execute('HandleSupport', { msg: 'second' });

      // Should only reflect second execution
      expect(runtime.toolCalls()).toHaveLength(0);
      expect(runtime.agentCalls()).toHaveLength(1);
      expect(runtime.agentCalls()[0].response).toBe('second');
    });

    it('resets totalCost between executions', async () => {
      const runtime = new AxlTestRuntime();
      runtime.register(HandleSupport);

      const provider1 = MockProvider.replay([
        {
          content: 'expensive',
          usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
          cost: 1.5,
        },
      ]);
      runtime.mockProvider('openai', provider1);
      await runtime.execute('HandleSupport', { msg: 'a' });
      expect(runtime.totalCost()).toBe(1.5);

      const provider2 = MockProvider.sequence([{ content: 'cheap' }]);
      runtime.mockProvider('openai', provider2);
      await runtime.execute('HandleSupport', { msg: 'b' });
      expect(runtime.totalCost()).toBe(0);
    });
  });

  describe('context properties', () => {
    it('provides executionId and metadata on context', async () => {
      let capturedCtx: any;

      const InspectWorkflow = workflow({
        name: 'InspectWorkflow',
        input: z.object({ x: z.number() }),
        handler: async (ctx) => {
          capturedCtx = ctx;
          return 'inspected';
        },
      });

      const runtime = new AxlTestRuntime();
      runtime.register(InspectWorkflow);

      await runtime.execute(
        'InspectWorkflow',
        { x: 42 },
        {
          metadata: { env: 'test' },
        },
      );

      expect(capturedCtx.executionId).toMatch(/^test-/);
      expect(capturedCtx.metadata).toEqual({ env: 'test' });
      expect(capturedCtx.input).toEqual({ x: 42 });
    });

    it('metadata defaults to empty object', async () => {
      let capturedCtx: any;

      const InspectWorkflow2 = workflow({
        name: 'InspectWorkflow2',
        input: z.object({ x: z.number() }),
        handler: async (ctx) => {
          capturedCtx = ctx;
          return 'ok';
        },
      });

      const runtime = new AxlTestRuntime();
      runtime.register(InspectWorkflow2);

      await runtime.execute('InspectWorkflow2', { x: 1 });

      expect(capturedCtx.metadata).toEqual({});
    });
  });

  describe('multiple tool calls in one turn', () => {
    it('handles multiple tool calls returned in a single response', async () => {
      const runtime = new AxlTestRuntime();

      const provider = MockProvider.sequence([
        {
          content: '',
          tool_calls: [
            {
              id: 'call-a',
              type: 'function',
              function: { name: 'get_order', arguments: '{"orderId":"A"}' },
            },
            {
              id: 'call-b',
              type: 'function',
              function: { name: 'get_order', arguments: '{"orderId":"B"}' },
            },
          ],
        },
        { content: 'Both orders found.' },
      ]);

      runtime.register(HandleSupport);
      runtime.mockProvider('openai', provider);

      const result = await runtime.execute('HandleSupport', { msg: 'check orders A and B' });

      expect(result).toBe('Both orders found.');
      expect(runtime.toolCalls()).toHaveLength(2);
      expect(runtime.toolCalls()[0].args).toEqual({ orderId: 'A' });
      expect(runtime.toolCalls()[1].args).toEqual({ orderId: 'B' });
    });
  });

  describe('config threading (parity with production runtime)', () => {
    it('honors trace.redact on agent_call events', async () => {
      const runtime = new AxlTestRuntime({
        config: { trace: { redact: true } },
      });

      const provider = MockProvider.sequence([{ content: 'secret response' }]);
      runtime.register(SimpleAskWorkflow);
      runtime.mockProvider('openai', provider);

      await runtime.execute('SimpleAsk', { q: 'secret prompt' });

      // prompt is on agent_call_start; response is on agent_call_end.
      const startCalls = runtime.traceLog().filter((t) => t.type === 'agent_call_start');
      expect(startCalls.length).toBeGreaterThan(0);
      expect((startCalls[0].data as Record<string, unknown>).prompt).toBe('[redacted]');

      const endCalls = runtime.traceLog().filter((t) => t.type === 'agent_call_end');
      expect(endCalls.length).toBeGreaterThan(0);
      expect((endCalls[0].data as Record<string, unknown>).response).toBe('[redacted]');
    });

    it('honors trace.level: full on agent_call events', async () => {
      const runtime = new AxlTestRuntime({
        config: { trace: { level: 'full' } },
      });

      const provider = MockProvider.sequence([{ content: 'hello' }]);
      runtime.register(SimpleAskWorkflow);
      runtime.mockProvider('openai', provider);

      await runtime.execute('SimpleAsk', { q: 'hi' });

      // verbose messages snapshot lives on agent_call_start.
      const agentCall = runtime.traceLog().find((t) => t.type === 'agent_call_start');
      expect(agentCall).toBeDefined();
      const data = agentCall!.data as Record<string, unknown>;
      expect(Array.isArray(data.messages)).toBe(true);
    });

    it('applies trace.redact to workflow_start and workflow_end events', async () => {
      const runtime = new AxlTestRuntime({
        config: { trace: { redact: true } },
      });

      runtime.register(RedactFixtureWorkflow);

      await runtime.execute('RedactFixture', { secret: 'abc' });

      const startEvent = runtime.traceLog().find((t) => t.type === 'workflow_start');
      const endEvent = runtime.traceLog().find((t) => t.type === 'workflow_end');

      expect(startEvent).toBeDefined();
      expect(endEvent).toBeDefined();

      // Redaction should scrub input/result but preserve structural fields.
      const startData = startEvent!.data as Record<string, unknown>;
      expect(startData.input).toBe('[redacted]');
      expect(startEvent!.workflow).toBe('RedactFixture');
      expect(typeof startEvent!.step).toBe('number');
      expect(typeof startEvent!.timestamp).toBe('number');
      expect(startEvent!.executionId).toMatch(/^test-/);

      const endData = endEvent!.data as Record<string, unknown>;
      expect(endData.result).toBe('[redacted]');
      expect(endData.status).toBe('completed');
      expect(endEvent!.workflow).toBe('RedactFixture');
      expect(typeof endEvent!.step).toBe('number');
      expect(typeof endEvent!.timestamp).toBe('number');
      expect(endEvent!.executionId).toMatch(/^test-/);
    });

    it('preserves raw input/result on workflow_start/end when redact is off', async () => {
      const runtime = new AxlTestRuntime();
      runtime.register(RedactFixtureWorkflow);

      await runtime.execute('RedactFixture', { secret: 'abc' });

      const startEvent = runtime.traceLog().find((t) => t.type === 'workflow_start');
      const endEvent = runtime.traceLog().find((t) => t.type === 'workflow_end');

      expect(startEvent).toBeDefined();
      expect(endEvent).toBeDefined();

      expect((startEvent!.data as Record<string, unknown>).input).toEqual({ secret: 'abc' });
      expect((endEvent!.data as Record<string, unknown>).result).toEqual({ answer: 'ok:abc' });
    });
  });

  describe('failure path emits workflow_end (parity with production runtime)', () => {
    it('emits workflow_end(status: failed) when handler throws', async () => {
      const runtime = new AxlTestRuntime();
      runtime.register(ThrowingWorkflow);

      await expect(runtime.execute('Throwing', { x: 1 })).rejects.toThrow('boom');

      const endEvents = runtime.traceLog().filter((t) => t.type === 'workflow_end');
      expect(endEvents).toHaveLength(1);

      const endData = endEvents[0].data as Record<string, unknown>;
      expect(endData.status).toBe('failed');
      expect(endData.error).toBe('boom');
      expect(endData.aborted).toBeUndefined();

      // workflow_start should still fire before the failure.
      const startEvents = runtime.traceLog().filter((t) => t.type === 'workflow_start');
      expect(startEvents).toHaveLength(1);

      // Start must precede end.
      expect(startEvents[0].step).toBeLessThan(endEvents[0].step);
    });

    it('marks workflow_end.aborted=true when handler throws an AbortError', async () => {
      const runtime = new AxlTestRuntime();
      runtime.register(AbortingWorkflow);

      await expect(runtime.execute('Aborting', { x: 1 })).rejects.toThrow('cancelled');

      const endEvents = runtime.traceLog().filter((t) => t.type === 'workflow_end');
      expect(endEvents).toHaveLength(1);

      const endData = endEvents[0].data as Record<string, unknown>;
      expect(endData.status).toBe('failed');
      expect(endData.error).toBe('cancelled');
      expect(endData.aborted).toBe(true);
    });

    it('redacts workflow_end.error when redact:true AND the workflow fails (combined invariant)', async () => {
      // Two parity fixes interact here:
      //   (a) AxlTestRuntime emits workflow_start/workflow_end through
      //       `_emitWorkflowStart`/`_emitWorkflowEnd`, so redaction applies.
      //   (b) The failure path emits workflow_end({status:'failed'}) with
      //       `error` in `data`.
      // Each is tested individually above, but a future regression in
      // either one would silently break PII protection on the failure
      // path. This test pins the COMBINED case so the failure-side
      // `error` field is scrubbed when redact is enabled.
      const runtime = new AxlTestRuntime({
        config: { trace: { redact: true } },
      });
      runtime.register(SecretThrowingWorkflow);

      await expect(runtime.execute('SecretThrowing', { secret: 'hunter2' })).rejects.toThrow(
        'leaked secret hunter2',
      );

      const startEvents = runtime.traceLog().filter((t) => t.type === 'workflow_start');
      const endEvents = runtime.traceLog().filter((t) => t.type === 'workflow_end');

      expect(startEvents).toHaveLength(1);
      expect(endEvents).toHaveLength(1);

      const startData = startEvents[0].data as Record<string, unknown>;
      const endData = endEvents[0].data as Record<string, unknown>;

      // input on workflow_start is scrubbed (the `{ secret }` object).
      expect(startData.input).toBe('[redacted]');

      // workflow_end carries the failure outcome with redaction applied.
      expect(endData.status).toBe('failed');
      // The error message contains the secret — must be scrubbed.
      expect(endData.error).toBe('[redacted]');
      // Plain failures (not AbortError) leave `aborted` unset.
      expect(endData.aborted).toBeUndefined();
    });
  });
});

// Fixtures for the redaction + failure-path tests above.
const RedactFixtureWorkflow = workflow({
  name: 'RedactFixture',
  input: z.object({ secret: z.string() }),
  handler: async (ctx) => {
    return { answer: `ok:${(ctx.input as { secret: string }).secret}` };
  },
});

const ThrowingWorkflow = workflow({
  name: 'Throwing',
  input: z.object({ x: z.number() }),
  handler: async () => {
    throw new Error('boom');
  },
});

const AbortingWorkflow = workflow({
  name: 'Aborting',
  input: z.object({ x: z.number() }),
  handler: async () => {
    const err = new Error('cancelled');
    err.name = 'AbortError';
    throw err;
  },
});

// Throws an error whose message embeds the input secret — pins that
// `workflow_end.data.error` is scrubbed under redact:true on the
// failure path (combined invariant: failure path + redaction).
const SecretThrowingWorkflow = workflow({
  name: 'SecretThrowing',
  input: z.object({ secret: z.string() }),
  handler: async (ctx) => {
    throw new Error(`leaked secret ${(ctx.input as { secret: string }).secret}`);
  },
});

// Small fixture used by the config-threading tests above.
const SimpleAsker = agent({
  model: 'openai:gpt-4o-mini',
  system: 'Helpful.',
});
const SimpleAskWorkflow = workflow({
  name: 'SimpleAsk',
  input: z.object({ q: z.string() }),
  handler: async (ctx) => ctx.ask(SimpleAsker, (ctx.input as { q: string }).q),
});
