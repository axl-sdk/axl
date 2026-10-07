import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../providers/anthropic.js';
import type { ChatMessage } from '../providers/types.js';

// Final-body guards are per-model capability fields. A model only gets the
// guards its own provider contract calls for: models without a field must keep
// sending what they sent before the guards were split apart.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fetchOk(model: string) {
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  });
  globalThis.fetch = fetcher;
  return fetcher;
}

const provider = () => new AnthropicProvider({ apiKey: 'test-key' });
const hi: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const tools = [
  {
    type: 'function' as const,
    function: { name: 'calc', description: 'calc', parameters: { type: 'object' } },
  },
];

const replay: ChatMessage[] = [
  { role: 'user', content: 'calculate' },
  {
    role: 'assistant',
    content: 'Working',
    providerMetadata: {
      anthropicThinkingBlocks: [{ type: 'thinking', thinking: 'r', signature: 'sig' }],
    },
    tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'calc', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'tool-1', content: '2' },
];

const sentBody = (fetcher: ReturnType<typeof fetchOk>) =>
  JSON.parse(fetcher.mock.calls[0][1].body) as Record<string, unknown>;

// Models with a capability entry but none of the split guard fields.
const unguarded = ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-opus-4-8'];

describe('Anthropic capability guards act only on models that declare them', () => {
  it.each(unguarded)('%s still sends a forced tool choice', async (model) => {
    const fetcher = fetchOk(model);
    await provider().chat(hi, { model, tools, toolChoice: 'required' });
    expect(sentBody(fetcher).tool_choice).toEqual({ type: 'any' });
    await provider().chat(hi, {
      model,
      tools,
      toolChoice: { type: 'function', function: { name: 'calc' } },
    });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).tool_choice).toEqual({
      type: 'tool',
      name: 'calc',
    });
  });

  it.each(unguarded)('%s still passes raw thinking shapes and effort through', async (model) => {
    const shapes = [
      { thinking: { type: 'disabled' } },
      { thinking: { type: 'enabled', budget_tokens: 2048 } },
      { output_config: { effort: 'none' } },
    ];
    for (const providerOptions of shapes) {
      const fetcher = fetchOk(model);
      await provider().chat(hi, { model, providerOptions });
      expect(sentBody(fetcher)).toMatchObject(providerOptions);
    }
  });

  it.each(unguarded)('%s still passes raw sampling through', async (model) => {
    const fetcher = fetchOk(model);
    await provider().chat(hi, {
      model,
      providerOptions: { temperature: 0.3, top_p: 0.5, top_k: 20 },
    });
    expect(sentBody(fetcher)).toMatchObject({ temperature: 0.3, top_p: 0.5, top_k: 20 });
  });

  it.each(unguarded)(
    '%s replays thinking without the binding beta or block_binding',
    async (model) => {
      const fetcher = fetchOk(model);
      await provider().chat(replay, { model });
      expect(fetcher.mock.calls[0][1].headers['anthropic-beta']).toBeUndefined();
      expect(
        (sentBody(fetcher).thinking as Record<string, unknown> | undefined)?.block_binding,
      ).toBe(undefined);
    },
  );

  it('keeps the disabled off-shape for a default-on model with no offShape', async () => {
    const fetcher = fetchOk('claude-opus-5');
    await provider().chat(hi, { model: 'claude-opus-5', effort: 'none' });
    expect(sentBody(fetcher).thinking).toEqual({ type: 'disabled' });
  });

  it('applies no guards to an exact legacy or unknown model', async () => {
    for (const model of ['claude-haiku-4-5', 'claude-haiku-5-5-20261007']) {
      const fetcher = fetchOk(model);
      await provider().chat(replay, {
        model,
        tools,
        toolChoice: 'required',
        providerOptions: { thinking: { type: 'disabled' }, top_k: 5, temperature: 0.2 },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1].headers['anthropic-beta']).toBeUndefined();
      expect(sentBody(fetcher).thinking).toEqual({ type: 'disabled' });
    }
  });
});

describe.each(['claude-opus-5-5', 'claude-fable-5-1'])('%s keeps every guard', (model) => {
  it.each([
    [{ tool_choice: { type: 'any' } }, 'forced tool choice'],
    [{ tool_choice: { type: 'tool', name: 'calc' } }, 'forced tool choice'],
    [{ thinking: { type: 'disabled' } }, 'manual or disabled thinking'],
    [{ thinking: { type: 'enabled', budget_tokens: 2048 } }, 'manual or disabled thinking'],
    [{ output_config: { effort: 'none' } }, 'output_config.effort'],
    [{ temperature: 0.3 }, 'temperature'],
    [{ top_p: 0.5 }, 'top_p'],
    [{ top_k: 20 }, 'top_k'],
  ] as const)('rejects %j before dispatch', async (providerOptions, option) => {
    const fetcher = fetchOk(model);
    await expect(provider().chat(hi, { model, tools, providerOptions })).rejects.toMatchObject({
      name: 'UnsupportedModelOptionError',
      model,
      option,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts auto tool choice, default sampling, and adaptive thinking', async () => {
    const fetcher = fetchOk(model);
    await provider().chat(hi, {
      model,
      tools,
      toolChoice: 'auto',
      providerOptions: { temperature: 1, thinking: { type: 'adaptive' } },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('binds replayed thinking with the beta and drop_block', async () => {
    const fetcher = fetchOk(model);
    await provider().chat(replay, { model });
    expect(fetcher.mock.calls[0][1].headers['anthropic-beta']).toBe(
      'thinking-binding-controls-2026-08-01',
    );
    expect(sentBody(fetcher).thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
  });
});
