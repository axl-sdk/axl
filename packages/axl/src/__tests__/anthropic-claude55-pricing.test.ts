// Claude Haiku 5.5 prompt-length pricing and Sonnet 5.5 Standard pricing
// (matrix §4, P1..P17). Prompt = uncached input + cache read + both cache-write
// TTLs; a prompt strictly above 100,000 tokens prices every component,
// output included, on the high card. Output never counts toward the split.
import { afterEach, describe, expect, it } from 'vitest';
import { estimateAnthropicCost } from '../providers/anthropic.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';
import { HAIKU, MODES, SONNET, installFetch, provider, run } from './anthropic-claude55-helpers.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Usage = [uncached: number, read: number, write5m: number, write1h: number, out: number];

const usage = ([
  inputTokens,
  cacheReadTokens,
  cacheWrite5mTokens,
  cacheWrite1hTokens,
  outputTokens,
]: Usage) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWrite5mTokens,
  cacheWrite1hTokens,
});

const ROWS: Array<[id: string, model: string, usage: Usage, cost: number]> = [
  ['P1 exactly 100,000 stays on the low card', HAIKU, [100000, 0, 0, 0, 1000], 0.0105],
  ['P2 100,001 moves every component to the high card', HAIKU, [100001, 0, 0, 0, 1000], 0.0525005],
  [
    'P3 cache read and 5m write count toward the prompt',
    HAIKU,
    [50000, 40000, 10000, 0, 2000],
    0.00765,
  ],
  [
    'P4 one more cache-read token crosses the split',
    HAIKU,
    [50000, 40001, 10000, 0, 2000],
    0.03825005,
  ],
  ['P5 cache reads alone cross the split', HAIKU, [0, 100001, 0, 0, 100], 0.00525005],
  ['P6a 1h writes at the boundary', HAIKU, [90000, 0, 0, 10000, 0], 0.011],
  ['P6b 1h writes past the boundary', HAIKU, [90000, 0, 0, 10001, 0], 0.055001],
  ['P7 both TTLs together cross the split', HAIKU, [99000, 0, 500, 501, 10], 0.0503385],
  ['P8 output never counts toward the split', HAIKU, [100000, 0, 0, 0, 500000], 0.26],
  [
    'P10 sonnet 5.5 with 0.05x read and both TTLs',
    SONNET,
    [10000, 40000, 5000, 1000, 2000],
    0.0605,
  ],
  ['P11 sonnet 5.5 is flat above 200K', SONNET, [200001, 0, 0, 0, 1000], 0.410002],
  ['P12 opus 5.5 unchanged', 'claude-opus-5-5', [10000, 40000, 0, 0, 0], 0.048],
  ['P13 sonnet 5 unchanged', 'claude-sonnet-5', [10000, 40000, 0, 0, 0], 0.028],
  ['P14 fable 5.1 unchanged', 'claude-fable-5-1', [0, 1000000, 0, 0, 0], 0.25],
];

describe('estimateAnthropicCost for the Claude 5.5 family', () => {
  it.each(ROWS)('%s', (_id, model, row, cost) => {
    expect(estimateAnthropicCost(model, usage(row))).toBeCloseTo(cost, 12);
  });

  it('P9 aggregate-only cache creation stays unpriced above the split', () => {
    expect(
      estimateAnthropicCost(HAIKU, {
        inputTokens: 100001,
        outputTokens: 10,
        aggregateCacheWriteTokens: 5000,
      }),
    ).toBeUndefined();
  });

  it.each([
    'claude-haiku-5-5-20261007',
    'claude-haiku-5-5-latest',
    'claude-haiku-5-5@20261007',
    'claude-sonnet-5-5-20261007',
    'claude-haiku-5-5-1m',
    'Claude-Haiku-5-5',
  ])('P15 %s is unpriced', (model) => {
    expect(estimateAnthropicCost(model, { inputTokens: 1000, outputTokens: 1000 })).toBeUndefined();
  });
});

const P4_USAGE = {
  input_tokens: 50000,
  cache_read_input_tokens: 40001,
  cache_creation_input_tokens: 10000,
  cache_creation: { ephemeral_5m_input_tokens: 10000, ephemeral_1h_input_tokens: 0 },
  output_tokens: 2000,
};

describe('wire usage reaches the tiered card', () => {
  it.each(MODES)('T-ST5 prices on the model the response reports (%s)', async (mode) => {
    installFetch({ model: HAIKU, usage: { input_tokens: 1000, output_tokens: 1000 } });
    const outcome = await run(mode, [{ role: 'user', content: 'x' }], { model: SONNET });
    expect(outcome.cost).toBeCloseTo(1000 * 0.1e-6 + 1000 * 0.5e-6, 12);
  });

  it.each(MODES)('P17 %s prices P4 usage on the high card', async (mode) => {
    installFetch({ usage: P4_USAGE });
    const outcome = await run(mode, [{ role: 'user', content: 'x' }], { model: HAIKU });
    expect(outcome.cost).toBeCloseTo(0.03825005, 12);
  });

  it.each([false, true])(
    'P16 a $0.03 budget sees the high-card cost and exceeds (stream=%s)',
    async (stream) => {
      installFetch({ usage: P4_USAGE });
      const registry = new ProviderRegistry();
      registry.registerInstance('anthropic', provider());
      const ctx = new WorkflowContext({
        input: 'task',
        executionId: `haiku-budget-${stream}`,
        metadata: {},
        config: { defaultProvider: 'anthropic', diagnostics: { silent: true } },
        providerRegistry: registry,
        _forceStreaming: stream,
      });
      const worker = agent({
        name: 'haiku-budget',
        model: `anthropic:${HAIKU}`,
        system: 'Answer briefly.',
      });
      const result = await ctx.budget({ cost: '$0.03' }, () => ctx.ask(worker, 'x'));
      expect(result.totalCost).toBeCloseTo(0.03825005, 12);
      expect(result.budgetExceeded).toBe(true);
      expect(result.unpriced).toBe(false);
    },
  );
});
