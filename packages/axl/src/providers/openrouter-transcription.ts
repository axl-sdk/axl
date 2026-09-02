import { InvalidTranscriptionInputError, UnsupportedTranscriptionInputError } from '../errors.js';
import { assertSafeProviderBaseUrl } from '../http-transport.js';
import type { ApiKeySource } from './types.js';
import { resolveApiKey } from './types.js';
import { buildProviderError } from './errors.js';
import { RateLimiter, type RateLimitConfig } from './rate-limiter.js';
import { fetchWithRetry } from './retry.js';
import type {
  TranscriptionCapabilities,
  TranscriptionProvider,
  TranscriptionProviderRequest,
  TranscriptionProviderResult,
} from './transcription-types.js';
import {
  OPENROUTER_TRANSCRIPTION_MODEL,
  assertOnlyProviderOptions,
  inlineAudioBytes,
  requireExactTranscriptionModel,
  requireNoProviderFile,
  safeProviderMessage,
  transcriptUsage,
} from './transcription-utils.js';

const FORMAT_BY_MIME: Record<string, string> = {
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

export class OpenRouterTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'openrouter-transcription';
  private readonly baseUrl: string;
  private readonly apiKeySource: ApiKeySource;
  private readonly governor?: RateLimiter;

  constructor(
    options: {
      apiKey?: ApiKeySource;
      baseUrl?: string;
      dangerouslyAllowInsecureHttp?: boolean;
      rateLimit?: RateLimitConfig;
    } = {},
  ) {
    this.apiKeySource = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
    this.baseUrl = (
      options.baseUrl ??
      process.env.OPENROUTER_BASE_URL ??
      'https://openrouter.ai/api/v1'
    ).replace(/\/$/, '');
    assertSafeProviderBaseUrl(
      this.baseUrl,
      'OpenRouter transcription provider',
      options.dangerouslyAllowInsecureHttp,
    );
    this.governor = options.rateLimit ? new RateLimiter(options.rateLimit) : undefined;
  }

  capabilities(model: string): TranscriptionCapabilities | undefined {
    return model === OPENROUTER_TRANSCRIPTION_MODEL ? { sources: ['bytes', 'base64'] } : undefined;
  }

  async transcribe(request: TranscriptionProviderRequest): Promise<TranscriptionProviderResult> {
    requireExactTranscriptionModel(this.name, request.model, OPENROUTER_TRANSCRIPTION_MODEL);
    requireNoProviderFile(request.audio, this.name, request.model);
    if (request.audio.type === 'provider-file')
      throw new UnsupportedTranscriptionInputError({
        provider: this.name,
        model: request.model,
        feature: 'provider-file transcription input',
      });
    const options = assertOnlyProviderOptions(request, this.name, request.model, [
      'temperature',
      'provider',
    ]);
    if (
      options.temperature !== undefined &&
      (typeof options.temperature !== 'number' ||
        !Number.isFinite(options.temperature) ||
        options.temperature < 0 ||
        options.temperature > 1)
    )
      throw new InvalidTranscriptionInputError(
        'OpenRouter transcription temperature must be a number between 0 and 1',
      );
    if (
      options.provider !== undefined &&
      (!options.provider || Array.isArray(options.provider) || typeof options.provider !== 'object')
    )
      throw new InvalidTranscriptionInputError(
        'OpenRouter transcription provider routing must be an object',
      );
    const format = FORMAT_BY_MIME[request.audio.mediaType];
    if (!format)
      throw new UnsupportedTranscriptionInputError({
        provider: this.name,
        model: request.model,
        feature: 'this audio media type',
      });
    const bytes = inlineAudioBytes(request.audio);
    const body = {
      model: request.model,
      input_audio: { data: Buffer.from(bytes).toString('base64'), format },
      ...(request.language ? { language: request.language } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
    };
    const key = await this.resolveKey();
    const res = await fetchWithRetry(
      `${this.baseUrl}/audio/transcriptions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.signal,
      },
      { governor: this.governor, provider: this.name },
    );
    if (!res.ok) {
      const errorBody = await res.text();
      throw buildProviderError({
        provider: this.name,
        status: res.status,
        headers: res.headers,
        message: safeProviderMessage('OpenRouter', res.status, errorBody),
        body: errorBody,
      });
    }
    const json = (await res.json()) as { text?: unknown; usage?: unknown };
    if (typeof json.text !== 'string')
      throw new InvalidTranscriptionInputError(
        'OpenRouter transcription response did not contain text',
      );
    return {
      transcript: { text: json.text, ...transcriptUsage(json.usage) },
      cleanupStatus: 'not_required',
    };
  }
  private async resolveKey(): Promise<string> {
    const key = await resolveApiKey(this.apiKeySource);
    if (!key)
      throw new Error(
        'OpenRouter API key is required. Set OPENROUTER_API_KEY or pass apiKey in options.',
      );
    return key;
  }
}
