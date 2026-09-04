import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent, workflow } from '@axlsdk/axl';
import type { StreamChunk } from '@axlsdk/axl';
import { MockProvider } from '../mock-provider.js';
import { AxlTestRuntime } from '../test-runtime.js';

// `MockProvider.stream()` forwards `cost` on its synthesized `done` chunk, the
// same way `chat()` returns it on `ProviderResponse`. Before that, a fixture
// with a `cost` priced correctly when asked non-streamed and reported nothing at
// all when streamed — so every cost assertion and every `ctx.budget` guard
// silently saw `$0` on the streaming path. A mock that disagrees with itself
// between the two paths makes a passing streaming budget test worthless.

const Bot = agent({ name: 'streamer', model: 'openai:gpt-4o-mini', system: 'terse' });

async function drain(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('MockProvider — streamed cost parity', () => {
  it('puts the fixture cost on the done chunk, matching chat()', async () => {
    const chunks = await drain(
      MockProvider.sequence([{ content: 'a', cost: 0.5 }]).stream(
        [{ role: 'user', content: 'x' }],
        {},
      ),
    );
    const done = chunks.find((c) => c.type === 'done');
    expect(done?.type === 'done' && done.cost).toBe(0.5);

    // Same fixture, non-streamed: the two paths must agree on the price.
    const chatted = await MockProvider.sequence([{ content: 'a', cost: 0.5 }]).chat(
      [{ role: 'user', content: 'x' }],
      {},
    );
    expect(chatted.cost).toBe(0.5);
  });

  it('reports the cost on agent_call_end for a streamed ask', async () => {
    const OneAsk = workflow({
      name: 'OneAsk',
      input: z.object({}),
      handler: async (ctx) => {
        // Allocating the event bus is what flips asks onto `provider.stream()`
        // — the path that reported no cost at all.
        void ctx.events;
        return await ctx.ask(Bot, 'one');
      },
    });

    const runtime = new AxlTestRuntime();
    runtime.register(OneAsk);
    runtime.mockProvider('openai', MockProvider.sequence([{ content: 'a', cost: 0.5 }]));

    await runtime.execute('OneAsk', {});

    const ends = runtime.traceLog().filter((e) => e.type === 'agent_call_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].cost).toBe(0.5);
    expect(runtime.totalCost()).toBe(0.5);
  });

  it('lets ctx.budget see a streamed ask and stop the run', async () => {
    // Three priced streamed asks at $0.5 against a $0.60 cap. With the streamed
    // `done` chunk reporting no cost, the budget accumulates $0, never reports
    // `budgetExceeded`, and all three asks complete — the guard would pass
    // vacuously. Both assertions below fail without the forwarded `cost`.
    let completed = 0;
    let exceeded: boolean | undefined;
    const Budgeted = workflow({
      name: 'Budgeted',
      input: z.object({}),
      handler: async (ctx) => {
        void ctx.events;
        const result = await ctx.budget({ cost: '$0.60' }, async () => {
          for (let i = 0; i < 3; i++) {
            await ctx.ask(Bot, `ask ${i}`);
            completed++;
          }
        });
        exceeded = result.budgetExceeded;
        return 'ok';
      },
    });

    const runtime = new AxlTestRuntime();
    runtime.register(Budgeted);
    runtime.mockProvider(
      'openai',
      MockProvider.sequence([
        { content: 'a', cost: 0.5 },
        { content: 'b', cost: 0.5 },
        { content: 'c', cost: 0.5 },
      ]),
    );

    await runtime.execute('Budgeted', {});

    expect(exceeded).toBe(true);
    // `finish_and_stop` lets the ask that crosses the cap finish, then blocks
    // the next one: 2 of 3, not all 3.
    expect(completed).toBe(2);
  });
});
