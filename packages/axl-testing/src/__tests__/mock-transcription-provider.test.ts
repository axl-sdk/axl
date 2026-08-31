import { describe, expect, it } from 'vitest';
import { MockTranscriptionProvider } from '../mock-transcription-provider.js';
import { AxlTestRuntime } from '../test-runtime.js';
import { workflow } from '@axlsdk/axl';
import { z } from 'zod';

describe('MockTranscriptionProvider', () => {
  it('records defensive request snapshots and returns defensive result snapshots', async () => {
    const provider = new MockTranscriptionProvider(() => ({ transcript: { text: 'ok' } }));
    const bytes = new Uint8Array([1, 2]);
    const result = await provider.transcribe({
      model: 'stt',
      audio: { type: 'bytes', data: bytes, mediaType: 'audio/wav' },
    });
    bytes[0] = 9;
    (result.transcript as { text: string }).text = 'mutated';
    expect((provider.calls[0].audio as { data: Uint8Array }).data).toEqual(new Uint8Array([1, 2]));
    const again = provider.calls[0];
    (again.audio as { data: Uint8Array }).data[0] = 4;
    expect((provider.calls[0].audio as { data: Uint8Array }).data[0]).toBe(1);
  });

  it('is reachable only through the test runtime transcription registry', async () => {
    const runtime = new AxlTestRuntime();
    const provider = MockTranscriptionProvider.text('recorded');
    runtime.mockTranscriptionProvider('mock-stt', provider);
    runtime.register(
      workflow({
        name: 'transcribe-fixture',
        input: z.object({}),
        handler: (ctx) =>
          ctx.transcribe({
            model: 'mock-stt:stt-1',
            audio: { type: 'bytes', data: new Uint8Array([1]), mediaType: 'audio/wav' },
          }),
      }),
    );
    await expect(runtime.execute('transcribe-fixture', {})).resolves.toMatchObject({
      text: 'recorded',
    });
    expect(provider.calls).toHaveLength(1);
    expect(runtime.traceLog().map((event) => event.type)).toContain('transcription_end');
  });

  it('does not route unknown transcription providers to a single mock fallback', async () => {
    const runtime = new AxlTestRuntime();
    const provider = MockTranscriptionProvider.text('never');
    runtime.mockTranscriptionProvider('mock-stt', provider);
    runtime.register(
      workflow({
        name: 'unknown-transcribe-fixture',
        input: z.object({}),
        handler: (ctx) =>
          ctx.transcribe({
            model: 'anthropic:stt',
            audio: { type: 'bytes', data: new Uint8Array([1]), mediaType: 'audio/wav' },
          }),
      }),
    );
    await expect(runtime.execute('unknown-transcribe-fixture', {})).rejects.toMatchObject({
      code: 'UNSUPPORTED_TRANSCRIPTION_INPUT',
    });
    expect(provider.calls).toHaveLength(0);
  });

  it('passes the original AbortSignal to the fixture but omits it from recorded snapshots', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const provider = new MockTranscriptionProvider(async (request) => {
      observedSignal = request.signal;
      await new Promise<void>((resolve) =>
        request.signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return { transcript: { text: 'aborted fixture' } };
    });
    const pending = provider.transcribe({
      model: 'stt',
      audio: { type: 'bytes', data: new Uint8Array([1]), mediaType: 'audio/wav' },
      signal: controller.signal,
    });
    controller.abort();
    await pending;
    expect(observedSignal).toBe(controller.signal);
    expect(provider.calls[0].signal).toBeUndefined();
  });
});
