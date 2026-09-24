/**
 * Entry-point parity for the runtime's eval wrappers (matrix A16).
 *
 * `runEval`, `runtime.eval()` and `runtime.runRegisteredEval()` are three doors
 * into one runner. A developer who moves between them must not get different
 * numbers, so these cases run the SAME workload through each door and compare
 * the accounting they produce.
 *
 * They live in the e2e workspace because `runtime.eval()` reaches `@axlsdk/eval`
 * through a dynamic import of the PUBLISHED package. Only here do the runtime
 * and the eval package resolve to the same built copy of the core — mixing core
 * source with core dist gives each copy its own module-private symbols, and the
 * admission channel between them breaks in a way no user would ever hit.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { AxlRuntime, agent, workflow } from '@axlsdk/axl';
import type {
  ChatMessage,
  ChatOptions,
  Provider,
  ProviderResponse,
  StreamChunk,
} from '@axlsdk/axl';
import { dataset, runEval, scorer } from '@axlsdk/eval';

/** Every call reports the same usable cost, so totals are exactly predictable. */
class PricedProvider implements Provider {
  readonly name = 'mock';
  calls = 0;

  async chat(_messages: ChatMessage[], _options: ChatOptions): Promise<ProviderResponse> {
    this.calls++;
    return {
      content: 'ok',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      cost: 0.25,
    };
  }

  async *stream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const response = await this.chat(messages, options);
    yield { type: 'text_delta', content: response.content };
    yield { type: 'done', usage: response.usage, cost: response.cost };
  }
}

const fixtureAgent = agent({ name: 'fixture', model: 'mock:m', system: 'fixture' });

function freshRuntime(): { runtime: AxlRuntime; provider: PricedProvider } {
  const provider = new PricedProvider();
  const runtime = new AxlRuntime({ defaultProvider: 'mock', trace: { enabled: false } });
  runtime.registerProvider('mock', provider);
  runtime.register(
    workflow({
      name: 'ask-wf',
      input: z.any(),
      handler: async (ctx) => ctx.ask(fixtureAgent, 'go'),
    }),
  );
  return { runtime, provider };
}

/** The identical eval definition, built fresh per entry point. */
function evalConfig() {
  return {
    workflow: 'ask-wf',
    dataset: dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'a' } }, { input: { q: 'b' } }],
    }),
    scorers: [scorer({ name: 'pass', description: 'always 1', score: () => 1 })],
  };
}

type Accounted = {
  totalCost: number;
  accounting?: { knownCost: number; completeness: string; breakdown: Record<string, number> };
  items: { cost?: number; outcome?: string }[];
};

describe('A16: every eval entry point reports the same spend', () => {
  // A16.10
  it('agrees across runEval, runtime.eval() and runRegisteredEval()', async () => {
    const direct = freshRuntime();
    const viaRunEval = (await runEval(
      evalConfig() as never,
      async (_input, rt) => ({
        output: await (rt as AxlRuntime).execute('ask-wf', _input),
      }),
      direct.runtime as never,
    )) as Accounted;

    const wrapped = freshRuntime();
    const viaRuntimeEval = (await wrapped.runtime.eval(evalConfig() as never)) as Accounted;

    const registered = freshRuntime();
    registered.runtime.registerEval('parity', evalConfig());
    const viaRegistered = (await registered.runtime.runRegisteredEval('parity')) as Accounted;

    for (const result of [viaRunEval, viaRuntimeEval, viaRegistered]) {
      expect(result.totalCost).toBeCloseTo(0.5, 10);
      expect(result.accounting!.knownCost).toBeCloseTo(0.5, 10);
      expect(result.accounting!.completeness).toBe('complete');
      expect(result.accounting!.breakdown.generation).toBeCloseTo(0.5, 10);
      expect(result.items.map((i) => i.outcome)).toEqual(['completed', 'completed']);
      expect(result.items.every((i) => i.cost === 0.25)).toBe(true);
    }

    // Same work, same call count — no wrapper double-executes or short-circuits.
    expect(direct.provider.calls).toBe(2);
    expect(wrapped.provider.calls).toBe(2);
    expect(registered.provider.calls).toBe(2);
  });

  // A16.11
  it('honors a budget identically through the wrappers', async () => {
    const wrapped = freshRuntime();
    const viaRuntimeEval = (await wrapped.runtime.eval({
      ...(evalConfig() as never as object),
      budget: '$0.25',
      concurrency: 1,
    } as never)) as Accounted & { accounting?: { budget?: { status: string } } };

    // The first item reaches exactly the limit, so the second never starts —
    // the wrapper must not lose the budget on the way through.
    expect(viaRuntimeEval.items.map((i) => i.outcome)).toEqual(['completed', 'budget_skipped']);
    expect(viaRuntimeEval.accounting!.budget!.status).toBe('closed');
    expect(wrapped.provider.calls).toBe(1);
  });

  // A16.14
  it('rejects an invalid budget through the wrapper before running anything', async () => {
    const wrapped = freshRuntime();

    await expect(
      wrapped.runtime.eval({
        ...(evalConfig() as never as object),
        budget: 'free',
      } as never),
    ).rejects.toThrow(/INVALID_BUDGET|budget/i);
    expect(wrapped.provider.calls).toBe(0);
  });
});
