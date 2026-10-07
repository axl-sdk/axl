// Claude Haiku 5.5 / Sonnet 5.5 request contract: catalog admission, the
// effort/thinking grid, tool choice, sampling, and raw providerOptions guards.
// Rows reference the frozen blind matrix (T-*, C*) for this workstream.
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { z } from 'zod';
import type { Effort } from '../providers/types.js';
import {
  BINDING_BETA,
  HAIKU,
  MODES,
  SONNET,
  captured,
  installFetch,
  provider,
  run,
  tools,
  type Mode,
} from './anthropic-claude55-helpers.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const hi = [{ role: 'user' as const, content: 'hi' }];
const OFF_SHAPE = { [HAIKU]: 'disabled', [SONNET]: 'between_tools' } as const;

// ---------------------------------------------------------------------------
// 1. Effort / thinking shape (AC2)
// ---------------------------------------------------------------------------

type Shape = 'omitted' | 'adaptive' | 'off';
type GridRow = [
  id: string,
  effort: Effort | undefined,
  thinkingBudget: number | undefined,
  shape: Shape,
  wireEffort: string | undefined,
];

const GRID: GridRow[] = [
  ['1 unset', undefined, undefined, 'omitted', undefined],
  ['2 low', 'low', undefined, 'adaptive', 'low'],
  ['3 medium', 'medium', undefined, 'adaptive', 'medium'],
  ['4 high', 'high', undefined, 'adaptive', 'high'],
  ['5 xhigh', 'xhigh', undefined, 'adaptive', 'xhigh'],
  ['6 max', 'max', undefined, 'adaptive', 'max'],
  ['7 none', 'none', undefined, 'off', undefined],
  ['8 low+0', 'low', 0, 'off', 'low'],
  ['9 medium+0', 'medium', 0, 'off', 'medium'],
  ['10 high+0', 'high', 0, 'off', 'high'],
  // Pinned: thinking-off is impossible above high, so the level is honored
  // adaptively. Reporting that fallback is a deferred follow-on.
  ['11 xhigh+0', 'xhigh', 0, 'adaptive', 'xhigh'],
  ['12 max+0', 'max', 0, 'adaptive', 'max'],
  ['13 unset+0', undefined, 0, 'off', undefined],
  // Pinned (QR2): the existing Claude 5 budget→effort mapping.
  ['14 high+8000', 'high', 8000, 'adaptive', 'high'],
  ['15 none+8000', 'none', 8000, 'adaptive', 'high'],
];

describe.each([HAIKU, SONNET])('%s effort/thinking grid (T-H1..15, T-S1..13)', (model) => {
  describe.each(MODES)('%s', (mode) => {
    it.each(GRID)('T-%s', async (_id, effort, thinkingBudget, shape, wireEffort) => {
      const fetcher = installFetch({});
      await run(mode, hi, { model, effort, thinkingBudget });
      const { body, raw } = captured(fetcher);
      if (shape === 'omitted') expect(body).not.toHaveProperty('thinking');
      if (shape === 'adaptive') expect(body.thinking).toEqual({ type: 'adaptive' });
      if (shape === 'off') {
        expect(body.thinking).toEqual({ type: OFF_SHAPE[model] });
        expect(Object.keys(body.thinking)).toEqual(['type']);
      }
      if (wireEffort) expect(body.output_config).toEqual({ effort: wireEffort });
      else expect(body.output_config?.effort).toBeUndefined();
      expect(raw).not.toMatch(/budget_tokens|"enabled"/);
      // PF2: thinking-off is the vendor's own shape, not a clamp.
      expect(provider().effortResolution({ model, effort, thinkingBudget })).toBeUndefined();
    });
  });
});

describe('effort grid regressions and schema asks', () => {
  it.each(MODES)(
    'T-X1 haiku none on a schema ask keeps the off-shape and no effort (%s)',
    async (mode) => {
      const fetcher = installFetch({ content: [{ type: 'text', text: '{"a":1}' }] });
      await run(mode, hi, {
        model: HAIKU,
        effort: 'none',
        responseFormat: { type: 'json_object' },
      });
      const { body } = captured(fetcher);
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.output_config?.effort).toBeUndefined();
      expect(String(body.system)).toContain('valid JSON only');
    },
  );

  it.each(['claude-sonnet-5', 'claude-opus-5'])(
    'T-R1 %s none still sends disabled',
    async (model) => {
      const fetcher = installFetch({});
      await provider().chat(hi, { model, effort: 'none' });
      expect(captured(fetcher).body.thinking).toEqual({ type: 'disabled' });
    },
  );

  it.each(['claude-opus-5-5', 'claude-fable-5-1'])(
    'T-R2 %s none still clamps to adaptive low',
    async (model) => {
      const fetcher = installFetch({});
      await provider().chat(hi, { model, effort: 'none' });
      expect(captured(fetcher).body).toMatchObject({
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
      });
      expect(provider().effortResolution({ model, effort: 'none' })).toMatchObject({
        effective: 'low',
        clamped: true,
      });
    },
  );

  it('T-R3 opus-4-6 low + thinkingBudget 0 keeps the 4.6 path', async () => {
    const fetcher = installFetch({});
    await provider().chat(hi, {
      model: 'claude-opus-4-6',
      effort: 'low',
      thinkingBudget: 0,
      temperature: 0.3,
    });
    const { body } = captured(fetcher);
    expect(body).not.toHaveProperty('thinking');
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.temperature).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// 2. Tool choice, sampling, raw providerOptions (AC3, R4b)
// ---------------------------------------------------------------------------

const calc = tool({
  name: 'calc',
  description: 'calc',
  input: z.object({}),
  handler: async () => '2',
});

function runtimeCtx(stream: boolean) {
  const registry = new ProviderRegistry();
  registry.registerInstance('anthropic', provider());
  return new WorkflowContext({
    input: 'task',
    executionId: `claude55-tc-${stream}`,
    metadata: {},
    config: { defaultProvider: 'anthropic', diagnostics: { silent: true } },
    providerRegistry: registry,
    _forceStreaming: stream,
  });
}

describe('tool choice', () => {
  describe.each(MODES)('%s', (mode) => {
    it('T-TC1/2 haiku sends required and named tool choice', async () => {
      const fetcher = installFetch({});
      await run(mode, hi, { model: HAIKU, tools, toolChoice: 'required' });
      await run(mode, hi, {
        model: HAIKU,
        tools,
        toolChoice: { type: 'function', function: { name: 'calc' } },
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(captured(fetcher, 0).body.tool_choice).toEqual({ type: 'any' });
      expect(captured(fetcher, 1).body.tool_choice).toEqual({ type: 'tool', name: 'calc' });
    });

    it('T-TC3 haiku none + required sends disabled thinking with forced choice', async () => {
      const fetcher = installFetch({});
      await run(mode, hi, { model: HAIKU, effort: 'none', tools, toolChoice: 'required' });
      expect(captured(fetcher).body).toMatchObject({
        thinking: { type: 'disabled' },
        tool_choice: { type: 'any' },
      });
    });

    it('T-TC6 sonnet sends auto and none', async () => {
      const fetcher = installFetch({});
      await run(mode, hi, { model: SONNET, tools, toolChoice: 'auto' });
      await run(mode, hi, { model: SONNET, tools, toolChoice: 'none' });
      expect(captured(fetcher, 0).body.tool_choice).toEqual({ type: 'auto' });
      expect(captured(fetcher, 1).body.tool_choice).toEqual({ type: 'none' });
    });

    it.each(['claude-opus-5-5', 'claude-fable-5-1'])(
      'T-TC7 %s still rejects required',
      async (model) => {
        const fetcher = installFetch({});
        await expect(run(mode, hi, { model, tools, toolChoice: 'required' })).rejects.toMatchObject(
          { name: 'UnsupportedModelOptionError', option: 'forced tool choice' },
        );
        expect(fetcher).not.toHaveBeenCalled();
      },
    );

    it.each(['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'])(
      'T-TC8 %s still sends required',
      async (model) => {
        const fetcher = installFetch({});
        await run(mode, hi, { model, tools, toolChoice: 'required' });
        expect(captured(fetcher).body.tool_choice).toEqual({ type: 'any' });
      },
    );

    it('T-TC9 sonnet rejects a raw forced tool_choice from providerOptions (QR4)', async () => {
      const fetcher = installFetch({});
      await expect(
        run(mode, hi, {
          model: SONNET,
          tools,
          toolChoice: 'auto',
          providerOptions: { tool_choice: { type: 'any' } },
        }),
      ).rejects.toMatchObject({
        name: 'UnsupportedModelOptionError',
        option: 'forced tool choice',
      });
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    'T-TC4/5 sonnet rejects agent-level required and ask-level named (stream=%s)',
    async (stream) => {
      const fetcher = installFetch({});
      const ctx = runtimeCtx(stream);
      const forced = agent({
        name: 'sonnet-forced',
        model: `anthropic:${SONNET}`,
        tools: [calc],
        toolChoice: 'required',
      });
      const error = await ctx.ask(forced, 'go').catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        name: 'UnsupportedModelOptionError',
        model: SONNET,
        option: 'forced tool choice',
      });
      expect((error as { remediation: string }).remediation).toContain('auto');

      const plain = agent({ name: 'sonnet-plain', model: `anthropic:${SONNET}`, tools: [calc] });
      await expect(
        ctx.ask(plain, 'go', { toolChoice: { type: 'function', function: { name: 'calc' } } }),
      ).rejects.toMatchObject({
        name: 'UnsupportedModelOptionError',
        option: 'forced tool choice',
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});

describe('portable temperature (T-TE1..4)', () => {
  describe.each(MODES)('%s', (mode) => {
    it.each([HAIKU, SONNET])(
      '%s strips temperature at high and under the off-shape',
      async (model) => {
        const fetcher = installFetch({});
        await run(mode, hi, { model, temperature: 0.2 });
        await run(mode, hi, { model, temperature: 0.2, effort: 'high' });
        await run(mode, hi, { model, temperature: 0.2, effort: 'none' });
        for (let index = 0; index < 3; index++) {
          expect(captured(fetcher, index).body).not.toHaveProperty('temperature');
        }
      },
    );

    // T-TE4: the exact options `llmScorer` sends by default (temperature 0.2,
    // JSON response format). The scorer itself lives in @axlsdk/eval.
    it('sonnet drops an llmScorer-style default temperature', async () => {
      const fetcher = installFetch({ content: [{ type: 'text', text: '{"score":1}' }] });
      await run(mode, hi, {
        model: SONNET,
        temperature: 0.2,
        responseFormat: { type: 'json_object' },
      });
      expect(captured(fetcher).body).not.toHaveProperty('temperature');
    });
  });
});

const STRICT_MODELS = [HAIKU, SONNET, 'claude-opus-5-5', 'claude-fable-5-1'];

describe.each(STRICT_MODELS)('%s raw sampling (T-PO1..7)', (model) => {
  it.each([[{ temperature: 1 }], [{ top_p: 0.99 }]])('accepts %j', async (providerOptions) => {
    const fetcher = installFetch({});
    await provider().chat(hi, { model, providerOptions });
    expect(captured(fetcher).body).toMatchObject(providerOptions);
  });

  it.each([
    [{ temperature: 0.7 }, 'temperature'],
    [{ top_p: 1 }, 'top_p'],
    [{ top_k: 5 }, 'top_k'],
    [{ temperature: 1, top_p: 0.99 }, 'temperature and top_p'],
  ] as const)('rejects %j before dispatch', async (providerOptions, option) => {
    const fetcher = installFetch({});
    await expect(provider().chat(hi, { model, providerOptions })).rejects.toMatchObject({
      name: 'UnsupportedModelOptionError',
      model,
      option,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('raw off-shape combinations (R4b, T-PO8..14)', () => {
  type Row = [
    id: string,
    model: string,
    effort: Effort | undefined,
    po: Record<string, unknown>,
    option: string,
  ];
  const rows: Row[] = [
    ['T-PO8', HAIKU, 'none', { output_config: { effort: 'xhigh' } }, 'output_config.effort'],
    ['T-PO9', SONNET, 'none', { output_config: { effort: 'max' } }, 'output_config.effort'],
    [
      'T-PO10',
      SONNET,
      undefined,
      { thinking: { type: 'between_tools', display: 'summarized' } },
      'thinking.between_tools.display',
    ],
    [
      'T-PO11',
      SONNET,
      undefined,
      {
        thinking: {
          type: 'between_tools',
          block_binding: { prefix_mismatch_behavior: 'drop_block' },
        },
      },
      'thinking.between_tools.block_binding',
    ],
    [
      'T-PO12',
      HAIKU,
      undefined,
      { thinking: { type: 'disabled', block_binding: { prefix_mismatch_behavior: 'drop_block' } } },
      'thinking.disabled.block_binding',
    ],
    [
      'T-PO13 haiku',
      HAIKU,
      undefined,
      { thinking: { type: 'enabled', budget_tokens: 4000 } },
      'thinking.type',
    ],
    [
      'T-PO13 sonnet',
      SONNET,
      undefined,
      { thinking: { type: 'enabled', budget_tokens: 4000 } },
      'thinking.type',
    ],
    ['T-PO14', SONNET, undefined, { thinking: { type: 'disabled' } }, 'thinking.type'],
    [
      'raw none effort haiku',
      HAIKU,
      undefined,
      { output_config: { effort: 'none' } },
      'output_config.effort',
    ],
    [
      'raw none effort sonnet',
      SONNET,
      undefined,
      { output_config: { effort: 'none' } },
      'output_config.effort',
    ],
    [
      'adaptive budget_tokens',
      SONNET,
      undefined,
      { thinking: { type: 'adaptive', budget_tokens: 4000 } },
      'thinking.budget_tokens',
    ],
  ];

  describe.each(MODES)('%s', (mode: Mode) => {
    it.each(rows)(
      '%s rejects before dispatch',
      async (_id, model, effort, providerOptions, option) => {
        const fetcher = installFetch({});
        await expect(run(mode, hi, { model, effort, providerOptions })).rejects.toMatchObject({
          name: 'UnsupportedModelOptionError',
          model,
          option,
        });
        expect(fetcher).not.toHaveBeenCalled();
      },
    );

    it.each([
      [HAIKU, 'high'],
      [SONNET, 'medium'],
    ] as const)('%s accepts the raw off-shape at effort %s', async (model, effort) => {
      const fetcher = installFetch({});
      await run(mode, hi, {
        model,
        providerOptions: { thinking: { type: OFF_SHAPE[model] }, output_config: { effort } },
      });
      expect(captured(fetcher).body).toMatchObject({
        thinking: { type: OFF_SHAPE[model] },
        output_config: { effort },
      });
    });
  });

  it('T-PO16 haiku none + raw adaptive is allowed; the final shape drives binding (QR7)', async () => {
    const fetcher = installFetch({});
    await provider().chat(hi, {
      model: HAIKU,
      effort: 'none',
      providerOptions: { thinking: { type: 'adaptive' } },
    });
    const { body, headers } = captured(fetcher);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(headers['anthropic-beta']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Catalog (AC1)
// ---------------------------------------------------------------------------

describe('catalog admission (C1..C5)', () => {
  it.each([HAIKU, SONNET])('C1 admits %s with a thinking control', async (model) => {
    const fetcher = installFetch({});
    await provider().chat(hi, { model, effort: 'low', temperature: 0.2 });
    expect(captured(fetcher).body).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    });
    expect(captured(fetcher).body).not.toHaveProperty('temperature');
  });

  it.each([
    'claude-haiku-5-5-20261007',
    'claude-haiku-5-5-latest',
    'claude-haiku-5-5@20261007',
    'claude-sonnet-5-5-20261007',
    'claude-haiku-5-5-1m',
    'Claude-Haiku-5-5',
    ' claude-sonnet-5-5',
    'claude-sonnet-5-5 ',
  ])('C2/C5 %j gets no capability and no price', async (model) => {
    const fetcher = installFetch({ usage: { input_tokens: 1000, output_tokens: 1000 } });
    const result = await provider().chat(hi, {
      model,
      effort: 'low',
      temperature: 0.2,
      tools,
      toolChoice: 'required',
    });
    const { body, headers } = captured(fetcher);
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('output_config');
    expect(body.temperature).toBe(0.2);
    expect(body.tool_choice).toEqual({ type: 'any' });
    expect(headers['anthropic-beta']).toBeUndefined();
    expect(result.cost).toBeUndefined();
  });

  it('C3 claude-sonnet-5 keeps its own rules', async () => {
    const fetcher = installFetch({});
    await provider().chat(hi, {
      model: 'claude-sonnet-5',
      effort: 'max',
      thinkingBudget: 0,
      providerOptions: { top_k: 5 },
    });
    // Sonnet 5 disables thinking up to max and has no raw sampling guard.
    expect(captured(fetcher).body).toMatchObject({
      thinking: { type: 'disabled' },
      output_config: { effort: 'max' },
      top_k: 5,
    });
  });

  it('C4 claude-haiku-4-5 keeps the legacy manual-thinking path', async () => {
    const fetcher = installFetch({});
    await provider().chat(hi, { model: 'claude-haiku-4-5', effort: 'low', maxTokens: 100 });
    expect(captured(fetcher).body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(captured(fetcher).headers['anthropic-beta']).toBeUndefined();
  });

  it('never sends the binding beta without replayed thinking (T-B7, QR8)', async () => {
    for (const model of [HAIKU, SONNET]) {
      const fetcher = installFetch({});
      await provider().chat(hi, { model, effort: 'high' });
      expect(captured(fetcher).headers['anthropic-beta']).toBeUndefined();
      expect(captured(fetcher).body.thinking).toEqual({ type: 'adaptive' });
      expect(captured(fetcher).raw).not.toContain(BINDING_BETA);
    }
  });
});
