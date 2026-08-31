import { InvalidTranscriptionInputError, UnsupportedTranscriptionInputError } from '../errors.js';
import { assertSafeProviderBaseUrl } from '../http-transport.js';
import type { ApiKeySource } from './types.js';
import { resolveApiKey } from './types.js';
import { buildProviderError } from './errors.js';
import { RateLimiter, type RateLimitConfig } from './rate-limiter.js';
import { fetchWithRetry } from './retry.js';
import type { Transcript } from '../transcription.js';
import type {
  TranscriptionCapabilities,
  TranscriptionProvider,
  TranscriptionProviderRequest,
  TranscriptionProviderResult,
} from './transcription-types.js';
import {
  GEMINI_TRANSCRIPTION_MODEL,
  assertOnlyProviderOptions,
  attachTranscriptionFailureMetadata,
  inlineAudioBytes,
  requireExactTranscriptionModel,
  safeProviderMessage,
  transcriptUsage,
} from './transcription-utils.js';

const CLEANUP_TIMEOUT_MS = 3_000;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const GEMINI_AUDIO_MEDIA_TYPES = new Set([
  'audio/wav',
  'audio/mp3',
  'audio/aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/mpeg',
  'audio/m4a',
  'audio/l16',
  'audio/opus',
  'audio/alaw',
  'audio/mulaw',
  'audio/webm',
]);

type GeminiFile = {
  name?: unknown;
  uri?: unknown;
  state?: unknown;
  mimeType?: unknown;
  mime_type?: unknown;
};

function abortError(): DOMException {
  return new DOMException('The transcription operation was aborted', 'AbortError');
}
function audioMime(audio: TranscriptionProviderRequest['audio']): string {
  if (!audio.mediaType)
    throw new UnsupportedTranscriptionInputError({
      provider: 'gemini-transcription',
      model: GEMINI_TRANSCRIPTION_MODEL,
      feature: 'provider-file audio mediaType',
    });
  return audio.mediaType;
}
function assertGeminiAudioMime(mediaType: string | undefined): string {
  if (!mediaType || !GEMINI_AUDIO_MEDIA_TYPES.has(mediaType)) {
    throw new UnsupportedTranscriptionInputError({
      provider: 'gemini-transcription',
      model: GEMINI_TRANSCRIPTION_MODEL,
      feature: 'this audio media type',
    });
  }
  return mediaType;
}
function secondsOffset(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      done(abortError());
    };
    function done(error?: unknown) {
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class GeminiTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'gemini-transcription';
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
    this.apiKeySource =
      options.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(
      /\/$/,
      '',
    );
    assertSafeProviderBaseUrl(
      this.baseUrl,
      'Gemini transcription provider',
      options.dangerouslyAllowInsecureHttp,
    );
    this.governor = options.rateLimit ? new RateLimiter(options.rateLimit) : undefined;
  }

  capabilities(model: string): TranscriptionCapabilities | undefined {
    return model === GEMINI_TRANSCRIPTION_MODEL
      ? { sources: ['bytes', 'base64', 'provider-file'], timestamps: ['word'], diarization: true }
      : undefined;
  }

  async transcribe(request: TranscriptionProviderRequest): Promise<TranscriptionProviderResult> {
    requireExactTranscriptionModel(this.name, request.model, GEMINI_TRANSCRIPTION_MODEL);
    const options = assertOnlyProviderOptions(request, this.name, request.model, [
      'mode',
      'customVocabulary',
    ]);
    const mode = options.mode ?? 'verbatim';
    if (mode !== 'smart' && mode !== 'verbatim')
      throw new InvalidTranscriptionInputError(
        'Gemini transcription mode must be smart or verbatim',
      );
    if (
      options.customVocabulary !== undefined &&
      (!Array.isArray(options.customVocabulary) ||
        options.customVocabulary.length > 1000 ||
        options.customVocabulary.some(
          (value) => typeof value !== 'string' || !value.trim() || value.length > 256,
        ))
    )
      throw new InvalidTranscriptionInputError(
        'Gemini transcription customVocabulary must contain at most 1000 nonempty strings up to 256 characters',
      );
    if (mode === 'smart' && (request.timestamps || request.diarization))
      throw new InvalidTranscriptionInputError(
        'Gemini smart transcription does not support timestamps or diarization',
      );
    if (request.timestamps && options.customVocabulary !== undefined)
      throw new InvalidTranscriptionInputError(
        'Gemini transcription customVocabulary cannot be combined with timestamps',
      );
    if (request.timestamps && request.timestamps !== 'word')
      throw new UnsupportedTranscriptionInputError({
        provider: this.name,
        model: request.model,
        feature: 'segment timestamps',
      });
    if (request.diarization && request.timestamps !== 'word')
      throw new InvalidTranscriptionInputError('Gemini diarization requires word timestamps');
    if (request.audio.type === 'provider-file') {
      if (
        request.audio.provider !== this.name ||
        typeof request.audio.reference !== 'string' ||
        !request.audio.reference.trim()
      ) {
        throw new UnsupportedTranscriptionInputError({
          provider: this.name,
          model: request.model,
          feature: 'a matching nonempty provider-file reference',
        });
      }
      assertGeminiAudioMime(request.audio.mediaType);
    } else {
      assertGeminiAudioMime(request.audio.mediaType);
    }
    const key = await this.resolveKey();
    if (request.audio.type === 'provider-file')
      return this.transcribeReference(request, key, mode, options);
    return this.transcribeUpload(request, key, mode, options);
  }

  private async transcribeReference(
    request: TranscriptionProviderRequest,
    key: string,
    mode: 'smart' | 'verbatim',
    options: Record<string, unknown>,
  ): Promise<TranscriptionProviderResult> {
    const audio = request.audio;
    if (audio.type !== 'provider-file' || audio.provider !== this.name)
      throw new UnsupportedTranscriptionInputError({
        provider: this.name,
        model: request.model,
        feature: 'a provider-file owned by another provider',
      });
    const mimeType = audioMime(audio);
    const transcript = await this.infer(request, key, audio.reference, mimeType, mode, options);
    return { transcript, cleanupStatus: 'not_required' };
  }

  private async transcribeUpload(
    request: TranscriptionProviderRequest,
    key: string,
    mode: 'smart' | 'verbatim',
    options: Record<string, unknown>,
  ): Promise<TranscriptionProviderResult> {
    let created = false;
    let fileName: string | undefined;
    let primaryError: unknown;
    let transcript: Transcript | undefined;
    let cleanupStatus: TranscriptionProviderResult['cleanupStatus'] = 'not_required';
    try {
      const uploaded = await this.upload(request, key);
      created = true;
      fileName = uploaded.name;
      const ready = await this.waitForReady(
        this.fileFromJson(uploaded.file, uploaded.mimeType),
        key,
        request.signal,
      );
      transcript = await this.infer(request, key, ready.uri, ready.mimeType, mode, options);
    } catch (error) {
      primaryError = error;
    } finally {
      if (created && fileName) cleanupStatus = await this.cleanup(fileName, key);
    }
    if (primaryError) {
      throw attachTranscriptionFailureMetadata(
        primaryError instanceof Error ? primaryError : new Error('Gemini transcription failed'),
        { cleanupStatus },
      );
    }
    if (!transcript)
      throw new InvalidTranscriptionInputError(
        'Gemini transcription response did not contain text',
      );
    return { transcript, cleanupStatus };
  }

  /** A finalization response with a name creates a caller-owned cleanup obligation
   * even when its URI/state is malformed. `transcribeUpload` stores the name before
   * strictly parsing the rest of the file representation. */
  private async upload(
    request: TranscriptionProviderRequest,
    key: string,
  ): Promise<{ name: string; file: GeminiFile; mimeType: string }> {
    if (request.audio.type === 'provider-file')
      throw new UnsupportedTranscriptionInputError({
        provider: this.name,
        model: request.model,
        feature: 'provider-file upload',
      });
    const mimeType = assertGeminiAudioMime(request.audio.mediaType);
    // This is local decoding only; no media leaves the process until the upload
    // URL has passed the same-origin and transport checks below.
    const bytes = inlineAudioBytes(request.audio);
    const start = await fetchWithRetry(
      `${this.baseUrl.replace(/\/v1beta$/, '')}/upload/v1beta/files`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': key,
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(bytes.byteLength),
          'X-Goog-Upload-Header-Content-Type': mimeType,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { display_name: 'axl-transcription' } }),
        signal: request.signal,
      },
      { governor: this.governor, provider: this.name, maxRetries: 0 },
    );
    if (!start.ok) {
      const body = await start.text();
      throw buildProviderError({
        provider: this.name,
        status: start.status,
        headers: start.headers,
        message: safeProviderMessage('Gemini', start.status, body),
        body,
      });
    }
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!uploadUrl)
      throw new InvalidTranscriptionInputError(
        'Gemini transcription upload did not return an upload URL',
      );
    let parsedUploadUrl: URL;
    try {
      parsedUploadUrl = new URL(uploadUrl);
    } catch {
      throw new InvalidTranscriptionInputError(
        'Gemini transcription upload returned an invalid upload URL',
      );
    }
    const baseOrigin = new URL(this.baseUrl).origin;
    if (
      parsedUploadUrl.username ||
      parsedUploadUrl.password ||
      parsedUploadUrl.origin !== baseOrigin
    ) {
      throw new InvalidTranscriptionInputError(
        'Gemini transcription upload returned an untrusted upload URL',
      );
    }
    assertSafeProviderBaseUrl(
      parsedUploadUrl.toString(),
      'Gemini transcription upload endpoint',
      new URL(this.baseUrl).protocol === 'http:',
    );
    const finalize = await fetchWithRetry(
      parsedUploadUrl.toString(),
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Command': 'upload, finalize',
          'X-Goog-Upload-Offset': '0',
          'Content-Length': String(bytes.byteLength),
        },
        body: bytes,
        signal: request.signal,
      },
      { governor: this.governor, provider: this.name, maxRetries: 0 },
    );
    if (!finalize.ok) {
      const body = await finalize.text();
      throw buildProviderError({
        provider: this.name,
        status: finalize.status,
        headers: finalize.headers,
        message: safeProviderMessage('Gemini', finalize.status, body),
        body,
      });
    }
    const payload = (await finalize.json()) as { file?: GeminiFile };
    const file = payload.file;
    if (!file || typeof file.name !== 'string') {
      throw new InvalidTranscriptionInputError(
        'Gemini transcription upload did not return a file name',
      );
    }
    return { name: file.name, file, mimeType };
  }

  private async waitForReady(
    file: { name: string; uri: string; mimeType: string; state?: string },
    key: string,
    signal?: AbortSignal,
  ): Promise<{ name: string; uri: string; mimeType: string }> {
    let current = file;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    // Missing state is not treated as ready: inference before the provider has
    // confirmed ACTIVE is a silent-loss risk. The created file still cleans up.
    if (!current.state) {
      throw new InvalidTranscriptionInputError(
        'Gemini transcription file readiness state is missing',
      );
    }
    while (current.state && current.state !== 'ACTIVE') {
      if (current.state === 'FAILED')
        throw new InvalidTranscriptionInputError('Gemini transcription file processing failed');
      if (Date.now() >= deadline)
        throw new InvalidTranscriptionInputError('Gemini transcription file readiness timed out');
      await sleep(Math.min(READY_POLL_MS, deadline - Date.now()), signal);
      const res = await fetchWithRetry(
        `${this.baseUrl}/${current.name}`,
        { method: 'GET', headers: { 'x-goog-api-key': key }, signal },
        { governor: this.governor, provider: this.name, maxRetries: 0 },
      );
      if (!res.ok) {
        const body = await res.text();
        throw buildProviderError({
          provider: this.name,
          status: res.status,
          headers: res.headers,
          message: safeProviderMessage('Gemini', res.status, body),
          body,
        });
      }
      current = this.fileFromJson((await res.json()) as GeminiFile, current.mimeType);
    }
    return current;
  }

  private async infer(
    request: TranscriptionProviderRequest,
    key: string,
    uri: string,
    mimeType: string,
    mode: 'smart' | 'verbatim',
    options: Record<string, unknown>,
  ): Promise<Transcript> {
    const transcriptionConfig: Record<string, unknown> = {
      mode:
        mode === 'smart'
          ? 'smart'
          : {
              type: 'verbatim',
              ...(request.timestamps ? { timestamp_granularities: ['word'] } : {}),
              ...(request.diarization ? { diarization_mode: 'speaker' } : {}),
            },
      ...(request.language ? { language_codes: [request.language] } : {}),
      ...(options.customVocabulary ? { custom_vocabulary: options.customVocabulary } : {}),
    };
    const body = {
      model: request.model,
      input: [{ type: 'audio', uri, mime_type: mimeType }],
      store: false,
      generation_config: { transcription_config: transcriptionConfig },
    };
    const res = await fetchWithRetry(
      `${this.baseUrl}/interactions`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
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
        message: safeProviderMessage('Gemini', res.status, errorBody),
        body: errorBody,
      });
    }
    const json = (await res.json()) as Record<string, unknown>;
    if (json.status !== 'completed') {
      throw new InvalidTranscriptionInputError('Gemini transcription interaction did not complete');
    }
    const words: Array<{ text: string; start: number; end: number; speaker?: string }> = [];
    let text = '';
    let hasModelOutputText = false;
    if (Array.isArray(json.steps)) {
      for (const step of json.steps) {
        if (!step || typeof step !== 'object') continue;
        const modelOutput = step as Record<string, unknown>;
        if (modelOutput.type !== 'model_output' || !Array.isArray(modelOutput.content)) continue;
        for (const block of modelOutput.content) {
          if (!block || typeof block !== 'object') continue;
          const content = block as Record<string, unknown>;
          if (content.type !== 'text' || typeof content.text !== 'string') continue;
          hasModelOutputText = true;
          text += content.text;
          if (!Array.isArray(content.annotations)) continue;
          for (const raw of content.annotations) {
            if (!raw || typeof raw !== 'object') continue;
            const annotation = raw as Record<string, unknown>;
            if (annotation.type !== 'word_info') continue;
            if (typeof annotation.text !== 'string') continue;
            const start = secondsOffset(annotation.start_offset);
            const end = secondsOffset(annotation.end_offset);
            if (start === undefined || end === undefined || end < start) continue;
            words.push({
              text: annotation.text,
              start,
              end,
              ...(typeof annotation.speaker === 'string' ? { speaker: annotation.speaker } : {}),
            });
          }
        }
      }
    }
    if (!hasModelOutputText)
      throw new InvalidTranscriptionInputError(
        'Gemini transcription response did not contain model output text',
      );
    return { text, ...(words.length ? { words } : {}), ...transcriptUsage(json.usage) };
  }

  private fileFromJson(
    value: { file?: GeminiFile } | GeminiFile,
    fallbackMimeType: string,
  ): { name: string; uri: string; mimeType: string; state?: string } {
    const file = 'file' in value && value.file ? value.file : (value as GeminiFile);
    if (typeof file.name !== 'string' || typeof file.uri !== 'string')
      throw new InvalidTranscriptionInputError(
        'Gemini transcription upload did not return a file reference',
      );
    return {
      name: file.name,
      uri: file.uri,
      mimeType:
        typeof file.mimeType === 'string'
          ? file.mimeType
          : typeof file.mime_type === 'string'
            ? file.mime_type
            : fallbackMimeType,
      ...(typeof file.state === 'string' ? { state: file.state } : {}),
    };
  }

  private async cleanup(
    fileName: string,
    key: string,
  ): Promise<NonNullable<TranscriptionProviderResult['cleanupStatus']>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLEANUP_TIMEOUT_MS);
    try {
      const res = await fetchWithRetry(
        `${this.baseUrl}/${fileName}`,
        { method: 'DELETE', headers: { 'x-goog-api-key': key }, signal: controller.signal },
        { governor: this.governor, provider: this.name, maxRetries: 0 },
      );
      return res.ok ? 'deleted' : 'failed';
    } catch {
      return controller.signal.aborted ? 'timed_out' : 'failed';
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveKey(): Promise<string> {
    const key = await resolveApiKey(this.apiKeySource);
    if (!key)
      throw new Error('Google API key is required. Set GOOGLE_API_KEY or pass apiKey in options.');
    return key;
  }
}
