import { describe, it, expect } from 'vitest';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { z } from 'zod';
import { createTestCtx } from './helpers.js';
import type { AxlEvent, AskScoped } from '../types.js';

describe('AxlEvent — ask correlation (askId / parentAskId / depth)', () => {
  it('every ask-scoped event during a single ctx.ask() shares the same askId', async () => {
    const a = agent({ name: 'scoped', model: 'mock:test', system: 'test' });
    const { ctx, traces } = createTestCtx();

    await ctx.ask(a, 'hello');

    const askEvents = traces.filter(
      (t) => t.type === 'ask_start' || t.type === 'ask_end' || t.type === 'agent_call_end',
    );
    expect(askEvents.length).toBeGreaterThanOrEqual(2);
    const askIds = new Set(askEvents.map((e) => (e as AxlEvent & AskScoped).askId));
    expect(askIds.size).toBe(1);
  });

  it('root ask emits depth=0 with no parentAskId', async () => {
    const a = agent({ name: 'root', model: 'mock:test', system: 'test' });
    const { ctx, traces } = createTestCtx();

    await ctx.ask(a, 'hello');

    const askStart = traces.find((t) => t.type === 'ask_start');
    expect(askStart).toBeDefined();
    const startAsk = askStart as AxlEvent & AskScoped & { type: 'ask_start' };
    expect(startAsk.depth).toBe(0);
    expect(startAsk.parentAskId).toBeUndefined();
    expect(startAsk.askId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('nested ask (agent-as-tool) carries parentAskId = outer.askId and depth = outer.depth + 1', async () => {
    // Inner agent — produces a final answer in the nested ask
    const innerAgent = agent({
      name: 'inner',
      model: 'mock:test',
      system: 'inner-prompt',
    });

    // Outer agent calls a tool whose handler invokes the inner agent
    // synchronously inside the same execution context. The nested ctx.ask
    // sees the outer ask's frame in askStorage as `parentAskId`.
    const callInner = tool({
      name: 'call_inner',
      description: 'Invoke inner agent',
      input: z.object({}),
      handler: async (_input, ctx) => {
        return await ctx.ask(innerAgent, 'inner question');
      },
    });

    const outerAgent = agent({
      name: 'outer',
      model: 'mock:test',
      system: 'outer-prompt',
      tools: [callInner],
    });

    // First outer turn: tool call. Second outer turn: final answer.
    const { ctx, traces } = createTestCtx({
      provider: undefined,
    });
    // Replace the default provider with one that emits a tool_call then an answer
    const { ctx: ctx2, traces: traces2 } = createTestCtx({
      provider: {
        name: 'mock',
        calls: [],
        chat: (() => {
          const responses = [
            {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function' as const,
                  function: { name: 'call_inner', arguments: '{}' },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
              cost: 0.001,
            },
            {
              content: 'INNER_ANSWER',
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
              cost: 0.001,
            },
            {
              content: 'OUTER_ANSWER',
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
              cost: 0.001,
            },
          ];
          let idx = 0;
          return async () => {
            const r = responses[idx] ?? responses[responses.length - 1];
            idx++;
            return r;
          };
        })(),
        stream: async function* () {
          yield {
            type: 'done' as const,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
        },
      },
    });
    void ctx;
    void traces;

    await ctx2.ask(outerAgent, 'outer prompt');

    const askStarts = traces2.filter((t) => t.type === 'ask_start');
    expect(askStarts.length).toBe(2);

    const outerStart = askStarts.find(
      (t) => (t as AxlEvent & { agent?: string }).agent === 'outer',
    ) as AxlEvent & AskScoped & { type: 'ask_start' };
    const innerStart = askStarts.find(
      (t) => (t as AxlEvent & { agent?: string }).agent === 'inner',
    ) as AxlEvent & AskScoped & { type: 'ask_start' };

    expect(outerStart).toBeDefined();
    expect(innerStart).toBeDefined();
    expect(outerStart.depth).toBe(0);
    expect(innerStart.depth).toBe(1);
    expect(innerStart.parentAskId).toBe(outerStart.askId);
    expect(outerStart.askId).not.toBe(innerStart.askId);
  });

  it('step counter is monotonic and shared across nested asks', async () => {
    const inner = agent({ name: 'inner', model: 'mock:test', system: 'inner' });
    const callInner = tool({
      name: 'call_inner',
      description: 'Invoke inner',
      input: z.object({}),
      handler: async (_input, ctx) => ctx.ask(inner, 'q'),
    });
    const outer = agent({
      name: 'outer',
      model: 'mock:test',
      system: 'outer',
      tools: [callInner],
    });

    const responses = [
      {
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function' as const,
            function: { name: 'call_inner', arguments: '{}' },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: 0.001,
      },
      {
        content: 'INNER',
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: 0.001,
      },
      {
        content: 'OUTER',
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: 0.001,
      },
    ];
    let idx = 0;
    const { ctx, traces } = createTestCtx({
      provider: {
        name: 'mock',
        calls: [],
        chat: async () => {
          const r = responses[idx] ?? responses[responses.length - 1];
          idx++;
          return r;
        },
        stream: async function* () {
          yield {
            type: 'done' as const,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
        },
      },
    });

    await ctx.ask(outer, 'go');

    const steps = traces.map((t) => t.step);
    // Strictly monotonic: every event's step is greater than the previous one.
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThan(steps[i - 1]);
    }
  });
});
