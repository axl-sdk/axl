import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, estimateAnthropicCost } from '../providers/anthropic.js';
import { UnsupportedModelOptionError } from '../errors.js';
import type { ChatMessage } from '../providers/types.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';
import type { AxlEvent } from '../types.js';
import type { ChatOptions, Provider } from '../providers/types.js';
import { tool } from '../tool.js';
import { z } from 'zod';
import { redactEvent } from '../redaction.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const response = (input_transformations?: unknown) => ({
  id: 'msg',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
  input_transformations,
});

function fetchResponse(value: unknown = response()) {
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => value,
  });
  globalThis.fetch = fetcher;
  return fetcher;
}

const replay: ChatMessage[] = [
  { role: 'user', content: 'calculate' },
  {
    role: 'assistant',
    content: 'Working',
    providerMetadata: {
      anthropicThinkingBlocks: [
        { type: 'thinking', thinking: 'private reasoning', signature: 'signed-secret' },
      ],
    },
    tool_calls: [
      { id: 'tool-1', type: 'function', function: { name: 'calculate', arguments: '{"x":2}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'tool-1', content: '2' },
];

const provider = () => new AnthropicProvider({ apiKey: 'test-key' });

describe('Claude Opus 5.5 final wire contract', () => {
  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'sends adaptive thinking and native %s effort',
    async (effort) => {
      const fetcher = fetchResponse();
      await provider().chat([{ role: 'user', content: 'hi' }], {
        model: 'claude-opus-5-5',
        effort,
        temperature: 0.5,
      });
      const body = JSON.parse(fetcher.mock.calls[0][1].body);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort });
      expect(body.temperature).toBeUndefined();
    },
  );

  it('clamps none to low and prices base plus both cache-write TTLs and reads', async () => {
    const fetcher = fetchResponse();
    const p = provider();
    expect(p.effortResolution({ model: 'claude-opus-5-5', effort: 'none' })).toMatchObject({
      requested: 'none',
      effective: 'low',
      clamped: true,
    });
    await p.chat([{ role: 'user', content: 'hi' }], { model: 'claude-opus-5-5', effort: 'none' });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).output_config).toEqual({ effort: 'low' });
    expect(
      estimateAnthropicCost('claude-opus-5-5', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWrite5mTokens: 1_000_000,
        cacheWrite1hTokens: 1_000_000,
      }),
    ).toBeCloseTo(37.2);

    fetchResponse({
      ...response(),
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      },
    });
    const priced = await p.chat([{ role: 'user', content: 'hi' }], { model: 'claude-opus-5-5' });
    expect(priced.cost).toBeCloseTo(
      100 * 4e-6 + 50 * 20e-6 + 200 * 0.2e-6 + 100 * 5e-6 + 200 * 8e-6,
    );
    expect(priced.costProvenance).toBe('price_table_estimate');
  });

  it.each(['required', { type: 'function', function: { name: 'calculate' } }] as const)(
    'rejects forced portable choice before fetch on both bound models',
    async (toolChoice) => {
      const fetcher = fetchResponse();
      for (const model of ['claude-opus-5-5', 'claude-fable-5-1']) {
        await expect(
          provider().chat([{ role: 'user', content: 'hi' }], { model, toolChoice }),
        ).rejects.toMatchObject({
          name: 'UnsupportedModelOptionError',
          provider: 'anthropic',
          model,
          option: 'forced tool choice',
        });
      }
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('validates the final model, tool choice and thinking after providerOptions overrides', async () => {
    const fetcher = fetchResponse();
    await expect(
      provider().chat([{ role: 'user', content: 'hi' }], {
        model: 'claude-opus-5',
        toolChoice: 'auto',
        providerOptions: { model: 'claude-opus-5-5', tool_choice: { type: 'any' } },
      }),
    ).rejects.toMatchObject({ model: 'claude-opus-5-5', option: 'forced tool choice' });
    await expect(
      provider().chat([{ role: 'user', content: 'hi' }], {
        model: 'claude-opus-5-5',
        providerOptions: { thinking: { type: 'disabled' } },
      }),
    ).rejects.toBeInstanceOf(UnsupportedModelOptionError);
    expect(fetcher).not.toHaveBeenCalled();
    await provider().chat([{ role: 'user', content: 'hi' }], {
      model: 'claude-opus-5-5',
      toolChoice: 'required',
      providerOptions: { model: 'claude-opus-5', tool_choice: { type: 'any' } },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ thinking: { type: 'adaptive', budget_tokens: 1024 } }, 'manual or disabled thinking'],
    [{ output_config: { effort: 'none' } }, 'output_config.effort'],
    [{ temperature: 0.5 }, 'temperature'],
    [{ top_p: 0.5 }, 'top_p'],
    [{ top_k: 20 }, 'top_k'],
  ] as const)(
    'rejects invalid final native option %s before dispatch',
    async (providerOptions, option) => {
      const fetcher = fetchResponse();
      await expect(
        provider().chat([{ role: 'user', content: 'hi' }], {
          model: 'claude-opus-5-5',
          providerOptions,
        }),
      ).rejects.toMatchObject({
        name: 'UnsupportedModelOptionError',
        model: 'claude-opus-5-5',
        option,
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('preserves signed thinking, text, tool use and result; composes Files and binding betas', async () => {
    const fetcher = fetchResponse();
    await provider().chat(
      [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'provider-file', provider: 'anthropic', reference: 'file-1' },
            },
          ],
        },
        ...replay,
      ],
      { model: 'claude-opus-5-5', toolChoice: 'auto' },
    );
    const request = fetcher.mock.calls[0][1];
    expect(request.headers['anthropic-beta']).toBe(
      'files-api-2025-04-14,thinking-binding-controls-2026-08-01',
    );
    const body = JSON.parse(request.body);
    expect(body.thinking).toEqual({
      type: 'adaptive',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
    expect(body.messages[1].content).toEqual([
      { type: 'thinking', thinking: 'private reasoning', signature: 'signed-secret' },
      { type: 'text', text: 'Working' },
      { type: 'tool_use', id: 'tool-1', name: 'calculate', input: { x: 2 } },
    ]);
    expect(body.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'tool-1', content: '2' },
    ]);
  });

  it('binds raw final messages and keeps explicit native error policy', async () => {
    const fetcher = fetchResponse();
    const rawMessages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'raw-sig' },
          { type: 'text', text: 'ok' },
        ],
      },
    ];
    await provider().chat([{ role: 'user', content: 'ignored' }], {
      model: 'claude-opus-5-5',
      providerOptions: {
        messages: rawMessages,
        thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } },
      },
    });
    const request = fetcher.mock.calls[0][1];
    expect(request.headers['anthropic-beta']).toBe('thinking-binding-controls-2026-08-01');
    expect(JSON.parse(request.body).messages).toEqual(rawMessages);
    expect(JSON.parse(request.body).thinking.block_binding).toEqual({
      prefix_mismatch_behavior: 'error',
    });
  });

  it('surfaces a tampered signature as one typed provider rejection', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({
          error: { type: 'invalid_request_error', message: 'Invalid signature in thinking block' },
        }),
    });
    globalThis.fetch = fetcher;
    await expect(provider().chat(replay, { model: 'claude-opus-5-5' })).rejects.toMatchObject({
      name: 'ProviderError',
      status: 400,
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('Anthropic thinking reset diagnostics', () => {
  const drops = [
    {
      type: 'thinking_dropped',
      reason: 'prefix_binding_mismatch',
      path: 'messages.1.content.0',
      secret: 'signed-secret',
    },
    { type: 'thinking_dropped', reason: 'model_binding_mismatch', path: 'messages.2.content.0' },
    {
      type: 'thinking_mismatch_allowed',
      reason: 'prefix_binding_mismatch',
      path: 'messages.3.content.0',
    },
    { type: 'thinking_dropped', reason: 'future_reason', path: 'messages.4.content.0' },
  ];

  it('normalizes only known dropped reasons in direct response', async () => {
    fetchResponse(response(drops));
    const result = await provider().chat(replay, { model: 'claude-opus-5-5' });
    expect(result.diagnostics?.reasoningContextReset).toEqual({
      droppedBlocks: 2,
      reasons: { prefix_binding_mismatch: 1, model_binding_mismatch: 1 },
    });
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/signed-secret|messages\./);
  });

  it.each(['start', 'delta'] as const)(
    'normalizes terminal stream %s transformations',
    async (placement) => {
      const events = [
        {
          type: 'message_start',
          message: {
            model: 'claude-opus-5-5',
            usage: { input_tokens: 10 },
            ...(placement === 'start' ? { input_transformations: drops } : {}),
          },
        },
        {
          type: 'message_delta',
          usage: { output_tokens: 5 },
          ...(placement === 'delta' ? { input_transformations: drops } : {}),
        },
        { type: 'message_stop' },
      ];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              events.map((event) => `data: ${JSON.stringify(event)}\n`).join(''),
            ),
          );
          controller.close();
        },
      });
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body });
      const chunks = [];
      for await (const chunk of provider().stream(replay, { model: 'claude-opus-5-5' }))
        chunks.push(chunk);
      expect(chunks.at(-1)).toMatchObject({
        type: 'done',
        diagnostics: {
          reasoningContextReset: {
            droppedBlocks: 2,
            reasons: { prefix_binding_mismatch: 1, model_binding_mismatch: 1 },
          },
        },
      });
      expect(JSON.stringify(chunks.at(-1))).not.toMatch(/signed-secret|messages\./);
    },
  );

  it.each([
    { final: [], expected: undefined },
    {
      final: [drops[0], drops[1]],
      expected: {
        droppedBlocks: 2,
        reasons: { prefix_binding_mismatch: 1, model_binding_mismatch: 1 },
      },
    },
  ])(
    'uses final stream transformations as the replacement when present',
    async ({ final, expected }) => {
      const events = [
        {
          type: 'message_start',
          message: {
            model: 'claude-opus-5-5',
            usage: { input_tokens: 10 },
            input_transformations: [drops[0]],
          },
        },
        { type: 'message_delta', usage: { output_tokens: 5 }, input_transformations: final },
        { type: 'message_stop' },
      ];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              events.map((event) => `data: ${JSON.stringify(event)}\n`).join(''),
            ),
          );
          controller.close();
        },
      });
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body });
      const chunks = [];
      for await (const chunk of provider().stream(replay, { model: 'claude-opus-5-5' }))
        chunks.push(chunk);
      const done = chunks.at(-1);
      if (expected) {
        expect(done).toMatchObject({
          type: 'done',
          diagnostics: { reasoningContextReset: expected },
        });
      } else {
        expect(done).toMatchObject({ type: 'done' });
        expect(done).not.toHaveProperty('diagnostics.reasoningContextReset');
      }
      expect(JSON.stringify(done)).not.toMatch(/signed-secret|messages\./);
    },
  );
});

describe('runtime continuation after Axl context summarization', () => {
  it.each([false, true])('regenerates then reuses a summary with stream=%s', async (stream) => {
    const history: ChatMessage[] = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `older ${index}: ${'x'.repeat(200)}`,
    }));
    history.push(...replay);
    const requests: Array<Record<string, any>> = [];
    const dropped = [
      { type: 'thinking_dropped', reason: 'prefix_binding_mismatch', path: 'messages.2.content.0' },
    ];
    const streamBody = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          const events = [
            {
              type: 'message_start',
              message: {
                model: 'claude-opus-5-5',
                usage: { input_tokens: 10 },
                input_transformations: dropped,
              },
            },
            { type: 'content_block_start', content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'continued' } },
            { type: 'content_block_stop' },
            { type: 'message_delta', usage: { output_tokens: 5 } },
            { type: 'message_stop' },
          ];
          controller.enqueue(
            new TextEncoder().encode(
              events.map((event) => `data: ${JSON.stringify(event)}\n`).join(''),
            ),
          );
          controller.close();
        },
      });
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      const isSummary = String(body.system).includes('Summarize the following conversation');
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () =>
          isSummary
            ? {
                ...response(),
                content: [{ type: 'text', text: 'summary' }],
                input_transformations: undefined,
              }
            : { ...response(dropped), content: [{ type: 'text', text: 'continued' }] },
        body: stream && !isSummary ? streamBody() : undefined,
      };
    });
    const registry = new ProviderRegistry();
    registry.registerInstance('anthropic', provider());
    const events: AxlEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'task',
      executionId: `opus-summary-${stream}`,
      metadata: {},
      config: { defaultProvider: 'anthropic', diagnostics: { silent: true } },
      providerRegistry: registry,
      sessionHistory: history,
      onTrace: (event) => events.push(event),
      _forceStreaming: stream,
    });
    const worker = agent({
      name: 'opus-summary',
      model: 'anthropic:claude-opus-5-5',
      maxContext: 2700,
    });
    expect(await ctx.ask(worker, 'first question')).toBe('continued');
    expect(await ctx.ask(worker, 'second question')).toBe('continued');
    const summaryCalls = requests.filter((body) =>
      String(body.system).includes('Summarize the following conversation'),
    );
    const actualCalls = requests.filter(
      (body) => !String(body.system).includes('Summarize the following conversation'),
    );
    expect(summaryCalls).toHaveLength(1);
    expect(actualCalls).toHaveLength(2);
    for (const body of actualCalls) {
      expect(String(body.system)).toContain('Summary of earlier conversation');
      expect(body.thinking.block_binding).toEqual({ prefix_mismatch_behavior: 'drop_block' });
      const assistant = body.messages.find(
        (message: any) =>
          message.role === 'assistant' &&
          Array.isArray(message.content) &&
          message.content.some((block: any) => block.type === 'tool_use'),
      );
      expect(assistant.content.map((block: any) => block.type)).toEqual([
        'thinking',
        'text',
        'tool_use',
      ]);
      expect(
        body.messages.some(
          (message: any) =>
            message.role === 'user' &&
            Array.isArray(message.content) &&
            message.content.some(
              (block: any) => block.type === 'tool_result' && block.tool_use_id === 'tool-1',
            ),
        ),
      ).toBe(true);
    }
    const resets = events.filter(
      (event) =>
        event.type === 'provider_diagnostic' && event.data.kind === 'reasoning_context_reset',
    );
    expect(resets).toHaveLength(2);
    expect(resets.map((event) => event.data)).toEqual([
      {
        kind: 'reasoning_context_reset',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        droppedBlocks: 1,
        reasons: { prefix_binding_mismatch: 1 },
      },
      {
        kind: 'reasoning_context_reset',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        droppedBlocks: 1,
        reasons: { prefix_binding_mismatch: 1 },
      },
    ]);
    expect(JSON.stringify(resets)).not.toMatch(/signed-secret|messages\.|private reasoning/);
  });
});

describe('runtime call-level reset cardinality', () => {
  it.each([false, true])(
    'emits after each affected turn in one tool loop with stream=%s',
    async (stream) => {
      const reset = { droppedBlocks: 2, reasons: { prefix_binding_mismatch: 2 } };
      let turn = 0;
      const scripted: Provider = {
        name: 'anthropic',
        async chat() {
          const index = turn++;
          return index < 2
            ? {
                content: '',
                tool_calls: [
                  {
                    id: `call-${index}`,
                    type: 'function',
                    function: { name: 'ping', arguments: '{}' },
                  },
                ],
                ...(index === 0 ? { diagnostics: { reasoningContextReset: reset } } : {}),
              }
            : { content: 'done', diagnostics: { reasoningContextReset: reset } };
        },
        async *stream(messages: ChatMessage[], options: ChatOptions) {
          const result = await this.chat(messages, options);
          for (const call of result.tool_calls ?? []) {
            yield {
              type: 'tool_call_delta' as const,
              id: call.id,
              name: call.function.name,
              arguments: call.function.arguments,
            };
          }
          if (result.content) yield { type: 'text_delta' as const, content: result.content };
          yield { type: 'done' as const, diagnostics: result.diagnostics };
        },
      };
      const registry = new ProviderRegistry();
      registry.registerInstance('anthropic', scripted);
      const events: AxlEvent[] = [];
      const ctx = new WorkflowContext({
        input: 'task',
        executionId: `opus-loop-${stream}`,
        config: { defaultProvider: 'anthropic', trace: { redact: true } },
        providerRegistry: registry,
        onTrace: (event) => events.push(event),
        _forceStreaming: stream,
      });
      const ping = tool({
        name: 'ping',
        description: 'ping',
        input: z.object({}),
        handler: async () => 'pong',
      });
      const worker = agent({
        name: 'opus-loop',
        model: 'anthropic:claude-opus-5-5',
        tools: [ping],
      });
      expect(await ctx.ask(worker, 'ping twice')).toBe('done');
      expect(turn).toBe(3);
      const resets = events.filter(
        (event) =>
          event.type === 'provider_diagnostic' && event.data.kind === 'reasoning_context_reset',
      );
      expect(resets).toHaveLength(2);
      expect(resets.map((event) => event.data)).toEqual([
        {
          kind: 'reasoning_context_reset',
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          ...reset,
        },
        {
          kind: 'reasoning_context_reset',
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          ...reset,
        },
      ]);
      expect(
        resets.every((event) => JSON.stringify(redactEvent(event)) === JSON.stringify(event)),
      ).toBe(true);
      expect(JSON.stringify(resets)).not.toMatch(/thinking|signature|messages\.|ping twice/);
    },
  );
});
