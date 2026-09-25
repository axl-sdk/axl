/**
 * Accounting coverage for the paths that spend money OUTSIDE a plain
 * `ctx.ask`, and for the two terminal states a dispatched failure can reach.
 *
 * Matrix rows: A2.2 (nesting), A2.4 (context-management summarization),
 * A2.5 (session-history summarization), A2.8 (transcription), A3.4 / A3.5
 * (dispatched vs. pre-dispatch failure on a lifecycle-reporting adapter).
 *
 * Every case asserts the public `accounting` record from `runtime.trackOutcome`
 * — the point of these rows is that spend the runtime itself initiates is
 * measured exactly like spend the workflow author asked for.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import type { Accounting } from '../accounting.js';
import type { ChatMessage, ChatOptions, Provider, StreamChunk } from '../providers/types.js';
import type { ProviderResponse } from '../types.js';
import type { AxlEvent } from '../types.js';
import { eventCostContribution } from '../event-utils.js';
import { ProviderError } from '../providers/errors.js';
import { ScriptedProvider, scriptedRuntime } from './accounting-helpers.js';

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

describe('settlement-backed agent diagnostics', () => {
  it('excludes a direct provider call from agent metadata while charging its cost', async () => {
    const runtime = new AxlRuntime({ defaultProvider: 'paid' });
    runtime.registerProvider('paid', {
      name: 'paid',
      async chat() {
        return {
          content: 'ok',
          cost: 0.1,
          usage: USAGE,
          timing: { queuedMs: 2, retryMs: 3, wireMs: 5, ttfbMs: 1, attempts: 1 },
        };
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('unused');
      },
    });
    runtime.register(
      workflow({
        name: 'paid-ask',
        input: z.any(),
        handler: (ctx) => ctx.ask(agent({ name: 'a', model: 'paid:m' }), 'go'),
      }),
    );
    const result = await runtime.trackOutcome(async () => {
      await runtime.execute('paid-ask', {});
      await runtime.resolveProvider('paid:m').provider.chat([], { model: 'm' });
    });
    expect(result.status).toBe('fulfilled');
    expect(result.accounting.knownCost).toBeCloseTo(0.2, 10);
    expect(result.accounting.operations.byKind.chat).toBe(2);
    expect(result.metadata).toMatchObject({
      modelCallCounts: { 'paid:m': 1 },
      agentCalls: 1,
      tokens: { input: 10, output: 5, reasoning: 0 },
    });
    expect(result.modelTiming?.['paid:m'].calls).toBe(1);
  });

  it('keeps timing for a successful custom call with no usage or price', async () => {
    const runtime = new AxlRuntime({ defaultProvider: 'bare' });
    runtime.registerProvider('bare', {
      name: 'bare',
      async chat() {
        return {
          content: 'ok',
          timing: { queuedMs: 2, retryMs: 3, wireMs: 5, ttfbMs: 1, attempts: 1 },
        };
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('unused');
      },
    });
    runtime.register(
      workflow({
        name: 'bare-ask',
        input: z.any(),
        handler: (ctx) => ctx.ask(agent({ name: 'a', model: 'bare:m' }), 'go'),
      }),
    );
    const result = await runtime.trackOutcome(() => runtime.execute('bare-ask', {}), {
      captureTimingSamples: true,
    });
    expect(result.status).toBe('fulfilled');
    expect(result.accounting.reasons).toEqual({ usage_missing: 1 });
    expect(result.metadata.modelCallCounts).toEqual({ 'bare:m': 1 });
    expect(result.modelTiming?.['bare:m']).toMatchObject({
      calls: 1,
      queuedMs: 2,
      retryMs: 3,
      wireMs: 5,
      samples: [{ queuedMs: 2, retryMs: 3, wireMs: 5 }],
    });
  });
});

/** A one-turn adapter that never throws, on its own provider name. */
function flatRate(name: string, cost: number): Provider {
  return {
    name,
    async chat(): Promise<ProviderResponse> {
      return { content: `summary from ${name}`, usage: USAGE, cost };
    },
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<StreamChunk> {
      throw new Error('unused');
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// A2.2 — a nested scope inside a spawned branch is charged once, not twice
// ═══════════════════════════════════════════════════════════════════════════

describe('A2.2: work delegated to a sub-scope is folded into the parent exactly once', () => {
  it('charges a parent ask plus a spawned nested ask as $0.50, not $0.75', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.25 }]);
    const asker = agent({ name: 'a', model: 'scripted:m' });

    let childAccounting!: Accounting;
    runtime.register(
      workflow({
        name: 'parent-with-branch',
        input: z.any(),
        handler: async (ctx) => {
          await ctx.ask(asker, 'parent turn');
          await ctx.spawn(1, async () => {
            // The branch opens its OWN accounting scope, exactly as an eval
            // item or a delegated sub-run would.
            const child = await runtime.trackOutcome(() => ctx.ask(asker, 'branch turn'));
            childAccounting = child.accounting;
            return 'branch done';
          });
          return 'done';
        },
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('parent-with-branch', {}));

    expect(outcome.status).toBe('fulfilled');
    // R1: the child records its own operation, and the parent records the same
    // operation once — never once for the child scope and again for itself.
    expect(childAccounting.knownCost).toBeCloseTo(0.25, 10);
    expect(childAccounting.operations.total).toBe(1);
    expect(outcome.accounting.knownCost).toBeCloseTo(0.5, 10);
    expect(outcome.accounting.operations.total).toBe(2);
    expect(outcome.accounting.operations.byKind.chat).toBe(2);
    expect(outcome.accounting.completeness).toBe('complete');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A2.4 / A2.5 — the runtime's own summarizer calls are real spend
// ═══════════════════════════════════════════════════════════════════════════

describe('A2.4: a context-management summarization call is measured like any other', () => {
  const overflowHistory: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `turn ${i}: ${'x'.repeat(200)}`,
  }));

  it('adds the summarizer charge to the scope that triggered the overflow', async () => {
    const main = new ScriptedProvider([{ cost: 0.4 }], { name: 'main' });
    const runtime = new AxlRuntime({
      defaultProvider: 'main',
      contextManagement: { summaryModel: 'summarizer:s', reserveTokens: 100 },
    });
    runtime.registerProvider('main', main);
    runtime.registerProvider('summarizer', flatRate('summarizer', 0.1));
    const events: AxlEvent[] = [];
    runtime.on('trace', (event) => events.push(event));

    // A tiny window with a long history forces the summarization branch.
    const asker = agent({ name: 'a', model: 'main:m', maxContext: 400 });
    const outcome = await runtime.trackOutcome(async () => {
      const ctx = runtime.createContext({ sessionHistory: overflowHistory });
      return ctx.ask(asker, 'and now the newest question');
    });

    expect(outcome.status).toBe('fulfilled');
    // Two chats: the summarizer's and the agent's. A summarizer that reached
    // the registry adapter directly would leave $0.40 here.
    expect(outcome.accounting.operations.byKind.chat).toBe(2);
    expect(outcome.accounting.knownCost).toBeCloseTo(0.5, 10);
    expect(outcome.accounting.breakdown.generation).toBeCloseTo(0.5, 10);
    expect(outcome.accounting.completeness).toBe('complete');
    const summaryStarts = events.filter(
      (event) => event.type === 'agent_call_start' && event.data.purpose === 'summary',
    );
    const summaryEnds = events.filter(
      (event) => event.type === 'agent_call_end' && event.data.purpose === 'summary',
    );
    expect(summaryStarts).toHaveLength(1);
    expect(summaryEnds).toHaveLength(1);
    expect(summaryEnds[0]).toMatchObject({ model: 'summarizer:s', cost: 0.1 });
    const askEnd = events.find((event) => event.type === 'ask_end');
    expect(askEnd).toMatchObject({ cost: 0.5 });
    expect(events.reduce((sum, event) => sum + eventCostContribution(event), 0)).toBeCloseTo(
      0.5,
      10,
    );
  });

  it('stops before the main call when a priced summary exhausts a finish_and_stop budget', async () => {
    const main = new ScriptedProvider([{ cost: 0.4 }], { name: 'main' });
    const runtime = new AxlRuntime({
      defaultProvider: 'main',
      contextManagement: { summaryModel: 'summarizer:s', reserveTokens: 100 },
    });
    runtime.registerProvider('main', main);
    runtime.registerProvider('summarizer', flatRate('summarizer', 0.1));
    const events: AxlEvent[] = [];
    runtime.on('trace', (event) => events.push(event));
    const asker = agent({ name: 'a', model: 'main:m', maxContext: 400 });

    const outcome = await runtime.trackOutcome(async () => {
      const ctx = runtime.createContext({ sessionHistory: overflowHistory });
      return ctx.budget({ cost: '$0.05', onExceed: 'finish_and_stop' }, () =>
        ctx.ask(asker, 'new question'),
      );
    });

    expect(outcome.status).toBe('fulfilled');
    expect(outcome.value).toMatchObject({ budgetExceeded: true, totalCost: 0.1, unpriced: false });
    expect(main.calls).toHaveLength(0);
    expect(outcome.accounting.knownCost).toBeCloseTo(0.1, 10);
    expect(events.filter((event) => event.type === 'agent_call_end')).toHaveLength(1);
    expect(events.find((event) => event.type === 'ask_end')).toMatchObject({ cost: 0.1 });
  });

  it('marks an unknown-price summary as a lower bound without stopping a later priced call', async () => {
    const main = new ScriptedProvider([{ cost: 0.4 }], { name: 'main' });
    const runtime = new AxlRuntime({
      defaultProvider: 'main',
      contextManagement: { summaryModel: 'summarizer:s', reserveTokens: 100 },
    });
    runtime.registerProvider('main', main);
    runtime.registerProvider('summarizer', {
      ...flatRate('summarizer', 0),
      async chat() {
        return { content: 'short summary', usage: USAGE };
      },
    });
    const events: AxlEvent[] = [];
    runtime.on('trace', (event) => events.push(event));
    const asker = agent({ name: 'a', model: 'main:m', maxContext: 400 });

    const outcome = await runtime.trackOutcome(async () => {
      const ctx = runtime.createContext({ sessionHistory: overflowHistory });
      return ctx.budget({ cost: '$1', onExceed: 'hard_stop' }, () =>
        ctx.ask(asker, 'new question'),
      );
    });

    expect(outcome.status).toBe('fulfilled');
    expect(outcome.value).toMatchObject({ budgetExceeded: false, totalCost: 0.4, unpriced: true });
    expect(main.calls).toHaveLength(1);
    expect(
      events.find((event) => event.type === 'agent_call_end' && event.data.purpose === 'summary'),
    ).toMatchObject({ unpriced: true });
    expect(events.find((event) => event.type === 'ask_end')).toMatchObject({
      cost: 0.4,
      unpriced: true,
    });
  });

  it('reuses a cached summary without a second summary charge', async () => {
    const main = new ScriptedProvider([{ cost: 0.4 }], { name: 'main' });
    const summarizer = new ScriptedProvider([{ content: 'short summary', cost: 0.1 }], {
      name: 'summarizer',
    });
    const runtime = new AxlRuntime({
      defaultProvider: 'main',
      contextManagement: { summaryModel: 'summarizer:s', reserveTokens: 100 },
    });
    runtime.registerProvider('main', main);
    runtime.registerProvider('summarizer', summarizer);
    const events: AxlEvent[] = [];
    runtime.on('trace', (event) => events.push(event));
    const asker = agent({ name: 'a', model: 'main:m', maxContext: 400 });

    const outcome = await runtime.trackOutcome(async () => {
      const ctx = runtime.createContext({ sessionHistory: overflowHistory });
      await ctx.ask(asker, 'first');
      await ctx.ask(asker, 'second');
    });

    expect(outcome.status).toBe('fulfilled');
    expect(summarizer.calls).toHaveLength(1);
    expect(main.calls).toHaveLength(2);
    expect(
      events.filter((event) => event.type === 'agent_call_end' && event.data.purpose === 'summary'),
    ).toHaveLength(1);
    expect(outcome.accounting.knownCost).toBeCloseTo(0.9, 10);
    expect(events.filter((event) => event.type === 'ask_end').map((event) => event.cost)).toEqual([
      0.5, 0.4,
    ]);
  });

  it('pairs a failed summary and keeps echoed history out of its diagnostic event', async () => {
    const main = new ScriptedProvider([{ cost: 0.4 }], { name: 'main' });
    const runtime = new AxlRuntime({
      defaultProvider: 'main',
      contextManagement: { summaryModel: 'summarizer:s', reserveTokens: 100 },
      trace: { redact: true },
    });
    runtime.registerProvider('main', main);
    runtime.registerProvider(
      'summarizer',
      new ScriptedProvider(
        [
          {
            throws: new ProviderError({
              provider: 'summarizer',
              status: 503,
              retryable: true,
              message: 'private history echoed by provider',
              body: 'private history in raw body',
            }),
          },
        ],
        { name: 'summarizer' },
      ),
    );
    const events: AxlEvent[] = [];
    runtime.on('trace', (event) => events.push(event));
    const ctx = runtime.createContext({ sessionHistory: overflowHistory });

    await expect(
      ctx.ask(agent({ name: 'a', model: 'main:m', maxContext: 400 }), 'new question'),
    ).rejects.toBeInstanceOf(ProviderError);

    const starts = events.filter((event) => event.type === 'agent_call_start');
    const ends = events.filter((event) => event.type === 'agent_call_end');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      model: 'summarizer:s',
      data: { purpose: 'summary', prompt: '[redacted]' },
    });
    expect(ends[0]).toMatchObject({
      model: 'summarizer:s',
      data: {
        purpose: 'summary',
        response: '[redacted]',
        error: '[redacted]',
        status: 503,
        retryable: true,
      },
    });
    expect(JSON.stringify(events)).not.toContain('private history');
    expect(main.calls).toHaveLength(0);
  });
});

describe('A2.5: session-history summarization lands in the active scope', () => {
  it('charges the summarizer even though it runs before the execution exists', async () => {
    const main = new ScriptedProvider([{ cost: 0.25 }], { name: 'main' });
    const runtime = new AxlRuntime({ defaultProvider: 'main' });
    runtime.registerProvider('main', main);
    runtime.registerProvider('summarizer', flatRate('summarizer', 0.1));

    const asker = agent({ name: 'a', model: 'main:m' });
    runtime.register(
      workflow({
        name: 'chat-turn',
        input: z.any(),
        handler: async (ctx) => ctx.ask(asker, 'go'),
      }),
    );

    const store = runtime.getStateStore();
    await store.saveSession(
      'session-a2-5',
      Array.from({ length: 6 }, (_, i) => ({
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `old turn ${i}`,
      })),
    );

    const session = runtime.session('session-a2-5', {
      history: { maxMessages: 2, summarize: true, summaryModel: 'summarizer:s' },
    });

    const outcome = await runtime.trackOutcome(() => session.send('chat-turn', 'newest'));

    expect(outcome.status).toBe('fulfilled');
    // `summarizeMessages` fires in `prepareHistory`, strictly before
    // `runtime.execute`. Attribution keyed to the execution id would drop it.
    expect(outcome.accounting.operations.byKind.chat).toBe(2);
    expect(outcome.accounting.knownCost).toBeCloseTo(0.35, 10);
    expect(outcome.accounting.completeness).toBe('complete');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A2.8 — transcription is a priced operation kind of its own
// ═══════════════════════════════════════════════════════════════════════════

describe('A2.8: a transcription charge folds into the run accounting', () => {
  it('keeps the reported audio seconds instead of a token-only usage roll-up', async () => {
    const runtime = new AxlRuntime();
    runtime.registerTranscriptionProvider('stubvoice', {
      name: 'stubvoice',
      capabilities: () => ({ sources: ['bytes'] }),
      transcribe: async () => ({
        transcript: { text: 'hello there', usage: { audioSeconds: 12, cost: 0.03 } },
      }),
    } as never);

    runtime.register(
      workflow({
        name: 'transcribe',
        input: z.any(),
        handler: async (ctx) =>
          ctx.transcribe({
            model: 'stubvoice:v',
            audio: { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'audio/wav' },
          } as never),
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('transcribe', {}));

    expect(outcome.status).toBe('fulfilled');
    expect(outcome.accounting.operations.byKind.transcription).toBe(1);
    expect(outcome.accounting.knownCost).toBeCloseTo(0.03, 10);
    expect(outcome.accounting.completeness).toBe('complete');
    // A token-only aggregation would report 0 here and silently lose the unit
    // the vendor actually bills on.
    expect(outcome.accounting.usage.audioSeconds).toBe(12);
    expect(outcome.accounting.usage.inputTokens).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A3.4 / A3.5 — a lifecycle-reporting adapter can tell the two failures apart
// ═══════════════════════════════════════════════════════════════════════════

/**
 * An adapter that positively declares it reports dispatch, and either reports
 * it before failing (a request that went out) or fails without reporting (a
 * request that never left).
 */
function lifecycleAdapter(options: { dispatch: boolean; error: unknown }): Provider {
  return {
    name: 'lifecycle',
    reportsRequestLifecycle: true,
    async chat(_messages: ChatMessage[], chatOptions: ChatOptions): Promise<ProviderResponse> {
      if (options.dispatch) chatOptions.requestLifecycle?.onDispatch?.();
      throw options.error;
    },
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<StreamChunk> {
      throw new Error('unused');
    },
  };
}

function lifecycleRuntime(options: { dispatch: boolean; error: unknown }): AxlRuntime {
  const runtime = new AxlRuntime({ defaultProvider: 'lifecycle' });
  runtime.registerProvider('lifecycle', lifecycleAdapter(options));
  return runtime;
}

describe('A3.4/A3.5: only an adapter that reports dispatch can prove nothing was billed', () => {
  it('A3.4 keeps a DISPATCHED usage-less failure unknown, never free and never denied', async () => {
    const runtime = lifecycleRuntime({ dispatch: true, error: new Error('upstream 500') });
    const facade = runtime.resolveProvider('lifecycle:m').provider;

    const outcome = await runtime.trackOutcome(() => facade.chat([], { model: 'm' }));

    expect(outcome.status).toBe('rejected');
    expect(outcome.accounting.completeness).toBe('incomplete');
    expect(outcome.accounting.reasons).toEqual({ usage_missing: 1 });
    expect(outcome.accounting.operations.unknown).toBe(1);
    expect(outcome.accounting.operations.settled).toBe(0);
    // "The call errored, so nothing was charged" is the shortcut this kills.
    expect(outcome.accounting.operations.denied).toBe(0);
    expect(outcome.accounting.knownCost).toBe(0);
  });

  it('A3.5 settles a PRE-dispatch rejection as a known $0 rather than permanent incompleteness', async () => {
    const runtime = lifecycleRuntime({
      dispatch: false,
      error: new Error('the request was rejected before it went out'),
    });
    const facade = runtime.resolveProvider('lifecycle:m').provider;

    const outcome = await runtime.trackOutcome(() => facade.chat([], { model: 'm' }));

    expect(outcome.status).toBe('rejected');
    // The adapter declared `reportsRequestLifecycle` and never signalled
    // dispatch, so it positively established that no request was billed.
    // Marking this `usage_missing` would leave every input-validation failure
    // permanently incomplete.
    expect(outcome.accounting.completeness).toBe('complete');
    expect(outcome.accounting.reasons).toEqual({});
    expect(outcome.accounting.knownCost).toBe(0);
    expect(outcome.accounting.operations.settled).toBe(1);
    expect(outcome.accounting.operations.unknown).toBe(0);
    // NOTE (contracts.md §1): `denied` means *refused admission*, so a
    // validation rejection is a settled known-free operation, not a denial.
    // The frozen matrix's A3.5 wording ("operations.denied === 1") predates
    // that split; contracts.md is authoritative.
    expect(outcome.accounting.operations.denied).toBe(0);
  });
});
