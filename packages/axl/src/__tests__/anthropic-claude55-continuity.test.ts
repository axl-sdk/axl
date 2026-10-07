// Claude Haiku 5.5 / Sonnet 5.5 thinking continuity: binding beta and
// block_binding only under adaptive thinking (D2), off-shape replay, provider
// drop diagnostics, and stream parsing of progress-update blocks. Every
// replayed history is produced by a first mocked provider response.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';
import type { AxlEvent } from '../types.js';
import type { ChatMessage, ChatOptions, Effort } from '../providers/types.js';
import {
  BINDING_BETA,
  HAIKU,
  MODES,
  SONNET,
  captured,
  historyFrom,
  installFetch,
  provider,
  run,
  toolTurn,
  type Fixture,
  type Mode,
} from './anthropic-claude55-helpers.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const OFF_SHAPE: Record<string, 'disabled' | 'between_tools'> = {
  [HAIKU]: 'disabled',
  [SONNET]: 'between_tools',
};
const DROP_BLOCK = { prefix_mismatch_behavior: 'drop_block' };

/** First turn on `model` returns signed thinking + tool_use; returns the history it produced. */
async function firstTurn(
  mode: Mode,
  model: string,
  options: Partial<ChatOptions> = {},
  turn: Fixture = toolTurn(),
): Promise<ChatMessage[]> {
  installFetch({ ...turn, model });
  const outcome = await run(mode, [{ role: 'user', content: 'calculate' }], {
    model,
    ...options,
  });
  return historyFrom(outcome);
}

function replayedAssistant(body: Record<string, any>) {
  return body.messages.find((message: any) => message.role === 'assistant');
}

describe.each(MODES)('replay under adaptive vs off-shape (%s)', (mode) => {
  it.each([
    ['T-B1', HAIKU, 'high'],
    ['T-B2', SONNET, 'medium'],
    ['T-B6', HAIKU, 'xhigh', 0],
  ] as const)(
    '%s %s adaptive at %s sends the beta and drop_block',
    async (_id, model, effort, budget?: number) => {
      const history = await firstTurn(mode, model, { effort });
      const fetcher = installFetch({});
      await run(mode, history, { model, effort, thinkingBudget: budget });
      const { body, headers } = captured(fetcher);
      expect(headers['anthropic-beta']).toBe(BINDING_BETA);
      expect(body.thinking).toEqual({ type: 'adaptive', block_binding: DROP_BLOCK });
      expect(replayedAssistant(body).content[0]).toEqual({
        type: 'thinking',
        thinking: 'private reasoning',
        signature: 'signed-secret',
      });
    },
  );

  it('QR1 effort unset + replay injects adaptive with drop_block', async () => {
    const history = await firstTurn(mode, HAIKU);
    const fetcher = installFetch({});
    await run(mode, history, { model: HAIKU });
    expect(captured(fetcher).body.thinking).toEqual({
      type: 'adaptive',
      block_binding: DROP_BLOCK,
    });
    expect(captured(fetcher).headers['anthropic-beta']).toBe(BINDING_BETA);
  });

  it.each([
    ['T-B3', HAIKU, { effort: 'none' as Effort }],
    ['T-B4', SONNET, { effort: 'none' as Effort }],
    ['T-B5', HAIKU, { effort: 'high' as Effort, thinkingBudget: 0 }],
    ['T-B5 sonnet', SONNET, { effort: 'low' as Effort, thinkingBudget: 0 }],
  ] as const)(
    '%s %s off-shape replay sends no beta and no block_binding',
    async (_id, model, options) => {
      const history = await firstTurn(mode, model, { effort: 'high' });
      const replayedBlocks = (history[1].providerMetadata as any).anthropicThinkingBlocks;
      const fetcher = installFetch({});
      await run(mode, history, { model, ...options });
      const { body, headers } = captured(fetcher);
      expect(headers['anthropic-beta']).toBeUndefined();
      expect(body.thinking).toEqual({ type: OFF_SHAPE[model] });
      expect(JSON.stringify(replayedAssistant(body).content[0])).toBe(
        JSON.stringify(replayedBlocks[0]),
      );
    },
  );

  it('T-B3 keeps other required betas under the off-shape', async () => {
    const history = await firstTurn(mode, HAIKU, { effort: 'high' });
    const fetcher = installFetch({});
    await run(
      mode,
      [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'provider-file', provider: 'anthropic', reference: 'file-1' },
            },
          ],
        },
        ...history,
      ],
      { model: HAIKU, effort: 'none' },
    );
    expect(captured(fetcher).headers['anthropic-beta']).toBe('files-api-2025-04-14');
  });

  it('T-B15 turn A high then turn B none replays under the off-shape', async () => {
    const history = await firstTurn(mode, SONNET, { effort: 'high' });
    const fetcher = installFetch(toolTurn('second', 'sig-2'), {});
    const second = await run(mode, history, { model: SONNET, effort: 'high' });
    const longer = [...history, ...historyFrom(second).slice(1)];
    await run(mode, longer, { model: SONNET, effort: 'none' });
    expect(captured(fetcher, 0).headers['anthropic-beta']).toBe(BINDING_BETA);
    const turnB = captured(fetcher, 1);
    expect(turnB.headers['anthropic-beta']).toBeUndefined();
    expect(turnB.body.thinking).toEqual({ type: 'between_tools' });
    const thinking = turnB.body.messages
      .filter((message: any) => message.role === 'assistant')
      .map((message: any) => message.content[0]);
    expect(thinking).toEqual([
      { type: 'thinking', thinking: 'private reasoning', signature: 'signed-secret' },
      { type: 'thinking', thinking: 'second', signature: 'sig-2' },
    ]);
  });

  it('T-PO15 haiku keeps an explicit error policy with the beta', async () => {
    const history = await firstTurn(mode, HAIKU, { effort: 'high' });
    const fetcher = installFetch({});
    await run(mode, history, {
      model: HAIKU,
      effort: 'high',
      providerOptions: {
        thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } },
      },
    });
    expect(captured(fetcher).headers['anthropic-beta']).toBe(BINDING_BETA);
    expect(captured(fetcher).body.thinking.block_binding).toEqual({
      prefix_mismatch_behavior: 'error',
    });
  });
});

describe.each(MODES)('provider drops and errors (%s)', (mode) => {
  const drops = [
    { type: 'thinking_dropped', reason: 'prefix_binding_mismatch', path: 'messages.1.content.0' },
    { type: 'thinking_dropped', reason: 'model_binding_mismatch', path: 'messages.1.content.0' },
  ];

  it.each([HAIKU, SONNET])(
    'T-B8/9 %s reports one reset with counts and no detail',
    async (model) => {
      const history = await firstTurn(mode, model, { effort: 'high' });
      installFetch({ input_transformations: drops });
      const outcome = await run(mode, history, { model, effort: 'high' });
      expect(outcome.diagnostics).toEqual({
        reasoningContextReset: {
          droppedBlocks: 2,
          reasons: { prefix_binding_mismatch: 1, model_binding_mismatch: 1 },
        },
      });
      expect(JSON.stringify(outcome.diagnostics)).not.toMatch(/signed-secret|messages\./);
    },
  );

  it.each([
    ['T-B10 haiku→sonnet', HAIKU, SONNET],
    ['T-B10 sonnet→haiku', SONNET, HAIKU],
    ['T-B11 opus-5-5→sonnet', 'claude-opus-5-5', SONNET],
  ])('%s keeps blocks locally and reports the provider drop', async (_id, from, to) => {
    const history = await firstTurn(
      mode,
      from,
      from === HAIKU || from === SONNET ? { effort: 'high' } : {},
    );
    const fetcher = installFetch({ input_transformations: [drops[1]] });
    const outcome = await run(mode, history, { model: to, effort: 'high' });
    expect(replayedAssistant(captured(fetcher).body).content[0]).toEqual({
      type: 'thinking',
      thinking: 'private reasoning',
      signature: 'signed-secret',
    });
    expect(outcome.diagnostics).toEqual({
      reasoningContextReset: { droppedBlocks: 1, reasons: { model_binding_mismatch: 1 } },
    });
  });

  it.each([
    ['T-B12', HAIKU],
    ['T-B13', SONNET],
  ])('%s %s off-shape edited prefix surfaces the 400 without retry', async (_id, model) => {
    const history = await firstTurn(mode, model, { effort: 'high' });
    const fetcher = installFetch({
      status: 400,
      message: 'thinking block prefix mismatch',
    });
    await expect(
      run(mode, [{ role: 'system', content: 'edited system prompt' }, ...history], {
        model,
        effort: 'none',
      }),
    ).rejects.toMatchObject({ name: 'ProviderError', status: 400 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(captured(fetcher).body.thinking).toEqual({ type: OFF_SHAPE[model] });
  });

  it('T-B16 adaptive + unexpected 400 is one ProviderError', async () => {
    const history = await firstTurn(mode, SONNET, { effort: 'high' });
    const fetcher = installFetch({ status: 400, message: 'unexpected' });
    await expect(run(mode, history, { model: SONNET, effort: 'high' })).rejects.toMatchObject({
      name: 'ProviderError',
      status: 400,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe.each(MODES)('progress-update and empty thinking blocks (%s)', (mode) => {
  it('T-ST1/2 sonnet none surfaces progress text and replays it byte-identically', async () => {
    const turn: Fixture = {
      content: [
        { type: 'thinking', thinking: 'Checking weather…', signature: 'sigX' },
        { type: 'tool_use', id: 'tool-1', name: 'calc', input: {} },
      ],
      stop_reason: 'tool_use',
    };
    installFetch({ ...turn, model: SONNET });
    const outcome = await run(mode, [{ role: 'user', content: 'weather?' }], {
      model: SONNET,
      effort: 'none',
    });
    expect(outcome.thinking).toBe('Checking weather…');
    expect(outcome.providerMetadata).toEqual({
      anthropicThinkingBlocks: [
        { type: 'thinking', thinking: 'Checking weather…', signature: 'sigX' },
      ],
    });
    const fetcher = installFetch({});
    await run(mode, historyFrom(outcome), { model: SONNET, effort: 'none' });
    const { body, headers, raw } = captured(fetcher);
    expect(headers['anthropic-beta']).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'between_tools' });
    expect(raw).toContain('{"type":"thinking","thinking":"Checking weather…","signature":"sigX"}');
  });

  it('T-ST3 haiku keeps an empty thinking string with its signature', async () => {
    installFetch({ ...toolTurn('', 'sig-empty'), model: HAIKU });
    const outcome = await run(mode, [{ role: 'user', content: 'calculate' }], { model: HAIKU });
    expect(outcome.providerMetadata).toEqual({
      anthropicThinkingBlocks: [{ type: 'thinking', thinking: '', signature: 'sig-empty' }],
    });
    const fetcher = installFetch({});
    await run(mode, historyFrom(outcome), { model: HAIKU });
    expect(replayedAssistant(captured(fetcher).body).content[0]).toEqual({
      type: 'thinking',
      thinking: '',
      signature: 'sig-empty',
    });
  });

  it('T-ST4 a refusal takes the existing path and stays unpriced', async () => {
    installFetch({
      model: HAIKU,
      content: [{ type: 'text', text: 'I cannot help with that.' }],
      stop_reason: 'refusal',
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    const outcome = await run(mode, [{ role: 'user', content: 'x' }], { model: HAIKU });
    expect(outcome.cost).toBeUndefined();
  });
});

describe('T-B14 haiku none + maxContext summary', () => {
  it.each([false, true])(
    'strips stale blocks and reports client_prefix_rewrite (stream=%s)',
    async (stream) => {
      const firstHistory = await firstTurn('chat', HAIKU, { effort: 'high' });
      const history: ChatMessage[] = Array.from({ length: 40 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `older ${index}: ${'x'.repeat(200)}`,
      }));
      history.push(...firstHistory);
      const requests: Array<{ body: Record<string, any>; headers: Record<string, string> }> = [];
      const answer = installFetch({ model: HAIKU, content: [{ type: 'text', text: 'continued' }] });
      const summary = installFetch({ model: HAIKU, content: [{ type: 'text', text: 'summary' }] });
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        requests.push({ body, headers: init.headers as Record<string, string> });
        const isSummary = String(body.system).includes('Summarize the following conversation');
        return (isSummary ? summary : answer)(url, init);
      }) as unknown as typeof fetch;

      const registry = new ProviderRegistry();
      registry.registerInstance('anthropic', provider());
      const events: AxlEvent[] = [];
      const ctx = new WorkflowContext({
        input: 'task',
        executionId: `haiku-summary-${stream}`,
        metadata: {},
        config: { defaultProvider: 'anthropic', diagnostics: { silent: true } },
        providerRegistry: registry,
        sessionHistory: history,
        onTrace: (event) => events.push(event),
        _forceStreaming: stream,
      });
      const worker = agent({
        name: 'haiku-summary',
        model: `anthropic:${HAIKU}`,
        system: 'Answer briefly.',
        effort: 'none',
        maxContext: 2700,
      });
      expect(await ctx.ask(worker, 'next question')).toBe('continued');
      const actual = requests.filter(
        (request) => !String(request.body.system).includes('Summarize the following conversation'),
      );
      expect(actual).toHaveLength(1);
      expect(actual[0].headers['anthropic-beta']).toBeUndefined();
      expect(actual[0].body.thinking).toEqual({ type: 'disabled' });
      expect(JSON.stringify(actual[0].body.messages)).not.toContain('signed-secret');
      const resets = events.filter(
        (event) =>
          event.type === 'provider_diagnostic' && event.data.kind === 'reasoning_context_reset',
      );
      expect(resets.map((event) => event.type === 'provider_diagnostic' && event.data)).toEqual([
        {
          kind: 'reasoning_context_reset',
          provider: 'anthropic',
          model: HAIKU,
          droppedBlocks: 1,
          reasons: { client_prefix_rewrite: 1 },
        },
      ]);
    },
  );
});
