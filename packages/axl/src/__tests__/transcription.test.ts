import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WorkflowContext } from '../context.js';
import { AxlRuntime } from '../runtime.js';
import {
  InvalidTranscriptionInputError,
  TranscriptionOperationError,
  UnsupportedTranscriptionInputError,
} from '../errors.js';
import { ProviderRegistry } from '../providers/registry.js';
import { TranscriptionProviderRegistry } from '../providers/transcription-registry.js';
import type {
  TranscriptionProvider,
  TranscriptionProviderRequest,
} from '../providers/transcription-types.js';
import type { AxlEvent } from '../types.js';
import {
  MAX_INLINE_TRANSCRIPTION_BYTES,
  normalizeTranscriptionAccounting,
  normalizeTranscriptionRequest,
} from '../transcription.js';
import { ProviderError } from '../providers/errors.js';

function makeProvider(): TranscriptionProvider & { calls: TranscriptionProviderRequest[] } {
  const calls: TranscriptionProviderRequest[] = [];
  return {
    calls,
    capabilities: () => ({
      sources: ['bytes', 'base64', 'provider-file'],
      timestamps: ['segment'],
      diarization: true,
    }),
    async transcribe(request) {
      calls.push(structuredClone(request));
      return {
        transcript: { text: 'hello', usage: { audioSeconds: 2 } },
        cleanupStatus: 'not_required',
      };
    },
  };
}

function makeContext(provider?: TranscriptionProvider) {
  const transcription = new TranscriptionProviderRegistry();
  if (provider) transcription.registerInstance('test', provider);
  const events: AxlEvent[] = [];
  return {
    events,
    ctx: new WorkflowContext({
      input: undefined,
      executionId: randomUUID(),
      config: {},
      providerRegistry: new ProviderRegistry(),
      transcriptionProviderRegistry: transcription,
      onTrace: (event) => events.push(event),
    }),
  };
}

describe('WorkflowContext.transcribe', () => {
  it('uses only the explicit transcription provider and emits safe paired events', async () => {
    const provider = makeProvider();
    const { ctx, events } = makeContext(provider);
    const input = new Uint8Array([1, 2, 3]);
    const transcript = await ctx.transcribe({
      model: 'test:stt-1',
      audio: { type: 'bytes', data: input, mediaType: 'audio/wav' },
      timestamps: 'segment',
    });
    input[0] = 99;
    expect(transcript.text).toBe('hello');
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].model).toBe('stt-1');
    expect((provider.calls[0].audio as { data: Uint8Array }).data[0]).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['transcription_start', 'transcription_end']);
    const end = events[1];
    expect(end.type).toBe('transcription_end');
    if (end.type === 'transcription_end') {
      expect(end.data).toMatchObject({ status: 'completed', audio: { source: 'bytes', bytes: 3 } });
      expect(JSON.stringify(end)).not.toContain('AQID');
      const start = events[0];
      expect(start.type).toBe('transcription_start');
      if (start.type === 'transcription_start')
        expect(end.transcriptionId).toBe(start.transcriptionId);
    }
  });

  it('fails malformed, unknown, mismatched-file, and aborted requests before dispatch with one terminal', async () => {
    const provider = makeProvider();
    const controller = new AbortController();
    controller.abort();
    const { ctx, events } = makeContext(provider);
    await expect(
      ctx.transcribe({
        model: 'test:stt',
        audio: { type: 'base64', data: 'abc', mediaType: 'audio/wav' },
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptionInputError);
    await expect(
      ctx.transcribe({
        model: 'missing:stt',
        audio: { type: 'bytes', data: new Uint8Array([1]), mediaType: 'audio/wav' },
      }),
    ).rejects.toBeInstanceOf(UnsupportedTranscriptionInputError);
    await expect(
      ctx.transcribe({
        model: 'test:stt',
        audio: { type: 'provider-file', provider: 'other', reference: 'secret-file' },
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptionInputError);
    const abortCtx = new WorkflowContext({
      input: undefined,
      executionId: randomUUID(),
      config: {},
      providerRegistry: new ProviderRegistry(),
      transcriptionProviderRegistry: new TranscriptionProviderRegistry(),
      signal: controller.signal,
    });
    await expect(
      abortCtx.transcribe({
        model: 'test:stt',
        audio: { type: 'bytes', data: new Uint8Array([1]), mediaType: 'audio/wav' },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.calls).toHaveLength(0);
    expect(events.filter((event) => event.type === 'transcription_start')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'transcription_end')).toHaveLength(3);
  });

  it('rejects oversized inline audio before dispatch or base64 decoding', async () => {
    const provider = makeProvider();
    const { ctx } = makeContext(provider);
    await expect(
      ctx.transcribe({
        model: 'test:stt',
        audio: {
          type: 'bytes',
          data: new Uint8Array(MAX_INLINE_TRANSCRIPTION_BYTES + 1),
          mediaType: 'audio/wav',
        },
      }),
    ).rejects.toThrow('must not exceed 25 MiB');
    expect(() =>
      normalizeTranscriptionRequest({
        model: 'test:stt',
        audio: {
          type: 'base64',
          data: 'A'.repeat(4 * Math.ceil(MAX_INLINE_TRANSCRIPTION_BYTES / 3) + 4),
          mediaType: 'audio/wav',
        },
      }),
    ).toThrow('must not exceed 25 MiB');
    expect(provider.calls).toHaveLength(0);
  });

  it('redacts transcript output without recording provider-file references', async () => {
    const provider = makeProvider();
    const transcription = new TranscriptionProviderRegistry();
    transcription.registerInstance('test', provider);
    const events: AxlEvent[] = [];
    const ctx = new WorkflowContext({
      input: undefined,
      executionId: randomUUID(),
      config: { trace: { redact: true } },
      providerRegistry: new ProviderRegistry(),
      transcriptionProviderRegistry: transcription,
      onTrace: (event) => events.push(event),
    });
    await ctx.transcribe({
      model: 'test:stt',
      audio: { type: 'provider-file', provider: 'test', reference: 'do-not-leak' },
    });
    expect(JSON.stringify(events)).not.toContain('do-not-leak');
    expect(JSON.stringify(events)).toContain('[redacted]');
  });

  it('wraps provider errors safely while accounting a failed authoritative result once', async () => {
    const secret = 'base64-audio-or-file-reference';
    const provider: TranscriptionProvider = {
      capabilities: () => ({ sources: ['base64'] }),
      async transcribe() {
        const error = new ProviderError({
          provider: 'test',
          status: 429,
          retryable: true,
          retryAfterMs: 2_000,
          requestId: 'request-safe-123',
          message: `vendor echoed ${secret}`,
          body: secret,
        }) as ProviderError & {
          usage: unknown;
          pricingStatus: unknown;
          cleanupStatus: unknown;
        };
        error.usage = { audioSeconds: 4, totalTokens: 9, cost: 0.02 };
        error.pricingStatus = 'priced';
        error.cleanupStatus = 'timed_out';
        throw error;
      },
    };
    const { ctx, events } = makeContext(provider);
    const rejection = expect(
      ctx.transcribe({
        model: 'test:stt',
        audio: { type: 'base64', data: 'AQI=', mediaType: 'audio/wav' },
      }),
    ).rejects;
    await rejection.toBeInstanceOf(TranscriptionOperationError);
    await rejection.toMatchObject({
      status: 429,
      retryable: true,
      retryAfterMs: 2_000,
      requestId: 'request-safe-123',
    });
    const end = events.find((event) => event.type === 'transcription_end');
    expect(end?.type).toBe('transcription_end');
    if (end?.type === 'transcription_end') {
      expect(end.cost).toBe(0.02);
      expect(end.data).toMatchObject({
        status: 'failed',
        cleanupStatus: 'timed_out',
        usage: { audioSeconds: 4, totalTokens: 9 },
        providerError: {
          status: 429,
          retryable: true,
          retryAfterMs: 2_000,
          requestId: 'request-safe-123',
        },
      });
    }
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('does not complete when an aborted operation resolves late, and pairs concurrent calls by id', async () => {
    let resolve!: () => void;
    const wait = new Promise<void>((done) => {
      resolve = done;
    });
    const provider: TranscriptionProvider = {
      capabilities: () => ({ sources: ['bytes'] }),
      async transcribe() {
        await wait;
        return { transcript: { text: 'late', usage: { audioSeconds: 1, cost: 0.01 } } };
      },
    };
    const controller = new AbortController();
    const { ctx, events } = makeContext(provider);
    const abortedContext = new WorkflowContext({
      input: undefined,
      executionId: randomUUID(),
      config: {},
      providerRegistry: new ProviderRegistry(),
      transcriptionProviderRegistry: (() => {
        const registry = new TranscriptionProviderRegistry();
        registry.registerInstance('test', provider);
        return registry;
      })(),
      signal: controller.signal,
      onTrace: (event) => events.push(event),
    });
    const first = ctx.transcribe({
      model: 'test:stt',
      audio: { type: 'bytes', data: new Uint8Array([1]), mediaType: 'audio/wav' },
    });
    const second = abortedContext.transcribe({
      model: 'test:stt',
      audio: { type: 'bytes', data: new Uint8Array([2]), mediaType: 'audio/wav' },
    });
    controller.abort();
    resolve();
    await expect(first).resolves.toMatchObject({ text: 'late' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    const starts = events.filter((event) => event.type === 'transcription_start');
    const ends = events.filter((event) => event.type === 'transcription_end');
    expect(new Set(starts.map((event) => event.transcriptionId)).size).toBe(2);
    expect(new Set(ends.map((event) => event.transcriptionId))).toEqual(
      new Set(starts.map((event) => event.transcriptionId)),
    );
    expect(ends.some((event) => event.data.status === 'aborted')).toBe(true);
  });

  it('rejects reserved overrides and unsupported capabilities before dispatch', async () => {
    const provider: TranscriptionProvider & { calls: number } = {
      calls: 0,
      capabilities: () => ({ sources: ['bytes'], timestamps: ['segment'], diarization: false }),
      async transcribe() {
        this.calls++;
        return { transcript: { text: 'nope' } };
      },
    };
    const { ctx } = makeContext(provider);
    await expect(
      ctx.transcribe({
        model: 'test:stt',
        audio: { type: 'bytes', data: new Uint8Array([1]), mediaType: 'audio/wav' },
        providerOptions: { signal: 'override' },
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptionInputError);
    await expect(
      ctx.transcribe({
        model: 'test:stt',
        audio: { type: 'base64', data: 'AQI=', mediaType: 'audio/wav' },
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptionInputError);
    await expect(
      ctx.transcribe({
        model: 'test:stt',
        audio: { type: 'bytes', data: new Uint8Array([1]), mediaType: 'audio/wav' },
        timestamps: 'word',
        diarization: true,
      }),
    ).rejects.toBeInstanceOf(InvalidTranscriptionInputError);
    expect(provider.calls).toBe(0);
  });

  it('does not dispatch a second operation after a finish-and-stop budget is exceeded', async () => {
    const provider: TranscriptionProvider & { calls: number } = {
      calls: 0,
      capabilities: () => ({ sources: ['bytes'] }),
      async transcribe() {
        this.calls++;
        return { transcript: { text: 'spent', usage: { audioSeconds: 1, cost: 2 } } };
      },
    };
    const { ctx, events } = makeContext(provider);
    const result = await ctx.budget({ cost: '$1', onExceed: 'finish_and_stop' }, async () => {
      await ctx.transcribe({
        model: 'test:stt',
        audio: { type: 'bytes', data: new Uint8Array([1]), mediaType: 'audio/wav' },
      });
      await ctx.transcribe({
        model: 'test:stt',
        audio: { type: 'bytes', data: new Uint8Array([2]), mediaType: 'audio/wav' },
      });
      return 'unreachable';
    });
    expect(result).toMatchObject({ value: null, budgetExceeded: true, totalCost: 2 });
    expect(provider.calls).toBe(1);
    expect(events.filter((event) => event.type === 'transcription_start')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'transcription_end')).toHaveLength(2);
  });

  it('keeps explicit priced zero and resolves contradictory zero pricing to positive cost', () => {
    expect(normalizeTranscriptionAccounting({ audioSeconds: 1, cost: 0 }, 'priced')).toMatchObject({
      cost: 0,
      pricingStatus: 'priced',
    });
    expect(normalizeTranscriptionAccounting({ audioSeconds: 1, cost: 0.1 }, 'zero')).toMatchObject({
      cost: 0.1,
      pricingStatus: 'priced',
    });
    expect(normalizeTranscriptionAccounting({ audioSeconds: 1 }, 'priced')).toMatchObject({
      pricingStatus: 'unpriced',
    });
  });

  it('returns the same normalized accounting that it emits', async () => {
    const provider: TranscriptionProvider = {
      capabilities: () => ({ sources: ['bytes'] }),
      async transcribe() {
        return {
          transcript: {
            text: 'normalized',
            usage: { audioSeconds: 1, cost: 0.1 },
            pricingStatus: 'zero',
          },
        };
      },
    };
    const { ctx, events } = makeContext(provider);
    const transcript = await ctx.transcribe({
      model: 'test:stt',
      audio: { type: 'bytes', data: new Uint8Array([1]), mediaType: 'audio/wav' },
    });
    expect(transcript).toMatchObject({ usage: { cost: 0.1 }, pricingStatus: 'priced' });
    const end = events.find((event) => event.type === 'transcription_end');
    expect(end?.type).toBe('transcription_end');
    if (end?.type === 'transcription_end')
      expect(end.data).toMatchObject({ usage: { cost: 0.1 }, pricingStatus: 'priced' });
  });

  it('is reachable through explicit runtime registration without a chat provider', async () => {
    const provider = makeProvider();
    const runtime = new AxlRuntime();
    runtime.registerTranscriptionProvider('test', provider);
    const ctx = runtime.createContext({
      sessionHistory: [{ role: 'user', content: 'chat history stays separate' }],
    });
    await expect(
      ctx.transcribe({
        model: 'test:stt',
        audio: { type: 'bytes', data: new Uint8Array([1]), mediaType: 'audio/wav' },
      }),
    ).resolves.toMatchObject({ text: 'hello' });
    expect(provider.calls).toHaveLength(1);
  });
});
