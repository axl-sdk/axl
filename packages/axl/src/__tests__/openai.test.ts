import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OpenAIProvider,
  isOSeriesModel,
  supportsReasoningNone,
  supportsXhigh,
  clampReasoningEffort,
} from '../providers/openai.js';

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

  describe('isOSeriesModel()', () => {
    it('detects o1 models', () => {
      expect(isOSeriesModel('o1')).toBe(true);
      expect(isOSeriesModel('o1-mini')).toBe(true);
      expect(isOSeriesModel('o1-pro')).toBe(true);
    });

    it('detects o3 models', () => {
      expect(isOSeriesModel('o3')).toBe(true);
      expect(isOSeriesModel('o3-mini')).toBe(true);
      expect(isOSeriesModel('o3-pro')).toBe(true);
    });

    it('detects o4-mini', () => {
      expect(isOSeriesModel('o4-mini')).toBe(true);
    });

    it('does not match GPT models', () => {
      expect(isOSeriesModel('gpt-4o')).toBe(false);
      expect(isOSeriesModel('gpt-4-turbo')).toBe(false);
      expect(isOSeriesModel('gpt-5')).toBe(false);
    });
  });

  describe('supportsReasoningNone()', () => {
    it('returns true for gpt-5.1+', () => {
      expect(supportsReasoningNone('gpt-5.1')).toBe(true);
      expect(supportsReasoningNone('gpt-5.2')).toBe(true);
      expect(supportsReasoningNone('gpt-5.4')).toBe(true);
    });

    it('returns false for pre-gpt-5.1 models', () => {
      expect(supportsReasoningNone('o3')).toBe(false);
      expect(supportsReasoningNone('o4-mini')).toBe(false);
      expect(supportsReasoningNone('gpt-5')).toBe(false);
      expect(supportsReasoningNone('gpt-5-mini')).toBe(false);
      expect(supportsReasoningNone('gpt-5-nano')).toBe(false);
      expect(supportsReasoningNone('gpt-5-pro')).toBe(false);
    });
  });

  describe('supportsXhigh()', () => {
    it('returns true for gpt-5.2+ (after gpt-5.1-codex-max)', () => {
      expect(supportsXhigh('gpt-5.2')).toBe(true);
      expect(supportsXhigh('gpt-5.3')).toBe(true);
      expect(supportsXhigh('gpt-5.4')).toBe(true);
      expect(supportsXhigh('gpt-5.5')).toBe(true);
    });

    it('returns false for gpt-5.1 and earlier', () => {
      expect(supportsXhigh('o3')).toBe(false);
      expect(supportsXhigh('gpt-5')).toBe(false);
      expect(supportsXhigh('gpt-5.1')).toBe(false);
    });
  });

  describe('clampReasoningEffort()', () => {
    it('clamps none to minimal on o-series', () => {
      expect(clampReasoningEffort('o3', 'none')).toBe('minimal');
      expect(clampReasoningEffort('o4-mini', 'none')).toBe('minimal');
    });

    it('clamps none to minimal on pre-gpt-5.1', () => {
      expect(clampReasoningEffort('gpt-5', 'none')).toBe('minimal');
      expect(clampReasoningEffort('gpt-5-nano', 'none')).toBe('minimal');
    });

    it('allows none on gpt-5.1+', () => {
      expect(clampReasoningEffort('gpt-5.1', 'none')).toBe('none');
      expect(clampReasoningEffort('gpt-5.4', 'none')).toBe('none');
    });

    it('clamps xhigh to high on gpt-5.1 and earlier', () => {
      expect(clampReasoningEffort('o3', 'xhigh')).toBe('high');
      expect(clampReasoningEffort('gpt-5', 'xhigh')).toBe('high');
      expect(clampReasoningEffort('gpt-5.1', 'xhigh')).toBe('high');
    });

    it('allows xhigh on gpt-5.2+ (after gpt-5.1-codex-max)', () => {
      expect(clampReasoningEffort('gpt-5.2', 'xhigh')).toBe('xhigh');
      expect(clampReasoningEffort('gpt-5.4', 'xhigh')).toBe('xhigh');
    });

    it('clamps any effort to high on gpt-5-pro', () => {
      expect(clampReasoningEffort('gpt-5-pro', 'low')).toBe('high');
      expect(clampReasoningEffort('gpt-5-pro', 'medium')).toBe('high');
      expect(clampReasoningEffort('gpt-5-pro', 'none')).toBe('high');
      expect(clampReasoningEffort('gpt-5-pro', 'xhigh')).toBe('high');
    });

    it('passes through valid effort levels unchanged', () => {
      expect(clampReasoningEffort('o3', 'low')).toBe('low');
      expect(clampReasoningEffort('o3', 'medium')).toBe('medium');
      expect(clampReasoningEffort('o3', 'high')).toBe('high');
      expect(clampReasoningEffort('gpt-5', 'low')).toBe('low');
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

    it('discounts cached tokens at 50% for gpt-4o era models', async () => {
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

      // gpt-4o: [2.5e-6, 10e-6, 0.5]
      // Non-cached input: 200 * 2.5e-6 = 0.0005
      // Cached input:     800 * 2.5e-6 * 0.5 = 0.001
      // Output:           50 * 10e-6 = 0.0005
      // Total: 0.002
      expect(response.cost).toBeCloseTo(0.002, 5);
    });

    it('discounts cached tokens at 25% for gpt-4.1 era models', async () => {
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
        model: 'gpt-4.1',
        maxTokens: 1024,
      });

      // gpt-4.1: [2e-6, 8e-6, 0.25]
      // Non-cached input: 200 * 2e-6 = 0.0004
      // Cached input:     800 * 2e-6 * 0.25 = 0.0004
      // Output:           50 * 8e-6 = 0.0004
      // Total: 0.0012
      expect(response.cost).toBeCloseTo(0.0012, 5);
    });

    it('discounts cached tokens at 10% for gpt-5 era models', async () => {
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
        model: 'gpt-5.4',
        maxTokens: 1024,
      });

      // gpt-5.4: [2.5e-6, 15e-6, 0.1]
      // Non-cached input: 200 * 2.5e-6 = 0.0005
      // Cached input:     800 * 2.5e-6 * 0.1 = 0.0002
      // Output:           50 * 15e-6 = 0.00075
      // Total: 0.00145
      expect(response.cost).toBeCloseTo(0.00145, 5);
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

    it('passes reasoning_effort for effort "high" on o-series', async () => {
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
        effort: 'high',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('high');
    });

    it('maps effort "max" to "high" on o3 (xhigh not supported pre-gpt-5.4)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp-1',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'o3',
        maxTokens: 1024,
        effort: 'max',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('high');
    });

    it('maps effort "max" to "xhigh" on gpt-5.4 (xhigh supported)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp-1',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5.4',
        maxTokens: 1024,
        effort: 'max',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('xhigh');
    });

    it('maps thinkingBudget to nearest reasoning_effort level', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp-1',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'o3',
        maxTokens: 1024,
        thinkingBudget: 500,
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('low');
    });

    it('does not set reasoning_effort when includeThoughts only', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp-1',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'o3',
        maxTokens: 1024,
        includeThoughts: true,
      });

      const body = getRequestBody(fetchMock);
      // includeThoughts alone should not set reasoning_effort
      expect(body.reasoning_effort).toBeUndefined();
    });

    it('ignores effort on non-reasoning-capable models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp-1',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-4o',
        maxTokens: 1024,
        effort: 'high',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBeUndefined();
    });

    it('sends reasoning_effort for GPT-5 models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp-1',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5',
        maxTokens: 1024,
        effort: 'high',
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

    it('clamps effort "none" to "minimal" on o-series (none not supported)', async () => {
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
        effort: 'none',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('minimal');
    });

    it('clamps effort "none" to "minimal" on pre-gpt-5.1 (none not supported)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5',
        maxTokens: 1024,
        effort: 'none',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('minimal');
    });

    it('sends reasoning_effort "none" on gpt-5.1 (none supported)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5.1',
        maxTokens: 1024,
        effort: 'none',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('none');
    });

    it('does not send reasoning_effort for effort "none" on non-reasoning models', async () => {
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
        effort: 'none',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBeUndefined();
    });

    it('clamps thinkingBudget 0 to "minimal" on o-series (none not supported)', async () => {
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
        thinkingBudget: 0,
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('minimal');
    });

    it('clamps effort+thinkingBudget:0 to "minimal" on o-series', async () => {
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
        effort: 'low',
        thinkingBudget: 0,
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('minimal');
    });

    it('clamps any effort to "high" on gpt-5-pro (only supports high)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5-pro',
        maxTokens: 1024,
        effort: 'low',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('high');
    });

    it('thinkingBudget overrides effort when both set', async () => {
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
        effort: 'high',
        thinkingBudget: 500,
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('low');
    });

    it('positive thinkingBudget overrides effort "none"', async () => {
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
        effort: 'none',
        thinkingBudget: 5000,
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('medium');
    });

    it('uses system role (not developer) for GPT-5 models', async () => {
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
        { model: 'gpt-5', maxTokens: 1024 },
      );

      const body = getRequestBody(fetchMock);
      const messages = body.messages as Array<{ role: string; content: string }>;
      expect(messages[0].role).toBe('system');
    });

    it('sends parallel_tool_calls for GPT-5 with tools', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5',
        maxTokens: 1024,
        tools: [
          {
            type: 'function',
            function: { name: 'test', description: 'test', parameters: {} },
          },
        ],
      });

      const body = getRequestBody(fetchMock);
      expect(body.parallel_tool_calls).toBe(true);
    });

    it('strips temperature for GPT-5 when reasoning active', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5',
        maxTokens: 1024,
        effort: 'high',
        temperature: 0.7,
      });

      const body = getRequestBody(fetchMock);
      expect(body).not.toHaveProperty('temperature');
      expect(body.reasoning_effort).toBe('high');
    });

    it('allows temperature for GPT-5 with no effort', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5',
        maxTokens: 1024,
        temperature: 0.7,
      });

      const body = getRequestBody(fetchMock);
      expect(body.temperature).toBe(0.7);
    });

    it('merges providerOptions into request body', async () => {
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
        providerOptions: { logprobs: true, top_logprobs: 3 },
      });

      const body = getRequestBody(fetchMock);
      expect(body.logprobs).toBe(true);
      expect(body.top_logprobs).toBe(3);
    });

    it('providerOptions can override computed fields', async () => {
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
        providerOptions: { temperature: 0.5 },
      });

      const body = getRequestBody(fetchMock);
      // providerOptions is merged last, so it can override stripped temperature
      expect(body.temperature).toBe(0.5);
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
