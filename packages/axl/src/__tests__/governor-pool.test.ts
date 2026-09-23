import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { AxlRuntime } from '../runtime.js';
import { ProviderRegistry } from '../providers/registry.js';
import { OpenAIProvider } from '../providers/openai.js';
import { RateLimiter } from '../providers/rate-limiter.js';
import { ScopeGovernor } from '../providers/governor-pool.js';
import type { AxlConfig } from '../config.js';
import type { ChatMessage, Provider, ProviderResponse } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Phase 2 of adaptive rate governance: rate governors are pooled per runtime,
// one per scope = provider family + base-URL origin + credential source +
// model (AC10–AC15, E1, E2).
//
// Every case runs REAL adapters against a stubbed `globalThis.fetch` whose
// responses stay pending until the test releases them, so "in flight" is
// measured at the transport, not inferred. This file imports only modules that
// predate the pool, so it also runs against the pre-change tree (AC10 must
// fail there).
// ---------------------------------------------------------------------------

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

const OPENAI_CHAT_JSON = {
  choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const RESPONSES_JSON = {
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};
const ANTHROPIC_JSON = {
  content: [{ type: 'text', text: 'hello' }],
  usage: { input_tokens: 1, output_tokens: 1 },
};
const GEMINI_JSON = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
};

function jsonFor(url: string): unknown {
  if (url.endsWith('/chat/completions')) return OPENAI_CHAT_JSON;
  if (url.endsWith('/responses')) return RESPONSES_JSON;
  if (url.endsWith('/messages')) return ANTHROPIC_JSON;
  if (url.includes(':generateContent')) return GEMINI_JSON;
  if (url.endsWith('/interactions')) return {};
  throw new Error(`unexpected URL in fetch stub: ${url}`);
}

type Dispatch = {
  url: string;
  /** The `Authorization` / `x-api-key` / `x-goog-api-key` header, whichever is set. */
  credential: string | undefined;
  at: number;
  release: () => void;
  released: boolean;
};

/**
 * `fetch` stub: every request stays pending until released. Tracks the
 * in-flight count and its peak at the transport.
 */
function stubFetch() {
  const dispatches: Dispatch[] = [];
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = vi.fn((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    inFlight++;
    peak = Math.max(peak, inFlight);
    return new Promise<Response>((resolve) => {
      const d: Dispatch = {
        url,
        credential:
          headers.get('authorization') ??
          headers.get('x-api-key') ??
          headers.get('x-goog-api-key') ??
          undefined,
        at: Date.now(),
        released: false,
        release: () => {
          if (d.released) return;
          d.released = true;
          inFlight--;
          resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => jsonFor(url),
            text: async () => '',
          } as unknown as Response);
        },
      };
      dispatches.push(d);
    });
  }) as unknown as typeof fetch;
  return {
    dispatches,
    get inFlight() {
      return inFlight;
    },
    get peak() {
      return peak;
    },
    releaseAll() {
      for (const d of dispatches) d.release();
    },
  };
}

// A real `setImmediate` captured before any fake timers, so settling never
// depends on the fake clock.
const realSetImmediate = globalThis.setImmediate;
/** Let every pending promise chain run (resolveKey → governor → fetch). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => realSetImmediate(r));
}

function chat(provider: Provider, model: string): Promise<ProviderResponse> {
  return provider.chat(messages, { model });
}

function resolveVia(runtime: AxlRuntime, uri: string): { provider: Provider; model: string } {
  return runtime.resolveProvider(uri);
}

const originalFetch = globalThis.fetch;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const mergeWarnings = () =>
  warn.mock.calls.map((c) => String(c[0])).filter((t) => t.includes('rate-limit scope'));

// ---------------------------------------------------------------------------
// AC10 — one shared `openai` block governs both OpenAI adapters as ONE scope.
// ---------------------------------------------------------------------------

describe('AC10: openai + openai-responses share one governor per model', () => {
  it('four calls split 2+2 across the two adapters have at most 2 in flight (today: 4)', async () => {
    const net = stubFetch();
    const runtime = new AxlRuntime({
      providers: { openai: { apiKey: 'k', rateLimit: { maxConcurrent: 2 } } },
    });
    const chatCompletions = resolveVia(runtime, 'openai:gpt-4o');
    const responses = resolveVia(runtime, 'openai-responses:gpt-4o');

    const calls = [
      chat(chatCompletions.provider, 'gpt-4o'),
      chat(responses.provider, 'gpt-4o'),
      chat(chatCompletions.provider, 'gpt-4o'),
      chat(responses.provider, 'gpt-4o'),
    ];
    await settle();
    expect(net.inFlight).toBe(2);

    // The queued pair dispatches only as permits free up, never above the cap.
    net.dispatches[0].release();
    await settle();
    expect(net.dispatches).toHaveLength(3);
    expect(net.inFlight).toBe(2);
    net.releaseAll();
    await settle();
    net.releaseAll();
    await Promise.all(calls);

    expect(net.dispatches).toHaveLength(4);
    expect(net.peak).toBe(2);
    // Both adapters really were exercised.
    expect(net.dispatches.filter((d) => d.url.endsWith('/chat/completions'))).toHaveLength(2);
    expect(net.dispatches.filter((d) => d.url.endsWith('/responses'))).toHaveLength(2);
  });

  it('three calls (gpt-4o via both adapters): the third is not sent until one lands', async () => {
    const net = stubFetch();
    const runtime = new AxlRuntime({
      providers: { openai: { apiKey: 'k', rateLimit: { maxConcurrent: 2 } } },
    });
    const calls = [
      chat(resolveVia(runtime, 'openai:gpt-4o').provider, 'gpt-4o'),
      chat(resolveVia(runtime, 'openai-responses:gpt-4o').provider, 'gpt-4o'),
      chat(resolveVia(runtime, 'openai:gpt-4o').provider, 'gpt-4o'),
    ];
    await settle();
    expect(net.dispatches).toHaveLength(2);
    net.dispatches[1].release();
    await settle();
    expect(net.dispatches).toHaveLength(3);
    net.releaseAll();
    await Promise.all(calls);
    expect(net.peak).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC11 — the model is part of the scope.
// ---------------------------------------------------------------------------

describe('AC11: different models on one provider get independent governors', () => {
  it('maxConcurrent 1: two models run concurrently; two calls on one model serialize', async () => {
    const net = stubFetch();
    const registry = new ProviderRegistry();
    const config: AxlConfig = {
      providers: { openai: { apiKey: 'k', rateLimit: { maxConcurrent: 1 } } },
    };
    const { provider } = registry.resolve('openai:gpt-4o', config);

    const crossModel = [chat(provider, 'gpt-4o'), chat(provider, 'gpt-4o-mini')];
    await settle();
    expect(net.inFlight).toBe(2);
    net.releaseAll();
    await Promise.all(crossModel);

    const sameModel = [chat(provider, 'gpt-4o'), chat(provider, 'gpt-4o')];
    await settle();
    expect(net.inFlight).toBe(1);
    net.releaseAll();
    await settle();
    expect(net.inFlight).toBe(1);
    net.releaseAll();
    await Promise.all(sameModel);
  });

  it('the scope model is the effective wire model (providerOptions.model override)', async () => {
    const net = stubFetch();
    const registry = new ProviderRegistry();
    const config: AxlConfig = {
      providers: { openai: { apiKey: 'k', rateLimit: { maxConcurrent: 1 } } },
    };
    const { provider } = registry.resolve('openai:gpt-4o', config);
    // Both requests go out as gpt-4o-mini, so they share gpt-4o-mini's governor
    // even though the first is nominally a gpt-4o call.
    const calls = [
      provider.chat(messages, { model: 'gpt-4o', providerOptions: { model: 'gpt-4o-mini' } }),
      chat(provider, 'gpt-4o-mini'),
    ];
    await settle();
    expect(net.inFlight).toBe(1);
    net.releaseAll();
    await settle();
    net.releaseAll();
    await Promise.all(calls);
    expect(net.peak).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Every chat fetch site resolves its governor per call from the effective model:
// openai-compatible, anthropic and openai-responses chat + stream, and Gemini's
// generateContent + Interactions, each chat + stream (10 sites).
// ---------------------------------------------------------------------------

const imageMessages: ChatMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AQID' } },
    ],
  },
];

type Site = {
  site: string;
  provider: string;
  models: [string, string];
  mode: 'chat' | 'stream';
  input: ChatMessage[];
  path: string;
};

const SITES: Site[] = [
  ...(['chat', 'stream'] as const).flatMap((mode): Site[] => [
    {
      site: `openai-compatible ${mode}`,
      provider: 'groq',
      models: ['llama-3.3-70b', 'llama-3.1-8b'],
      mode,
      input: messages,
      path: '/chat/completions',
    },
    {
      site: `anthropic ${mode}`,
      provider: 'anthropic',
      models: ['claude-sonnet-4', 'claude-haiku-4-5'],
      mode,
      input: messages,
      path: '/messages',
    },
    {
      site: `openai-responses ${mode}`,
      provider: 'openai-responses',
      models: ['gpt-4o', 'gpt-4o-mini'],
      mode,
      input: messages,
      path: '/responses',
    },
    {
      site: `gemini generateContent ${mode}`,
      provider: 'google',
      models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
      mode,
      input: messages,
      path: 'Content',
    },
    {
      site: `gemini interactions ${mode}`,
      provider: 'google',
      models: ['gemini-3.8-flash', 'gemini-3.8-pro'],
      mode,
      input: imageMessages,
      path: '/interactions',
    },
  ]),
];

/** Start one call at `site`; the stub's responses carry no stream body, so the outcome is ignored. */
function callSite(provider: Provider, site: Site, model: string): Promise<unknown> {
  const run =
    site.mode === 'chat'
      ? provider.chat(site.input, { model })
      : (async () => {
          for await (const chunk of provider.stream(site.input, { model })) void chunk;
        })();
  return run.catch(() => undefined);
}

describe('each chat fetch site governs per effective model', () => {
  it.each(SITES.map((s) => [s.site, s] as const))('%s', async (_name, site) => {
    const net = stubFetch();
    const registry = new ProviderRegistry();
    const config: AxlConfig = {
      providers: { [site.provider]: { apiKey: 'k', rateLimit: { maxConcurrent: 1 } } },
    };
    const { provider } = registry.resolve(`${site.provider}:${site.models[0]}`, config);

    const sameModel = [
      callSite(provider, site, site.models[0]),
      callSite(provider, site, site.models[0]),
    ];
    await settle();
    expect(net.inFlight).toBe(1);
    expect(net.dispatches[0].url).toContain(site.path);
    net.releaseAll();
    await settle();
    expect(net.dispatches).toHaveLength(2);
    net.releaseAll();
    await Promise.all(sameModel);

    const crossModel = [
      callSite(provider, site, site.models[0]),
      callSite(provider, site, site.models[1]),
    ];
    await settle();
    expect(net.inFlight).toBe(2);
    net.releaseAll();
    await Promise.all(crossModel);
  });
});

// ---------------------------------------------------------------------------
// AC12 / E2 / RQ2 — tenants and runtimes never share by inference.
// ---------------------------------------------------------------------------

describe('AC12: credentials, origins and runtimes separate scopes', () => {
  const capped = (apiKey: string): AxlConfig => ({
    providers: { openai: { apiKey, rateLimit: { maxConcurrent: 1 } } },
  });

  it('two runtimes with different keys on one model are independent', async () => {
    const net = stubFetch();
    const a = resolveVia(new AxlRuntime(capped('key-tenant-a')), 'openai:gpt-4o');
    const b = resolveVia(new AxlRuntime(capped('key-tenant-b')), 'openai:gpt-4o');
    const calls = [chat(a.provider, 'gpt-4o'), chat(b.provider, 'gpt-4o')];
    await settle();
    expect(net.inFlight).toBe(2);
    expect(net.dispatches.map((d) => d.credential).sort()).toEqual([
      'Bearer key-tenant-a',
      'Bearer key-tenant-b',
    ]);
    net.releaseAll();
    await Promise.all(calls);
  });

  it('two runtimes with the SAME key but separately built adapters are independent', async () => {
    const net = stubFetch();
    const a = resolveVia(new AxlRuntime(capped('same-key')), 'openai:gpt-4o');
    const b = resolveVia(new AxlRuntime(capped('same-key')), 'openai:gpt-4o');
    const calls = [chat(a.provider, 'gpt-4o'), chat(b.provider, 'gpt-4o')];
    await settle();
    expect(net.inFlight).toBe(2);
    net.releaseAll();
    await Promise.all(calls);
  });

  it('within one runtime, openai-responses with its own key is a separate scope', async () => {
    const net = stubFetch();
    const runtime = new AxlRuntime({
      providers: {
        openai: { apiKey: 'key-one', rateLimit: { maxConcurrent: 1 } },
        'openai-responses': { apiKey: 'key-two', rateLimit: { maxConcurrent: 1 } },
      },
    });
    const calls = [
      chat(resolveVia(runtime, 'openai:gpt-4o').provider, 'gpt-4o'),
      chat(resolveVia(runtime, 'openai-responses:gpt-4o').provider, 'gpt-4o'),
    ];
    await settle();
    expect(net.inFlight).toBe(2);
    net.releaseAll();
    await Promise.all(calls);
    expect(mergeWarnings()).toEqual([]);
  });

  it('within one runtime, the same key at a different origin is a separate scope', async () => {
    const net = stubFetch();
    const runtime = new AxlRuntime({
      providers: {
        openai: { apiKey: 'k', rateLimit: { maxConcurrent: 1 } },
        'openai-responses': {
          apiKey: 'k',
          baseUrl: 'https://proxy.example.com/v1',
          rateLimit: { maxConcurrent: 1 },
        },
      },
    });
    const calls = [
      chat(resolveVia(runtime, 'openai:gpt-4o').provider, 'gpt-4o'),
      chat(resolveVia(runtime, 'openai-responses:gpt-4o').provider, 'gpt-4o'),
    ];
    await settle();
    expect(net.inFlight).toBe(2);
    net.releaseAll();
    await Promise.all(calls);
  });

  it('the origin is normalized: default port and trailing slash do not split a scope', async () => {
    const net = stubFetch();
    const runtime = new AxlRuntime({
      providers: {
        openai: {
          apiKey: 'k',
          baseUrl: 'https://api.openai.com:443/v1/',
          rateLimit: { maxConcurrent: 1 },
        },
        'openai-responses': {
          apiKey: 'k',
          baseUrl: 'https://API.openai.com/v1',
          rateLimit: { maxConcurrent: 1 },
        },
      },
    });
    const calls = [
      chat(resolveVia(runtime, 'openai:gpt-4o').provider, 'gpt-4o'),
      chat(resolveVia(runtime, 'openai-responses:gpt-4o').provider, 'gpt-4o'),
    ];
    await settle();
    // One scope: the explicit :443 and the host's case are the same origin.
    expect(net.inFlight).toBe(1);
    net.releaseAll();
    await settle();
    expect(net.inFlight).toBe(1);
    net.releaseAll();
    await Promise.all(calls);
    expect(net.peak).toBe(1);
    expect(mergeWarnings()).toEqual([]);
  });

  it('the family is part of the scope: openai and a preset on one key and origin stay separate', async () => {
    const net = stubFetch();
    const proxy = 'https://proxy.example.com/v1';
    const runtime = new AxlRuntime({
      providers: {
        openai: { apiKey: 'k', baseUrl: proxy, rateLimit: { maxConcurrent: 1 } },
        groq: { apiKey: 'k', baseUrl: proxy, rateLimit: { maxConcurrent: 1 } },
      },
    });
    const calls = [
      chat(resolveVia(runtime, 'openai:shared-model').provider, 'shared-model'),
      chat(resolveVia(runtime, 'groq:shared-model').provider, 'shared-model'),
    ];
    await settle();
    expect(net.inFlight).toBe(2);
    expect(net.dispatches.every((d) => d.url.startsWith(proxy))).toBe(true);
    net.releaseAll();
    await Promise.all(calls);
  });
});

// ---------------------------------------------------------------------------
// AC13 / E1 — a rotating key callback is one scope, by identity.
// ---------------------------------------------------------------------------

describe('AC13: a rotating apiKey callback is exactly one scope', () => {
  it('three distinct resolved keys from one callback serialize under maxConcurrent 1, across both OpenAI adapters', async () => {
    const net = stubFetch();
    let n = 0;
    const rotating = () => `rot-${++n}`;
    const runtime = new AxlRuntime({
      providers: { openai: { apiKey: rotating, rateLimit: { maxConcurrent: 1 } } },
    });
    const completions = resolveVia(runtime, 'openai:gpt-4o').provider;
    const responses = resolveVia(runtime, 'openai-responses:gpt-4o').provider;
    const calls = [
      chat(completions, 'gpt-4o'),
      chat(responses, 'gpt-4o'),
      chat(completions, 'gpt-4o'),
    ];
    for (let i = 0; i < 3; i++) {
      await settle();
      expect(net.inFlight).toBe(1);
      net.releaseAll();
    }
    await Promise.all(calls);
    expect(net.peak).toBe(1);
    // The callback really rotated: three different keys went out on the wire.
    expect(new Set(net.dispatches.map((d) => d.credential)).size).toBe(3);
    for (const call of warn.mock.calls) expect(call.map(String).join(' ')).not.toContain('rot-');
  });

  it('a different callback on another block is a separate scope', async () => {
    const net = stubFetch();
    const runtime = new AxlRuntime({
      providers: {
        openai: { apiKey: () => 'rot-a', rateLimit: { maxConcurrent: 1 } },
        'openai-responses': { apiKey: () => 'rot-a', rateLimit: { maxConcurrent: 1 } },
      },
    });
    const calls = [
      chat(resolveVia(runtime, 'openai:gpt-4o').provider, 'gpt-4o'),
      chat(resolveVia(runtime, 'openai-responses:gpt-4o').provider, 'gpt-4o'),
    ];
    await settle();
    // Same resolved string, different callback identity: two scopes.
    expect(net.inFlight).toBe(2);
    net.releaseAll();
    await Promise.all(calls);
  });
});

// ---------------------------------------------------------------------------
// AC14 (guard) — explicit sharing: one instance in two runtimes.
// ---------------------------------------------------------------------------

describe('AC14: one provider instance registered in two runtimes shares its governor', () => {
  it('maxConcurrent 1 holds across both runtimes', async () => {
    const net = stubFetch();
    const shared = new OpenAIProvider({ apiKey: 'k', rateLimit: { maxConcurrent: 1 } });
    const runtimeA = new AxlRuntime();
    const runtimeB = new AxlRuntime();
    runtimeA.registerProvider('openai', shared);
    runtimeB.registerProvider('openai', shared);
    const calls = [
      chat(resolveVia(runtimeA, 'openai:gpt-4o').provider, 'gpt-4o'),
      chat(resolveVia(runtimeB, 'openai:gpt-4o').provider, 'gpt-4o'),
    ];
    await settle();
    expect(net.inFlight).toBe(1);
    net.releaseAll();
    await settle();
    expect(net.inFlight).toBe(1);
    net.releaseAll();
    await Promise.all(calls);
    expect(net.peak).toBe(1);
  });

  it('documented limit: a registered openai instance does not pool with a factory-built openai-responses', async () => {
    // docs/providers.md tells users to register an instance for EVERY adapter
    // they share; this pins why.
    const net = stubFetch();
    const runtime = new AxlRuntime({
      providers: { openai: { apiKey: 'k', rateLimit: { maxConcurrent: 1 } } },
    });
    runtime.registerProvider(
      'openai',
      new OpenAIProvider({ apiKey: 'k', rateLimit: { maxConcurrent: 1 } }),
    );
    const calls = [
      chat(resolveVia(runtime, 'openai:gpt-4o').provider, 'gpt-4o'),
      chat(resolveVia(runtime, 'openai-responses:gpt-4o').provider, 'gpt-4o'),
    ];
    await settle();
    expect(net.inFlight).toBe(2);
    net.releaseAll();
    await Promise.all(calls);
  });
});

// ---------------------------------------------------------------------------
// AC15 — two blocks reaching one scope: strictest per field, one warning.
// ---------------------------------------------------------------------------

describe('AC15: two rateLimit blocks on one scope merge strictest', () => {
  const SECRET = 'sk-tenant-secret-0001';

  it('applies the tighter maxConcurrent and minIntervalMs and the smaller acquireTimeoutMs, warning once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const net = stubFetch();
    const runtime = new AxlRuntime({
      providers: {
        openai: { apiKey: SECRET, rateLimit: { maxConcurrent: 4, minIntervalMs: 10 } },
        'openai-responses': {
          apiKey: SECRET,
          rateLimit: { maxConcurrent: 2, minIntervalMs: 50, acquireTimeoutMs: 100 },
        },
      },
    });
    const completions = resolveVia(runtime, 'openai:gpt-4o').provider;
    const responses = resolveVia(runtime, 'openai-responses:gpt-4o').provider;

    // Warm up both adapters so each has joined the scope.
    for (const provider of [completions, responses]) {
      const call = chat(provider, 'gpt-4o');
      await settle();
      await vi.advanceTimersByTimeAsync(50);
      await settle();
      net.releaseAll();
      await call;
    }
    const warmups = net.dispatches.length;
    await vi.advanceTimersByTimeAsync(1000);

    const a = chat(completions, 'gpt-4o');
    const b = chat(responses, 'gpt-4o');
    const c = chat(completions, 'gpt-4o');
    const cSettled = c.then(
      () => 'resolved',
      (err: unknown) => err,
    );
    await settle();
    // A is granted immediately; B waits out the 50 ms interval (not openai's 10).
    expect(net.dispatches.length - warmups).toBe(1);
    await vi.advanceTimersByTimeAsync(49);
    await settle();
    expect(net.dispatches.length - warmups).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(net.dispatches.length - warmups).toBe(2);
    const [dispA, dispB] = net.dispatches.slice(warmups);
    expect(dispB.at - dispA.at).toBe(50);

    // Two in flight: C (an openai call, whose own block allows 4) must queue,
    // and responses' 100 ms acquireTimeoutMs rejects it.
    expect(net.inFlight).toBe(2);
    await vi.advanceTimersByTimeAsync(50);
    await settle();
    const err = await cSettled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('RateLimiter.acquire timed out after 100ms');
    expect(net.dispatches.length - warmups).toBe(2);

    net.releaseAll();
    await Promise.all([a, b]);

    const merges = mergeWarnings();
    expect(merges).toHaveLength(1);
    expect(merges[0]).toContain('"openai" and "openai-responses"');
    expect(merges[0]).toContain('maxConcurrent: 4 vs 2');
    expect(merges[0]).toContain('minIntervalMs: 10 vs 50');
    expect(merges[0]).toContain('maxConcurrent=2, minIntervalMs=50, acquireTimeoutMs=100');
    expect(merges[0]).toContain('https://api.openai.com');
    // RQ1: no warning of any kind carries the credential.
    for (const call of warn.mock.calls) {
      expect(call.map(String).join(' ')).not.toContain('tenant-secret');
    }
  });

  it('tightens a governor already in use when the second block joins', async () => {
    const net = stubFetch();
    const runtime = new AxlRuntime({
      providers: {
        openai: { apiKey: 'k', rateLimit: { maxConcurrent: 4 } },
        'openai-responses': { apiKey: 'k', rateLimit: { maxConcurrent: 2 } },
      },
    });
    const completions = resolveVia(runtime, 'openai:gpt-4o').provider;
    const firstThree = [0, 1, 2].map(() => chat(completions, 'gpt-4o'));
    await settle();
    expect(net.inFlight).toBe(3); // openai's own cap of 4 was in force

    // The Responses adapter joins the scope: the cap drops to 2 in place.
    const late = chat(resolveVia(runtime, 'openai-responses:gpt-4o').provider, 'gpt-4o');
    await settle();
    expect(net.dispatches).toHaveLength(3);
    net.dispatches[0].release();
    await settle();
    expect(net.dispatches).toHaveLength(3); // 2 still in flight = the merged cap
    net.dispatches[1].release();
    await settle();
    expect(net.dispatches).toHaveLength(4);
    net.releaseAll();
    await Promise.all([...firstThree, late]);
    expect(mergeWarnings()).toHaveLength(1);
  });

  it('a block without rateLimit on the same scope is governed by the other block, without a warning', async () => {
    const net = stubFetch();
    const runtime = new AxlRuntime({
      providers: {
        openai: { apiKey: 'k', rateLimit: { maxConcurrent: 1 } },
        'openai-responses': { apiKey: 'k' },
      },
    });
    const calls = [
      chat(resolveVia(runtime, 'openai-responses:gpt-4o').provider, 'gpt-4o'),
      chat(resolveVia(runtime, 'openai:gpt-4o').provider, 'gpt-4o'),
    ];
    await settle();
    expect(net.inFlight).toBe(1);
    net.releaseAll();
    await settle();
    net.releaseAll();
    await Promise.all(calls);
    expect(net.peak).toBe(1);
    expect(mergeWarnings()).toEqual([]);
  });

  it('a waiter armed before a merge reports the timeout it was armed with', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const net = stubFetch();
    const config: AxlConfig = {
      providers: {
        openai: { apiKey: 'k', rateLimit: { maxConcurrent: 1, acquireTimeoutMs: 200 } },
        'openai-responses': { apiKey: 'k', rateLimit: { acquireTimeoutMs: 50 } },
      },
    };
    const registry = new ProviderRegistry();
    const completions = registry.resolve('openai:gpt-4o', config).provider;
    const holder = chat(completions, 'gpt-4o');
    const waiter = chat(completions, 'gpt-4o').then(
      () => 'resolved',
      (err: unknown) => err,
    );
    await settle();
    expect(net.inFlight).toBe(1);

    // The Responses block joins and tightens the scope's timeout to 50 ms. The
    // queued waiter keeps its 200 ms timer, and its error must say so.
    registry.resolve('openai-responses:gpt-4o', config);
    await vi.advanceTimersByTimeAsync(199);
    await settle();
    expect(net.dispatches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const err = await waiter;
    expect((err as Error).message).toBe('RateLimiter.acquire timed out after 200ms');

    net.releaseAll();
    await holder;
  });

  it('an invalid value in one block is not taken as the strictest', async () => {
    const net = stubFetch();
    const runtime = new AxlRuntime({
      providers: {
        openai: { apiKey: 'k', rateLimit: { maxConcurrent: 0 } },
        'openai-responses': { apiKey: 'k', rateLimit: { maxConcurrent: 1 } },
      },
    });
    const calls = [
      chat(resolveVia(runtime, 'openai:gpt-4o').provider, 'gpt-4o'),
      chat(resolveVia(runtime, 'openai-responses:gpt-4o').provider, 'gpt-4o'),
    ];
    await settle();
    // `0` is ignored (with today's warning), so the valid cap of 1 applies.
    expect(net.inFlight).toBe(1);
    net.releaseAll();
    await settle();
    net.releaseAll();
    await Promise.all(calls);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('ignoring invalid maxConcurrent (0)')),
    ).toBe(true);
    expect(mergeWarnings()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RQ13 / F1 — an unconfigured scope has no governor at all.
// ---------------------------------------------------------------------------

describe('no rateLimit anywhere', () => {
  // A dialect scope (first-party OpenAI, Anthropic) has a governor even with no
  // `rateLimit`, so its fleet brake works with zero configuration (F1). Before
  // any 429 it applies no cap, no spacing and no warning.
  it.each([
    ['openai', 'gpt-4o'],
    ['openai-responses', 'gpt-4o'],
    ['anthropic', 'claude-sonnet-4'],
  ])(
    '%s: a governor that admits everything at once, queuedMs 0, no warning',
    async (name, model) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const acquire = vi.spyOn(RateLimiter.prototype, 'acquire');
      const tryAcquire = vi.spyOn(ScopeGovernor.prototype, 'tryAcquire');
      const net = stubFetch();
      const runtime = new AxlRuntime({ providers: { [name]: { apiKey: 'k' } } });
      const { provider } = resolveVia(runtime, `${name}:${model}`);
      const calls = [chat(provider, model), chat(provider, model), chat(provider, model)];
      await settle();
      expect(net.inFlight).toBe(3);
      net.releaseAll();
      const results = await Promise.all(calls);
      // Each call took a permit from the scope's governor at once; none queued.
      expect(tryAcquire.mock.results.map((r) => r.value)).toEqual([true, true, true]);
      expect(acquire).not.toHaveBeenCalled();
      for (const r of results) expect(r.timing?.queuedMs).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  // A dialect-less scope keeps no governor at all, as before pooling (AC21).
  it.each([
    ['google', 'gemini-2.5-flash'],
    ['groq', 'llama-3.3-70b'],
  ])('%s never touches a RateLimiter and reports queuedMs 0', async (name, model) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const acquire = vi.spyOn(RateLimiter.prototype, 'acquire');
    const net = stubFetch();
    const runtime = new AxlRuntime({ providers: { [name]: { apiKey: 'k' } } });
    const { provider } = resolveVia(runtime, `${name}:${model}`);
    const calls = [chat(provider, model), chat(provider, model), chat(provider, model)];
    await settle();
    expect(net.inFlight).toBe(3);
    net.releaseAll();
    const results = await Promise.all(calls);
    expect(acquire).not.toHaveBeenCalled();
    for (const r of results) expect(r.timing?.queuedMs).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Permits are exact and never held across a nested ask (RQ14, E8).
// ---------------------------------------------------------------------------

describe('permit bookkeeping on a pooled governor', () => {
  it('maxConcurrent 1: a nested same-scope ask through the other adapter completes', async () => {
    const net = stubFetch();
    const runtime = new AxlRuntime({
      providers: { openai: { apiKey: 'k', rateLimit: { maxConcurrent: 1 } } },
    });
    const completions = resolveVia(runtime, 'openai:gpt-4o').provider;
    const responses = resolveVia(runtime, 'openai-responses:gpt-4o').provider;
    // The "tool handler" issues its ask after the outer call returned, the way
    // the SDK runs tools between provider calls.
    const outer = chat(completions, 'gpt-4o').then(() => chat(responses, 'gpt-4o'));
    await settle();
    net.releaseAll();
    await settle();
    expect(net.dispatches).toHaveLength(2);
    net.releaseAll();
    await outer;
    // Permit count is exact: a fresh pair still admits exactly one at a time.
    const pair = [chat(completions, 'gpt-4o'), chat(responses, 'gpt-4o')];
    await settle();
    expect(net.inFlight).toBe(1);
    net.releaseAll();
    await settle();
    expect(net.inFlight).toBe(1);
    net.releaseAll();
    await Promise.all(pair);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('double-release'))).toBe(false);
  });

  it('clearCache starts a fresh pool, so a changed rateLimit is not merged with the old one', async () => {
    const net = stubFetch();
    const registry = new ProviderRegistry();
    const tight: AxlConfig = {
      providers: { openai: { apiKey: 'k', rateLimit: { maxConcurrent: 1 } } },
    };
    const loose: AxlConfig = {
      providers: { openai: { apiKey: 'k', rateLimit: { maxConcurrent: 3 } } },
    };
    const first = registry.resolve('openai:gpt-4o', tight).provider;
    const warm = chat(first, 'gpt-4o');
    await settle();
    net.releaseAll();
    await warm;

    registry.clearCache();
    const rebuilt = registry.resolve('openai:gpt-4o', loose).provider;
    const calls = [0, 1, 2].map(() => chat(rebuilt, 'gpt-4o'));
    await settle();
    expect(net.inFlight).toBe(3);
    net.releaseAll();
    await Promise.all(calls);
    expect(mergeWarnings()).toEqual([]);
  });
});
