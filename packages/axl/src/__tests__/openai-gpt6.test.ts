import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnsupportedModelOptionError } from '../errors.js';
import { OpenAIProvider, OPENAI_PRICING, estimateDirectOpenAICost } from '../providers/openai.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';

const originalFetch = globalThis.fetch;
const message = [{ role: 'user' as const, content: 'hi' }];
const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'check',
      description: 'Check',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function captureFetch() {
  const requests: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    requests.push(body);
    if (String(_url).endsWith('/responses')) {
      return new Response(
        JSON.stringify({
          model: body.model,
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        model: body.model,
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  globalThis.fetch = fetchMock as typeof fetch;
  return { requests, fetchMock };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('exact GPT-6 adapter boundary', () => {
  it.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])(
    'maps %s on both endpoints and prices text',
    async (model) => {
      const { requests } = captureFetch();
      const chat = await new OpenAIProvider({ apiKey: 'test' }).chat(message, {
        model,
        effort: 'max',
      });
      const responses = await new OpenAIResponsesProvider({ apiKey: 'test' }).chat(message, {
        model,
        effort: 'max',
      });
      expect(requests[0]).toMatchObject({ model, reasoning_effort: 'max' });
      expect(requests[1]).toMatchObject({ model, reasoning: { effort: 'max' } });
      expect(chat.cost).toBeGreaterThan(0);
      expect(responses.cost).toBe(chat.cost);
    },
  );

  it('clamps Astra none to low and keeps Sol/Luna none and max', async () => {
    const { requests } = captureFetch();
    const chat = new OpenAIProvider({ apiKey: 'test' });
    await chat.chat(message, { model: 'gpt-6-astra', effort: 'none' });
    await chat.chat(message, { model: 'gpt-6-sol', effort: 'none' });
    await chat.chat(message, { model: 'gpt-6-luna', effort: 'max' });
    expect(requests.map((r) => r.reasoning_effort)).toEqual(['low', 'none', 'max']);
    expect(chat.effortResolution({ model: 'gpt-6-astra', effort: 'none' })).toMatchObject({
      requested: 'none',
      effective: 'low',
      clamped: true,
    });
  });

  it.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])(
    'rejects forbidden Chat tools for %s with zero fetches',
    async (model) => {
      const { fetchMock } = captureFetch();
      const provider = new OpenAIProvider({ apiKey: 'test' });
      let failure: unknown;
      try {
        await provider.chat(message, { model, tools, effort: 'high' });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(UnsupportedModelOptionError);
      expect(failure).toMatchObject({
        provider: 'openai',
        model,
        option: 'Chat Completions tool calling',
      });
      expect((failure as Error).message).toContain(`openai-responses:${model}`);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('accepts explicit effective none with Sol/Luna Chat tools, including native override', async () => {
    const { requests } = captureFetch();
    const provider = new OpenAIProvider({ apiKey: 'test' });
    await provider.chat(message, { model: 'gpt-6-sol', tools, effort: 'none' });
    await provider.chat(message, {
      model: 'gpt-6-luna',
      tools,
      effort: 'high',
      providerOptions: { reasoning_effort: 'none' },
    });
    expect(requests.map((body) => body.reasoning_effort)).toEqual(['none', 'none']);
  });

  it('validates the final model and tools after both directions of native overrides', async () => {
    const { requests, fetchMock } = captureFetch();
    const provider = new OpenAIProvider({ apiKey: 'test' });
    await expect(
      provider.chat(message, {
        model: 'gpt-5.6-luna',
        effort: 'high',
        tools,
        providerOptions: { model: 'gpt-6-astra' },
      }),
    ).rejects.toMatchObject({ model: 'gpt-6-astra' });
    expect(fetchMock).not.toHaveBeenCalled();
    await provider.chat(message, {
      model: 'gpt-6-astra',
      effort: 'high',
      tools,
      providerOptions: { model: 'gpt-5.6-luna' },
    });
    expect(requests[0].model).toBe('gpt-5.6-luna');
    await provider.chat(message, {
      model: 'gpt-6-sol',
      effort: 'high',
      tools,
      providerOptions: { tools: [], tool_choice: 'none' },
    });
    expect(requests[1].tools).toEqual([]);
    await expect(
      provider.chat(message, {
        model: 'gpt-6-sol',
        effort: 'none',
        providerOptions: { tools },
      }),
    ).resolves.toMatchObject({ content: 'ok' });
    await expect(
      provider.chat(message, {
        model: 'gpt-6-sol',
        effort: 'none',
        providerOptions: { tools, reasoning_effort: 'high' },
      }),
    ).rejects.toMatchObject({ model: 'gpt-6-sol' });
  });

  it.each(['temperature', 'top_p', 'top_logprobs', 'logprobs'])(
    'rejects active Chat %s overrides before fetch',
    async (option) => {
      const { fetchMock } = captureFetch();
      const provider = new OpenAIProvider({ apiKey: 'test' });
      await expect(
        provider.chat(message, {
          model: 'gpt-6-sol',
          effort: 'high',
          providerOptions: { [option]: option === 'logprobs' ? true : 0.5 },
        }),
      ).rejects.toMatchObject({ option, model: 'gpt-6-sol' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects raw Responses sampling overrides and the logprobs include while reasoning is active', async () => {
    const { fetchMock } = captureFetch();
    const provider = new OpenAIResponsesProvider({ apiKey: 'test' });
    for (const option of ['temperature', 'top_p', 'top_logprobs']) {
      await expect(
        provider.chat(message, {
          model: 'gpt-6-astra',
          providerOptions: { [option]: 0.5 },
        }),
      ).rejects.toMatchObject({ option, model: 'gpt-6-astra', provider: 'openai-responses' });
    }
    await expect(
      provider.chat(message, {
        model: 'gpt-6-sol',
        providerOptions: { include: ['message.output_text.logprobs'] },
      }),
    ).rejects.toMatchObject({ option: 'message.output_text.logprobs' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps unknown GPT-6 siblings pass-through and unpriced', async () => {
    const { requests } = captureFetch();
    const response = await new OpenAIProvider({ apiKey: 'test' }).chat(message, {
      model: 'gpt-6-sol-2099-01-01',
      tools,
      temperature: 0.4,
    });
    expect(requests[0].temperature).toBe(0.4);
    expect(response.cost).toBeUndefined();
  });
});

/**
 * Portable `ChatOptions.temperature` follows the same policy as GPT-5.x: it is
 * stripped while reasoning is active. Only a raw `providerOptions` field that
 * re-injects a forbidden wire parameter is rejected. Every case asserts the
 * final wire body, so "stripped" and "rejected" cannot be confused.
 */
describe('GPT-6 sampling policy: portable options stripped, raw overrides rejected', () => {
  const endpoints = [
    { name: 'Chat', create: () => new OpenAIProvider({ apiKey: 'test' }) },
    { name: 'Responses', create: () => new OpenAIResponsesProvider({ apiKey: 'test' }) },
  ] as const;
  const models = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'];

  for (const endpoint of endpoints) {
    it.each(models)(
      `${endpoint.name} strips portable temperature for %s under explicit active effort`,
      async (model) => {
        const { requests } = captureFetch();
        await endpoint.create().chat(message, { model, effort: 'high', temperature: 0.4 });
        expect(requests).toHaveLength(1);
        expect(requests[0]).not.toHaveProperty('temperature');
        expect(requests[0].model).toBe(model);
      },
    );

    it.each(models)(
      `${endpoint.name} strips portable temperature for %s under the active default effort`,
      async (model) => {
        const { requests } = captureFetch();
        await endpoint.create().chat(message, { model, temperature: 0.4 });
        expect(requests).toHaveLength(1);
        expect(requests[0]).not.toHaveProperty('temperature');
        expect(requests[0]).not.toHaveProperty('reasoning_effort');
      },
    );

    it(`${endpoint.name} strips portable temperature when Astra clamps none to low`, async () => {
      const { requests } = captureFetch();
      await endpoint.create().chat(message, {
        model: 'gpt-6-astra',
        effort: 'none',
        temperature: 0.4,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty('temperature');
    });

    it.each(['gpt-6-sol', 'gpt-6-luna'])(
      `${endpoint.name} keeps portable temperature for %s at effective none`,
      async (model) => {
        const { requests } = captureFetch();
        await endpoint.create().chat(message, { model, effort: 'none', temperature: 0.4 });
        expect(requests).toHaveLength(1);
        expect(requests[0].temperature).toBe(0.4);
      },
    );

    it(`${endpoint.name} keeps a raw temperature override for Sol at effective none`, async () => {
      const { requests } = captureFetch();
      await endpoint.create().chat(message, {
        model: 'gpt-6-sol',
        effort: 'none',
        providerOptions: { temperature: 0.3, top_p: 0.9 },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ temperature: 0.3, top_p: 0.9 });
    });

    it(`${endpoint.name} rejects a raw temperature override even when a portable one was stripped`, async () => {
      const { fetchMock } = captureFetch();
      await expect(
        endpoint.create().chat(message, {
          model: 'gpt-6-luna',
          effort: 'high',
          temperature: 0.4,
          providerOptions: { temperature: 0.5 },
        }),
      ).rejects.toBeInstanceOf(UnsupportedModelOptionError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it.each([
    ['Chat', () => new OpenAIProvider({ apiKey: 'test' }), { reasoning_effort: 'high' }],
    [
      'Responses',
      () => new OpenAIResponsesProvider({ apiKey: 'test' }),
      { reasoning: { effort: 'high' } },
    ],
  ] as const)(
    '%s rejects a raw effort override that activates reasoning after the portable temperature was kept',
    async (_name, create, providerOptions) => {
      const { fetchMock } = captureFetch();
      await expect(
        create().chat(message, {
          model: 'gpt-6-sol',
          effort: 'none',
          temperature: 0.4,
          providerOptions: { ...providerOptions },
        }),
      ).rejects.toMatchObject({ option: 'temperature', model: 'gpt-6-sol' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('Chat strips portable temperature in the streaming request body too', async () => {
    const { requests } = captureFetch();
    const stream = new OpenAIProvider({ apiKey: 'test' }).stream(message, {
      model: 'gpt-6-sol',
      effort: 'medium',
      temperature: 0.4,
    });
    await stream.next().catch(() => undefined);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty('temperature');
  });
});

describe('GPT-6 Standard estimator', () => {
  const rows = [
    ['gpt-6-astra', [10, 1, 12.5, 50], [20, 2, 25, 75]],
    ['gpt-6-sol', [2, 0.2, 2.5, 10], [4, 0.4, 5, 15]],
    ['gpt-6-luna', [0.1, 0.01, 0.125, 0.5], [0.2, 0.02, 0.25, 0.75]],
  ] as const;
  it.each(rows)('prices %s across full-call boundary with cache buckets', (model, short, long) => {
    for (const total of [271_999, 272_000, 272_001]) {
      const [input, cacheRead, cacheWrite, output] = total > 272_000 ? long : short;
      const expected =
        ((total - 300) * input + 200 * cacheRead + 100 * cacheWrite + 7 * output) / 1_000_000;
      expect(
        estimateDirectOpenAICost(model, {
          prompt_tokens: total,
          completion_tokens: 7,
          total_tokens: total + 7,
          cached_tokens: 200,
          cache_write_tokens: 100,
        }),
      ).toBeCloseTo(expected, 12);
    }
    expect(OPENAI_PRICING).not.toHaveProperty(model);
    expect(
      estimateDirectOpenAICost(`${model}-2099-01-01`, {
        prompt_tokens: 10,
        completion_tokens: 1,
        total_tokens: 11,
      }),
    ).toBeUndefined();
  });

  it('keeps unknown billing, media, and hosted tools unpriced', () => {
    const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
    expect(
      estimateDirectOpenAICost('gpt-6-sol', usage, { request: { service_tier: 'fast' } }),
    ).toBeUndefined();
    expect(
      estimateDirectOpenAICost('gpt-6-sol', usage, { request: { region: 'eu' } }),
    ).toBeUndefined();
    expect(
      estimateDirectOpenAICost('gpt-6-sol', usage, {
        request: { tools: [{ type: 'web_search' }] },
      }),
    ).toBeUndefined();
    expect(
      estimateDirectOpenAICost('gpt-6-sol', { ...usage, audio_input_tokens: 1 }),
    ).toBeUndefined();
    expect(
      estimateDirectOpenAICost('gpt-6-sol', { ...usage, prompt_tokens: Number.NaN }),
    ).toBeUndefined();
    expect(
      estimateDirectOpenAICost('gpt-6-sol', { ...usage, total_tokens: Number.NaN }),
    ).toBeUndefined();
    expect(estimateDirectOpenAICost('gpt-6-sol', { ...usage, total_tokens: 109 })).toBeUndefined();
  });
});
