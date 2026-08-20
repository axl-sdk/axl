import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxlError } from '../errors.js';
import { OpenAIEmbedder } from '../memory/embedder-openai.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAICompatibleProvider, type ProviderProfile } from '../providers/openai-compatible.js';
import { OpenAIProvider } from '../providers/openai.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { ProviderRegistry } from '../providers/registry.js';
import { assertSafeProviderBaseUrl } from '../providers/transport.js';
import type { AxlConfig } from '../config.js';

const TEST_PROFILE: ProviderProfile = {
  name: 'test-compatible',
  defaultBaseUrl: 'https://api.test.example/v1',
  pricing: { kind: 'unknown' },
  reasoning: { emit: () => {}, capture: 'none' },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function expectUnsafe(operation: () => unknown): void {
  try {
    operation();
    throw new Error('expected unsafe transport rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(AxlError);
    expect((error as AxlError).code).toBe('UNSAFE_TRANSPORT');
    expect((error as Error).message).not.toContain('user:secret');
    expect((error as Error).message).not.toContain('sensitive-query');
  }
}

describe('built-in provider transport policy', () => {
  it.each([
    'https://192.168.1.20/v1',
    'https://api.example.test/v1',
    'http://LOCALHOST:11434/v1',
    'http://localhost.:11434/v1',
    'http://127.42.99.3:11434/v1',
    'http://[::1]:11434/v1',
    // WHATWG parsing proves that these are literal 127/8 addresses before
    // the policy classifies them. They do not involve DNS resolution.
    'http://2130706433:11434/v1',
    'http://0x7f000001:11434/v1',
  ])('permits secure or parsed loopback endpoint %s', (baseUrl) => {
    expect(() => assertSafeProviderBaseUrl(baseUrl, 'Test provider')).not.toThrow();
  });

  it.each([
    'http://localhost.evil.test/v1',
    'http://evil.localhost/v1',
    'http://192.168.1.20/v1',
    'http://203.0.113.10/v1',
    'http://ollama:11434/v1',
    'http://host.docker.internal:11434/v1',
    'http://0.0.0.0:11434/v1',
    'http://127.0.0.999:11434/v1',
    'http://127.999.999.999:11434/v1',
    'http://[::ffff:127.0.0.1]:11434/v1',
    'http://0:11434/v1',
    'relative/path',
    'http://',
    'ftp://example.test/v1',
    'file:///tmp/provider',
  ])('rejects endpoint %s without an explicit insecure override', (baseUrl) => {
    expectUnsafe(() => assertSafeProviderBaseUrl(baseUrl, 'Test provider'));
  });

  it('permits only otherwise-valid HTTP when its own endpoint explicitly opts in', () => {
    expect(() =>
      assertSafeProviderBaseUrl('http://ollama:11434/v1', 'Test provider', true),
    ).not.toThrow();
    expectUnsafe(() => assertSafeProviderBaseUrl('ftp://example.test/v1', 'Test provider', true));
  });

  it('does not expose credentials or query values in unsafe transport errors', () => {
    expectUnsafe(() =>
      assertSafeProviderBaseUrl(
        'http://user:secret@remote.example/v1?sensitive-query=yes',
        'Test provider',
      ),
    );
  });

  it.each([
    ['OpenAI', () => new OpenAIProvider({ apiKey: 'k', baseUrl: 'http://remote.test/v1' })],
    [
      'OpenAI-compatible',
      () =>
        new OpenAICompatibleProvider({
          profile: TEST_PROFILE,
          apiKey: 'k',
          baseUrl: 'http://remote.test/v1',
        }),
    ],
    [
      'OpenAI Responses',
      () => new OpenAIResponsesProvider({ apiKey: 'k', baseUrl: 'http://remote.test/v1' }),
    ],
    ['Anthropic', () => new AnthropicProvider({ apiKey: 'k', baseUrl: 'http://remote.test/v1' })],
    ['Google', () => new GeminiProvider({ apiKey: 'k', baseUrl: 'http://remote.test/v1' })],
    [
      'OpenAI embedder',
      () => new OpenAIEmbedder({ apiKey: 'k', baseUrl: 'http://remote.test/v1' }),
    ],
  ])('%s rejects remote HTTP at direct construction', (_name, construct) => {
    expectUnsafe(construct);
  });

  it('permits an insecure endpoint only for the direct provider that opts in', () => {
    expect(
      () =>
        new OpenAIProvider({
          apiKey: 'k',
          baseUrl: 'http://remote.test/v1',
          dangerouslyAllowInsecureHttp: true,
        }),
    ).not.toThrow();
    expectUnsafe(() => new AnthropicProvider({ apiKey: 'k', baseUrl: 'http://remote.test/v1' }));
  });

  it('validates a direct provider before invoking a lazy API-key source or fetch', () => {
    const apiKey = vi.fn(() => 'k');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expectUnsafe(() => new OpenAIProvider({ apiKey, baseUrl: 'http://remote.test/v1' }));
    expect(apiKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('validates an environment-provided base URL before a request', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'http://remote.test/v1');
    expectUnsafe(() => new OpenAIProvider({ apiKey: 'k' }));
  });

  it('surfaces a redirect response as one non-retryable provider error', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response('moved', { status: 302, headers: { Location: '/other' } }));
    vi.stubGlobal('fetch', fetchSpy);
    const provider = new OpenAIProvider({ apiKey: 'k' });

    await expect(
      provider.chat([{ role: 'user', content: 'hello' }], { model: 'gpt-4o' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', status: 302, retryable: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('registry transport policy', () => {
  it('keeps invalid unused configuration lazy and rejects before a key callback or fetch', () => {
    const apiKey = vi.fn(() => 'k');
    const insecureOpenAIConfig: AxlConfig = {
      providers: {
        openai: { apiKey, baseUrl: 'http://remote.test/v1' },
        anthropic: { apiKey: 'k' },
      },
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const registry = new ProviderRegistry();

    expect(() => registry.get('anthropic', insecureOpenAIConfig)).not.toThrow();
    expect(apiKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    expectUnsafe(() => registry.get('openai', insecureOpenAIConfig));
    expect(apiKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards the dangerous override only through the resolved provider block', () => {
    const registry = new ProviderRegistry();
    const config: AxlConfig = {
      providers: {
        openai: {
          apiKey: 'k',
          baseUrl: 'http://remote.test/v1',
          dangerouslyAllowInsecureHttp: true,
        },
        anthropic: { apiKey: 'k', baseUrl: 'http://remote.test/v1' },
      },
    };

    expect(() => registry.get('openai', config)).not.toThrow();
    expectUnsafe(() => registry.get('anthropic', config));
  });

  it('inherits OpenAI transport configuration only when the Responses block is absent', () => {
    const fallback = new ProviderRegistry();
    const fallbackConfig: AxlConfig = {
      providers: {
        openai: {
          apiKey: 'k',
          baseUrl: 'http://remote.test/v1',
          dangerouslyAllowInsecureHttp: true,
        },
      },
    };
    expect(() => fallback.get('openai-responses', fallbackConfig)).not.toThrow();

    const explicit = new ProviderRegistry();
    const explicitConfig: AxlConfig = {
      providers: {
        openai: {
          apiKey: 'k',
          baseUrl: 'http://remote.test/v1',
          dangerouslyAllowInsecureHttp: true,
        },
        'openai-responses': { apiKey: 'k', baseUrl: 'http://remote.test/v1' },
      },
    };
    expectUnsafe(() => explicit.get('openai-responses', explicitConfig));
  });
});
