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

    it('estimates cost for gemini-3.1 models', async () => {
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
        model: 'gemini-3.1-flash-lite-preview',
      });

      // gemini-3.1-flash-lite-preview: [0.25e-6, 1.5e-6]
      // Expected: 100 * 0.25e-6 + 50 * 1.5e-6 = 0.000025 + 0.000075 = 0.0001
      expect(response.cost).toBeCloseTo(0.0001, 8);
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

    it('prefers longer prefix matches for versioned model names', async () => {
      // gemini-2.5-flash-lite-preview-0520 should match gemini-2.5-flash-lite (0.1e-6 input),
      // not the shorter gemini-2.5-flash prefix (0.3e-6 input — a 3x overcharge).
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

      // Should match gemini-2.5-flash-lite: [0.1e-6, 0.4e-6]
      // NOT gemini-2.5-flash: [0.3e-6, 2.5e-6]
      // Expected: 1000 * 0.1e-6 = 0.0001
      expect(response.cost).toBeCloseTo(0.0001, 8);
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

    it('maps effort "max" to thinkingBudget 32768 for gemini-2.5-pro-preview (prefix match)', async () => {
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
        thinkingBudget: 32768,
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
        model: 'gemini-3-pro-preview',
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
        { functionCall: { name: 'search', args: { q: 'test' } }, thoughtSignature: 'sig-fc' },
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
