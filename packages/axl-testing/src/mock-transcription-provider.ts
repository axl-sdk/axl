import type {
  TranscriptionCapabilities,
  TranscriptionProvider,
  TranscriptionProviderRequest,
  TranscriptionProviderResult,
} from '@axlsdk/axl';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneRequest(
  request: TranscriptionProviderRequest,
  includeSignal: boolean,
): TranscriptionProviderRequest {
  const audio =
    request.audio.type === 'bytes'
      ? { ...request.audio, data: request.audio.data.slice() }
      : { ...request.audio };
  return {
    model: request.model,
    audio,
    ...(request.language !== undefined ? { language: request.language } : {}),
    ...(request.timestamps !== undefined ? { timestamps: request.timestamps } : {}),
    ...(request.diarization !== undefined ? { diarization: request.diarization } : {}),
    ...(request.providerOptions ? { providerOptions: clone(request.providerOptions) } : {}),
    ...(includeSignal && request.signal ? { signal: request.signal } : {}),
  };
}

/** Dedicated transcription mock. It intentionally does not extend MockProvider,
 * so chat fixtures cannot accidentally become transcription adapters. */
export class MockTranscriptionProvider implements TranscriptionProvider {
  private _calls: TranscriptionProviderRequest[] = [];

  constructor(
    private readonly response: (
      request: TranscriptionProviderRequest,
      callIndex: number,
    ) => TranscriptionProviderResult | Promise<TranscriptionProviderResult>,
    private readonly capabilitiesFor: (
      model: string,
    ) => TranscriptionCapabilities | undefined = () => ({
      sources: ['bytes', 'base64', 'provider-file'],
      timestamps: ['segment', 'word'],
      diarization: true,
    }),
  ) {}

  get calls(): readonly TranscriptionProviderRequest[] {
    return this._calls.map(clone);
  }

  capabilities(model: string): TranscriptionCapabilities | undefined {
    return this.capabilitiesFor(model);
  }

  async transcribe(request: TranscriptionProviderRequest): Promise<TranscriptionProviderResult> {
    // AbortSignal cannot be structured-cloned. Keep it only on the callback
    // request so fixtures can observe cancellation; recorded calls omit it.
    const snapshot = cloneRequest(request, false);
    this._calls.push(snapshot);
    return clone(await this.response(cloneRequest(request, true), this._calls.length - 1));
  }

  static text(text: string): MockTranscriptionProvider {
    return new MockTranscriptionProvider(() => ({ transcript: { text } }));
  }
}
