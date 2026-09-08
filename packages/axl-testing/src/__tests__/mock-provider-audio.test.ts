import { describe, expect, it } from 'vitest';
import {
  AxlRuntime,
  agent,
  workflow,
  InvalidModelInputError,
  UnsupportedModelInputError,
  type AxlEvent,
  type ChatMessage,
  type ModelInput,
} from '@axlsdk/axl';
import { z } from 'zod';
import { AxlTestRuntime, MockProvider, MockTranscriptionProvider } from '../index.js';

/** Base64 that is decodable and unique enough that any leak is unambiguous.
 *  ('SENTINELAUDIO' padded to a legal base64 quantum.) */
const SENTINEL = 'U0VOVElORUxBVURJTw==';

const ListenAgent = agent({
  name: 'listen-agent',
  model: 'mock:audio-test',
  system: 'Describe the supplied sound.',
});

const audioBytesPart = (data: number[], label?: string) =>
  ({
    type: 'audio' as const,
    source: { type: 'bytes' as const, data: new Uint8Array(data), mediaType: 'audio/wav' },
    ...(label ? { label } : {}),
  }) satisfies Exclude<ModelInput, string>[number];

/** Ask `input` through a bare workflow on `provider` and return the result. */
function askWith(provider: MockProvider, input: ModelInput, name: string) {
  const runtime = new AxlRuntime();
  runtime.registerProvider('mock', provider);
  const wf = workflow({
    name,
    input: z.object({}).strict(),
    handler: async (ctx) => ctx.ask(ListenAgent, input),
  });
  runtime.register(wf);
  return { runtime, run: () => runtime.execute(name, {}) };
}

// ── AT-01 / AT-02: the default modality list and its opt-out ────────────────

describe('MockProvider input modalities', () => {
  it('AT-01: accepts audio with no modality configuration at all', async () => {
    const provider = MockProvider.sequence([{ content: 'a bell' }]);
    const { run } = askWith(
      provider,
      [audioBytesPart([1, 2, 3]), { type: 'text', text: 'what is this?' }],
      'at01-default-audio',
    );

    await expect(run()).resolves.toBe('a bell');
    expect(provider.calls).toHaveLength(1);
  });

  it('AT-01: declares both image and audio capabilities by default', () => {
    expect(MockProvider.sequence([{ content: 'x' }]).inputCapabilities('any')).toEqual({
      image: { sources: ['url', 'bytes', 'base64', 'provider-file'] },
      audio: { sources: ['bytes', 'base64', 'provider-file'] },
    });
  });

  it('AT-02: withInputModalities([image]) fails audio closed before recording a call', async () => {
    const provider = MockProvider.sequence([{ content: 'never returned' }]).withInputModalities([
      'image',
    ]);
    const { run } = askWith(
      provider,
      [audioBytesPart([1, 2, 3]), { type: 'text', text: 'what is this?' }],
      'at02-audio-optout',
    );

    const error = await run().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    expect((error as UnsupportedModelInputError).modality).toBe('audio');
    expect((error as UnsupportedModelInputError).source).toBe('bytes');
    expect((error as Error).message.toLowerCase()).not.toContain('image');
    expect(provider.calls).toHaveLength(0);
  });

  it('AT-02: the opt-out drops only the named modality from inputCapabilities', () => {
    const imageOnly = MockProvider.sequence([{ content: 'x' }]).withInputModalities(['image']);
    expect(imageOnly.inputCapabilities('any')).toEqual({
      image: { sources: ['url', 'bytes', 'base64', 'provider-file'] },
    });

    const audioOnly = MockProvider.sequence([{ content: 'x' }]).withInputModalities(['audio']);
    expect(audioOnly.inputCapabilities('any')).toEqual({
      audio: { sources: ['bytes', 'base64', 'provider-file'] },
    });
  });

  it('AT-02: the builder returns the same provider so it composes with the factories', () => {
    const provider = MockProvider.echo();
    expect(provider.withInputModalities(['image'])).toBe(provider);
  });

  it('AT-02: an audio part reaching validateInput directly still reports the audio modality', () => {
    // Defence in depth: the runtime's capability gate fires first for audio, so
    // this exercises the mock used as a bare provider (or by a host that skips
    // the gate). It must not report the first rich part's modality.
    const provider = MockProvider.sequence([{ content: 'x' }]).withInputModalities(['image']);
    const error = (() => {
      try {
        provider.validateInput({
          model: 'mock-model',
          input: [
            { type: 'image', source: { type: 'base64', data: SENTINEL, mediaType: 'image/png' } },
            audioBytesPart([9]),
          ],
          history: [],
          stream: false,
          hasTools: false,
          responseMode: 'text',
        });
        return undefined;
      } catch (err: unknown) {
        return err;
      }
    })();

    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    expect((error as UnsupportedModelInputError).modality).toBe('audio');
    expect((error as UnsupportedModelInputError).source).toBe('bytes');
    expect((error as Error).message).toContain('audio input');
  });

  it('AT-02: rejects an undeclared modality carried only by session history', () => {
    const provider = MockProvider.sequence([{ content: 'x' }]).withInputModalities(['image']);
    const history: ChatMessage[] = [{ role: 'user', content: [audioBytesPart([1])] }];
    expect(() =>
      provider.validateInput({
        model: 'mock-model',
        input: 'text only',
        history,
        stream: false,
        hasTools: false,
        responseMode: 'text',
      }),
    ).toThrow(UnsupportedModelInputError);
  });
});

// ── AT-03: what `calls` records ────────────────────────────────────────────

describe('MockProvider records logical audio parts', () => {
  it('AT-03: keeps caller order and clones the caller bytes', async () => {
    const callerBytes = new Uint8Array([4, 5, 6]);
    const input: ModelInput = [
      { type: 'text', text: 'before' },
      {
        type: 'audio',
        source: { type: 'bytes', data: callerBytes, mediaType: 'audio/wav' },
        label: 'call',
      },
      { type: 'text', text: 'after' },
    ];
    const provider = MockProvider.sequence([{ content: 'ok' }]);
    const { run } = askWith(provider, input, 'at03-record');
    await run();

    callerBytes[0] = 99;

    expect(provider.calls[0].messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'before' },
      {
        type: 'audio',
        source: { type: 'bytes', data: new Uint8Array([4, 5, 6]), mediaType: 'audio/wav' },
        label: 'call',
      },
      { type: 'text', text: 'after' },
    ]);
    const parts = provider.calls[0].messages.at(-1)?.content as Exclude<ModelInput, string>;
    expect(parts[1].type).toBe('audio');
  });
});

// ── AT-04: one projection, shared with summarizeModelInput ─────────────────

describe('MockProvider.echo() audio projection', () => {
  const input: ModelInput = [
    { type: 'audio', source: { type: 'base64', data: SENTINEL, mediaType: 'audio/wav' } },
    { type: 'text', text: 'hello' },
  ];

  it('AT-04: echoes the audio placeholder deterministically and never the payload', async () => {
    const first = askWith(MockProvider.echo(), input, 'at04-echo-a');
    const second = askWith(MockProvider.echo(), input, 'at04-echo-b');

    const a = await first.run();
    const b = await second.run();

    expect(a).toBe(b);
    expect(a).toContain('[audio audio/wav]');
    expect(a).not.toContain('[image');
    expect(a).not.toContain(SENTINEL);
    expect(a).toBe('[audio audio/wav]\nhello');
  });
});

// ── AT-05 / AB-12: nothing leaks through the testing surface ───────────────

describe('audio never leaks through the AxlTestRuntime observability surface', () => {
  const audioInput: ModelInput = [
    {
      type: 'audio',
      source: { type: 'base64', data: SENTINEL, mediaType: 'audio/wav' },
      label: 'customer call',
    },
    { type: 'text', text: 'summarize it' },
  ];

  function testRuntime(input: ModelInput, name: string) {
    const runtime = new AxlTestRuntime({ config: { trace: { level: 'full' } } });
    const provider = MockProvider.sequence([{ content: 'a doorbell' }]);
    const wf = workflow({
      name,
      input: z.object({}).strict(),
      handler: async (ctx) => ctx.ask(ListenAgent, input),
    });
    runtime.register(wf);
    runtime.mockProvider('mock', provider);
    return { runtime, provider, run: () => runtime.execute(name, {}) };
  }

  it('AT-05: the sentinel reaches the provider but not traceLog() or agentCalls()', async () => {
    const { runtime, provider, run } = testRuntime(audioInput, 'at05-leak');
    await expect(run()).resolves.toBe('a doorbell');

    // Positive control — without this the absence assertions prove nothing.
    expect(JSON.stringify(provider.calls)).toContain(SENTINEL);

    expect(JSON.stringify(runtime.traceLog())).not.toContain(SENTINEL);
    expect(JSON.stringify(runtime.agentCalls())).not.toContain(SENTINEL);
    expect(runtime.agentCalls()[0]).toMatchObject({
      agent: 'listen-agent',
      input: {
        parts: [
          { type: 'audio', source: 'base64', mediaType: 'audio/wav', label: 'customer call' },
          { type: 'text', characters: 12 },
        ],
      },
    });
  });

  it('AB-12: an audio ask emits no event types beyond the text-only set', async () => {
    const audio = testRuntime(audioInput, 'ab12-audio');
    await audio.run();
    const audioTypes = new Set(audio.runtime.traceLog().map((event: AxlEvent) => event.type));

    const text = testRuntime('summarize it', 'ab12-text');
    await text.run();
    const textTypes = new Set(text.runtime.traceLog().map((event: AxlEvent) => event.type));

    expect([...audioTypes].filter((type) => !textTypes.has(type))).toEqual([]);
  });
});

// ── Review fix wave: the rejected part owns the reported modality ──────────

describe('MockProvider reports the offending part, not the first rich part', () => {
  it('reports audio when a supported image leads and the audio provider-file is foreign', async () => {
    const provider = MockProvider.echo();
    const { run } = askWith(
      provider,
      [
        { type: 'image', source: { type: 'base64', data: SENTINEL, mediaType: 'image/png' } },
        {
          type: 'audio',
          source: { type: 'provider-file', provider: 'not-mock', reference: 'file_1' },
        },
      ],
      'fix-offending-modality',
    );

    const error = (await run().catch((err: unknown) => err)) as UnsupportedModelInputError;
    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    // Deriving from the leading rich part would report the (supported) image.
    expect(error.modality).toBe('audio');
    expect(error.source).toBe('provider-file');
    expect(provider.calls).toHaveLength(0);
  });
});

// ── AT-06: image rejections keep the frozen image triple ───────────────────

describe('MockProvider image rejections are unchanged', () => {
  it('AT-06: a mismatched image provider-file still yields the frozen image triple', async () => {
    // Frozen in packages/axl/src/__tests__/fixtures/rich-input-baselines.ts as
    // IMAGE_REJECTION_TRIPLES.mockMismatchedProviderFile. Duplicated as a
    // literal because that fixture is not exported across packages.
    const provider = MockProvider.echo();
    const { run } = askWith(
      provider,
      [
        {
          type: 'image',
          source: { type: 'provider-file', provider: 'not-mock', reference: 'file_1' },
        },
      ],
      'at06-image-triple',
    );

    const error = (await run().catch((err: unknown) => err)) as UnsupportedModelInputError;
    expect({ modality: error.modality, source: error.source, message: error.message }).toEqual({
      modality: 'image',
      source: 'provider-file',
      message: "Provider 'mock' model 'audio-test' does not support image from provider-file",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it('AT-06: withInputModalities([audio]) rejects an image as the image modality', async () => {
    const provider = MockProvider.sequence([{ content: 'never' }]).withInputModalities(['audio']);
    const { run } = askWith(
      provider,
      [{ type: 'image', source: { type: 'base64', data: SENTINEL, mediaType: 'image/png' } }],
      'at06-image-optout',
    );

    const error = (await run().catch((err: unknown) => err)) as UnsupportedModelInputError;
    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    expect(error.modality).toBe('image');
    expect(error.source).toBe('base64');
    expect(error.message).toContain('image input');
    expect(provider.calls).toHaveLength(0);
  });
});

// ── AT-07: the transcription mock is a separate product ────────────────────

describe('MockTranscriptionProvider is untouched by general audio input', () => {
  it('AT-07: records a transcription request with no model-input part concept', async () => {
    const transcriber = MockTranscriptionProvider.text('hello there');
    const result = await transcriber.transcribe({
      model: 'whisper-test',
      audio: { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'audio/wav' },
    });

    expect(result.transcript.text).toBe('hello there');
    expect(transcriber.calls).toHaveLength(1);
    expect(transcriber.calls[0]).toEqual({
      model: 'whisper-test',
      audio: { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'audio/wav' },
    });
    expect(JSON.stringify(transcriber.calls)).not.toContain('"type":"audio"');
  });

  it('AT-07: exposes transcription capabilities, not input modalities', () => {
    const transcriber = MockTranscriptionProvider.text('x');
    expect(transcriber.capabilities('whisper-test')).toEqual({
      sources: ['bytes', 'base64', 'provider-file'],
      timestamps: ['segment', 'word'],
      diarization: true,
    });
    expect('inputCapabilities' in transcriber).toBe(false);
    expect('withInputModalities' in transcriber).toBe(false);
  });
});

// ── AB-01 / AB-02 / AB-07 end-to-end through the mock ──────────────────────

describe('audio source kinds survive the ask round trip', () => {
  it.each([
    [
      'bytes',
      {
        type: 'audio' as const,
        source: { type: 'bytes' as const, data: new Uint8Array([7, 8]), mediaType: 'audio/wav' },
        label: 'call',
      },
    ],
    [
      'base64',
      {
        type: 'audio' as const,
        source: { type: 'base64' as const, data: SENTINEL, mediaType: 'audio/mpeg' },
        label: 'voicemail',
      },
    ],
    [
      'provider-file',
      {
        type: 'audio' as const,
        source: {
          type: 'provider-file' as const,
          provider: 'mock',
          reference: 'files/rec-1',
          mediaType: 'audio/wav',
        },
      },
    ],
  ])(
    'AB-01: a %s audio part is recorded verbatim, never coerced to an image',
    async (kind, part) => {
      const provider = MockProvider.sequence([{ content: 'ok' }]);
      const { run } = askWith(provider, [part], `ab01-${kind}`);
      await run();

      expect(provider.calls[0].messages.at(-1)?.content).toEqual([part]);
    },
  );

  it('AB-02: mutating the caller buffer after the ask does not change the record', async () => {
    const callerBytes = new Uint8Array([1, 2, 3]);
    const provider = MockProvider.sequence([{ content: 'ok' }]);
    const { run } = askWith(
      provider,
      [{ type: 'audio', source: { type: 'bytes', data: callerBytes, mediaType: 'audio/wav' } }],
      'ab02-ownership',
    );
    await run();

    callerBytes.fill(255);

    expect(provider.calls[0].messages.at(-1)?.content).toEqual([
      {
        type: 'audio',
        source: { type: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'audio/wav' },
      },
    ]);
  });

  it('AB-07: audio-only input resolves, while an empty part array is invalid', async () => {
    const provider = MockProvider.sequence([{ content: 'a siren' }]);
    const audioOnly = askWith(provider, [audioBytesPart([1, 2, 3])], 'ab07-audio-only');
    await expect(audioOnly.run()).resolves.toBe('a siren');

    const empty = askWith(MockProvider.sequence([{ content: 'x' }]), [], 'ab07-empty');
    await expect(empty.run()).rejects.toBeInstanceOf(InvalidModelInputError);
  });
});

// ── AB-23: no hidden transcription fallback ────────────────────────────────

describe('an unsupported audio modality never falls back to transcription', () => {
  it('AB-23: throws with a transcription provider registered and calls it zero times', async () => {
    const runtime = new AxlTestRuntime({ config: { trace: { level: 'full' } } });
    const provider = MockProvider.sequence([{ content: 'never' }]).withInputModalities(['image']);
    const transcriber = MockTranscriptionProvider.text('transcribed fallback');
    const wf = workflow({
      name: 'ab23-no-fallback',
      input: z.object({}).strict(),
      handler: async (ctx) =>
        ctx.ask(ListenAgent, [
          { type: 'audio', source: { type: 'base64', data: SENTINEL, mediaType: 'audio/wav' } },
          { type: 'text', text: 'what is this?' },
        ]),
    });
    runtime.register(wf);
    runtime.mockProvider('mock', provider);
    runtime.mockTranscriptionProvider('mock', transcriber);

    const error = await runtime.execute('ab23-no-fallback', {}).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UnsupportedModelInputError);
    expect((error as UnsupportedModelInputError).modality).toBe('audio');
    expect(transcriber.calls).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
    expect(runtime.traceLog().map((event: AxlEvent) => event.type)).not.toContain(
      'transcription_start',
    );
  });
});

// ── AB-24: audio is per-call evidence, not retained session history ────────

describe('Session history does not auto-retain an audio part', () => {
  it('AB-24: the turn after an audio ask carries no audio part', async () => {
    const runtime = new AxlRuntime();
    const provider = MockProvider.sequence([{ content: 'a bell' }, { content: 'yes' }]);
    runtime.registerProvider('mock', provider);
    // The attachment is workflow-internal per-call evidence, exactly as an app
    // would source it. Passing it through the workflow *input* instead would
    // put it in the session's persisted user turn as plain JSON — which is how
    // image attachments already behave and is not what this case is about.
    runtime.register(
      workflow({
        name: 'ab24-audio-turn',
        input: z.object({ text: z.string() }),
        handler: async (ctx) =>
          ctx.ask(ListenAgent, [
            {
              type: 'audio',
              source: { type: 'base64', data: SENTINEL, mediaType: 'audio/wav' },
              label: 'call',
            },
            { type: 'text', text: ctx.input.text },
          ]),
      }),
    );
    runtime.register(
      workflow({
        name: 'ab24-text-turn',
        input: z.object({ text: z.string() }),
        handler: async (ctx) => ctx.ask(ListenAgent, ctx.input.text),
      }),
    );

    const session = runtime.session('ab24-audio-session');
    await session.send('ab24-audio-turn', { text: 'what is this?' });
    await session.send('ab24-text-turn', { text: 'was it loud?' });

    expect(provider.calls).toHaveLength(2);
    const secondUserMessages = provider.calls[1].messages.filter(
      (message) => message.role === 'user',
    );
    expect(secondUserMessages.length).toBeGreaterThan(0);
    for (const message of secondUserMessages) {
      const parts = typeof message.content === 'string' ? [] : message.content;
      expect(parts.some((part) => part.type === 'audio')).toBe(false);
    }
    expect(JSON.stringify(provider.calls[1])).not.toContain(SENTINEL);

    await runtime.shutdown();
  });
});
