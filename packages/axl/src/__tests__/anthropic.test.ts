import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicProvider } from '../providers/anthropic.js';

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

    it('maps thinking "high" to manual mode with budget_tokens on older models', async () => {
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
        thinking: 'high',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
      expect(body.output_config).toBeUndefined();
    });

    it('maps thinking "high" to adaptive mode with effort on 4.6 models', async () => {
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
        thinking: 'high',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'high' });
    });

    it('maps thinking "low" to adaptive mode with effort on opus 4.6', async () => {
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
        thinking: 'low',
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
        thinking: 'high',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Adaptive mode has no budget_tokens, so max_tokens stays as-is
      expect(body.max_tokens).toBe(4096);
    });

    it('uses manual mode with budget_tokens for budgetTokens form on 4.6 models', async () => {
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
        thinking: { budgetTokens: 3000 },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Budget form always uses manual mode for precise control
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 3000 });
      expect(body.output_config).toBeUndefined();
    });

    it('maps thinking "max" to adaptive mode with effort "max" on 4.6 models', async () => {
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
        thinking: 'max',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'max' });
    });

    it('maps thinking "max" to manual mode on Sonnet 4.6 (max effort not supported)', async () => {
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
        thinking: 'max',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Sonnet 4.6 does NOT support effort: 'max', so falls back to manual mode
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 30000 });
      expect(body.output_config).toBeUndefined();
      // Should auto-bump max_tokens
      expect(body.max_tokens).toBe(31024);
    });

    it('maps thinking "max" to manual mode with budget_tokens 30000 on older models', async () => {
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
        thinking: 'max',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 30000 });
      // Should auto-bump max_tokens since 4096 < 30000 + 1024
      expect(body.max_tokens).toBe(31024);
    });

    it('maps thinking budget form to Anthropic thinking with exact budget_tokens', async () => {
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
        thinking: { budgetTokens: 3000 },
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
        thinking: 'high',
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
        thinking: 'low',
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
        thinking: 'low',
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
});
