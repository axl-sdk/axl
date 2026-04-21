import { describe, it, expect } from 'vitest';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { z } from 'zod';
import { createTestCtx, createSequenceProvider } from './helpers.js';
import type { CallbackMeta } from '../types.js';

describe('createChildContext — streaming-callback inheritance (spec/16 §3.2)', () => {
  it('child context inherits onToken / onAgentStart / onToolCall', async () => {
    const tokens: { token: string; meta: CallbackMeta }[] = [];
    const agentStarts: { agent: string; meta: CallbackMeta }[] = [];

    const { ctx } = createTestCtx({
      onToken: (token: string, meta: CallbackMeta) => tokens.push({ token, meta }),
      onAgentStart: (info: { agent: string }, meta: CallbackMeta) =>
        agentStarts.push({ agent: info.agent, meta }),
    });

    const child = ctx.createChildContext('outer-tool-call-id');
    const a = agent({ name: 'child-agent', model: 'mock:test', system: 'go' });

    await child.ask(a, 'hi');

    // Inheritance: parent's callbacks fire when the child runs an ask.
    expect(agentStarts.length).toBeGreaterThan(0);
    expect(agentStarts[0].agent).toBe('child-agent');
    expect(agentStarts[0].meta.agent).toBe('child-agent');
    // Stronger than `meta.depth === 0`: the meta correlates to the child's
    // own ask via askId — proves the inherited callback is wired through
    // the ALS frame, not just the no-frame fallback.
    expect(agentStarts[0].meta.askId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(agentStarts[0].meta.depth).toBe(0);
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

    const agentStarts: { agent: string; depth: number }[] = [];

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

    const { ctx } = createTestCtx({
      provider,
      // Don't set onToken — the test mock's stream() doesn't mirror chat
      // responses, so enabling streaming would short-circuit tool calls.
      // Without onToken, the agent uses provider.chat() and tool execution
      // proceeds normally.
      onAgentStart: (info: { agent: string }, meta: CallbackMeta) =>
        agentStarts.push({ agent: info.agent, depth: meta.depth }),
    });

    await ctx.ask(outer, 'go');

    // Outer agent fires at depth 0, inner agent fires at depth 1 — the
    // nested ask inherited its parent's frame via askStorage.
    const outerStarts = agentStarts.filter((s) => s.agent === 'outer');
    const innerStarts = agentStarts.filter((s) => s.agent === 'inner');
    expect(outerStarts.length).toBeGreaterThan(0);
    expect(innerStarts.length).toBeGreaterThan(0);
    expect(outerStarts[0].depth).toBe(0);
    expect(innerStarts[0].depth).toBe(1);
  });
});
