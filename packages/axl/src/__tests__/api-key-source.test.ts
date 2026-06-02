import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveApiKey } from '../providers/types.js';
import { OpenAIProvider } from '../providers/openai.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { OLLAMA_PROFILE } from '../providers/profiles/local.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import type { ChatMessage } from '../providers/types.js';

const originalFetch = globalThis.fetch;

function mockFetch(
  json: unknown = {
    choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve(json),
    text: () => Promise.resolve(''),
    body: undefined,
  });
  globalThis.fetch = fn as any;
  return fn;
}

function headersOf(fetchMock: ReturnType<typeof mockFetch>): Record<string, string> {
  return fetchMock.mock.calls[0][1].headers as Record<string, string>;
}

const msg: ChatMessage[] = [{ role: 'user', content: 'hi' }];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ===========================================================================
// resolveApiKey helper
// ===========================================================================

describe('resolveApiKey', () => {
  it('resolves a string, a sync function, an async function, and undefined', async () => {
    expect(await resolveApiKey('sk')).toBe('sk');
    expect(await resolveApiKey(() => 'sync')).toBe('sync');
    expect(await resolveApiKey(async () => 'async')).toBe('async');
    expect(await resolveApiKey(undefined)).toBe('');
  });
});

// ===========================================================================
// Engine (OpenAIProvider / OpenAICompatibleProvider)
// ===========================================================================

describe('async apiKey — engine', () => {
  it('resolves a function key per request and injects it (Bearer)', async () => {
    const fetchMock = mockFetch();
    await new OpenAIProvider({ apiKey: () => 'sk-fn' }).chat(msg, { model: 'gpt-4o' });
    expect(headersOf(fetchMock).Authorization).toBe('Bearer sk-fn');
  });

  it('awaits an async function key', async () => {
    const fetchMock = mockFetch();
    await new OpenAIProvider({ apiKey: async () => 'sk-async' }).chat(msg, { model: 'gpt-4o' });
    expect(headersOf(fetchMock).Authorization).toBe('Bearer sk-async');
  });

  it('invokes the callback ONCE PER REQUEST with a fresh value (no memoization)', async () => {
    let n = 0;
    const key = vi.fn(() => `tok-${++n}`);
    const provider = new OpenAIProvider({ apiKey: key });

    let fetchMock = mockFetch();
    await provider.chat(msg, { model: 'gpt-4o' });
    expect(headersOf(fetchMock).Authorization).toBe('Bearer tok-1');

    fetchMock = mockFetch();
    await provider.chat(msg, { model: 'gpt-4o' });
    expect(headersOf(fetchMock).Authorization).toBe('Bearer tok-2'); // refreshed, not cached
    expect(key).toHaveBeenCalledTimes(2);
  });

  it('does NOT throw at construction for a function source (deferred validation)', () => {
    // Even a function that WOULD resolve empty must not throw eagerly.
    expect(() => new OpenAIProvider({ apiKey: () => '' })).not.toThrow();
  });

  it('throws per-request when the function resolves empty (no allowMissingApiKey)', async () => {
    mockFetch();
    await expect(
      new OpenAIProvider({ apiKey: () => '' }).chat(msg, { model: 'gpt-4o' }),
    ).rejects.toThrow('OpenAI API key is required');
  });

  it('still throws EAGERLY for an empty string key', () => {
    expect(() => new OpenAIProvider({ apiKey: '' })).toThrow('OpenAI API key is required');
  });

  it('allowMissingApiKey: a function resolving empty sends NO auth header (local)', async () => {
    const fetchMock = mockFetch();
    const ollama = new OpenAICompatibleProvider({ profile: OLLAMA_PROFILE, apiKey: () => '' });
    await ollama.chat(msg, { model: 'llama3' });
    const h = headersOf(fetchMock);
    expect(h.Authorization).toBeUndefined();
  });

  it('propagates a rejecting callback as the call rejection (no unhandled rejection)', async () => {
    mockFetch();
    await expect(
      new OpenAIProvider({
        apiKey: async () => {
          throw new Error('token service down');
        },
      }).chat(msg, { model: 'gpt-4o' }),
    ).rejects.toThrow('token service down');
  });
});

// ===========================================================================
// Native adapters — each injects the resolved key via its own mechanism
// ===========================================================================

describe('async apiKey — native adapters', () => {
  it('Anthropic injects the resolved key via x-api-key', async () => {
    const fetchMock = mockFetch({ content: [{ type: 'text', text: 'ok' }], usage: {} });
    await new AnthropicProvider({ apiKey: () => 'ak-fn' })
      .chat(msg, { model: 'claude-opus-4-8' })
      .catch(() => {});
    expect(headersOf(fetchMock)['x-api-key']).toBe('ak-fn');
  });

  it('Gemini injects the resolved key via x-goog-api-key', async () => {
    const fetchMock = mockFetch({ candidates: [] });
    await new GeminiProvider({ apiKey: () => 'gk-fn' })
      .chat(msg, { model: 'gemini-2.5-flash' })
      .catch(() => {});
    expect(headersOf(fetchMock)['x-goog-api-key']).toBe('gk-fn');
  });

  it('openai-responses injects the resolved key on BOTH chat AND stream (no streaming-only auth bug)', async () => {
    // chat
    let fetchMock = mockFetch({ output: [], usage: {} });
    await new OpenAIResponsesProvider({ apiKey: () => 'or-fn' })
      .chat(msg, { model: 'gpt-5.5' })
      .catch(() => {});
    expect(headersOf(fetchMock).Authorization).toBe('Bearer or-fn');

    // stream — the site MF-10 warned could be missed
    fetchMock = mockFetch();
    const gen = new OpenAIResponsesProvider({ apiKey: () => 'or-fn' }).stream(msg, {
      model: 'gpt-5.5',
    });
    await gen.next().catch(() => {});
    expect(headersOf(fetchMock).Authorization).toBe('Bearer or-fn');
  });

  it('native adapters throw per-request when a function resolves empty', async () => {
    mockFetch();
    await expect(
      new AnthropicProvider({ apiKey: () => '' }).chat(msg, { model: 'claude-opus-4-8' }),
    ).rejects.toThrow('Anthropic API key is required');
    mockFetch();
    await expect(
      new GeminiProvider({ apiKey: () => '' }).chat(msg, { model: 'gemini-2.5-flash' }),
    ).rejects.toThrow('Google API key is required');
  });

  it('native adapters do NOT throw at construction for a function source', () => {
    expect(() => new AnthropicProvider({ apiKey: () => '' })).not.toThrow();
    expect(() => new GeminiProvider({ apiKey: () => '' })).not.toThrow();
    expect(() => new OpenAIResponsesProvider({ apiKey: () => '' })).not.toThrow();
  });
});
