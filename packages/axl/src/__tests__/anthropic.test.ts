import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicProvider, estimateAnthropicCost } from '../providers/anthropic.js';
import type { StreamChunk } from '../providers/types.js';

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

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ANTHROPIC_API_KEY;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('AnthropicProvider', () => {
  it('throws when no API key is provided', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => new AnthropicProvider()).toThrow('Anthropic API key is required');
  });

  it('accepts API key via constructor options', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const provider = new AnthropicProvider({ apiKey: 'my-key' });
    expect(provider.name).toBe('anthropic');
  });

  describe('chat()', () => {
    it('extracts system messages into top-level system param', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello!' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat(
        [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
        { model: 'claude-sonnet-4', maxTokens: 1024 },
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.system).toBe('You are helpful.');
      // System message should not appear in messages array
      expect(body.messages.every((m: any) => m.role !== 'system')).toBe(true);
    });

    it('maps assistant tool_calls to tool_use content blocks', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-2',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu_1',
                name: 'search',
                input: { query: 'test' },
              },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 20, output_tokens: 15 },
          }),
      });

      const provider = new AnthropicProvider();
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
        { model: 'claude-sonnet-4', maxTokens: 1024 },
      );

      // The request body should map tool_calls to tool_use blocks
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const assistantMsg = body.messages.find(
        (m: any) => m.role === 'assistant' && Array.isArray(m.content),
      );
      expect(assistantMsg).toBeDefined();
      const toolUseBlock = assistantMsg.content.find((b: any) => b.type === 'tool_use');
      expect(toolUseBlock).toBeDefined();
      expect(toolUseBlock.name).toBe('search');

      // Response should parse tool_use from the API response
      expect(response.tool_calls).toHaveLength(1);
      expect(response.tool_calls![0].function.name).toBe('search');
    });

    it('maps tool messages to user messages with tool_result content blocks', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-3',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Done' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 15, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
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
          { role: 'tool', content: 'result data', tool_call_id: 'tc_1' },
        ],
        { model: 'claude-sonnet-4', maxTokens: 1024 },
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Tool result should be in a user-role message with tool_result content block
      const userMsgs = body.messages.filter((m: any) => m.role === 'user');
      const toolResultMsg = userMsgs.find(
        (m: any) =>
          Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'),
      );
      expect(toolResultMsg).toBeDefined();
      const toolResultBlock = toolResultMsg.content.find((b: any) => b.type === 'tool_result');
      expect(toolResultBlock.tool_use_id).toBe('tc_1');
      expect(toolResultBlock.content).toBe('result data');
    });

    it('estimates cost from usage data', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-4',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
      });

      const provider = new AnthropicProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
      });

      // claude-sonnet-4-6: [3e-6, 15e-6]
      // Expected: 100 * 3e-6 + 50 * 15e-6 = 0.0003 + 0.00075 = 0.00105
      expect(response.cost).toBeCloseTo(0.00105, 5);
      expect(response.usage).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      });
    });

    it('discounts cache reads at 10% and surcharges cache writes at 125%', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-cached',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi' }],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 800,
              cache_creation_input_tokens: 200,
              cache_creation: { ephemeral_5m_input_tokens: 200 },
            },
          }),
      });

      const provider = new AnthropicProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
      });

      // claude-sonnet-4-6: [3e-6, 15e-6]
      // Total input: 100 + 800 + 200 = 1100
      // Regular:     100 * 3e-6 = 0.0003
      // Cache read:  800 * 3e-6 * 0.1 = 0.00024
      // Cache write: 200 * 3e-6 * 1.25 = 0.00075
      // Output:      50 * 15e-6 = 0.00075
      // Total: 0.00204
      expect(response.cost).toBeCloseTo(0.00204, 5);
      expect(response.usage).toEqual({
        prompt_tokens: 1100,
        completion_tokens: 50,
        total_tokens: 1150,
        cached_tokens: 800,
        cache_write_tokens: 200,
      });
    });

    it('preserves aggregate-only cache writes in usage but leaves their cost undefined', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-aggregate-cache-write',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi' }],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 20,
            },
          }),
      });
      const response = await new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-5',
      });
      expect(response.usage).toEqual({
        prompt_tokens: 120,
        completion_tokens: 50,
        total_tokens: 170,
        cache_write_tokens: 20,
      });
      expect(response.cost).toBeUndefined();
    });

    it('prices claude-opus-4-7 at $5/$25 per 1M tokens (same as 4.6)', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-price-47',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
      });

      const provider = new AnthropicProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-4-7',
        maxTokens: 1024,
      });

      // claude-opus-4-7: [5e-6, 25e-6]
      // 100 * 5e-6 + 50 * 25e-6 = 0.0005 + 0.00125 = 0.00175
      expect(response.cost).toBeCloseTo(0.00175, 5);
    });

    it('prices claude-opus-4-8 at $5/$25 per 1M tokens (same as 4.7)', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-price-48',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
      });

      const provider = new AnthropicProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-4-8',
        maxTokens: 1024,
      });

      // claude-opus-4-8: [5e-6, 25e-6]
      // 100 * 5e-6 + 50 * 25e-6 = 0.0005 + 0.00125 = 0.00175
      expect(response.cost).toBeCloseTo(0.00175, 5);
    });

    it('treats the ordinary not_available inference geo as Standard pricing', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-standard-geo',
            type: 'message',
            role: 'assistant',
            model: 'claude-haiku-4-5-20251001',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              service_tier: 'standard',
              inference_geo: 'not_available',
            },
          }),
      });

      const response = await new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-haiku-4-5',
      });
      expect(response.cost).toBeCloseTo(0.00035, 8);
    });

    it('leaves not_available inference geo unpriced for Claude 4.6 and later', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-modern-unknown-geo',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              service_tier: 'standard',
              inference_geo: 'not_available',
            },
          }),
      });

      const response = await new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-5',
      });
      expect(response.cost).toBeUndefined();
    });

    it('leaves unknown modern Claude snapshot siblings unpriced', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-price-47-versioned',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
      });

      const provider = new AnthropicProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-4-7-20251201',
        maxTokens: 1024,
      });

      expect(response.cost).toBeUndefined();
    });

    it('returns undefined cost for unknown models (honest lower-bound signal)', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-unknown',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
      });

      const provider = new AnthropicProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-unknown-model-9000',
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
            JSON.stringify({ error: { message: 'Bad request', type: 'invalid_request' } }),
          ),
      });

      const provider = new AnthropicProvider();
      await expect(
        provider.chat([{ role: 'user', content: 'Hi' }], {
          model: 'claude-sonnet-4',
          maxTokens: 1024,
        }),
      ).rejects.toThrow('Anthropic API error (400): Bad request');
    });

    it('passes signal to fetch', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-5',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const controller = new AbortController();
      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 1024,
        signal: controller.signal,
      });

      expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
    });

    it('maps toolChoice "required" to Anthropic tool_choice {type:"any"}', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-tc',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 1024,
        toolChoice: 'required',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.tool_choice).toEqual({ type: 'any' });
    });

    it('maps toolChoice "auto" to Anthropic tool_choice {type:"auto"}', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-tc2',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 1024,
        toolChoice: 'auto',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.tool_choice).toEqual({ type: 'auto' });
    });

    it('maps specific function toolChoice to Anthropic {type:"tool", name}', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-tc3',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 1024,
        toolChoice: { type: 'function', function: { name: 'search' } },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.tool_choice).toEqual({ type: 'tool', name: 'search' });
    });

    it('maps effort "high" to manual mode with budget_tokens on older models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 1024,
        effort: 'high',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
      expect(body.output_config).toBeUndefined();
    });

    it('maps effort "high" to adaptive mode with effort on 4.6 models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th1a',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4-6',
        maxTokens: 4096,
        effort: 'high',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'high' });
    });

    it('maps effort "low" to adaptive mode with effort on opus 4.6', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th1b',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-4-6',
        maxTokens: 4096,
        effort: 'low',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'low' });
    });

    it('adaptive mode does not auto-bump max_tokens', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th1c',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4-6',
        maxTokens: 4096,
        effort: 'high',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Adaptive mode has no budget_tokens, so max_tokens stays as-is
      expect(body.max_tokens).toBe(4096);
    });

    it('uses manual mode with budget_tokens for thinkingBudget on 4.6 models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th1d',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4-6',
        maxTokens: 4096,
        thinkingBudget: 3000,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Budget form always uses manual mode for precise control
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 3000 });
      expect(body.output_config).toBeUndefined();
    });

    it('maps effort "max" to adaptive mode with effort "max" on Opus 4.6', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th-max-adaptive',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-4-6',
        maxTokens: 4096,
        effort: 'max',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'max' });
    });

    it('maps effort "max" to adaptive mode with effort "max" on Sonnet 4.6', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th-max-sonnet46',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4-6',
        maxTokens: 4096,
        effort: 'max',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'max' });
      // Adaptive mode does not bump max_tokens
      expect(body.max_tokens).toBe(4096);
    });

    it('maps effort "xhigh" to adaptive mode with effort "xhigh" on Opus 4.7', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th-xhigh-47',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-4-7',
        maxTokens: 4096,
        effort: 'xhigh',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'xhigh' });
    });

    it('maps effort "max" to adaptive mode with effort "max" on Opus 4.7', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th-max-47',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-4-7',
        maxTokens: 4096,
        effort: 'max',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'max' });
    });

    it('maps effort "xhigh" to adaptive mode with effort "xhigh" on Opus 4.8', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th-xhigh-48',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-4-8',
        maxTokens: 4096,
        effort: 'xhigh',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'xhigh' });
    });

    it('maps effort "max" to adaptive mode with effort "max" on Opus 4.8', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th-max-48',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-4-8',
        maxTokens: 4096,
        effort: 'max',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'max' });
    });

    it('clamps effort "xhigh" to "high" on Opus 4.6 (does not support xhigh)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th-xhigh-46',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-4-6',
        maxTokens: 4096,
        effort: 'xhigh',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'high' });
    });

    it('clamps effort "xhigh" to "high" on Opus 4.5 (no adaptive, effort only)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th-xhigh-45',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-4-5',
        maxTokens: 4096,
        effort: 'xhigh',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // 4.5 has no adaptive thinking; xhigh clamps to 'high'
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toEqual({ effort: 'high' });
    });

    it('maps effort "max" to manual mode with budget_tokens on older models (max downgraded to high)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th-max-manual',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 4096,
        effort: 'max',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // 'max' downgraded to 'high' (older model doesn't support max effort)
      // Falls back to manual thinking budget
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
      // Should auto-bump max_tokens since 4096 < 10000 + 1024
      expect(body.max_tokens).toBe(11024);
    });

    it('maps thinkingBudget to Anthropic thinking with exact budget_tokens', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th2',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 1024,
        thinkingBudget: 3000,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 3000 });
    });

    it('does not include thinking when thinking is undefined', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th3',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 1024,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toBeUndefined();
    });

    it('ignores includeThoughts-only option (Gemini-only feature)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th4',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        includeThoughts: true,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // includeThoughts is Gemini-only; should not trigger Anthropic thinking
      expect(body.thinking).toBeUndefined();
    });

    it('auto-bumps max_tokens when thinking budget exceeds it (manual mode)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th-bump',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      // maxTokens 4096 < budget_tokens 10000 for 'high'
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 4096,
        effort: 'high',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
      // Should be auto-bumped to budget_tokens + 1024
      expect(body.max_tokens).toBe(11024);
    });

    it('does not bump max_tokens when already sufficient for thinking budget (manual mode)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-th-nobump',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      // maxTokens 4096 > budget_tokens 1024 + 1024 for 'low'
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 4096,
        effort: 'low',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
      expect(body.max_tokens).toBe(4096);
    });

    it('strips temperature when thinking is enabled', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-temp',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 4096,
        temperature: 0.7,
        effort: 'low',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBeUndefined();
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    });

    it('uses the providerOptions model for Anthropic thinking and temperature', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-effective-model',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });
      await new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        effort: 'low',
        temperature: 0.7,
        providerOptions: { model: 'claude-opus-4-5' },
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe('claude-opus-4-5');
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toEqual({ effort: 'low' });
      expect(body.temperature).toBe(0.7);
    });

    it('allows temperature when thinking is not set', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-temp2',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 4096,
        temperature: 0.7,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.7);
      expect(body.thinking).toBeUndefined();
    });

    it('does not include tool_choice when toolChoice is undefined', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-tc4',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 1024,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.tool_choice).toBeUndefined();
    });

    it('sends nothing for effort "none" (no thinking, no output_config)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-none-46',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4-6',
        maxTokens: 4096,
        effort: 'none',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toBeUndefined();
    });

    it('sends nothing for effort "none" on older models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-none-old',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 4096,
        effort: 'none',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toBeUndefined();
    });

    it('sends output_config effort only on opus-4-5 (no adaptive)', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-opus45',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-4-5',
        maxTokens: 4096,
        effort: 'low',
        temperature: 0.5,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Opus 4.5 supports effort but NOT adaptive thinking
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toEqual({ effort: 'low' });
      // Temperature should pass through (no thinking block present)
      expect(body.temperature).toBe(0.5);
    });

    it('sends output_config without thinking for effort + thinkingBudget: 0 on 4.6', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-effort-tb0-46',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4-6',
        maxTokens: 4096,
        effort: 'low',
        thinkingBudget: 0,
        temperature: 0.7,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // thinkingBudget: 0 disables thinking, but effort still goes through as standalone
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toEqual({ effort: 'low' });
      // Temperature should pass through (no thinking block)
      expect(body.temperature).toBe(0.7);
    });

    it('sends nothing for effort + thinkingBudget: 0 on older models', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-effort-tb0-old',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 4096,
        effort: 'low',
        thinkingBudget: 0,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Older model: no effort support and thinkingBudget: 0 disables thinking → no-op
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toBeUndefined();
    });

    it('sends manual thinking + output_config for thinkingBudget + effort on 4.6', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-budget-effort-46',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-4-6',
        maxTokens: 4096,
        thinkingBudget: 8000,
        effort: 'high',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Explicit budget → manual thinking; effort sent alongside on 4.6
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
      expect(body.output_config).toEqual({ effort: 'high' });
      // max_tokens auto-bumped since 4096 < 8000 + 1024
      expect(body.max_tokens).toBe(9024);
    });

    it('positive thinkingBudget overrides effort "none"', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-budget-override-none',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4-6',
        maxTokens: 4096,
        effort: 'none',
        thinkingBudget: 5000,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Positive budget overrides effort: 'none' → thinking enabled
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
      // effort: 'none' → activeEffort is undefined → no output_config
      expect(body.output_config).toBeUndefined();
    });

    it('resolves every Claude 5 portable-thinking control to a valid request body', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const models = [
        ['claude-fable-5', false],
        ['claude-opus-5', true],
        ['claude-sonnet-5', true],
      ] as const;
      const response = {
        id: 'msg-5',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      const request = async (
        model: string,
        controls: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        const fetchMock = mockFetch({ json: () => Promise.resolve(response) });
        await new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
          model,
          maxTokens: 1024,
          temperature: 0.7,
          ...controls,
        });
        return JSON.parse(fetchMock.mock.calls[0][1].body);
      };

      try {
        for (const [model, disableable] of models) {
          const omitted = await request(model, {});
          expect(omitted.thinking).toBeUndefined();
          expect(omitted.output_config).toBeUndefined();
          expect(omitted.temperature).toBeUndefined();

          const none = await request(model, { effort: 'none' });
          expect(none.thinking).toEqual(disableable ? { type: 'disabled' } : { type: 'adaptive' });
          expect(none.output_config).toEqual(disableable ? undefined : { effort: 'low' });

          for (const effort of ['low', 'xhigh', 'max'] as const) {
            const body = await request(model, { effort });
            expect(body.thinking).toEqual({ type: 'adaptive' });
            expect(body.output_config).toEqual({ effort });
          }

          const disabled = await request(model, { thinkingBudget: 0 });
          expect(disabled.thinking).toEqual(
            disableable ? { type: 'disabled' } : { type: 'adaptive' },
          );

          const budget = await request(model, { thinkingBudget: 2000 });
          expect(budget.thinking).toEqual({ type: 'adaptive' });
          expect(budget.output_config).toEqual({ effort: 'medium' });
          expect(budget.thinking.budget_tokens).toBeUndefined();

          const conflict = await request(model, { effort: 'max', thinkingBudget: 2000 });
          expect(conflict.thinking).toEqual({ type: 'adaptive' });
          expect(conflict.output_config).toEqual({ effort: 'medium' });
        }

        const opusConflict = await request('claude-opus-5', { effort: 'xhigh', thinkingBudget: 0 });
        expect(opusConflict.thinking).toEqual({ type: 'adaptive' });
        expect(opusConflict.output_config).toEqual({ effort: 'xhigh' });
        // The 'cannot disable thinking' fallback above is reported through
        // `effortResolution` (see the effortResolution suite), not a console.warn.
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('strips temperature for Opus 4.7/4.8 without thinking but preserves 4.6 behavior', async () => {
      for (const model of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-4-6']) {
        const fetchMock = mockFetch({
          json: () =>
            Promise.resolve({
              id: 'msg-temp-regression',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        });
        await new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
          model,
          maxTokens: 1024,
          temperature: 0.7,
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.temperature).toBe(model === 'claude-opus-4-6' ? 0.7 : undefined);
      }
    });

    it('keeps 4.6 manual budgets but maps 4.7/4.8 budgets to adaptive effort', async () => {
      for (const [model, expectedThinking] of [
        ['claude-opus-4-6', { type: 'enabled', budget_tokens: 2000 }],
        ['claude-opus-4-7', { type: 'adaptive' }],
        ['claude-opus-4-8', { type: 'adaptive' }],
      ]) {
        const fetchMock = mockFetch({
          json: () =>
            Promise.resolve({
              id: 'msg-budget-regression',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        });
        await new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
          model,
          maxTokens: 1024,
          thinkingBudget: 2000,
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.thinking).toEqual(expectedThinking);
        expect(body.output_config).toEqual(
          model === 'claude-opus-4-6' ? undefined : { effort: 'medium' },
        );
      }
    });

    it('maps Claude 5 manual-budget anchors through every supported effort tier', async () => {
      for (const [budget, effort] of [
        [1024, 'low'],
        [1025, 'medium'],
        [5000, 'medium'],
        [5001, 'high'],
        [10000, 'high'],
        [10001, 'xhigh'],
        [20000, 'xhigh'],
        [20001, 'max'],
        [30000, 'max'],
      ]) {
        const fetchMock = mockFetch({
          json: () =>
            Promise.resolve({
              id: 'msg-budget-anchor',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        });
        await new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
          model: 'claude-opus-5',
          maxTokens: 1024,
          thinkingBudget: budget,
        });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).output_config).toEqual({ effort });
      }
    });

    it('does not infer Claude 5 capabilities for an unknown sibling', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-unknown-sibling',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
      });
      const response = await new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-5-future',
        maxTokens: 1024,
        temperature: 0.7,
        effort: 'high',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toBeUndefined();
      expect(body.temperature).toBe(0.7);
      expect(response.cost).toBeUndefined();
    });

    it('retains manual thinking only for documented legacy snapshots', async () => {
      for (const [model, expectedThinking] of [
        ['claude-3-7-sonnet-20250219', { type: 'enabled', budget_tokens: 10000 }],
        ['claude-3-5-sonnet-20240620', { type: 'enabled', budget_tokens: 10000 }],
        ['claude-3-7-sonnet-future', undefined],
      ]) {
        const fetchMock = mockFetch({
          json: () =>
            Promise.resolve({
              id: 'msg-legacy-snapshot',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        });
        await new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
          model,
          maxTokens: 1024,
          effort: 'high',
          temperature: 0.7,
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.thinking).toEqual(expectedThinking);
        expect(body.temperature).toBe(expectedThinking ? undefined : 0.7);
      }
    });

    it('preserves opaque thinking blocks and signatures for non-stream continuations', async () => {
      const firstFetch = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-thoughts',
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'reasoning', signature: 'sig-1' },
              { type: 'redacted_thinking', data: 'opaque-redacted' },
              { type: 'tool_use', id: 'tool-1', name: 'lookup', input: { q: 'a' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
      });
      const provider = new AnthropicProvider();
      const first = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-5',
        maxTokens: 1024,
      });
      expect(first.providerMetadata).toEqual({
        anthropicThinkingBlocks: [
          { type: 'thinking', thinking: 'reasoning', signature: 'sig-1' },
          { type: 'redacted_thinking', data: 'opaque-redacted' },
        ],
      });
      expect(firstFetch).toHaveBeenCalledTimes(1);

      const continuationFetch = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-continuation',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
      });
      await provider.chat(
        [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: first.tool_calls,
            providerMetadata: first.providerMetadata,
          },
          { role: 'tool', content: 'result', tool_call_id: 'tool-1' },
        ],
        { model: 'claude-sonnet-5', maxTokens: 1024 },
      );
      const assistant = JSON.parse(continuationFetch.mock.calls[0][1].body).messages[1];
      expect(assistant.content).toEqual([
        { type: 'thinking', thinking: 'reasoning', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'opaque-redacted' },
        { type: 'tool_use', id: 'tool-1', name: 'lookup', input: { q: 'a' } },
      ]);
    });

    it('rejects any fallback-served response before it enters continuation history', async () => {
      const fallbackFetch = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-fallback',
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'reasoning', signature: 'sig-fallback' },
              { type: 'fallback', model: 'claude-other' },
              { type: 'text', text: 'answer' },
              { type: 'tool_use', id: 'fallback-tool', name: 'lookup', input: { q: 'a' } },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
      });
      await expect(
        new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
          model: 'claude-opus-5',
          maxTokens: 1024,
        }),
      ).rejects.toThrow('fallback responses cannot be continued safely');
      expect(fallbackFetch).toHaveBeenCalledTimes(1);
    });

    it('rejects a text-only fallback response before it enters history', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-fallback-text',
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'discard this', signature: 'sig' },
              { type: 'fallback', model: 'claude-other' },
              { type: 'text', text: 'answer' },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
      });
      await expect(
        new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
          model: 'claude-opus-5',
          maxTokens: 1024,
        }),
      ).rejects.toThrow('fallback responses cannot be continued safely');
    });

    it('leaves a refusal response unpriced', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-refusal',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'cannot comply' }],
            stop_reason: 'refusal',
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
      });
      const refusal = await new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-5',
        maxTokens: 1024,
      });
      expect(refusal.cost).toBeUndefined();
    });

    it('rejects response-reported fallback iterations and suppresses thinking metadata', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-iterations',
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'do not replay', signature: 'iteration-sig' },
              { type: 'text', text: 'ok' },
            ],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              iterations: [{ type: 'fallback_message', model: 'claude-sonnet-5' }],
            },
          }),
      });
      await expect(
        new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
          model: 'claude-opus-5',
          maxTokens: 1024,
        }),
      ).rejects.toThrow('fallback responses cannot be continued safely');
    });

    it('never estimates cost from absent or malformed mandatory token counts', async () => {
      for (const usage of [
        { input_tokens: 1 },
        { output_tokens: 1 },
        { input_tokens: -1, output_tokens: 1 },
        { input_tokens: 1.5, output_tokens: 1 },
        { input_tokens: Number.POSITIVE_INFINITY, output_tokens: 1 },
        { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
      ]) {
        mockFetch({
          json: () =>
            Promise.resolve({
              id: 'msg-malformed-usage',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage,
            }),
        });
        const response = await new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
          model: 'claude-opus-5',
          maxTokens: 1024,
        });
        expect(response.cost).toBeUndefined();
        expect(response.usage).toBeUndefined();
      }
    });

    it('prices Claude 5 exact models and TTL cache buckets', () => {
      expect(
        estimateAnthropicCost('claude-fable-5', { inputTokens: 100, outputTokens: 50 }),
      ).toBeCloseTo(0.0035, 10);
      expect(
        estimateAnthropicCost('claude-opus-5', {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 50,
          cacheWrite5mTokens: 20,
          cacheWrite1hTokens: 10,
          aggregateCacheWriteTokens: 30,
        }),
      ).toBeCloseTo(0.002, 10);
      for (const model of [
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-opus-4-5-20251101',
        'claude-sonnet-4-5-20250929',
        'claude-haiku-4-5-20251001',
        'claude-opus-4-1-20250805',
      ]) {
        expect(estimateAnthropicCost(model, { inputTokens: 1, outputTokens: 1 })).toBeDefined();
      }
      expect(
        estimateAnthropicCost('claude-opus-4', { inputTokens: 1, outputTokens: 1 }),
      ).toBeUndefined();
      // Sonnet 5 is $2/$10: the announced 2026-09-01 increase to $3/$15 was
      // cancelled, so the rate is flat and must not vary with the clock.
      expect(
        estimateAnthropicCost('claude-sonnet-5', { inputTokens: 100, outputTokens: 50 }),
      ).toBeCloseTo(0.0007, 10);
      expect(
        estimateAnthropicCost('claude-opus-5', {
          inputTokens: 100,
          outputTokens: 50,
          aggregateCacheWriteTokens: 20,
        }),
      ).toBeUndefined();
      expect(
        estimateAnthropicCost('claude-opus-5-future', { inputTokens: 1, outputTokens: 1 }),
      ).toBeUndefined();
    });

    it('prices from the merged effective model and leaves speed/geo modifiers unpriced', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-effective',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
      });
      const provider = new AnthropicProvider();
      const effective = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        providerOptions: { model: 'claude-fable-5' },
      });
      expect(effective.cost).toBeCloseTo(0.0035, 10);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('claude-fable-5');

      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-fast',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50, speed: 'fast' },
          }),
      });
      const fast = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-5',
        maxTokens: 1024,
        providerOptions: { speed: 'fast', inference_geo: 'us' },
      });
      expect(fast.cost).toBeUndefined();
    });

    it('leaves an explicit fallback request unpriced', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-fallback-request-isolated',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
      });
      const response = await new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-5',
        maxTokens: 1024,
        providerOptions: { fallbacks: ['claude-sonnet-5'] },
      });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).fallbacks).toEqual(['claude-sonnet-5']);
      expect(response.cost).toBeUndefined();
    });

    it('does not treat response-only not_available geo metadata as a safe request override', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-request-geo-not-available',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              inference_geo: 'not_available',
            },
          }),
      });
      const response = await new AnthropicProvider().chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-haiku-4-5',
        providerOptions: { inference_geo: 'not_available' },
      });
      expect(response.cost).toBeUndefined();
    });

    it('merges providerOptions into request body', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-po',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 1024,
        providerOptions: { metadata: { user_id: 'abc' } },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.metadata).toEqual({ user_id: 'abc' });
    });

    it('extracts thinking_content from response with thinking blocks', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-thinking',
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Let me think about this...' },
              { type: 'thinking', thinking: ' I need to consider the options.' },
              { type: 'text', text: 'Here is my answer.' },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 20, output_tokens: 30 },
          }),
      });

      const provider = new AnthropicProvider();
      const response = await provider.chat([{ role: 'user', content: 'Think about this' }], {
        model: 'claude-sonnet-4-6',
        maxTokens: 4096,
        effort: 'high',
      });

      expect(response.content).toBe('Here is my answer.');
      expect(response.thinking_content).toBe(
        'Let me think about this... I need to consider the options.',
      );
    });

    it('returns undefined thinking_content when no thinking blocks are present', async () => {
      mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-no-thinking',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello!' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-sonnet-4',
        maxTokens: 1024,
      });

      expect(response.content).toBe('Hello!');
      expect(response.thinking_content).toBeUndefined();
    });

    it('merges consecutive same-role messages', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-6',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      });

      const provider = new AnthropicProvider();
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
          { role: 'tool', content: 'result1', tool_call_id: 'tc_1' },
          { role: 'tool', content: 'result2', tool_call_id: 'tc_2' },
        ],
        { model: 'claude-sonnet-4', maxTokens: 1024 },
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Consecutive tool messages (mapped to user) should be merged into one user message
      // with multiple tool_result content blocks
      const userMsgs = body.messages.filter((m: any) => m.role === 'user');
      const toolResultMsg = userMsgs.find(
        (m: any) =>
          Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'),
      );
      expect(toolResultMsg).toBeDefined();
      const toolResults = toolResultMsg.content.filter((b: any) => b.type === 'tool_result');
      expect(toolResults).toHaveLength(2);
    });
  });

  describe('stream()', () => {
    function createSSEStream(
      events: Array<{ type: string; [key: string]: unknown }>,
    ): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(lines));
          controller.close();
        },
      });
    }

    it('uses the providerOptions model for streaming thinking and temperature', async () => {
      const fetchMock = mockFetch({
        body: createSSEStream([
          { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: 'message_delta', usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ]),
      });
      const chunks: StreamChunk[] = [];
      for await (const chunk of new AnthropicProvider().stream(
        [{ role: 'user', content: 'Hello' }],
        {
          model: 'claude-sonnet-4',
          effort: 'low',
          temperature: 0.7,
          providerOptions: { model: 'claude-opus-4-5' },
        },
      )) {
        chunks.push(chunk);
      }
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe('claude-opus-4-5');
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toEqual({ effort: 'low' });
      expect(body.temperature).toBe(0.7);
      expect(chunks.at(-1)).toMatchObject({ type: 'done' });
    });

    it('retains aggregate-only cache writes in stream usage without estimating their cost', async () => {
      mockFetch({
        body: createSSEStream([
          {
            type: 'message_start',
            message: {
              usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 20 },
            },
          },
          { type: 'message_delta', usage: { output_tokens: 50 } },
          { type: 'message_stop' },
        ]),
      });
      const chunks: StreamChunk[] = [];
      for await (const chunk of new AnthropicProvider().stream(
        [{ role: 'user', content: 'Hello' }],
        { model: 'claude-opus-5' },
      )) {
        chunks.push(chunk);
      }
      expect(chunks.at(-1)).toMatchObject({
        type: 'done',
        usage: {
          prompt_tokens: 120,
          completion_tokens: 50,
          total_tokens: 170,
          cache_write_tokens: 20,
        },
        cost: undefined,
      });
    });

    it('emits thinking_delta chunks for thinking content blocks', async () => {
      const sseEvents = [
        {
          type: 'message_start',
          message: { usage: { input_tokens: 10, output_tokens: 0 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me think' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: ' about this...' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Here is my answer.' },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 25 },
        },
        { type: 'message_stop' },
      ];

      mockFetch({ body: createSSEStream(sseEvents) });

      const provider = new AnthropicProvider();
      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.stream([{ role: 'user', content: 'Think' }], {
        model: 'claude-sonnet-4-6',
        maxTokens: 4096,
        effort: 'high',
      })) {
        chunks.push(chunk);
      }

      const thinkingChunks = chunks.filter((c) => c.type === 'thinking_delta');
      expect(thinkingChunks).toHaveLength(2);
      expect(thinkingChunks[0]).toEqual({ type: 'thinking_delta', content: 'Let me think' });
      expect(thinkingChunks[1]).toEqual({ type: 'thinking_delta', content: ' about this...' });

      const textChunks = chunks.filter((c) => c.type === 'text_delta');
      expect(textChunks).toHaveLength(1);
      expect(textChunks[0]).toEqual({ type: 'text_delta', content: 'Here is my answer.' });

      const doneChunk = chunks.find((c) => c.type === 'done');
      expect(doneChunk).toBeDefined();
      expect(doneChunk!.type === 'done' && doneChunk!.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 25,
        total_tokens: 35,
      });
    });

    it('does not emit thinking_delta when no thinking blocks are streamed', async () => {
      const sseEvents = [
        {
          type: 'message_start',
          message: { usage: { input_tokens: 5, output_tokens: 0 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello!' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 3 },
        },
        { type: 'message_stop' },
      ];

      mockFetch({ body: createSSEStream(sseEvents) });

      const provider = new AnthropicProvider();
      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.stream([{ role: 'user', content: 'Hi' }], {
        model: 'claude-sonnet-4',
        maxTokens: 1024,
      })) {
        chunks.push(chunk);
      }

      const thinkingChunks = chunks.filter((c) => c.type === 'thinking_delta');
      expect(thinkingChunks).toHaveLength(0);

      const textChunks = chunks.filter((c) => c.type === 'text_delta');
      expect(textChunks).toHaveLength(1);
      expect(textChunks[0]).toEqual({ type: 'text_delta', content: 'Hello!' });
    });

    it('captures streamed thinking signatures and replays them before tool blocks', async () => {
      const sseEvents = [
        {
          type: 'message_start',
          message: { usage: { input_tokens: 10, output_tokens: 0 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'reason' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig-' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'stream' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'redacted_thinking', data: 'opaque' },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'tool-stream', name: 'lookup' },
        },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ];
      mockFetch({ body: createSSEStream(sseEvents) });
      const provider = new AnthropicProvider();
      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.stream([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-5',
        maxTokens: 1024,
      })) {
        chunks.push(chunk);
      }
      const done = chunks.at(-1);
      expect(done).toMatchObject({
        type: 'done',
        providerMetadata: {
          anthropicThinkingBlocks: [
            { type: 'thinking', thinking: 'reason', signature: 'sig-stream' },
            { type: 'redacted_thinking', data: 'opaque' },
          ],
        },
      });

      const continuationFetch = mockFetch({
        json: () =>
          Promise.resolve({
            id: 'msg-after-stream',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
      });
      await provider.chat(
        [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tool-stream',
                type: 'function',
                function: { name: 'lookup', arguments: '{}' },
              },
            ],
            providerMetadata: done!.type === 'done' ? done!.providerMetadata : undefined,
          },
          { role: 'tool', content: 'result', tool_call_id: 'tool-stream' },
        ],
        { model: 'claude-opus-5', maxTokens: 1024 },
      );
      const assistant = JSON.parse(continuationFetch.mock.calls[0][1].body).messages[1];
      expect(assistant.content.slice(0, 2)).toEqual([
        { type: 'thinking', thinking: 'reason', signature: 'sig-stream' },
        { type: 'redacted_thinking', data: 'opaque' },
      ]);
      expect(assistant.content[2]).toMatchObject({ type: 'tool_use', id: 'tool-stream' });
    });

    it('retains TTL cache-write usage and uses the same stream cost estimator', async () => {
      const sseEvents = [
        {
          type: 'message_start',
          message: {
            model: 'claude-opus-5',
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 30,
              cache_creation: {
                ephemeral_5m_input_tokens: 20,
                ephemeral_1h_input_tokens: 10,
              },
            },
          },
        },
        {
          type: 'message_delta',
          usage: { output_tokens: 50, speed: 'standard', inference_geo: 'global' },
        },
        { type: 'message_stop' },
      ];
      mockFetch({ body: createSSEStream(sseEvents) });
      const chunks: StreamChunk[] = [];
      for await (const chunk of new AnthropicProvider().stream(
        [{ role: 'user', content: 'Hello' }],
        {
          model: 'claude-opus-5',
          maxTokens: 1024,
        },
      )) {
        chunks.push(chunk);
      }
      const done = chunks.at(-1);
      expect(done).toMatchObject({
        type: 'done',
        usage: {
          prompt_tokens: 180,
          completion_tokens: 50,
          total_tokens: 230,
          cached_tokens: 50,
          cache_write_tokens: 30,
        },
      });
      expect(done!.type === 'done' && done!.cost).toBeCloseTo(0.002, 10);
    });

    it('rejects any fallback stream before a successful done chunk', async () => {
      const sseEvents = [
        {
          type: 'message_start',
          message: { usage: { input_tokens: 100, output_tokens: 0 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'reason' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'fallback', model: 'other' },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'stream-fallback-tool', name: 'lookup' },
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"q":"a"}' },
        },
        { type: 'content_block_stop', index: 2 },
        {
          type: 'message_delta',
          usage: { output_tokens: 50 },
        },
        { type: 'message_stop' },
      ];
      mockFetch({ body: createSSEStream(sseEvents) });
      const stream = new AnthropicProvider().stream([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-5',
        maxTokens: 1024,
      });
      await expect(
        (async () => {
          for await (const chunk of stream) {
            expect(chunk.type).not.toBe('done');
          }
        })(),
      ).rejects.toThrow('fallback streams cannot be continued safely');
    });

    it('rejects a fallback-message iteration stream without client tools', async () => {
      mockFetch({
        body: createSSEStream([
          { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
          {
            type: 'message_delta',
            usage: {
              output_tokens: 5,
              iterations: [{ type: 'fallback_message', model: 'claude-sonnet-5' }],
            },
          },
          { type: 'message_stop' },
        ]),
      });
      const stream = new AnthropicProvider().stream([{ role: 'user', content: 'Hello' }], {
        model: 'claude-opus-5',
        maxTokens: 1024,
      });
      await expect(
        (async () => {
          for await (const chunk of stream) {
            expect(chunk.type).not.toBe('done');
          }
        })(),
      ).rejects.toThrow('fallback streams cannot be continued safely');
    });

    it('leaves a non-fallback iteration stream unpriced without rejecting it', async () => {
      mockFetch({
        body: createSSEStream([
          { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
          {
            type: 'message_delta',
            usage: {
              output_tokens: 5,
              iterations: [{ type: 'message', model: 'claude-opus-5' }],
            },
          },
          { type: 'message_stop' },
        ]),
      });
      const chunks: StreamChunk[] = [];
      for await (const chunk of new AnthropicProvider().stream(
        [{ role: 'user', content: 'Hello' }],
        { model: 'claude-opus-5' },
      )) {
        chunks.push(chunk);
      }
      expect(chunks.at(-1)).toMatchObject({ type: 'done', cost: undefined });
    });

    it('re-normalizes cumulative terminal usage and rejects TTL aggregate conflicts', async () => {
      const sseEvents = [
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 30,
              cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 },
            },
          },
        },
        {
          type: 'message_delta',
          usage: {
            input_tokens: 110,
            cache_read_input_tokens: 55,
            cache_creation_input_tokens: 20,
            output_tokens: 50,
          },
        },
        { type: 'message_stop' },
      ];
      mockFetch({ body: createSSEStream(sseEvents) });
      const chunks: StreamChunk[] = [];
      for await (const chunk of new AnthropicProvider().stream(
        [{ role: 'user', content: 'Hello' }],
        { model: 'claude-opus-5', maxTokens: 1024 },
      )) {
        chunks.push(chunk);
      }
      const done = chunks.at(-1);
      expect(done).toMatchObject({
        type: 'done',
        usage: {
          prompt_tokens: 185,
          completion_tokens: 50,
          total_tokens: 235,
          cache_write_tokens: 30,
        },
        cost: undefined,
      });
    });

    it('leaves a stream refusal unpriced', async () => {
      const sseEvents = [
        { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } },
        { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 50 } },
        { type: 'message_stop' },
      ];
      mockFetch({ body: createSSEStream(sseEvents) });
      const chunks: StreamChunk[] = [];
      for await (const chunk of new AnthropicProvider().stream(
        [{ role: 'user', content: 'Hello' }],
        { model: 'claude-opus-5', maxTokens: 1024 },
      )) {
        chunks.push(chunk);
      }
      expect(chunks.at(-1)).toMatchObject({ type: 'done', cost: undefined });
    });

    it('maps ordered image input blocks and keeps rich text-table cost unpriced', async () => {
      const fetchMock = mockFetch({
        json: () =>
          Promise.resolve({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 10, output_tokens: 1 },
          }),
      });
      const provider = new AnthropicProvider();
      const response = await provider.chat(
        [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                label: 'receipt',
                source: { type: 'base64', data: 'AQID', mediaType: 'image/png' },
              },
              { type: 'text', text: 'read it' },
              {
                type: 'image',
                source: { type: 'provider-file', provider: 'anthropic', reference: 'file_123' },
              },
            ],
          },
        ],
        { model: 'claude-opus-5' },
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(fetchMock.mock.calls[0][1].headers['anthropic-beta']).toBe('files-api-2025-04-14');
      expect(body.messages[0].content).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
        { type: 'text', text: '[Image: receipt]' },
        { type: 'text', text: 'read it' },
        { type: 'image', source: { type: 'file', file_id: 'file_123' } },
      ]);
      expect(response.cost).toBeUndefined();
      expect(() =>
        provider.validateInput({
          model: 'claude-sonnet-4-5',
          input: [
            {
              type: 'image',
              source: { type: 'provider-file', provider: 'google', reference: 'secret' },
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
          providerOptions: { model: 'future-claude-model' },
        }),
      ).toEqual({ effectiveModel: 'future-claude-model' });
      expect(() =>
        provider.validateInput({
          model: '',
          input: [
            { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } },
          ],
          history: [],
          stream: false,
          hasTools: false,
          responseMode: 'text',
        }),
      ).toThrow('image input for this model');
      expect(provider.inputCapabilities('claude-opus-5')).toEqual({
        image: { sources: ['url', 'bytes', 'base64', 'provider-file'] },
      });
      expect(provider.inputCapabilities('future-claude-model')).toEqual({
        image: { sources: ['url', 'bytes', 'base64', 'provider-file'] },
      });
      expect(provider.inputCapabilities('')).toEqual({});
      for (const model of [undefined, 42, '   ']) {
        expect(() =>
          provider.validateInput({
            model: 'claude-opus-5',
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

    it('surfaces Anthropic SSE error events as typed provider failures', async () => {
      mockFetch({
        body: createSSEStream([
          {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'image model rejected' },
          },
        ]),
      });

      await expect(
        (async () => {
          for await (const chunk of new AnthropicProvider().stream(
            [{ role: 'user', content: 'Hello' }],
            { model: 'future-claude-model' },
          ))
            void chunk;
        })(),
      ).rejects.toMatchObject({
        name: 'ProviderError',
        provider: 'anthropic',
        status: 400,
        retryable: false,
        body: undefined,
      });
    });

    it('sets the Files beta header only for provider-file image current/history in chat and stream', async () => {
      const historyWithFile = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'image' as const,
              source: {
                type: 'provider-file' as const,
                provider: 'anthropic',
                reference: 'file_123',
              },
            },
          ],
        },
        {
          role: 'assistant' as const,
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'inspect', arguments: '{}' },
            },
          ],
        },
        { role: 'tool' as const, tool_call_id: 'call_1', content: '{"ok":true}' },
      ];
      const chatFetch = mockFetch({
        json: () => Promise.resolve({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
      });
      await new AnthropicProvider().chat(historyWithFile, {
        model: 'claude-sonnet-4-5',
        providerOptions: { 'anthropic-beta': 'attempted-override' },
      });
      expect(chatFetch.mock.calls[0][1].headers['anthropic-beta']).toBe('files-api-2025-04-14');

      const streamFetch = mockFetch({
        body: createSSEStream([
          { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'message_stop' },
        ]),
      });
      for await (const chunk of new AnthropicProvider().stream(historyWithFile, {
        model: 'claude-sonnet-4-5',
      })) {
        // Drain the stream; the header is the assertion seam.
        void chunk;
      }
      expect(streamFetch.mock.calls[0][1].headers['anthropic-beta']).toBe('files-api-2025-04-14');

      const noFileInputs = [
        [{ role: 'user' as const, content: 'plain text' }],
        [
          {
            role: 'user' as const,
            content: [
              {
                type: 'image' as const,
                source: { type: 'url' as const, url: 'https://example.test/image.png' },
              },
            ],
          },
        ],
        [
          {
            role: 'user' as const,
            content: [
              {
                type: 'image' as const,
                source: {
                  type: 'bytes' as const,
                  data: new Uint8Array([1]),
                  mediaType: 'image/png',
                },
              },
            ],
          },
        ],
      ];
      for (const messages of noFileInputs) {
        const noFileFetch = mockFetch({
          json: () =>
            Promise.resolve({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
        });
        await new AnthropicProvider().chat(messages, { model: 'claude-sonnet-4-5' });
        expect(noFileFetch.mock.calls[0][1].headers['anthropic-beta']).toBeUndefined();
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Effort provenance (B8) — Anthropic
// ═══════════════════════════════════════════════════════════════════════════

describe('AnthropicProvider.effortResolution', () => {
  const response = {
    id: 'msg-effort',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  it('reports the adaptive low fallback on a model that cannot disable thinking', async () => {
    const provider = new AnthropicProvider();
    const resolution = provider.effortResolution({ model: 'claude-fable-5', effort: 'none' });
    expect(resolution).toMatchObject({ requested: 'none', effective: 'low', clamped: true });
    expect(resolution!.cause).toContain('cannot be disabled');

    // Pairing: the request body carries that same effective level.
    const fetchMock = mockFetch({ json: () => Promise.resolve(response) });
    await provider.chat([{ role: 'user', content: 'Hello' }], {
      model: 'claude-fable-5',
      maxTokens: 1024,
      effort: 'none',
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'low' });
  });

  it.each([
    ['max', 10000],
    ['xhigh', 10000],
  ] as const)(
    'reports the legacy budget-tier downgrade of effort %s',
    async (effort, budgetTokens) => {
      const provider = new AnthropicProvider();
      const resolution = provider.effortResolution({ model: 'claude-sonnet-4', effort });
      expect(resolution).toMatchObject({ requested: effort, effective: 'high', clamped: true });
      expect(resolution!.cause).toContain('budget_tokens');

      // Pairing: the request carries the 'high' tier's budget, not the tier the
      // caller asked for ('max' would be 30000, 'xhigh' 20000).
      const fetchMock = mockFetch({ json: () => Promise.resolve(response) });
      await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 4096,
        effort,
      });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).thinking).toEqual({
        type: 'enabled',
        budget_tokens: budgetTokens,
      });
    },
  );

  it('reports nothing when a legacy model gets the ceiling tier it asked for', async () => {
    const provider = new AnthropicProvider();
    expect(provider.effortResolution({ model: 'claude-sonnet-4', effort: 'high' })).toBeUndefined();

    const fetchMock = mockFetch({ json: () => Promise.resolve(response) });
    await provider.chat([{ role: 'user', content: 'Hello' }], {
      model: 'claude-sonnet-4',
      maxTokens: 4096,
      effort: 'high',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).thinking).toEqual({
      type: 'enabled',
      budget_tokens: 10000,
    });
  });

  it('reports an effort level the model does not support', async () => {
    const provider = new AnthropicProvider();
    const resolution = provider.effortResolution({ model: 'claude-opus-4-5', effort: 'max' });
    expect(resolution).toMatchObject({ requested: 'max', effective: 'high', clamped: true });

    const fetchMock = mockFetch({ json: () => Promise.resolve(response) });
    await provider.chat([{ role: 'user', content: 'Hello' }], {
      model: 'claude-opus-4-5',
      maxTokens: 1024,
      effort: 'max',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).output_config).toEqual({ effort: 'high' });
  });

  it.each([
    ['claude-opus-5', 'none'],
    ['claude-opus-5', 'xhigh'],
    ['claude-sonnet-5', 'high'],
  ] as const)('reports nothing for honored %s effort %s', (model, effort) => {
    expect(new AnthropicProvider().effortResolution({ model, effort })).toBeUndefined();
  });

  it('reports nothing without an effort, for an unknown model, or under a budget override', () => {
    const provider = new AnthropicProvider();
    expect(provider.effortResolution({ model: 'claude-fable-5' })).toBeUndefined();
    expect(provider.effortResolution({ model: 'claude-unknown-9', effort: 'max' })).toBeUndefined();
    expect(
      provider.effortResolution({ model: 'claude-fable-5', effort: 'none', thinkingBudget: 2000 }),
    ).toBeUndefined();
  });

  it('resolves against the providerOptions model override', () => {
    expect(
      new AnthropicProvider().effortResolution({
        model: 'claude-opus-5',
        effort: 'none',
        providerOptions: { model: 'claude-fable-5' },
      }),
    ).toMatchObject({ effective: 'low', clamped: true });
  });
});
