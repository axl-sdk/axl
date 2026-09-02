import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { OPENROUTER_PROFILE } from '../providers/profiles/openrouter.js';
import { AxlRuntime } from '../runtime.js';
import { tool } from '../tool.js';
import { workflow } from '../workflow.js';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function request(fetchMock: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function openRouterRuntime(): AxlRuntime {
  const runtime = new AxlRuntime();
  runtime.registerProvider(
    'openrouter',
    new OpenAICompatibleProvider({ profile: OPENROUTER_PROFILE, apiKey: 'test-key' }),
  );
  return runtime;
}

const imageInput = [
  { type: 'text', text: 'Inspect this receipt.' },
  {
    type: 'image',
    label: 'receipt',
    source: { type: 'base64', data: 'AQID', mediaType: 'image/png' },
  },
] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OpenRouter multimodal runtime bridge', () => {
  it('keeps ordered rich input through a two-request image and tool loop', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'lookup_receipt', arguments: '{"id":"receipt-1"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.01 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: 'final answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost: 0.01 },
        }),
      );
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const lookupReceipt = tool({
      name: 'lookup_receipt',
      description: 'Look up a receipt by its identifier.',
      input: z.object({ id: z.string() }),
      handler: async ({ id }) => `confirmed:${id}`,
    });
    const inspector = agent({
      name: 'inspector',
      model: 'openrouter:catalog/default',
      system: 'Inspect receipts.',
      tools: [lookupReceipt],
      providerOptions: { model: 'vendor/vision:variant' },
    });
    const runtime = openRouterRuntime();
    runtime.register(
      workflow({
        name: 'openrouter-rich-tool-loop',
        input: z.object({}),
        handler: (ctx) => ctx.ask(inspector, imageInput),
      }),
    );

    await expect(runtime.execute('openrouter-rich-tool-loop', {})).resolves.toBe('final answer');
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = request(fetch, 0);
    const second = request(fetch, 1);
    expect(first.model).toBe('vendor/vision:variant');
    expect(first.tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({
          name: 'lookup_receipt',
          description: 'Look up a receipt by its identifier.',
        }),
      }),
    ]);
    expect(first.messages).toEqual(
      expect.arrayContaining([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect this receipt.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
            { type: 'text', text: '[Image: receipt]' },
          ],
        },
      ]),
    );
    const secondMessages = second.messages as Array<Record<string, unknown>>;
    expect(secondMessages.slice(-3)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this receipt.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
          { type: 'text', text: '[Image: receipt]' },
        ],
      },
      expect.objectContaining({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup_receipt', arguments: '{"id":"receipt-1"}' },
          },
        ],
      }),
      expect.objectContaining({
        role: 'tool',
        content: '"confirmed:receipt-1"',
        tool_call_id: 'call-1',
      }),
    ]);
    await runtime.shutdown();
  });

  it('dispatches rich images through the real adapter streaming path', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"streamed answer"},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost":0.01}}',
          'data: [DONE]',
        ]),
      );
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const runtime = openRouterRuntime();
    runtime.register(
      workflow({
        name: 'openrouter-rich-stream',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(
            agent({ model: 'openrouter:vendor/vision-stream', system: 'Inspect.' }),
            imageInput,
          ),
      }),
    );

    await expect(runtime.stream('openrouter-rich-stream', {}).promise).resolves.toBe(
      'streamed answer',
    );
    expect(request(fetch, 0).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.arrayContaining([
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
          ]),
        }),
      ]),
    );
    await runtime.shutdown();
  });

  it('remaps rich input on schema retry and attributes the effective OpenRouter model', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: '{"wrong":true}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.01 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: '{"answer":"approved"}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost: 0.01 },
        }),
      );
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const runtime = openRouterRuntime();
    const traces: Array<{ type: string; model?: string }> = [];
    runtime.on('trace', (event) => traces.push(event));
    runtime.register(
      workflow({
        name: 'openrouter-rich-schema-retry',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(
            agent({
              model: 'openrouter:catalog/default',
              system: 'Extract the answer.',
              providerOptions: { model: 'vendor/vision:variant' },
            }),
            imageInput,
            { schema: z.object({ answer: z.string() }), retries: 1 },
          ),
      }),
    );

    await expect(runtime.execute('openrouter-rich-schema-retry', {})).resolves.toEqual({
      answer: 'approved',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const index of [0, 1]) {
      expect(request(fetch, index).model).toBe('vendor/vision:variant');
      expect(request(fetch, index).messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.arrayContaining([
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
            ]),
          }),
        ]),
      );
    }
    expect(
      traces.filter((event) => event.type === 'agent_call_start').map((event) => event.model),
    ).toEqual(['openrouter:vendor/vision:variant', 'openrouter:vendor/vision:variant']);
    await runtime.shutdown();
  });
});
