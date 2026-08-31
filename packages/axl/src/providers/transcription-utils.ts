import { InvalidTranscriptionInputError, UnsupportedTranscriptionInputError } from '../errors.js';
import type { RecordedAudioSource, Transcript } from '../transcription.js';
import type { TranscriptionProviderRequest } from './transcription-types.js';

export const OPENAI_TRANSCRIPTION_MODEL = 'gpt-transcribe';
export const GEMINI_TRANSCRIPTION_MODEL = 'gemini-3.5-transcribe';
export const OPENROUTER_TRANSCRIPTION_MODEL = 'openai/whisper-1';

export function requireExactTranscriptionModel(
  provider: string,
  model: string,
  expected: string,
): void {
  if (model !== expected) {
    throw new UnsupportedTranscriptionInputError({
      provider,
      model,
      feature: 'this transcription model',
    });
  }
}

export function inlineAudioBytes(audio: RecordedAudioSource): Uint8Array {
  if (audio.type === 'bytes') return new Uint8Array(audio.data);
  if (audio.type === 'base64') return Uint8Array.from(Buffer.from(audio.data, 'base64'));
  throw new UnsupportedTranscriptionInputError({
    provider: audio.provider,
    model: '',
    feature: 'provider-file transcription input',
  });
}

export function requireNoProviderFile(
  audio: RecordedAudioSource,
  provider: string,
  model: string,
): void {
  if (audio.type === 'provider-file') {
    throw new UnsupportedTranscriptionInputError({
      provider,
      model,
      feature: 'provider-file transcription input',
    });
  }
}

export function assertOnlyProviderOptions(
  request: TranscriptionProviderRequest,
  provider: string,
  model: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const options = request.providerOptions ?? {};
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      throw new InvalidTranscriptionInputError(
        `Unsupported ${provider} transcription provider option for model '${model}'`,
      );
    }
  }
  return options;
}

export function transcriptUsage(value: unknown): Pick<Transcript, 'usage' | 'pricingStatus'> {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const number = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const candidate = source[key];
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0)
        return candidate;
    }
    return undefined;
  };
  const inputTokens = number('total_input_tokens', 'input_tokens', 'prompt_tokens', 'inputTokens');
  const outputTokens = number(
    'total_output_tokens',
    'output_tokens',
    'completion_tokens',
    'outputTokens',
  );
  const totalTokens = number('total_tokens', 'totalTokens');
  const audioSeconds = number('seconds', 'audio_seconds', 'audioSeconds', 'duration_seconds');
  const cost = number('cost');
  const usage =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    totalTokens !== undefined ||
    audioSeconds !== undefined ||
    cost !== undefined
      ? {
          ...(audioSeconds !== undefined ? { audioSeconds } : {}),
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(totalTokens !== undefined ? { totalTokens } : {}),
          ...(cost !== undefined ? { cost } : {}),
        }
      : undefined;
  const hasWork =
    (audioSeconds ?? 0) > 0 ||
    (inputTokens ?? 0) > 0 ||
    (outputTokens ?? 0) > 0 ||
    (totalTokens ?? 0) > 0;
  return {
    ...(usage ? { usage } : {}),
    ...(cost !== undefined
      ? { pricingStatus: 'priced' as const }
      : hasWork
        ? { pricingStatus: 'unpriced' as const }
        : {}),
  };
}

export function safeProviderMessage(provider: string, status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === 'string')
      return `${provider} transcription API error (${status}): ${message}`;
  } catch {
    // Preserve the body on the ProviderError, but do not require a JSON shape.
  }
  return `${provider} transcription API error (${status})`;
}

export function attachTranscriptionFailureMetadata<T extends Error>(
  error: T,
  metadata: {
    usage?: Transcript['usage'];
    pricingStatus?: Transcript['pricingStatus'];
    cleanupStatus?: 'not_required' | 'deleted' | 'failed' | 'timed_out';
  },
): T {
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) Object.defineProperty(error, key, { enumerable: true, value });
  }
  return error;
}
