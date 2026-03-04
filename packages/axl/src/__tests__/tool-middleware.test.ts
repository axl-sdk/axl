import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { tool } from '../tool.js';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { randomUUID } from 'node:crypto';
import type { TraceEvent, AwaitHumanOptions, HumanDecision } from '../types.js';
import type { Provider, ProviderResponse, ToolCallMessage } from '../providers/types.js';

/** Create a mock provider that returns tool calls then a final response. */
function createToolCallingProvider(toolCalls: ToolCallMessage[], finalResponse: string): Provider {
  let callIndex = 0;
  return {
    name: 'mock',
    chat: async () => {
      callIndex++;
      if (callIndex === 1) {
        // First call: return tool calls
        return {
          content: '',
          tool_calls: toolCalls,
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          cost: 0.001,
        } as ProviderResponse;
      }
      // Subsequent calls: return final text
      return {
        content: finalResponse,
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: 0.001,
      } as ProviderResponse;
    },
    stream: async function* () {
      yield {
        type: 'done' as const,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  };
}

function createSimpleProvider(response: string): Provider {
  return {
    name: 'mock',
    chat: async () => ({
      content: response,
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      cost: 0.001,
    }),
    stream: async function* () {
      yield {
        type: 'done' as const,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  };
}

function createCtx(overrides: Record<string, unknown> = {}) {
  const registry = new ProviderRegistry();
  const provider = (overrides.provider as Provider) ?? createSimpleProvider('Done');
  registry.registerInstance('mock', provider);
  const traces: TraceEvent[] = [];
  return {
    ctx: new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: {},
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
      ...overrides,
    }),
    traces,
  };
}

describe('tool middleware & approval gates', () => {
  describe('requireApproval', () => {
    it('approved → executes normally', async () => {
      const myTool = tool({
        name: 'risky_action',
        description: 'A risky action',
        input: z.object({ value: z.string() }),
        handler: (input) => `executed: ${input.value}`,
        requireApproval: true,
      });

      const toolCalls: ToolCallMessage[] = [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'risky_action', arguments: '{"value":"test"}' },
        },
      ];

      const awaitHumanHandler = vi.fn(async (_opts: AwaitHumanOptions): Promise<HumanDecision> => {
        return { approved: true };
      });

      const { ctx, traces } = createCtx({
        provider: createToolCallingProvider(toolCalls, 'All done'),
        awaitHumanHandler,
      });

      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        tools: [myTool],
      });

      const result = await ctx.ask(a, 'Do the risky thing');
      expect(result).toBe('All done');
      expect(awaitHumanHandler).toHaveBeenCalledOnce();
      expect(awaitHumanHandler.mock.calls[0][0].channel).toBe('tool_approval');

      // Approval-succeeded trace emitted (tool_denied with denied: false)
      const approvalTraces = traces.filter((t) => t.type === 'tool_denied');
      expect(approvalTraces).toHaveLength(1);
      expect((approvalTraces[0].data as any).denied).toBe(false);
    });

    it('denied → LLM gets denial message, tool_denied trace emitted', async () => {
      const myTool = tool({
        name: 'risky_action',
        description: 'A risky action',
        input: z.object({ value: z.string() }),
        handler: (input) => `executed: ${input.value}`,
        requireApproval: true,
      });

      // Provider: first call triggers tool, second call (after denial) returns final text
      const toolCalls: ToolCallMessage[] = [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'risky_action', arguments: '{"value":"test"}' },
        },
      ];

      const awaitHumanHandler = vi.fn(async (): Promise<HumanDecision> => {
        return { approved: false, reason: 'Too dangerous' };
      });

      const { ctx, traces } = createCtx({
        provider: createToolCallingProvider(toolCalls, 'OK, I will not do that'),
        awaitHumanHandler,
      });

      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        tools: [myTool],
      });

      const result = await ctx.ask(a, 'Do the risky thing');
      expect(result).toBe('OK, I will not do that');

      // Verify tool_denied trace was emitted
      const deniedTraces = traces.filter((t) => t.type === 'tool_denied');
      expect(deniedTraces).toHaveLength(1);
      expect((deniedTraces[0].data as any).reason).toBe('Too dangerous');
    });
  });

  describe('hooks', () => {
    it('before hook transforms input', async () => {
      const myTool = tool({
        name: 'greet',
        description: 'Greet someone',
        input: z.object({ name: z.string() }),
        handler: (input) => `Hello, ${input.name}!`,
        hooks: {
          before: (input) => ({ ...input, name: input.name.toUpperCase() }),
        },
      });

      const toolCalls: ToolCallMessage[] = [
        { id: 'tc1', type: 'function', function: { name: 'greet', arguments: '{"name":"world"}' } },
      ];

      const { ctx } = createCtx({
        provider: createToolCallingProvider(toolCalls, 'Done'),
      });

      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        tools: [myTool],
      });

      const result = await ctx.ask(a, 'Greet someone');
      expect(result).toBe('Done');

      // Also test via direct tool.run()
      const directResult = await myTool.run(ctx, { name: 'world' });
      expect(directResult).toBe('Hello, WORLD!');
    });

    it('after hook transforms output', async () => {
      const myTool = tool({
        name: 'compute',
        description: 'Compute something',
        input: z.object({ x: z.number() }),
        handler: (input) => input.x * 2,
        hooks: {
          after: (output) => output + 100,
        },
      });

      const toolCalls: ToolCallMessage[] = [
        { id: 'tc1', type: 'function', function: { name: 'compute', arguments: '{"x":5}' } },
      ];

      // We need a provider that returns the tool result in context
      let capturedToolResult: string | undefined;
      let callIndex = 0;
      const provider: Provider = {
        name: 'mock',
        chat: async (messages) => {
          callIndex++;
          if (callIndex === 1) {
            return {
              content: '',
              tool_calls: toolCalls,
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
              cost: 0.001,
            };
          }
          // Capture the tool result from the messages
          const toolMsg = messages.find((m) => m.role === 'tool');
          capturedToolResult = toolMsg?.content;
          return {
            content: `Result: ${capturedToolResult}`,
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            cost: 0.001,
          };
        },
        stream: async function* () {
          yield {
            type: 'done' as const,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
        },
      };

      const { ctx } = createCtx({ provider });

      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        tools: [myTool],
      });

      await ctx.ask(a, 'Compute x=5');

      // The after hook should have transformed 10 → 110
      expect(capturedToolResult).toBe('110');

      // Also test via direct tool.run()
      const directResult = await myTool.run(ctx, { x: 5 });
      expect(directResult).toBe(110);
    });
  });

  describe('hook error handling', () => {
    it('before hook throws → LLM gets error message, agent loop continues', async () => {
      const myTool = tool({
        name: 'failing_before',
        description: 'Tool with failing before hook',
        input: z.object({ v: z.string() }),
        handler: (input) => `result:${input.v}`,
        hooks: {
          before: () => {
            throw new Error('before hook exploded');
          },
        },
      });

      const toolCalls: ToolCallMessage[] = [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'failing_before', arguments: '{"v":"x"}' },
        },
      ];

      let capturedToolMsg: string | undefined;
      let callIndex = 0;
      const provider: Provider = {
        name: 'mock',
        chat: async (messages) => {
          callIndex++;
          if (callIndex === 1) {
            return {
              content: '',
              tool_calls: toolCalls,
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
              cost: 0.001,
            };
          }
          const toolMsg = messages.find((m) => m.role === 'tool');
          capturedToolMsg = toolMsg?.content;
          return {
            content: 'Handled error gracefully',
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            cost: 0.001,
          };
        },
        stream: async function* () {
          yield {
            type: 'done' as const,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
        },
      };

      const { ctx } = createCtx({ provider });
      const a = agent({ model: 'mock:test', system: 'You are helpful.', tools: [myTool] });

      const result = await ctx.ask(a, 'Do it');
      expect(result).toBe('Handled error gracefully');
      expect(capturedToolMsg).toContain('Before hook error');
      expect(capturedToolMsg).toContain('before hook exploded');
    });

    it('after hook throws → LLM gets error message, agent loop continues', async () => {
      const myTool = tool({
        name: 'failing_after',
        description: 'Tool with failing after hook',
        input: z.object({ v: z.string() }),
        handler: (input) => `result:${input.v}`,
        hooks: {
          after: () => {
            throw new Error('after hook exploded');
          },
        },
      });

      const toolCalls: ToolCallMessage[] = [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'failing_after', arguments: '{"v":"x"}' },
        },
      ];

      let capturedToolMsg: string | undefined;
      let callIndex = 0;
      const provider: Provider = {
        name: 'mock',
        chat: async (messages) => {
          callIndex++;
          if (callIndex === 1) {
            return {
              content: '',
              tool_calls: toolCalls,
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
              cost: 0.001,
            };
          }
          const toolMsg = messages.find((m) => m.role === 'tool');
          capturedToolMsg = toolMsg?.content;
          return {
            content: 'Handled after error',
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            cost: 0.001,
          };
        },
        stream: async function* () {
          yield {
            type: 'done' as const,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
        },
      };

      const { ctx } = createCtx({ provider });
      const a = agent({ model: 'mock:test', system: 'You are helpful.', tools: [myTool] });

      const result = await ctx.ask(a, 'Do it');
      expect(result).toBe('Handled after error');
      expect(capturedToolMsg).toContain('After hook error');
      expect(capturedToolMsg).toContain('after hook exploded');
    });
  });

  describe('execution order', () => {
    it('approval → before → handler → after sequence', async () => {
      const sequence: string[] = [];

      const myTool = tool({
        name: 'ordered',
        description: 'Tests execution order',
        input: z.object({ v: z.string() }),
        handler: (input) => {
          sequence.push('handler');
          return `result:${input.v}`;
        },
        requireApproval: true,
        hooks: {
          before: (input) => {
            sequence.push('before');
            return input;
          },
          after: (output) => {
            sequence.push('after');
            return output;
          },
        },
      });

      const toolCalls: ToolCallMessage[] = [
        { id: 'tc1', type: 'function', function: { name: 'ordered', arguments: '{"v":"x"}' } },
      ];

      const awaitHumanHandler = vi.fn(async (): Promise<HumanDecision> => {
        sequence.push('approval');
        return { approved: true };
      });

      const { ctx } = createCtx({
        provider: createToolCallingProvider(toolCalls, 'Done'),
        awaitHumanHandler,
      });

      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        tools: [myTool],
      });

      await ctx.ask(a, 'Do it');
      expect(sequence).toEqual(['approval', 'before', 'handler', 'after']);
    });

    it('before hook NOT called on approval denial', async () => {
      const sequence: string[] = [];

      const myTool = tool({
        name: 'gated',
        description: 'Gated tool',
        input: z.object({ v: z.string() }),
        handler: () => {
          sequence.push('handler');
          return 'result';
        },
        requireApproval: true,
        hooks: {
          before: (input) => {
            sequence.push('before');
            return input;
          },
          after: (output) => {
            sequence.push('after');
            return output;
          },
        },
      });

      const toolCalls: ToolCallMessage[] = [
        { id: 'tc1', type: 'function', function: { name: 'gated', arguments: '{"v":"x"}' } },
      ];

      const awaitHumanHandler = vi.fn(async (): Promise<HumanDecision> => {
        sequence.push('approval_denied');
        return { approved: false, reason: 'Nope' };
      });

      const { ctx } = createCtx({
        provider: createToolCallingProvider(toolCalls, 'Understood'),
        awaitHumanHandler,
      });

      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        tools: [myTool],
      });

      await ctx.ask(a, 'Do it');
      expect(sequence).toEqual(['approval_denied']);
    });
  });

  describe('tool.run() behavior', () => {
    it('calls hooks but NOT approval gate', async () => {
      const sequence: string[] = [];

      const myTool = tool({
        name: 'direct_run',
        description: 'Direct run tool',
        input: z.object({ v: z.string() }),
        handler: (input) => {
          sequence.push('handler');
          return `result:${input.v}`;
        },
        requireApproval: true,
        hooks: {
          before: (input) => {
            sequence.push('before');
            return input;
          },
          after: (output) => {
            sequence.push('after');
            return output;
          },
        },
      });

      const { ctx } = createCtx();
      const result = await myTool.run(ctx, { v: 'test' });

      // approval should NOT be in sequence — run() bypasses it
      expect(sequence).toEqual(['before', 'handler', 'after']);
      expect(result).toBe('result:test');
    });
  });

  describe('OTel span', () => {
    it('emits axl.tool.approval span with correct attributes', async () => {
      const spans: Array<{ name: string; attrs: Record<string, any> }> = [];

      const mockSpanManager = {
        withSpanAsync: async <T>(
          name: string,
          attrs: Record<string, any>,
          fn: (span: any) => Promise<T>,
        ) => {
          const span = {
            setAttribute: (k: string, v: any) => {
              const existing = spans.find((s) => s.name === name);
              if (existing) existing.attrs[k] = v;
            },
            addEvent: () => {},
            setStatus: () => {},
            end: () => {},
          };
          spans.push({ name, attrs: { ...attrs } });
          return fn(span);
        },
        addEventToActiveSpan: () => {},
        shutdown: async () => {},
      };

      const myTool = tool({
        name: 'risky',
        description: 'Risky tool',
        input: z.object({ v: z.string() }),
        handler: () => 'done',
        requireApproval: true,
      });

      const toolCalls: ToolCallMessage[] = [
        { id: 'tc1', type: 'function', function: { name: 'risky', arguments: '{"v":"x"}' } },
      ];

      const awaitHumanHandler = vi.fn(async (): Promise<HumanDecision> => {
        return { approved: true };
      });

      const { ctx } = createCtx({
        provider: createToolCallingProvider(toolCalls, 'Done'),
        awaitHumanHandler,
        spanManager: mockSpanManager,
      });

      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        tools: [myTool],
      });

      await ctx.ask(a, 'Do it');

      const approvalSpans = spans.filter((s) => s.name === 'axl.tool.approval');
      expect(approvalSpans).toHaveLength(1);
      expect(approvalSpans[0].attrs['axl.tool.name']).toBe('risky');
      expect(approvalSpans[0].attrs['axl.agent.name']).toBe('mock:test');
      expect(approvalSpans[0].attrs['axl.tool.approval.approved']).toBe(true);
    });
  });

  describe('backwards compatibility', () => {
    it('existing tools without new properties behave identically', async () => {
      const myTool = tool({
        name: 'simple',
        description: 'A simple tool',
        input: z.object({ query: z.string() }),
        handler: (input) => `result: ${input.query}`,
      });

      // Verify defaults
      expect(myTool.requireApproval).toBe(false);
      expect(myTool.hooks).toBeUndefined();

      const toolCalls: ToolCallMessage[] = [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'simple', arguments: '{"query":"test"}' },
        },
      ];

      const { ctx } = createCtx({
        provider: createToolCallingProvider(toolCalls, 'Done'),
      });

      const a = agent({
        model: 'mock:test',
        system: 'You are helpful.',
        tools: [myTool],
      });

      const result = await ctx.ask(a, 'Search');
      expect(result).toBe('Done');
    });
  });
});
