/**
 * Phase 2b acceptance tests: recorded audio input on the `google:` adapter.
 *
 * Gemini routes every rich ask through the stateless Interactions endpoint, so
 * these tests assert on the captured `/interactions` request BODY — which part
 * carried the recording, at which ordinal index, with which `mime_type` — never
 * on a bare request count. Matrix IDs implemented here: AE-03, AE-06 (incl. the
 * `routerInput: 'text'` sub-case), AE-09 (google half), AE-10 (google), AE-13,
 * AE-16(a)/(b), AE-18, AE-21 (google rows), and the Q6 `providerMetadata` case.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { GeminiProvider } from '../providers/gemini.js';
import { AxlRuntime } from '../runtime.js';
import { tool } from '../tool.js';
import { workflow } from '../workflow.js';
import { UnsupportedModelInputError } from '../errors.js';
import { isUnpricedLeaf } from '../event-utils.js';
import { GOOGLE_IMAGE_BODY, GOOGLE_STRING_BODY } from './fixtures/rich-input-baselines.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Distinctive base64 payload. Every leak assertion greps for this literal, so
 *  it must not appear in any expected event/trace string. */
const SENTINEL = 'QUFBQXNlbnRpbmVsQUFBQQ==';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** A terminal Interactions response carrying one model_output step. */
function interactionText(text: string, usage?: Record<string, number>): Response {
  return jsonResponse({
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    ...(usage ? { usage } : {}),
  });
}

/** An Interactions response that asks for one function call. */
function interactionToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
  usage?: Record<string, number>,
): Response {
  return jsonResponse({
    status: 'requires_action',
    steps: [{ type: 'function_call', id, name, arguments: args }],
    ...(usage ? { usage } : {}),
  });
}

const INTERACTION_USAGE = {
  total_input_tokens: 120,
  total_output_tokens: 8,
  total_tokens: 128,
};

/** A `generateContent` response. String-only asks never reach `/interactions`,
 *  so the delegate `routerInput: 'text'` sub-case needs both wire shapes. */
function generateContentResponse(text: string, priced = false): Response {
  return jsonResponse({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: {
      promptTokenCount: 120,
      candidatesTokenCount: 8,
      totalTokenCount: 128,
      ...(priced ? { serviceTier: 'SERVICE_TIER_STANDARD' } : {}),
    },
  });
}

function requestBody(
  fetchMock: ReturnType<typeof vi.fn>,
  index = 0,
): Record<string, unknown> | undefined {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  return init ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
}

function requestUrl(fetchMock: ReturnType<typeof vi.fn>, index = 0): string {
  return String(fetchMock.mock.calls[index]?.[0]);
}

type InteractionStep = { type: string; content?: Array<Record<string, unknown>> };

/** The content array of the first `user_input` step of a captured request. */
function userContent(
  fetchMock: ReturnType<typeof vi.fn>,
  index = 0,
): Array<Record<string, unknown>> {
  const body = requestBody(fetchMock, index);
  const input = (body?.input ?? []) as InteractionStep[];
  const step = input.find((entry) => entry.type === 'user_input');
  if (!step?.content) throw new Error(`no user_input step in request ${index}`);
  return step.content;
}

function googleRuntime(): AxlRuntime {
  const runtime = new AxlRuntime();
  runtime.registerProvider('google', new GeminiProvider({ apiKey: 'test-key' }));
  return runtime;
}

function audioInput(
  mediaType = 'audio/wav',
  label?: string,
): Array<Record<string, unknown>> & unknown[] {
  return [
    {
      type: 'audio',
      ...(label ? { label } : {}),
      source: { type: 'base64', data: SENTINEL, mediaType },
    },
    { type: 'text', text: 'What is in this recording?' },
  ];
}

const EXPECTED_AUDIO_PART = {
  type: 'audio',
  data: SENTINEL,
  mime_type: 'audio/wav',
};

// ── Mapping ─────────────────────────────────────────────────────────────

describe('Gemini Interactions audio mapping', () => {
  it('maps base64 audio to an inline audio part, verbatim and in caller order', async () => {
    const fetch = vi.fn().mockResolvedValue(interactionText('A dog barking.'));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const runtime = googleRuntime();
    runtime.register(
      workflow({
        name: 'google-audio-inline',
        input: z.object({}),
        handler: (ctx) => ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), audioInput()),
      }),
    );

    await expect(runtime.execute('google-audio-inline', {})).resolves.toBe('A dog barking.');
    expect(requestUrl(fetch, 0)).toContain('/interactions');
    expect(userContent(fetch)).toEqual([
      EXPECTED_AUDIO_PART,
      { type: 'text', text: 'What is in this recording?' },
    ]);
    await runtime.shutdown();
  });

  it('encodes byte audio to base64 without mutating the caller array', async () => {
    const fetch = vi.fn().mockResolvedValue(interactionText('Encoded.'));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const runtime = googleRuntime();
    runtime.register(
      workflow({
        name: 'google-audio-bytes',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), [
            { type: 'audio', source: { type: 'bytes', data: bytes, mediaType: 'audio/mpeg' } },
          ]),
      }),
    );

    await expect(runtime.execute('google-audio-bytes', {})).resolves.toBe('Encoded.');
    expect(userContent(fetch)).toEqual([
      {
        type: 'audio',
        data: Buffer.from([1, 2, 3, 4]).toString('base64'),
        mime_type: 'audio/mpeg',
      },
    ]);
    await runtime.shutdown();
  });

  it('appends a trailing text part for an audio label, mirroring the image convention', async () => {
    const fetch = vi.fn().mockResolvedValue(interactionText('Labelled.'));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const runtime = googleRuntime();
    runtime.register(
      workflow({
        name: 'google-audio-label',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), audioInput('audio/wav', 'clip-7')),
      }),
    );

    await expect(runtime.execute('google-audio-label', {})).resolves.toBe('Labelled.');
    expect(userContent(fetch)).toEqual([
      EXPECTED_AUDIO_PART,
      { type: 'text', text: '[Audio: clip-7]' },
      { type: 'text', text: 'What is in this recording?' },
    ]);
    await runtime.shutdown();
  });

  // AE-13
  it('AE-13: passes the caller media type through as mime_type unchanged, with no format token', async () => {
    for (const mediaType of ['audio/wav', 'audio/ogg', 'audio/x-unusual-but-declared']) {
      const fetch = vi.fn().mockResolvedValue(interactionText('Heard.'));
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const runtime = googleRuntime();
      runtime.register(
        workflow({
          name: 'google-audio-mime',
          input: z.object({}),
          handler: (ctx) =>
            ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), audioInput(mediaType)),
        }),
      );

      await expect(runtime.execute('google-audio-mime', {})).resolves.toBe('Heard.');
      const part = userContent(fetch)[0];
      expect(part).toEqual({ type: 'audio', data: SENTINEL, mime_type: mediaType });
      expect(part).not.toHaveProperty('format');
      await runtime.shutdown();
    }
  });

  // AE-16(a)
  it('AE-16(a): carries a Gemini Files reference as a URI audio part', async () => {
    const fetch = vi.fn().mockResolvedValue(interactionText('From the file.'));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const runtime = googleRuntime();
    runtime.register(
      workflow({
        name: 'google-audio-file',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), [
            {
              type: 'audio',
              source: {
                type: 'provider-file',
                provider: 'google',
                reference: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
                mediaType: 'audio/flac',
              },
            },
          ]),
      }),
    );

    await expect(runtime.execute('google-audio-file', {})).resolves.toBe('From the file.');
    expect(userContent(fetch)).toEqual([
      {
        type: 'audio',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
        mime_type: 'audio/flac',
      },
    ]);
    await runtime.shutdown();
  });

  // AE-16(b)
  it('AE-16(b): rejects a provider-file scoped to another provider with zero fetches', async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const runtime = googleRuntime();
    runtime.register(
      workflow({
        name: 'google-audio-foreign-file',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), [
            {
              type: 'audio',
              source: {
                type: 'provider-file',
                provider: 'anthropic',
                reference: 'file-anthropic-1',
                mediaType: 'audio/wav',
              },
            },
          ]),
      }),
    );

    const error = await runtime.execute('google-audio-foreign-file', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    const unsupported = error as UnsupportedModelInputError;
    expect({
      modality: unsupported.modality,
      source: unsupported.source,
      message: unsupported.message,
    }).toEqual({
      modality: 'audio',
      source: 'provider-file',
      message:
        "Provider 'google' model 'gemini-2.5-flash' does not support audio from provider-file",
    });
    expect(unsupported.message).not.toContain('file-anthropic-1');
    expect(fetch).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it('rejects a Gemini provider-file with no declared media type, with zero fetches', async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const runtime = googleRuntime();
    runtime.register(
      workflow({
        name: 'google-audio-file-no-mime',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), [
            {
              type: 'audio',
              source: { type: 'provider-file', provider: 'google', reference: 'files/abc' },
            },
          ]),
      }),
    );

    await expect(runtime.execute('google-audio-file-no-mime', {})).rejects.toThrow(
      /does not support Interactions URI audio mediaType from provider-file/,
    );
    expect(fetch).not.toHaveBeenCalled();
    await runtime.shutdown();
  });
});

// ── Ordered-input preservation (AE-03, AE-06) ───────────────────────────

describe('Gemini audio survives orchestration', () => {
  // AE-03
  it('AE-03: repeats the identical audio part at the same index on the tool continuation', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        interactionToolCall('call-1', 'classify_sound', { hint: 'bark' }, INTERACTION_USAGE),
      )
      .mockResolvedValueOnce(interactionText('A dog barking.', INTERACTION_USAGE));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const classifySound = tool({
      name: 'classify_sound',
      description: 'Classify a sound from a hint.',
      input: z.object({ hint: z.string() }),
      handler: async ({ hint }) => `classified:${hint}`,
    });
    const traces: unknown[] = [];
    const runtime = googleRuntime();
    runtime.on('trace', (event) => traces.push(event));
    runtime.register(
      workflow({
        name: 'google-audio-tool-loop',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(
            agent({
              name: 'listener',
              model: 'google:gemini-2.5-flash',
              system: 'Identify sounds.',
              tools: [classifySound],
            }),
            audioInput(),
          ),
      }),
    );

    await expect(runtime.execute('google-audio-tool-loop', {})).resolves.toBe('A dog barking.');
    const first = userContent(fetch, 0);
    const second = userContent(fetch, 1);
    // Deep equality of the part, and the same ordinal index (0) in both.
    expect(second[0]).toEqual(first[0]);
    expect(second[0]).toEqual(EXPECTED_AUDIO_PART);
    expect(first.filter((part) => part.type === 'audio')).toHaveLength(1);
    expect(second.filter((part) => part.type === 'audio')).toHaveLength(1);
    // The continuation is a full stateless rebuild: no resumption handle.
    for (const index of [0, 1]) {
      const body = requestBody(fetch, index)!;
      expect(body).not.toHaveProperty('previous_interaction_id');
      expect(body.store).toBe(false);
      // Positive control: the recording really is on the wire.
      expect(JSON.stringify(body)).toContain(SENTINEL);
    }
    // Negative control: never in observability output.
    expect(JSON.stringify(traces)).not.toContain(SENTINEL);
    const [info] = await runtime.getExecutions();
    expect(JSON.stringify(info)).not.toContain(SENTINEL);
    await runtime.shutdown();
  });

  // AE-06
  it('AE-06: routes the audio to both the delegate router and the selected delegate', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        interactionToolCall('call-1', 'handoff_to_sound_expert', {}, INTERACTION_USAGE),
      )
      .mockResolvedValueOnce(interactionText('A dog barking.', INTERACTION_USAGE));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const runtime = googleRuntime();
    runtime.register(
      workflow({
        name: 'google-audio-delegate',
        input: z.object({}),
        handler: (ctx) =>
          ctx.delegate(
            [
              agent({
                name: 'sound_expert',
                model: 'google:gemini-2.5-flash',
                system: 'Identify environmental sounds.',
              }),
              agent({
                name: 'text_expert',
                model: 'google:gemini-2.5-flash',
                system: 'Answer text questions.',
              }),
            ],
            audioInput(),
          ),
      }),
    );

    await expect(runtime.execute('google-audio-delegate', {})).resolves.toBe('A dog barking.');
    expect(fetch).toHaveBeenCalledTimes(2);
    // Request 0 is the router (it carries the handoff tools); request 1 is the
    // selected delegate (it carries that agent's own system instruction). Both
    // must be the audio-bearing request, not one or the other.
    const routerBody = requestBody(fetch, 0)!;
    const delegateBody = requestBody(fetch, 1)!;
    expect((routerBody.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([
      'handoff_to_sound_expert',
      'handoff_to_text_expert',
    ]);
    expect(delegateBody.tools).toBeUndefined();
    expect(String(delegateBody.system_instruction)).toContain('Identify environmental sounds.');
    const router = userContent(fetch, 0);
    const delegated = userContent(fetch, 1);
    expect(router[0]).toEqual(EXPECTED_AUDIO_PART);
    expect(delegated[0]).toEqual(EXPECTED_AUDIO_PART);
    expect(delegated[0]).toEqual(router[0]);
    await runtime.shutdown();
  });

  // AE-06 sub-case
  it("AE-06 sub-case: routerInput 'text' keeps audio off the router but on the delegate", async () => {
    // The router is asked with a plain string, which stays on `generateContent`;
    // only the delegate's rich ask reaches `/interactions`.
    const fetch = vi.fn(async (url: unknown) =>
      String(url).includes('/interactions')
        ? interactionText('A dog barking.', INTERACTION_USAGE)
        : jsonResponse({
            candidates: [
              {
                content: {
                  parts: [
                    { functionCall: { id: 'fc-1', name: 'handoff_to_sound_expert', args: {} } },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 },
          }),
    );
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    const runtime = googleRuntime();
    runtime.register(
      workflow({
        name: 'google-audio-delegate-text-router',
        input: z.object({}),
        handler: (ctx) =>
          ctx.delegate(
            [
              agent({
                name: 'sound_expert',
                model: 'google:gemini-2.5-flash',
                system: 'Identify environmental sounds.',
              }),
              agent({
                name: 'text_expert',
                model: 'google:gemini-2.5-flash',
                system: 'Answer text questions.',
              }),
            ],
            audioInput(),
            { routerInput: 'text' },
          ),
      }),
    );

    await expect(runtime.execute('google-audio-delegate-text-router', {})).resolves.toBe(
      'A dog barking.',
    );
    const routerCalls = fetch.mock.calls.filter(
      (call) => !String(call[0]).includes('/interactions'),
    );
    const interactionCalls = fetch.mock.calls.filter((call) =>
      String(call[0]).includes('/interactions'),
    );
    expect(routerCalls.length).toBeGreaterThan(0);
    expect(interactionCalls.length).toBeGreaterThan(0);
    for (const call of routerCalls) {
      expect(String((call[1] as RequestInit).body)).not.toContain(SENTINEL);
    }
    const delegateContent = userContent(fetch, fetch.mock.calls.length - 1);
    expect(delegateContent[0]).toEqual(EXPECTED_AUDIO_PART);
    await runtime.shutdown();
  });
});

// ── Structured output (AE-09, AE-10) ────────────────────────────────────

describe('Gemini audio with structured output', () => {
  const schema = z.object({ sound: z.string() });

  async function structuredRequest(
    name: string,
    input: unknown[],
  ): Promise<Record<string, unknown>> {
    const fetch = vi.fn().mockResolvedValue(interactionText('{"sound":"bark"}'));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const runtime = googleRuntime();
    runtime.register(
      workflow({
        name,
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), input as never, { schema }),
      }),
    );
    await expect(runtime.execute(name, {})).resolves.toEqual({ sound: 'bark' });
    const body = requestBody(fetch, 0)!;
    (body as { __content?: unknown }).__content = userContent(fetch, 0);
    await runtime.shutdown();
    return body;
  }

  // AE-09
  it('AE-09: appends schema guidance after the audio part, exactly once, as the last part', async () => {
    const body = await structuredRequest('google-audio-structured', audioInput());
    const content = (body as { __content: Array<Record<string, unknown>> }).__content;
    const audioIndex = content.findIndex((part) => part.type === 'audio');
    const guidanceIndices = content
      .map((part, index) => ({ part, index }))
      .filter(({ part }) => String(part.text ?? '').includes('Respond with valid JSON'))
      .map(({ index }) => index);
    expect(audioIndex).toBe(0);
    expect(guidanceIndices).toHaveLength(1);
    expect(guidanceIndices[0]).toBeGreaterThan(audioIndex);
    expect(guidanceIndices[0]).toBe(content.length - 1);
    expect(content.map((part) => part.type)).toEqual(['audio', 'text', 'text']);
  });

  // AE-10
  it('AE-10: uses the same native structured-output field as the image-only ask', async () => {
    const audioBody = await structuredRequest('google-audio-structured-native', audioInput());
    const imageBody = await structuredRequest('google-image-structured-native', [
      {
        type: 'image',
        source: { type: 'base64', data: TINY_PNG_BASE64, mediaType: 'image/png' },
      },
      { type: 'text', text: 'What is in this recording?' },
    ]);
    expect(audioBody.response_format).toEqual(imageBody.response_format);
    expect(audioBody.response_format).toBeDefined();
  });
});

// ── Accounting (AE-18) ──────────────────────────────────────────────────

describe('Gemini audio accounting', () => {
  // AE-18
  it('AE-18: reports an audio-bearing call as unpriced, never as $0 or a text-rate estimate', async () => {
    const fetch = vi.fn().mockResolvedValue(interactionText('A dog barking.', INTERACTION_USAGE));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const events: Array<Record<string, unknown>> = [];
    const runtime = googleRuntime();
    runtime.on('trace', (event) => events.push(event as unknown as Record<string, unknown>));
    runtime.register(
      workflow({
        name: 'google-audio-unpriced',
        input: z.object({}),
        handler: (ctx) => ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), audioInput()),
      }),
    );

    await expect(runtime.execute('google-audio-unpriced', {})).resolves.toBe('A dog barking.');
    const callEnd = events.find((event) => event.type === 'agent_call_end')!;
    // The call really did billable work (tokens are reported)…
    expect(callEnd.tokens).toEqual({ input: 120, output: 8 });
    // …but no cost is claimed for it, and it is not presented as a known $0.
    expect(callEnd.cost).toBeUndefined();
    expect(callEnd.cost).not.toBe(0);
    expect(isUnpricedLeaf(callEnd as Parameters<typeof isUnpricedLeaf>[0])).toBe(true);
    const askEnd = events.find((event) => event.type === 'ask_end')!;
    expect(askEnd.unpriced).toBe(true);
    const [info] = await runtime.getExecutions();
    expect(info.unpriced).toBe(true);
    expect(info.totalCost).toBe(0); // a lower bound, flagged unpriced — not a known zero
    await runtime.shutdown();
  });

  it('AE-18 negative control: the same model prices a string-only ask', async () => {
    const fetch = vi.fn().mockResolvedValue(generateContentResponse('Sunny.', true));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const events: Array<Record<string, unknown>> = [];
    const runtime = googleRuntime();
    runtime.on('trace', (event) => events.push(event as unknown as Record<string, unknown>));
    runtime.register(
      workflow({
        name: 'google-string-priced',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), 'Describe the weather.'),
      }),
    );

    await expect(runtime.execute('google-string-priced', {})).resolves.toBe('Sunny.');
    const callEnd = events.find((event) => event.type === 'agent_call_end')!;
    expect(typeof callEnd.cost).toBe('number');
    expect(callEnd.cost).toBeGreaterThan(0);
    expect(isUnpricedLeaf(callEnd as Parameters<typeof isUnpricedLeaf>[0])).toBe(false);
    const askEnd = events.find((event) => event.type === 'ask_end')!;
    expect(askEnd.unpriced).toBeFalsy();
    const [info] = await runtime.getExecutions();
    expect(info.unpriced).toBe(false);
    expect(info.totalCost).toBeGreaterThan(0);
    await runtime.shutdown();
  });
});

// ── providerMetadata (Q6) ───────────────────────────────────────────────

describe('Gemini audio providerMetadata', () => {
  it('Q6: passes Interactions steps through unchanged and carries no base64 or file URI', async () => {
    const steps = [
      { type: 'thought', summary: [{ type: 'text', text: 'Listening.' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'A dog barking.' }] },
    ];
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: 'completed', steps, usage: INTERACTION_USAGE }));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiProvider({ apiKey: 'test-key' });
    const response = await provider.chat([{ role: 'user', content: audioInput() as never }], {
      model: 'gemini-2.5-flash',
    });

    expect(response.content).toBe('A dog barking.');
    const metadata = response.providerMetadata;
    expect(metadata).toEqual({ geminiInteractionSteps: steps });
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain('audio/wav');
    expect(serialized).not.toContain('/files/');
    // Positive control: the recording was on the wire for this very call.
    expect(String((fetch.mock.calls[0]?.[1] as RequestInit).body)).toContain(SENTINEL);
  });
});

// ── Regression guards (AE-21) ───────────────────────────────────────────

describe('AE-21: Gemini text-only and image-only wire bodies are unchanged', () => {
  it('string-only ask still goes to generateContent with the Phase 0 body', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: 'Sunny.' }] }, finishReason: 'STOP' }],
      }),
    );
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const runtime = googleRuntime();
    runtime.register(
      workflow({
        name: 'google-string-baseline',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), 'Describe the weather.'),
      }),
    );

    await expect(runtime.execute('google-string-baseline', {})).resolves.toBe('Sunny.');
    expect(requestUrl(fetch, 0)).toContain(':generateContent');
    expect(requestBody(fetch, 0)).toEqual(GOOGLE_STRING_BODY);
    await runtime.shutdown();
  });

  it('image-only ask still goes to /interactions with the Phase 0 body', async () => {
    const fetch = vi.fn().mockResolvedValue(interactionText('A pixel.'));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const runtime = googleRuntime();
    runtime.register(
      workflow({
        name: 'google-image-baseline',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), [
            {
              type: 'image',
              source: { type: 'base64', data: TINY_PNG_BASE64, mediaType: 'image/png' },
            },
            { type: 'text', text: 'Describe.' },
          ]),
      }),
    );

    await expect(runtime.execute('google-image-baseline', {})).resolves.toBe('A pixel.');
    expect(requestUrl(fetch, 0)).toContain('/interactions');
    expect(requestBody(fetch, 0)).toEqual(GOOGLE_IMAGE_BODY);
    await runtime.shutdown();
  });

  it('an image-only ask with a URL source is still rejected with the Phase 0 triple', async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const runtime = googleRuntime();
    runtime.register(
      workflow({
        name: 'google-image-url-rejection',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ model: 'google:gemini-2.5-flash' }), [
            { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          ]),
      }),
    );

    const error = await runtime.execute('google-image-url-rejection', {}).catch((e: unknown) => e);
    const unsupported = error as UnsupportedModelInputError;
    expect({
      modality: unsupported.modality,
      source: unsupported.source,
      message: unsupported.message,
    }).toEqual({
      modality: 'image',
      source: 'url',
      message:
        "Provider 'google' model 'gemini-2.5-flash' does not support direct URL image input; pass bytes/base64 or a Gemini provider-file from url",
    });
    expect(fetch).not.toHaveBeenCalled();
    await runtime.shutdown();
  });
});
