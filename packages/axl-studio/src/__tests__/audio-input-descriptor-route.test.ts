/**
 * Studio observation boundary for **audio** model input (matrix AS-01,
 * AS-04, AS-05, AS-06).
 *
 * Before the exhaustive-descriptor change, `describeStudioInput` labelled
 * every non-text part `type: 'image'`, so an audio attachment reached the
 * browser mislabelled. These tests assert the positive audio shape AND the
 * absence of the image label, which is what makes them discriminating: a
 * fallthrough still produces a well-formed descriptor.
 *
 * `MockProvider` does not (yet) declare audio support, so the WS row uses a
 * local provider double that opts in via `inputCapabilities`. That is
 * deliberate: this lane must not depend on the MockProvider audio lane.
 */
import { describe, expect, it, vi } from 'vitest';
import { AxlRuntime, agent, workflow } from '@axlsdk/axl';
import type {
  ChatMessage,
  InputModalitySupport,
  Provider,
  ProviderInputValidationRequest,
  ProviderResponse,
  StreamChunk,
} from '@axlsdk/axl';
import { z } from 'zod';
import { createServer } from '../server/index.js';

/** Distinctive, valid base64 — its presence anywhere in a Studio payload is
 * a leak, and its presence in the captured provider request is the positive
 * control proving the audio actually reached the provider. */
const AUDIO_SENTINEL = 'QVhMLUFVRElPLVNFTlRJTkVMLTkxMzc=';
const IMAGE_SENTINEL = 'iVBORw0KGgo=';

/** A provider that opts in to base64 audio and records what it was sent. */
class AudioCapableProvider implements Provider {
  readonly name = 'audio-mock';
  readonly calls: ChatMessage[][] = [];

  inputCapabilities(): InputModalitySupport {
    return {
      image: { sources: ['base64'] },
      audio: { sources: ['base64', 'provider-file'] },
    };
  }

  validateInput(request: ProviderInputValidationRequest): { effectiveModel: string } {
    return { effectiveModel: request.model };
  }

  async chat(messages: ChatMessage[]): Promise<ProviderResponse> {
    this.calls.push(messages);
    return {
      content: 'heard it',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
    this.calls.push(messages);
    yield { type: 'text_delta', content: 'heard it' };
    yield { type: 'done', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }
}

function setup(redact = false) {
  const runtime = new AxlRuntime(redact ? { trace: { redact: true } } : undefined);
  const provider = new AudioCapableProvider();
  runtime.registerProvider('audio-mock', provider);
  const server = createServer({ runtime });
  return { runtime, provider, ...server };
}

const audioHistory = (label?: string): ChatMessage[] => [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'private text' },
      {
        type: 'audio',
        source: { type: 'base64', data: AUDIO_SENTINEL, mediaType: 'audio/wav' },
        ...(label ? { label } : {}),
      },
    ],
  },
];

describe('Studio session route — audio input descriptors', () => {
  // AS-01
  it('labels an audio history part as audio, never as image, and never ships the bytes', async () => {
    const { app, runtime } = setup();
    await runtime.getStateStore().saveSession('audio-session', audioHistory());

    const res = await app.request('/api/sessions/audio-session');
    const serialized = await res.text();
    const body = JSON.parse(serialized) as {
      data: { history: { content: { parts: Record<string, unknown>[] } }[] };
    };
    const parts = body.data.history[0]!.content.parts;

    expect(parts).toEqual([
      { type: 'text', characters: 12 },
      { type: 'audio', source: 'base64', mediaType: 'audio/wav', bytes: 23 },
    ]);
    // The fallthrough bug produced `"type":"image"` here.
    expect(serialized).not.toContain('"type":"image"');
    expect(serialized).not.toContain(AUDIO_SENTINEL);
    expect(serialized).not.toContain('private text');
  });

  // AS-01, provider-file variant: the Studio-safe descriptor carries the
  // source kind but never the locator (same policy as the image variant).
  it('omits the provider-file reference from an audio descriptor', async () => {
    const { app, runtime } = setup();
    await runtime.getStateStore().saveSession('audio-file-session', [
      {
        role: 'user',
        content: [
          {
            type: 'audio',
            source: {
              type: 'provider-file',
              provider: 'openai',
              reference: 'file-secret-locator',
              mediaType: 'audio/mpeg',
            },
          },
        ],
      },
    ]);

    const serialized = await (await app.request('/api/sessions/audio-file-session')).text();
    expect(JSON.parse(serialized).data.history[0].content.parts).toEqual([
      { type: 'audio', source: 'provider-file', mediaType: 'audio/mpeg' },
    ]);
    expect(serialized).not.toContain('file-secret-locator');
  });

  // AS-05
  it('keeps the audio descriptor structural under redaction while scrubbing the label', async () => {
    const { app, runtime } = setup(true);
    await runtime.getStateStore().saveSession('redacted-audio', audioHistory('private label'));

    const serialized = await (await app.request('/api/sessions/redacted-audio')).text();
    expect(JSON.parse(serialized).data.history[0].content.parts).toEqual([
      { type: 'text', characters: 12 },
      { type: 'audio', source: 'base64', mediaType: 'audio/wav', bytes: 23 },
    ]);
    expect(serialized).not.toContain('private label');
    expect(serialized).not.toContain('private text');
    expect(serialized).not.toContain(AUDIO_SENTINEL);
    expect(serialized).not.toContain('"type":"image"');
  });

  // AS-06 regression: adding the audio branch must not disturb image output.
  it('leaves the image descriptor payload unchanged', async () => {
    const { app, runtime } = setup();
    await runtime.getStateStore().saveSession('image-session', [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'private text' },
          {
            type: 'image',
            source: { type: 'base64', data: IMAGE_SENTINEL, mediaType: 'image/png' },
            label: 'private-name.png',
          },
        ],
      },
    ]);

    const serialized = await (await app.request('/api/sessions/image-session')).text();
    expect(JSON.parse(serialized).data.history[0].content.parts).toEqual([
      { type: 'text', characters: 12 },
      { type: 'image', source: 'base64', mediaType: 'image/png', bytes: 8 },
    ]);
    expect(serialized).not.toContain('"type":"audio"');
    expect(serialized).not.toContain(IMAGE_SENTINEL);
    expect(serialized).not.toContain('private-name.png');
  });
});

describe('Studio WS broadcast — audio input', () => {
  async function runAudioExecution(redact: boolean) {
    const { runtime, provider, connMgr } = setup(redact);
    const broadcast = vi.spyOn(connMgr, 'broadcastWithWildcard');

    runtime.register(
      workflow({
        name: 'audio-run',
        input: z.object({}),
        handler: (ctx) =>
          ctx.ask(agent({ name: 'listener', model: 'audio-mock:ears-1' }), [
            {
              type: 'audio',
              source: { type: 'base64', data: AUDIO_SENTINEL, mediaType: 'audio/wav' },
              label: 'private-clip.wav',
            },
            { type: 'text', text: 'what do you hear?' },
          ]),
      }),
    );
    await expect(runtime.execute('audio-run', {})).resolves.toBe('heard it');

    // Positive control: the audio really was dispatched, so the absence
    // assertions are about the WS boundary, not a run that never happened.
    expect(JSON.stringify(provider.calls)).toContain(AUDIO_SENTINEL);

    const traceFrames = broadcast.mock.calls.filter(([channel]) =>
      String(channel).startsWith('trace:'),
    );
    expect(traceFrames.length).toBeGreaterThan(0);
    await runtime.shutdown();
    return { allFrames: broadcast.mock.calls, traceFrames };
  }

  // AS-04
  it('never puts audio base64 on any WS channel, including the trace firehose', async () => {
    const { allFrames, traceFrames } = await runAudioExecution(false);

    expect(JSON.stringify(allFrames)).not.toContain(AUDIO_SENTINEL);
    // The descriptor itself must still reach the UI, labelled as audio.
    const trace = JSON.stringify(traceFrames);
    expect(trace).toContain('"type":"audio"');
    expect(trace).toContain('"source":"base64"');
    expect(trace).not.toContain('"type":"image"');
  });

  // AS-05 on the firehose: docs/security §300 requires the trace channel to
  // apply the same scrub as the per-route broadcasts.
  it('scrubs the audio label on the trace firehose under redaction', async () => {
    const { allFrames, traceFrames } = await runAudioExecution(true);

    const serialized = JSON.stringify(allFrames);
    expect(serialized).not.toContain(AUDIO_SENTINEL);
    expect(serialized).not.toContain('private-clip.wav');
    // Structural fields survive redaction so the run stays diagnosable.
    const trace = JSON.stringify(traceFrames);
    expect(trace).toContain('"type":"audio"');
    expect(trace).toContain('"mediaType":"audio/wav"');
    expect(trace).not.toContain('"type":"image"');
  });
});
