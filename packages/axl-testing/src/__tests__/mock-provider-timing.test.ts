import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent, workflow } from '@axlsdk/axl';
import type { CallTiming, StreamChunk } from '@axlsdk/axl';
import { MockProvider } from '../mock-provider.js';
import { AxlTestRuntime } from '../test-runtime.js';

// Frozen behavioral matrix group M (R-T7 / AC-7): `MockProvider` passes a
// `timing` block straight through to `ProviderResponse.timing` and to the
// synthesized terminal `done` chunk, so runtime, TimeoutError and eval-rollup
// tests get deterministic provider timing without a real clock or transport.

const TIMING: CallTiming = {
  queuedMs: 11,
  attempts: 2,
  retryMs: 22,
  ttfbMs: 33,
  firstTokenMs: 44,
  wireMs: 55,
};

async function drain(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function doneChunkOf(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'done' }> {
  const done = chunks.find((c) => c.type === 'done');
  if (!done || done.type !== 'done') throw new Error('no done chunk was yielded');
  return done;
}

describe('MockProvider — timing passthrough (R-T7)', () => {
  // M1
  it('sequence(): chat() surfaces the timing block on ProviderResponse, by value', async () => {
    const fixture = { ...TIMING };
    const provider = MockProvider.sequence([{ content: 'hi', timing: fixture }]);

    const first = await provider.chat([{ role: 'user', content: 'a' }], {});
    expect(first.timing).toEqual(TIMING);

    // Copied, not shared: mutating what one call returned must not rewrite the
    // fixture a later call reads. A by-reference passthrough fails here.
    first.timing!.wireMs = 9999;
    expect(fixture.wireMs).toBe(55);

    const provider2 = MockProvider.sequence([{ content: 'a', timing: fixture }, { content: 'b' }]);
    const a = await provider2.chat([{ role: 'user', content: 'x' }], {});
    a.timing!.queuedMs = 9999;
    const b = await provider2.chat([{ role: 'user', content: 'y' }], {});
    expect(b.timing).toBeUndefined();
    expect(fixture.queuedMs).toBe(11);
  });

  // M2
  it('sequence(): stream() carries the timing block on the terminal done chunk', async () => {
    const provider = MockProvider.sequence([{ content: 'hello', timing: TIMING }]);

    const done = doneChunkOf(await drain(provider.stream([{ role: 'user', content: 'x' }], {})));
    expect(done.timing).toEqual(TIMING);
    // The done chunk's existing payload is untouched.
    expect(done.usage).toEqual({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
  });

  it('sequence(): a chunked stream still ends with one timed done chunk', async () => {
    const provider = MockProvider.sequence([
      { content: 'abcdef', chunks: ['abc', 'def'], timing: TIMING },
    ]);

    const chunks = await drain(provider.stream([{ role: 'user', content: 'x' }], {}));
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(1);
    expect(doneChunkOf(chunks).timing).toEqual(TIMING);
  });

  // M3 — absence must be absence, not `timing: undefined` or `timing: {}`.
  it('omitting timing leaves the key off both the response and the done chunk', async () => {
    const provider = MockProvider.sequence([{ content: 'hi' }]);

    const response = await provider.chat([{ role: 'user', content: 'x' }], {});
    expect('timing' in response).toBe(false);

    const provider2 = MockProvider.sequence([{ content: 'hi' }]);
    const done = doneChunkOf(await drain(provider2.stream([{ role: 'user', content: 'x' }], {})));
    expect('timing' in done).toBe(false);
  });

  it('echo() and json() report no timing', async () => {
    const echoed = await MockProvider.echo().chat([{ role: 'user', content: 'x' }], {});
    expect('timing' in echoed).toBe(false);

    const generated = await MockProvider.json(z.object({ a: z.string() })).chat(
      [{ role: 'user', content: 'x' }],
      {},
    );
    expect('timing' in generated).toBe(false);
  });

  // M4 — `fn()` varying timing by call index, observed end to end on
  // `agent_call_end`. Both halves live in one test because the point is that the
  // per-call value survives the whole path, not that either half works alone.
  it('fn(): per-call timing varies by call index and reaches each agent_call_end', async () => {
    const provider = MockProvider.fn((_messages, callIndex) => ({
      content: `r${callIndex}`,
      timing: { ...TIMING, wireMs: 100 * (callIndex + 1) },
    }));

    const Bot = agent({ model: 'openai:gpt-4o-mini', system: 'you are terse' });
    const TwoAsks = workflow({
      name: 'TwoAsksFn',
      input: z.object({}),
      handler: async (ctx) => {
        await ctx.ask(Bot, 'one');
        await ctx.ask(Bot, 'two');
        return 'ok';
      },
    });

    const runtime = new AxlTestRuntime();
    runtime.register(TwoAsks);
    runtime.mockProvider('openai', provider);

    await runtime.execute('TwoAsksFn', {});

    // A value captured once at provider construction would repeat 100 twice.
    const ends = runtime.traceLog().filter((e) => e.type === 'agent_call_end');
    expect(ends.map((e) => (e as { timing?: CallTiming }).timing?.wireMs)).toEqual([100, 200]);
  });

  it('replay(): a recorded ProviderResponse keeps its timing', async () => {
    const provider = MockProvider.replay([{ content: 'recorded', timing: TIMING }]);
    const response = await provider.chat([{ role: 'user', content: 'x' }], {});
    expect(response.timing).toEqual(TIMING);
  });

  it('drives agent_call_end.timing per provider call from a sequence', async () => {
    const Bot = agent({ model: 'openai:gpt-4o-mini', system: 'you are terse' });
    const TwoAsks = workflow({
      name: 'TwoAsks',
      input: z.object({}),
      handler: async (ctx) => {
        await ctx.ask(Bot, 'one');
        await ctx.ask(Bot, 'two');
        return 'ok';
      },
    });

    const runtime = new AxlTestRuntime();
    runtime.register(TwoAsks);
    runtime.mockProvider(
      'openai',
      MockProvider.sequence([
        { content: 'a', timing: { ...TIMING, wireMs: 111 } },
        { content: 'b', timing: { ...TIMING, wireMs: 222 } },
      ]),
    );

    await runtime.execute('TwoAsks', {});

    const ends = runtime.traceLog().filter((e) => e.type === 'agent_call_end');
    expect(ends).toHaveLength(2);
    expect(ends.map((e) => (e as { timing?: CallTiming }).timing?.wireMs)).toEqual([111, 222]);
  });

  it('an untimed mock produces agent_call_end events with no timing key', async () => {
    const Bot = agent({ model: 'openai:gpt-4o-mini', system: 'you are terse' });
    const OneAsk = workflow({
      name: 'OneAsk',
      input: z.object({}),
      handler: async (ctx) => await ctx.ask(Bot, 'one'),
    });

    const runtime = new AxlTestRuntime();
    runtime.register(OneAsk);
    runtime.mockProvider('openai', MockProvider.sequence([{ content: 'a' }]));

    await runtime.execute('OneAsk', {});

    const ends = runtime.traceLog().filter((e) => e.type === 'agent_call_end');
    expect(ends).toHaveLength(1);
    expect('timing' in ends[0]).toBe(false);
  });
});
