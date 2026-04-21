import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { workflow } from '../workflow.js';
import { AxlRuntime } from '../runtime.js';
import { createTestCtx, createSequenceProvider } from './helpers.js';
import type { AxlEvent, AskScoped } from '../types.js';

describe('ask_start / ask_end lifecycle (spec/16 §3.8)', () => {
  it('emits exactly one ask_start and one ask_end per ctx.ask() on the success path', async () => {
    const a = agent({ name: 'lifecycle', model: 'mock:test', system: 'system' });
    const { ctx, traces } = createTestCtx();

    await ctx.ask(a, 'hello');

    const starts = traces.filter((t) => t.type === 'ask_start');
    const ends = traces.filter((t) => t.type === 'ask_end');
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);

    // ask_start carries the prompt; ask_end carries outcome.ok=true with result.
    const start = starts[0] as AxlEvent & AskScoped & { type: 'ask_start'; prompt: string };
    const end = ends[0] as AxlEvent &
      AskScoped & {
        type: 'ask_end';
        outcome: { ok: true; result: unknown } | { ok: false; error: string };
        cost: number;
        duration: number;
      };
    expect(start.prompt).toBe('hello');
    expect(end.outcome.ok).toBe(true);
    if (end.outcome.ok) {
      expect(end.outcome.result).toBe('Done');
    }
    expect(typeof end.cost).toBe('number');
    expect(typeof end.duration).toBe('number');
    expect(end.askId).toBe(start.askId);
  });

  it('emits ask_end with outcome.ok=false when the LLM call throws (e.g., schema retries exhausted)', async () => {
    const a = agent({ name: 'fail', model: 'mock:test', system: 'system' });
    // The default test provider returns "Done" — pair it with a strict
    // schema that the response can't satisfy. Schema retries exhaust and
    // ctx.ask() throws VerifyError, which the ask body catches in finally.
    const { ctx, traces } = createTestCtx();

    await expect(
      ctx.ask(a, 'expect failure', {
        schema: z.object({ shouldNotMatch: z.literal('value') }),
        retries: 0,
      }),
    ).rejects.toThrow();

    const ends = traces.filter((t) => t.type === 'ask_end');
    expect(ends.length).toBe(1);
    const end = ends[0] as AxlEvent & {
      outcome: { ok: true; result: unknown } | { ok: false; error: string };
    };
    expect(end.outcome.ok).toBe(false);
    if (!end.outcome.ok) {
      expect(typeof end.outcome.error).toBe('string');
    }
  });

  it('ask_end.cost rolls up agent_call_end + tool_call_end WITHIN the ask, excluding nested asks (spec decision 10)', async () => {
    // Setup: outer agent calls a tool that invokes an inner agent. The inner
    // ask has its own ask_end with its own cost. The outer ask_end MUST NOT
    // double-count the inner cost — only its own agent_call_end events.
    const inner = agent({ name: 'inner', model: 'mock:test', system: 'inner' });
    const callInner = tool({
      name: 'call_inner',
      description: 'Call inner',
      input: z.object({}),
      handler: async (_input, ctx) => ctx.ask(inner, 'q'),
    });
    const outer = agent({
      name: 'outer',
      model: 'mock:test',
      system: 'outer',
      tools: [callInner],
    });

    // Each chat call costs $0.001 (createSequenceProvider default).
    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'c1',
            type: 'function' as const,
            function: { name: 'call_inner', arguments: '{}' },
          },
        ],
      },
      'INNER',
      'OUTER',
    ]);
    const { ctx, traces } = createTestCtx({ provider });

    await ctx.ask(outer, 'go');

    const askEnds = traces.filter((t) => t.type === 'ask_end') as Array<
      AxlEvent & AskScoped & { type: 'ask_end'; cost: number }
    >;
    expect(askEnds.length).toBe(2);

    const innerEnd = askEnds.find((e) => (e as AxlEvent & { agent?: string }).agent === 'inner')!;
    const outerEnd = askEnds.find((e) => (e as AxlEvent & { agent?: string }).agent === 'outer')!;

    // Inner ask: 1 chat call → $0.001.
    expect(innerEnd.cost).toBeCloseTo(0.001, 5);
    // Outer ask: 2 chat calls (turn 1 with tool_call + turn 2 final) → $0.002.
    // The inner ask's $0.001 does NOT roll up here.
    expect(outerEnd.cost).toBeCloseTo(0.002, 5);
  });

  it('does NOT emit a workflow-level error event for ask-internal throws (spec decision 9)', async () => {
    // A workflow whose handler throws via ctx.ask() — the ask emits
    // ask_end(ok:false) and the throw propagates to runtime.execute which
    // emits workflow_end(status: 'failed'). No `error` event should fire
    // because ask_end is the authoritative failure record.
    const a = agent({ name: 'wfail', model: 'mock:test', system: 'system' });
    const wf = workflow({
      name: 'ask-fail-wf',
      input: z.object({}),
      handler: async (ctx) => {
        return ctx.ask(a, 'fail', {
          schema: z.object({ never: z.literal('matches') }),
          retries: 0,
        });
      },
    });

    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', {
      name: 'mock',
      chat: async () => ({
        content: 'plain text',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 0.001,
      }),
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    });
    runtime.register(wf);

    const collected: AxlEvent[] = [];
    runtime.on('trace', (event: AxlEvent) => collected.push(event));

    await expect(runtime.execute('ask-fail-wf', {})).rejects.toThrow();

    const askEnds = collected.filter((e) => e.type === 'ask_end');
    const errorEvents = collected.filter((e) => e.type === 'error');
    expect(askEnds.length).toBeGreaterThan(0);
    expect(
      askEnds.every((e) => (e as AxlEvent & { outcome?: { ok?: boolean } }).outcome?.ok === false),
    ).toBe(true);
    // Workflow lifecycle still emits workflow_end(failed); the workflow-level
    // `error` discriminant is reserved for failures with no ask_end available.
    expect(errorEvents.length).toBe(0);
  });
});
