import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicProvider } from '../providers/anthropic.js';
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
        model: 'claude-sonnet-4',
        maxTokens: 1024,
      });

      // claude-sonnet-4: [3e-6, 15e-6]
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
            },
          }),
      });

      const provider = new AnthropicProvider();
      const response = await provider.chat([{ role: 'user', content: 'Hello' }], {
        model: 'claude-sonnet-4',
        maxTokens: 1024,
      });

      // claude-sonnet-4: [3e-6, 15e-6]
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
      });
    });

    it('returns cost: 0 for unknown models (not undefined)', async () => {
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

      expect(response.cost).toBe(0);
      expect(response.cost).not.toBeUndefined();
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

    it('maps effort "max" to adaptive mode with effort "high" on Sonnet 4.6 (max downgraded)', async () => {
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
      // Sonnet 4.6 does NOT support effort: 'max', so it's downgraded to 'high'
      // and uses adaptive mode since Sonnet 4.6 supports it
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'high' });
      // Adaptive mode does not bump max_tokens
      expect(body.max_tokens).toBe(4096);
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
  });
});
