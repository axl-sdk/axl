import { InvalidTranscriptionInputError } from './errors.js';

/** Audio supplied to a transcription provider. Network and file-system sources
 * are deliberately excluded: callers retain control of all I/O. */
export type RecordedAudioSource =
  | { readonly type: 'bytes'; readonly data: Uint8Array; readonly mediaType: string }
  | { readonly type: 'base64'; readonly data: string; readonly mediaType: string }
  | {
      readonly type: 'provider-file';
      readonly provider: string;
      readonly reference: string;
      readonly mediaType?: string;
    };

export type TranscriptionRequest = {
  readonly model: string;
  readonly audio: RecordedAudioSource;
  readonly language?: string;
  readonly timestamps?: 'segment' | 'word';
  readonly diarization?: boolean;
  readonly providerOptions?: Record<string, unknown>;
};

export type Transcript = {
  readonly text: string;
  readonly detectedLanguages?: readonly string[];
  readonly segments?: readonly {
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly speaker?: string;
  }[];
  readonly words?: readonly {
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly speaker?: string;
  }[];
  readonly usage?: {
    readonly audioSeconds?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly cost?: number;
  };
  readonly pricingStatus?: 'priced' | 'unpriced' | 'zero';
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
};

export type NormalizedTranscriptionAccounting = {
  readonly usage?: NonNullable<Transcript['usage']>;
  readonly pricingStatus?: Transcript['pricingStatus'];
  readonly cost?: number;
  readonly tokens?: { readonly input?: number; readonly output?: number };
  readonly hasWork: boolean;
};

/** Maximum decoded size of caller-supplied inline audio. */
export const MAX_INLINE_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

const RESERVED_PROVIDER_OPTION_KEYS = new Set([
  'model',
  'audio',
  'signal',
  'cleanup',
  'cleanupStatus',
  'usage',
  'cost',
  'pricingStatus',
  'accounting',
]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new InvalidTranscriptionInputError('Transcription options must be structured-cloneable');
  }
}

/** @internal Normalizes public input without retaining caller-owned media. */
export function normalizeTranscriptionRequest(request: TranscriptionRequest): TranscriptionRequest {
  if (!request || typeof request !== 'object' || !nonEmptyString(request.model)) {
    throw new InvalidTranscriptionInputError('A transcription model URI is required');
  }
  const audio = request.audio;
  if (!audio || typeof audio !== 'object') {
    throw new InvalidTranscriptionInputError('A transcription audio source is required');
  }

  let normalizedAudio: RecordedAudioSource;
  if (audio.type === 'bytes') {
    if (
      !(audio.data instanceof Uint8Array) ||
      audio.data.byteLength === 0 ||
      !nonEmptyString(audio.mediaType)
    ) {
      throw new InvalidTranscriptionInputError(
        'Inline transcription bytes require nonempty data and mediaType',
      );
    }
    if (audio.data.byteLength > MAX_INLINE_TRANSCRIPTION_BYTES) {
      throw new InvalidTranscriptionInputError(
        'Inline transcription audio must not exceed 25 MiB; chunk it or use a supported provider-file source',
      );
    }
    normalizedAudio = {
      type: 'bytes',
      data: new Uint8Array(audio.data),
      mediaType: audio.mediaType,
    };
  } else if (audio.type === 'base64') {
    if (!nonEmptyString(audio.data) || !nonEmptyString(audio.mediaType)) {
      throw new InvalidTranscriptionInputError(
        'Inline base64 transcription audio requires data and mediaType',
      );
    }
    // Bound the encoded value before allocating a decoded copy for canonical
    // validation. The exact decoded length is checked below as well.
    if (audio.data.length > 4 * Math.ceil(MAX_INLINE_TRANSCRIPTION_BYTES / 3)) {
      throw new InvalidTranscriptionInputError(
        'Inline transcription audio must not exceed 25 MiB; chunk it or use a supported provider-file source',
      );
    }
    let decoded: Uint8Array;
    try {
      decoded = Uint8Array.from(Buffer.from(audio.data, 'base64'));
    } catch {
      throw new InvalidTranscriptionInputError(
        'Transcription base64 must be canonical and decode to audio',
      );
    }
    if (!decoded.byteLength || Buffer.from(decoded).toString('base64') !== audio.data) {
      throw new InvalidTranscriptionInputError(
        'Transcription base64 must be canonical and decode to nonempty audio',
      );
    }
    if (decoded.byteLength > MAX_INLINE_TRANSCRIPTION_BYTES) {
      throw new InvalidTranscriptionInputError(
        'Inline transcription audio must not exceed 25 MiB; chunk it or use a supported provider-file source',
      );
    }
    normalizedAudio = { type: 'base64', data: audio.data, mediaType: audio.mediaType };
  } else if (audio.type === 'provider-file') {
    if (!nonEmptyString(audio.provider) || !nonEmptyString(audio.reference)) {
      throw new InvalidTranscriptionInputError(
        'A provider-file transcription source requires provider and reference',
      );
    }
    if (audio.mediaType !== undefined && !nonEmptyString(audio.mediaType)) {
      throw new InvalidTranscriptionInputError(
        'Transcription provider-file mediaType must be nonempty when supplied',
      );
    }
    normalizedAudio = {
      type: 'provider-file',
      provider: audio.provider,
      reference: audio.reference,
      ...(audio.mediaType !== undefined ? { mediaType: audio.mediaType } : {}),
    };
  } else {
    throw new InvalidTranscriptionInputError(
      'Transcription audio must be bytes, base64, or provider-file',
    );
  }

  if (request.language !== undefined && !nonEmptyString(request.language)) {
    throw new InvalidTranscriptionInputError(
      'Transcription language must be nonempty when supplied',
    );
  }
  if (
    request.timestamps !== undefined &&
    request.timestamps !== 'segment' &&
    request.timestamps !== 'word'
  ) {
    throw new InvalidTranscriptionInputError('Transcription timestamps must be segment or word');
  }
  if (request.diarization !== undefined && typeof request.diarization !== 'boolean') {
    throw new InvalidTranscriptionInputError('Transcription diarization must be boolean');
  }
  if (request.providerOptions !== undefined) {
    if (
      !request.providerOptions ||
      Array.isArray(request.providerOptions) ||
      typeof request.providerOptions !== 'object'
    ) {
      throw new InvalidTranscriptionInputError('Transcription providerOptions must be an object');
    }
    for (const key of Object.keys(request.providerOptions)) {
      if (RESERVED_PROVIDER_OPTION_KEYS.has(key)) {
        throw new InvalidTranscriptionInputError(
          'Transcription providerOptions cannot override reserved operation fields',
        );
      }
    }
  }
  return {
    model: request.model,
    audio: normalizedAudio,
    ...(request.language !== undefined ? { language: request.language } : {}),
    ...(request.timestamps !== undefined ? { timestamps: request.timestamps } : {}),
    ...(request.diarization !== undefined ? { diarization: request.diarization } : {}),
    ...(request.providerOptions !== undefined
      ? { providerOptions: cloneValue(request.providerOptions) }
      : {}),
  };
}

/** @internal Clone an adapter result before exposing it to application code. */
export function cloneTranscript(transcript: Transcript): Transcript {
  if (!transcript || typeof transcript !== 'object' || typeof transcript.text !== 'string') {
    throw new InvalidTranscriptionInputError(
      'Transcription provider returned an invalid transcript',
    );
  }
  const cloned = cloneValue(transcript);
  const accounting = normalizeTranscriptionAccounting(cloned.usage, cloned.pricingStatus);
  return {
    text: cloned.text,
    ...(cloned.detectedLanguages ? { detectedLanguages: cloned.detectedLanguages } : {}),
    ...(cloned.segments ? { segments: cloned.segments } : {}),
    ...(cloned.words ? { words: cloned.words } : {}),
    ...(accounting.usage ? { usage: accounting.usage } : {}),
    ...(accounting.pricingStatus ? { pricingStatus: accounting.pricingStatus } : {}),
    ...(cloned.providerMetadata ? { providerMetadata: cloned.providerMetadata } : {}),
  };
}

/** @internal Keep provider accounting authoritative but safe for events and
 * aggregation. `zero` is an explicit known $0; `priced` without a usable cost
 * is downgraded to unpriced rather than inventing a charge. */
export function normalizeTranscriptionAccounting(
  usageValue: unknown,
  pricingValue: unknown,
): NormalizedTranscriptionAccounting {
  const value =
    usageValue && typeof usageValue === 'object'
      ? (usageValue as Record<string, unknown>)
      : undefined;
  const number = (key: string): number | undefined => {
    const candidate = value?.[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : undefined;
  };
  const audioSeconds = number('audioSeconds');
  const inputTokens = number('inputTokens');
  const outputTokens = number('outputTokens');
  const totalTokens = number('totalTokens');
  const reportedCost = number('cost');
  const usage =
    value &&
    (audioSeconds !== undefined ||
      inputTokens !== undefined ||
      outputTokens !== undefined ||
      totalTokens !== undefined ||
      reportedCost !== undefined)
      ? {
          ...(audioSeconds !== undefined ? { audioSeconds } : {}),
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(totalTokens !== undefined ? { totalTokens } : {}),
          ...(reportedCost !== undefined ? { cost: reportedCost } : {}),
        }
      : undefined;
  const hasWork =
    (audioSeconds ?? 0) > 0 ||
    (inputTokens ?? 0) > 0 ||
    (outputTokens ?? 0) > 0 ||
    (totalTokens ?? 0) > 0;
  const requested =
    pricingValue === 'priced' || pricingValue === 'unpriced' || pricingValue === 'zero'
      ? pricingValue
      : undefined;
  const cost =
    requested === 'zero' && (reportedCost === undefined || reportedCost === 0) ? 0 : reportedCost;
  const pricingStatus =
    requested === 'zero' && (reportedCost === undefined || reportedCost === 0)
      ? 'zero'
      : requested === 'priced' && cost !== undefined
        ? 'priced'
        : requested === 'unpriced' && cost === undefined
          ? 'unpriced'
          : cost !== undefined
            ? 'priced'
            : hasWork || requested === 'unpriced' || requested === 'priced'
              ? 'unpriced'
              : undefined;
  const tokens =
    inputTokens !== undefined || outputTokens !== undefined
      ? {
          ...(inputTokens !== undefined ? { input: inputTokens } : {}),
          ...(outputTokens !== undefined ? { output: outputTokens } : {}),
        }
      : undefined;
  return {
    ...(usage ? { usage } : {}),
    ...(pricingStatus ? { pricingStatus } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(tokens ? { tokens } : {}),
    hasWork,
  };
}
