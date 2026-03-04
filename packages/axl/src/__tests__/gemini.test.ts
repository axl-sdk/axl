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
  },
) {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: usage ?? { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
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
      await provider.chat([{ role: 'user', content: 'Hi' }], { model: 'gemini-2.0-flash' });

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('/models/gemini-2.0-flash:generateContent');
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
        model: 'gemini-2.0-flash',
      });

      // gemini-2.0-flash: [0.1e-6, 0.4e-6]
      // Expected: 100 * 0.1e-6 + 50 * 0.4e-6 = 0.00001 + 0.00002 = 0.00003
      expect(response.cost).toBeCloseTo(0.00003, 8);
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
        model: 'gemini-2.0-flash',
      });

      // gemini-2.0-flash: [0.1e-6, 0.4e-6]
      // Non-cached input: 200 * 0.1e-6 = 0.00002
      // Cached input:     800 * 0.1e-6 * 0.1 = 0.000008
      // Output:           50 * 0.4e-6 = 0.00002
      // Total: 0.000048
      expect(response.cost).toBeCloseTo(0.000048, 8);
      expect(response.usage).toEqual({
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
        cached_tokens: 800,
      });
    });

    it('returns cost: 0 for unknown models (not undefined)', async () => {
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

      expect(response.cost).toBe(0);
      expect(response.cost).not.toBeUndefined();
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
  });
});
