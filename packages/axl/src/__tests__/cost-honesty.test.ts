import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { createTestCtx } from './helpers.js';
import { redactEvent } from '../redaction.js';
import type { Provider, ProviderResponse, StreamChunk } from '../providers/types.js';
import type { AxlEvent } from '../types.js';

// ---------------------------------------------------------------------------
// T2.5 — ask_end.unpriced signal. An ask whose cost-bearing leaf did measurable
// work (returned usage/tokens) but had no usable cost (unpriced model /
// pricing-table miss) must flag `unpriced` so the aggregate cost reads as a
// lower bound, not a misleading exact figure. A failed call (no usage) must NOT
// flag it.
// ---------------------------------------------------------------------------

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

/** A provider returning a fixed sequence of full ProviderResponses (we control
 *  usage/cost exactly — MockProvider coerces cost to 0, which we can't use here). */
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

/** A streaming provider: yields a text delta then a `done` chunk that carries
 *  usage/cost only when provided (mirrors a real provider — no fabricated usage). */
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

type AskEnd = Extract<AxlEvent, { type: 'ask_end' }>;
function askEnd(traces: AxlEvent[]): AskEnd | undefined {
  return traces.find((t) => t.type === 'ask_end') as AskEnd | undefined;
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

describe('ask_end.unpriced (T2.5)', () => {
  it('flags an ask whose call returned usage but NO cost (unpriced model)', async () => {
    const { ctx, traces } = createTestCtx({ provider: seqProvider([{ content: 'ok', usage }]) });
    await ctx.ask(plain(), 'hi');
    expect(askEnd(traces)?.unpriced).toBe(true);
  });

  it('does NOT flag a priced ask (cost present)', async () => {
    const { ctx, traces } = createTestCtx({
      provider: seqProvider([{ content: 'ok', usage, cost: 0.002 }]),
    });
    await ctx.ask(plain(), 'hi');
    const end = askEnd(traces);
    expect(end?.unpriced).toBeFalsy();
    expect(end?.cost).toBeCloseTo(0.002, 6);
  });

  it('does NOT flag a known-free call (cost: 0 is a real zero, not unknown)', async () => {
    const { ctx, traces } = createTestCtx({
      provider: seqProvider([{ content: 'ok', usage, cost: 0 }]),
    });
    await ctx.ask(plain(), 'hi');
    expect(askEnd(traces)?.unpriced).toBeFalsy();
  });

  it('does NOT flag when there is no usage at all (nothing measurable to price)', async () => {
    const { ctx, traces } = createTestCtx({ provider: seqProvider([{ content: 'ok' }]) });
    await ctx.ask(plain(), 'hi');
    expect(askEnd(traces)?.unpriced).toBeFalsy();
  });

  it('does NOT flag a FAILED call (error path emits neither cost nor tokens)', async () => {
    const { ctx, traces } = createTestCtx({ provider: throwingProvider() });
    await expect(ctx.ask(plain(), 'hi')).rejects.toThrow('provider boom');
    const end = askEnd(traces);
    expect(end?.outcome.ok).toBe(false);
    expect(end?.unpriced).toBeFalsy(); // a failure is not "unpriced"
  });

  it('flags an ask that MIXES a priced and an unpriced call (cost is a lower bound)', async () => {
    const provider = seqProvider([
      { content: '', tool_calls: [toolCall], usage, cost: 0.001 }, // priced tool-calling turn
      { content: 'done', usage }, // unpriced final turn
    ]);
    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(agent({ name: 'a', model: 'mock:test', system: 's', tools: [noopTool] }), 'hi');
    const end = askEnd(traces);
    expect(end?.unpriced).toBe(true);
    expect(end?.cost).toBeCloseTo(0.001, 6); // only the priced turn counted
  });

  it('does NOT flag when a free tool runs but every LLM call is priced', async () => {
    const provider = seqProvider([
      { content: '', tool_calls: [toolCall], usage, cost: 0.001 },
      { content: 'done', usage, cost: 0.001 },
    ]);
    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(agent({ name: 'a', model: 'mock:test', system: 's', tools: [noopTool] }), 'hi');
    expect(askEnd(traces)?.unpriced).toBeFalsy();
  });

  it('redaction preserves the unpriced flag (load-bearing, not a content field)', async () => {
    const { ctx, traces } = createTestCtx({ provider: seqProvider([{ content: 'ok', usage }]) });
    await ctx.ask(plain(), 'hi');
    const redacted = redactEvent(askEnd(traces)!) as { unpriced?: boolean };
    expect(redacted.unpriced).toBe(true);
  });

  // ── Streaming parity (regression guard for the fabricated-zero-usage bug) ──
  it('STREAMING: a done chunk with NO usage does NOT flag unpriced (parity with chat)', async () => {
    // The bug: the streaming branch fabricated {0,0,0} usage, so a no-usage
    // streamed call (every $0 local provider that omits the usage chunk) was
    // wrongly flagged as unpriced. It must behave exactly like non-streaming.
    const { ctx, traces } = createTestCtx({
      provider: streamProvider({ content: 'hi' }), // no usage
      onToken: () => {}, // enables the streaming path
    });
    await ctx.ask(plain(), 'hi');
    expect(askEnd(traces)?.unpriced).toBeFalsy();
  });

  it('STREAMING: a done chunk WITH usage but no cost DOES flag unpriced', async () => {
    const { ctx, traces } = createTestCtx({
      provider: streamProvider({ content: 'hi', usage }), // usage, no cost
      onToken: () => {},
    });
    await ctx.ask(plain(), 'hi');
    expect(askEnd(traces)?.unpriced).toBe(true);
  });

  it('emits unpriced on the handoff-roundtrip target ask_end (not just the main loop)', async () => {
    // The target ask_end is emitted at a DIFFERENT code site than the main loop;
    // verify the signal rides it. Source turns are priced; only the target is not.
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
    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(source, 'coordinate');

    const ends = traces.filter((t) => t.type === 'ask_end') as AskEnd[];
    const targetEnd = ends.find((e) => e.agent === 'target');
    const sourceEnd = ends.find((e) => e.agent === 'source');
    expect(targetEnd?.unpriced).toBe(true); // the unpriced target turn flags its own ask
    expect(sourceEnd?.unpriced).toBeFalsy(); // source turns were all priced
  });
});
