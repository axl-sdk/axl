import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider, isReasoningModel } from '../providers/openai.js';

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

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('OpenAIProvider', () => {
  it('throws when no API key is provided', () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => new OpenAIProvider()).toThrow('OpenAI API key is required');
  });

  it('accepts API key via constructor options', () => {
    delete process.env.OPENAI_API_KEY;
    const provider = new OpenAIProvider({ apiKey: 'my-key' });
    expect(provider.name).toBe('openai');
  });

  describe('isReasoningModel()', () => {
    it('detects o1 models', () => {
      expect(isReasoningModel('o1')).toBe(true);
      expect(isReasoningModel('o1-mini')).toBe(true);
      expect(isReasoningModel('o1-pro')).toBe(true);
    });

    it('detects o3 models', () => {
      expect(isReasoningModel('o3')).toBe(true);
      expect(isReasoningModel('o3-mini')).toBe(true);
      expect(isReasoningModel('o3-pro')).toBe(true);
    });

    it('detects o4-mini', () => {
      expect(isReasoningModel('o4-mini')).toBe(true);
    });

    it('does not match GPT models', () => {
      expect(isReasoningModel('gpt-4o')).toBe(false);
      expect(isReasoningModel('gpt-4-turbo')).toBe(false);
      expect(isReasoningModel('gpt-5')).toBe(false);
    });
  });

  describe('chat()', () => {
    it('estimates cost from usage data for known models', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: { content: 'Hi', tool_calls: undefined },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
      });

      const provider = new OpenAIProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
      });

      // gpt-4o: [2.5e-6, 10e-6]
      // Expected: 100 * 2.5e-6 + 50 * 10e-6 = 0.00025 + 0.0005 = 0.00075
      expect(response.cost).toBeCloseTo(0.00075, 5);
      expect(response.usage).toMatchObject({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      });
    });

    it('discounts cached tokens at 50% of input rate', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: { content: 'Hi', tool_calls: undefined },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 50,
              total_tokens: 1050,
              prompt_tokens_details: { cached_tokens: 800 },
            },
          }),
      });

      const provider = new OpenAIProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
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

    it('returns cost: 0 for unknown models (not undefined)', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: { content: 'Hi', tool_calls: undefined },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
      });

      const provider = new OpenAIProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-unknown-model-9000',
        maxTokens: 1024,
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
            JSON.stringify({ error: { message: 'Invalid request', type: 'invalid_request' } }),
          ),
      });

      const provider = new OpenAIProvider();
      await expect(
        provider.chat([{ role: 'user', content: 'Hi' }], {
          model: 'gpt-4o',
          maxTokens: 1024,
        }),
      ).rejects.toThrow('OpenAI API error (400): Invalid request');
    });

    it('passes signal to fetch', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: { content: 'ok', tool_calls: undefined },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const controller = new AbortController();
      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
        signal: controller.signal,
      });

      expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
    });

    it('sends max_completion_tokens instead of max_tokens', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-4o',
        maxTokens: 2048,
      });

      const body = getRequestBody(fetchMock);
      expect(body.max_completion_tokens).toBe(2048);
      expect(body).not.toHaveProperty('max_tokens');
    });

    it('maps system role to developer for reasoning models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat(
        [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
        { model: 'o3', maxTokens: 1024 },
      );

      const body = getRequestBody(fetchMock);
      const messages = body.messages as Array<{ role: string; content: string }>;
      expect(messages[0].role).toBe('developer');
      expect(messages[1].role).toBe('user');
    });

    it('strips temperature for reasoning models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'o1',
        maxTokens: 1024,
        temperature: 0.7,
      });

      const body = getRequestBody(fetchMock);
      expect(body).not.toHaveProperty('temperature');
    });

    it('passes reasoning_effort when set', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'o3',
        maxTokens: 1024,
        reasoningEffort: 'high',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('high');
    });

    it('passes tool_choice when set', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
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
      expect(body.parallel_tool_calls).toBe(true);
    });

    it('captures reasoning and cached tokens from usage', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 200,
              total_tokens: 300,
              completion_tokens_details: { reasoning_tokens: 150 },
              prompt_tokens_details: { cached_tokens: 50 },
            },
          }),
      });

      const provider = new OpenAIProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'o3',
        maxTokens: 1024,
      });

      expect(response.usage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 200,
        total_tokens: 300,
        reasoning_tokens: 150,
        cached_tokens: 50,
      });
    });
  });

  describe('stream()', () => {
    function makeSSEStream(lines: string[]): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      const payload = lines.join('\n') + '\n';
      let sent = false;
      return new ReadableStream({
        pull(controller) {
          if (!sent) {
            controller.enqueue(encoder.encode(payload));
            sent = true;
          } else {
            controller.close();
          }
        },
      });
    }

    it('captures reasoning and cached tokens from stream usage chunk', async () => {
      const sseBody = makeSSEStream([
        'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}',
        '',
        `data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":200,"total_tokens":300,"completion_tokens_details":{"reasoning_tokens":150},"prompt_tokens_details":{"cached_tokens":50}}}`,
        '',
        'data: [DONE]',
        '',
      ]);

      mockFetch({ body: sseBody });

      const provider = new OpenAIProvider();
      const chunks: any[] = [];
      for await (const chunk of provider.stream([{ role: 'user', content: 'Hello' }], {
        model: 'o3',
        maxTokens: 1024,
      })) {
        chunks.push(chunk);
      }

      const doneChunk = chunks.find((c) => c.type === 'done');
      expect(doneChunk).toBeDefined();
      expect(doneChunk.usage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 200,
        total_tokens: 300,
        reasoning_tokens: 150,
        cached_tokens: 50,
      });
    });
  });
});
