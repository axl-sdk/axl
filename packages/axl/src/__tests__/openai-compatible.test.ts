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

  it('applies the cache multiplier', () => {
    // 80 cached @ 0.5, 20 uncached, 50 out
    expect(priceFromTable(table, 'model-x', 100, 50, 80)).toBeCloseTo(
      20 * 1e-6 + 80 * 1e-6 * 0.5 + 50 * 2e-6,
      9,
    );
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

  it('table → undefined on miss', async () => {
    const pricing: PricingSource = { kind: 'table', table: { known: [1e-6, 1e-6, 1] } };
    mockFetch(okJson());
    const r = await makeProvider({ pricing }).chat(userMsg, { model: 'unknown' });
    expect(r.cost).toBeUndefined();
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
    expect(r.providerMetadata).toEqual({
      openaiCompatReasoning: { field: 'reasoning_content', value: 'x' },
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
    providerMetadata: { openaiCompatReasoning: { field: 'reasoning_content', value: 'echoed' } },
  };
  const assistantPlain: ChatMessage = {
    role: 'assistant',
    content: 'just text',
    providerMetadata: { openaiCompatReasoning: { field: 'reasoning_content', value: 'nope' } },
  };

  it('echoes reasoning on an assistant turn that carried tool_calls', async () => {
    const fetchMock = mockFetch(okJson());
    await makeProvider({
      reasoning: { emit: () => {}, capture: 'reasoning_content', roundTrip: 'on-tool-call-turns' },
    }).chat([assistantWithToolCall], { model: 'm' });
    const msgs = lastRequest(fetchMock).body.messages as Array<Record<string, unknown>>;
    expect(msgs[0].reasoning_content).toBe('echoed');
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
      openaiCompatReasoning: { field: 'reasoning_content', value: 'r1r2' },
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
