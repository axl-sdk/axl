// Shared fetch-level fixtures for the Claude Haiku 5.5 / Sonnet 5.5 suites.
// Every request-shape assertion reads the captured `fetch` call, and every
// response fixture can be served as both a Messages JSON body and an SSE
// stream so the same row runs on `chat` and `stream`.
import { vi } from 'vitest';
import { AnthropicProvider } from '../providers/anthropic.js';
import type { ChatMessage, ChatOptions, StreamChunk, ToolCallMessage } from '../providers/types.js';

export const HAIKU = 'claude-haiku-5-5';
export const SONNET = 'claude-sonnet-5-5';
export const BINDING_BETA = 'thinking-binding-controls-2026-08-01';
export const MODES = ['chat', 'stream'] as const;
export type Mode = (typeof MODES)[number];

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'refusal' };

export type Fixture = {
  model?: string;
  content?: ContentBlock[];
  stop_reason?: string;
  usage?: Record<string, unknown>;
  input_transformations?: unknown;
};

export type ErrorFixture = { status: number; message: string };

const DEFAULT_USAGE = { input_tokens: 10, output_tokens: 5 };

function messageJson(fixture: Fixture, requestModel: string) {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: fixture.model ?? requestModel,
    content: fixture.content ?? [{ type: 'text', text: 'ok' }],
    stop_reason: fixture.stop_reason ?? 'end_turn',
    usage: fixture.usage ?? DEFAULT_USAGE,
    ...(fixture.input_transformations !== undefined
      ? { input_transformations: fixture.input_transformations }
      : {}),
  };
}

/** The SSE event sequence Anthropic streams for `fixture`. */
export function sseEvents(fixture: Fixture, requestModel: string): unknown[] {
  const json = messageJson(fixture, requestModel);
  const { output_tokens: outputTokens, ...startUsage } = json.usage as Record<string, unknown>;
  const events: unknown[] = [
    {
      type: 'message_start',
      message: {
        model: json.model,
        usage: { ...startUsage, output_tokens: 0 },
        ...(fixture.input_transformations !== undefined
          ? { input_transformations: fixture.input_transformations }
          : {}),
      },
    },
  ];
  for (const [index, block] of json.content.entries()) {
    if (block.type === 'thinking') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      });
      if (block.thinking) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: block.thinking },
        });
      }
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: block.signature },
      });
    } else if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    } else if (block.type === 'tool_use') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'refusal' } });
    }
    events.push({ type: 'content_block_stop', index });
  }
  events.push({
    type: 'message_delta',
    delta: { stop_reason: json.stop_reason },
    usage: { output_tokens: outputTokens },
  });
  events.push({ type: 'message_stop' });
  return events;
}

function sseBody(events: unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        ),
      );
      controller.close();
    },
  });
}

/**
 * Install a fetch mock that answers call N with `fixtures[N]` (the last one
 * repeats). A fixture with `status` answers with that HTTP error.
 */
export function installFetch(...fixtures: Array<Fixture | ErrorFixture>) {
  let call = 0;
  const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    const fixture = fixtures[Math.min(call++, fixtures.length - 1)] ?? {};
    const requestModel = String(JSON.parse(String(init.body)).model);
    if ('status' in fixture) {
      return {
        ok: false,
        status: fixture.status,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({ error: { type: 'invalid_request_error', message: fixture.message } }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => messageJson(fixture, requestModel),
      body: sseBody(sseEvents(fixture, requestModel)),
    };
  });
  globalThis.fetch = fetcher as unknown as typeof fetch;
  return fetcher;
}

export type Captured = {
  body: Record<string, any>;
  raw: string;
  headers: Record<string, string>;
};

export function captured(fetcher: ReturnType<typeof installFetch>, index = 0): Captured {
  const init = fetcher.mock.calls[index][1] as { body: string; headers: Record<string, string> };
  return { body: JSON.parse(init.body), raw: init.body, headers: init.headers };
}

export const provider = () => new AnthropicProvider({ apiKey: 'test-key' });

/** The provider outcome normalized across `chat` and `stream`. */
export type Outcome = {
  content: string;
  thinking?: string;
  toolCalls?: ToolCallMessage[];
  providerMetadata?: Record<string, unknown>;
  cost?: number;
  diagnostics?: unknown;
};

export async function run(
  mode: Mode,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<Outcome> {
  const p = provider();
  if (mode === 'chat') {
    const result = await p.chat(messages, options);
    return {
      content: result.content,
      thinking: result.thinking_content,
      toolCalls: result.tool_calls,
      providerMetadata: result.providerMetadata,
      cost: result.cost,
      diagnostics: result.diagnostics,
    };
  }
  let content = '';
  let thinking = '';
  const calls = new Map<string, ToolCallMessage>();
  let lastId = '';
  let done: Extract<StreamChunk, { type: 'done' }> | undefined;
  for await (const chunk of p.stream(messages, options)) {
    if (chunk.type === 'text_delta') content += chunk.content;
    else if (chunk.type === 'thinking_delta') thinking += chunk.content;
    else if (chunk.type === 'tool_call_delta') {
      const id = chunk.id || lastId;
      lastId = id;
      const existing = calls.get(id) ?? {
        id,
        type: 'function' as const,
        function: { name: chunk.name ?? '', arguments: '' },
      };
      existing.function.arguments += chunk.arguments ?? '';
      calls.set(id, existing);
    } else if (chunk.type === 'done') done = chunk;
  }
  return {
    content,
    thinking: thinking || undefined,
    toolCalls: calls.size > 0 ? [...calls.values()] : undefined,
    providerMetadata: done?.providerMetadata,
    cost: done?.cost,
    diagnostics: done?.diagnostics,
  };
}

/** One signed thinking block plus a tool call: the turn every continuity row replays. */
export function toolTurn(thinking = 'private reasoning', signature = 'signed-secret'): Fixture {
  return {
    content: [
      { type: 'thinking', thinking, signature },
      { type: 'text', text: 'Working' },
      { type: 'tool_use', id: 'tool-1', name: 'calc', input: { x: 2 } },
    ],
    stop_reason: 'tool_use',
  };
}

/** Conversation history built from a real (mocked) provider outcome. */
export function historyFrom(outcome: Outcome): ChatMessage[] {
  return [
    { role: 'user', content: 'calculate' },
    {
      role: 'assistant',
      content: outcome.content,
      providerMetadata: outcome.providerMetadata,
      tool_calls: outcome.toolCalls,
    },
    { role: 'tool', tool_call_id: outcome.toolCalls?.[0]?.id ?? 'tool-1', content: '2' },
  ];
}

export const tools = [
  {
    type: 'function' as const,
    function: { name: 'calc', description: 'calc', parameters: { type: 'object' } },
  },
];
