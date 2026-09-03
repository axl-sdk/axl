import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OpenAIProvider,
  OPENAI_PRICING,
  isOSeriesModel,
  supportsReasoningNone,
  supportsMaxReasoningEffort,
  supportsXhigh,
  clampReasoningEffort,
  estimateDirectOpenAICost,
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

  describe('supportsMaxReasoningEffort()', () => {
    it('only recognizes the exact GPT-5.6 family IDs', () => {
      expect(supportsMaxReasoningEffort('gpt-5.6')).toBe(true);
      expect(supportsMaxReasoningEffort('gpt-5.6-sol')).toBe(true);
      expect(supportsMaxReasoningEffort('gpt-5.6-terra')).toBe(true);
      expect(supportsMaxReasoningEffort('gpt-5.6-luna')).toBe(true);
      expect(supportsMaxReasoningEffort('gpt-5.6-sol-2099-01-01')).toBe(false);
      expect(supportsMaxReasoningEffort('gpt-5.7')).toBe(false);
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

    it('prices gpt-5.5 at $5/$30 per 1M tokens with 10% cached input', async () => {
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
        model: 'gpt-5.5',
        maxTokens: 1024,
      });

      // gpt-5.5: [5e-6, 30e-6, 0.1]
      // Non-cached input: 200 * 5e-6 = 0.001
      // Cached input:     800 * 5e-6 * 0.1 = 0.0004
      // Output:           50 * 30e-6 = 0.0015
      // Total: 0.0029
      expect(response.cost).toBeCloseTo(0.0029, 5);
    });

    it('prices gpt-5.5-pro at $30/$180 via longest-prefix match (not gpt-5.5)', async () => {
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
        model: 'gpt-5.5-pro',
        maxTokens: 1024,
      });

      // gpt-5.5-pro: [30e-6, 180e-6, 0.1]
      // 100 * 30e-6 + 50 * 180e-6 = 0.003 + 0.009 = 0.012
      expect(response.cost).toBeCloseTo(0.012, 5);
    });

    it('returns cost: undefined for unknown models (unmeasured, not a misleading $0)', async () => {
      // A pricing-table miss surfaces as `undefined` ("unknown cost"), never a
      // silent 0 — a fake $0 would mislead cost dashboards and let ctx.budget()
      // treat paid models as free. See spec §6.
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

      expect(response.cost).toBeUndefined();
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

    it('maps effort "max" to "xhigh" on gpt-5.5 (native max not supported)', async () => {
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
        model: 'gpt-5.5',
        maxTokens: 1024,
        effort: 'max',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('xhigh');
    });

    it('caps GPT-5.6 max at xhigh on Chat Completions', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      for (const model of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
        const fetchMock = mockFetch({
          json: () =>
            Promise.resolve({
              id: 'resp-56',
              choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
        });

        await new OpenAIProvider().chat([{ role: 'user', content: 'Hello' }], {
          model,
          maxTokens: 1024,
          effort: 'max',
        });

        expect(getRequestBody(fetchMock).reasoning_effort).toBe('xhigh');
      }

      // The max→xhigh downgrade is reported through `effortResolution` (see the
      // effortResolution suite) and surfaced by the runtime, not warned here.
      expect(warn).not.toHaveBeenCalled();

      await new OpenAIProvider().chat([{ role: 'user', content: 'Hello again' }], {
        model: 'gpt-5.6-luna',
        maxTokens: 1024,
        effort: 'max',
      });
      expect(warn).not.toHaveBeenCalled();

      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp-unknown',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      await new OpenAIProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5.6-sol-2099-01-01',
        maxTokens: 1024,
        effort: 'max',
      });

      expect(getRequestBody(fetchMock).reasoning_effort).toBe('xhigh');
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('passes reasoning_effort "xhigh" on gpt-5.4 (xhigh supported)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp-xhigh-54',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5.4',
        maxTokens: 1024,
        effort: 'xhigh',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('xhigh');
    });

    it('clamps reasoning_effort "xhigh" to "high" on gpt-5.1', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'resp-xhigh-51',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });

      const provider = new OpenAIProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5.1',
        maxTokens: 1024,
        effort: 'xhigh',
      });

      const body = getRequestBody(fetchMock);
      expect(body.reasoning_effort).toBe('high');
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

    it('prices the fully merged providerOptions model and leaves non-Standard tiers unpriced', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          }),
      });
      const provider = new OpenAIProvider();
      const priced = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-4o',
        providerOptions: { model: 'gpt-5.6-luna' },
      });
      expect(getRequestBody(fetchMock).model).toBe('gpt-5.6-luna');
      expect(priced.cost).toBeCloseTo(32e-6, 12);

      mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            service_tier: 'flex',
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          }),
      });
      const unpriced = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-5.6-luna',
      });
      expect(unpriced.cost).toBeUndefined();
    });

    it('fails closed on providerOptions Chat image content', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          }),
      });
      const response = await new OpenAIProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-4o',
        providerOptions: {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: 'https://example.test/image.png' } },
              ],
            },
          ],
        },
      });
      expect(response.cost).toBeUndefined();
    });

    it('does not apply direct-OpenAI pricing through a custom base URL', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
      });
      const response = await new OpenAIProvider({ baseUrl: 'https://proxy.example/v1' }).chat(
        [{ role: 'user', content: 'Hello' }],
        { model: 'gpt-4o' },
      );
      expect(response.cost).toBeUndefined();
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
              prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 25 },
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
        cache_write_tokens: 25,
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

    it('uses the providerOptions model for streaming role, reasoning, and temperature', async () => {
      const fetchMock = mockFetch({
        body: makeSSEStream([
          'data: {"choices":[{"delta":{"content":"ok"}}]}',
          '',
          'data: [DONE]',
          '',
        ]),
      });
      for await (const chunk of new OpenAIProvider().stream(
        [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'Hello' },
        ],
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
      expect((body.messages as Array<{ role: string }>)[0].role).toBe('developer');
      expect(body.reasoning_effort).toBe('high');
      expect(body).not.toHaveProperty('temperature');
    });

    it('fails closed on providerOptions Chat image content in a stream', async () => {
      mockFetch({
        body: makeSSEStream([
          'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}',
          '',
          'data: [DONE]',
          '',
        ]),
      });
      const chunks: Array<{ type: string; cost?: number }> = [];
      for await (const chunk of new OpenAIProvider().stream([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-4o',
        providerOptions: {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: 'https://example.test/image.png' } },
              ],
            },
          ],
        },
      })) {
        chunks.push(chunk);
      }
      expect(chunks.find((chunk) => chunk.type === 'done')?.cost).toBeUndefined();
    });

    it('captures reasoning and cached tokens from stream usage chunk', async () => {
      const sseBody = makeSSEStream([
        'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}',
        '',
        `data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":200,"total_tokens":300,"completion_tokens_details":{"reasoning_tokens":150},"prompt_tokens_details":{"cached_tokens":50,"cache_write_tokens":25}}}`,
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
        cache_write_tokens: 25,
      });
    });

    it('uses model and default tier reported with a terminal usage-only chunk', async () => {
      mockFetch({
        body: makeSSEStream([
          'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}',
          '',
          'data: {"model":"gpt-5.6-luna","service_tier":"default","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}',
          '',
          'data: [DONE]',
          '',
        ]),
      });
      const chunks: any[] = [];
      for await (const chunk of new OpenAIProvider().stream([{ role: 'user', content: 'Hello' }], {
        model: 'gpt-4o',
      })) {
        chunks.push(chunk);
      }
      expect(chunks.find((chunk) => chunk.type === 'done')?.cost).toBeCloseTo(32e-6, 12);
    });
  });
});

describe('direct OpenAI Standard estimator', () => {
  const usage = (prompt_tokens: number, completion_tokens = 10, extra = {}) => ({
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    ...extra,
  });

  it('recognizes only exact aliases and documented snapshots', () => {
    expect(estimateDirectOpenAICost('gpt-5.6', usage(100))).toBeCloseTo(600e-6, 12);
    expect(estimateDirectOpenAICost('gpt-4o-2024-05-13', usage(100))).toBeCloseTo(650e-6, 12);
    expect(estimateDirectOpenAICost('gpt-3.5-turbo-1106', usage(100))).toBeCloseTo(120e-6, 12);
    expect(estimateDirectOpenAICost('gpt-4o-2024-05-14', usage(100))).toBeUndefined();
    expect(estimateDirectOpenAICost('gpt-5.6-sol-2026-08-03', usage(100))).toBeUndefined();
  });

  it.each([
    ['gpt-4o', 12.5],
    ['gpt-4o-2024-05-13', 20],
    ['gpt-4-turbo-2024-04-09', 40],
    ['gpt-4-0613', 90],
    ['gpt-3.5-turbo-1106', 3],
    ['o3', 10],
    ['gpt-5.2-pro', 189],
    ['gpt-5.4-mini', 5.25],
    ['gpt-5-pro', 135],
    ['davinci-002', 4],
  ])('uses the audited Standard row for %s', (model, dollarsPerMillion) => {
    expect(estimateDirectOpenAICost(model, usage(1, 1))).toBeCloseTo(
      dollarsPerMillion / 1_000_000,
      12,
    );
  });

  it.each(['o1-mini', 'gpt-5.3', 'gpt-4', 'gpt-4-turbo'])(
    'leaves absent row %s unpriced',
    (model) => {
      expect(estimateDirectOpenAICost(model, usage(1, 1))).toBeUndefined();
    },
  );

  it.each([
    'gpt-5.5-2026-04-23',
    'gpt-5.5-pro-2026-04-23',
    'gpt-5.4-2026-03-05',
    'gpt-5.4-pro-2026-03-05',
    'gpt-5.4-mini-2026-03-17',
    'gpt-5.4-nano-2026-03-17',
    'gpt-5.2-2025-12-11',
    'gpt-5.2-pro-2025-12-11',
    'gpt-5.1-2025-11-13',
    'gpt-5-2025-08-07',
    'gpt-5-pro-2025-10-06',
    'gpt-5-mini-2025-08-07',
    'gpt-5-nano-2025-08-07',
    'gpt-4.1-2025-04-14',
    'gpt-4.1-mini-2025-04-14',
    'gpt-4.1-nano-2025-04-14',
    'gpt-4o-2024-05-13',
    'gpt-4o-2024-08-06',
    'gpt-4o-2024-11-20',
    'gpt-4o-mini-2024-07-18',
    'o1-2024-12-17',
    'o1-pro-2025-03-19',
    'o3-2025-04-16',
    'o3-pro-2025-06-10',
    'o3-mini-2025-01-31',
    'o4-mini-2025-04-16',
  ])('prices the explicitly audited snapshot %s', (model) => {
    expect(estimateDirectOpenAICost(model, usage(1, 1))).toBeDefined();
  });

  it.each([
    'gpt-5.5-2026-04-24',
    'gpt-5.4-mini-2026-03-18',
    'gpt-5.2-2025-12-12',
    'gpt-4.1-2025-04-15',
    'o3-2025-04-17',
  ])('rejects fictitious snapshot %s', (model) => {
    expect(estimateDirectOpenAICost(model, usage(1, 1))).toBeUndefined();
  });

  it('uses literal cache-read/write rates and rejects invalid categories', () => {
    // Terra: 50 ordinary @ $2, 20 cached @ $0.20, 30 writes @ $2.50, 10 output @ $12.
    expect(
      estimateDirectOpenAICost(
        'gpt-5.6-terra',
        usage(100, 10, { cached_tokens: 20, cache_write_tokens: 30 }),
      ),
    ).toBeCloseTo(299e-6, 12);
    expect(
      estimateDirectOpenAICost('o3-pro', usage(100, 10, { cached_tokens: 1 })),
    ).toBeUndefined();
    expect(
      estimateDirectOpenAICost(
        'gpt-5.6-terra',
        usage(100, 10, { cached_tokens: 60, cache_write_tokens: 41 }),
      ),
    ).toBeUndefined();
    expect(
      estimateDirectOpenAICost('gpt-3.5-turbo', usage(100, 10, { cached_tokens: 1 })),
    ).toBeUndefined();
    expect(
      estimateDirectOpenAICost('gpt-3.5-turbo-0125', usage(100, 10, { cached_tokens: 1 })),
    ).toBeUndefined();
  });

  it('keeps the public tuple view limited to fully representable flat rows', () => {
    expect(OPENAI_PRICING).toHaveProperty('gpt-4o');
    expect(OPENAI_PRICING).toHaveProperty('gpt-4.1');
    expect(OPENAI_PRICING).not.toHaveProperty('gpt-3.5-turbo');
    expect(OPENAI_PRICING).not.toHaveProperty('gpt-3.5-turbo-0125');
    expect(OPENAI_PRICING).not.toHaveProperty('gpt-4o-2024-05-13');
    expect(OPENAI_PRICING).not.toHaveProperty('gpt-5.4');
    expect(OPENAI_PRICING).not.toHaveProperty('gpt-5.5');
    expect(OPENAI_PRICING).not.toHaveProperty('o3-pro');
  });

  it('changes full-request rates strictly above the long-context boundary', () => {
    expect(estimateDirectOpenAICost('gpt-5.6-sol', usage(271_999, 1))).toBeCloseTo(
      (271_999 * 4 + 20) / 1_000_000,
      12,
    );
    expect(estimateDirectOpenAICost('gpt-5.6-sol', usage(272_000, 1))).toBeCloseTo(
      (272_000 * 4 + 20) / 1_000_000,
      12,
    );
    expect(estimateDirectOpenAICost('gpt-5.6-sol', usage(272_001, 1))).toBeCloseTo(
      (272_001 * 8 + 30) / 1_000_000,
      12,
    );
    expect(estimateDirectOpenAICost('gpt-5.4', usage(272_001, 1))).toBeCloseTo(
      (272_001 * 5 + 22.5) / 1_000_000,
      12,
    );
    expect(estimateDirectOpenAICost('gpt-5.4-pro', usage(272_001, 1))).toBeCloseTo(
      (272_001 * 60 + 270) / 1_000_000,
      12,
    );
    expect(estimateDirectOpenAICost('gpt-5.5', usage(272_001, 1))).toBeCloseTo(
      (272_001 * 10 + 45) / 1_000_000,
      12,
    );
    expect(estimateDirectOpenAICost('gpt-5.5-pro', usage(272_001, 1))).toBeCloseTo(
      (272_001 * 60 + 270) / 1_000_000,
      12,
    );
  });

  it('does not estimate an ambiguous billing mode', () => {
    expect(
      estimateDirectOpenAICost('gpt-5.6', usage(10), { request: { service_tier: 'flex' } }),
    ).toBeUndefined();
    expect(
      estimateDirectOpenAICost('gpt-5.6', usage(10), { response: { service_tier: 'fast' } }),
    ).toBeUndefined();
    expect(
      estimateDirectOpenAICost('gpt-5.6', usage(10), {
        baseUrl: 'https://regional.example.com/v1',
      }),
    ).toBeUndefined();
    expect(
      estimateDirectOpenAICost('gpt-5.6', usage(10), {
        request: { service_tier: 'auto' },
        response: { service_tier: 'default' },
      }),
    ).toBeDefined();
    expect(
      estimateDirectOpenAICost('gpt-5.6', usage(10), {
        request: { service_tier: 'auto' },
        response: { service_tier: 'flex' },
      }),
    ).toBeUndefined();
    expect(
      estimateDirectOpenAICost('gpt-5.6', usage(10), {
        request: { reasoning: { mode: 'pro' } },
      }),
    ).toBeUndefined();
    expect(
      estimateDirectOpenAICost('gpt-5.6', usage(10), {
        request: { tools: [{ type: 'web_search' }] },
      }),
    ).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Effort provenance (B8) — OpenAI Chat Completions
// ═══════════════════════════════════════════════════════════════════════════

describe('OpenAIProvider.effortResolution', () => {
  const chatResponse = {
    id: 'resp-effort',
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  // Each clamping row is paired with the wire value the same request carries.
  it.each([
    ['gpt-5.6', 'max', 'xhigh'],
    ['gpt-5', 'none', 'minimal'],
    ['gpt-5.1', 'xhigh', 'high'],
    ['gpt-5-pro', 'low', 'high'],
  ] as const)('reports and sends %s effort %s as %s', async (model, effort, effective) => {
    const provider = new OpenAIProvider();
    const resolution = provider.effortResolution({ model, effort });
    expect(resolution).toMatchObject({ requested: effort, effective, clamped: true });
    expect(resolution!.cause).toBeTruthy();

    const fetchMock = mockFetch({ json: () => Promise.resolve(chatResponse) });
    await provider.chat([{ role: 'user', content: 'Hello' }], { model, maxTokens: 1024, effort });
    expect(getRequestBody(fetchMock).reasoning_effort).toBe(effective);
  });

  it.each([
    ['gpt-5.1', 'high'],
    ['gpt-5.1', 'none'],
    ['gpt-5.4', 'xhigh'],
    // Non-reasoning models ignore the knob entirely — nothing to report.
    ['gpt-4o', 'high'],
  ] as const)('reports nothing for honored %s effort %s', (model, effort) => {
    expect(new OpenAIProvider().effortResolution({ model, effort })).toBeUndefined();
  });

  it('reports nothing without an effort, or when thinkingBudget overrides it', () => {
    const provider = new OpenAIProvider();
    expect(provider.effortResolution({ model: 'gpt-5.6' })).toBeUndefined();
    expect(
      provider.effortResolution({ model: 'gpt-5.6', effort: 'max', thinkingBudget: 2000 }),
    ).toBeUndefined();
  });

  it('resolves against the providerOptions model override', () => {
    expect(
      new OpenAIProvider().effortResolution({
        model: 'gpt-5.1',
        effort: 'none',
        providerOptions: { model: 'gpt-5' },
      }),
    ).toMatchObject({ effective: 'minimal', clamped: true });
  });
});
