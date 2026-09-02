import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OpenAICompatibleProvider,
  ThinkTagScanner,
  extractThinkTags,
  priceFromTable,
  resolvePerModel,
  type ProviderProfile,
  type PricingSource,
  type ReasoningProfile,
  type CapabilityFlags,
} from '../providers/openai-compatible.js';
import type { ChatMessage } from '../providers/types.js';
import { OPENROUTER_PROFILE } from '../providers/profiles/openrouter.js';

// ── fetch mock harness (mirrors openai.test.ts) ───────────────────────────

const originalFetch = globalThis.fetch;

function mockFetch(response: {
  ok?: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
  body?: ReadableStream<Uint8Array>;
}) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    headers: new Headers(),
    json: response.json ?? (() => Promise.resolve({})),
    text: response.text ?? (() => Promise.resolve('')),
    body: response.body,
  });
  globalThis.fetch = fn as any;
  return fn;
}

function lastRequest(fetchMock: ReturnType<typeof mockFetch>) {
  const call = fetchMock.mock.calls[0];
  return {
    url: call[0] as string,
    headers: call[1].headers as Record<string, string>,
    body: JSON.parse(call[1].body as string) as Record<string, unknown>,
  };
}

function okJson(extra: Record<string, unknown> = {}, message: Record<string, unknown> = {}) {
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
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < lines.length) {
        controller.enqueue(enc.encode(lines[i] + '\n'));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Minimal profile factory — every field defaulted to the OpenAI-safe value.
function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    name: 'test',
    label: 'Test',
    defaultBaseUrl: 'https://api.test.example/v1',
    pricing: { kind: 'unknown' },
    reasoning: { emit: () => {}, capture: 'none' },
    ...overrides,
  };
}

function makeProvider(overrides: Partial<ProviderProfile> = {}, apiKey: string | undefined = 'k') {
  return new OpenAICompatibleProvider({ profile: profile(overrides), apiKey });
}

const userMsg: ChatMessage[] = [{ role: 'user', content: 'Hello' }];

// ===========================================================================
// ThinkTagScanner — the most bug-prone piece (tags split across chunks).
// ===========================================================================

describe('ThinkTagScanner', () => {
  it('separates a complete think block in one push', () => {
    const s = new ThinkTagScanner();
    const r = s.push('before<think>secret</think>after');
    expect(r.text).toBe('beforeafter');
    expect(r.thinking).toBe('secret');
    expect(s.flush()).toEqual({ text: '', thinking: '' });
  });

  it('handles an opening tag split across two chunks', () => {
    const s = new ThinkTagScanner();
    const a = s.push('abc<thi');
    // "<thi" is a partial tag — held back, not emitted as text.
    expect(a.text).toBe('abc');
    expect(a.thinking).toBe('');
    const b = s.push('nk>secret</think>def');
    expect(b.text).toBe('def');
    expect(b.thinking).toBe('secret');
  });

  it('handles a closing tag split across chunks', () => {
    const s = new ThinkTagScanner();
    s.push('<think>rea');
    const b = s.push('soning</thi');
    expect(b.thinking).toBe('soning');
    expect(b.text).toBe('');
    const c = s.push('nk>visible');
    expect(c.text).toBe('visible');
    expect(c.thinking).toBe('');
  });

  it('handles a tag split character-by-character', () => {
    const s = new ThinkTagScanner();
    let text = '';
    let thinking = '';
    for (const ch of 'x<think>y</think>z') {
      const r = s.push(ch);
      text += r.text;
      thinking += r.thinking;
    }
    const f = s.flush();
    text += f.text;
    thinking += f.thinking;
    expect(text).toBe('xz');
    expect(thinking).toBe('y');
  });

  it('flushes an unterminated think block as thinking', () => {
    const s = new ThinkTagScanner();
    const a = s.push('text<think>unterminated');
    expect(a.text).toBe('text');
    expect(a.thinking).toBe('unterminated');
    expect(s.flush()).toEqual({ text: '', thinking: '' });
  });

  it('does not mistake a lone "<" for a tag start', () => {
    const s = new ThinkTagScanner();
    // "a < b" — the "<" could begin "<think>" so the tail is held, but flush recovers it.
    const a = s.push('2 < 3 is true');
    const f = s.flush();
    expect(a.text + f.text).toBe('2 < 3 is true');
    expect(a.thinking + f.thinking).toBe('');
  });

  it('extractThinkTags handles multiple blocks', () => {
    expect(extractThinkTags('a<think>1</think>b<think>2</think>c')).toEqual({
      content: 'abc',
      thinking: '12',
    });
  });
});

// ===========================================================================
// priceFromTable / resolvePerModel
// ===========================================================================

describe('priceFromTable', () => {
  const table = { 'model-x': [1e-6, 2e-6, 0.5] as [number, number, number] };

  it('returns undefined on a miss (never 0)', () => {
    expect(priceFromTable(table, 'unknown', 100, 50)).toBeUndefined();
  });

  it('matches by longest prefix for versioned ids', () => {
    expect(priceFromTable(table, 'model-x-2026-01', 100, 50)).toBeCloseTo(100e-6 + 100e-6, 9);
  });

  it('keeps prefix matching as the default but supports exact built-in rows', () => {
    expect(priceFromTable(table, 'model-x-future', 100, 50)).toBeDefined();
    expect(priceFromTable(table, 'model-x-future', 100, 50, undefined, 'exact')).toBeUndefined();
    expect(priceFromTable(table, 'model-x', 100, 50, undefined, 'exact')).toBeDefined();
  });

  it('rejects malformed counts directly without weakening prefix or exact matching', () => {
    for (const [prompt, completion, cached] of [
      [-1, 1, undefined],
      [1.5, 1, undefined],
      [Number.MAX_SAFE_INTEGER + 1, 1, undefined],
      [1, 1, 2],
    ] as const) {
      expect(priceFromTable(table, 'model-x-2026-01', prompt, completion, cached)).toBeUndefined();
      expect(priceFromTable(table, 'model-x', prompt, completion, cached, 'exact')).toBeUndefined();
    }
  });

  it('applies the cache multiplier', () => {
    // 80 cached @ 0.5, 20 uncached, 50 out
    expect(priceFromTable(table, 'model-x', 100, 50, 80)).toBeCloseTo(
      20 * 1e-6 + 80 * 1e-6 * 0.5 + 50 * 2e-6,
      9,
    );
  });
});

describe('zero pricing', () => {
  it('returns cost 0 for a known-free provider even when usage is omitted', async () => {
    mockFetch(okJson({ usage: undefined }));
    const r = await makeProvider({ pricing: { kind: 'zero' } }).chat(userMsg, { model: 'm' });
    expect(r.usage).toBeUndefined();
    expect(r.cost).toBe(0);
  });

  it('streams cost 0 for a known-free provider even when usage is omitted', async () => {
    mockFetch({
      body: sseStream([
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
        'data: [DONE]',
      ]),
    });
    const chunks: any[] = [];
    for await (const c of makeProvider({ pricing: { kind: 'zero' } }).stream(userMsg, {
      model: 'm',
    })) {
      chunks.push(c);
    }
    const done = chunks.find((c) => c.type === 'done');
    expect(done.usage).toBeUndefined();
    expect(done.cost).toBe(0);
  });
});

describe('resolvePerModel', () => {
  it('resolves plain values, functions, and the fallback', () => {
    expect(resolvePerModel(['a'], 'm', [])).toEqual(['a']);
    expect(resolvePerModel((m: string) => [m], 'm', [])).toEqual(['m']);
    expect(resolvePerModel(undefined, 'm', ['fb'])).toEqual(['fb']);
  });
});

// ===========================================================================
// Auth headers
// ===========================================================================

describe('auth headers', () => {
  it('defaults to Authorization: Bearer', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider().chat(userMsg, { model: 'm' });
    expect(lastRequest(fetchMock).headers.Authorization).toBe('Bearer k');
  });

  it('uses the api-key header for authHeader: "api-key" (Azure)', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({ authHeader: 'api-key' }).chat(userMsg, { model: 'm' });
    const h = lastRequest(fetchMock).headers;
    expect(h['api-key']).toBe('k');
    expect(h.Authorization).toBeUndefined();
  });

  it('supports a custom header + scheme', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({ authHeader: { header: 'X-Key', scheme: 'Token' } }).chat(userMsg, {
      model: 'm',
    });
    expect(lastRequest(fetchMock).headers['X-Key']).toBe('Token k');
  });

  it('omits the auth header entirely when allowMissingApiKey + empty key', async () => {
    const fetchMock = mockFetch(okJson());
    const p = new OpenAICompatibleProvider({
      profile: profile({ allowMissingApiKey: true }),
      apiKey: '',
    });
    await p.chat(userMsg, { model: 'm' });
    const h = lastRequest(fetchMock).headers;
    expect(h.Authorization).toBeUndefined();
    expect(h['api-key']).toBeUndefined();
  });

  it('throws on a missing key when allowMissingApiKey is false', () => {
    expect(() => new OpenAICompatibleProvider({ profile: profile(), apiKey: '' })).toThrow(
      'Test API key is required',
    );
  });

  it('merges static profile headers', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({ headers: { 'HTTP-Referer': 'https://x' } }).chat(userMsg, { model: 'm' });
    expect(lastRequest(fetchMock).headers['HTTP-Referer']).toBe('https://x');
  });
});

// ===========================================================================
// Request body knobs
// ===========================================================================

describe('request body', () => {
  it('defaults to max_completion_tokens, overridable to max_tokens', async () => {
    let fetchMock = mockFetch(okJson());
    await makeProvider().chat(userMsg, { model: 'm', maxTokens: 256 });
    expect(lastRequest(fetchMock).body.max_completion_tokens).toBe(256);

    fetchMock = mockFetch(okJson());
    await makeProvider({ maxTokensField: 'max_tokens' }).chat(userMsg, {
      model: 'm',
      maxTokens: 256,
    });
    const body = lastRequest(fetchMock).body;
    expect(body.max_tokens).toBe(256);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('omits messages[].name when emitsMessageName is false', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({ capabilities: { emitsMessageName: false } }).chat(
      [{ role: 'user', content: 'Hi', name: 'alice' }],
      { model: 'm' },
    );
    const msgs = lastRequest(fetchMock).body.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).not.toHaveProperty('name');
  });

  it('emits messages[].name by default', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider().chat([{ role: 'user', content: 'Hi', name: 'alice' }], { model: 'm' });
    const msgs = lastRequest(fetchMock).body.messages as Array<Record<string, unknown>>;
    expect(msgs[0].name).toBe('alice');
  });

  it('never leaks the `agent` attribution field onto the wire', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider().chat([{ role: 'assistant', content: 'x', agent: 'secret-agent' }], {
      model: 'm',
    });
    expect(JSON.stringify(lastRequest(fetchMock).body)).not.toContain('secret-agent');
  });

  it('maps roles via roleFor', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({ roleFor: (r) => (r === 'system' ? 'developer' : r) }).chat(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      { model: 'm' },
    );
    const msgs = lastRequest(fetchMock).body.messages as Array<Record<string, unknown>>;
    expect(msgs[0].role).toBe('developer');
    expect(msgs[1].role).toBe('user');
  });

  it('uses a merge-last providerOptions model for every synthesized capability', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({
      roleFor: (role, model) => (role === 'system' && model === 'target' ? 'developer' : role),
      reasoning: {
        emit: (body, _resolved, model) => {
          if (model === 'target') body.reasoning_effort = 'high';
          return { stripTemperature: model === 'target' };
        },
        capture: 'none',
      },
      parallelToolCalls: (model) => model !== 'target',
      capabilities: {
        supportsJsonSchema: (model) => model !== 'target',
        forbiddenParams: (model) => (model === 'target' ? ['stop'] : []),
      },
    }).chat(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
      ],
      {
        model: 'source',
        effort: 'high',
        temperature: 0.7,
        stop: ['END'],
        tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: {} } }],
        responseFormat: {
          type: 'json_schema',
          json_schema: { name: 'S', schema: { type: 'object' } },
        },
        providerOptions: { model: 'target' },
      },
    );
    const body = lastRequest(fetchMock).body;
    expect(body.model).toBe('target');
    expect((body.messages as Array<{ role: string }>)[0].role).toBe('developer');
    expect(body.reasoning_effort).toBe('high');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('parallel_tool_calls');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body).not.toHaveProperty('stop');
  });

  it('uses the providerOptions model for synthesized streaming capabilities', async () => {
    const fetchMock = mockFetch({
      body: sseStream(['data: {"choices":[{"delta":{"content":"ok"}}]}', 'data: [DONE]']),
    });
    const stream = makeProvider({
      reasoning: {
        emit: (body, _resolved, model) => {
          if (model === 'target') body.reasoning_effort = 'high';
          return { stripTemperature: model === 'target' };
        },
        capture: 'none',
      },
    }).stream(userMsg, {
      model: 'source',
      effort: 'high',
      temperature: 0.7,
      providerOptions: { model: 'target' },
    });
    for await (const chunk of stream) {
      expect(chunk).toBeDefined();
    }
    const body = lastRequest(fetchMock).body;
    expect(body.model).toBe('target');
    expect(body.reasoning_effort).toBe('high');
    expect(body).not.toHaveProperty('temperature');
  });

  it('sends parallel_tool_calls only when the PerModel predicate is true', async () => {
    const tools = [
      { type: 'function' as const, function: { name: 't', description: 'd', parameters: {} } },
    ];
    let fetchMock = mockFetch(okJson());
    await makeProvider({ parallelToolCalls: (m) => m !== 'no-parallel' }).chat(userMsg, {
      model: 'yes',
      tools,
    });
    expect(lastRequest(fetchMock).body.parallel_tool_calls).toBe(true);

    fetchMock = mockFetch(okJson());
    await makeProvider({ parallelToolCalls: (m) => m !== 'no-parallel' }).chat(userMsg, {
      model: 'no-parallel',
      tools,
    });
    expect(lastRequest(fetchMock).body).not.toHaveProperty('parallel_tool_calls');
  });

  it('merges requestDefaults before providerOptions', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({ requestDefaults: { usage: { include: true } } }).chat(userMsg, {
      model: 'm',
    });
    expect(lastRequest(fetchMock).body.usage).toEqual({ include: true });
  });

  it('lets the user override a requestDefault via providerOptions', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({ requestDefaults: { foo: 1 } }).chat(userMsg, {
      model: 'm',
      providerOptions: { foo: 2 },
    });
    expect(lastRequest(fetchMock).body.foo).toBe(2);
  });
});

// ===========================================================================
// forbiddenParams precedence (MUST-FIX 8)
// ===========================================================================

describe('forbiddenParams', () => {
  it('strips an engine-computed forbidden param (e.g. stop)', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({ capabilities: { forbiddenParams: ['stop'] } }).chat(userMsg, {
      model: 'm',
      stop: ['END'],
    });
    expect(lastRequest(fetchMock).body).not.toHaveProperty('stop');
  });

  it('PRESERVES a forbidden param the user set explicitly via providerOptions', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({ capabilities: { forbiddenParams: ['stop'] } }).chat(userMsg, {
      model: 'm',
      stop: ['END'], // engine-computed value
      providerOptions: { stop: ['USER'] }, // explicit user override — you-asked-for-it
    });
    expect(lastRequest(fetchMock).body.stop).toEqual(['USER']);
  });

  it('resolves forbiddenParams per model', async () => {
    const caps: CapabilityFlags = {
      forbiddenParams: (m) => (m === 'reasoner' ? ['stop'] : []),
    };
    let fetchMock = mockFetch(okJson());
    await makeProvider({ capabilities: caps }).chat(userMsg, { model: 'reasoner', stop: ['X'] });
    expect(lastRequest(fetchMock).body).not.toHaveProperty('stop');

    fetchMock = mockFetch(okJson());
    await makeProvider({ capabilities: caps }).chat(userMsg, { model: 'chat', stop: ['X'] });
    expect(lastRequest(fetchMock).body.stop).toEqual(['X']);
  });
});

// ===========================================================================
// json_schema fallback
// ===========================================================================

describe('response_format', () => {
  const fmt = {
    type: 'json_schema' as const,
    json_schema: { name: 'S', schema: { type: 'object' } },
  };

  it('passes json_schema through when supported', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider().chat(userMsg, { model: 'm', responseFormat: fmt });
    expect((lastRequest(fetchMock).body.response_format as any).type).toBe('json_schema');
  });

  it('falls back to json_object when supportsJsonSchema is false', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({ capabilities: { supportsJsonSchema: false } }).chat(userMsg, {
      model: 'm',
      responseFormat: fmt,
    });
    expect(lastRequest(fetchMock).body.response_format).toEqual({ type: 'json_object' });
  });
});

// ===========================================================================
// Pricing modes
// ===========================================================================

describe('pricing', () => {
  it('zero → cost 0 (explicit, for local runtimes)', async () => {
    mockFetch(okJson());
    const r = await makeProvider({ pricing: { kind: 'zero' } }).chat(userMsg, { model: 'm' });
    expect(r.cost).toBe(0);
  });

  it('unknown → cost undefined', async () => {
    mockFetch(okJson());
    const r = await makeProvider({ pricing: { kind: 'unknown' } }).chat(userMsg, { model: 'm' });
    expect(r.cost).toBeUndefined();
  });

  it('from-response → reads usage.cost', async () => {
    mockFetch(
      okJson({
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.0042 },
      }),
    );
    const r = await makeProvider({ pricing: { kind: 'from-response' } }).chat(userMsg, {
      model: 'm',
    });
    expect(r.cost).toBe(0.0042);
  });

  it('from-response → undefined when provider omits cost', async () => {
    mockFetch(okJson());
    const r = await makeProvider({ pricing: { kind: 'from-response' } }).chat(userMsg, {
      model: 'm',
    });
    expect(r.cost).toBeUndefined();
  });

  it('from-response accepts only finite nonnegative OpenRouter USD costs', async () => {
    for (const cost of [0, 0.0042, undefined, -1, Infinity, NaN]) {
      mockFetch(
        okJson({
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost },
        }),
      );
      const result = await makeProvider({ pricing: { kind: 'from-response' } }).chat(userMsg, {
        model: 'm',
      });
      expect(result.cost).toBe(cost === 0 || cost === 0.0042 ? cost : undefined);
    }
  });

  it('from-response converts only valid xAI USD ticks once', async () => {
    for (const ticks of [
      0,
      12_500_000_000,
      undefined,
      -1,
      Infinity,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      mockFetch(
        okJson({
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
            cost_in_usd_ticks: ticks,
          },
        }),
      );
      const result = await makeProvider({ name: 'xai', pricing: { kind: 'from-response' } }).chat(
        userMsg,
        { model: 'grok-4.5' },
      );
      expect(result.cost).toBe(ticks === 0 ? 0 : ticks === 12_500_000_000 ? 1.25 : undefined);
    }
  });

  it('table → undefined on miss', async () => {
    const pricing: PricingSource = { kind: 'table', table: { known: [1e-6, 1e-6, 1] } };
    mockFetch(okJson());
    const r = await makeProvider({ pricing }).chat(userMsg, { model: 'unknown' });
    expect(r.cost).toBeUndefined();
  });

  it('table pricing rejects malformed token counts before calculating', async () => {
    const pricing: PricingSource = { kind: 'table', table: { known: [1e-6, 1e-6, 0.5] } };
    for (const usage of [
      { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 },
      { prompt_tokens: 1.5, completion_tokens: 1, total_tokens: 2.5 },
      { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 1, total_tokens: 2 },
      {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        prompt_tokens_details: { cached_tokens: 2 },
      },
      {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        prompt_tokens_details: { cached_tokens: 0.5 },
      },
    ]) {
      mockFetch(okJson({ usage }));
      const result = await makeProvider({ pricing }).chat(userMsg, { model: 'known' });
      expect(result.cost).toBeUndefined();
    }
  });

  it('keeps custom table profiles priceable without built-in cache-split policy', async () => {
    mockFetch(okJson({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    const result = await makeProvider({
      pricing: { kind: 'table', table: { known: [1e-6, 2e-6, 0.5] }, match: 'exact' },
    }).chat(userMsg, { model: 'known' });
    expect(result.cost).toBeCloseTo(20e-6, 12);
  });
});

// ===========================================================================
// Reasoning capture (non-streaming)
// ===========================================================================

describe('reasoning capture (chat)', () => {
  function reasoning(
    capture: ReasoningProfile['capture'],
    roundTrip?: ReasoningProfile['roundTrip'],
  ) {
    return makeProvider({ reasoning: { emit: () => {}, capture, roundTrip } });
  }

  it('reasoning_content → thinking_content', async () => {
    mockFetch(okJson({}, { reasoning_content: 'deep thoughts' }));
    const r = await reasoning('reasoning_content').chat(userMsg, { model: 'm' });
    expect(r.thinking_content).toBe('deep thoughts');
  });

  it('reasoning (Groq) → thinking_content', async () => {
    mockFetch(okJson({}, { reasoning: 'groq thoughts' }));
    const r = await reasoning('reasoning').chat(userMsg, { model: 'm' });
    expect(r.thinking_content).toBe('groq thoughts');
  });

  it('reasoning_details → thinking from reasoning text', async () => {
    mockFetch(
      okJson({}, { reasoning: 'or thoughts', reasoning_details: [{ type: 'reasoning.text' }] }),
    );
    const r = await reasoning('reasoning_details').chat(userMsg, { model: 'm' });
    expect(r.thinking_content).toBe('or thoughts');
  });

  it('think_tags → extracts thinking from content', async () => {
    mockFetch(okJson({}, { content: 'pre<think>hidden</think>post' }));
    const r = await reasoning('think_tags').chat(userMsg, { model: 'm' });
    expect(r.content).toBe('prepost');
    expect(r.thinking_content).toBe('hidden');
  });

  it('normalizes content block arrays to the ProviderResponse string contract', async () => {
    mockFetch(okJson({}, { content: [{ type: 'text', text: 'hi' }, { content: ' there' }] }));
    const r = await reasoning('none').chat(userMsg, { model: 'm' });
    expect(r.content).toBe('hi there');
  });

  it('does NOT attach round-trip metadata when roundTrip is none', async () => {
    mockFetch(okJson({}, { reasoning_content: 'x' }));
    const r = await reasoning('reasoning_content').chat(userMsg, { model: 'm' });
    expect(r.providerMetadata).toBeUndefined();
  });

  it('attaches round-trip metadata when roundTrip is on-tool-call-turns', async () => {
    mockFetch(okJson({}, { reasoning_content: 'x' }));
    const r = await reasoning('reasoning_content', 'on-tool-call-turns').chat(userMsg, {
      model: 'm',
    });
    // Capture still surfaces thinking AND the round-trip bag is attached.
    expect(r.thinking_content).toBe('x');
    expect(r.providerMetadata).toEqual({
      openaiCompatReasoning: { provider: 'test', field: 'reasoning_content', value: 'x' },
    });
  });
});

// ===========================================================================
// Turn-aware reasoning round-trip echo (DeepSeek's per-turn rule)
// ===========================================================================

describe('reasoning round-trip echo (on-tool-call-turns)', () => {
  const assistantWithToolCall: ChatMessage = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    providerMetadata: {
      openaiCompatReasoning: { provider: 'test', field: 'reasoning_content', value: 'echoed' },
    },
  };
  const assistantPlain: ChatMessage = {
    role: 'assistant',
    content: 'just text',
    providerMetadata: {
      openaiCompatReasoning: { provider: 'test', field: 'reasoning_content', value: 'nope' },
    },
  };

  it('echoes reasoning on an assistant turn that carried tool_calls', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({
      reasoning: { emit: () => {}, capture: 'reasoning_content', roundTrip: 'on-tool-call-turns' },
    }).chat([assistantWithToolCall], { model: 'm' });
    const msgs = lastRequest(fetchMock).body.messages as Array<Record<string, unknown>>;
    expect(msgs[0].reasoning_content).toBe('echoed');
  });

  it('does NOT echo reasoning metadata captured by a different compatible provider', async () => {
    const fetchMock = mockFetch(okJson());
    const foreign: ChatMessage = {
      ...assistantWithToolCall,
      providerMetadata: {
        openaiCompatReasoning: {
          provider: 'openrouter',
          field: 'reasoning_details',
          value: [{ type: 'reasoning.text' }],
        },
      },
    };
    await makeProvider({
      name: 'deepseek',
      reasoning: { emit: () => {}, capture: 'reasoning_content', roundTrip: 'on-tool-call-turns' },
    }).chat([foreign], { model: 'm' });

    const msgs = lastRequest(fetchMock).body.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).not.toHaveProperty('reasoning_content');
    expect(msgs[0]).not.toHaveProperty('reasoning');
    expect(msgs[0]).not.toHaveProperty('reasoning_details');
  });

  it('does NOT echo reasoning on a plain assistant turn', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({
      reasoning: { emit: () => {}, capture: 'reasoning_content', roundTrip: 'on-tool-call-turns' },
    }).chat([assistantPlain], { model: 'm' });
    const msgs = lastRequest(fetchMock).body.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).not.toHaveProperty('reasoning_content');
  });

  it('does NOT echo when roundTrip is none even on tool-call turns', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({
      reasoning: { emit: () => {}, capture: 'reasoning_content' },
    }).chat([assistantWithToolCall], { model: 'm' });
    const msgs = lastRequest(fetchMock).body.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).not.toHaveProperty('reasoning_content');
  });
});

// ===========================================================================
// Error labeling
// ===========================================================================

describe('error handling', () => {
  it('labels errors with the profile label, not "OpenAI"', async () => {
    mockFetch({
      ok: false,
      status: 400,
      text: () => Promise.resolve(JSON.stringify({ error: { message: 'bad' } })),
    });
    await expect(makeProvider({ label: 'Groq' }).chat(userMsg, { model: 'm' })).rejects.toThrow(
      'Groq API error (400): bad',
    );
  });

  it('parses alternative error body shapes (message / detail)', async () => {
    mockFetch({
      ok: false,
      status: 422,
      text: () => Promise.resolve(JSON.stringify({ detail: 'unprocessable' })),
    });
    await expect(makeProvider().chat(userMsg, { model: 'm' })).rejects.toThrow(
      'Test API error (422): unprocessable',
    );
  });

  it('falls back to the raw body when not JSON', async () => {
    mockFetch({ ok: false, status: 502, text: () => Promise.resolve('upstream down') });
    await expect(makeProvider().chat(userMsg, { model: 'm' })).rejects.toThrow(
      'Test API error (502): upstream down',
    );
  });
});

// ===========================================================================
// Streaming: reasoning capture, cost, think_tags, usage-only chunk
// ===========================================================================

describe('streaming', () => {
  async function collect(p: OpenAICompatibleProvider, model = 'm') {
    const chunks: any[] = [];
    for await (const c of p.stream(userMsg, { model })) chunks.push(c);
    return chunks;
  }

  it('captures sidecar reasoning deltas as thinking_delta', async () => {
    mockFetch({
      body: sseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"think "},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"reasoning_content":"more"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":null}]}',
        'data: [DONE]',
      ]),
    });
    const chunks = await collect(
      makeProvider({ reasoning: { emit: () => {}, capture: 'reasoning_content' } }),
    );
    const thinking = chunks.filter((c) => c.type === 'thinking_delta').map((c) => c.content);
    expect(thinking).toEqual(['think ', 'more']);
    expect(chunks.find((c) => c.type === 'text_delta').content).toBe('answer');
  });

  it('reads usage.cost on the final chunk for from-response pricing', async () => {
    mockFetch({
      body: sseStream([
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost":0.009}}',
        'data: [DONE]',
      ]),
    });
    const chunks = await collect(makeProvider({ pricing: { kind: 'from-response' } }));
    expect(chunks.find((c) => c.type === 'done').cost).toBe(0.009);
  });

  it('uses valid xAI ticks from the terminal usage-only stream chunk', async () => {
    mockFetch({
      body: sseStream([
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost_in_usd_ticks":0}}',
        'data: [DONE]',
      ]),
    });
    const chunks = await collect(makeProvider({ name: 'xai', pricing: { kind: 'from-response' } }));
    expect(chunks.find((c) => c.type === 'done').cost).toBe(0);
  });

  it('rejects malformed OpenRouter and xAI terminal costs', async () => {
    for (const [name, key, value] of [
      ['test', 'cost', -1],
      ['test', 'cost', Infinity],
      ['xai', 'cost_in_usd_ticks', -1],
      ['xai', 'cost_in_usd_ticks', 1.5],
      ['xai', 'cost_in_usd_ticks', Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      mockFetch({
        body: sseStream([
          `data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"${key}":${JSON.stringify(value)}}}`,
          'data: [DONE]',
        ]),
      });
      const chunks = await collect(makeProvider({ name, pricing: { kind: 'from-response' } }));
      expect(chunks.find((c) => c.type === 'done').cost).toBeUndefined();
    }
  });

  it('rejects malformed table usage from terminal stream chunks', async () => {
    for (const usage of [
      { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 },
      { prompt_tokens: 1.5, completion_tokens: 1, total_tokens: 2.5 },
      { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 1, total_tokens: 2 },
      {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    ]) {
      mockFetch({
        body: sseStream([`data: ${JSON.stringify({ choices: [], usage })}`, 'data: [DONE]']),
      });
      const chunks = await collect(
        makeProvider({ pricing: { kind: 'table', table: { known: [1e-6, 1e-6, 1] } } }),
        'known',
      );
      expect(chunks.find((c) => c.type === 'done').cost).toBeUndefined();
    }
  });

  it('separates streamed <think> tags split across chunks', async () => {
    mockFetch({
      body: sseStream([
        'data: {"choices":[{"delta":{"content":"a<thi"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"nk>secret</thi"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"nk>b"},"finish_reason":null}]}',
        'data: [DONE]',
      ]),
    });
    const chunks = await collect(
      makeProvider({ reasoning: { emit: () => {}, capture: 'think_tags' } }),
    );
    const text = chunks
      .filter((c) => c.type === 'text_delta')
      .map((c) => c.content)
      .join('');
    const thinking = chunks
      .filter((c) => c.type === 'thinking_delta')
      .map((c) => c.content)
      .join('');
    expect(text).toBe('ab');
    expect(thinking).toBe('secret');
  });

  it('accumulates reasoning for round-trip in the done chunk', async () => {
    mockFetch({
      body: sseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"r1"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"reasoning_content":"r2"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ]),
    });
    const chunks = await collect(
      makeProvider({
        reasoning: {
          emit: () => {},
          capture: 'reasoning_content',
          roundTrip: 'on-tool-call-turns',
        },
      }),
    );
    expect(chunks.find((c) => c.type === 'done').providerMetadata).toEqual({
      openaiCompatReasoning: { provider: 'test', field: 'reasoning_content', value: 'r1r2' },
    });
  });

  it('does not request stream usage when supportsStreamUsage is false', async () => {
    const fetchMock = mockFetch({
      body: sseStream([
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
        'data: [DONE]',
      ]),
    });
    await collect(makeProvider({ capabilities: { supportsStreamUsage: false } }));
    expect(lastRequest(fetchMock).body).not.toHaveProperty('stream_options');
  });
});

// ===========================================================================
// Tool calls — streaming reassembly + non-streaming round-trip + mapping
// ===========================================================================

describe('tool calls', () => {
  async function collectStream(p: OpenAICompatibleProvider) {
    const chunks: any[] = [];
    for await (const c of p.stream(userMsg, { model: 'm' })) chunks.push(c);
    return chunks;
  }

  // Simulate the downstream accumulator (context.ts keys deltas by id).
  function assemble(chunks: any[]) {
    const byId = new Map<string, { name?: string; arguments: string }>();
    for (const c of chunks) {
      if (c.type !== 'tool_call_delta') continue;
      const cur = byId.get(c.id) ?? { arguments: '' };
      if (c.name) cur.name = c.name;
      if (c.arguments) cur.arguments += c.arguments;
      byId.set(c.id, cur);
    }
    return byId;
  }

  it('reassembles a tool call when id+name are on the first delta (OpenAI shape)', async () => {
    mockFetch({
      body: sseStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":"{\\"a\\":"}}]},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":null}]}',
        'data: [DONE]',
      ]),
    });
    const calls = assemble(await collectStream(makeProvider()));
    expect([...calls.keys()]).toEqual(['call_1']);
    expect(calls.get('call_1')).toEqual({ name: 'f', arguments: '{"a":1}' });
  });

  it('reassembles a SINGLE tool call when the id arrives on a LATER delta', async () => {
    // Some providers stream name/args first, id later. Must not split into two.
    mockFetch({
      body: sseStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"f","arguments":"{\\"a\\":"}}]},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"arguments":"1}"}}]},"finish_reason":null}]}',
        'data: [DONE]',
      ]),
    });
    const calls = assemble(await collectStream(makeProvider()));
    expect([...calls.keys()]).toEqual(['call_9']);
    expect(calls.get('call_9')).toEqual({ name: 'f', arguments: '{"a":1}' });
  });

  it('flushes a buffered tool call under a synthetic id if the id never arrives', async () => {
    mockFetch({
      body: sseStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"f","arguments":"{}"}}]},"finish_reason":null}]}',
        'data: [DONE]',
      ]),
    });
    const calls = assemble(await collectStream(makeProvider()));
    // Not dropped — emitted once under a stable per-index synthetic id.
    expect([...calls.values()]).toEqual([{ name: 'f', arguments: '{}' }]);
  });

  it('round-trips assistant tool_calls + tool result onto the wire (non-streaming)', async () => {
    const fetchMock = mockFetch(okJson());
    const history: ChatMessage[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', content: '42', tool_call_id: 't1' },
    ];
    await makeProvider().chat(history, { model: 'm' });
    const msgs = lastRequest(fetchMock).body.messages as Array<Record<string, any>>;
    expect(msgs[1].tool_calls[0].id).toBe('t1');
    expect(msgs[1].content).toBe('');
    expect(msgs[2].role).toBe('tool');
    expect(msgs[2].tool_call_id).toBe('t1');
  });

  it('maps response.message.tool_calls into ProviderResponse.tool_calls', async () => {
    mockFetch(
      okJson(
        {},
        {
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' } },
          ],
        },
      ),
    );
    const r = await makeProvider().chat(userMsg, { model: 'm' });
    expect(r.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' } },
    ]);
  });
});

// ===========================================================================
// Round-trip field validation (security: closed allowlist for the echo key)
// ===========================================================================

describe('round-trip field allowlist', () => {
  it('refuses to echo a non-allowlisted field from providerMetadata', async () => {
    const fetchMock = mockFetch(okJson());
    const hostile: ChatMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      // A malformed/hostile history entry trying to overwrite the model field.
      providerMetadata: {
        openaiCompatReasoning: { provider: 'test', field: 'model', value: 'evil-model' },
      },
    };
    await makeProvider({
      reasoning: { emit: () => {}, capture: 'reasoning_content', roundTrip: 'on-tool-call-turns' },
    }).chat([hostile], { model: 'real-model' });
    const body = lastRequest(fetchMock).body;
    expect(body.model).toBe('real-model'); // not overwritten
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).not.toHaveProperty('model');
  });
});

// ===========================================================================
// computeCost robustness
// ===========================================================================

describe('computeCost NaN guard', () => {
  it('returns undefined (not NaN) when a table-priced provider omits token counts', async () => {
    // Malformed usage: cost would compute as NaN without the finite guard.
    mockFetch({
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
          usage: { completion_tokens: 5, total_tokens: 5 }, // prompt_tokens missing
        }),
    });
    const r = await makeProvider({
      pricing: { kind: 'table', table: { m: [1e-6, 1e-6, 1] } },
    }).chat(userMsg, { model: 'm' });
    expect(r.cost).toBeUndefined();
  });
});

// ===========================================================================
// More streaming edge cases
// ===========================================================================

describe('streaming edge cases', () => {
  async function collect(p: OpenAICompatibleProvider) {
    const chunks: any[] = [];
    for await (const c of p.stream(userMsg, { model: 'm' })) chunks.push(c);
    return chunks;
  }

  it('accumulates reasoning_details across deltas for round-trip on tool turns', async () => {
    mockFetch({
      body: sseStream([
        'data: {"choices":[{"delta":{"reasoning":"a","reasoning_details":[{"i":1}]},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"reasoning":"b","reasoning_details":[{"i":2}]},"finish_reason":null}]}',
        'data: [DONE]',
      ]),
    });
    const chunks = await collect(
      makeProvider({
        reasoning: {
          emit: () => {},
          capture: 'reasoning_details',
          roundTrip: 'on-tool-call-turns',
        },
      }),
    );
    expect(chunks.find((c) => c.type === 'done').providerMetadata).toEqual({
      openaiCompatReasoning: {
        provider: 'test',
        field: 'reasoning_details',
        value: [{ i: 1 }, { i: 2 }],
      },
    });
  });

  it('throws ProviderError on an in-band SSE error payload', async () => {
    mockFetch({
      body: sseStream(['data: {"error":{"message":"stream failed","type":"server_error"}}']),
    });

    await expect(collect(makeProvider())).rejects.toMatchObject({
      name: 'ProviderError',
      provider: 'test',
      status: 0,
      retryable: false,
      message: 'stream failed',
    });
  });

  it('flushes think tags then throws when the stream ends without [DONE]', async () => {
    mockFetch({
      body: sseStream([
        'data: {"choices":[{"delta":{"content":"visible<think>hidden"},"finish_reason":null}]}',
        // no "data: [DONE]" — abrupt close
      ]),
    });
    const chunks: any[] = [];
    const p = (async () => {
      for await (const c of makeProvider({
        reasoning: { emit: () => {}, capture: 'think_tags' },
      }).stream(userMsg, { model: 'm' })) {
        chunks.push(c);
      }
    })();
    await expect(p).rejects.toMatchObject({
      name: 'ProviderError',
      provider: 'test',
      status: 0,
      retryable: true,
      message: 'Test stream ended before [DONE]',
    });
    expect(chunks.some((c) => c.type === 'done')).toBe(false);
    const thinking = chunks
      .filter((c) => c.type === 'thinking_delta')
      .map((c) => c.content)
      .join('');
    expect(thinking).toBe('hidden'); // unterminated block flushed as thinking
  });
});

// ===========================================================================
// think_tags malformed-input contract
// ===========================================================================

describe('think_tags malformed input', () => {
  it('treats a stray </think> with no opening tag as ordinary text', () => {
    // No <think> ever opened → nothing to close → the literal stays visible.
    expect(extractThinkTags('a</think>b')).toEqual({ content: 'a</think>b', thinking: '' });
  });
});

describe('OpenRouter image transport capability', () => {
  it('maps arbitrary model image content with tools and retains response-reported cost', async () => {
    const fetchMock = mockFetch(
      okJson({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.012 } }),
    );
    const provider = new OpenAICompatibleProvider({
      profile: OPENROUTER_PROFILE,
      apiKey: 'test-key',
    });
    const response = await provider.chat(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'compare' },
            {
              type: 'image',
              label: 'remote',
              source: { type: 'url', url: 'https://example.test/receipt.png' },
            },
            {
              type: 'image',
              label: 'inline',
              source: { type: 'bytes', data: new Uint8Array([4, 5, 6]), mediaType: 'image/jpeg' },
            },
            {
              type: 'image',
              label: 'receipt',
              source: { type: 'base64', data: 'AQID', mediaType: 'image/png' },
            },
            { type: 'text', text: 'read it' },
          ],
        },
      ],
      {
        model: 'catalog/default',
        providerOptions: { model: 'anthropic/claude-vision-example' },
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Look up the receipt.',
              parameters: { type: 'object' },
            },
          },
        ],
      },
    );
    expect(lastRequest(fetchMock).body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'compare' },
          { type: 'image_url', image_url: { url: 'https://example.test/receipt.png' } },
          { type: 'text', text: '[Image: remote]' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BAUG' } },
          { type: 'text', text: '[Image: inline]' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
          { type: 'text', text: '[Image: receipt]' },
          { type: 'text', text: 'read it' },
        ],
      },
    ]);
    expect(response.cost).toBe(0.012);
    expect(lastRequest(fetchMock).body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up the receipt.',
          parameters: { type: 'object' },
        },
      },
    ]);
    expect(provider.inputCapabilities('google/gemini-vision-example')).toEqual({
      image: { sources: ['url', 'bytes', 'base64'] },
    });
    expect(() =>
      provider.validateInput({
        model: 'google/gemini-vision-example',
        input: [
          {
            type: 'image',
            source: { type: 'provider-file', provider: 'openrouter', reference: 'file' },
          },
        ],
        history: [],
        stream: false,
        hasTools: true,
        responseMode: 'text',
      }),
    ).toThrow('provider-file');
    expect(
      provider.validateInput({
        model: 'catalog/default',
        input: [{ type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }],
        history: [],
        providerOptions: { model: 'openai/gpt-4o-mini' },
        stream: false,
        hasTools: true,
        responseMode: 'text',
      }),
    ).toEqual({ effectiveModel: 'openai/gpt-4o-mini' });
    for (const model of [undefined, 42, '']) {
      expect(() =>
        provider.validateInput({
          model: 'openai/gpt-4o-mini',
          input: [{ type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }],
          history: [],
          providerOptions: { model },
          stream: false,
          hasTools: false,
          responseMode: 'text',
        }),
      ).toThrow('invalid model providerOptions');
    }
    expect(() =>
      provider.validateInput({
        model: 'vendor/vision-model',
        input: [{ type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }],
        history: [],
        providerOptions: { messages: [] },
        stream: false,
        hasTools: false,
        responseMode: 'text',
      }),
    ).toThrow('raw messages providerOptions');
    expect(() =>
      provider.validateInput({
        model: 'vendor/vision-model',
        input: [{ type: 'text', text: 'continue' }],
        history: [
          {
            role: 'assistant',
            content: [
              {
                type: 'image',
                source: { type: 'url', url: 'https://example.test/a.png' },
              },
            ],
          },
        ],
        stream: false,
        hasTools: false,
        responseMode: 'text',
      }),
    ).toThrow('rich non-user history');
  });

  it('surfaces an upstream catalog capability rejection as ProviderError', async () => {
    mockFetch({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(JSON.stringify({ error: { message: 'image input is unsupported' } })),
    });
    const provider = new OpenAICompatibleProvider({
      profile: OPENROUTER_PROFILE,
      apiKey: 'test-key',
    });
    await expect(
      provider.chat(
        [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'url', url: 'https://example.test/a.png' },
              },
            ],
          },
        ],
        { model: 'vendor/not-vision' },
      ),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      provider: 'openrouter',
      status: 400,
      message: expect.stringContaining('image input is unsupported'),
    });
  });
});
