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
import { MAX_INLINE_TRANSCRIPTION_BYTES } from '../transcription.js';
import {
  OPENAI_TRANSCRIPTION_MODEL,
  assertOnlyProviderOptions,
  inlineAudioBytes,
  requireExactTranscriptionModel,
  requireNoProviderFile,
  safeProviderMessage,
  transcriptUsage,
} from './transcription-utils.js';

const OPENAI_FILE_EXTENSIONS: Record<string, string> = {
  'audio/flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mpga': 'mpga',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

export class OpenAITranscriptionProvider implements TranscriptionProvider {
  readonly name = 'openai-transcription';
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
    this.apiKeySource = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (
      options.baseUrl ??
      process.env.OPENAI_BASE_URL ??
      'https://api.openai.com/v1'
    ).replace(/\/$/, '');
    assertSafeProviderBaseUrl(
      this.baseUrl,
      'OpenAI transcription provider',
      options.dangerouslyAllowInsecureHttp,
    );
    this.governor = options.rateLimit ? new RateLimiter(options.rateLimit) : undefined;
  }

  capabilities(model: string): TranscriptionCapabilities | undefined {
    return model === OPENAI_TRANSCRIPTION_MODEL ? { sources: ['bytes', 'base64'] } : undefined;
  }

  async transcribe(request: TranscriptionProviderRequest): Promise<TranscriptionProviderResult> {
    requireExactTranscriptionModel(this.name, request.model, OPENAI_TRANSCRIPTION_MODEL);
    requireNoProviderFile(request.audio, this.name, request.model);
    if (request.audio.type === 'provider-file')
      throw new UnsupportedTranscriptionInputError({
        provider: this.name,
        model: request.model,
        feature: 'provider-file transcription input',
      });
    const options = assertOnlyProviderOptions(request, this.name, request.model, [
      'temperature',
      'prompt',
    ]);
    if (
      options.temperature !== undefined &&
      (typeof options.temperature !== 'number' ||
        !Number.isFinite(options.temperature) ||
        options.temperature < 0 ||
        options.temperature > 1)
    )
      throw new InvalidTranscriptionInputError(
        'OpenAI transcription temperature must be a number between 0 and 1',
      );
    if (options.prompt !== undefined && typeof options.prompt !== 'string')
      throw new InvalidTranscriptionInputError('OpenAI transcription prompt must be a string');
    const mediaType = request.audio.mediaType;
    const extension = OPENAI_FILE_EXTENSIONS[mediaType];
    if (!extension)
      throw new UnsupportedTranscriptionInputError({
        provider: this.name,
        model: request.model,
        feature: 'this audio media type',
      });
    const bytes = inlineAudioBytes(request.audio);
    if (bytes.byteLength > MAX_INLINE_TRANSCRIPTION_BYTES)
      throw new InvalidTranscriptionInputError('OpenAI transcription audio must not exceed 25 MiB');
    const form = new FormData();
    form.set('file', new Blob([Buffer.from(bytes)], { type: mediaType }), `audio.${extension}`);
    form.set('model', request.model);
    form.set('response_format', 'json');
    if (request.language) form.set('language', request.language);
    if (options.temperature !== undefined) form.set('temperature', String(options.temperature));
    if (options.prompt !== undefined) form.set('prompt', options.prompt);
    const key = await this.resolveKey();
    const res = await fetchWithRetry(
      `${this.baseUrl}/audio/transcriptions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: request.signal,
      },
      { governor: this.governor, provider: this.name },
    );
    if (!res.ok) {
      const body = await res.text();
      throw buildProviderError({
        provider: this.name,
        status: res.status,
        headers: res.headers,
        message: safeProviderMessage('OpenAI', res.status, body),
        body,
      });
    }
    const json = (await res.json()) as { text?: unknown; usage?: unknown };
    if (typeof json.text !== 'string')
      throw new InvalidTranscriptionInputError(
        'OpenAI transcription response did not contain text',
      );
    return {
      transcript: { text: json.text, ...transcriptUsage(json.usage) },
      cleanupStatus: 'not_required',
    };
  }

  private async resolveKey(): Promise<string> {
    const key = await resolveApiKey(this.apiKeySource);
    if (!key)
      throw new Error('OpenAI API key is required. Set OPENAI_API_KEY or pass apiKey in options.');
    return key;
  }
}
