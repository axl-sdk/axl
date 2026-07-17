import { describe, it, expect } from 'vitest';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { z } from 'zod';
import { createTestCtx, createSequenceProvider } from './helpers.js';

describe('createChildContext — event-stream inheritance (spec/16 §3.2)', () => {
  it('child context emits through the parent event bus', async () => {
    const { ctx } = createTestCtx();
    const agentStarts: Array<{ agent: string; askId: string; depth: number }> = [];
    ctx.events.on('agent_call_start', (event) => {
      agentStarts.push({ agent: event.agent, askId: event.askId, depth: event.depth });
    });

    const child = ctx.createChildContext();
    const a = agent({ name: 'child-agent', model: 'mock:test', system: 'go' });

    await child.ask(a, 'hi');

    // Inheritance: the parent's event observer sees the child's ask.
    expect(agentStarts.length).toBeGreaterThan(0);
    expect(agentStarts[0].agent).toBe('child-agent');
    expect(agentStarts[0].askId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(agentStarts[0].depth).toBe(0);
  });

  it('nested ask emits meta.depth >= 1 so consumers can filter root-only', async () => {
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

    const provider = createSequenceProvider([
      {
        tool_calls: [
          {
            id: 'call_1',
            type: 'function' as const,
            function: { name: 'call_inner', arguments: '{}' },
          },
        ],
      },
      'INNER_RESULT',
      'OUTER_RESULT',
    ]);

    const { ctx, traces } = createTestCtx({ provider });

    await ctx.ask(outer, 'go');

    // Outer agent fires at depth 0, inner agent fires at depth 1 — the
    // nested ask inherited its parent's frame via askStorage.
    const agentStarts = traces.filter((event) => event.type === 'agent_call_start');
    const outerStarts = agentStarts.filter((event) => event.agent === 'outer');
    const innerStarts = agentStarts.filter((event) => event.agent === 'inner');
    expect(outerStarts.length).toBeGreaterThan(0);
    expect(innerStarts.length).toBeGreaterThan(0);
    expect(outerStarts[0].depth).toBe(0);
    expect(innerStarts[0].depth).toBe(1);
  });
});
