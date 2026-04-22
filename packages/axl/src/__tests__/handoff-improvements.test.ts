import { describe, it, expect } from 'vitest';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AxlEvent } from '../types.js';
import type { Provider, ProviderResponse, ToolCallMessage } from '../providers/types.js';

/**
 * Create a mock provider from a sequence of responses.
 * Each response is either a string (text) or an object with tool_calls.
 */
function createSequenceProvider(
  responses: Array<string | { content?: string; tool_calls: ToolCallMessage[] }>,
): Provider {
  let callIndex = 0;
  return {
    name: 'mock',
    chat: async () => {
      const item = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      if (typeof item === 'string') {
        return {
          content: item,
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          cost: 0.001,
        } as ProviderResponse;
      }
      return {
        content: item.content ?? '',
        tool_calls: item.tool_calls,
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

function createCtx(overrides: Record<string, unknown> = {}) {
  const registry = new ProviderRegistry();
  const provider = (overrides.provider as Provider) ?? createSequenceProvider(['Done']);
  registry.registerInstance('mock', provider);
  const traces: AxlEvent[] = [];
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
    registry,
  };
}

describe('agent handoff improvements', () => {
  describe('roundtrip handoff', () => {
    it('source calls target, gets result back, continues its loop', async () => {
      // Target agent: always returns "target_result"
      const targetAgent = agent({
        name: 'target',
        model: 'mock:test',
        system: 'You are a specialist.',
      });

      // Source agent: first call triggers handoff to target, second call returns final text
      const sourceAgent = agent({
        name: 'source',
        model: 'mock:test',
        system: 'You are a coordinator.',
        handoffs: [{ agent: targetAgent, mode: 'roundtrip' }],
      });

      // Provider sequence:
      // Call 1 (source): triggers handoff_to_target with message
      // Call 2 (target): returns "specialist answer"
      // Call 3 (source, after roundtrip): returns final answer incorporating target's result
      const provider = createSequenceProvider([
        {
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: {
                name: 'handoff_to_target',
                arguments: '{"message":"Please analyze this data"}',
              },
            },
          ],
        },
        'specialist answer', // target's response
        'Final answer: specialist answer was helpful', // source continues
      ]);

      const { ctx, traces } = createCtx({ provider });
      const result = await ctx.ask(sourceAgent, 'Coordinate this task');

      // Source should continue after roundtrip and produce the final result
      expect(result).toBe('Final answer: specialist answer was helpful');

      // Verify handoff_start (carries mode) and handoff_return (carries
      // duration) were both emitted — roundtrip mode emits both legs of
      // the split event pair.
      const handoffStarts = traces.filter((t) => t.type === 'handoff_start');
      expect(handoffStarts).toHaveLength(1);
      expect((handoffStarts[0].data as any).mode).toBe('roundtrip');

      const handoffReturns = traces.filter((t) => t.type === 'handoff_return');
      expect(handoffReturns).toHaveLength(1);
      expect(typeof (handoffReturns[0].data as any).duration).toBe('number');
    });

    it('roundtrip message param used as target agent prompt', async () => {
      let capturedPrompt: string | undefined;

      const targetAgent = agent({
        name: 'target',
        model: 'mock:test',
        system: 'You are a specialist.',
      });

      const sourceAgent = agent({
        name: 'source',
        model: 'mock:test',
        system: 'You are a coordinator.',
        handoffs: [{ agent: targetAgent, mode: 'roundtrip' }],
      });

      // Custom provider that captures the user prompt sent to the target
      let callIndex = 0;
      const provider: Provider = {
        name: 'mock',
        chat: async (messages) => {
          callIndex++;
          if (callIndex === 1) {
            // Source calls handoff
            return {
              content: '',
              tool_calls: [
                {
                  id: 'tc1',
                  type: 'function',
                  function: {
                    name: 'handoff_to_target',
                    arguments: '{"message":"Specific delegated task"}',
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
              cost: 0.001,
            };
          }
          if (callIndex === 2) {
            // Target receives the prompt — capture the user message
            const userMsg = messages.find((m) => m.role === 'user');
            capturedPrompt = userMsg?.content;
            return {
              content: 'target done',
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
              cost: 0.001,
            };
          }
          // Source continues
          return {
            content: 'final',
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
      await ctx.ask(sourceAgent, 'Original task');

      // The target should receive "Specific delegated task" as the prompt, not the original
      expect(capturedPrompt).toContain('Specific delegated task');
    });

    it('roundtrip tool definition has correct description and parameters', async () => {
      const targetAgent = agent({
        name: 'helper',
        model: 'mock:test',
        system: 'You help.',
      });

      const sourceAgent = agent({
        name: 'main',
        model: 'mock:test',
        system: 'You coordinate.',
        handoffs: [{ agent: targetAgent, mode: 'roundtrip' }],
      });

      // Capture the tool definitions sent to the provider
      let capturedTools: any;
      const provider: Provider = {
        name: 'mock',
        chat: async (_messages, options) => {
          capturedTools = options?.tools;
          return {
            content: 'done',
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
      await ctx.ask(sourceAgent, 'Hello');

      const handoffTool = capturedTools?.find((t: any) => t.function.name === 'handoff_to_helper');
      expect(handoffTool).toBeDefined();
      expect(handoffTool.function.description).toContain('Delegate a task to helper');
      expect(handoffTool.function.parameters).toEqual({
        type: 'object',
        properties: { message: { type: 'string', description: 'The task to delegate' } },
        required: ['message'],
      });
    });
  });

  describe('oneway handoff (default)', () => {
    it('still works with default behavior unchanged', async () => {
      const targetAgent = agent({
        name: 'target',
        model: 'mock:test',
        system: 'You are the target.',
      });

      const sourceAgent = agent({
        name: 'source',
        model: 'mock:test',
        system: 'You are the source.',
        handoffs: [{ agent: targetAgent }], // No mode = oneway
      });

      const provider = createSequenceProvider([
        {
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'handoff_to_target', arguments: '{}' },
            },
          ],
        },
        'I am the target agent',
      ]);

      const { ctx, traces } = createCtx({ provider });
      const result = await ctx.ask(sourceAgent, 'Hello');

      // Oneway: result comes from target directly
      expect(result).toBe('I am the target agent');

      // Oneway handoffs emit only `handoff_start` (no return trip — the
      // target's `ask_end` IS the end of the chain, so no `handoff_return`).
      const handoffTraces = traces.filter((t) => t.type === 'handoff_start');
      expect(handoffTraces).toHaveLength(1);
      expect((handoffTraces[0].data as any).mode).toBe('oneway');
      expect(traces.filter((t) => t.type === 'handoff_return')).toHaveLength(0);
    });

    it('handoff.toAskId matches the target agent_call_end.askId (review B-7/B-8)', async () => {
      // The handoff event's `toAskId` used to be a synthesized UUID
      // that no other event referenced — consumers grouping by askId
      // saw the handoff as an orphan row. The fix runs the target's
      // executeAgentCall under a real ask frame whose askId is
      // `handoffToAskId`, so downstream events from the target
      // (agent_call_end, tool_call_end) carry askId === handoffToAskId
      // and parentAskId === handoffFromAskId.
      const targetAgent = agent({
        name: 'target-b7',
        model: 'mock:test',
        system: 'target',
      });
      const sourceAgent = agent({
        name: 'source-b7',
        model: 'mock:test',
        system: 'source',
        handoffs: [{ agent: targetAgent }], // oneway
      });
      const provider = createSequenceProvider([
        {
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'handoff_to_target-b7', arguments: '{}' },
            },
          ],
        },
        'target answer',
      ]);
      const { ctx, traces } = createCtx({ provider });
      await ctx.ask(sourceAgent, 'start');

      // `handoff_start` is always emitted (for both oneway and roundtrip)
      // and carries the fromAskId/toAskId correlation anchors.
      const handoff = traces.find((t) => t.type === 'handoff_start');
      expect(handoff).toBeDefined();
      const toAskId = handoff!.toAskId;
      const fromAskId = handoff!.fromAskId;
      expect(toAskId).toBeTypeOf('string');
      expect(fromAskId).toBeTypeOf('string');
      expect(toAskId).not.toBe(fromAskId);

      // The target agent's agent_call_end event should be scoped to
      // the handoffToAskId frame — proving the askId is a real
      // correlation anchor, not a synthesized sentinel.
      type AgentCallEnd = Extract<AxlEvent, { type: 'agent_call_end' }>;
      const targetCalls = traces.filter(
        (t): t is AgentCallEnd => t.type === 'agent_call_end' && t.agent === 'target-b7',
      );
      expect(targetCalls.length).toBeGreaterThan(0);
      for (const call of targetCalls) {
        expect(call.askId).toBe(toAskId);
        expect(call.parentAskId).toBe(fromAskId);
        expect(call.depth).toBe((handoff!.sourceDepth ?? 0) + 1);
      }
    });

    it('oneway tool definition has empty parameters', async () => {
      const targetAgent = agent({
        name: 'helper',
        model: 'mock:test',
        system: 'You help.',
      });

      const sourceAgent = agent({
        name: 'main',
        model: 'mock:test',
        system: 'You coordinate.',
        handoffs: [{ agent: targetAgent }], // Default oneway
      });

      let capturedTools: any;
      const provider: Provider = {
        name: 'mock',
        chat: async (_messages, options) => {
          capturedTools = options?.tools;
          return {
            content: 'done',
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
      await ctx.ask(sourceAgent, 'Hello');

      const handoffTool = capturedTools?.find((t: any) => t.function.name === 'handoff_to_helper');
      expect(handoffTool).toBeDefined();
      expect(handoffTool.function.description).toContain('Hand off the conversation to helper');
      expect(handoffTool.function.parameters).toEqual({ type: 'object', properties: {} });
    });
  });

  describe('session handoff history', () => {
    it('session.handoffs() returns handoff records', async () => {
      const targetAgent = agent({
        name: 'specialist',
        model: 'mock:test',
        system: 'You are a specialist.',
      });

      const sourceAgent = agent({
        name: 'coordinator',
        model: 'mock:test',
        system: 'You coordinate.',
        handoffs: [{ agent: targetAgent, mode: 'roundtrip' }],
      });

      // Build a runtime with a mock provider and our workflow
      const runtime = new AxlRuntime({});
      const provider = createSequenceProvider([
        {
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: {
                name: 'handoff_to_specialist',
                arguments: '{"message":"analyze this"}',
              },
            },
          ],
        },
        'specialist result',
        'coordinator final answer',
      ]);
      runtime.registerProvider('mock', provider);

      const wf = workflow({
        name: 'handoff-test',
        input: z.string(),
        handler: async (ctx) => ctx.ask(sourceAgent, ctx.input as string),
      });
      runtime.register(wf);

      const session = runtime.session('test-session-1');
      await session.send('handoff-test', 'Run the task');

      // Wait a tick for async handoff record persistence
      await new Promise((resolve) => setTimeout(resolve, 50));

      const records = await session.handoffs();
      expect(records).toHaveLength(1);
      expect(records[0].source).toBe('coordinator');
      expect(records[0].target).toBe('specialist');
      expect(records[0].mode).toBe('roundtrip');
      expect(records[0].timestamp).toBeGreaterThan(0);
      expect(typeof records[0].duration).toBe('number');
      expect(records[0].duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('session.fork() copies handoff history', () => {
    it('forked session inherits handoff records', async () => {
      const targetAgent = agent({
        name: 'specialist',
        model: 'mock:test',
        system: 'You are a specialist.',
      });

      const sourceAgent = agent({
        name: 'coordinator',
        model: 'mock:test',
        system: 'You coordinate.',
        handoffs: [{ agent: targetAgent, mode: 'roundtrip' }],
      });

      const runtime = new AxlRuntime({});
      const provider = createSequenceProvider([
        {
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: {
                name: 'handoff_to_specialist',
                arguments: '{"message":"analyze this"}',
              },
            },
          ],
        },
        'specialist result',
        'coordinator final answer',
      ]);
      runtime.registerProvider('mock', provider);

      const wf = workflow({
        name: 'fork-handoff-test',
        input: z.string(),
        handler: async (ctx) => ctx.ask(sourceAgent, ctx.input as string),
      });
      runtime.register(wf);

      const session = runtime.session('fork-source');
      await session.send('fork-handoff-test', 'Run the task');

      // Wait for async handoff record persistence
      await new Promise((resolve) => setTimeout(resolve, 50));

      const originalRecords = await session.handoffs();
      expect(originalRecords).toHaveLength(1);

      // Fork the session
      const forked = await session.fork('fork-target');
      const forkedRecords = await forked.handoffs();

      expect(forkedRecords).toHaveLength(1);
      expect(forkedRecords[0].source).toBe('coordinator');
      expect(forkedRecords[0].target).toBe('specialist');
      expect(forkedRecords[0].mode).toBe('roundtrip');
    });
  });

  describe('OTel', () => {
    it('span includes axl.handoff.mode attribute', async () => {
      const spans: Array<{ name: string; attrs: Record<string, any> }> = [];

      const mockSpanManager = {
        withSpanAsync: async <T>(
          name: string,
          attrs: Record<string, any>,
          fn: (span: any) => Promise<T>,
        ) => {
          const spanAttrs = { ...attrs };
          const span = {
            setAttribute: (k: string, v: any) => {
              spanAttrs[k] = v;
            },
            addEvent: () => {},
            setStatus: () => {},
            end: () => {},
          };
          spans.push({ name, attrs: spanAttrs });
          return fn(span);
        },
        addEventToActiveSpan: () => {},
        shutdown: async () => {},
      };

      const targetAgent = agent({
        name: 'target',
        model: 'mock:test',
        system: 'You are a target.',
      });

      const sourceAgent = agent({
        name: 'source',
        model: 'mock:test',
        system: 'You coordinate.',
        handoffs: [{ agent: targetAgent, mode: 'roundtrip' }],
      });

      const provider = createSequenceProvider([
        {
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: {
                name: 'handoff_to_target',
                arguments: '{"message":"do this"}',
              },
            },
          ],
        },
        'target result',
        'source final',
      ]);

      const { ctx } = createCtx({ provider, spanManager: mockSpanManager });
      await ctx.ask(sourceAgent, 'Go');

      const handoffSpans = spans.filter((s) => s.name === 'axl.agent.handoff');
      expect(handoffSpans).toHaveLength(1);
      expect(handoffSpans[0].attrs['axl.handoff.mode']).toBe('roundtrip');
      expect(handoffSpans[0].attrs['axl.handoff.source']).toBe('source');
      expect(handoffSpans[0].attrs['axl.handoff.target']).toBe('target');
    });
  });

  describe('stream event', () => {
    it('handoff stream event includes mode field', async () => {
      const targetAgent = agent({
        name: 'specialist',
        model: 'mock:test',
        system: 'You are a specialist.',
      });

      const sourceAgent = agent({
        name: 'coordinator',
        model: 'mock:test',
        system: 'You coordinate.',
        handoffs: [{ agent: targetAgent }], // oneway
      });

      const runtime = new AxlRuntime({});

      // Create a provider that supports both chat() and stream() paths.
      // runtime.stream() uses the streaming path (provider.stream()), so we
      // need to yield tool_call_delta chunks for the handoff to trigger.
      let callIndex = 0;
      const provider: Provider = {
        name: 'mock',
        chat: async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              content: '',
              tool_calls: [
                {
                  id: 'tc1',
                  type: 'function' as const,
                  function: { name: 'handoff_to_specialist', arguments: '{}' },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
              cost: 0.001,
            };
          }
          return {
            content: 'specialist answer',
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            cost: 0.001,
          };
        },
        stream: async function* (_messages, _options) {
          callIndex++;
          if (callIndex === 1) {
            // Source agent: return handoff tool call via stream
            yield {
              type: 'tool_call_delta' as const,
              id: 'tc1',
              name: 'handoff_to_specialist',
              arguments: '{}',
            };
            yield {
              type: 'done' as const,
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            };
          } else {
            // Target agent: return text
            yield { type: 'text_delta' as const, content: 'specialist answer' };
            yield {
              type: 'done' as const,
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            };
          }
        },
      };
      runtime.registerProvider('mock', provider);

      const wf = workflow({
        name: 'stream-handoff-test',
        input: z.string(),
        handler: async (ctx) => ctx.ask(sourceAgent, ctx.input as string),
      });
      runtime.register(wf);

      const stream = runtime.stream('stream-handoff-test', 'Run');
      const events: any[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Oneway handoffs emit only `handoff_start` (no return trip).
      // Wire format is AxlEvent — handoff fields live under `data`
      // (spec/16 §2.1). `fromAskId`/`toAskId` are at the top level for
      // tree reconstruction. `mode` is on `handoff_start` (no return trip
      // means no `handoff_return` for oneway).
      const handoffEvents = events.filter((e) => e.type === 'handoff_start');
      expect(handoffEvents).toHaveLength(1);
      expect(handoffEvents[0].data.source).toBe('coordinator');
      expect(handoffEvents[0].data.target).toBe('specialist');
      expect(handoffEvents[0].data.mode).toBe('oneway');
      expect(handoffEvents[0].fromAskId).toBeDefined();
      expect(handoffEvents[0].toAskId).toBeDefined();
      // Oneway: no handoff_return emitted.
      expect(events.filter((e) => e.type === 'handoff_return')).toHaveLength(0);
    });
  });

  describe('nested handoff', () => {
    it('roundtrip → oneway: source gets result', async () => {
      // specialist → sub-specialist (oneway), so specialist's loop ends with sub-specialist's answer
      // source → specialist (roundtrip), so source continues with specialist's answer
      const subSpecialist = agent({
        name: 'sub_specialist',
        model: 'mock:test',
        system: 'You are a sub-specialist.',
      });

      const specialist = agent({
        name: 'specialist',
        model: 'mock:test',
        system: 'You are a specialist.',
        handoffs: [{ agent: subSpecialist }], // oneway
      });

      const source = agent({
        name: 'source',
        model: 'mock:test',
        system: 'You coordinate.',
        handoffs: [{ agent: specialist, mode: 'roundtrip' }],
      });

      // Flow:
      // 1. source: triggers handoff_to_specialist (roundtrip)
      // 2. specialist: triggers handoff_to_sub_specialist (oneway)
      // 3. sub_specialist: returns "deep answer"
      // 4. source: continues with "deep answer" as tool result, returns final
      const provider = createSequenceProvider([
        // source call 1: handoff to specialist
        {
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: {
                name: 'handoff_to_specialist',
                arguments: '{"message":"analyze deeply"}',
              },
            },
          ],
        },
        // specialist call: handoff to sub_specialist (oneway)
        {
          tool_calls: [
            {
              id: 'tc2',
              type: 'function',
              function: { name: 'handoff_to_sub_specialist', arguments: '{}' },
            },
          ],
        },
        // sub_specialist: final text
        'deep answer from sub-specialist',
        // source call 2: final text (after roundtrip)
        'Final: incorporated deep answer',
      ]);

      const { ctx, traces } = createCtx({ provider });
      const result = await ctx.ask(source, 'Complex task');

      expect(result).toBe('Final: incorporated deep answer');

      // Both handoffs emit `handoff_start` (always fired, pre-transition).
      // `handoff_start` orders correctly in step-sorted timelines — the
      // outer source → specialist transition fires first, then the
      // inner specialist → sub_specialist transition.
      const handoffStarts = traces.filter((t) => t.type === 'handoff_start');
      expect(handoffStarts).toHaveLength(2);
      expect((handoffStarts[0].data as any).target).toBe('specialist');
      expect((handoffStarts[0].data as any).mode).toBe('roundtrip');
      expect((handoffStarts[1].data as any).target).toBe('sub_specialist');
      expect((handoffStarts[1].data as any).mode).toBe('oneway');

      // Only the roundtrip leg produces a `handoff_return` event.
      const handoffReturns = traces.filter((t) => t.type === 'handoff_return');
      expect(handoffReturns).toHaveLength(1);
      expect((handoffReturns[0].data as any).target).toBe('specialist');
    });
  });

  describe('handoff_return on target failure (gap 1)', () => {
    it('roundtrip target throws → handoff_return still emits with measurable duration', async () => {
      // Failing target makes handoffFn throw. Without try/finally on the
      // emission site, the source's loop sees the error but consumers
      // never see a handoff_return — the timeline shows handoff_start
      // with no completion. The fix wraps the emission in try/finally
      // so the event always fires.
      const targetAgent = agent({
        name: 'failing_specialist',
        model: 'mock:test',
        system: 'You always fail.',
      });
      const sourceAgent = agent({
        name: 'coordinator',
        model: 'mock:test',
        system: 'You coordinate via roundtrip handoff.',
        handoffs: [{ agent: targetAgent, mode: 'roundtrip' }],
      });

      const provider: Provider = {
        name: 'mock',
        chat: async (messages) => {
          // First call (coordinator): emit handoff tool call.
          // Second call (specialist): throw.
          const sysContent = messages.find((m) => m.role === 'system')?.content ?? '';
          if (typeof sysContent === 'string' && sysContent.includes('always fail')) {
            throw new Error('specialist exploded');
          }
          return {
            content: '',
            tool_calls: [
              {
                id: 'tc1',
                type: 'function',
                function: {
                  name: 'handoff_to_failing_specialist',
                  arguments: '{"message":"do the thing"}',
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
        stream: async function* () {
          yield {
            type: 'done',
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      };

      const { ctx, traces } = createCtx({ provider });
      await expect(ctx.ask(sourceAgent, 'go')).rejects.toThrow('specialist exploded');

      const starts = traces.filter((t) => t.type === 'handoff_start');
      const returns = traces.filter((t) => t.type === 'handoff_return');
      expect(starts).toHaveLength(1);
      // The fix: handoff_return emits even when the target throws.
      expect(returns).toHaveLength(1);
      expect(typeof (returns[0].data as { duration: number }).duration).toBe('number');
      expect((returns[0].data as { duration: number }).duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('HandoffRecord.duration backfill from target ask_end (gap 2)', () => {
    it('oneway handoff populates session HandoffRecord.duration from target ask_end', async () => {
      // Old behavior: oneway handoffs left `duration: undefined` because
      // there was no `handoff_return` event to fire the update. Fix: the
      // runtime listens for the target's `ask_end` and patches the
      // record (matched by `toAskId`) with the target's measured duration.
      const targetAgent = agent({
        name: 'oneway_specialist',
        model: 'mock:test',
        system: 'You answer.',
      });
      const sourceAgent = agent({
        name: 'oneway_coordinator',
        model: 'mock:test',
        system: 'You delegate via oneway handoff.',
        handoffs: [{ agent: targetAgent, mode: 'oneway' }],
      });

      const runtime = new AxlRuntime({});
      const provider = createSequenceProvider([
        {
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'handoff_to_oneway_specialist', arguments: '{}' },
            },
          ],
        },
        'specialist answer',
      ]);
      runtime.registerProvider('mock', provider);

      const wf = workflow({
        name: 'oneway-test',
        input: z.string(),
        handler: async (ctx) => ctx.ask(sourceAgent, ctx.input as string),
      });
      runtime.register(wf);

      const session = runtime.session('test-oneway-session');
      await session.send('oneway-test', 'Run the task');
      // Async metadata persistence — give it a tick to settle.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const records = await session.handoffs();
      expect(records).toHaveLength(1);
      expect(records[0].mode).toBe('oneway');
      expect(records[0].toAskId).toBeTypeOf('string');
      // The fix: oneway records now have a duration (target's ask_end.duration).
      expect(typeof records[0].duration).toBe('number');
      expect(records[0].duration).toBeGreaterThanOrEqual(0);
    });
  });
});
