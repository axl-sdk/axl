import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiProvider } from '../providers/gemini.js';

// ── Mock fetch ──────────────────────────────────────────────────────────

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

function makeGeminiResponse(
  text: string,
  usage?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
  },
) {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {
      serviceTier: 'SERVICE_TIER_STANDARD',
      ...(usage ?? { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }),
    },
  };
}

beforeEach(() => {
  process.env.GOOGLE_API_KEY = 'test-key';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('GeminiProvider', () => {
  it('throws when no API key is provided', () => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect(() => new GeminiProvider()).toThrow('Google API key is required');
  });

  it('accepts API key via constructor options', () => {
    delete process.env.GOOGLE_API_KEY;
    const provider = new GeminiProvider({ apiKey: 'my-key' });
    expect(provider.name).toBe('google');
  });

  it('accepts GEMINI_API_KEY env var', () => {
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = 'gemini-key';
    const provider = new GeminiProvider();
    expect(provider.name).toBe('google');
  });

  describe('chat()', () => {
    it('sends correct URL and headers', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('Hello!')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], { model: 'gemini-2.5-flash' });

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('/models/gemini-2.5-flash:generateContent');
      expect(opts.headers['x-goog-api-key']).toBe('test-key');
      expect(opts.headers['Content-Type']).toBe('application/json');
    });

    it('extracts system messages into system_instruction', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('Hello!')),
      });

      const provider = new GeminiProvider();
      await provider.chat(
        [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
        { model: 'gemini-2.0-flash' },
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.system_instruction).toEqual({ parts: [{ text: 'You are helpful.' }] });
      // System message should not appear in contents
      expect(body.contents.every((c: any) => c.role !== 'system')).toBe(true);
    });

    it('maps assistant role to model role', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('Done')),
      });

      const provider = new GeminiProvider();
      await provider.chat(
        [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
          { role: 'user', content: 'How are you?' },
        ],
        { model: 'gemini-2.0-flash' },
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.contents[1].role).toBe('model');
      expect(body.contents[1].parts[0].text).toBe('Hi there');
    });

    it('maps assistant tool_calls to functionCall parts', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        name: 'search',
                        args: { query: 'test' },
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15, totalTokenCount: 35 },
          }),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat(
        [
          { role: 'user', content: 'Search for test' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tc_1',
                type: 'function' as const,
                function: { name: 'search', arguments: '{"query":"test"}' },
              },
            ],
          },
          { role: 'tool', content: 'Found results', tool_call_id: 'tc_1' },
        ],
        { model: 'gemini-2.0-flash' },
      );

      // Verify request body maps tool_calls to functionCall parts
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const modelMsg = body.contents.find((c: any) => c.role === 'model');
      expect(modelMsg).toBeDefined();
      const fcPart = modelMsg.parts.find((p: any) => p.functionCall);
      expect(fcPart).toBeDefined();
      expect(fcPart.functionCall.name).toBe('search');
      expect(fcPart.functionCall.args).toEqual({ query: 'test' });

      // Response should parse functionCall from API response
      expect(response.tool_calls).toHaveLength(1);
      expect(response.tool_calls![0].function.name).toBe('search');
      expect(response.tool_calls![0].function.arguments).toBe('{"query":"test"}');
    });

    it('preserves functionCall.id from Gemini 3.6 Flash responses (non-streaming)', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        id: 'fc_abc',
                        name: 'search',
                        args: { query: 'test' },
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15, totalTokenCount: 35 },
          }),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Search' }], {
        model: 'gemini-3.6-flash',
      });

      expect(response.tool_calls).toHaveLength(1);
      expect(response.tool_calls![0].id).toBe('fc_abc');
      const geminiParts = response.providerMetadata?.geminiParts as Array<{
        functionCall?: { id?: string };
      }>;
      expect(geminiParts?.[0].functionCall?.id).toBe('fc_abc');
    });

    it('includes id in functionResponse when prior assistant carried a Gemini-native id', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('Done')),
      });

      const provider = new GeminiProvider();
      await provider.chat(
        [
          { role: 'user', content: 'Search for test' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'fc_abc',
                type: 'function' as const,
                function: { name: 'search', arguments: '{"query":"test"}' },
              },
            ],
            providerMetadata: {
              geminiParts: [
                {
                  functionCall: { id: 'fc_abc', name: 'search', args: { query: 'test' } },
                  thoughtSignature: 'sig-fc-abc',
                },
              ],
            },
          },
          { role: 'tool', content: '{"hits":3}', tool_call_id: 'fc_abc' },
        ],
        { model: 'gemini-3.6-flash' },
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const userMsgWithFr = body.contents.find((c: any) =>
        c.parts.some((p: any) => p.functionResponse),
      );
      const frPart = userMsgWithFr.parts.find((p: any) => p.functionResponse);
      expect(frPart.functionResponse.id).toBe('fc_abc');
      expect(frPart.functionResponse.name).toBe('search');
      expect(frPart.functionResponse.response).toEqual({ hits: 3 });
    });

    it('round-trips parallel functionCall ids — both preserved on incoming and echoed on outbound', async () => {
      // Turn 1: Gemini returns two parallel functionCalls with native ids.
      mockFetch({
        json: () =>
          Promise.resolve({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: { id: 'fc_a', name: 'tool_a', args: { x: 1 } },
                      thoughtSignature: 'sig-fc-a',
                    },
                    {
                      functionCall: { id: 'fc_b', name: 'tool_b', args: { y: 2 } },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 20, totalTokenCount: 50 },
          }),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Use both' }], {
        model: 'gemini-3.6-flash',
      });

      expect(response.tool_calls).toHaveLength(2);
      expect(response.tool_calls![0].id).toBe('fc_a');
      expect(response.tool_calls![1].id).toBe('fc_b');

      // Turn 2: replay the assistant message + both tool results back into Gemini.
      const turn2Mock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('Done')),
      });

      await provider.chat(
        [
          { role: 'user', content: 'Use both' },
          {
            role: 'assistant',
            content: '',
            tool_calls: response.tool_calls!,
            providerMetadata: response.providerMetadata,
          },
          { role: 'tool', content: '{"a":1}', tool_call_id: 'fc_a' },
          { role: 'tool', content: '{"b":2}', tool_call_id: 'fc_b' },
        ],
        { model: 'gemini-3.6-flash' },
      );

      const body = JSON.parse(turn2Mock.mock.calls[0][1].body);
      // Tool messages collapse via mergeConsecutiveRoles into one user content with two parts.
      const userContents = body.contents.filter((c: any) =>
        c.parts.some((p: any) => p.functionResponse),
      );
      const allFrParts = userContents.flatMap((c: any) =>
        c.parts.filter((p: any) => p.functionResponse),
      );
      expect(allFrParts).toHaveLength(2);
      const byId = new Map<string, any>(allFrParts.map((p: any) => [p.functionResponse.id, p]));
      expect(byId.get('fc_a')?.functionResponse.name).toBe('tool_a');
      expect(byId.get('fc_a')?.functionResponse.response).toEqual({ a: 1 });
      expect(byId.get('fc_b')?.functionResponse.name).toBe('tool_b');
      expect(byId.get('fc_b')?.functionResponse.response).toEqual({ b: 2 });
    });

    it('omits id in functionResponse for Gemini 2.x (no native id seen)', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('Done')),
      });

      const provider = new GeminiProvider();
      await provider.chat(
        [
          { role: 'user', content: 'Search for test' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_0',
                type: 'function' as const,
                function: { name: 'search', arguments: '{"query":"test"}' },
              },
            ],
            // No providerMetadata.geminiParts → 2.x case (or first turn without round-trip).
          },
          { role: 'tool', content: '{"hits":3}', tool_call_id: 'call_0' },
        ],
        { model: 'gemini-2.0-flash' },
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const userMsgWithFr = body.contents.find((c: any) =>
        c.parts.some((p: any) => p.functionResponse),
      );
      const frPart = userMsgWithFr.parts.find((p: any) => p.functionResponse);
      expect(frPart.functionResponse.id).toBeUndefined();
      expect(frPart.functionResponse.name).toBe('search');
    });

    it('maps tool messages to user messages with functionResponse parts', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('Done')),
      });

      const provider = new GeminiProvider();
      await provider.chat(
        [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tc_1',
                type: 'function' as const,
                function: { name: 'get_data', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', content: '{"result":"data"}', tool_call_id: 'tc_1' },
        ],
        { model: 'gemini-2.0-flash' },
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Tool result should be a user-role message with functionResponse part
      const userMsgs = body.contents.filter((c: any) => c.role === 'user');
      const frMsg = userMsgs.find((c: any) => c.parts.some((p: any) => p.functionResponse));
      expect(frMsg).toBeDefined();
      const frPart = frMsg.parts.find((p: any) => p.functionResponse);
      expect(frPart.functionResponse.name).toBe('get_data');
      expect(frPart.functionResponse.response).toEqual({ result: 'data' });
    });

    it.each([
      ['number', '42', { result: 42 }],
      ['boolean', 'false', { result: false }],
      ['null', 'null', { result: null }],
      ['array', '[1,"two"]', { result: [1, 'two'] }],
      ['JSON string', '"plain"', { result: 'plain' }],
      ['non-JSON text', 'plain', { result: 'plain' }],
    ])(
      "wraps a parsed %s tool result in Gemini's required object envelope",
      async (_label, content, expected) => {
        const fetchMock = mockFetch({
          json: () => Promise.resolve(makeGeminiResponse('Done')),
        });

        const provider = new GeminiProvider();
        await provider.chat(
          [
            { role: 'user', content: 'Run the tool' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'tc_primitive',
                  type: 'function' as const,
                  function: { name: 'get_value', arguments: '{}' },
                },
              ],
            },
            { role: 'tool', content, tool_call_id: 'tc_primitive' },
          ],
          { model: 'gemini-2.0-flash' },
        );

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const functionResponse = body.contents
          .flatMap((item: any) => item.parts)
          .find((part: any) => part.functionResponse)?.functionResponse;
        expect(functionResponse.response).toEqual(expected);
      },
    );

    it('maps json_object response format to responseMimeType', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('{"key":"value"}')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Return JSON' }], {
        model: 'gemini-2.0-flash',
        responseFormat: { type: 'json_object' },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.responseMimeType).toBe('application/json');
    });

    it('maps json_schema response format to responseSchema', async () => {
      const schema = { type: 'object', properties: { name: { type: 'string' } } };
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('{"name":"test"}')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Return JSON' }], {
        model: 'gemini-2.0-flash',
        responseFormat: {
          type: 'json_schema',
          json_schema: { name: 'TestSchema', schema },
        },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      expect(body.generationConfig.responseSchema).toEqual(schema);
    });

    it('estimates cost from usage data for known models', async () => {
      mockFetch({
        json: () =>
          Promise.resolve(
            makeGeminiResponse('Hi', {
              promptTokenCount: 100,
              candidatesTokenCount: 50,
              totalTokenCount: 150,
            }),
          ),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-flash',
      });

      // gemini-2.5-flash: input $0.30/M, output $2.50/M
      expect(response.cost).toBeCloseTo(0.000155, 8);
      expect(response.usage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      });
    });

    it('discounts cached tokens at 10% of input rate', async () => {
      mockFetch({
        json: () =>
          Promise.resolve(
            makeGeminiResponse('Hi', {
              promptTokenCount: 1000,
              candidatesTokenCount: 50,
              totalTokenCount: 1050,
              cachedContentTokenCount: 800,
            }),
          ),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-flash',
      });

      // Non-cached input: 200 * 0.3e-6 = 0.00006
      // Cached input:     800 * 0.03e-6 = 0.000024
      // Output:           50 * 2.5e-6 = 0.000125
      expect(response.cost).toBeCloseTo(0.000209, 8);
      expect(response.usage).toEqual({
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
        cached_tokens: 800,
      });
    });

    it('estimates cost for an exact current gemini-3.1 model id', async () => {
      mockFetch({
        json: () =>
          Promise.resolve(
            makeGeminiResponse('Hi', {
              promptTokenCount: 100,
              candidatesTokenCount: 50,
              totalTokenCount: 150,
            }),
          ),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.1-flash-lite',
      });

      // gemini-3.1-flash-lite-preview: [0.25e-6, 1.5e-6]
      // Expected: 100 * 0.25e-6 + 50 * 1.5e-6 = 0.000025 + 0.000075 = 0.0001
      expect(response.cost).toBeCloseTo(0.0001, 8);
    });

    it('returns undefined cost for retired Gemini 2.0 models', async () => {
      mockFetch({
        json: () =>
          Promise.resolve(
            makeGeminiResponse('Hi', {
              promptTokenCount: 100,
              candidatesTokenCount: 50,
              totalTokenCount: 150,
            }),
          ),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.0-flash',
      });

      expect(response.cost).toBeUndefined();
    });

    it('returns undefined cost for unknown models (honest lower-bound signal)', async () => {
      mockFetch({
        json: () =>
          Promise.resolve(
            makeGeminiResponse('Hi', {
              promptTokenCount: 100,
              candidatesTokenCount: 50,
              totalTokenCount: 150,
            }),
          ),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-unknown-model-9000',
      });

      expect(response.cost).toBeUndefined();
    });

    it('does not infer pricing for a versioned sibling model id', async () => {
      mockFetch({
        json: () =>
          Promise.resolve(
            makeGeminiResponse('Hi', {
              promptTokenCount: 1000,
              candidatesTokenCount: 0,
              totalTokenCount: 1000,
            }),
          ),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-flash-lite-preview-0520',
      });

      expect(response.cost).toBeUndefined();
    });

    it('does not infer pricing for a versioned gemini-3.5-flash sibling', async () => {
      mockFetch({
        json: () =>
          Promise.resolve(
            makeGeminiResponse('Hi', {
              promptTokenCount: 1000,
              candidatesTokenCount: 0,
              totalTokenCount: 1000,
            }),
          ),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.5-flash-001',
      });

      expect(response.cost).toBeUndefined();
    });

    it('prices gemini-3.6-flash from the response model and bills thoughts once', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            ...makeGeminiResponse('Hi', {
              promptTokenCount: 100,
              candidatesTokenCount: 10,
              thoughtsTokenCount: 20,
              totalTokenCount: 130,
            }),
            modelVersion: 'gemini-3.6-flash',
          }),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.5-flash-lite',
      });

      // $1.50/M input + (10 candidate + 20 thought) * $7.50/M output.
      expect(response.cost).toBeCloseTo(0.000375, 8);
      expect(response.usage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 130,
        reasoning_tokens: 20,
      });
    });

    it('prices the lowercase standard tier returned by the live API', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            ...makeGeminiResponse('Hi'),
            modelVersion: 'gemini-3.5-flash-lite',
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 10,
              totalTokenCount: 110,
              serviceTier: 'standard',
            },
          }),
      });

      const response = await new GeminiProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.5-flash-lite',
      });
      expect(response.cost).toBeCloseTo(0.000055, 8);
    });

    it('leaves thinking-only MAX_TOKENS usage unpriced when candidate count is omitted', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            modelVersion: 'gemini-3.6-flash',
            candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }],
            usageMetadata: {
              promptTokenCount: 3,
              thoughtsTokenCount: 60,
              totalTokenCount: 63,
              serviceTier: 'standard',
            },
          }),
      });

      const response = await new GeminiProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.6-flash',
      });
      expect(response.usage).toBeUndefined();
      expect(response.cost).toBeUndefined();
    });

    it('leaves Flex and Priority calls unpriced', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            ...makeGeminiResponse('Hi'),
            modelVersion: 'gemini-3.6-flash',
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              totalTokenCount: 15,
              serviceTier: 'SERVICE_TIER_FLEX',
            },
          }),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.6-flash',
        providerOptions: { serviceTier: 'SERVICE_TIER_PRIORITY' },
      });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).serviceTier).toBe('SERVICE_TIER_PRIORITY');
      expect(response.cost).toBeUndefined();
    });

    it('fails closed on malformed billed token counts', async () => {
      mockFetch({
        json: () =>
          Promise.resolve(
            makeGeminiResponse('Hi', {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              totalTokenCount: 15,
              cachedContentTokenCount: 11,
            }),
          ),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.6-flash',
      });

      expect(response.usage).toBeUndefined();
      expect(response.cost).toBeUndefined();
    });

    it('strips portable temperature only for the two newest Gemini models', async () => {
      const fetchMock = mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Hi')) });
      const provider = new GeminiProvider();

      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.6-flash',
        temperature: 0.7,
      });

      expect(
        JSON.parse(fetchMock.mock.calls[0][1].body).generationConfig?.temperature,
      ).toBeUndefined();

      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.5-flash-lite',
        temperature: 0.7,
        providerOptions: { generationConfig: { temperature: 0.2 } },
      });

      expect(JSON.parse(fetchMock.mock.calls[1][1].body).generationConfig).toEqual({
        temperature: 0.2,
      });
    });

    it('rejects a newest-family terminal model prefill before fetch without mutating messages', async () => {
      const fetchMock = mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Hi')) });
      const messages = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Prefilled answer' },
      ];
      const originalMessages = structuredClone(messages);
      const provider = new GeminiProvider();

      await expect(provider.chat(messages, { model: 'gemini-3.6-flash' })).rejects.toThrow(
        'does not support a terminal assistant/model prefill',
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(messages).toEqual(originalMessages);
    });

    it('allows an empty terminal assistant message for the newest family', async () => {
      const fetchMock = mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Hi')) });
      const provider = new GeminiProvider();

      await provider.chat(
        [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: '' },
        ],
        { model: 'gemini-3.5-flash-lite' },
      );

      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('rejects Gemini 3 tool continuations that lack native signed parts before fetch', async () => {
      const fetchMock = mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Hi')) });
      const provider = new GeminiProvider();

      await expect(
        provider.chat(
          [
            { role: 'user', content: 'Search' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function' as const,
                  function: { name: 'search', arguments: '{"query":"axl"}' },
                },
              ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: '{"result":"ok"}' },
          ],
          { model: 'gemini-3.6-flash' },
        ),
      ).rejects.toThrow('require providerMetadata.geminiParts with thought signatures');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects missing, duplicate, and stale Gemini 3 tool responses before fetch', async () => {
      const fetchMock = mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Hi')) });
      const provider = new GeminiProvider();
      const assistant = {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          { id: 'fc_a', type: 'function' as const, function: { name: 'tool_a', arguments: '{}' } },
          { id: 'fc_b', type: 'function' as const, function: { name: 'tool_b', arguments: '{}' } },
        ],
        providerMetadata: {
          geminiParts: [
            {
              functionCall: { id: 'fc_a', name: 'tool_a', args: {} },
              thoughtSignature: 'sig-a',
            },
            { functionCall: { id: 'fc_b', name: 'tool_b', args: {} } },
          ],
        },
      };

      await expect(
        provider.chat(
          [
            { role: 'user', content: 'Use both' },
            assistant,
            { role: 'tool', tool_call_id: 'fc_a', content: '{}' },
          ],
          { model: 'gemini-3.6-flash' },
        ),
      ).rejects.toThrow('one contiguous functionResponse for every native functionCall');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['duplicate', ['fc_a', 'fc_a'], undefined, 'exactly one matching native functionCall'],
      [
        'extra/stale',
        ['fc_a', 'fc_b', 'stale'],
        undefined,
        'exactly one matching native functionCall',
      ],
      [
        'raw/normalized name mismatch',
        ['fc_a', 'fc_b'],
        'different_name',
        'exact native functionCall id/name',
      ],
    ])(
      'rejects a %s Gemini 3 continuation group before fetch',
      async (_caseName, responseIds, rawSecondName, expectedError) => {
        const fetchMock = mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Hi')) });
        const provider = new GeminiProvider();
        const assistant = {
          role: 'assistant' as const,
          content: '',
          tool_calls: [
            {
              id: 'fc_a',
              type: 'function' as const,
              function: { name: 'tool_a', arguments: '{}' },
            },
            {
              id: 'fc_b',
              type: 'function' as const,
              function: { name: 'tool_b', arguments: '{}' },
            },
          ],
          providerMetadata: {
            geminiParts: [
              {
                functionCall: { id: 'fc_a', name: 'tool_a', args: {} },
                thoughtSignature: 'sig-a',
              },
              {
                functionCall: { id: 'fc_b', name: rawSecondName ?? 'tool_b', args: {} },
              },
            ],
          },
        };
        await expect(
          provider.chat(
            [
              { role: 'user', content: 'Use both' },
              assistant,
              ...responseIds.map((tool_call_id) => ({
                role: 'tool' as const,
                tool_call_id,
                content: '{}',
              })),
            ],
            { model: 'gemini-3.6-flash' },
          ),
        ).rejects.toThrow(expectedError);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('uses the long-context Gemini 2.5 Pro band only above 200K prompt tokens', async () => {
      mockFetch({
        json: () =>
          Promise.resolve(
            makeGeminiResponse('Hi', {
              promptTokenCount: 200_001,
              candidatesTokenCount: 1,
              totalTokenCount: 200_002,
            }),
          ),
      });
      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-pro',
      });

      expect(response.cost).toBeCloseTo(0.5000175, 8);
    });

    it('keeps the short-context rate at exactly 200K prompt tokens', async () => {
      mockFetch({
        json: () =>
          Promise.resolve(
            makeGeminiResponse('Hi', {
              promptTokenCount: 200_000,
              candidatesTokenCount: 1,
              totalTokenCount: 200_001,
            }),
          ),
      });
      const response = await new GeminiProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-pro',
      });

      expect(response.cost).toBeCloseTo(0.25001, 8);
    });

    it('uses providerOptions.model for URL/capabilities/pricing but omits it from the body', async () => {
      const fetchMock = mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Hi')) });
      const response = await new GeminiProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-flash-lite',
        temperature: 0.7,
        providerOptions: { model: 'gemini-3.6-flash' },
      });

      expect(fetchMock.mock.calls[0][0]).toContain('/models/gemini-3.6-flash:generateContent');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBeUndefined();
      expect(body.generationConfig?.temperature).toBeUndefined();
      expect(response.cost).toBeCloseTo(0.0000525, 8);
    });

    it('validates Gemini usage totals and exposes valid tool-use usage without pricing it', async () => {
      mockFetch({
        json: () =>
          Promise.resolve(
            makeGeminiResponse('Hi', {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              thoughtsTokenCount: 2,
              toolUsePromptTokenCount: 3,
              totalTokenCount: 20,
            }),
          ),
      });
      const response = await new GeminiProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.6-flash',
      });
      expect(response.usage?.completion_tokens).toBe(5);
      expect(response.cost).toBeUndefined();
    });

    it('fails closed on mismatched total usage and on a near customtools suffix', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve(
            makeGeminiResponse('Hi', {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              totalTokenCount: 16,
            }),
          ),
      });
      const provider = new GeminiProvider();
      const malformed = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.6-flash',
      });
      expect(malformed.usage).toBeUndefined();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(makeGeminiResponse('Hi')),
        text: () => Promise.resolve(''),
      });
      const sibling = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.1-pro-preview-customtools-001',
      });
      expect(sibling.cost).toBeUndefined();
    });

    it('prices the exact Gemini 3.1 Pro customtools descriptor', async () => {
      mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Hi')) });
      const response = await new GeminiProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.1-pro-preview-customtools',
      });
      expect(response.cost).toBeCloseTo(0.00008, 8);
    });

    it('gives customtools the Gemini 3 low thinking floor and continuation safety', async () => {
      const fetchMock = mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Hi')) });
      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.1-pro-preview-customtools',
        effort: 'none',
      });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'low',
      });

      await expect(
        provider.chat(
          [
            { role: 'user', content: 'Hello' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 't', arguments: '{}' } },
              ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: '{}' },
          ],
          { model: 'gemini-3.1-pro-preview-customtools' },
        ),
      ).rejects.toThrow('require providerMetadata.geminiParts with thought signatures');
    });

    it('rejects a reused native functionCall id with a different name across replay turns', async () => {
      const fetchMock = mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Hi')) });
      const signedAssistant = (name: string, signature: string) => ({
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          { id: 'fc_reused', type: 'function' as const, function: { name, arguments: '{}' } },
        ],
        providerMetadata: {
          geminiParts: [
            { functionCall: { id: 'fc_reused', name, args: {} }, thoughtSignature: signature },
          ],
        },
      });
      await expect(
        new GeminiProvider().chat(
          [
            { role: 'user', content: 'First' },
            signedAssistant('first_tool', 'sig-1'),
            { role: 'tool', tool_call_id: 'fc_reused', content: '{}' },
            { role: 'user', content: 'Second' },
            signedAssistant('second_tool', 'sig-2'),
            { role: 'tool', tool_call_id: 'fc_reused', content: '{}' },
          ],
          { model: 'gemini-3.6-flash' },
        ),
      ).rejects.toThrow('native functionCall ids must be globally unique across a replay');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats fatal finish reasons as errors even when the candidate has partial text', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            ...makeGeminiResponse('partial'),
            candidates: [
              { content: { role: 'model', parts: [{ text: 'partial' }] }, finishReason: 'SAFETY' },
            ],
          }),
      });
      await expect(
        new GeminiProvider().chat([{ role: 'user', content: 'Hello' }], {
          model: 'gemini-3.6-flash',
        }),
      ).rejects.toThrow('non-success finish reason: SAFETY');
    });

    it('leaves custom-base, hosted-tool, and non-text calls unpriced', async () => {
      const provider = new GeminiProvider({
        apiKey: 'test-key',
        baseUrl: 'https://proxy.example/v1',
      });
      mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Hi')) });
      expect(
        (await provider.chat([{ role: 'user', content: 'Hello' }], { model: 'gemini-3.6-flash' }))
          .cost,
      ).toBeUndefined();

      mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Hi')) });
      expect(
        (
          await new GeminiProvider().chat([{ role: 'user', content: 'Hello' }], {
            model: 'gemini-3.6-flash',
            providerOptions: { tools: [{ googleSearch: {} }] },
          })
        ).cost,
      ).toBeUndefined();

      mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Hi')) });
      expect(
        (
          await new GeminiProvider().chat([{ role: 'user', content: 'Hello' }], {
            model: 'gemini-3.6-flash',
            providerOptions: {
              contents: [
                { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'abc' } }] },
              ],
            },
          })
        ).cost,
      ).toBeUndefined();

      mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Hi')) });
      expect(
        (
          await new GeminiProvider().chat([{ role: 'user', content: 'Hello' }], {
            model: 'gemini-3.6-flash',
            providerOptions: { cachedContent: 'cachedContents/example' },
          })
        ).cost,
      ).toBeUndefined();

      mockFetch({
        json: () =>
          Promise.resolve({
            ...makeGeminiResponse(''),
            candidates: [
              { content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png' } }] } },
            ],
          }),
      });
      expect(
        (
          await new GeminiProvider().chat([{ role: 'user', content: 'Hello' }], {
            model: 'gemini-3.6-flash',
          })
        ).cost,
      ).toBeUndefined();
    });

    it('handles API errors gracefully', async () => {
      mockFetch({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: { code: 400, message: 'Invalid argument', status: 'INVALID_ARGUMENT' },
            }),
          ),
      });

      const provider = new GeminiProvider();
      await expect(
        provider.chat([{ role: 'user', content: 'Hi' }], {
          model: 'gemini-2.0-flash',
        }),
      ).rejects.toThrow('Gemini API error (400): Invalid argument');
    });

    it('passes signal to fetch', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const controller = new AbortController();
      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.0-flash',
        signal: controller.signal,
      });

      expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
    });

    it('merges consecutive same-role messages', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat(
        [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tc_1',
                type: 'function' as const,
                function: { name: 'tool1', arguments: '{}' },
              },
              {
                id: 'tc_2',
                type: 'function' as const,
                function: { name: 'tool2', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', content: '{"r":"1"}', tool_call_id: 'tc_1' },
          { role: 'tool', content: '{"r":"2"}', tool_call_id: 'tc_2' },
        ],
        { model: 'gemini-2.0-flash' },
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Consecutive tool messages (mapped to user) should be merged
      const userMsgs = body.contents.filter((c: any) => c.role === 'user');
      const frMsg = userMsgs.find((c: any) => c.parts.some((p: any) => p.functionResponse));
      expect(frMsg).toBeDefined();
      const frParts = frMsg.parts.filter((p: any) => p.functionResponse);
      expect(frParts).toHaveLength(2);
    });

    it('maps toolChoice "required" to toolConfig with mode ANY', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.0-flash',
        tools: [
          {
            type: 'function',
            function: {
              name: 'search',
              description: 'Search',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        toolChoice: 'required',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.toolConfig).toEqual({
        functionCallingConfig: { mode: 'ANY' },
      });
    });

    it('maps toolChoice "none" to toolConfig with mode NONE', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.0-flash',
        toolChoice: 'none',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.toolConfig).toEqual({
        functionCallingConfig: { mode: 'NONE' },
      });
    });

    it('maps specific function toolChoice to allowedFunctionNames', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.0-flash',
        tools: [
          {
            type: 'function',
            function: {
              name: 'search',
              description: 'Search',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        toolChoice: { type: 'function', function: { name: 'search' } },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.toolConfig).toEqual({
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search'] },
      });
    });

    it('maps effort "high" to thinkingBudget for 2.x models', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-pro',
        effort: 'high',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 10000,
      });
    });

    it('maps effort "max" to thinkingBudget 32768 for gemini-2.5-pro', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-pro',
        effort: 'max',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 32768,
      });
    });

    it('does not infer the Gemini 2.5 Pro thinking limit for an unknown sibling', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-pro-preview',
        effort: 'max',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 24576,
      });
    });

    it('maps effort "max" to thinkingBudget 24576 for gemini-2.5-flash', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-flash',
        effort: 'max',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 24576,
      });
    });

    it('maps thinkingBudget to exact thinkingBudget for 2.x models', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-flash',
        thinkingBudget: 4000,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 4000,
      });
    });

    it('maps effort "xhigh" to thinkingBudget 16384 for 2.x models', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-pro',
        effort: 'xhigh',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // xhigh slots between high (10000) and max (24576) for 2.x
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 16384,
      });
    });

    it('maps effort "xhigh" to thinkingLevel "high" for 3.x models (no xhigh tier)', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.6-flash',
        effort: 'xhigh',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'high',
      });
    });

    it('maps effort "high" to thinkingLevel for 3.x models', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.1-flash-lite-preview',
        effort: 'high',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'high',
      });
    });

    it('maps effort "low" to thinkingLevel for 3.x models', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3-flash-preview',
        effort: 'low',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'low',
      });
    });

    it('maps effort "max" to thinkingLevel "high" for 3.x models (caps at high)', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.1-pro-preview',
        effort: 'max',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'high',
      });
    });

    it('maps thinkingBudget >5000 to thinkingLevel "high" for 3.x models', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.1-flash-lite-preview',
        thinkingBudget: 8000,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'high',
      });
    });

    it('maps thinkingBudget <=1024 to thinkingLevel "low" for 3.x models', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3-pro-preview',
        thinkingBudget: 512,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'low',
      });
    });

    it('maps thinkingBudget <=5000 to thinkingLevel "medium" for 3.x models', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.1-pro-preview',
        thinkingBudget: 3000,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'medium',
      });
    });

    it('maps thinkingBudget at boundary 1024 to thinkingLevel "low" for 3.x models', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3-flash-preview',
        thinkingBudget: 1024,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'low',
      });
    });

    it('maps thinkingBudget at boundary 5000 to thinkingLevel "medium" for 3.x models', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3-flash-preview',
        thinkingBudget: 5000,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'medium',
      });
    });

    it('maps effort "none" to thinkingLevel "low" on gemini-3.1-pro', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.1-pro-preview',
        effort: 'none',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // 3.1 Pro doesn't support 'minimal' — floor is 'low'
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'low',
      });
    });

    it('maps effort "none" to thinkingLevel "minimal" on gemini-3-flash', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3-flash-preview',
        effort: 'none',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'minimal',
      });
    });

    it('maps effort "none" to thinkingBudget 0 on gemini-2.5-pro', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-pro',
        effort: 'none',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 0,
      });
    });

    it('maps thinkingBudget 0 to thinkingLevel "low" on gemini-3.1-pro', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.1-pro-preview',
        thinkingBudget: 0,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Same as effort: 'none' — 3.1 Pro floors at 'low'
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'low',
      });
    });

    it('maps thinkingBudget 0 to thinkingLevel "minimal" on gemini-3-flash', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3-flash-preview',
        thinkingBudget: 0,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'minimal',
      });
    });

    it('positive thinkingBudget overrides effort "none" on 3.x', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3-flash-preview',
        effort: 'none',
        thinkingBudget: 5000,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Positive budget wins over effort: 'none' → maps to nearest thinkingLevel
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'medium',
      });
    });

    it('positive thinkingBudget overrides effort "none" on 2.x', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-pro',
        effort: 'none',
        thinkingBudget: 5000,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Positive budget wins over effort: 'none'
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 5000,
      });
    });

    it('merges providerOptions into request body (shallow merge)', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-flash',
        temperature: 0.5,
        providerOptions: {
          generationConfig: { topK: 40 },
          safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
        },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Shallow merge: providerOptions.generationConfig REPLACES the computed one
      expect(body.generationConfig).toEqual({ topK: 40 });
      // Additional fields are added
      expect(body.safetySettings).toEqual([
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      ]);
    });

    it('does not include thinkingConfig when no effort/thinkingBudget/includeThoughts set', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-flash',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig?.thinkingConfig).toBeUndefined();
    });

    it('sends includeThoughts with thinkingLevel for 3.x models when thinkingBudget also set', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3-flash-preview',
        thinkingBudget: 3000,
        includeThoughts: true,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: 'medium',
        includeThoughts: true,
      });
    });

    it('does not include thinkingConfig when thinking is undefined', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-pro',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig).toBeUndefined();
    });

    it('parses thoughtsTokenCount into reasoning_tokens', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'thought result' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 50,
              totalTokenCount: 200,
              thoughtsTokenCount: 50,
            },
          }),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Think' }], {
        model: 'gemini-3.1-flash-lite-preview',
      });

      expect(response.usage?.reasoning_tokens).toBe(50);
    });

    it('omits reasoning_tokens when thoughtsTokenCount is 0 or absent', async () => {
      mockFetch({
        json: () =>
          Promise.resolve(
            makeGeminiResponse('Hi', {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              totalTokenCount: 15,
            }),
          ),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.0-flash',
      });

      expect(response.usage?.reasoning_tokens).toBeUndefined();
    });

    it('does not include toolConfig when toolChoice is undefined', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.0-flash',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.toolConfig).toBeUndefined();
    });

    it('maps tool definitions to functionDeclarations', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.0-flash',
        tools: [
          {
            type: 'function',
            function: {
              name: 'search',
              description: 'Search the web',
              parameters: { type: 'object', properties: { q: { type: 'string' } } },
            },
          },
        ],
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].functionDeclarations).toHaveLength(1);
      expect(body.tools[0].functionDeclarations[0].name).toBe('search');
      expect(body.tools[0].functionDeclarations[0].description).toBe('Search the web');
    });

    it('sends includeThoughts in thinkingConfig when includeThoughts: true', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-flash',
        includeThoughts: true,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        includeThoughts: true,
      });
    });

    it('sends both thinkingBudget and includeThoughts in thinkingConfig', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-flash',
        thinkingBudget: 5000,
        includeThoughts: true,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingBudget: 5000,
        includeThoughts: true,
      });
    });

    it('populates thinking_content from response parts with thought: true', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    { text: 'Let me think about this...', thought: true },
                    { text: 'Here is my answer.' },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
          }),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Think about this' }], {
        model: 'gemini-2.5-flash',
      });

      expect(response.thinking_content).toBe('Let me think about this...');
      expect(response.content).toBe('Here is my answer.');
    });

    it('does not set thinking_content when no thought parts are present', async () => {
      mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('Just a normal response')),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-2.5-flash',
      });

      expect(response.thinking_content).toBeUndefined();
      expect(response.content).toBe('Just a normal response');
    });

    it('concatenates multiple thought parts into thinking_content', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    { text: 'First thought. ', thought: true },
                    { text: 'Second thought.', thought: true },
                    { text: 'Final answer.' },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 30, totalTokenCount: 40 },
          }),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Think hard' }], {
        model: 'gemini-2.5-flash',
      });

      expect(response.thinking_content).toBe('First thought. Second thought.');
      expect(response.content).toBe('Final answer.');
    });
  });

  describe('schema sanitization (Gemini API rejects standard JSON Schema fields)', () => {
    // Gemini's API rejects fields like `additionalProperties`, `$schema`,
    // `oneOf`, etc. that Zod v4's `z.toJSONSchema()` emits by default.
    // Without sanitization, every Zod-defined tool would 400 on first call
    // with "Unknown name 'additionalProperties' at 'tools[0].function_
    // declarations[0].parameters'". These tests pin the strip behavior at
    // the wire layer so the failure can't regress.

    it('strips additionalProperties from tool function parameters at every depth', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gemini-2.0-flash',
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Look up a thing',
              // Mirrors the exact shape Zod v4 emits for nested objects + arrays.
              parameters: {
                type: 'object',
                properties: {
                  outer: { type: 'string' },
                  nested: {
                    type: 'object',
                    properties: { inner: { type: 'number' } },
                    required: ['inner'],
                    additionalProperties: false,
                  },
                  list: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { x: { type: 'boolean' } },
                      required: ['x'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['outer', 'nested', 'list'],
                additionalProperties: false,
              },
            },
          },
        ],
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const params = body.tools[0].functionDeclarations[0].parameters;
      // Walk the whole tree and assert NO additionalProperties survived.
      const stack: unknown[] = [params];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          expect(node).not.toHaveProperty('additionalProperties');
          for (const v of Object.values(node)) stack.push(v);
        } else if (Array.isArray(node)) {
          for (const v of node) stack.push(v);
        }
      }
      // Sanity: real fields survive.
      expect(params.type).toBe('object');
      expect(params.properties.outer.type).toBe('string');
      expect(params.properties.nested.properties.inner.type).toBe('number');
      expect(params.properties.list.items.properties.x.type).toBe('boolean');
    });

    it('strips $schema, $ref, $defs, allOf, not, patternProperties, unevaluated* from tool parameters', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gemini-2.0-flash',
        tools: [
          {
            type: 'function',
            function: {
              name: 't',
              description: 'd',
              parameters: {
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                $defs: { Foo: { type: 'object' } },
                $ref: '#/$defs/Foo',
                type: 'object',
                properties: {
                  field: {
                    allOf: [{ type: 'string' }],
                    not: { type: 'null' },
                    patternProperties: { '^x': { type: 'string' } },
                    unevaluatedProperties: false,
                    unevaluatedItems: false,
                  },
                },
              },
            },
          },
        ],
      });

      const params = JSON.parse(fetchMock.mock.calls[0][1].body).tools[0].functionDeclarations[0]
        .parameters;
      for (const banned of [
        '$schema',
        '$defs',
        '$ref',
        'allOf',
        'not',
        'patternProperties',
        'unevaluatedProperties',
        'unevaluatedItems',
      ]) {
        // Walk the whole tree and assert no occurrence anywhere.
        const stack: unknown[] = [params];
        while (stack.length > 0) {
          const node = stack.pop();
          if (node && typeof node === 'object' && !Array.isArray(node)) {
            expect(node, `${banned} should be stripped from every node`).not.toHaveProperty(banned);
            for (const v of Object.values(node)) stack.push(v);
          } else if (Array.isArray(node)) {
            for (const v of node) stack.push(v);
          }
        }
      }
    });

    it('translates oneOf → anyOf so z.discriminatedUnion still works', async () => {
      // Regression: stripping oneOf entirely (the naive fix) would erase
      // the union shape that `z.discriminatedUnion` produces — Gemini
      // would have no schema for the field. Translate to anyOf instead;
      // the two are semantically identical for tool-use because the
      // discriminator field already enforces mutual exclusion.
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gemini-2.0-flash',
        tools: [
          {
            type: 'function',
            function: {
              name: 't',
              description: 'd',
              // Mirrors what `z.discriminatedUnion('kind', [...])` emits.
              parameters: {
                oneOf: [
                  {
                    type: 'object',
                    properties: { kind: { type: 'string', const: 'a' }, x: { type: 'string' } },
                    required: ['kind', 'x'],
                    additionalProperties: false,
                  },
                  {
                    type: 'object',
                    properties: { kind: { type: 'string', const: 'b' }, y: { type: 'number' } },
                    required: ['kind', 'y'],
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
        ],
      });

      const params = JSON.parse(fetchMock.mock.calls[0][1].body).tools[0].functionDeclarations[0]
        .parameters;
      // oneOf gone, anyOf present with both branches
      expect(params).not.toHaveProperty('oneOf');
      expect(params.anyOf).toHaveLength(2);
      // Branches recursed into: additionalProperties stripped, const → enum translated
      expect(params.anyOf[0]).not.toHaveProperty('additionalProperties');
      expect(params.anyOf[0].properties.kind).not.toHaveProperty('const');
      expect(params.anyOf[0].properties.kind.enum).toEqual(['a']);
      expect(params.anyOf[1].properties.kind.enum).toEqual(['b']);
      // Real fields survive.
      expect(params.anyOf[0].properties.x.type).toBe('string');
      expect(params.anyOf[1].properties.y.type).toBe('number');
    });

    it('translates const → enum so z.literal still works', async () => {
      // Regression: stripping const entirely would lose the literal
      // constraint. Translate to enum with a single value — Gemini's
      // supported equivalent.
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gemini-2.0-flash',
        tools: [
          {
            type: 'function',
            function: {
              name: 't',
              description: 'd',
              parameters: {
                type: 'object',
                properties: {
                  // z.literal('foo') → { type: 'string', const: 'foo' }
                  literalField: { type: 'string', const: 'foo' },
                  // z.literal(42)
                  numLiteral: { type: 'number', const: 42 },
                },
              },
            },
          },
        ],
      });

      const params = JSON.parse(fetchMock.mock.calls[0][1].body).tools[0].functionDeclarations[0]
        .parameters;
      expect(params.properties.literalField).not.toHaveProperty('const');
      expect(params.properties.literalField.enum).toEqual(['foo']);
      expect(params.properties.numLiteral.enum).toEqual([42]);
    });

    it('does NOT clobber an explicit enum when const is also present', async () => {
      // Defensive: if a schema author explicitly wrote `enum`, don't let
      // the const→enum translation overwrite it.
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gemini-2.0-flash',
        tools: [
          {
            type: 'function',
            function: {
              name: 't',
              description: 'd',
              parameters: {
                type: 'string',
                enum: ['x', 'y', 'z'],
                const: 'shouldNotWin', // ← const is dropped silently
              },
            },
          },
        ],
      });

      const params = JSON.parse(fetchMock.mock.calls[0][1].body).tools[0].functionDeclarations[0]
        .parameters;
      expect(params.enum).toEqual(['x', 'y', 'z']); // explicit wins
      expect(params).not.toHaveProperty('const');
    });

    it('preserves anyOf (Gemini supports it) and recurses into its branches', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gemini-2.0-flash',
        tools: [
          {
            type: 'function',
            function: {
              name: 't',
              description: 'd',
              parameters: {
                type: 'object',
                properties: {
                  union: {
                    anyOf: [
                      { type: 'string' },
                      {
                        type: 'object',
                        properties: { y: { type: 'number' } },
                        additionalProperties: false, // ← must be stripped from inside anyOf
                      },
                    ],
                  },
                },
                additionalProperties: false,
              },
            },
          },
        ],
      });

      const params = JSON.parse(fetchMock.mock.calls[0][1].body).tools[0].functionDeclarations[0]
        .parameters;
      expect(params.properties.union.anyOf).toHaveLength(2);
      expect(params.properties.union.anyOf[0]).toEqual({ type: 'string' });
      expect(params.properties.union.anyOf[1].properties.y.type).toBe('number');
      expect(params.properties.union.anyOf[1]).not.toHaveProperty('additionalProperties');
    });

    it('strips disallowed fields from responseSchema (structured output path)', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('{"a":1}')),
      });

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Give me JSON' }], {
        model: 'gemini-2.0-flash',
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'Out',
            schema: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
              properties: { a: { type: 'number' } },
              required: ['a'],
              additionalProperties: false,
            },
          },
        },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      const schema = body.generationConfig.responseSchema;
      expect(schema).not.toHaveProperty('additionalProperties');
      expect(schema).not.toHaveProperty('$schema');
      // Real fields survive.
      expect(schema.type).toBe('object');
      expect(schema.properties.a.type).toBe('number');
      expect(schema.required).toEqual(['a']);
    });

    it('passes through schemas that have no disallowed fields untouched', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('ok')),
      });

      const clean = {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'a name' },
          age: { type: 'integer', minimum: 0 },
        },
        required: ['name'],
      };

      const provider = new GeminiProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gemini-2.0-flash',
        tools: [
          {
            type: 'function',
            function: { name: 't', description: 'd', parameters: clean },
          },
        ],
      });

      const params = JSON.parse(fetchMock.mock.calls[0][1].body).tools[0].functionDeclarations[0]
        .parameters;
      expect(params).toEqual(clean);
    });
  });

  describe('stream()', () => {
    it('sends correct URL with alt=sse', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = makeGeminiResponse('Hello');
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          controller.close();
        },
      });

      const fetchMock = mockFetch({ body: stream });

      const provider = new GeminiProvider();
      const gen = provider.stream([{ role: 'user', content: 'Hi' }], { model: 'gemini-2.0-flash' });

      // Consume stream
      const chunks: any[] = [];
      for await (const c of gen) {
        chunks.push(c);
      }

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/models/gemini-2.0-flash:streamGenerateContent?alt=sse');
    });

    it('yields text_delta and done chunks', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk1 = {
            candidates: [{ content: { role: 'model', parts: [{ text: 'Hello ' }] } }],
          };
          const chunk2 = {
            candidates: [{ content: { role: 'model', parts: [{ text: 'world' }] } }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk1)}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk2)}\n\n`));
          controller.close();
        },
      });

      mockFetch({ body: stream });

      const provider = new GeminiProvider();
      const gen = provider.stream([{ role: 'user', content: 'Hi' }], { model: 'gemini-2.0-flash' });

      const chunks: any[] = [];
      for await (const c of gen) {
        chunks.push(c);
      }

      expect(chunks[0]).toEqual({ type: 'text_delta', content: 'Hello ' });
      expect(chunks[1]).toEqual({ type: 'text_delta', content: 'world' });
      // Last chunk should be done with usage
      const done = chunks[chunks.length - 1];
      expect(done.type).toBe('done');
      expect(done.usage).toEqual({
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
      });
    });

    it('keeps newest-family streamed usage and billing aligned with non-streaming', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                modelVersion: 'gemini-3.6-flash',
                candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }] } }],
                usageMetadata: {
                  promptTokenCount: 100,
                  candidatesTokenCount: 10,
                  thoughtsTokenCount: 20,
                  totalTokenCount: 130,
                  serviceTier: 'standard',
                },
              })}\n\n`,
            ),
          );
          controller.close();
        },
      });

      mockFetch({ body: stream });
      const provider = new GeminiProvider();
      const chunks: any[] = [];
      for await (const chunk of provider.stream([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.5-flash-lite',
      })) {
        chunks.push(chunk);
      }

      const done = chunks.at(-1);
      expect(done.usage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 130,
        reasoning_tokens: 20,
      });
      expect(done.cost).toBeCloseTo(0.000375, 8);
    });

    it('leaves streamed usage unpriced when candidate count is omitted', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                modelVersion: 'gemini-3.6-flash',
                candidates: [
                  {
                    content: { role: 'model', parts: [{ thought: true, text: 'thinking' }] },
                    finishReason: 'MAX_TOKENS',
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 3,
                  thoughtsTokenCount: 60,
                  totalTokenCount: 63,
                  serviceTier: 'standard',
                },
              })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      mockFetch({ body: stream });
      const chunks: any[] = [];
      for await (const chunk of new GeminiProvider().stream([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.6-flash',
      })) {
        chunks.push(chunk);
      }
      expect(chunks.at(-1).usage).toBeUndefined();
      expect(chunks.at(-1).cost).toBeUndefined();
    });

    it('never recovers stream pricing after conflicting tier evidence', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                usageMetadata: { serviceTier: 'SERVICE_TIER_STANDARD' },
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }] } }],
                usageMetadata: {
                  promptTokenCount: 10,
                  candidatesTokenCount: 5,
                  totalTokenCount: 15,
                  serviceTier: 'SERVICE_TIER_FLEX',
                },
              })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      mockFetch({ body: stream });
      const chunks: any[] = [];
      for await (const chunk of new GeminiProvider().stream([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.6-flash',
      })) {
        chunks.push(chunk);
      }
      expect(chunks.at(-1).cost).toBeUndefined();
    });

    it('keeps valid streamed tool-use usage but leaves its separate billing unpriced', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }] } }],
                usageMetadata: {
                  promptTokenCount: 10,
                  candidatesTokenCount: 5,
                  toolUsePromptTokenCount: 1,
                  totalTokenCount: 16,
                  serviceTier: 'SERVICE_TIER_STANDARD',
                },
              })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      mockFetch({ body: stream });
      const chunks: any[] = [];
      for await (const chunk of new GeminiProvider().stream([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.6-flash',
      })) {
        chunks.push(chunk);
      }
      expect(chunks.at(-1).usage?.total_tokens).toBe(16);
      expect(chunks.at(-1).cost).toBeUndefined();
    });

    it('throws on a fatal streamed finish reason even after partial text', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                candidates: [
                  {
                    content: { role: 'model', parts: [{ text: 'partial' }] },
                    finishReason: 'SAFETY',
                  },
                ],
              })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      mockFetch({ body: stream });
      await expect(async () => {
        for await (const chunk of new GeminiProvider().stream(
          [{ role: 'user', content: 'Hello' }],
          {
            model: 'gemini-3.6-flash',
          },
        )) {
          expect(chunk.type).toBe('text_delta');
        }
      }).rejects.toThrow('non-success finish reason: SAFETY');
    });

    it('rejects a newest-family terminal model prefill before a stream fetch', async () => {
      const fetchMock = mockFetch({});
      const provider = new GeminiProvider();
      const messages = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Prefilled answer' },
      ];
      const originalMessages = structuredClone(messages);

      await expect(async () => {
        for await (const chunk of provider.stream(messages, { model: 'gemini-3.5-flash-lite' })) {
          expect(chunk).toBeUndefined();
        }
      }).rejects.toThrow('does not support a terminal assistant/model prefill');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(messages).toEqual(originalMessages);
    });

    it('yields tool_call_delta for functionCall chunks', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ functionCall: { name: 'search', args: { q: 'test' } } }],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          controller.close();
        },
      });

      mockFetch({ body: stream });

      const provider = new GeminiProvider();
      const gen = provider.stream([{ role: 'user', content: 'Search' }], {
        model: 'gemini-2.0-flash',
      });

      const chunks: any[] = [];
      for await (const c of gen) {
        chunks.push(c);
      }

      expect(chunks[0]).toEqual({
        type: 'tool_call_delta',
        id: 'call_0',
        name: 'search',
        arguments: '{"q":"test"}',
      });
    });

    it('preserves functionCall.id from Gemini 3.6 Flash responses (streaming)', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ functionCall: { id: 'fc_abc', name: 'search', args: { q: 'test' } } }],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          controller.close();
        },
      });

      mockFetch({ body: stream });

      const provider = new GeminiProvider();
      const gen = provider.stream([{ role: 'user', content: 'Search' }], {
        model: 'gemini-3.6-flash',
      });

      const chunks: any[] = [];
      for await (const c of gen) {
        chunks.push(c);
      }

      const toolDelta = chunks.find((c) => c.type === 'tool_call_delta');
      expect(toolDelta).toBeDefined();
      expect(toolDelta.id).toBe('fc_abc');
      expect(toolDelta.name).toBe('search');
    });

    it('continues parallel calls from stream-derived signed metadata with an exact response group', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts: [
                        {
                          functionCall: { id: 'fc_a', name: 'tool_a', args: {} },
                          thoughtSignature: 'sig-a',
                        },
                        { functionCall: { id: 'fc_b', name: 'tool_b', args: {} } },
                      ],
                    },
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 10,
                  candidatesTokenCount: 5,
                  totalTokenCount: 15,
                  serviceTier: 'SERVICE_TIER_STANDARD',
                },
              })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      mockFetch({ body: stream });
      const streamed: any[] = [];
      for await (const chunk of new GeminiProvider().stream([{ role: 'user', content: 'Hello' }], {
        model: 'gemini-3.6-flash',
      })) {
        streamed.push(chunk);
      }
      const metadata = streamed.at(-1).providerMetadata;

      const fetchMock = mockFetch({ json: () => Promise.resolve(makeGeminiResponse('Done')) });
      await new GeminiProvider().chat(
        [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'fc_a', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'fc_b', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
            ],
            providerMetadata: metadata,
          },
          { role: 'tool', tool_call_id: 'fc_a', content: '{}' },
          { role: 'tool', tool_call_id: 'fc_b', content: '{}' },
        ],
        { model: 'gemini-3.6-flash' },
      );

      const parts = JSON.parse(fetchMock.mock.calls[0][1].body).contents.at(-1).parts;
      expect(parts.map((part: any) => part.functionResponse)).toEqual([
        { id: 'fc_a', name: 'tool_a', response: {} },
        { id: 'fc_b', name: 'tool_b', response: {} },
      ]);
    });

    it('yields thinking_delta for thought parts and text_delta for regular parts', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const thoughtChunk = {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'Reasoning about the problem...', thought: true }],
                },
              },
            ],
          };
          const textChunk = {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'Here is the answer.' }],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15, totalTokenCount: 25 },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(thoughtChunk)}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(textChunk)}\n\n`));
          controller.close();
        },
      });

      mockFetch({ body: stream });

      const provider = new GeminiProvider();
      const gen = provider.stream([{ role: 'user', content: 'Think' }], {
        model: 'gemini-2.5-flash',
      });

      const chunks: any[] = [];
      for await (const c of gen) {
        chunks.push(c);
      }

      expect(chunks[0]).toEqual({
        type: 'thinking_delta',
        content: 'Reasoning about the problem...',
      });
      expect(chunks[1]).toEqual({ type: 'text_delta', content: 'Here is the answer.' });
      expect(chunks[2].type).toBe('done');
    });

    it('includes accumulated raw parts in done chunk providerMetadata', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'Hello', thoughtSignature: 'opaque-sig-data' }],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          controller.close();
        },
      });

      mockFetch({ body: stream });

      const provider = new GeminiProvider();
      const gen = provider.stream([{ role: 'user', content: 'Hi' }], {
        model: 'gemini-3.6-flash',
      });

      const chunks: any[] = [];
      for await (const c of gen) {
        chunks.push(c);
      }

      const done = chunks[chunks.length - 1];
      expect(done.type).toBe('done');
      expect(done.providerMetadata).toBeDefined();
      expect(done.providerMetadata.geminiParts).toHaveLength(1);
      expect(done.providerMetadata.geminiParts[0].thoughtSignature).toBe('opaque-sig-data');
    });
  });

  describe('providerMetadata / thought signature round-trip', () => {
    it('parseResponse includes providerMetadata.geminiParts when response has parts', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'Hello', thoughtSignature: 'sig-abc-123' }],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          }),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gemini-3-pro-preview',
      });

      expect(response.content).toBe('Hello');
      expect(response.providerMetadata).toBeDefined();
      expect(response.providerMetadata!.geminiParts).toEqual([
        { text: 'Hello', thoughtSignature: 'sig-abc-123' },
      ]);
    });

    it('parseResponse includes providerMetadata for functionCall parts with signatures', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: { name: 'search', args: { q: 'test' } },
                      thoughtSignature: 'sig-fc-456',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          }),
      });

      const provider = new GeminiProvider();
      const response = await provider.chat([{ role: 'user', content: 'Search' }], {
        model: 'gemini-3-pro-preview',
      });

      expect(response.tool_calls).toHaveLength(1);
      expect(response.providerMetadata!.geminiParts).toEqual([
        { functionCall: { name: 'search', args: { q: 'test' } }, thoughtSignature: 'sig-fc-456' },
      ]);
    });

    it('mapMessages uses raw geminiParts from providerMetadata when available', async () => {
      const rawParts = [
        { text: '', thoughtSignature: 'sig-round-trip' },
        {
          functionCall: { id: 'tc_1', name: 'search', args: { q: 'test' } },
          thoughtSignature: 'sig-fc',
        },
      ];

      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('Done')),
      });

      const provider = new GeminiProvider();
      await provider.chat(
        [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tc_1',
                type: 'function' as const,
                function: { name: 'search', arguments: '{"q":"test"}' },
              },
            ],
            providerMetadata: { geminiParts: rawParts },
          },
          { role: 'tool', content: '{"result":"data"}', tool_call_id: 'tc_1' },
        ],
        { model: 'gemini-3-pro-preview' },
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const modelMsg = body.contents.find((c: any) => c.role === 'model');
      expect(modelMsg).toBeDefined();
      // Should use raw parts directly, preserving thoughtSignature
      expect(modelMsg.parts).toEqual(rawParts);
    });

    it('mapMessages reconstructs parts when providerMetadata is absent (backward compat)', async () => {
      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('Done')),
      });

      const provider = new GeminiProvider();
      await provider.chat(
        [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: 'Some text',
            tool_calls: [
              {
                id: 'tc_1',
                type: 'function' as const,
                function: { name: 'get_data', arguments: '{}' },
              },
            ],
            // No providerMetadata — backward compatibility
          },
          { role: 'tool', content: '{"result":"data"}', tool_call_id: 'tc_1' },
        ],
        { model: 'gemini-2.0-flash' },
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const modelMsg = body.contents.find((c: any) => c.role === 'model');
      expect(modelMsg).toBeDefined();
      // Should reconstruct parts from content + tool_calls
      expect(modelMsg.parts[0].text).toBe('Some text');
      expect(modelMsg.parts[1].functionCall).toEqual({ name: 'get_data', args: {} });
      // No thoughtSignature or other opaque fields
      expect(modelMsg.parts[0].thoughtSignature).toBeUndefined();
    });

    it('preserves multiple opaque fields through round-trip', async () => {
      const rawParts = [
        {
          text: 'I will help you.',
          thoughtSignature: 'sig-1',
          inlineDataSignature: 'data-sig-2',
        },
      ];

      const fetchMock = mockFetch({
        json: () => Promise.resolve(makeGeminiResponse('Done')),
      });

      const provider = new GeminiProvider();
      await provider.chat(
        [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: 'I will help you.',
            providerMetadata: { geminiParts: rawParts },
          },
          { role: 'user', content: 'Thanks' },
        ],
        { model: 'gemini-3-pro-preview' },
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const modelMsg = body.contents.find((c: any) => c.role === 'model');
      expect(modelMsg.parts).toEqual(rawParts);
      // Both opaque fields preserved
      expect(modelMsg.parts[0].thoughtSignature).toBe('sig-1');
      expect(modelMsg.parts[0].inlineDataSignature).toBe('data-sig-2');
    });
  });
});
