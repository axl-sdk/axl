/**
 * Phase 2a acceptance suite: audio input on the OpenAI-compatible engine
 * (`openai:` and `openrouter:` profiles).
 *
 * Behavioral matrix IDs AE-01, AE-02, AE-04, AE-05, AE-07, AE-08,
 * AE-09/AE-10 (openrouter), AE-11, AE-12, AE-14, AE-15, AE-16(c), AE-17,
 * AE-19, AE-21 (openai + openrouter rows), AE-22, plus the Q6
 * `providerMetadata` passthrough case.
 *
 * Everything here asserts WHICH BODY each request carried, never a bare count:
 * a dropped, reordered, re-encoded, or downgraded part must fail a body
 * assertion, not merely a `toHaveBeenCalledTimes`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { UnsupportedModelInputError } from '../errors.js';
import { isUnpricedLeaf } from '../event-utils.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { InputContentPart, ModelInput } from '../input.js';
import { OpenAIProvider } from '../providers/openai.js';
import {
  OpenAICompatibleProvider,
  compatibleRichParts,
  type ProfileInputModalities,
} from '../providers/openai-compatible.js';
import { OPENAI_CHAT_AUDIO_FORMATS, OPENROUTER_AUDIO_FORMATS } from '../providers/audio-format.js';
import { GROQ_PROFILE } from '../providers/profiles/groq.js';
import { OPENROUTER_PROFILE } from '../providers/profiles/openrouter.js';
import { AxlRuntime } from '../runtime.js';
import { tool } from '../tool.js';
import type { AxlEvent, ChatMessage } from '../types.js';
import { workflow } from '../workflow.js';
import {
  IMAGE_REJECTION_TRIPLES,
  OPENAI_STRING_BODY,
  OPENROUTER_IMAGE_BODY,
  OPENROUTER_STRING_BODY,
} from './fixtures/rich-input-baselines.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Harness ─────────────────────────────────────────────────────────────

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

function rawBody(fetchMock: ReturnType<typeof vi.fn>, index: number): string {
  return (fetchMock.mock.calls[index]?.[1] as RequestInit).body as string;
}

function messages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body.messages as Array<Record<string, unknown>>;
}

/** The single user turn carrying the caller's input, in each request. */
function userContent(
  fetchMock: ReturnType<typeof vi.fn>,
  index: number,
): Array<Record<string, unknown>> {
  const rich = messages(request(fetchMock, index)).filter(
    (m) => m.role === 'user' && Array.isArray(m.content),
  );
  expect(rich).toHaveLength(1);
  return rich[0].content as Array<Record<string, unknown>>;
}

function mockFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  fetchMock.mockResolvedValue(responses[responses.length - 1]);
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

/** Any provider request at all fails a "rejected locally" contract. */
function forbidFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => {
    throw new Error('provider request issued for a locally-rejected input');
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

function openAIRuntime(): AxlRuntime {
  const runtime = new AxlRuntime();
  runtime.registerProvider('openai', new OpenAIProvider({ apiKey: 'test-key' }));
  return runtime;
}

function openRouterRuntime(): AxlRuntime {
  const runtime = new AxlRuntime();
  runtime.registerProvider(
    'openrouter',
    new OpenAICompatibleProvider({ profile: OPENROUTER_PROFILE, apiKey: 'test-key' }),
  );
  return runtime;
}

/** Run one ask on a registered runtime and return its result. */
function askOnce(
  runtime: AxlRuntime,
  name: string,
  model: string,
  input: ModelInput,
  askOptions?: Parameters<typeof z.object>[0] extends never ? never : Record<string, unknown>,
): Promise<unknown> {
  runtime.register(
    workflow({
      name,
      input: z.object({}),
      handler: (ctx) =>
        ctx.ask(agent({ name, model, system: 'Listen.' }), input, askOptions as never),
    }),
  );
  return runtime.execute(name, {});
}

// ── Fixtures ────────────────────────────────────────────────────────────

/** Distinctive, valid base64 so its presence/absence is unambiguous. */
const SENTINEL = Buffer.from('AUDIOSENTINEL123').toString('base64');

const AUDIO_INPUT: readonly InputContentPart[] = [
  {
    type: 'audio',
    label: 'call',
    source: { type: 'base64', data: SENTINEL, mediaType: 'audio/wav' },
  },
  { type: 'text', text: 'What is happening in this recording?' },
];

/** What `AUDIO_INPUT` must render to, on both profiles, in every request. */
const WIRE_AUDIO = { type: 'input_audio', input_audio: { data: SENTINEL, format: 'wav' } };
const WIRE_CONTENT = [
  WIRE_AUDIO,
  { type: 'text', text: '[Audio: call]' },
  { type: 'text', text: 'What is happening in this recording?' },
];

const USAGE = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
const OPENROUTER_USAGE = { ...USAGE, cost: 0.0042 };

function toolCallResponse(usage: Record<string, unknown>): Response {
  return jsonResponse({
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"id":"a"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage,
  });
}

function textResponse(text: string, usage: Record<string, unknown>): Response {
  return jsonResponse({
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage,
  });
}

const lookup = tool({
  name: 'lookup',
  description: 'Look something up.',
  input: z.object({ id: z.string() }),
  handler: async ({ id }) => `found:${id}`,
});

/**
 * The shared AE-01…AE-08 assertions: the audio part is byte-identical and at
 * the same ordinal index in every request, appears exactly once per request,
 * and the sentinel really is on the wire (positive control).
 */
function expectAudioPreserved(fetchMock: ReturnType<typeof vi.fn>, requestCount: number): void {
  expect(fetchMock).toHaveBeenCalledTimes(requestCount);
  for (let i = 0; i < requestCount; i++) {
    const content = userContent(fetchMock, i);
    // The caller's parts lead the content array unchanged; a rail that appends
    // its own guidance (schema retry) may follow, but never displace them.
    expect(content.slice(0, WIRE_CONTENT.length)).toEqual(WIRE_CONTENT);
    expect(content.indexOf(content.find((p) => p.type === 'input_audio')!)).toBe(0);
    expect(content.filter((p) => p.type === 'input_audio')).toHaveLength(1);
    expect(rawBody(fetchMock, i)).toContain(SENTINEL);
  }
  // Deep equality across requests — no re-encode, no placeholder substitution.
  for (let i = 1; i < requestCount; i++) {
    expect(userContent(fetchMock, i)[0]).toEqual(userContent(fetchMock, 0)[0]);
  }
}

/** No event, trace payload, or execution record may carry the audio bytes. */
function expectSentinelAbsent(events: readonly unknown[]): void {
  for (const event of events) {
    expect(JSON.stringify(event) ?? '').not.toContain(SENTINEL);
  }
}

// ── AE-01 / AE-02: tool-loop continuation ───────────────────────────────

describe('ordered audio input survives orchestration (AE-01, AE-02, AE-04, AE-05, AE-07)', () => {
  it('AE-01 openai: keeps the audio part identical in a tool-loop continuation', async () => {
    const fetchMock = mockFetch(toolCallResponse(USAGE), textResponse('done', USAGE));
    const runtime = openAIRuntime();
    const traces: AxlEvent[] = [];
    runtime.on('trace', (event) => traces.push(event));
    runtime.register(
      workflow({
        name: 'openai-audio-tools',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(
            agent({ model: 'openai:gpt-4o', system: 'Listen.', tools: [lookup] }),
            AUDIO_INPUT,
          ),
      }),
    );

    await expect(runtime.execute('openai-audio-tools', {})).resolves.toBe('done');
    expectAudioPreserved(fetchMock, 2);
    // The continuation also carries the tool round-trip, proving the audio turn
    // was rebuilt from history rather than replayed from a cached first body.
    const second = messages(request(fetchMock, 1));
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expectSentinelAbsent(traces);
    await runtime.shutdown();
  });

  it('AE-02 openrouter: keeps the audio part identical in a tool-loop continuation', async () => {
    const fetchMock = mockFetch(
      toolCallResponse(OPENROUTER_USAGE),
      textResponse('done', OPENROUTER_USAGE),
    );
    const runtime = openRouterRuntime();
    const traces: AxlEvent[] = [];
    runtime.on('trace', (event) => traces.push(event));
    runtime.register(
      workflow({
        name: 'openrouter-audio-tools',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(
            agent({ model: 'openrouter:vendor/audio', system: 'Listen.', tools: [lookup] }),
            AUDIO_INPUT,
          ),
      }),
    );

    await expect(runtime.execute('openrouter-audio-tools', {})).resolves.toBe('done');
    expectAudioPreserved(fetchMock, 2);
    expectSentinelAbsent(traces);
    await runtime.shutdown();
  });

  it('AE-04 openai: keeps the audio part identical across a schema-validation retry', async () => {
    const fetchMock = mockFetch(
      textResponse('{"wrong":true}', USAGE),
      textResponse('{"answer":"a siren"}', USAGE),
    );
    const runtime = openAIRuntime();
    runtime.register(
      workflow({
        name: 'openai-audio-schema-retry',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ model: 'openai:gpt-4o', system: 'Listen.' }), AUDIO_INPUT, {
            schema: z.object({ answer: z.string() }),
            retries: 1,
          }),
      }),
    );

    await expect(runtime.execute('openai-audio-schema-retry', {})).resolves.toEqual({
      answer: 'a siren',
    });
    // The retry re-sends the audio, not just a text projection + repair note.
    expectAudioPreserved(fetchMock, 2);
    await runtime.shutdown();
  });

  it('AE-05 openrouter: keeps the audio part identical across an output-guardrail retry', async () => {
    const fetchMock = mockFetch(
      textResponse('blocked answer', OPENROUTER_USAGE),
      textResponse('clean answer', OPENROUTER_USAGE),
    );
    const runtime = openRouterRuntime();
    runtime.register(
      workflow({
        name: 'openrouter-audio-guardrail-retry',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(
            agent({
              model: 'openrouter:vendor/audio',
              system: 'Listen.',
              guardrails: {
                output: async (text: string) =>
                  text.includes('blocked')
                    ? { block: true, reason: 'contains blocked' }
                    : { block: false },
                onBlock: 'retry',
              },
            }),
            AUDIO_INPUT,
          ),
      }),
    );

    await expect(runtime.execute('openrouter-audio-guardrail-retry', {})).resolves.toBe(
      'clean answer',
    );
    // The guardrail rail commonly rebuilds from `inputText()`, which drops audio
    // by design; this proves the rich input is what gets re-sent.
    expectAudioPreserved(fetchMock, 2);
    await runtime.shutdown();
  });

  it('AE-07 openai: forwards the audio to a handoff target, instruction appended after it', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'handoff_to_specialist',
                    arguments: '{"message":"Identify the siren."}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: USAGE,
      }),
      textResponse('a siren', USAGE),
    );
    const specialist = agent({ name: 'specialist', model: 'openai:gpt-4o', system: 'Specialize.' });
    const runtime = openAIRuntime();
    runtime.register(
      workflow({
        name: 'openai-audio-handoff',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(
            agent({
              name: 'triage',
              model: 'openai:gpt-4o',
              system: 'Listen.',
              handoffs: [{ agent: specialist }],
            }),
            AUDIO_INPUT,
          ),
      }),
    );

    await expect(runtime.execute('openai-audio-handoff', {})).resolves.toBe('a siren');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const target = userContent(fetchMock, 1);
    // Evidence is forwarded as parts, not flattened into the instruction string.
    expect(target.slice(0, 3)).toEqual(WIRE_CONTENT);
    expect(target.filter((p) => p.type === 'input_audio')).toHaveLength(1);
    expect(target).toEqual(userContent(fetchMock, 0).concat(target.slice(3)));
    // The handoff instruction is appended AFTER the audio part.
    const instruction = target.findIndex(
      (p) => p.type === 'text' && String(p.text).includes('Identify the siren.'),
    );
    expect(instruction).toBeGreaterThan(0);
    expect(rawBody(fetchMock, 1)).toContain(SENTINEL);
    await runtime.shutdown();
  });
});

// ── AE-08: streaming + redaction ────────────────────────────────────────

describe('AE-08 openrouter streaming with audio input', () => {
  it('sends the audio on the streaming path and leaks the sentinel nowhere else', async () => {
    const fetchMock = mockFetch(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"a "},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"siren"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15,"cost":0.0042}}',
        'data: [DONE]',
      ]),
    );
    const runtime = openRouterRuntime();
    const traces: AxlEvent[] = [];
    runtime.on('trace', (event) => traces.push(event));
    const observed: unknown[] = [];
    const completions: unknown[] = [];
    runtime.register(
      workflow({
        name: 'openrouter-audio-stream',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ model: 'openrouter:vendor/audio', system: 'Listen.' }), AUDIO_INPUT),
      }),
    );

    const stream = runtime.stream('openrouter-audio-stream', {}, {
      onAgentCallComplete: (info: unknown) => completions.push(info),
    } as never);
    for await (const chunk of stream) observed.push(chunk);
    await expect(stream.promise).resolves.toBe('a siren');

    // Positive control: the bytes ARE on the wire.
    expect(userContent(fetchMock, 0)).toEqual(WIRE_CONTENT);
    expect(rawBody(fetchMock, 0)).toContain(SENTINEL);
    // …and nowhere an observer, trace, or recovered execution can see them.
    expectSentinelAbsent(traces);
    expectSentinelAbsent(observed);
    expectSentinelAbsent(completions);
    expectSentinelAbsent(await runtime.getExecutions());
    await runtime.shutdown();
  });
});

// ── AE-09 / AE-10: structured output composition ────────────────────────

describe('AE-09/AE-10 openrouter: audio composes with structured output', () => {
  const schema = z.object({ answer: z.string() });

  async function structuredBody(
    input: readonly InputContentPart[] | string,
  ): Promise<Record<string, unknown>> {
    const fetchMock = mockFetch(textResponse('{"answer":"a siren"}', OPENROUTER_USAGE));
    const runtime = openRouterRuntime();
    runtime.register(
      workflow({
        name: 'openrouter-structured',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ model: 'openrouter:vendor/audio', system: 'Listen.' }), input, {
            schema,
          }),
      }),
    );
    await runtime.execute('openrouter-structured', {});
    const body = request(fetchMock, 0);
    await runtime.shutdown();
    return body;
  }

  it('AE-09 appends the schema guidance strictly after the audio part, exactly once', async () => {
    const fetchMock = mockFetch(textResponse('{"answer":"a siren"}', OPENROUTER_USAGE));
    const runtime = openRouterRuntime();
    runtime.register(
      workflow({
        name: 'openrouter-structured-order',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ model: 'openrouter:vendor/audio', system: 'Listen.' }), AUDIO_INPUT, {
            schema,
          }),
      }),
    );
    await runtime.execute('openrouter-structured-order', {});

    const content = userContent(fetchMock, 0);
    const audioIndex = content.findIndex((p) => p.type === 'input_audio');
    const guidance = content
      .map((p, index) => ({ p, index }))
      .filter(({ p }) => p.type === 'text' && /json/i.test(String(p.text)));
    expect(audioIndex).toBe(0);
    // Guidance never precedes the evidence, and is never duplicated.
    expect(guidance).toHaveLength(1);
    expect(guidance[0].index).toBeGreaterThan(audioIndex);
    expect(guidance[0].index).toBe(content.length - 1);
    // The caller's own parts are untouched ahead of it.
    expect(content.slice(0, 3)).toEqual(WIRE_CONTENT);
    await runtime.shutdown();
  });

  it('AE-10 keeps the native structured-output field identical to the non-audio ask', async () => {
    // Deviation from the matrix's literal wording: the Phase 0 baselines capture
    // asks WITHOUT a schema, so `IMAGE_ONLY_BODIES[...].response_format` does not
    // exist. The discriminating comparison is the same structured ask run with a
    // non-audio input on the same model — that is what "audio ⇒ downgraded to
    // prompt-only structured output" would break.
    const audioBody = await structuredBody(AUDIO_INPUT);
    const imageBody = await structuredBody([
      { type: 'image', source: { type: 'base64', data: 'AQID', mediaType: 'image/png' } },
      { type: 'text', text: 'What is happening in this recording?' },
    ]);
    const stringBody = await structuredBody('What is happening in this recording?');

    expect(audioBody.response_format).toBeDefined();
    expect(audioBody.response_format).toEqual(imageBody.response_format);
    expect(audioBody.response_format).toEqual(stringBody.response_format);
    // Also assert the engine's own capability answer is modality-blind.
    expect(
      new OpenAICompatibleProvider({
        profile: OPENROUTER_PROFILE,
        apiKey: 'test-key',
      }).nativeStructuredOutputSupport('vendor/audio'),
    ).toBe('schema');
  });
});

// ── AE-11 / AE-12: media type → wire format ─────────────────────────────

describe('AE-11/AE-12 media-type → format mapping', () => {
  async function formatFor(
    kind: 'openai' | 'openrouter',
    mediaType: string,
  ): Promise<Record<string, unknown>> {
    const usage = kind === 'openai' ? USAGE : OPENROUTER_USAGE;
    const fetchMock = mockFetch(textResponse('ok', usage));
    const runtime = kind === 'openai' ? openAIRuntime() : openRouterRuntime();
    const model = kind === 'openai' ? 'openai:gpt-4o' : 'openrouter:vendor/audio';
    await askOnce(runtime, `${kind}-${mediaType}`, model, [
      { type: 'audio', source: { type: 'base64', data: SENTINEL, mediaType } },
    ]);
    const part = userContent(fetchMock, 0)[0];
    await runtime.shutdown();
    return part;
  }

  it.each(Object.entries(OPENAI_CHAT_AUDIO_FORMATS))(
    'AE-11 openai maps %s to format %s with the caller base64 verbatim',
    async (mediaType, format) => {
      // A raw MIME passthrough or a `split('/')[1]` would produce `audio/mpeg`
      // or `mpeg` here — both rejected by OpenAI's `wav | mp3` enum.
      expect(await formatFor('openai', mediaType)).toEqual({
        type: 'input_audio',
        input_audio: { data: SENTINEL, format },
      });
    },
  );

  it.each(Object.entries(OPENROUTER_AUDIO_FORMATS))(
    'AE-12 openrouter maps %s to format %s with the caller base64 verbatim',
    async (mediaType, format) => {
      expect(await formatFor('openrouter', mediaType)).toEqual({
        type: 'input_audio',
        input_audio: { data: SENTINEL, format },
      });
    },
  );

  it('AE-12 covers every OpenRouter format token, and the profiles do not share a table', async () => {
    expect([...new Set(Object.values(OPENROUTER_AUDIO_FORMATS))].sort()).toEqual([
      'aac',
      'aiff',
      'flac',
      'm4a',
      'mp3',
      'ogg',
      'pcm16',
      'wav',
    ]);
    // A media type OpenRouter carries but OpenAI does not: proof the OpenAI
    // profile did not inherit the wider table.
    const fetchMock = forbidFetch();
    const runtime = openAIRuntime();
    const error = await askOnce(runtime, 'openai-flac', 'openai:gpt-4o', [
      { type: 'audio', source: { type: 'base64', data: SENTINEL, mediaType: 'audio/flac' } },
    ]).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    expect((error as Error).message).toContain("audio media type 'audio/flac'");
    expect(fetchMock).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it('encodes bytes audio to base64 without re-encoding a base64 source', async () => {
    const fetchMock = mockFetch(textResponse('ok', OPENROUTER_USAGE));
    const runtime = openRouterRuntime();
    await askOnce(runtime, 'openrouter-bytes-audio', 'openrouter:vendor/audio', [
      {
        type: 'audio',
        source: { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'audio/mpeg' },
      },
      { type: 'audio', source: { type: 'base64', data: SENTINEL, mediaType: 'audio/wav' } },
    ]);
    expect(userContent(fetchMock, 0)).toEqual([
      { type: 'input_audio', input_audio: { data: 'AQID', format: 'mp3' } },
      { type: 'input_audio', input_audio: { data: SENTINEL, format: 'wav' } },
    ]);
    await runtime.shutdown();
  });
});

// ── AE-14 / AE-15: local rejections ─────────────────────────────────────

describe('AE-14/AE-15 local audio rejections (no fetch)', () => {
  const lanes: Array<[string, () => AxlRuntime, string]> = [
    ['openai', openAIRuntime, 'openai:gpt-4o'],
    ['openrouter', openRouterRuntime, 'openrouter:vendor/audio'],
  ];

  it.each(lanes)(
    'AE-14 %s rejects an unmappable media type locally and names it',
    async (name, makeRuntime, model) => {
      const fetchMock = forbidFetch();
      const runtime = makeRuntime();
      const error = await askOnce(runtime, `${name}-unknown-type`, model, [
        {
          type: 'audio',
          source: { type: 'base64', data: SENTINEL, mediaType: 'audio/x-unknown' },
        },
      ]).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(UnsupportedModelInputError);
      expect((error as UnsupportedModelInputError).modality).toBe('audio');
      expect((error as UnsupportedModelInputError).source).toBe('base64');
      // Naming the type is the point: a generic "unsupported media type" gives
      // the developer nothing to act on.
      expect((error as Error).message).toContain("audio media type 'audio/x-unknown'");
      expect((error as Error).message).not.toContain(SENTINEL);
      expect(fetchMock).not.toHaveBeenCalled();
      await runtime.shutdown();
    },
  );

  it.each(lanes)(
    'AE-15 %s rejects a provider-file audio source locally and names the source kind',
    async (name, makeRuntime, model) => {
      const fetchMock = forbidFetch();
      const runtime = makeRuntime();
      const error = await askOnce(runtime, `${name}-provider-file`, model, [
        {
          type: 'audio',
          source: {
            type: 'provider-file',
            provider: name,
            reference: 'files/secret-ref',
            mediaType: 'audio/wav',
          },
        },
      ]).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(UnsupportedModelInputError);
      expect((error as UnsupportedModelInputError).modality).toBe('audio');
      expect((error as UnsupportedModelInputError).source).toBe('provider-file');
      expect((error as Error).message).toContain('provider-file');
      // The reference is a locator; it must not be echoed into the message.
      expect((error as Error).message).not.toContain('files/secret-ref');
      expect(fetchMock).not.toHaveBeenCalled();
      await runtime.shutdown();
    },
  );

  it.each([
    ['openai', () => new OpenAIProvider({ apiKey: 'test-key' }), 'openai:gpt-4o'] as const,
    [
      'openrouter',
      () => new OpenAICompatibleProvider({ profile: OPENROUTER_PROFILE, apiKey: 'test-key' }),
      'openrouter:vendor/audio',
    ] as const,
  ])(
    'AE-14 %s rejects an unmappable media type carried only by user history',
    async (name, makeProvider, model) => {
      // Validating history too keeps a continuation request from failing later
      // than the first one.
      const fetchMock = forbidFetch();
      const registry = new ProviderRegistry();
      registry.registerInstance(name, makeProvider());
      const history: ChatMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'audio',
              source: { type: 'base64', data: SENTINEL, mediaType: 'audio/x-unknown' },
            },
          ],
        },
      ];
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: `${name}-history-unknown-type`,
        config: {},
        providerRegistry: registry,
        sessionHistory: history,
      });
      const error = await ctx
        .ask(agent({ model, system: 'Listen.' }), 'follow up')
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(UnsupportedModelInputError);
      expect((error as UnsupportedModelInputError).modality).toBe('audio');
      expect((error as Error).message).toContain("audio media type 'audio/x-unknown'");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

// ── AE-16(c): OpenRouter slug ───────────────────────────────────────────

describe('AE-16(c) openrouter model slugs', () => {
  it('preserves a colon-qualified slug verbatim on an audio request', async () => {
    const fetchMock = mockFetch(textResponse('ok', OPENROUTER_USAGE));
    const runtime = openRouterRuntime();
    await askOnce(runtime, 'openrouter-colon-slug', 'openrouter:vendor/model:free', AUDIO_INPUT);
    // A `split(':')` in URI parsing would truncate this to `vendor/model`.
    expect(request(fetchMock, 0).model).toBe('vendor/model:free');
    expect(userContent(fetchMock, 0)).toEqual(WIRE_CONTENT);
    await runtime.shutdown();
  });
});

// ── AE-17 / AE-19: accounting ───────────────────────────────────────────

describe('AE-17 openai audio calls are unpriced, never $0', () => {
  async function run(input: ModelInput): Promise<{
    events: AxlEvent[];
    executions: Awaited<ReturnType<AxlRuntime['getExecutions']>>;
  }> {
    mockFetch(
      jsonResponse({
        choices: [{ message: { content: 'a siren' }, finish_reason: 'stop' }],
        usage: {
          ...USAGE,
          prompt_tokens_details: { audio_tokens: 9 },
          completion_tokens_details: { audio_tokens: 0 },
        },
      }),
    );
    const runtime = openAIRuntime();
    const events: AxlEvent[] = [];
    runtime.on('trace', (event) => events.push(event));
    await askOnce(runtime, `openai-pricing-${typeof input}`, 'openai:gpt-4o', input);
    const executions = await runtime.getExecutions();
    await runtime.shutdown();
    return { events, executions };
  }

  it('reports unpriced for an audio-bearing ask on a priced text model', async () => {
    const { events, executions } = await run(AUDIO_INPUT);
    const callEnd = events.find((e) => e.type === 'agent_call_end')!;
    const askEnd = events.find((e) => e.type === 'ask_end')!;

    expect(callEnd.cost).toBeUndefined();
    expect(callEnd.cost).not.toBe(0); // never report $0 as if known
    // Deviation from the matrix wording: `agent_call_end` carries no literal
    // `unpriced` field on the success path — the leaf is classified by
    // `isUnpricedLeaf`, which is what the runtime and Studio aggregate through.
    expect(isUnpricedLeaf(callEnd)).toBe(true);
    expect(askEnd.unpriced).toBe(true);
    expect(executions[0].unpriced).toBe(true);
  });

  it('negative control: the same model prices a string-only ask normally', async () => {
    // Proves the unpriced signal is audio-specific, not a broken pricing table.
    const { events, executions } = await run('What is happening in this recording?');
    const callEnd = events.find((e) => e.type === 'agent_call_end')!;

    expect(typeof callEnd.cost).toBe('number');
    expect(callEnd.cost).toBeGreaterThan(0);
    expect(isUnpricedLeaf(callEnd)).toBe(false);
    expect(executions[0].unpriced).toBe(false);
  });
});

describe('AE-19 openrouter response cost stays authoritative', () => {
  async function run(usage: Record<string, unknown>): Promise<AxlEvent[]> {
    mockFetch(textResponse('a siren', usage));
    const runtime = openRouterRuntime();
    const events: AxlEvent[] = [];
    runtime.on('trace', (event) => events.push(event));
    await askOnce(runtime, 'openrouter-pricing', 'openrouter:vendor/audio', AUDIO_INPUT);
    const executions = await runtime.getExecutions();
    events.push({ type: 'execution-probe', data: executions[0] } as unknown as AxlEvent);
    await runtime.shutdown();
    return events;
  }

  it('uses usage.cost for an audio-bearing call', async () => {
    const events = await run(OPENROUTER_USAGE);
    const callEnd = events.find((e) => e.type === 'agent_call_end')!;
    expect(callEnd.cost).toBe(0.0042);
    expect(isUnpricedLeaf(callEnd)).toBe(false);
    const probe = events.find((e) => e.type === ('execution-probe' as never))!;
    expect((probe as unknown as { data: { totalCost: number } }).data.totalCost).toBe(0.0042);
  });

  it('reports unpriced — not $0 — when the response omits usage.cost', async () => {
    const events = await run(USAGE);
    const callEnd = events.find((e) => e.type === 'agent_call_end')!;
    expect(callEnd.cost).toBeUndefined();
    expect(callEnd.cost).not.toBe(0);
    expect(isUnpricedLeaf(callEnd)).toBe(true);
  });
});

// ── Q6: providerMetadata ────────────────────────────────────────────────

describe('Q6 providerMetadata on an audio-bearing call', () => {
  it('round-trips provider metadata unchanged and never carries the audio bytes', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        choices: [
          {
            message: { content: 'a siren' },
            finish_reason: 'stop',
          },
        ],
        usage: OPENROUTER_USAGE,
      }),
    );
    const runtime = openRouterRuntime();
    const traces: AxlEvent[] = [];
    runtime.on('trace', (event) => traces.push(event));
    runtime.register(
      workflow({
        name: 'openrouter-audio-metadata',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(
            agent({
              model: 'openrouter:vendor/audio',
              system: 'Listen.',
              // `providerOptions` is the escape hatch merged last into the body;
              // an audio part must not perturb it.
              providerOptions: { transforms: ['middle-out'], user: 'tenant-7' },
            }),
            AUDIO_INPUT,
          ),
      }),
    );

    await expect(runtime.execute('openrouter-audio-metadata', {})).resolves.toBe('a siren');
    const body = request(fetchMock, 0);
    expect(body.transforms).toEqual(['middle-out']);
    expect(body.user).toBe('tenant-7');
    expect(userContent(fetchMock, 0)).toEqual(WIRE_CONTENT);
    // The metadata surfaces never carry the base64.
    expectSentinelAbsent(traces);
    expect(JSON.stringify({ transforms: body.transforms, user: body.user })).not.toContain(
      SENTINEL,
    );
    await runtime.shutdown();
  });
});

// ── AE-21 / AE-22: regression guards ────────────────────────────────────

describe('AE-21 text-only and image-only bodies are unchanged by the audio work', () => {
  it('openai string-only ask still matches the Phase 0 baseline body', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        choices: [{ message: { content: 'Sunny.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    const runtime = openAIRuntime();
    await expect(
      askOnce(runtime, 'ae21-openai-string', 'openai:gpt-4o', 'Describe the weather.'),
    ).resolves.toBe('Sunny.');
    expect(request(fetchMock, 0)).toEqual({
      ...OPENAI_STRING_BODY,
      messages: [{ role: 'system', content: 'Listen.' }, ...OPENAI_STRING_BODY.messages],
    });
    await runtime.shutdown();
  });

  it('openrouter string-only and image-only asks still match the Phase 0 baseline bodies', async () => {
    for (const [name, input, baseline] of [
      ['string', 'Describe the weather.', OPENROUTER_STRING_BODY],
      [
        'image',
        [
          {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              data: (
                OPENROUTER_IMAGE_BODY.messages[0].content[0] as {
                  image_url: { url: string };
                }
              ).image_url.url.split(',')[1],
              mediaType: 'image/png',
            },
          },
          { type: 'text' as const, text: 'Describe.' },
        ],
        OPENROUTER_IMAGE_BODY,
      ],
    ] as const) {
      const fetchMock = mockFetch(
        jsonResponse({
          choices: [{ message: { content: 'Sunny.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.01 },
        }),
      );
      const runtime = openRouterRuntime();
      runtime.register(
        workflow({
          name: `ae21-openrouter-${name}`,
          input: z.object({}),
          handler: (ctx) =>
            ctx.ask(
              agent({
                model: 'openrouter:catalog/default',
                providerOptions: { model: baseline.model },
              }),
              input as ModelInput,
            ),
        }),
      );
      await expect(runtime.execute(`ae21-openrouter-${name}`, {})).resolves.toBe('Sunny.');
      expect(request(fetchMock, 0)).toEqual(baseline);
      await runtime.shutdown();
    }
  });
});

describe('AE-22 images stay off openai: (fork F4)', () => {
  it('(a) rejects an image ask at preflight with the Phase 0 triple and zero fetches', async () => {
    const fetchMock = forbidFetch();
    const runtime = openAIRuntime();
    const error = await askOnce(runtime, 'ae22-openai-image', 'openai:gpt-4o', [
      { type: 'image', source: { type: 'base64', data: 'AQID', mediaType: 'image/png' } },
      { type: 'text', text: 'Describe.' },
    ]).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    expect({
      modality: (error as UnsupportedModelInputError).modality,
      source: (error as UnsupportedModelInputError).source,
      message: (error as Error).message,
    }).toEqual(IMAGE_REJECTION_TRIPLES.openai);
    expect(fetchMock).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it('(b) the rich-part builder itself refuses an image on the OpenAI modalities', () => {
    // Defense in depth: the guard survives a preflight refactor.
    const openaiModalities: ProfileInputModalities = {
      audio: { sources: ['bytes', 'base64'], formats: OPENAI_CHAT_AUDIO_FORMATS },
    };
    expect(() =>
      compatibleRichParts(
        [{ type: 'image', source: { type: 'base64', data: 'AQID', mediaType: 'image/png' } }],
        'gpt-4o',
        openaiModalities,
        'openai',
      ),
    ).toThrow(UnsupportedModelInputError);
    // …while audio on the same modalities builds normally.
    expect(compatibleRichParts([...AUDIO_INPUT], 'gpt-4o', openaiModalities, 'openai')).toEqual(
      WIRE_CONTENT,
    );
  });

  it('(b) the builder also refuses audio on a profile that declares none', () => {
    expect(() => compatibleRichParts([...AUDIO_INPUT], 'llama-test', {}, 'groq')).toThrow(
      UnsupportedModelInputError,
    );
    expect(() =>
      compatibleRichParts(
        [...AUDIO_INPUT],
        'vendor/vision',
        { image: { sources: ['url', 'bytes', 'base64'] } },
        'openrouter',
      ),
    ).toThrow(/audio input/);
  });
});

// ── Review fix wave: builder routing, offending-part modality, media type ──

/** Exposes the engine's protected `formatMessage` so the wire content a profile
 * produces can be asserted without a dispatch the gate would reject first. */
class ExposedCompatibleProvider extends OpenAICompatibleProvider {
  formatOne(message: ChatMessage, model: string): Record<string, unknown> {
    return this.formatMessage(message, model);
  }
}

describe('array content is routed through the rich-part builder unconditionally', () => {
  const groq = () => new ExposedCompatibleProvider({ profile: GROQ_PROFILE, apiKey: 'test-key' });

  it('refuses audio on a profile that declares no modality at all', () => {
    // `groq` declares neither image nor audio. Skipping the builder for such a
    // profile would put raw `InputContentPart` objects — base64 and all — into
    // the request body instead of failing.
    const message: ChatMessage = { role: 'user', content: [...AUDIO_INPUT] };
    expect(() => groq().formatOne(message, 'llama-test')).toThrow(UnsupportedModelInputError);
    try {
      groq().formatOne(message, 'llama-test');
    } catch (err) {
      expect((err as UnsupportedModelInputError).modality).toBe('audio');
      expect((err as Error).message).not.toContain(SENTINEL);
    }
  });

  it('still passes text parts through on a profile that declares no modality', () => {
    const formatted = groq().formatOne(
      { role: 'user', content: [{ type: 'text', text: 'plain words' }] },
      'llama-test',
    );
    expect(formatted.content).toEqual([{ type: 'text', text: 'plain words' }]);
  });
});

describe('a mixed-modality rejection reports the offending part, not the first one', () => {
  it('reports image (not audio) when only the image part is unsupported on openai:', async () => {
    const fetchMock = forbidFetch();
    const runtime = openAIRuntime();
    const error = await askOnce(runtime, 'openai-audio-then-image', 'openai:gpt-4o', [
      ...AUDIO_INPUT,
      { type: 'image', source: { type: 'base64', data: 'AQID', mediaType: 'image/png' } },
    ]).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    expect((error as UnsupportedModelInputError).modality).toBe('image');
    expect((error as Error).message).toContain('image input for this model');
    expect(fetchMock).not.toHaveBeenCalled();
    await runtime.shutdown();
  });
});

describe('an unmappable audio media type is never rendered as the string "undefined"', () => {
  it('names a missing media type as missing', () => {
    // A profile may legitimately accept a provider-file audio source, where the
    // media type is optional on the part. `validateInput` then reaches the
    // format table with `undefined`.
    const provider = new OpenAICompatibleProvider({
      profile: {
        ...OPENROUTER_PROFILE,
        capabilities: {
          ...OPENROUTER_PROFILE.capabilities,
          inputModalities: {
            audio: {
              sources: ['provider-file', 'base64'],
              formats: OPENROUTER_AUDIO_FORMATS,
            },
          },
        },
      },
      apiKey: 'test-key',
    });
    const error = (() => {
      try {
        provider.validateInput({
          model: 'vendor/audio',
          input: [
            {
              type: 'audio',
              source: { type: 'provider-file', provider: 'openrouter', reference: 'files/a' },
            },
          ],
          history: [],
          stream: false,
          hasTools: false,
          responseMode: 'text',
        });
      } catch (err) {
        return err;
      }
    })();

    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    expect((error as Error).message).toContain('audio media type (missing)');
    expect((error as Error).message).not.toContain('undefined');
  });
});
