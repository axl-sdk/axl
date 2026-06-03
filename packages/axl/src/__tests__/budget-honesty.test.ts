import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { workflow } from '../workflow.js';
import { AxlRuntime } from '../runtime.js';
import { createTestCtx } from './helpers.js';
import { MemoryManager } from '../memory/manager.js';
import { InMemoryVectorStore } from '../memory/vector-memory.js';
import { MemoryStore } from '../state/memory.js';
import type { Embedder, EmbedResult } from '../memory/types.js';
import type { Provider, ProviderResponse, StreamChunk } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Part A — budget honesty (L1). A `ctx.budget()` block that runs an unpriced
// model (positive tokens, no usable cost) must REPORT it: `BudgetResult.unpriced`
// / `getBudgetStatus().unpriced` become true and `totalCost` is a lower bound.
// Crucially this is REPORTING only — the cost limit / hard_stop still cannot
// enforce on unpriced spend (the enforcement rail never sees it). These tests
// try to break both halves: the honesty signal AND the enforcement boundary.
// ---------------------------------------------------------------------------

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

/** Replays full ProviderResponses verbatim (MockProvider coerces cost to 0, unusable here). */
function seqProvider(responses: ProviderResponse[]): Provider {
  let i = 0;
  return {
    name: 'mock',
    async chat() {
      return responses[Math.min(i++, responses.length - 1)];
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'done' };
    },
  };
}

/** Streaming provider: a text delta then a `done` chunk carrying usage/cost only when given. */
function streamProvider(opts: {
  content?: string;
  usage?: ProviderResponse['usage'];
  cost?: number;
}): Provider {
  const content = opts.content ?? 'ok';
  return {
    name: 'mock',
    async chat() {
      return { content, usage: opts.usage, cost: opts.cost };
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', content };
      yield {
        type: 'done',
        ...(opts.usage
          ? {
              usage: {
                prompt_tokens: opts.usage.prompt_tokens,
                completion_tokens: opts.usage.completion_tokens,
                total_tokens: opts.usage.total_tokens,
              },
            }
          : {}),
        ...(opts.cost !== undefined ? { cost: opts.cost } : {}),
      };
    },
  };
}

function throwingProvider(): Provider {
  return {
    name: 'mock',
    async chat(): Promise<ProviderResponse> {
      throw new Error('provider boom');
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'done' };
    },
  };
}

/** Embedder that reports usage but (optionally) no cost — an unpriced embedder. */
class MockEmbedder implements Embedder {
  readonly dimensions = 3;
  reportUsage?: { cost?: number; tokens?: number; model?: string };
  async embed(texts: string[]): Promise<EmbedResult> {
    const vectors = texts.map(() => [0.5, 0.5, 0]);
    return this.reportUsage ? { vectors, usage: this.reportUsage } : { vectors };
  }
}

const plain = () => agent({ name: 'a', model: 'mock:test', system: 's' });
const noopTool = tool({
  name: 'noop',
  description: 'no-op',
  input: z.object({}),
  handler: async () => 'tool-result',
});
const toolCall = {
  id: 't1',
  type: 'function' as const,
  function: { name: 'noop', arguments: '{}' },
};

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe('budget honesty — BudgetResult.unpriced (Part A)', () => {
  it('flags a budget whose call returned usage but NO cost (unpriced model)', async () => {
    const { ctx } = createTestCtx({ provider: seqProvider([{ content: 'ok', usage }]) });
    const r = await ctx.budget({ cost: '$5' }, () => ctx.ask(plain(), 'hi'));
    expect(r.unpriced).toBe(true);
    expect(r.totalCost).toBe(0); // unpriced spend is unmeasured, contributes 0
  });

  it('does NOT flag a priced budget (and does not warn)', async () => {
    const { ctx } = createTestCtx({
      provider: seqProvider([{ content: 'ok', usage, cost: 0.002 }]),
    });
    const r = await ctx.budget({ cost: '$5' }, () => ctx.ask(plain(), 'hi'));
    expect(r.unpriced).toBe(false);
    expect(r.totalCost).toBeCloseTo(0.002, 6);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('flags a budget that MIXES priced + unpriced calls; totalCost is the priced lower bound', async () => {
    const provider = seqProvider([
      { content: '', tool_calls: [toolCall], usage, cost: 0.001 }, // priced tool-calling turn
      { content: 'done', usage }, // unpriced final turn
    ]);
    const { ctx } = createTestCtx({ provider });
    const r = await ctx.budget({ cost: '$5' }, () =>
      ctx.ask(agent({ name: 'a', model: 'mock:test', system: 's', tools: [noopTool] }), 'hi'),
    );
    expect(r.unpriced).toBe(true);
    expect(r.totalCost).toBeCloseTo(0.001, 6); // only the priced turn counted
  });

  it('ENFORCEMENT still works on priced spend (regression: honesty must not break exceeded/limit)', async () => {
    // Two priced calls of $0.001 against a $0.0015 limit → the 2nd trips `exceeded`.
    const { ctx } = createTestCtx({
      provider: seqProvider([{ content: 'ok', usage, cost: 0.001 }]),
    });
    const r = await ctx.budget({ cost: '$0.0015' }, async () => {
      await ctx.ask(plain(), 'one');
      await ctx.ask(plain(), 'two');
      return 'done';
    });
    expect(r.budgetExceeded).toBe(true);
    expect(r.unpriced).toBe(false);
    expect(r.totalCost).toBeCloseTo(0.002, 6);
  });

  it('HONESTY ≠ ENFORCEMENT: a hard_stop budget does NOT trip on unpriced spend', async () => {
    // The load-bearing guard: a user must not believe their $0.01 hard_stop now
    // governs Bedrock/self-hosted. Five unpriced calls all run; nothing trips.
    const { ctx } = createTestCtx({ provider: seqProvider([{ content: 'ok', usage }]) });
    let calls = 0;
    const r = await ctx.budget({ cost: '$0.01', onExceed: 'hard_stop' }, async () => {
      for (let i = 0; i < 5; i++) {
        await ctx.ask(plain(), 'hi');
        calls++;
      }
      return 'all-ran';
    });
    expect(r.value).toBe('all-ran');
    expect(r.budgetExceeded).toBe(false); // unpriced spend never trips the limit
    expect(r.unpriced).toBe(true); // …but it is honestly reported as a lower bound
    expect(calls).toBe(5);
  });

  it('flags a FRAMELESS cost-bearing leaf — ctx.remember(embed) under budget, no ask frame', async () => {
    // Proves A1's de-gating: budget detection is NOT gated on an ask frame. A direct
    // semantic memory op emits a cost-bearing leaf with no ALS frame; the budget must
    // still see it. Unpriced embedder = usage tokens, no cost.
    const embedder = new MockEmbedder();
    embedder.reportUsage = { tokens: 5 }; // tokens, NO cost → unpriced
    const memoryManager = new MemoryManager({ vectorStore: new InMemoryVectorStore(), embedder });
    const { ctx } = createTestCtx({ memoryManager, stateStore: new MemoryStore() });
    const r = await ctx.budget({ cost: '$5' }, () =>
      ctx.remember('k', 'v', { embed: true, scope: 'global' }),
    );
    expect(r.unpriced).toBe(true);
  });

  it('propagates the unpriced flag from a nested budget to its parent', async () => {
    const { ctx } = createTestCtx({ provider: seqProvider([{ content: 'ok', usage }]) });
    const r = await ctx.budget({ cost: '$5' }, async () => {
      const inner = await ctx.budget({ cost: '$1' }, () => ctx.ask(plain(), 'hi'));
      expect(inner.unpriced).toBe(true);
      return inner.value;
    });
    expect(r.unpriced).toBe(true); // inner's lower-bound nature rolls up to the parent
  });

  it('reports unpriced via getBudgetStatus() mid-block', async () => {
    const { ctx } = createTestCtx({ provider: seqProvider([{ content: 'ok', usage }]) });
    await ctx.budget({ cost: '$5' }, async () => {
      expect(ctx.getBudgetStatus()?.unpriced).toBe(false); // nothing spent yet
      await ctx.ask(plain(), 'hi');
      expect(ctx.getBudgetStatus()?.unpriced).toBe(true);
    });
    expect(ctx.getBudgetStatus()).toBeNull(); // outside any block
  });

  it('does NOT flag a FAILED call (error path emits neither cost nor tokens)', async () => {
    const { ctx } = createTestCtx({ provider: throwingProvider() });
    const r = await ctx.budget({ cost: '$5' }, async () => {
      await ctx.ask(plain(), 'hi').catch(() => {}); // swallow so the block completes
      return 'ok';
    });
    expect(r.unpriced).toBe(false); // a failure is not "unpriced"
  });

  it('warns at most ONCE per budget block across many unpriced calls', async () => {
    const { ctx } = createTestCtx({ provider: seqProvider([{ content: 'ok', usage }]) });
    await ctx.budget({ cost: '$5' }, async () => {
      for (let i = 0; i < 4; i++) await ctx.ask(plain(), 'hi');
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('Budget honesty');
  });

  // ── Streaming parity (the fabricated-zero-usage bug class must not resurface) ──
  it('STREAMING: a done chunk with NO usage does NOT flag the budget unpriced', async () => {
    const { ctx } = createTestCtx({
      provider: streamProvider({ content: 'hi' }), // no usage
      onToken: () => {}, // enables the streaming path
    });
    const r = await ctx.budget({ cost: '$5' }, () => ctx.ask(plain(), 'hi'));
    expect(r.unpriced).toBe(false);
  });

  it('STREAMING: a done chunk WITH positive tokens but no cost DOES flag unpriced', async () => {
    const { ctx } = createTestCtx({
      provider: streamProvider({ content: 'hi', usage }), // usage, no cost
      onToken: () => {},
    });
    const r = await ctx.budget({ cost: '$5' }, () => ctx.ask(plain(), 'hi'));
    expect(r.unpriced).toBe(true);
  });

  it('captures an unpriced target turn through a roundtrip HANDOFF inside a budget', async () => {
    // The target ask_end is emitted at a different code site; the budget flag rides
    // the LEAF events regardless of the active frame, so the source budget sees it.
    const target = agent({ name: 'target', model: 'mock:test', system: 'specialist' });
    const source = agent({
      name: 'source',
      model: 'mock:test',
      system: 'coordinator',
      handoffs: [{ agent: target, mode: 'roundtrip' }],
    });
    const provider = seqProvider([
      {
        content: '',
        tool_calls: [
          {
            id: 'h1',
            type: 'function',
            function: { name: 'handoff_to_target', arguments: '{"message":"go"}' },
          },
        ],
        usage,
        cost: 0.001,
      },
      { content: 'specialist answer', usage }, // target turn — UNPRICED
      { content: 'final', usage, cost: 0.001 }, // source resumes — priced
    ]);
    const { ctx } = createTestCtx({ provider });
    const r = await ctx.budget({ cost: '$5' }, () => ctx.ask(source, 'coordinate'));
    expect(r.unpriced).toBe(true); // the unpriced target turn makes the whole budget a lower bound
    expect(r.totalCost).toBeCloseTo(0.002, 6); // only the two priced source turns counted
  });

  it('does NOT warn for the runtime ambient (Infinity-limit) budget — no user limit was set', async () => {
    // runtime.execute() installs an ambient budgetContext with limit:Infinity. An
    // unpriced call there must NOT print "your cost limit is a lower bound" — there
    // is no limit. The unpriced flag may still be recorded; only the warn is gated.
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', seqProvider([{ content: 'ok', usage }]) as never);
    const wf = workflow({
      name: 'amb',
      input: z.any(),
      handler: async (ctx) => ctx.ask(agent({ name: 'a', model: 'mock:test', system: 's' }), 'hi'),
    });
    runtime.register(wf);
    await runtime.execute('amb', {});
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
