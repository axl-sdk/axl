import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidTranscriptionInputError, UnsupportedTranscriptionInputError } from '../errors.js';
import { GeminiTranscriptionProvider } from '../providers/gemini-transcription.js';
import { OpenAITranscriptionProvider } from '../providers/openai-transcription.js';
import { OpenRouterTranscriptionProvider } from '../providers/openrouter-transcription.js';
import { TranscriptionProviderRegistry } from '../providers/transcription-registry.js';

const originalFetch = globalThis.fetch;
const bytes = new Uint8Array([1, 2, 3]);

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(
    status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers },
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('dedicated transcription adapters', () => {
  it('maps OpenAI bytes to the dedicated multipart endpoint with returned token usage', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        response({ text: 'hello', usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } }),
      );
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new OpenAITranscriptionProvider({ apiKey: 'key' });
    const result = await provider.transcribe({
      model: 'gpt-transcribe',
      audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
      language: 'en',
      providerOptions: { temperature: 0.2, prompt: 'names' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/audio/transcriptions');
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key');
    const form = init.body as FormData;
    expect((form.get('file') as File).name).toBe('audio.wav');
    expect(form.get('model')).toBe('gpt-transcribe');
    expect(form.get('response_format')).toBe('json');
    expect(form.get('language')).toBe('en');
    expect(form.get('temperature')).toBe('0.2');
    expect(result.transcript).toMatchObject({
      text: 'hello',
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      pricingStatus: 'unpriced',
    });
  });

  it('rejects OpenAI provider-file, unsupported options, model, media type, and 25 MiB before network', async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new OpenAITranscriptionProvider({ apiKey: 'key' });
    await expect(
      provider.transcribe({
        model: 'other',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
      }),
    ).rejects.toBeInstanceOf(UnsupportedTranscriptionInputError);
    await expect(
      provider.transcribe({
        model: 'gpt-transcribe',
        audio: { type: 'provider-file', provider: 'openai-transcription', reference: 'secret' },
      }),
    ).rejects.toBeInstanceOf(UnsupportedTranscriptionInputError);
    await expect(
      provider.transcribe({
        model: 'gpt-transcribe',
        audio: { type: 'bytes', data: bytes, mediaType: 'text/plain' },
      }),
    ).rejects.toBeInstanceOf(UnsupportedTranscriptionInputError);
    await expect(
      provider.transcribe({
        model: 'gpt-transcribe',
        audio: {
          type: 'bytes',
          data: new Uint8Array(25 * 1024 * 1024 + 1),
          mediaType: 'audio/wav',
        },
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptionInputError);
    await expect(
      provider.transcribe({
        model: 'gpt-transcribe',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
        providerOptions: { model: 'bad' },
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptionInputError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses Gemini upload, readiness, stateless Interactions, and one safe delete', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response('', 200, {
          'x-goog-upload-url': 'https://generativelanguage.googleapis.com/session',
        }),
      )
      .mockResolvedValueOnce(
        response({
          file: {
            name: 'files/secret',
            uri: 'https://files.test/secret',
            mimeType: 'audio/wav',
            state: 'PROCESSING',
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          name: 'files/secret',
          uri: 'https://files.test/secret',
          mimeType: 'audio/wav',
          state: 'ACTIVE',
        }),
      )
      .mockResolvedValueOnce(
        response({
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [
                {
                  type: 'text',
                  text: 'hello',
                  annotations: [
                    {
                      type: 'word_info',
                      text: 'hello',
                      start_offset: '0s',
                      end_offset: '0.5s',
                      speaker: 'A',
                    },
                  ],
                },
              ],
            },
          ],
          usage: { total_input_tokens: 5, total_output_tokens: 2, total_tokens: 7 },
        }),
      )
      .mockResolvedValueOnce(response('', 204));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiTranscriptionProvider({ apiKey: 'key' });
    const result = await provider.transcribe({
      model: 'gemini-3.5-transcribe',
      audio: { type: 'base64', data: 'AQID', mediaType: 'audio/wav' },
      language: 'en',
      timestamps: 'word',
      diarization: true,
      providerOptions: { mode: 'verbatim' },
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.map((call) => [call[0], (call[1] as RequestInit).method])).toEqual([
      ['https://generativelanguage.googleapis.com/upload/v1beta/files', 'POST'],
      ['https://generativelanguage.googleapis.com/session', 'POST'],
      ['https://generativelanguage.googleapis.com/v1beta/files/secret', 'GET'],
      ['https://generativelanguage.googleapis.com/v1beta/interactions', 'POST'],
      ['https://generativelanguage.googleapis.com/v1beta/files/secret', 'DELETE'],
    ]);
    const body = JSON.parse((fetch.mock.calls[3][1] as RequestInit).body as string);
    expect(body).toEqual({
      model: 'gemini-3.5-transcribe',
      input: [{ type: 'audio', uri: 'https://files.test/secret', mime_type: 'audio/wav' }],
      store: false,
      generation_config: {
        transcription_config: {
          mode: {
            type: 'verbatim',
            timestamp_granularities: ['word'],
            diarization_mode: 'speaker',
          },
          language_codes: ['en'],
        },
      },
    });
    expect(result).toMatchObject({
      cleanupStatus: 'deleted',
      transcript: {
        text: 'hello',
        words: [{ text: 'hello', start: 0, end: 0.5, speaker: 'A' }],
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        pricingStatus: 'unpriced',
      },
    });
  });

  it('uses caller-owned Gemini provider files without an upload lifecycle and rejects smart timestamp requests before fetch', async () => {
    const fetch = vi.fn().mockResolvedValue(
      response({
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hello' }] }],
      }),
    );
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiTranscriptionProvider({ apiKey: 'key' });
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: {
          type: 'provider-file',
          provider: 'gemini-transcription',
          reference: 'https://files.test/caller',
          mediaType: 'audio/wav',
        },
        providerOptions: {
          mode: 'smart',
          customVocabulary: Array.from({ length: 1000 }, (_, i) => `word-${i}`),
        },
      }),
    ).resolves.toMatchObject({ cleanupStatus: 'not_required' });
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
        timestamps: 'word',
        providerOptions: { mode: 'smart' },
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptionInputError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string).generation_config
        .transcription_config,
    ).toEqual({
      mode: 'smart',
      custom_vocabulary: Array.from({ length: 1000 }, (_, i) => `word-${i}`),
    });
  });

  it('defaults Gemini to verbatim and cleans up a finalized file when its readiness state is missing', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response('', 200, {
          'x-goog-upload-url': 'https://generativelanguage.googleapis.com/session',
        }),
      )
      .mockResolvedValueOnce(
        response({
          file: {
            name: 'files/known-but-incomplete',
            uri: 'https://files.test/known',
            mimeType: 'audio/wav',
          },
        }),
      )
      .mockResolvedValueOnce(response('', 204));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiTranscriptionProvider({ apiKey: 'key' });
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
      }),
    ).rejects.toMatchObject({ cleanupStatus: 'deleted' });
    expect(fetch.mock.calls.map((call) => [call[0], (call[1] as RequestInit).method])).toEqual([
      ['https://generativelanguage.googleapis.com/upload/v1beta/files', 'POST'],
      ['https://generativelanguage.googleapis.com/session', 'POST'],
      ['https://generativelanguage.googleapis.com/v1beta/files/known-but-incomplete', 'DELETE'],
    ]);
  });

  it('uses Gemini verbatim mode by default for a caller-owned file', async () => {
    const fetch = vi.fn().mockResolvedValue(
      response({
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hello' }] }],
      }),
    );
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiTranscriptionProvider({ apiKey: 'key' });
    await provider.transcribe({
      model: 'gemini-3.5-transcribe',
      audio: {
        type: 'provider-file',
        provider: 'gemini-transcription',
        reference: 'https://files.test/caller',
        mediaType: 'audio/wav',
      },
    });
    expect(
      JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string).generation_config
        .transcription_config,
    ).toEqual({ mode: { type: 'verbatim' } });
  });

  it('accepts a completed silent Gemini transcript and keeps only valid optional word annotations', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      response({
        status: 'completed',
        steps: [
          {
            type: 'model_output',
            content: [
              {
                type: 'text',
                text: '',
                annotations: [
                  { type: 'word_info', text: 'ok', start_offset: '1s', end_offset: '2.5s' },
                  { type: 'word_info', text: 'discard', start_offset: 'bad', end_offset: '3s' },
                ],
              },
            ],
          },
        ],
      }),
    );
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiTranscriptionProvider({ apiKey: 'key' });
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: {
          type: 'provider-file',
          provider: 'gemini-transcription',
          reference: 'https://files.test/silent',
          mediaType: 'audio/wav',
        },
        timestamps: 'word',
      }),
    ).resolves.toMatchObject({
      transcript: { text: '', words: [{ text: 'ok', start: 1, end: 2.5 }] },
    });
  });

  it('fails Gemini model/source/composition/media preflight without requiring credentials or fetching', async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiTranscriptionProvider();
    await expect(
      provider.transcribe({
        model: 'other',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
      }),
    ).rejects.toBeInstanceOf(UnsupportedTranscriptionInputError);
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: { type: 'bytes', data: bytes, mediaType: 'text/plain' },
      }),
    ).rejects.toBeInstanceOf(UnsupportedTranscriptionInputError);
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: {
          type: 'provider-file',
          provider: 'other',
          reference: 'secret',
          mediaType: 'audio/wav',
        },
      }),
    ).rejects.toBeInstanceOf(UnsupportedTranscriptionInputError);
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: {
          type: 'provider-file',
          provider: 'gemini-transcription',
          reference: '',
          mediaType: 'audio/wav',
        },
      }),
    ).rejects.toBeInstanceOf(UnsupportedTranscriptionInputError);
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
        diarization: true,
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptionInputError);
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
        timestamps: 'word',
        providerOptions: { customVocabulary: ['Axl'] },
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptionInputError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an untrusted Gemini resumable URL before sending bytes', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(response('', 200, { 'x-goog-upload-url': 'https://evil.test/session' }));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiTranscriptionProvider({ apiKey: 'key' });
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptionInputError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves the primary Gemini inference failure while independently deleting the created file', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response('', 200, {
          'x-goog-upload-url': 'https://generativelanguage.googleapis.com/session',
        }),
      )
      .mockResolvedValueOnce(
        response({
          file: {
            name: 'files/cleanup',
            uri: 'https://files.test/cleanup',
            mimeType: 'audio/wav',
            state: 'ACTIVE',
          },
        }),
      )
      .mockResolvedValueOnce(response({ status: 'failed', steps: [] }))
      .mockResolvedValueOnce(response('', 500));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiTranscriptionProvider({ apiKey: 'key' });
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
      }),
    ).rejects.toMatchObject({ cleanupStatus: 'failed' });
    expect(fetch.mock.calls.map((call) => (call[1] as RequestInit).method)).toEqual([
      'POST',
      'POST',
      'POST',
      'DELETE',
    ]);
  });

  it('cleans up once after caller aborts immediately after finalization', async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response('', 200, {
          'x-goog-upload-url': 'https://generativelanguage.googleapis.com/session',
        }),
      )
      .mockImplementationOnce(() => {
        controller.abort();
        return Promise.resolve(
          response({
            file: {
              name: 'files/aborted',
              uri: 'https://files.test/aborted',
              mimeType: 'audio/wav',
              state: 'PROCESSING',
            },
          }),
        );
      })
      .mockResolvedValueOnce(response('', 204));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiTranscriptionProvider({ apiKey: 'key' });
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ cleanupStatus: 'deleted' });
    expect(fetch.mock.calls.map((call) => (call[1] as RequestInit).method)).toEqual([
      'POST',
      'POST',
      'DELETE',
    ]);
  });

  it.each([
    [
      'FAILED readiness state',
      [
        response('', 200, {
          'x-goog-upload-url': 'https://generativelanguage.googleapis.com/session',
        }),
        response({
          file: {
            name: 'files/failed',
            uri: 'https://files.test/failed',
            mimeType: 'audio/wav',
            state: 'FAILED',
          },
        }),
        response('', 204),
      ],
    ],
    [
      'poll HTTP failure',
      [
        response('', 200, {
          'x-goog-upload-url': 'https://generativelanguage.googleapis.com/session',
        }),
        response({
          file: {
            name: 'files/poll-http',
            uri: 'https://files.test/poll-http',
            mimeType: 'audio/wav',
            state: 'PROCESSING',
          },
        }),
        response('bad', 400),
        response('', 204),
      ],
    ],
  ])('cleans up exactly once on Gemini %s', async (_name, replies) => {
    const fetch = vi.fn();
    for (const reply of replies) fetch.mockResolvedValueOnce(reply);
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiTranscriptionProvider({ apiKey: 'key' });
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
      }),
    ).rejects.toMatchObject({ cleanupStatus: 'deleted' });
    expect(
      fetch.mock.calls.filter((call) => (call[1] as RequestInit).method === 'DELETE'),
    ).toHaveLength(1);
  });

  it('cleans up exactly once on a Gemini readiness poll network failure', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response('', 200, {
          'x-goog-upload-url': 'https://generativelanguage.googleapis.com/session',
        }),
      )
      .mockResolvedValueOnce(
        response({
          file: {
            name: 'files/poll-network',
            uri: 'https://files.test/poll-network',
            mimeType: 'audio/wav',
            state: 'PROCESSING',
          },
        }),
      )
      .mockRejectedValueOnce(new Error('poll network'))
      .mockResolvedValueOnce(response('', 204));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiTranscriptionProvider({ apiKey: 'key' });
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
      }),
    ).rejects.toMatchObject({ cleanupStatus: 'deleted' });
    expect(fetch.mock.calls.map((call) => (call[1] as RequestInit).method)).toEqual([
      'POST',
      'POST',
      'GET',
      'DELETE',
    ]);
  });

  it('bounds Gemini readiness polling and cleans up exactly once on timeout', async () => {
    vi.useFakeTimers();
    const processing = response({
      name: 'files/readiness-timeout',
      uri: 'https://files.test/readiness-timeout',
      mimeType: 'audio/wav',
      state: 'PROCESSING',
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response('', 200, {
          'x-goog-upload-url': 'https://generativelanguage.googleapis.com/session',
        }),
      )
      .mockResolvedValueOnce(
        response({
          file: {
            name: 'files/readiness-timeout',
            uri: 'https://files.test/readiness-timeout',
            mimeType: 'audio/wav',
            state: 'PROCESSING',
          },
        }),
      )
      .mockImplementation((_url: unknown, init: RequestInit) =>
        Promise.resolve(init.method === 'DELETE' ? response('', 204) : processing.clone()),
      );
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiTranscriptionProvider({ apiKey: 'key' });
    const pending = provider.transcribe({
      model: 'gemini-3.5-transcribe',
      audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
    });
    const assertion = expect(pending).rejects.toMatchObject({
      message: 'Gemini transcription file readiness timed out',
      cleanupStatus: 'deleted',
    });
    await vi.advanceTimersByTimeAsync(30_001);
    await assertion;
    expect(
      fetch.mock.calls.filter((call) => (call[1] as RequestInit).method === 'DELETE'),
    ).toHaveLength(1);
    expect(
      fetch.mock.calls.filter((call) => (call[1] as RequestInit).method === 'GET').length,
    ).toBeGreaterThan(0);
  });

  it('cleans up on Gemini inference network, inference HTTP, and malformed completed response failures', async () => {
    const scenarios = [
      [new Error('poll network'), undefined],
      [response('inference bad', 400), undefined],
      [
        response({
          status: 'completed',
          steps: [{ type: 'model_output', content: [{ type: 'image' }] }],
        }),
        undefined,
      ],
    ] as const;
    for (const [failure] of scenarios) {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          response('', 200, {
            'x-goog-upload-url': 'https://generativelanguage.googleapis.com/session',
          }),
        )
        .mockResolvedValueOnce(
          response({
            file: {
              name: 'files/failure',
              uri: 'https://files.test/failure',
              mimeType: 'audio/wav',
              state: 'ACTIVE',
            },
          }),
        );
      if (failure instanceof Error) {
        fetch
          .mockRejectedValueOnce(failure)
          .mockRejectedValueOnce(failure)
          .mockRejectedValueOnce(failure);
      } else fetch.mockResolvedValueOnce(failure);
      fetch.mockResolvedValueOnce(response('', 204));
      globalThis.fetch = fetch as typeof globalThis.fetch;
      const provider = new GeminiTranscriptionProvider({ apiKey: 'key' });
      await expect(
        provider.transcribe({
          model: 'gemini-3.5-transcribe',
          audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
        }),
      ).rejects.toMatchObject({ cleanupStatus: 'deleted' });
      expect(
        fetch.mock.calls.filter((call) => (call[1] as RequestInit).method === 'DELETE'),
      ).toHaveLength(1);
    }
  });

  it('reports Gemini cleanup network failure without replacing the primary error', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response('', 200, {
          'x-goog-upload-url': 'https://generativelanguage.googleapis.com/session',
        }),
      )
      .mockResolvedValueOnce(
        response({
          file: {
            name: 'files/delete-network',
            uri: 'https://files.test/delete-network',
            mimeType: 'audio/wav',
            state: 'ACTIVE',
          },
        }),
      )
      .mockResolvedValueOnce(response({ status: 'failed', steps: [] }))
      .mockRejectedValueOnce(new Error('delete network'));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiTranscriptionProvider({ apiKey: 'key' });
    await expect(
      provider.transcribe({
        model: 'gemini-3.5-transcribe',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
      }),
    ).rejects.toMatchObject({
      message: 'Gemini transcription interaction did not complete',
      cleanupStatus: 'failed',
    });
    expect(
      fetch.mock.calls.filter((call) => (call[1] as RequestInit).method === 'DELETE'),
    ).toHaveLength(1);
  });

  it('bounds Gemini cleanup with its independent timeout', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response('', 200, {
          'x-goog-upload-url': 'https://generativelanguage.googleapis.com/session',
        }),
      )
      .mockResolvedValueOnce(
        response({
          file: {
            name: 'files/delete-timeout',
            uri: 'https://files.test/delete-timeout',
            mimeType: 'audio/wav',
            state: 'ACTIVE',
          },
        }),
      )
      .mockResolvedValueOnce(response({ status: 'failed', steps: [] }))
      .mockImplementationOnce(
        (_url: unknown, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            init.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            ),
          ),
      );
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new GeminiTranscriptionProvider({ apiKey: 'key' });
    const pending = provider.transcribe({
      model: 'gemini-3.5-transcribe',
      audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
    });
    const assertion = expect(pending).rejects.toMatchObject({ cleanupStatus: 'timed_out' });
    await vi.advanceTimersByTimeAsync(3_001);
    await assertion;
    expect(
      fetch.mock.calls.filter((call) => (call[1] as RequestInit).method === 'DELETE'),
    ).toHaveLength(1);
  });

  it('uses the OpenRouter dedicated JSON endpoint and maps authoritative cost', async () => {
    const fetch = vi.fn().mockResolvedValue(
      response({
        text: 'hello',
        usage: { seconds: 3, input_tokens: 2, output_tokens: 1, total_tokens: 3, cost: 0.04 },
      }),
    );
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new OpenRouterTranscriptionProvider({ apiKey: 'key' });
    const result = await provider.transcribe({
      model: 'openai/whisper-1',
      audio: { type: 'bytes', data: bytes, mediaType: 'audio/mpeg' },
      language: 'en',
      providerOptions: { temperature: 0, provider: { order: ['openai'] } },
    });
    expect(fetch.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      model: 'openai/whisper-1',
      input_audio: { data: 'AQID', format: 'mp3' },
      language: 'en',
      temperature: 0,
      provider: { order: ['openai'] },
    });
    expect(result.transcript).toMatchObject({
      usage: { audioSeconds: 3, cost: 0.04 },
      pricingStatus: 'priced',
    });
  });

  it('accepts OpenRouter AAC and rejects out-of-range temperature before network', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ text: 'aac' }));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const provider = new OpenRouterTranscriptionProvider({ apiKey: 'key' });
    await expect(
      provider.transcribe({
        model: 'openai/whisper-1',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/aac' },
      }),
    ).resolves.toMatchObject({ transcript: { text: 'aac' } });
    expect(
      JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string).input_audio.format,
    ).toBe('aac');
    await expect(
      provider.transcribe({
        model: 'openai/whisper-1',
        audio: { type: 'bytes', data: bytes, mediaType: 'audio/aac' },
        providerOptions: { temperature: 1.1 },
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptionInputError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('registers only the explicit built-in adapters with their matching config blocks', () => {
    const registry = new TranscriptionProviderRegistry();
    expect(registry.has('openai-transcription')).toBe(true);
    expect(registry.has('gemini-transcription')).toBe(true);
    expect(registry.has('openrouter-transcription')).toBe(true);
    expect(
      registry.get('openai-transcription', { providers: { openai: { apiKey: 'one' } } }),
    ).toBeInstanceOf(OpenAITranscriptionProvider);
    expect(
      registry.get('gemini-transcription', { providers: { google: { apiKey: 'two' } } }),
    ).toBeInstanceOf(GeminiTranscriptionProvider);
    expect(
      registry.get('openrouter-transcription', { providers: { openrouter: { apiKey: 'three' } } }),
    ).toBeInstanceOf(OpenRouterTranscriptionProvider);
    expect(registry.has('anthropic-transcription')).toBe(false);
  });
});
