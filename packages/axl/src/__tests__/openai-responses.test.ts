import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';

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

function getRequestBody(fetchMock: ReturnType<typeof mockFetch>): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

function makeSSEStream(
  events: Array<{ event: string; data: unknown }>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
      } else {
        controller.close();
      }
    },
  });
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('OpenAIResponsesProvider', () => {
  it('throws when no API key is provided', () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => new OpenAIResponsesProvider()).toThrow('OpenAI API key is required');
  });

  it('has name "openai-responses"', () => {
    const provider = new OpenAIResponsesProvider();
    expect(provider.name).toBe('openai-responses');
  });

  describe('chat() — message mapping', () => {
    it('maps system messages to instructions', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Hello!' }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat(
        [
          { role: 'system', content: 'Be helpful.' },
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hi' },
        ],
        { model: 'gpt-4o', maxTokens: 1024 },
      );

      const body = getRequestBody(fetchMock);
      expect(body.instructions).toBe('Be helpful.\nBe concise.');
      const input = body.input as Array<{ type: string; role?: string }>;
      expect(input).toHaveLength(1);
      expect(input[0]).toEqual({ type: 'message', role: 'user', content: 'Hi' });
    });

    it('maps tool results to function_call_output', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Done' }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat(
        [
          { role: 'user', content: 'Run the tool' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"SF"}' },
              },
            ],
          },
          { role: 'tool', content: '72°F', tool_call_id: 'call_abc' },
        ],
        { model: 'gpt-4o', maxTokens: 1024 },
      );

      const body = getRequestBody(fetchMock);
      const input = body.input as any[];
      expect(input).toEqual([
        { type: 'message', role: 'user', content: 'Run the tool' },
        {
          type: 'function_call',
          call_id: 'call_abc',
          name: 'get_weather',
          arguments: '{"city":"SF"}',
        },
        { type: 'function_call_output', call_id: 'call_abc', output: '72°F' },
      ]);
    });

    it('includes assistant text message when it has both content and tool_calls', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat(
        [
          { role: 'user', content: 'Do stuff' },
          {
            role: 'assistant',
            content: 'Let me call the tool',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'my_tool', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', content: 'result', tool_call_id: 'call_1' },
        ],
        { model: 'gpt-4o', maxTokens: 1024 },
      );

      const body = getRequestBody(fetchMock);
      const input = body.input as any[];
      // Should include the assistant message text + function_call + function_call_output
      expect(input[1]).toEqual({
        type: 'message',
        role: 'assistant',
        content: 'Let me call the tool',
      });
      expect(input[2]).toEqual({
        type: 'function_call',
        call_id: 'call_1',
        name: 'my_tool',
        arguments: '{}',
      });
    });
  });

  describe('chat() — tool definition format', () => {
    it('flattens nested function format to flat Responses API format', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'test' }], {
        model: 'gpt-5.6-terra',
        maxTokens: 1024,
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather for a city',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
              strict: true,
            },
          },
        ],
      });

      const body = getRequestBody(fetchMock);
      const tools = body.tools as any[];
      expect(tools).toEqual([
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
          strict: true,
        },
      ]);
    });
  });

  describe('chat() — response parsing', () => {
    it('extracts text content from output message', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  { type: 'output_text', text: 'Hello ' },
                  { type: 'output_text', text: 'world!' },
                ],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
      });

      expect(response.content).toBe('Hello world!');
    });

    it('extracts tool calls from function_call output items', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [
              {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_abc',
                name: 'get_weather',
                arguments: '{"city":"NYC"}',
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      const response = await provider.chat([{ role: 'user', content: 'weather?' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
      });

      expect(response.content).toBe('');
      expect(response.tool_calls).toEqual([
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
        },
      ]);
    });

    it('maps usage fields correctly (input_tokens → prompt_tokens)', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              total_tokens: 150,
              output_tokens_details: { reasoning_tokens: 30 },
              input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
            },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
      });

      expect(response.usage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        reasoning_tokens: 30,
        cached_tokens: 20,
        cache_write_tokens: 10,
      });
    });

    it('estimates cost using shared pricing table', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
      });

      // gpt-4o: [2.5e-6, 10e-6] → 100*2.5e-6 + 50*10e-6 = 0.00075
      expect(response.cost).toBeCloseTo(0.00075, 5);
    });

    it('discounts cached tokens at 50% of input rate', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: {
              input_tokens: 1000,
              output_tokens: 50,
              total_tokens: 1050,
              input_tokens_details: { cached_tokens: 800 },
            },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
      });

      // gpt-4o: [2.5e-6, 10e-6]
      // Non-cached input: 200 * 2.5e-6 = 0.0005
      // Cached input:     800 * 2.5e-6 * 0.5 = 0.001
      // Output:           50 * 10e-6 = 0.0005
      // Total: 0.002
      expect(response.cost).toBeCloseTo(0.002, 5);
    });
  });

  describe('chat() — request options', () => {
    it('prices the fully merged providerOptions model and leaves a requested non-Standard tier unpriced', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          }),
      });
      const provider = new OpenAIResponsesProvider();
      const priced = await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        providerOptions: { model: 'gpt-5.6-luna' },
      });
      expect(getRequestBody(fetchMock).model).toBe('gpt-5.6-luna');
      expect(priced.cost).toBeCloseTo(32e-6, 12);

      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_2',
            output: [],
            usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          }),
      });
      const unpriced = await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-5.6-luna',
        providerOptions: { service_tier: 'flex' },
      });
      expect(unpriced.cost).toBeUndefined();
    });

    it('fails closed on providerOptions Responses image input', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp-image',
            output: [],
            usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          }),
      });
      const response = await new OpenAIResponsesProvider().chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        providerOptions: {
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_image', image_url: 'https://example.test/image.png' }],
            },
          ],
        },
      });
      expect(response.cost).toBeUndefined();
    });

    it('fails closed on opaque Responses context references', async () => {
      for (const providerOptions of [
        { previous_response_id: 'resp_previous' },
        { conversation: 'conv_123' },
        { prompt: 'pmpt_123' },
      ]) {
        mockFetch({
          json: () =>
            Promise.resolve({
              id: 'resp-opaque-context',
              output: [],
              usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
            }),
        });
        const response = await new OpenAIResponsesProvider().chat(
          [{ role: 'user', content: 'Hi' }],
          {
            model: 'gpt-4o',
            providerOptions,
          },
        );
        expect(response.cost).toBeUndefined();
      }
    });

    it('prices text-only modalities and native custom client-tool inputs', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp-custom-tool',
            output: [],
            usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          }),
      });
      const response = await new OpenAIResponsesProvider().chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        providerOptions: {
          modalities: ['text'],
          tools: [{ type: 'custom', name: 'run_code' }],
          input: [
            { type: 'custom_tool_call', call_id: 'call_1', name: 'run_code', input: 'print(1)' },
            { type: 'custom_tool_call_output', call_id: 'call_1', output: '1' },
          ],
        },
      });
      expect(response.cost).toBeCloseTo(0.00035, 12);
    });

    it('does not apply direct-OpenAI pricing through a custom base URL or hosted tool', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });
      const custom = await new OpenAIResponsesProvider({
        baseUrl: 'https://proxy.example/v1',
      }).chat([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' });
      expect(custom.cost).toBeUndefined();

      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_2',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });
      const hostedTool = await new OpenAIResponsesProvider().chat(
        [{ role: 'user', content: 'Hi' }],
        {
          model: 'gpt-4o',
          providerOptions: { tools: [{ type: 'web_search' }] },
        },
      );
      expect(hostedTool.cost).toBeUndefined();
    });

    it('sends store: false by default', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
      });

      const body = getRequestBody(fetchMock);
      expect(body.store).toBe(false);
    });

    it('passes reasoning as { effort } for reasoning models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
        effort: 'high',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning).toEqual({ effort: 'high' });
    });

    it('maps effort "max" to "high" on o3 (xhigh not supported pre-gpt-5.4)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'o3',
        maxTokens: 1024,
        effort: 'max',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning).toEqual({ effort: 'high' });
    });

    it('maps effort "max" to "xhigh" on gpt-5.5 (native max not supported)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp-55',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      await new OpenAIResponsesProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5.5',
        maxTokens: 1024,
        effort: 'max',
      });

      expect(getRequestBody(fetchMock).reasoning).toEqual({ effort: 'xhigh' });
    });

    it('emits native effort "max" only for exact GPT-5.6 family IDs', async () => {
      for (const model of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
        const fetchMock = mockFetch({
          json: () =>
            Promise.resolve({
              id: 'resp-56',
              output: [],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            }),
        });

        await new OpenAIResponsesProvider().chat([{ role: 'user', content: 'Hello' }], {
          model,
          maxTokens: 1024,
          effort: 'max',
        });

        expect(getRequestBody(fetchMock).reasoning).toEqual({ effort: 'max' });
      }

      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp-unknown',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      await new OpenAIResponsesProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5.6-sol-2099-01-01',
        maxTokens: 1024,
        effort: 'max',
      });

      expect(getRequestBody(fetchMock).reasoning).toEqual({ effort: 'xhigh' });
    });

    it('passes reasoning { effort: "xhigh" } on gpt-5.4 (xhigh supported)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_xhigh',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5.4',
        maxTokens: 1024,
        effort: 'xhigh',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning).toEqual({ effort: 'xhigh' });
    });

    it('clamps reasoning { effort: "xhigh" } to "high" on gpt-5.1', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_xhigh_clamp',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5.1',
        maxTokens: 1024,
        effort: 'xhigh',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning).toEqual({ effort: 'high' });
    });

    it('ignores effort on non-reasoning models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
        effort: 'high',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning).toBeUndefined();
    });

    it('maps object toolChoice to flat Responses API format', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
        toolChoice: { type: 'function', function: { name: 'get_weather' } },
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', description: 'Get weather', parameters: {} },
          },
        ],
      });

      const body = getRequestBody(fetchMock);
      // Responses API uses flat {type, name} instead of nested {type, function:{name}}
      expect(body.tool_choice).toEqual({ type: 'function', name: 'get_weather' });
    });

    it('passes string toolChoice values through directly', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
        toolChoice: 'required',
        tools: [
          {
            type: 'function',
            function: { name: 'test', description: 'test', parameters: {} },
          },
        ],
      });

      const body = getRequestBody(fetchMock);
      expect(body.tool_choice).toBe('required');
    });

    it('strips temperature for reasoning models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
        temperature: 0.7,
      });

      const body = getRequestBody(fetchMock);
      expect(body).not.toHaveProperty('temperature');
    });

    it('strips temperature for GPT-5.6 when reasoning uses the provider default', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      await new OpenAIResponsesProvider().chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-5.6',
        maxTokens: 1024,
        temperature: 0.7,
      });

      expect(getRequestBody(fetchMock)).not.toHaveProperty('temperature');
    });

    it('uses the providerOptions model for reasoning and temperature decisions', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp-effective-model',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });
      await new OpenAIResponsesProvider().chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        effort: 'high',
        temperature: 0.7,
        providerOptions: { model: 'o3' },
      });
      const body = getRequestBody(fetchMock);
      expect(body.model).toBe('o3');
      expect(body.reasoning).toEqual({ effort: 'high' });
      expect(body).not.toHaveProperty('temperature');
    });

    it('sends max_output_tokens', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 4096,
      });

      const body = getRequestBody(fetchMock);
      expect(body.max_output_tokens).toBe(4096);
      expect(body).not.toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('max_completion_tokens');
    });

    it('posts to /responses endpoint', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
      });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toBe('https://api.openai.com/v1/responses');
    });

    it('flattens json_schema responseFormat into text.format', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'my_schema',
            strict: true,
            schema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
              additionalProperties: false,
            },
          },
        },
      });

      const body = getRequestBody(fetchMock);
      // Responses API expects flattened format — no nested json_schema key
      expect(body.text).toEqual({
        format: {
          type: 'json_schema',
          name: 'my_schema',
          strict: true,
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
      });
      // Verify the nested Chat Completions format is NOT present
      expect((body.text as any).format.json_schema).toBeUndefined();
    });

    it('passes json_object responseFormat through as text.format', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
        responseFormat: { type: 'json_object' },
      });

      const body = getRequestBody(fetchMock);
      expect(body.text).toEqual({ format: { type: 'json_object' } });
    });

    it('passes text responseFormat through as text.format', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
        responseFormat: { type: 'text' },
      });

      const body = getRequestBody(fetchMock);
      expect(body.text).toEqual({ format: { type: 'text' } });
    });

    it('clamps effort "none" to "minimal" on o-series (none not supported)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
        effort: 'none',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning).toEqual({ effort: 'minimal' });
    });

    it('does not send reasoning for effort "none" on non-reasoning models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
        effort: 'none',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning).toBeUndefined();
    });

    it('maps thinkingBudget to nearest reasoning effort', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
        thinkingBudget: 500,
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning).toEqual({ effort: 'low' });
    });

    it('clamps thinkingBudget 0 to "minimal" on o-series (none not supported)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
        thinkingBudget: 0,
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning).toEqual({ effort: 'minimal' });
    });

    it('clamps effort+thinkingBudget:0 to "minimal" on o-series', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
        effort: 'low',
        thinkingBudget: 0,
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning).toEqual({ effort: 'minimal' });
    });

    it('thinkingBudget overrides effort when both set', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
        effort: 'high',
        thinkingBudget: 500,
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning).toEqual({ effort: 'low' });
    });

    it('positive thinkingBudget overrides effort "none"', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
        effort: 'none',
        thinkingBudget: 5000,
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning).toEqual({ effort: 'medium' });
    });

    it('sends reasoning summary "detailed" for includeThoughts on reasoning models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
        effort: 'high',
        includeThoughts: true,
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning).toEqual({ effort: 'high', summary: 'detailed' });
    });

    it('sends reasoning summary for includeThoughts-only on reasoning models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
        includeThoughts: true,
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning).toEqual({ summary: 'detailed' });
    });

    it('captures reasoning items in providerMetadata from response', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [
              {
                type: 'reasoning',
                id: 'rs_1',
                encrypted_content: 'encrypted-data',
              },
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
      });

      expect(response.providerMetadata).toBeDefined();
      expect(response.providerMetadata!.openaiReasoningItems).toEqual([
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted-data' },
      ]);
    });

    it('injects reasoning items from providerMetadata into input', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat(
        [
          { role: 'user', content: 'Hi' },
          {
            role: 'assistant',
            content: 'Sure',
            providerMetadata: {
              openaiReasoningItems: [
                { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted-data' },
              ],
            },
          },
          { role: 'user', content: 'Thanks' },
        ],
        { model: 'o3', maxTokens: 1024 },
      );

      const body = getRequestBody(fetchMock);
      const input = body.input as any[];
      // Reasoning item should be injected before the assistant message
      expect(input[1]).toEqual({
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'encrypted-data',
      });
      expect(input[2]).toEqual({
        type: 'message',
        role: 'assistant',
        content: 'Sure',
      });
    });

    it('merges providerOptions into request body', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
        providerOptions: { truncation: 'auto' },
      });

      const body = getRequestBody(fetchMock);
      expect(body.truncation).toBe('auto');
    });

    it('requests reasoning.encrypted_content for reasoning models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
      });

      const body = getRequestBody(fetchMock);
      expect(body.include).toEqual(['reasoning.encrypted_content']);
    });

    it('does not request reasoning.encrypted_content for non-reasoning models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp_1',
            output: [],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIResponsesProvider();
      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
      });

      const body = getRequestBody(fetchMock);
      expect(body.include).toBeUndefined();
    });

    it('handles API errors gracefully', async () => {
      mockFetch({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: { message: 'Invalid request', type: 'invalid_request_error' },
            }),
          ),
      });

      const provider = new OpenAIResponsesProvider();
      await expect(
        provider.chat([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o', maxTokens: 1024 }),
      ).rejects.toThrow('OpenAI Responses API error (400): Invalid request');
    });
  });

  describe('stream()', () => {
    it('uses the providerOptions model for streaming reasoning and temperature', async () => {
      const fetchMock = mockFetch({
        body: makeSSEStream([
          {
            event: 'response.completed',
            data: {
              response: {
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
              },
            },
          },
        ]),
      });
      for await (const chunk of new OpenAIResponsesProvider().stream(
        [{ role: 'user', content: 'Hi' }],
        {
          model: 'gpt-4o',
          effort: 'high',
          temperature: 0.7,
          providerOptions: { model: 'o3' },
        },
      )) {
        expect(chunk).toBeDefined();
      }
      const body = getRequestBody(fetchMock);
      expect(body.model).toBe('o3');
      expect(body.reasoning).toEqual({ effort: 'high' });
      expect(body.include).toEqual(['reasoning.encrypted_content']);
      expect(body).not.toHaveProperty('temperature');
    });

    it('fails closed on providerOptions Responses image input in a stream', async () => {
      mockFetch({
        body: makeSSEStream([
          {
            event: 'response.completed',
            data: {
              response: {
                usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
              },
            },
          },
        ]),
      });
      const chunks: Array<{ type: string; cost?: number }> = [];
      for await (const chunk of new OpenAIResponsesProvider().stream(
        [{ role: 'user', content: 'Hi' }],
        {
          model: 'gpt-4o',
          providerOptions: {
            input: [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_image', image_url: 'https://example.test/image.png' }],
              },
            ],
          },
        },
      )) {
        chunks.push(chunk);
      }
      expect(chunks.find((chunk) => chunk.type === 'done')?.cost).toBeUndefined();
    });

    it('fails closed on opaque Responses context references in a stream', async () => {
      for (const providerOptions of [
        { previous_response_id: 'resp_previous' },
        { conversation: 'conv_123' },
        { prompt: 'pmpt_123' },
      ]) {
        mockFetch({
          body: makeSSEStream([
            {
              event: 'response.completed',
              data: {
                response: {
                  usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
                },
              },
            },
          ]),
        });
        const chunks: Array<{ type: string; cost?: number }> = [];
        for await (const chunk of new OpenAIResponsesProvider().stream(
          [{ role: 'user', content: 'Hi' }],
          { model: 'gpt-4o', providerOptions },
        )) {
          chunks.push(chunk);
        }
        expect(chunks.find((chunk) => chunk.type === 'done')?.cost).toBeUndefined();
      }
    });

    it('emits text_delta from response.output_text.delta events', async () => {
      const sseBody = makeSSEStream([
        {
          event: 'response.output_text.delta',
          data: { delta: 'Hello ' },
        },
        {
          event: 'response.output_text.delta',
          data: { delta: 'world!' },
        },
        {
          event: 'response.completed',
          data: {
            response: {
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                input_tokens_details: { cache_write_tokens: 4 },
              },
            },
          },
        },
      ]);

      mockFetch({ body: sseBody });

      const provider = new OpenAIResponsesProvider();
      const chunks: any[] = [];
      for await (const chunk of provider.stream([{ role: 'user', content: 'Hi' }], {
        model: 'gpt-5.6-terra',
        maxTokens: 1024,
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { type: 'text_delta', content: 'Hello ' },
        { type: 'text_delta', content: 'world!' },
        {
          type: 'done',
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            reasoning_tokens: undefined,
            cached_tokens: undefined,
            cache_write_tokens: 4,
          },
          // Terra: 6 ordinary @ $2, 4 cache writes @ $2.50, 5 output @ $12 per MTok.
          cost: expect.closeTo(0.000082, 8),
          providerMetadata: undefined,
        },
      ]);
    });

    it('emits tool_call_delta from function_call events', async () => {
      const sseBody = makeSSEStream([
        {
          event: 'response.output_item.added',
          data: {
            output_index: 0,
            item: { type: 'function_call', call_id: 'call_xyz', name: 'get_weather' },
          },
        },
        {
          event: 'response.function_call_arguments.delta',
          data: { output_index: 0, delta: '{"city"' },
        },
        {
          event: 'response.function_call_arguments.delta',
          data: { output_index: 0, delta: ':"SF"}' },
        },
        {
          event: 'response.completed',
          data: {
            response: {
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        },
      ]);

      mockFetch({ body: sseBody });

      const provider = new OpenAIResponsesProvider();
      const chunks: any[] = [];
      for await (const chunk of provider.stream([{ role: 'user', content: 'weather' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
      })) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'tool_call_delta',
        id: 'call_xyz',
        name: 'get_weather',
      });
      expect(chunks[1]).toEqual({
        type: 'tool_call_delta',
        id: 'call_xyz',
        arguments: '{"city"',
      });
      expect(chunks[2]).toEqual({
        type: 'tool_call_delta',
        id: 'call_xyz',
        arguments: ':"SF"}',
      });
      expect(chunks[3].type).toBe('done');
    });

    it('emits thinking_delta from reasoning_summary_text.delta events', async () => {
      const sseBody = makeSSEStream([
        {
          event: 'response.reasoning_summary_text.delta',
          data: { delta: 'Let me think...' },
        },
        {
          event: 'response.output_text.delta',
          data: { delta: 'Hello!' },
        },
        {
          event: 'response.completed',
          data: {
            response: {
              output: [],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        },
      ]);

      mockFetch({ body: sseBody });

      const provider = new OpenAIResponsesProvider();
      const chunks: any[] = [];
      for await (const chunk of provider.stream([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
      })) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'thinking_delta', content: 'Let me think...' });
      expect(chunks[1]).toEqual({ type: 'text_delta', content: 'Hello!' });
      expect(chunks[2].type).toBe('done');
    });

    it('captures reasoning items in stream done providerMetadata', async () => {
      const sseBody = makeSSEStream([
        {
          event: 'response.output_text.delta',
          data: { delta: 'Hello!' },
        },
        {
          event: 'response.completed',
          data: {
            response: {
              output: [
                {
                  type: 'reasoning',
                  id: 'rs_1',
                  encrypted_content: 'encrypted-data',
                },
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Hello!' }],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        },
      ]);

      mockFetch({ body: sseBody });

      const provider = new OpenAIResponsesProvider();
      const chunks: any[] = [];
      for await (const chunk of provider.stream([{ role: 'user', content: 'Hi' }], {
        model: 'o3',
        maxTokens: 1024,
      })) {
        chunks.push(chunk);
      }

      const doneChunk = chunks.find((c) => c.type === 'done');
      expect(doneChunk).toBeDefined();
      expect(doneChunk.providerMetadata).toEqual({
        openaiReasoningItems: [
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted-data' },
        ],
      });
    });

    it('throws on response.failed events', async () => {
      const sseBody = makeSSEStream([
        {
          event: 'response.failed',
          data: {
            response: {
              error: { message: 'Context length exceeded' },
            },
          },
        },
      ]);

      mockFetch({ body: sseBody });

      const provider = new OpenAIResponsesProvider();
      const chunks: unknown[] = [];
      const p = (async () => {
        for await (const chunk of provider.stream([{ role: 'user', content: 'Hi' }], {
          model: 'gpt-4o',
          maxTokens: 1024,
        })) {
          chunks.push(chunk);
        }
      })();
      await expect(p).rejects.toMatchObject({
        name: 'ProviderError',
        provider: 'openai-responses',
        status: 0,
        retryable: false,
        message: 'OpenAI Responses API error: Context length exceeded',
      });
      expect(chunks).toEqual([]);
    });

    it('maps ordered rich images without changing text-only request content', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            output: [],
            usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
          }),
      });
      const provider = new OpenAIResponsesProvider();
      await provider.chat(
        [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                label: 'first',
                source: { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
              },
              { type: 'text', text: 'between' },
              { type: 'image', source: { type: 'url', url: 'https://example.test/two.png' } },
              {
                type: 'image',
                source: {
                  type: 'provider-file',
                  provider: 'openai-responses',
                  reference: 'file_123',
                },
              },
            ],
          },
        ],
        { model: 'gpt-5.6' },
      );
      const body = getRequestBody(fetchMock);
      expect((body.input as any[])[0].content).toEqual([
        { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
        { type: 'input_text', text: '[Image: first]' },
        { type: 'input_text', text: 'between' },
        { type: 'input_image', image_url: 'https://example.test/two.png' },
        { type: 'input_image', file_id: 'file_123' },
      ]);
      expect(() =>
        provider.validateInput({
          model: 'gpt-4o',
          input: [
            {
              type: 'image',
              source: { type: 'provider-file', provider: 'anthropic', reference: 'secret' },
            },
          ],
          history: [],
          stream: false,
          hasTools: false,
          responseMode: 'text',
        }),
      ).toThrow('provider-file');
      expect(
        provider.validateInput({
          model: 'base-model',
          input: [
            { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } },
          ],
          history: [],
          stream: false,
          hasTools: false,
          responseMode: 'text',
          providerOptions: { model: 'future-vision-model' },
        }),
      ).toEqual({ effectiveModel: 'future-vision-model' });
      expect(() =>
        provider.validateInput({
          model: '   ',
          input: [
            { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } },
          ],
          history: [],
          stream: false,
          hasTools: false,
          responseMode: 'text',
        }),
      ).toThrow('image input for this model');
      expect(provider.inputCapabilities('gpt-5.6')).toEqual({
        image: { sources: ['url', 'bytes', 'base64', 'provider-file'] },
      });
      expect(provider.inputCapabilities('future-vision-model')).toEqual({
        image: { sources: ['url', 'bytes', 'base64', 'provider-file'] },
      });
      expect(provider.inputCapabilities('   ')).toEqual({});
      for (const model of [undefined, 42, '   ']) {
        expect(() =>
          provider.validateInput({
            model: 'gpt-5.6',
            input: [
              { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } },
            ],
            history: [],
            stream: false,
            hasTools: false,
            responseMode: 'text',
            providerOptions: { model },
          }),
        ).toThrow('invalid model providerOptions');
      }
    });
  });
});
