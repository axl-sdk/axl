import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import type { ChatMessage, ChatOptions, Provider, StreamChunk } from '../providers/types.js';
import type { FinishReason } from '../index.js';

const textMessages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];
const richMessages: ChatMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this' },
      { type: 'image', source: { type: 'base64', data: 'AQID', mediaType: 'image/png' } },
    ],
  },
];

function jsonWire(value: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(value))),
  );
}

function sseWire(frames: string[]): void {
  const encoder = new TextEncoder();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`));
              controller.close();
            },
          }),
        ),
    ),
  );
}

function data(value: unknown): string {
  return `data: ${JSON.stringify(value)}`;
}

function event(name: string, value: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(value)}`;
}

async function terminal(
  provider: Provider,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<Extract<StreamChunk, { type: 'done' }>> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.stream(messages, options)) chunks.push(chunk);
  const done = chunks.filter(
    (chunk): chunk is Extract<StreamChunk, { type: 'done' }> => chunk.type === 'done',
  );
  expect(done).toHaveLength(1);
  return done[0];
}

const metadata = (value: {
  finishReason?: FinishReason;
  rawFinishReason?: string;
  responseId?: string;
  responseModel?: string;
}) => ({
  finishReason: value.finishReason,
  rawFinishReason: value.rawFinishReason,
  responseId: value.responseId,
  responseModel: value.responseModel,
});

afterEach(() => vi.unstubAllGlobals());

describe('provider response metadata from HTTP and SSE wire fixtures', () => {
  it('OpenAI-compatible chat reports the first choice and never substitutes the request model', async () => {
    const provider = new OpenAICompatibleProvider({
      profile: {
        name: 'fixture',
        defaultBaseUrl: 'https://example.com/v1',
        pricing: { kind: 'unknown' },
        reasoning: { emit: () => {}, capture: 'none' },
      },
      apiKey: 'fixture-key',
    });
    jsonWire({
      id: 'chat_1',
      model: 'served-model',
      choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
    });
    const response = await provider.chat(textMessages, { model: 'requested-model' });
    expect(metadata(response)).toEqual({
      finishReason: 'length',
      rawFinishReason: 'length',
      responseId: 'chat_1',
      responseModel: 'served-model',
    });

    jsonWire({ choices: [{ message: { content: 'x' }, finish_reason: 'future_reason' }] });
    const unknown = await provider.chat(textMessages, { model: 'requested-model' });
    expect(metadata(unknown)).toEqual({
      finishReason: 'other',
      rawFinishReason: 'future_reason',
      responseId: undefined,
      responseModel: undefined,
    });

    jsonWire({ choices: [{ message: { content: 'x' }, finish_reason: null }] });
    const absent = await provider.chat(textMessages, { model: 'requested-model' });
    expect(metadata(absent)).toEqual({
      finishReason: undefined,
      rawFinishReason: undefined,
      responseId: undefined,
      responseModel: undefined,
    });
    expect('finishReason' in absent).toBe(false);
  });

  it('OpenAI-compatible stream retains finish metadata across a later usage-only frame', async () => {
    const provider = new OpenAICompatibleProvider({
      profile: {
        name: 'fixture',
        defaultBaseUrl: 'https://example.com/v1',
        pricing: { kind: 'unknown' },
        reasoning: { emit: () => {}, capture: 'none' },
      },
      apiKey: 'fixture-key',
    });
    sseWire([
      data({ id: 'stream_1', model: 'served-model', choices: [{ delta: { content: 'x' } }] }),
      data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      data({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      'data: [DONE]',
    ]);
    const done = await terminal(provider, textMessages, { model: 'requested-model' });
    expect(metadata(done)).toEqual({
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
      responseId: 'stream_1',
      responseModel: 'served-model',
    });

    sseWire([data({ choices: [{ delta: {}, finish_reason: 'future_reason' }] }), 'data: [DONE]']);
    expect(metadata(await terminal(provider, textMessages, { model: 'requested-model' }))).toEqual({
      finishReason: 'other',
      rawFinishReason: 'future_reason',
      responseId: undefined,
      responseModel: undefined,
    });
  });

  it('OpenAI Responses chat uses incomplete details and actual function-call output', async () => {
    const provider = new OpenAIResponsesProvider({ apiKey: 'fixture-key' });
    jsonWire({
      id: 'resp_1',
      model: 'served-model',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
    });
    expect(metadata(await provider.chat(textMessages, { model: 'gpt-4o' }))).toEqual({
      finishReason: 'length',
      rawFinishReason: 'max_output_tokens',
      responseId: 'resp_1',
      responseModel: 'served-model',
    });

    jsonWire({
      id: 'resp_2',
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' }],
    });
    expect(metadata(await provider.chat(textMessages, { model: 'gpt-4o' }))).toEqual({
      finishReason: 'tool_calls',
      rawFinishReason: 'completed',
      responseId: 'resp_2',
      responseModel: undefined,
    });

    jsonWire({ status: 'incomplete', incomplete_details: { reason: 'future_reason' }, output: [] });
    expect(metadata(await provider.chat(textMessages, { model: 'gpt-4o' }))).toEqual({
      finishReason: 'other',
      rawFinishReason: 'future_reason',
      responseId: undefined,
      responseModel: undefined,
    });

    jsonWire({ output: [] });
    const absent = await provider.chat(textMessages, { model: 'gpt-4o' });
    expect(metadata(absent)).toEqual({
      finishReason: undefined,
      rawFinishReason: undefined,
      responseId: undefined,
      responseModel: undefined,
    });
    expect('responseModel' in absent).toBe(false);
  });

  it('OpenAI Responses stream reports completed tool output and incomplete terminal details', async () => {
    const provider = new OpenAIResponsesProvider({ apiKey: 'fixture-key' });
    sseWire([
      event('response.output_item.added', {
        item: { type: 'function_call', call_id: 'call_1', name: 'lookup' },
        output_index: 0,
      }),
      event('response.completed', {
        response: { id: 'resp_stream', model: 'served-model', status: 'completed', output: [] },
      }),
    ]);
    expect(metadata(await terminal(provider, textMessages, { model: 'gpt-4o' }))).toEqual({
      finishReason: 'tool_calls',
      rawFinishReason: 'completed',
      responseId: 'resp_stream',
      responseModel: 'served-model',
    });

    sseWire([
      event('response.created', {
        response: { id: 'resp_early', model: 'served-early', status: 'in_progress' },
      }),
      event('response.completed', { response: { status: 'completed', output: [] } }),
    ]);
    expect(metadata(await terminal(provider, textMessages, { model: 'gpt-4o' }))).toEqual({
      finishReason: 'stop',
      rawFinishReason: 'completed',
      responseId: 'resp_early',
      responseModel: 'served-early',
    });

    sseWire([
      event('response.incomplete', {
        response: {
          id: 'resp_truncated',
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
          output: [],
        },
      }),
    ]);
    expect(metadata(await terminal(provider, textMessages, { model: 'gpt-4o' }))).toEqual({
      finishReason: 'content_filter',
      rawFinishReason: 'content_filter',
      responseId: 'resp_truncated',
      responseModel: undefined,
    });

    sseWire([
      event('response.incomplete', {
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'future_reason' },
          output: [],
        },
      }),
    ]);
    expect(metadata(await terminal(provider, textMessages, { model: 'gpt-4o' }))).toEqual({
      finishReason: 'other',
      rawFinishReason: 'future_reason',
      responseId: undefined,
      responseModel: undefined,
    });

    // EOF without a terminal status still carries identity reported earlier.
    sseWire([
      event('response.created', {
        response: { id: 'resp_eof', model: 'served-before-eof', status: 'in_progress' },
      }),
      event('response.output_text.delta', { delta: 'partial' }),
    ]);
    const interrupted = await terminal(provider, textMessages, { model: 'gpt-4o' });
    expect(metadata(interrupted)).toEqual({
      finishReason: undefined,
      rawFinishReason: undefined,
      responseId: 'resp_eof',
      responseModel: 'served-before-eof',
    });
    expect('finishReason' in interrupted).toBe(false);

    // Keep the adapter's existing EOF fallback; no terminal event means no
    // finish reason, and a stream without response.created has no identity.
    sseWire([]);
    const empty = await terminal(provider, textMessages, { model: 'gpt-4o' });
    expect(metadata(empty)).toEqual({
      finishReason: undefined,
      rawFinishReason: undefined,
      responseId: undefined,
      responseModel: undefined,
    });
    expect('responseId' in empty).toBe(false);
  });

  it('Anthropic chat and stream report stop reason and response identity', async () => {
    const provider = new AnthropicProvider({ apiKey: 'fixture-key' });
    jsonWire({
      id: 'msg_1',
      model: 'served-model',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
    });
    expect(metadata(await provider.chat(textMessages, { model: 'claude-sonnet-4' }))).toEqual({
      finishReason: 'stop',
      rawFinishReason: 'end_turn',
      responseId: 'msg_1',
      responseModel: 'served-model',
    });

    sseWire([
      data({
        type: 'message_start',
        message: { id: 'msg_stream', model: 'served-model', usage: { input_tokens: 2 } },
      }),
      data({
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens' },
        usage: { output_tokens: 3 },
      }),
      data({ type: 'message_stop' }),
    ]);
    expect(metadata(await terminal(provider, textMessages, { model: 'claude-sonnet-4' }))).toEqual({
      finishReason: 'length',
      rawFinishReason: 'max_tokens',
      responseId: 'msg_stream',
      responseModel: 'served-model',
    });

    jsonWire({ content: [], stop_reason: 'pause_turn' });
    expect(metadata(await provider.chat(textMessages, { model: 'claude-sonnet-4' }))).toEqual({
      finishReason: 'other',
      rawFinishReason: 'pause_turn',
      responseId: undefined,
      responseModel: undefined,
    });

    sseWire([
      data({ type: 'message_start', message: {} }),
      data({ type: 'message_delta', delta: { stop_reason: 'pause_turn' } }),
      data({ type: 'message_stop' }),
    ]);
    expect(metadata(await terminal(provider, textMessages, { model: 'claude-sonnet-4' }))).toEqual({
      finishReason: 'other',
      rawFinishReason: 'pause_turn',
      responseId: undefined,
      responseModel: undefined,
    });

    jsonWire({ content: [], stop_reason: null });
    expect(metadata(await provider.chat(textMessages, { model: 'claude-sonnet-4' }))).toEqual({
      finishReason: undefined,
      rawFinishReason: undefined,
      responseId: undefined,
      responseModel: undefined,
    });
  });

  it('Gemini generateContent reports STOP with function calls and stream MAX_TOKENS', async () => {
    const provider = new GeminiProvider({ apiKey: 'fixture-key' });
    jsonWire({
      responseId: 'gem_1',
      modelVersion: 'served-model',
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'call_1', name: 'lookup', args: {} } }],
          },
          finishReason: 'STOP',
        },
      ],
    });
    expect(metadata(await provider.chat(textMessages, { model: 'gemini-2.5-flash' }))).toEqual({
      finishReason: 'tool_calls',
      rawFinishReason: 'STOP',
      responseId: 'gem_1',
      responseModel: 'served-model',
    });

    sseWire([
      data({
        responseId: 'gem_stream',
        modelVersion: 'served-model',
        candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }],
      }),
      data({ candidates: [{ finishReason: 'MAX_TOKENS' }] }),
    ]);
    expect(metadata(await terminal(provider, textMessages, { model: 'gemini-2.5-flash' }))).toEqual(
      {
        finishReason: 'length',
        rawFinishReason: 'MAX_TOKENS',
        responseId: 'gem_stream',
        responseModel: 'served-model',
      },
    );

    jsonWire({ candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] } }] });
    const absent = await provider.chat(textMessages, { model: 'gemini-2.5-flash' });
    expect(metadata(absent)).toEqual({
      finishReason: undefined,
      rawFinishReason: undefined,
      responseId: undefined,
      responseModel: undefined,
    });

    sseWire([data({ candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] } }] })]);
    expect(metadata(await terminal(provider, textMessages, { model: 'gemini-2.5-flash' }))).toEqual(
      {
        finishReason: undefined,
        rawFinishReason: undefined,
        responseId: undefined,
        responseModel: undefined,
      },
    );

    jsonWire({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY' }] });
    await expect(provider.chat(textMessages, { model: 'gemini-2.5-flash' })).rejects.toThrow(
      'Gemini returned non-success finish reason: SAFETY',
    );
  });

  it('Gemini Interactions uses requires_action and terminal interaction identity', async () => {
    const provider = new GeminiProvider({ apiKey: 'fixture-key' });
    jsonWire({
      id: 'interaction_1',
      model: 'served-model',
      status: 'requires_action',
      steps: [{ type: 'function_call', id: 'call_1', name: 'lookup', arguments: {} }],
    });
    expect(metadata(await provider.chat(richMessages, { model: 'gemini-2.5-flash' }))).toEqual({
      finishReason: 'tool_calls',
      rawFinishReason: 'requires_action',
      responseId: 'interaction_1',
      responseModel: 'served-model',
    });

    sseWire([
      data({
        event_type: 'interaction.created',
        interaction: { id: 'interaction_stream', model: 'served-model', status: 'in_progress' },
      }),
      data({ event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } }),
      data({ event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'answer' } }),
      data({ event_type: 'step.stop', index: 0 }),
      data({ event_type: 'interaction.completed', interaction: { status: 'completed' } }),
    ]);
    expect(metadata(await terminal(provider, richMessages, { model: 'gemini-2.5-flash' }))).toEqual(
      {
        finishReason: 'stop',
        rawFinishReason: 'completed',
        responseId: 'interaction_stream',
        responseModel: 'served-model',
      },
    );

    // Google's function-call SSE terminates with interaction.requires_action,
    // rather than interaction.completed carrying a requires_action status.
    sseWire([
      data({
        event_type: 'interaction.created',
        interaction: { id: 'interaction_tool', model: 'served-model', status: 'in_progress' },
      }),
      data({
        event_type: 'step.start',
        index: 0,
        step: { type: 'function_call', id: 'call_1', name: 'lookup', arguments: {} },
      }),
      data({ event_type: 'step.stop', index: 0 }),
      data({
        event_type: 'interaction.requires_action',
        interaction: { status: 'requires_action' },
      }),
    ]);
    expect(metadata(await terminal(provider, richMessages, { model: 'gemini-2.5-flash' }))).toEqual(
      {
        finishReason: 'tool_calls',
        rawFinishReason: 'requires_action',
        responseId: 'interaction_tool',
        responseModel: 'served-model',
      },
    );

    sseWire([
      data({
        event_type: 'interaction.requires_action',
        interaction: { status: 'requires_action' },
      }),
    ]);
    await expect(terminal(provider, richMessages, { model: 'gemini-2.5-flash' })).rejects.toThrow(
      'Gemini Interactions ended with non-success status: requires_action',
    );

    jsonWire({ status: 'completed', steps: [{ type: 'model_output', content: [] }] });
    expect(metadata(await provider.chat(richMessages, { model: 'gemini-2.5-flash' }))).toEqual({
      finishReason: 'stop',
      rawFinishReason: 'completed',
      responseId: undefined,
      responseModel: undefined,
    });
  });
});
