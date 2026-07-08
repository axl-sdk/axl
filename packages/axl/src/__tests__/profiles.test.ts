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
    expect(req(fetchMock).body.usage).toEqual({ include: true });
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
    expect(() => provider(AZURE_PROFILE)).toThrow(/Azure OpenAI requires a base URL/);
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

  it('prices when the deployment is named after a known model, undefined otherwise', async () => {
    mockFetch(ok());
    const named = await azure().chat(user, { model: 'gpt-4o' });
    expect(named.cost).toBeGreaterThan(0);

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
  it('emits reasoning_effort for grok-3-mini (low|high), clamping the rest to high', async () => {
    let fetchMock = mockFetch(ok());
    await provider(XAI_PROFILE).chat(user, { model: 'grok-3-mini', effort: 'max' });
    expect(req(fetchMock).body.reasoning_effort).toBe('high');

    fetchMock = mockFetch(ok());
    await provider(XAI_PROFILE).chat(user, { model: 'grok-3-mini', effort: 'medium' });
    expect(req(fetchMock).body.reasoning_effort).toBe('high'); // grok-3-mini has no 'medium'

    fetchMock = mockFetch(ok());
    await provider(XAI_PROFILE).chat(user, { model: 'grok-3-mini', effort: 'low' });
    expect(req(fetchMock).body.reasoning_effort).toBe('low');
  });

  it('does NOT send reasoning_effort to grok-4 (auto-reasons, would 400)', async () => {
    const fetchMock = mockFetch(ok());
    await provider(XAI_PROFILE).chat(user, { model: 'grok-4', effort: 'high' });
    expect(req(fetchMock).body).not.toHaveProperty('reasoning_effort');
  });

  it('strips stop on reasoning models (grok-3-mini, grok-4) but keeps it on chat variants', async () => {
    for (const model of ['grok-4', 'grok-3-mini']) {
      const fetchMock = mockFetch(ok());
      await provider(XAI_PROFILE).chat(user, { model, stop: ['END'] });
      expect(req(fetchMock).body, model).not.toHaveProperty('stop');
    }
    const fetchMock = mockFetch(ok());
    await provider(XAI_PROFILE).chat(user, { model: 'grok-3', stop: ['END'] });
    expect(req(fetchMock).body.stop).toEqual(['END']);
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
    const p = new OpenAICompatibleProvider({ profile: OLLAMA_PROFILE }); // no apiKey
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
