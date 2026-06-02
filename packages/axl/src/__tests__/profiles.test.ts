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

function provider(profile: ProviderProfile, apiKey = 'k') {
  return new OpenAICompatibleProvider({ profile, apiKey });
}

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
      openaiCompatReasoning: { field: 'reasoning_details', value: details },
    });
  });
});

// ===========================================================================
// Azure OpenAI
// ===========================================================================

describe('Azure preset', () => {
  it('authenticates with the api-key header (not Bearer)', async () => {
    const fetchMock = mockFetch(ok());
    await provider(AZURE_PROFILE).chat(user, { model: 'my-deployment' });
    expect(req(fetchMock).headers['api-key']).toBe('k');
    expect(req(fetchMock).headers.Authorization).toBeUndefined();
  });

  it('prices when the deployment is named after a known model, undefined otherwise', async () => {
    mockFetch(ok());
    const named = await provider(AZURE_PROFILE).chat(user, { model: 'gpt-4o' });
    expect(named.cost).toBeGreaterThan(0);

    mockFetch(ok());
    const arbitrary = await provider(AZURE_PROFILE).chat(user, { model: 'prod-deploy-7' });
    expect(arbitrary.cost).toBeUndefined();
  });

  it('reuses OpenAI reasoning: system→developer + reasoning_effort on o-series', async () => {
    const fetchMock = mockFetch(ok());
    await provider(AZURE_PROFILE).chat(
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
  it('maps effort to reasoning_effort, clamping max→high', async () => {
    let fetchMock = mockFetch(ok());
    await provider(XAI_PROFILE).chat(user, { model: 'grok-3-mini', effort: 'max' });
    expect(req(fetchMock).body.reasoning_effort).toBe('high');

    fetchMock = mockFetch(ok());
    await provider(XAI_PROFILE).chat(user, { model: 'grok-3-mini', effort: 'low' });
    expect(req(fetchMock).body.reasoning_effort).toBe('low');
  });

  it('strips stop on grok-4 reasoning models but keeps it on chat variants', async () => {
    let fetchMock = mockFetch(ok());
    await provider(XAI_PROFILE).chat(user, { model: 'grok-4', stop: ['END'] });
    expect(req(fetchMock).body).not.toHaveProperty('stop');

    fetchMock = mockFetch(ok());
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
      openaiCompatReasoning: { field: 'reasoning_content', value: 'chain' },
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
  it('maps any active effort to high (narrow vocabulary)', async () => {
    let fetchMock = mockFetch(ok());
    await provider(MISTRAL_PROFILE).chat(user, { model: 'magistral-medium', effort: 'low' });
    // magistral rejects reasoning_effort entirely
    expect(req(fetchMock).body).not.toHaveProperty('reasoning_effort');

    fetchMock = mockFetch(ok());
    await provider(MISTRAL_PROFILE).chat(user, { model: 'mistral-large', effort: 'low' });
    expect(req(fetchMock).body.reasoning_effort).toBe('high');

    fetchMock = mockFetch(ok());
    await provider(MISTRAL_PROFILE).chat(user, { model: 'mistral-large', effort: 'none' });
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

  it('emits reasoning_effort only for reasoning families', async () => {
    let fetchMock = mockFetch(ok());
    await provider(GROQ_PROFILE).chat(user, { model: 'openai/gpt-oss-120b', effort: 'medium' });
    expect(req(fetchMock).body.reasoning_effort).toBe('medium');

    fetchMock = mockFetch(ok());
    await provider(GROQ_PROFILE).chat(user, { model: 'llama-3.3-70b', effort: 'medium' });
    expect(req(fetchMock).body).not.toHaveProperty('reasoning_effort');
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
