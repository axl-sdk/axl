import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatibleProvider, type ProviderProfile } from '../providers/openai-compatible.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  OPENROUTER_PROFILE,
  AZURE_PROFILE,
  XAI_PROFILE,
  DEEPSEEK_PROFILE,
  MISTRAL_PROFILE,
  GROQ_PROFILE,
  BEDROCK_PROFILE,
  OLLAMA_PROFILE,
  BUILTIN_PROFILES,
} from '../providers/profiles/index.js';
import type { ChatMessage } from '../providers/types.js';

const originalFetch = globalThis.fetch;

function mockFetch(response: {
  ok?: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  body?: ReadableStream<Uint8Array>;
}) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    headers: new Headers(),
    json: response.json ?? (() => Promise.resolve({})),
    text: () => Promise.resolve(''),
    body: response.body,
  });
  globalThis.fetch = fn as any;
  return fn;
}

function req(fetchMock: ReturnType<typeof mockFetch>) {
  const call = fetchMock.mock.calls[0];
  return {
    url: call[0] as string,
    headers: call[1].headers as Record<string, string>,
    body: JSON.parse(call[1].body as string) as Record<string, unknown>,
  };
}

function ok(extra: Record<string, unknown> = {}, message: Record<string, unknown> = {}) {
  return {
    json: () =>
      Promise.resolve({
        choices: [{ message: { content: 'hi', ...message }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        ...extra,
      }),
  };
}

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < lines.length) controller.enqueue(enc.encode(`${lines[index++]}\n`));
      else controller.close();
    },
  });
}

const user: ChatMessage[] = [{ role: 'user', content: 'Hello' }];

function provider(profile: ProviderProfile, apiKey: string | undefined = 'k', baseUrl?: string) {
  return new OpenAICompatibleProvider({ profile, apiKey, baseUrl });
}

const AZURE_BASE = 'https://my-resource.openai.azure.com/openai/v1';
const azure = () => provider(AZURE_PROFILE, 'k', AZURE_BASE);

const BEDROCK_BASE = 'https://bedrock-mantle.us-east-1.api.aws/v1';
const bedrock = () => provider(BEDROCK_PROFILE, 'tok', BEDROCK_BASE);

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

// ===========================================================================
// OpenRouter
// ===========================================================================

describe('OpenRouter preset', () => {
  it('targets the OpenRouter base URL and reports usage.cost', async () => {
    const fetchMock = mockFetch(
      ok({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.0123 } }),
    );
    const r = await provider(OPENROUTER_PROFILE).chat(user, { model: 'anthropic/claude-x' });
    expect(req(fetchMock).url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(req(fetchMock).body).not.toHaveProperty('usage');
    expect(r.cost).toBe(0.0123);
  });

  it('emits the reasoning object: effort, clamped, XOR max_tokens, or disabled', async () => {
    let fetchMock = mockFetch(ok());
    await provider(OPENROUTER_PROFILE).chat(user, { model: 'm', effort: 'high' });
    expect(req(fetchMock).body.reasoning).toEqual({ effort: 'high' });

    fetchMock = mockFetch(ok());
    await provider(OPENROUTER_PROFILE).chat(user, { model: 'm', effort: 'max' });
    expect(req(fetchMock).body.reasoning).toEqual({ effort: 'high' }); // clamp

    fetchMock = mockFetch(ok());
    await provider(OPENROUTER_PROFILE).chat(user, { model: 'm', thinkingBudget: 4000 });
    expect(req(fetchMock).body.reasoning).toEqual({ max_tokens: 4000 }); // budget wins, XOR

    fetchMock = mockFetch(ok());
    await provider(OPENROUTER_PROFILE).chat(user, { model: 'm', effort: 'none' });
    expect(req(fetchMock).body.reasoning).toEqual({ enabled: false });
  });

  it('captures message.reasoning + round-trips reasoning_details on tool turns', async () => {
    const details = [{ type: 'reasoning.text', text: 'why' }];
    mockFetch(ok({}, { reasoning: 'because', reasoning_details: details }));
    const r = await provider(OPENROUTER_PROFILE).chat(user, { model: 'm' });
    expect(r.thinking_content).toBe('because');
    expect(r.providerMetadata).toEqual({
      openaiCompatReasoning: { provider: 'openrouter', field: 'reasoning_details', value: details },
    });
  });
});

// ===========================================================================
// Azure OpenAI
// ===========================================================================

describe('Azure preset', () => {
  it('throws if no base URL is provided (resource-specific, no default)', () => {
    expect(() => provider({ ...AZURE_PROFILE, envBaseUrl: undefined })).toThrow(
      /Azure OpenAI requires a base URL/,
    );
  });

  it('targets the configured resource base URL', async () => {
    const fetchMock = mockFetch(ok());
    await azure().chat(user, { model: 'my-deployment' });
    expect(req(fetchMock).url).toBe(`${AZURE_BASE}/chat/completions`);
  });

  it('authenticates with the api-key header (not Bearer)', async () => {
    const fetchMock = mockFetch(ok());
    await azure().chat(user, { model: 'my-deployment' });
    expect(req(fetchMock).headers['api-key']).toBe('k');
    expect(req(fetchMock).headers.Authorization).toBeUndefined();
  });

  it('can override authHeader for Entra bearer-token callbacks', async () => {
    const fetchMock = mockFetch(ok());
    await new OpenAICompatibleProvider({
      profile: AZURE_PROFILE,
      baseUrl: AZURE_BASE,
      apiKey: async () => 'entra-token',
      authHeader: 'bearer',
    }).chat(user, { model: 'my-deployment' });
    expect(req(fetchMock).headers.Authorization).toBe('Bearer entra-token');
    expect(req(fetchMock).headers['api-key']).toBeUndefined();
  });

  it('remains unpriced even when a deployment is named after a direct OpenAI model', async () => {
    mockFetch(ok());
    const named = await azure().chat(user, { model: 'gpt-4o' });
    expect(named.cost).toBeUndefined();

    mockFetch(ok());
    const arbitrary = await azure().chat(user, { model: 'prod-deploy-7' });
    expect(arbitrary.cost).toBeUndefined();
  });

  it('reuses OpenAI reasoning: system→developer + reasoning_effort on o-series', async () => {
    const fetchMock = mockFetch(ok());
    await azure().chat(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ],
      { model: 'o3', effort: 'high' },
    );
    const body = req(fetchMock).body;
    expect((body.messages as any[])[0].role).toBe('developer');
    expect(body.reasoning_effort).toBe('high');
  });
});

// ===========================================================================
// xAI Grok
// ===========================================================================

describe('xAI preset', () => {
  it('uses exact Grok 4.5 descriptors and clamps irreducible none to low once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fetchMock = mockFetch(ok());
    await provider(XAI_PROFILE).chat(user, { model: 'grok-4.5', effort: 'max' });
    expect(req(fetchMock).body.reasoning_effort).toBe('high');

    fetchMock = mockFetch(ok());
    await provider(XAI_PROFILE).chat(user, { model: 'grok-build-latest', effort: 'medium' });
    expect(req(fetchMock).body.reasoning_effort).toBe('medium');

    fetchMock = mockFetch(ok());
    await provider(XAI_PROFILE).chat(user, { model: 'grok-4.5-latest', effort: 'none' });
    expect(req(fetchMock).body.reasoning_effort).toBe('low');
    expect(warn).toHaveBeenCalledTimes(2);

    fetchMock = mockFetch(ok());
    await provider(XAI_PROFILE).chat(user, { model: 'grok-4.5', effort: 'max' });
    expect(req(fetchMock).body.reasoning_effort).toBe('high');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('maps exact Grok 4.3 aliases including disabled reasoning', async () => {
    const fetchMock = mockFetch(ok());
    await provider(XAI_PROFILE).chat(user, { model: 'grok-latest', effort: 'none' });
    expect(req(fetchMock).body.reasoning_effort).toBe('none');
  });

  it('bounds xAI high-effort clamp warnings without warning for supported or unknown values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [model, effort] of [
      ['grok-4.3', 'xhigh'],
      ['grok-4.3', 'xhigh'],
      ['grok-4.3', 'max'],
      ['grok-4.5', 'low'],
      ['grok-4.20-future', 'max'],
      ['grok-4.20-multi-agent', 'max'],
    ] as const) {
      const fetchMock = mockFetch(ok());
      await provider(XAI_PROFILE).chat(user, { model, effort });
      if (model === 'grok-4.20-future' || model === 'grok-4.20-multi-agent') {
        expect(req(fetchMock).body).not.toHaveProperty('reasoning_effort');
      }
    }
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('keeps Grok 4.20 behavior exact: reasoning strips params, non-reasoning does not', async () => {
    for (const model of ['grok-4.20', 'grok-4.20-0309-reasoning']) {
      const fetchMock = mockFetch(ok());
      await provider(XAI_PROFILE).chat(user, {
        model,
        effort: 'high',
        stop: ['END'],
        providerOptions: { presence_penalty: 1, frequency_penalty: 1 },
      });
      expect(req(fetchMock).body, model).not.toHaveProperty('stop');
      // Explicit providerOptions always remains last-write-wins.
      expect(req(fetchMock).body.presence_penalty).toBe(1);
      expect(req(fetchMock).body.frequency_penalty).toBe(1);
    }
    const fetchMock = mockFetch(ok());
    await provider(XAI_PROFILE).chat(user, {
      model: 'grok-4.20-non-reasoning',
      effort: 'high',
      stop: ['END'],
    });
    expect(req(fetchMock).body.stop).toEqual(['END']);
    expect(req(fetchMock).body).not.toHaveProperty('reasoning_effort');
  });

  it('does not infer Chat behavior for unknown siblings or Responses-only multi-agent ids', async () => {
    for (const model of [
      'grok-4.20-future',
      'grok-4.20-multi-agent',
      'grok-4.20-multi-agent-0309',
    ]) {
      const fetchMock = mockFetch(ok());
      await provider(XAI_PROFILE).chat(user, { model, effort: 'xhigh', stop: ['END'] });
      expect(req(fetchMock).body, model).not.toHaveProperty('reasoning_effort');
      expect(req(fetchMock).body.stop).toEqual(['END']);
    }
  });

  it('uses the returned tick total exactly once regardless of cache, tier, or tool usage', async () => {
    mockFetch(
      ok({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          cost_in_usd_ticks: 25_000_000,
          prompt_tokens_details: { cached_tokens: 90 },
        },
        service_tier: 'priority',
      }),
    );
    const result = await provider(XAI_PROFILE).chat(user, { model: 'grok-4.5', tools: [] });
    expect(result.cost).toBe(0.0025);
  });
});

// ===========================================================================
// DeepSeek
// ===========================================================================

describe('DeepSeek preset', () => {
  it('captures reasoning_content and round-trips it on tool-call turns', async () => {
    mockFetch(ok({}, { reasoning_content: 'chain' }));
    const r = await provider(DEEPSEEK_PROFILE).chat(user, { model: 'deepseek-reasoner' });
    expect(r.thinking_content).toBe('chain');
    expect(r.providerMetadata).toEqual({
      openaiCompatReasoning: { provider: 'deepseek', field: 'reasoning_content', value: 'chain' },
    });
  });

  it('falls back to json_object (no strict json_schema)', async () => {
    const fetchMock = mockFetch(ok());
    await provider(DEEPSEEK_PROFILE).chat(user, {
      model: 'deepseek-chat',
      responseFormat: { type: 'json_schema', json_schema: { name: 'S', schema: {} } },
    });
    expect(req(fetchMock).body.response_format).toEqual({ type: 'json_object' });
  });

  it('strips temperature for reasoner models but not for chat', async () => {
    let fetchMock = mockFetch(ok());
    await provider(DEEPSEEK_PROFILE).chat(user, {
      model: 'deepseek-reasoner',
      temperature: 0.7,
    });
    expect(req(fetchMock).body).not.toHaveProperty('temperature');

    fetchMock = mockFetch(ok());
    await provider(DEEPSEEK_PROFILE).chat(user, { model: 'deepseek-chat', temperature: 0.7 });
    expect(req(fetchMock).body.temperature).toBe(0.7);
  });

  it('prices exact V4 ids from normalized cache hit/miss usage only', async () => {
    mockFetch(
      ok({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 20,
        },
      }),
    );
    const priced = await provider(DEEPSEEK_PROFILE).chat(user, { model: 'deepseek-v4-flash' });
    expect(priced.usage?.cached_tokens).toBe(80);
    expect(priced.cost).toBeCloseTo(80 * 0.0028e-6 + 20 * 0.14e-6 + 10 * 0.28e-6, 12);

    mockFetch(
      ok({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 19,
        },
      }),
    );
    const malformed = await provider(DEEPSEEK_PROFILE).chat(user, { model: 'deepseek-v4-flash' });
    expect(malformed.cost).toBeUndefined();

    for (const usage of [
      { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_cache_hit_tokens: 80,
      },
    ]) {
      mockFetch(ok({ usage }));
      const missingSplit = await provider(DEEPSEEK_PROFILE).chat(user, {
        model: 'deepseek-v4-flash',
      });
      expect(missingSplit.cost).toBeUndefined();
    }

    const clonedProfile: ProviderProfile = {
      ...DEEPSEEK_PROFILE,
      pricing: { ...DEEPSEEK_PROFILE.pricing },
    };
    mockFetch(ok({ usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
    const clonedMissingSplit = await provider(clonedProfile).chat(user, {
      model: 'deepseek-v4-flash',
    });
    expect(clonedMissingSplit.cost).toBeUndefined();

    mockFetch({
      body: sseStream([
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_cache_hit_tokens":80}}',
        'data: [DONE]',
      ]),
    });
    const streamChunks = [];
    for await (const chunk of provider(DEEPSEEK_PROFILE).stream(user, {
      model: 'deepseek-v4-flash',
    })) {
      streamChunks.push(chunk);
    }
    expect(streamChunks.find((chunk) => chunk.type === 'done')?.cost).toBeUndefined();

    mockFetch(ok());
    const sibling = await provider(DEEPSEEK_PROFILE).chat(user, {
      model: 'deepseek-v4-flash-next',
    });
    expect(sibling.cost).toBeUndefined();
  });
});

// ===========================================================================
// Mistral
// ===========================================================================

describe('Mistral preset', () => {
  it('emits reasoning_effort=high only for the small/medium families', async () => {
    let fetchMock = mockFetch(ok());
    await provider(MISTRAL_PROFILE).chat(user, { model: 'mistral-small-latest', effort: 'low' });
    expect(req(fetchMock).body.reasoning_effort).toBe('high'); // narrow vocab → high

    fetchMock = mockFetch(ok());
    await provider(MISTRAL_PROFILE).chat(user, { model: 'mistral-medium-latest', effort: 'max' });
    expect(req(fetchMock).body.reasoning_effort).toBe('high');
  });

  it('omits reasoning_effort for models that reject it (would 422)', async () => {
    // mistral-large / ministral / pixtral / codestral do not accept the field
    for (const model of ['mistral-large-latest', 'ministral-8b', 'magistral-medium']) {
      const fetchMock = mockFetch(ok());
      await provider(MISTRAL_PROFILE).chat(user, { model, effort: 'high' });
      expect(req(fetchMock).body, model).not.toHaveProperty('reasoning_effort');
    }
  });

  it('omits reasoning_effort when reasoning is disabled', async () => {
    const fetchMock = mockFetch(ok());
    await provider(MISTRAL_PROFILE).chat(user, { model: 'mistral-small-latest', effort: 'none' });
    expect(req(fetchMock).body).not.toHaveProperty('reasoning_effort');
  });

  it('prices only exact source-dated direct Chat rows with a 90% cache discount', async () => {
    mockFetch(
      ok({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      }),
    );
    const priced = await provider(MISTRAL_PROFILE).chat(user, { model: 'mistral-small-latest' });
    expect(priced.cost).toBeCloseTo(20 * 0.15e-6 + 80 * 0.15e-6 * 0.1 + 10 * 0.6e-6, 12);

    mockFetch(ok());
    const sibling = await provider(MISTRAL_PROFILE).chat(user, {
      model: 'mistral-small-latest-next',
    });
    expect(sibling.cost).toBeUndefined();

    mockFetch(ok());
    const euRegional = await provider(MISTRAL_PROFILE, 'k', 'https://api.mistral.ai/v1/eu').chat(
      user,
      { model: 'mistral-small-latest' },
    );
    expect(euRegional.cost).toBeUndefined();

    mockFetch(ok());
    const customEndpoint = await provider(MISTRAL_PROFILE, 'k', 'https://mistral.example/v1').chat(
      user,
      { model: 'mistral-small-latest' },
    );
    expect(customEndpoint.cost).toBeUndefined();

    mockFetch(ok());
    const enterprise = await provider(
      MISTRAL_PROFILE,
      'k',
      'https://api.mistral.ai/v1/enterprise',
    ).chat(user, { model: 'mistral-small-latest' });
    expect(enterprise.cost).toBeUndefined();

    const clonedProfile: ProviderProfile = {
      ...MISTRAL_PROFILE,
      pricing: { ...MISTRAL_PROFILE.pricing },
    };
    mockFetch(ok());
    const clonedCustomBase = await provider(clonedProfile, 'k', 'https://mistral.proxy/v1').chat(
      user,
      { model: 'mistral-small-latest' },
    );
    expect(clonedCustomBase.cost).toBeUndefined();
  });
});

// ===========================================================================
// Groq
// ===========================================================================

describe('Groq preset', () => {
  it('drops messages[].name (Groq 400s on it)', async () => {
    const fetchMock = mockFetch(ok());
    await provider(GROQ_PROFILE).chat([{ role: 'user', content: 'hi', name: 'bob' }], {
      model: 'llama-3.3-70b',
    });
    expect((req(fetchMock).body.messages as any[])[0]).not.toHaveProperty('name');
  });

  it('emits reasoning_effort (low/medium/high) only for gpt-oss', async () => {
    let fetchMock = mockFetch(ok());
    await provider(GROQ_PROFILE).chat(user, { model: 'openai/gpt-oss-120b', effort: 'medium' });
    expect(req(fetchMock).body.reasoning_effort).toBe('medium');

    fetchMock = mockFetch(ok());
    await provider(GROQ_PROFILE).chat(user, { model: 'openai/gpt-oss-120b', effort: 'max' });
    expect(req(fetchMock).body.reasoning_effort).toBe('high'); // clamp
  });

  it('does NOT send low/medium/high to qwen3 or plain models (they 400 on it)', async () => {
    // qwen3 accepts only none|default; llama rejects the field entirely.
    for (const model of ['qwen/qwen3-32b', 'llama-3.3-70b', 'deepseek-r1-distill-llama-70b']) {
      const fetchMock = mockFetch(ok());
      await provider(GROQ_PROFILE).chat(user, { model, effort: 'medium' });
      expect(req(fetchMock).body, model).not.toHaveProperty('reasoning_effort');
    }
  });

  it('prices exact on-demand/Flex rows and leaves ambiguous or Performance tiers unpriced', async () => {
    for (const [requestTier, responseTier, expected] of [
      ['on_demand', undefined, true],
      ['flex', undefined, true],
      ['auto', 'on_demand', true],
      ['performance', undefined, false],
      ['auto', undefined, false],
      ['auto', 'performance', false],
    ] as const) {
      mockFetch(ok(responseTier === undefined ? {} : { service_tier: responseTier }));
      const result = await provider(GROQ_PROFILE).chat(user, {
        model: 'openai/gpt-oss-20b',
        providerOptions: { service_tier: requestTier },
      });
      expect(result.cost !== undefined, `${requestTier}/${responseTier}`).toBe(expected);
    }

    mockFetch(ok());
    const compound = await provider(GROQ_PROFILE).chat(user, { model: 'groq/compound' });
    expect(compound.cost).toBeUndefined();

    mockFetch(ok());
    const sibling = await provider(GROQ_PROFILE).chat(user, { model: 'openai/gpt-oss-20b-next' });
    expect(sibling.cost).toBeUndefined();
  });

  it('prices cached GPT-OSS input but leaves server-side tools and modifiers unpriced', async () => {
    mockFetch(
      ok({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      }),
    );
    const cached = await provider(GROQ_PROFILE).chat(user, { model: 'openai/gpt-oss-20b' });
    expect(cached.cost).toBeCloseTo(20 * 0.075e-6 + 80 * 0.075e-6 * 0.5 + 10 * 0.3e-6, 12);

    for (const providerOptions of [
      { tools: [{ type: 'browser_search' }] },
      { browser_search: {} },
      { code_interpreter: {} },
    ]) {
      mockFetch(ok());
      const unpriced = await provider(GROQ_PROFILE).chat(user, {
        model: 'openai/gpt-oss-20b',
        providerOptions,
      });
      expect(unpriced.cost).toBeUndefined();
    }

    mockFetch(ok());
    const functionTool = await provider(GROQ_PROFILE).chat(user, {
      model: 'openai/gpt-oss-20b',
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', description: 'd', parameters: {} },
        },
      ],
      providerOptions: { tools: [{ type: 'function', function: { name: 'native' } }] },
    });
    expect(functionTool.cost).toBeDefined();

    const clonedProfile: ProviderProfile = {
      ...GROQ_PROFILE,
      pricing: { ...GROQ_PROFILE.pricing },
    };
    mockFetch(ok());
    const clonedServerTool = await provider(clonedProfile).chat(user, {
      model: 'openai/gpt-oss-20b',
      providerOptions: { browser_search: {} },
    });
    expect(clonedServerTool.cost).toBeUndefined();
  });
});

describe('canonical table-pricing endpoints', () => {
  const policies = [
    {
      profile: GROQ_PROFILE,
      model: 'openai/gpt-oss-20b',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    {
      profile: DEEPSEEK_PROFILE,
      model: 'deepseek-v4-flash',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_cache_hit_tokens: 5,
        prompt_cache_miss_tokens: 5,
      },
    },
  ] as const;

  it('keeps custom, env, and proxy base URLs unpriced in final and terminal streams', async () => {
    for (const { profile, model, usage } of policies) {
      for (const [kind, baseUrl] of [
        ['custom', 'https://custom.example/v1'],
        ['env', 'https://env.example/v1'],
        ['proxy', 'https://proxy.example/v1'],
      ] as const) {
        if (kind === 'env') vi.stubEnv(profile.envBaseUrl!, baseUrl);
        mockFetch(ok({ usage }));
        const final = await provider(profile, 'k', kind === 'env' ? undefined : baseUrl).chat(
          user,
          {
            model,
          },
        );
        expect(final.cost, `${profile.name} ${kind} final`).toBeUndefined();

        mockFetch({
          body: sseStream([`data: ${JSON.stringify({ choices: [], usage })}`, 'data: [DONE]']),
        });
        const chunks = [];
        for await (const chunk of provider(
          profile,
          'k',
          kind === 'env' ? undefined : baseUrl,
        ).stream(user, { model })) {
          chunks.push(chunk);
        }
        expect(
          chunks.find((chunk) => chunk.type === 'done')?.cost,
          `${profile.name} ${kind} stream`,
        ).toBeUndefined();
        vi.unstubAllEnvs();
      }
    }
  });
});

// ===========================================================================
// AWS Bedrock
// ===========================================================================

describe('Bedrock preset', () => {
  it('throws if no base URL is provided (region-specific, no default)', () => {
    expect(() => provider(BEDROCK_PROFILE, 'tok')).toThrow(/AWS Bedrock requires a base URL/);
  });

  it('uses bearer auth against the configured region endpoint', async () => {
    const fetchMock = mockFetch(ok());
    await bedrock().chat(user, { model: 'openai.gpt-oss-120b-1:0' });
    const r = req(fetchMock);
    expect(r.url).toBe(`${BEDROCK_BASE}/chat/completions`);
    expect(r.headers.Authorization).toBe('Bearer tok');
  });

  it('emits reasoning_effort for gpt-oss (clamping max→high)', async () => {
    let fetchMock = mockFetch(ok());
    await bedrock().chat(user, { model: 'openai.gpt-oss-120b-1:0', effort: 'medium' });
    expect(req(fetchMock).body.reasoning_effort).toBe('medium');

    fetchMock = mockFetch(ok());
    await bedrock().chat(user, { model: 'openai.gpt-oss-20b-1:0', effort: 'max' });
    expect(req(fetchMock).body.reasoning_effort).toBe('high');
  });

  it('omits reasoning_effort for non-gpt-oss models', async () => {
    const fetchMock = mockFetch(ok());
    await bedrock().chat(user, { model: 'anthropic.claude-sonnet-4-6', effort: 'high' });
    expect(req(fetchMock).body).not.toHaveProperty('reasoning_effort');
  });

  it('reports unknown cost (Bedrock returns no usage.cost)', async () => {
    mockFetch(ok());
    const r = await bedrock().chat(user, { model: 'openai.gpt-oss-120b-1:0' });
    expect(r.cost).toBeUndefined();
  });
});

// ===========================================================================
// Local (Ollama as representative)
// ===========================================================================

describe('Local presets', () => {
  it('constructs with no API key and sends no auth header', async () => {
    const fetchMock = mockFetch(ok());
    const p = new OpenAICompatibleProvider({
      profile: OLLAMA_PROFILE,
      baseUrl: 'http://localhost:11434/v1',
    }); // no apiKey
    await p.chat(user, { model: 'llama3' });
    const r = req(fetchMock);
    expect(r.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(r.headers.Authorization).toBeUndefined();
    expect(r.headers['api-key']).toBeUndefined();
  });

  it('forces cost 0 even when a local model is named like a paid one', async () => {
    mockFetch(ok());
    const r = await new OpenAICompatibleProvider({ profile: OLLAMA_PROFILE }).chat(user, {
      model: 'gpt-4o', // a mischievously-named local model
    });
    expect(r.cost).toBe(0);
  });

  it('uses max_tokens (not max_completion_tokens)', async () => {
    const fetchMock = mockFetch(ok());
    await new OpenAICompatibleProvider({ profile: OLLAMA_PROFILE }).chat(user, {
      model: 'llama3',
      maxTokens: 128,
    });
    const body = req(fetchMock).body;
    expect(body.max_tokens).toBe(128);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('extracts inline <think> tags into thinking_content', async () => {
    mockFetch(ok({}, { content: 'a<think>secret</think>b' }));
    const r = await new OpenAICompatibleProvider({ profile: OLLAMA_PROFILE }).chat(user, {
      model: 'deepseek-r1',
    });
    expect(r.content).toBe('ab');
    expect(r.thinking_content).toBe('secret');
  });
});

// ===========================================================================
// Registry wiring
// ===========================================================================

describe('registry wiring', () => {
  it('registers every built-in preset', () => {
    const reg = new ProviderRegistry();
    for (const profile of BUILTIN_PROFILES) {
      expect(reg.has(profile.name)).toBe(true);
    }
    expect(reg.has('openrouter')).toBe(true);
    expect(reg.has('ollama')).toBe(true);
  });

  it('resolves provider:vendor/model slugs on the first colon only', () => {
    const reg = new ProviderRegistry();
    const { provider: p, model } = reg.resolve('openrouter:anthropic/claude-opus-4.7', {
      providers: { openrouter: { apiKey: 'k' } },
    });
    expect(model).toBe('anthropic/claude-opus-4.7');
    expect(p.name).toBe('openrouter');
  });

  it('preserves a colon WITHIN the model id (Bedrock runtime -1:0 suffix)', () => {
    const reg = new ProviderRegistry();
    const { provider: p, model } = reg.resolve('bedrock:openai.gpt-oss-120b-1:0', {
      providers: {
        bedrock: {
          apiKey: 'tok',
          baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
        },
      },
    });
    expect(model).toBe('openai.gpt-oss-120b-1:0'); // split on the FIRST colon only
    expect(p.name).toBe('bedrock');
  });

  it('does NOT override the native big-3 adapters with presets', () => {
    const reg = new ProviderRegistry();
    const openai = reg.get('openai', { providers: { openai: { apiKey: 'k' } } });
    expect(openai.name).toBe('openai');
    // anthropic/google have their own native adapters (not OpenAI-compatible).
    expect(reg.has('anthropic')).toBe(true);
    expect(reg.has('google')).toBe(true);
  });

  it('lazily constructs a local preset with no key (no throw)', () => {
    const reg = new ProviderRegistry();
    expect(() => reg.get('ollama')).not.toThrow();
  });
});
