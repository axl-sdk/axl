import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { workflow } from '../workflow.js';
import { AxlRuntime } from '../runtime.js';
import { TimeoutError } from '../errors.js';
import { createTestCtx } from './helpers.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { Provider, ProviderResponse, StreamChunk } from '../providers/types.js';
import type { AxlEvent, CallTiming } from '../types.js';
import { ProviderError } from '../providers/errors.js';

// ---------------------------------------------------------------------------
// AC-4 — the runtime copies a provider's CallTiming onto agent_call_end, on
// both transports, and it survives persistence.
// AC-5 — a TimeoutError explains where the budget went, but only when there is
// something real to say.
// ---------------------------------------------------------------------------

const TIMING: CallTiming = {
  queuedMs: 4200,
  attempts: 2,
  retryMs: 1100,
  ttfbMs: 300,
  firstTokenMs: 850,
  wireMs: 2400,
};

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

/** Non-streaming provider returning a fixed timing block (or none). */
function chatProvider(timing?: CallTiming): Provider {
  return {
    name: 'mock',
    async chat(): Promise<ProviderResponse> {
      return { content: 'ok', usage, cost: 0.001, ...(timing ? { timing } : {}) };
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'done' };
    },
  };
}

/**
 * Streaming provider whose `done` chunk carries timing. `withUsage: false` is
 * the headline case: usage-less streams are the ones a naive implementation
 * drops, because the runtime only built a response object when usage arrived.
 */
function streamProvider(opts: { timing?: CallTiming; withUsage: boolean }): Provider {
  return {
    name: 'mock',
    async chat(): Promise<ProviderResponse> {
      return { content: 'ok' };
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', content: 'ok' };
      yield {
        type: 'done',
        ...(opts.withUsage ? { usage } : {}),
        ...(opts.timing ? { timing: opts.timing } : {}),
      };
    },
  };
}

function throwingProvider(err: () => unknown = () => new Error('provider exploded')): Provider {
  return {
    name: 'mock',
    async chat(): Promise<ProviderResponse> {
      throw err();
    },
    // The error-path test uses the non-streaming transport; this satisfies the
    // Provider interface without a yield-less generator.
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'done' };
    },
  };
}

type CallEnd = Extract<AxlEvent, { type: 'agent_call_end' }>;
const callEnds = (traces: AxlEvent[]): CallEnd[] =>
  traces.filter((t): t is CallEnd => t.type === 'agent_call_end');

const plain = () => agent({ name: 'a', model: 'mock:test', system: 's' });

describe('agent_call_end.timing (AC-4)', () => {
  it('copies the provider block verbatim on a non-streaming ask', async () => {
    const { ctx, traces } = createTestCtx({ provider: chatProvider(TIMING) });
    await ctx.ask(plain(), 'hi');

    const [end] = callEnds(traces);
    expect(end.timing).toEqual(TIMING);
    // Additive: duration keeps its own turn-wall-clock meaning.
    expect(end.duration).toBeGreaterThanOrEqual(0);
  });

  it('copies the done-chunk block on a streaming ask', async () => {
    const { ctx, traces } = createTestCtx({
      provider: streamProvider({ timing: TIMING, withUsage: true }),
    });
    void ctx.events;
    await ctx.ask(plain(), 'hi');

    expect(callEnds(traces)[0].timing).toEqual(TIMING);
  });

  it('HEADLINE: a streamed done chunk with timing but NO usage still reports timing', async () => {
    // The trap: the runtime's `done` handler only materialized a response when
    // `chunk.usage` was set. A $0 local model or a usage-omitting gateway would
    // silently lose its latency breakdown.
    const { ctx, traces } = createTestCtx({
      provider: streamProvider({ timing: TIMING, withUsage: false }),
    });
    void ctx.events;
    await ctx.ask(plain(), 'hi');

    const [end] = callEnds(traces);
    expect(end.timing).toEqual(TIMING);
    // Still no fabricated usage — the usage gate itself is unchanged.
    expect(end.tokens).toBeUndefined();
  });

  it('CUSTOM PROVIDER: a provider reporting no timing produces no timing KEY', async () => {
    // J5. "Absent" must mean the key is not there — not `timing: undefined` and
    // not a zero-filled block. A consumer asking `'timing' in event` has to be
    // able to tell "this provider is uninstrumented" from "this call was
    // instantaneous", and a downstream JSON round-trip erases the difference
    // between those two only if we never emit the key.
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', chatProvider());
    const { ctx, traces } = createTestCtx({ registry });

    const result = await ctx.ask(plain(), 'hi');

    expect(result).toBe('ok');
    const [end] = callEnds(traces);
    expect('timing' in end).toBe(false);
    // Everything else on the event is untouched by the feature.
    expect(end.cost).toBeCloseTo(0.001, 6);
    expect(end.tokens).toEqual({
      input: 10,
      output: 5,
      reasoning: undefined,
      cached: undefined,
      cacheWrite: undefined,
    });
    expect(end.duration).toBeGreaterThanOrEqual(0);
    expect(end.data.response).toBe('ok');
  });

  it('omits the timing key when the throw carries no measurement', async () => {
    // A non-provider throw measured nothing. A half-filled block here
    // (wireMs: 0) would let a dashboard chart a fake zero-latency call.
    const { ctx, traces } = createTestCtx({ provider: throwingProvider() });
    await expect(ctx.ask(plain(), 'hi')).rejects.toThrow('provider exploded');

    const [end] = callEnds(traces);
    expect(end.data.error).toBeDefined();
    expect(end.duration).toBeGreaterThanOrEqual(0);
    expect('timing' in end).toBe(false);
  });

  it('HEADLINE: copies ProviderError.timing onto the error-path agent_call_end', async () => {
    // The failure case is the one an operator most wants measured. A 500 that
    // took 4.2s of queue and 1.1s of backoff is invisible if the error path
    // reports only `duration`, which conflates all three.
    const { ctx, traces } = createTestCtx({
      provider: throwingProvider(
        () =>
          new ProviderError({
            provider: 'mock',
            status: 500,
            retryable: true,
            message: 'internal error',
            timing: TIMING,
          }),
      ),
    });

    await expect(ctx.ask(plain(), 'hi')).rejects.toThrow('internal error');

    const [end] = callEnds(traces);
    expect(end.timing).toEqual(TIMING);
    // Top-level beside `duration`, exactly as on the success path — not nested
    // in `data` with the other ProviderError metadata.
    expect(end.duration).toBeGreaterThanOrEqual(0);
    expect(end.data.status).toBe(500);
    expect(end.data.retryable).toBe(true);
    // No fabricated usage or cost: the call still delivered neither.
    expect(end.tokens).toBeUndefined();
    expect(end.cost).toBeUndefined();
  });

  it('a network-failure ProviderError still produces no timing KEY', async () => {
    // `status: 0` means no response was ever received, so nothing was measured.
    // The distinction has to survive to the event: absent key, not zeros.
    const { ctx, traces } = createTestCtx({
      provider: throwingProvider(
        () =>
          new ProviderError({
            provider: 'mock',
            status: 0,
            retryable: true,
            message: 'fetch failed',
          }),
      ),
    });

    await expect(ctx.ask(plain(), 'hi')).rejects.toThrow('fetch failed');

    const [end] = callEnds(traces);
    expect('timing' in end).toBe(false);
    expect(end.data.status).toBe(0);
  });

  it('gives each gate-retry turn its own timing', async () => {
    // A schema retry is a separate provider call with its own latency. One
    // `timing` per `agent_call_end`, never a value captured once per ask.
    const perCall: CallTiming[] = [
      { queuedMs: 1, attempts: 1, retryMs: 0, ttfbMs: 2, wireMs: 3 },
      { queuedMs: 90, attempts: 2, retryMs: 400, ttfbMs: 7, wireMs: 11 },
    ];
    let i = 0;
    const provider: Provider = {
      name: 'mock',
      async chat(): Promise<ProviderResponse> {
        const timing = perCall[Math.min(i, perCall.length - 1)];
        const content = i === 0 ? 'not json' : JSON.stringify({ answer: 'ok' });
        i++;
        return { content, usage, cost: 0.001, timing };
      },
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'done' };
      },
    };

    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(plain(), 'hi', { schema: z.object({ answer: z.string() }) });

    const ends = callEnds(traces);
    expect(ends).toHaveLength(2);
    expect(ends[1].data.retryReason).toBe('schema');
    expect(ends[0].timing).toEqual(perCall[0]);
    expect(ends[1].timing).toEqual(perCall[1]);
  });

  it('survives a state-store round-trip', async () => {
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', chatProvider(TIMING));
    const wf = workflow({
      name: 'timed',
      input: z.any(),
      handler: async (ctx) => ctx.ask(plain(), 'hi'),
    });
    runtime.register(wf);

    let executionId: string | undefined;
    runtime.on('trace', (event: AxlEvent) => {
      executionId = event.executionId;
    });
    await runtime.execute('timed', 'input');

    const info = await runtime.getExecution(executionId!);
    const persisted = callEnds(info!.events as AxlEvent[]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].timing).toEqual(TIMING);
  });
});

describe('TimeoutError breakdown (AC-5)', () => {
  /**
   * Always asks for another turn, and its single turn already outruns the
   * 50ms budget — so exactly ONE turn completes before the between-turns check
   * fires, and the asserted sums are the sums over that one turn.
   */
  function slowLoopingProvider(timing?: CallTiming): Provider {
    return {
      name: 'mock',
      async chat(): Promise<ProviderResponse> {
        await new Promise((r) => setTimeout(r, 80));
        return {
          content: '',
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
          usage,
          ...(timing ? { timing } : {}),
        };
      },
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'done' };
      },
    };
  }

  const timedAgent = () =>
    agent({ name: 'a', model: 'mock:test', system: 's', timeout: '50ms', tools: [] });

  it('attributes elapsed time when a completed turn reported timing', async () => {
    const turnTiming: CallTiming = {
      queuedMs: 40,
      attempts: 1,
      retryMs: 0,
      ttfbMs: 2,
      wireMs: 5,
    };
    const { ctx } = createTestCtx({ provider: slowLoopingProvider(turnTiming) });

    const err = await ctx.ask(timedAgent(), 'hi').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    const timeout = err as TimeoutError;

    // The historical prefix is preserved verbatim for message-matching consumers.
    expect(timeout.message.startsWith('ctx.ask() exceeded timeout of 50ms')).toBe(true);
    expect(timeout.message).toContain('queued 40ms');
    expect(timeout.message).toContain('retries 0ms');
    expect(timeout.message).toContain('wire 5ms');
    expect(timeout.breakdown).toMatchObject({ queuedMs: 40, retryMs: 0, wireMs: 5 });
    expect(timeout.breakdown!.elapsedMs).toBeGreaterThan(50);
    // `other` is the residual: elapsed minus the three measured buckets.
    expect(timeout.breakdown!.otherMs).toBe(timeout.breakdown!.elapsedMs - 40 - 0 - 5);
  });

  it('sums every completed turn, including gate-retry turns', async () => {
    // X2. A last-turn-only implementation would report 15/300/12 here, and a
    // first-turn-only one 40/0/8. Only a running sum gives 55/300/20.
    const perTurn: CallTiming[] = [
      { queuedMs: 40, attempts: 1, retryMs: 0, ttfbMs: 2, wireMs: 8 },
      { queuedMs: 15, attempts: 2, retryMs: 300, ttfbMs: 3, wireMs: 12 },
    ];
    // Turn 1 is fast so the between-turns check passes; turn 2 blows the
    // budget, so exactly two turns complete before the throw.
    const delays = [5, 100];
    let i = 0;
    const provider: Provider = {
      name: 'mock',
      async chat(): Promise<ProviderResponse> {
        const n = i++;
        await new Promise((r) => setTimeout(r, delays[Math.min(n, delays.length - 1)]));
        return {
          content: 'not json',
          usage,
          timing: perTurn[Math.min(n, perTurn.length - 1)],
        };
      },
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: 'done' };
      },
    };

    const { ctx, traces } = createTestCtx({ provider });
    const err = await ctx
      .ask(timedAgent(), 'hi', { schema: z.object({ answer: z.string() }) })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TimeoutError);
    // Both completed turns were schema-retry turns and both counted.
    expect(callEnds(traces)).toHaveLength(2);
    const { breakdown } = err as TimeoutError;
    expect(breakdown).toMatchObject({ queuedMs: 55, retryMs: 300, wireMs: 20 });
    expect((err as TimeoutError).message).toContain('queued 55ms');
    expect((err as TimeoutError).message).toContain('retries 300ms');
    expect((err as TimeoutError).message).toContain('wire 20ms');
  });

  it('UNINSTRUMENTED: keeps the historical prefix, names the agent, and omits attribution', async () => {
    // An all-zero breakdown would blame tools and gates for a budget the
    // provider simply never measured. Say nothing instead.
    const { ctx } = createTestCtx({ provider: slowLoopingProvider() });

    const err = await ctx.ask(timedAgent(), 'hi').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).message).toBe("ctx.ask() exceeded timeout of 50ms for agent 'a'");
    expect((err as TimeoutError).breakdown).toBeUndefined();
  });
});
