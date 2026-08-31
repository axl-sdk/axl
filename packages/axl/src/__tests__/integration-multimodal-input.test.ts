import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { UnsupportedModelInputError } from '../errors.js';
import { assertSafeProviderBaseUrl } from '../http-transport.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { ProviderRegistry } from '../providers/registry.js';
import { TranscriptionProviderRegistry } from '../providers/transcription-registry.js';
import type { AxlEvent } from '../types.js';
import { tool } from '../tool.js';

// ---------------------------------------------------------------------------
// Multimodal live lighthouse. This file is intentionally double-gated: a key
// alone never spends. Run one named L-row at a time with the direct Vitest
// command documented in docs/testing.md.
// The current allowlists are exercised exactly; an available key is not hidden
// behind a fallback model.
// ---------------------------------------------------------------------------

function liveEnabled(env: Record<string, string | undefined>): boolean {
  return env.AXL_MULTIMODAL_LIVE === '1' && env.AXL_DISABLE_LIVE_INTEGRATION !== '1';
}

function transcriptionLiveEnabled(env: Record<string, string | undefined>): boolean {
  return env.AXL_TRANSCRIPTION_LIVE === '1' && env.AXL_DISABLE_LIVE_INTEGRATION !== '1';
}

const RUN = liveEnabled(process.env);
const PNG_BYTES = readFileSync(
  new URL('../../../../docs/assets/studio-playground.png', import.meta.url),
);
const PNG_BASE64 = PNG_BYTES.toString('base64');
const PNG_BASE64_SENTINEL = PNG_BASE64.slice(0, 128);
const RECORDED_CALL_BASE64 = readFileSync(
  new URL('./fixtures/recorded-call.mp3.b64', import.meta.url),
  'utf8',
).replace(/\s/g, '');
const RECORDED_CALL_BYTES = Uint8Array.from(Buffer.from(RECORDED_CALL_BASE64, 'base64'));
const RECORDED_CALL_SENTINEL = RECORDED_CALL_BASE64.slice(0, 128);
const HTTPS_IMAGE =
  'https://raw.githubusercontent.com/axl-sdk/axl/main/docs/assets/studio-playground.png';
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_FILE_READY_TIMEOUT_MS = 30_000;
const GEMINI_FILE_READY_POLL_MS = 250;

async function uploadTemporaryAnthropicImage(): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');

  const body = new FormData();
  body.set('file', new Blob([Uint8Array.from(PNG_BYTES)], { type: 'image/png' }), 'lighthouse.png');
  body.set('expires_in_seconds', '3600');
  const response = await fetch('https://api.anthropic.com/v1/files', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'files-api-2025-04-14',
    },
    body,
  });
  if (!response.ok) throw new Error(`Anthropic temporary file upload failed (${response.status})`);
  const result = (await response.json()) as { id?: unknown };
  if (typeof result.id !== 'string' || result.id.length === 0) {
    throw new Error('Anthropic temporary file upload returned no file ID');
  }
  return result.id;
}

async function deleteTemporaryAnthropicImage(fileId: string): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');
  const response = await fetch(`https://api.anthropic.com/v1/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'files-api-2025-04-14',
    },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Anthropic temporary file deletion failed (${response.status})`);
  }
}

function input(
  source:
    | { type: 'bytes'; data: Uint8Array; mediaType: string }
    | { type: 'base64'; data: string; mediaType: string }
    | { type: 'url'; url: string; mediaType?: string }
    | { type: 'provider-file'; provider: string; reference: string },
) {
  return [
    { type: 'text' as const, text: 'Inspect this image and answer concisely.' },
    { type: 'image' as const, label: 'lighthouse fixture', source },
  ] as const;
}

function liveContext() {
  const events: AxlEvent[] = [];
  const context = new WorkflowContext({
    input: 'lighthouse',
    executionId: `multimodal-${randomUUID()}`,
    config: {},
    providerRegistry: new ProviderRegistry(),
    transcriptionProviderRegistry: new TranscriptionProviderRegistry(),
    onTrace: (event) => events.push(event),
  });
  return { context, events };
}

function assertHonestTerminal(events: AxlEvent[]) {
  const end = events.find((event) => event.type === 'ask_end');
  expect(end).toBeDefined();
  if (end?.type === 'ask_end') {
    expect(end.outcome.ok).toBe(true);
    expect(Number.isFinite(end.cost)).toBe(true);
    // Rich input may intentionally be unpriced. A priced zero is never treated
    // as evidence that a provider image request was free.
    expect(end.cost > 0 || end.unpriced === true).toBe(true);
  }
}

function assertNoBase64InEvents(events: AxlEvent[]) {
  expect(JSON.stringify(events)).not.toContain(PNG_BASE64_SENTINEL);
}

function assertTranscriptionTerminal(
  events: AxlEvent[],
  expected: { readonly source: 'bytes' | 'provider-file'; readonly cleanup?: string },
) {
  const starts = events.filter((event) => event.type === 'transcription_start');
  const ends = events.filter((event) => event.type === 'transcription_end');
  expect(starts).toHaveLength(1);
  expect(ends).toHaveLength(1);
  const start = starts[0];
  const end = ends[0];
  if (start?.type === 'transcription_start' && end?.type === 'transcription_end') {
    expect(end.transcriptionId).toBe(start.transcriptionId);
    expect(start.data.audio.source).toBe(expected.source);
    expect(end.data.status).toBe('completed');
    if (expected.cleanup) expect(end.data.cleanupStatus).toBe(expected.cleanup);
    const usage = end.data.usage;
    expect(
      end.cost !== undefined || end.data.pricingStatus === 'unpriced' || usage === undefined,
    ).toBe(true);
  }
}

function completedTranscriptionEnd(events: AxlEvent[]) {
  const end = events.find((event) => event.type === 'transcription_end');
  expect(end).toBeDefined();
  if (!end || end.type !== 'transcription_end')
    throw new Error('Missing transcription terminal event');
  expect(end.data.status).toBe('completed');
  return end;
}

function assertNoRecordedAudioInEvents(events: AxlEvent[], ...identifiers: string[]) {
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain(RECORDED_CALL_SENTINEL);
  for (const identifier of identifiers) expect(serialized).not.toContain(identifier);
}

type InteractionObservation = {
  readonly model?: string;
  readonly store?: boolean;
  readonly inputType?: string;
  readonly inputMimeType?: string;
  readonly transcriptionConfig?: {
    readonly mode?: 'smart' | 'verbatim';
    readonly timestampGranularities?: readonly string[];
    readonly diarizationMode?: string;
    readonly languageCodes?: readonly string[];
    readonly customVocabulary?: readonly string[];
  };
};
type FetchObservation = {
  readonly method: string;
  readonly path: string;
  readonly uploadCommand?: string;
  readonly interaction?: InteractionObservation;
};

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function interactionObservation(body: unknown): InteractionObservation | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const request = body as Record<string, unknown>;
  const input = Array.isArray(request.input) ? request.input[0] : undefined;
  const audio = input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined;
  const generation =
    request.generation_config && typeof request.generation_config === 'object'
      ? (request.generation_config as Record<string, unknown>)
      : undefined;
  const config =
    generation?.transcription_config && typeof generation.transcription_config === 'object'
      ? (generation.transcription_config as Record<string, unknown>)
      : undefined;
  const mode = config?.mode;
  const verbatim = mode && typeof mode === 'object' ? (mode as Record<string, unknown>) : undefined;
  return {
    ...(typeof request.model === 'string' ? { model: request.model } : {}),
    ...(typeof request.store === 'boolean' ? { store: request.store } : {}),
    ...(typeof audio?.type === 'string' ? { inputType: audio.type } : {}),
    ...(typeof audio?.mime_type === 'string' ? { inputMimeType: audio.mime_type } : {}),
    ...(config
      ? {
          transcriptionConfig: {
            ...(mode === 'smart' || verbatim?.type === 'verbatim'
              ? { mode: mode === 'smart' ? 'smart' : 'verbatim' }
              : {}),
            ...(stringArray(verbatim?.timestamp_granularities)
              ? { timestampGranularities: stringArray(verbatim?.timestamp_granularities) }
              : {}),
            ...(typeof verbatim?.diarization_mode === 'string'
              ? { diarizationMode: verbatim.diarization_mode }
              : {}),
            ...(stringArray(config.language_codes)
              ? { languageCodes: stringArray(config.language_codes) }
              : {}),
            ...(stringArray(config.custom_vocabulary)
              ? { customVocabulary: stringArray(config.custom_vocabulary) }
              : {}),
          },
        }
      : {}),
  };
}

async function observeFetch<T>(fn: (requests: FetchObservation[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const requests: FetchObservation[] = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers ?? request?.headers);
    const body = init?.body;
    let interaction: InteractionObservation | undefined;
    if (url.pathname === '/v1beta/interactions' && typeof body === 'string') {
      try {
        interaction = interactionObservation(JSON.parse(body));
      } catch {
        interaction = undefined;
      }
    }
    requests.push({
      method: init?.method ?? request?.method ?? 'GET',
      path: url.pathname,
      ...(headers.get('x-goog-upload-command')
        ? { uploadCommand: headers.get('x-goog-upload-command')! }
        : {}),
      ...(interaction ? { interaction } : {}),
    });
    return await original(input, init);
  };
  try {
    return await fn(requests);
  } finally {
    globalThis.fetch = original;
  }
}

type TemporaryGeminiFile = {
  readonly name: string;
  readonly uri: string;
  readonly state: string;
  readonly mimeType: string;
};

function geminiTemporaryFileName(value: unknown): string {
  if (!value || typeof value !== 'object')
    throw new Error('Gemini temporary audio upload returned no file name');
  const name = (value as Record<string, unknown>).name;
  if (typeof name !== 'string' || !/^files\/[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error('Gemini temporary audio upload returned an invalid file name');
  }
  return name;
}

function assertNoRedirect(response: Response, operation: string): void {
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${operation} redirected and was rejected`);
  }
}

function geminiTemporaryFile(value: unknown): TemporaryGeminiFile {
  if (!value || typeof value !== 'object')
    throw new Error('Gemini temporary audio returned no file');
  const file = value as Record<string, unknown>;
  const mimeType = file.mimeType ?? file.mime_type;
  if (
    typeof file.name !== 'string' ||
    !/^files\/[A-Za-z0-9_-]+$/.test(file.name) ||
    typeof file.uri !== 'string' ||
    !file.uri.startsWith('https://') ||
    typeof file.state !== 'string' ||
    typeof mimeType !== 'string'
  ) {
    throw new Error('Gemini temporary audio upload returned an invalid file reference');
  }
  return { name: file.name, uri: file.uri, state: file.state, mimeType };
}

function assertTrustedGeminiUploadUrl(uploadUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(uploadUrl);
  } catch {
    throw new Error('Gemini temporary audio upload returned an invalid upload URL');
  }
  const base = new URL(GEMINI_API_BASE_URL);
  if (parsed.username || parsed.password || parsed.origin !== base.origin) {
    throw new Error('Gemini temporary audio upload returned an untrusted upload URL');
  }
  assertSafeProviderBaseUrl(parsed.toString(), 'Gemini live-test upload endpoint');
  return parsed;
}

async function uploadTemporaryGeminiAudio(): Promise<TemporaryGeminiFile> {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY is required');
  assertSafeProviderBaseUrl(GEMINI_API_BASE_URL, 'Gemini live-test Files API');
  const start = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(RECORDED_CALL_BYTES.byteLength),
      'X-Goog-Upload-Header-Content-Type': 'audio/mpeg',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'axl-live-transcription-fixture' } }),
    redirect: 'manual',
  });
  assertNoRedirect(start, 'Gemini temporary audio upload start');
  if (!start.ok) throw new Error(`Gemini temporary audio upload start failed (${start.status})`);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini temporary audio upload returned no upload URL');
  const trustedUploadUrl = assertTrustedGeminiUploadUrl(uploadUrl);
  const finalized = await fetch(trustedUploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Length': String(RECORDED_CALL_BYTES.byteLength),
    },
    body: RECORDED_CALL_BYTES,
    redirect: 'manual',
  });
  assertNoRedirect(finalized, 'Gemini temporary audio upload finalize');
  if (!finalized.ok)
    throw new Error(`Gemini temporary audio upload finalize failed (${finalized.status})`);
  const body = (await finalized.json()) as { file?: unknown };
  const name = geminiTemporaryFileName(body.file);
  try {
    return geminiTemporaryFile(body.file);
  } catch (error) {
    await deleteTemporaryGeminiAudio(name).catch(() => undefined);
    throw error;
  }
}

async function waitForTemporaryGeminiAudio(
  file: TemporaryGeminiFile,
): Promise<TemporaryGeminiFile> {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY is required');
  let current = file;
  const deadline = Date.now() + GEMINI_FILE_READY_TIMEOUT_MS;
  while (current.state !== 'ACTIVE') {
    if (current.state === 'FAILED') throw new Error('Gemini temporary audio processing failed');
    if (Date.now() >= deadline) throw new Error('Gemini temporary audio readiness timed out');
    await new Promise((resolve) => setTimeout(resolve, GEMINI_FILE_READY_POLL_MS));
    const response = await fetch(`${GEMINI_API_BASE_URL}/${current.name}`, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
      redirect: 'manual',
    });
    assertNoRedirect(response, 'Gemini temporary audio readiness read');
    if (!response.ok) {
      throw new Error(`Gemini temporary audio readiness read failed (${response.status})`);
    }
    current = geminiTemporaryFile(await response.json());
  }
  return current;
}

async function deleteTemporaryGeminiAudio(fileName: string): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY is required');
  const response = await fetch(`${GEMINI_API_BASE_URL}/${fileName}`, {
    method: 'DELETE',
    headers: { 'x-goog-api-key': apiKey },
    redirect: 'manual',
  });
  assertNoRedirect(response, 'Gemini temporary audio deletion');
  if (!response.ok && response.status !== 404) {
    throw new Error(`Gemini temporary audio deletion failed (${response.status})`);
  }
}

describe.skipIf(!RUN || !process.env.OPENAI_API_KEY)(
  'multimodal live [L1]: OpenAI Responses gpt-4o-mini',
  () => {
    it('[L1] byte image + text returns text with honest terminal accounting', async () => {
      const { context, events } = liveContext();
      const a = agent({ model: 'openai-responses:gpt-4o-mini', system: 'Reply with one word.' });
      const result = await context.ask(
        a,
        input({ type: 'bytes', data: PNG_BYTES, mediaType: 'image/png' }),
        { maxTokens: 32, temperature: 0 },
      );
      expect(result.length).toBeGreaterThan(0);
      assertHonestTerminal(events);
      assertNoBase64InEvents(events);
    });
  },
);

describe.skipIf(!RUN || !process.env.OPENAI_API_KEY)(
  'multimodal live [L2]: OpenAI Responses gpt-4o-mini',
  () => {
    it('[L2] HTTPS image + schema streams normal observable events', async () => {
      const { context, events } = liveContext();
      void context.events; // opt into the provider streaming path before ask
      const a = agent({ model: 'openai-responses:gpt-4o-mini', system: 'Return only JSON.' });
      const result = await context.ask(a, input({ type: 'url', url: HTTPS_IMAGE }), {
        maxTokens: 64,
        temperature: 0,
        schema: z.object({ visible: z.boolean() }),
      });
      context.disposeEvents();
      expect(typeof result.visible).toBe('boolean');
      expect(
        events.some((event) => event.type === 'token' || event.type === 'partial_object'),
      ).toBe(true);
      assertHonestTerminal(events);
    });
  },
);

describe.skipIf(!RUN || !process.env.ANTHROPIC_API_KEY)(
  'multimodal live [L11]: Anthropic claude-sonnet-4-5',
  () => {
    it('[L11] forwards an HTTPS URL as native image input without host retrieval', async () => {
      const { context, events } = liveContext();
      const a = agent({ model: 'anthropic:claude-sonnet-4-5', system: 'Reply with one word.' });
      const result = await context.ask(a, input({ type: 'url', url: HTTPS_IMAGE }), {
        maxTokens: 32,
        temperature: 0,
      });
      expect(result.length).toBeGreaterThan(0);
      assertHonestTerminal(events);
    });
  },
);

describe.skipIf(!RUN || !process.env.GOOGLE_API_KEY)(
  'multimodal live [L4]: Gemini Interactions gemini-3.7-flash',
  () => {
    it('[L4] byte image + schema uses the rich Gemini transport', async () => {
      const { context, events } = liveContext();
      const a = agent({ model: 'google:gemini-3.7-flash', system: 'Return only JSON.' });
      const result = await context.ask(
        a,
        input({ type: 'bytes', data: PNG_BYTES, mediaType: 'image/png' }),
        {
          maxTokens: 256,
          temperature: 0,
          effort: 'none',
          schema: z.object({ visible: z.boolean() }),
        },
      );
      expect(typeof result.visible).toBe('boolean');
      assertHonestTerminal(events);
      assertNoBase64InEvents(events);
    });
  },
);

describe.skipIf(!RUN || !process.env.GOOGLE_API_KEY)(
  'multimodal live [L12]: Gemini Interactions gemini-3.7-flash',
  () => {
    it('[L12] forwards an HTTPS image URL through stateless Interactions', async () => {
      const { context, events } = liveContext();
      const a = agent({ model: 'google:gemini-3.7-flash', system: 'Reply with one word.' });
      const result = await context.ask(
        a,
        input({ type: 'url', url: HTTPS_IMAGE, mediaType: 'image/png' }),
        {
          maxTokens: 128,
          temperature: 0,
          effort: 'none',
        },
      );
      expect(result.length).toBeGreaterThan(0);
      assertHonestTerminal(events);
    });
  },
);

describe.skipIf(!RUN || !process.env.OPENROUTER_API_KEY)(
  'multimodal live [L5] (non-blocking): OpenRouter openai/gpt-4o-mini',
  () => {
    it('[L5] maps a base64 image to image_url and preserves provider-reported cost honesty', async () => {
      const { context, events } = liveContext();
      const a = agent({ model: 'openrouter:openai/gpt-4o-mini', system: 'Reply with one word.' });
      const result = await context.ask(
        a,
        input({ type: 'base64', data: PNG_BASE64, mediaType: 'image/png' }),
        { maxTokens: 32, temperature: 0 },
      );
      expect(result.length).toBeGreaterThan(0);
      assertHonestTerminal(events);
      assertNoBase64InEvents(events);
    });
  },
);

describe.skipIf(
  !RUN ||
    !process.env.ANTHROPIC_API_KEY ||
    (!process.env.ANTHROPIC_IMAGE_FILE_ID && process.env.AXL_ANTHROPIC_TEMP_FILE !== '1'),
)('multimodal live [L3]: Anthropic provider-file continuation', () => {
  it('[L3] retains an explicitly supplied Anthropic file reference through one tool continuation', async () => {
    const temporary = !process.env.ANTHROPIC_IMAGE_FILE_ID;
    const fileId = process.env.ANTHROPIC_IMAGE_FILE_ID ?? (await uploadTemporaryAnthropicImage());
    try {
      const { context, events } = liveContext();
      const confirm = tool({
        name: 'confirm_image',
        description: 'Confirm that the image was inspected.',
        input: z.object({}),
        handler: () => ({ confirmed: true }),
      });
      const a = agent({
        model: 'anthropic:claude-sonnet-4-5',
        system: 'Call confirm_image, then reply with one word.',
        tools: [confirm],
        // One model turn must call the tool; the second must produce the final
        // answer. This is the hard request cap for the provider-file probe.
        maxTurns: 2,
      });
      const result = await context.ask(
        a,
        input({ type: 'provider-file', provider: 'anthropic', reference: fileId }),
        { maxTokens: 64, temperature: 0 },
      );
      expect(result.length).toBeGreaterThan(0);
      expect(events.filter((event) => event.type === 'agent_call_start')).toHaveLength(2);
      assertHonestTerminal(events);
    } finally {
      if (temporary) await deleteTemporaryAnthropicImage(fileId);
    }
  });
});

// ---------------------------------------------------------------------------
// Completed-file transcription live evidence. This is a separate gate from
// image input: keys and AXL_MULTIMODAL_LIVE never run these paid rows.
// ---------------------------------------------------------------------------

const TRANSCRIPTION_RUN = transcriptionLiveEnabled(process.env);

describe.skipIf(!TRANSCRIPTION_RUN || !process.env.OPENAI_API_KEY)(
  'transcription live [L7]: OpenAI gpt-transcribe',
  () => {
    it('[L7] transcribes fixture bytes without an agent call or raw-audio event leakage', async () => {
      await observeFetch(async (requests) => {
        const { context, events } = liveContext();
        const transcript = await context.transcribe({
          model: 'openai-transcription:gpt-transcribe',
          audio: { type: 'bytes', data: RECORDED_CALL_BYTES, mediaType: 'audio/mpeg' },
        });
        expect(transcript.text.trim().length).toBeGreaterThan(0);
        expect(requests).toEqual([{ method: 'POST', path: '/v1/audio/transcriptions' }]);
        expect(
          events.some((event) => event.type === 'ask_start' || event.type === 'agent_call_start'),
        ).toBe(false);
        assertTranscriptionTerminal(events, { source: 'bytes', cleanup: 'not_required' });
        assertNoRecordedAudioInEvents(events);
      });
    });
  },
);

describe.skipIf(!TRANSCRIPTION_RUN || (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY))(
  'transcription live [L8]: Gemini Interactions gemini-3.5-transcribe',
  () => {
    it('[L8] uploads bytes, waits if needed, uses stateless Interactions, and deletes', async () => {
      await observeFetch(async (requests) => {
        const { context, events } = liveContext();
        const transcript = await context.transcribe({
          model: 'gemini-transcription:gemini-3.5-transcribe',
          audio: { type: 'bytes', data: RECORDED_CALL_BYTES, mediaType: 'audio/mpeg' },
          language: 'en',
          timestamps: 'word',
          diarization: true,
          providerOptions: { mode: 'verbatim' },
        });
        expect(transcript.text.trim().length).toBeGreaterThan(0);
        expect(transcript.words?.length).toBeGreaterThan(0);
        expect(
          transcript.words?.every(
            (word) =>
              Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start,
          ),
        ).toBe(true);
        expect(transcript.words?.some((word) => typeof word.speaker === 'string')).toBe(true);
        expect(
          requests.filter(
            (request) =>
              request.method === 'POST' &&
              request.path === '/upload/v1beta/files' &&
              request.uploadCommand === 'start',
          ),
        ).toHaveLength(1);
        expect(
          requests.filter((request) => request.uploadCommand === 'upload, finalize'),
        ).toHaveLength(1);
        expect(requests.filter((request) => request.path === '/v1beta/interactions')).toEqual([
          {
            method: 'POST',
            path: '/v1beta/interactions',
            interaction: {
              model: 'gemini-3.5-transcribe',
              store: false,
              inputType: 'audio',
              inputMimeType: 'audio/mpeg',
              transcriptionConfig: {
                mode: 'verbatim',
                timestampGranularities: ['word'],
                diarizationMode: 'speaker',
                languageCodes: ['en'],
              },
            },
          },
        ]);
        expect(
          requests.filter(
            (request) => request.method === 'DELETE' && request.path.startsWith('/v1beta/files/'),
          ),
        ).toHaveLength(1);
        assertTranscriptionTerminal(events, { source: 'bytes', cleanup: 'deleted' });
        assertNoRecordedAudioInEvents(events);
      });
    });
  },
);

describe.skipIf(!TRANSCRIPTION_RUN || (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY))(
  'transcription live [L8V]: Gemini custom vocabulary',
  () => {
    it('[L8V] maps a bounded custom vocabulary without timestamp composition', async () => {
      await observeFetch(async (requests) => {
        const { context, events } = liveContext();
        const transcript = await context.transcribe({
          model: 'gemini-transcription:gemini-3.5-transcribe',
          audio: { type: 'bytes', data: RECORDED_CALL_BYTES, mediaType: 'audio/mpeg' },
          language: 'en',
          providerOptions: { mode: 'verbatim', customVocabulary: ['birch', 'canoe'] },
        });
        expect(transcript.text.trim().length).toBeGreaterThan(0);
        expect(requests.filter((request) => request.path === '/v1beta/interactions')).toEqual([
          {
            method: 'POST',
            path: '/v1beta/interactions',
            interaction: {
              model: 'gemini-3.5-transcribe',
              store: false,
              inputType: 'audio',
              inputMimeType: 'audio/mpeg',
              transcriptionConfig: {
                mode: 'verbatim',
                languageCodes: ['en'],
                customVocabulary: ['birch', 'canoe'],
              },
            },
          },
        ]);
        assertTranscriptionTerminal(events, { source: 'bytes', cleanup: 'deleted' });
        assertNoRecordedAudioInEvents(events);
      });
    });
  },
);

describe.skipIf(!TRANSCRIPTION_RUN || (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY))(
  'transcription live [L9]: Gemini provider-file gemini-3.5-transcribe',
  () => {
    it('[L9] supplies a test-owned temporary Files URI without host fetching and deletes it', async () => {
      await observeFetch(async (requests) => {
        const uploaded = await uploadTemporaryGeminiAudio();
        try {
          const temporary = await waitForTemporaryGeminiAudio(uploaded);
          expect(temporary.mimeType).toBe('audio/mpeg');
          const { context, events } = liveContext();
          const beforeTranscribe = requests.length;
          const transcript = await context.transcribe({
            model: 'gemini-transcription:gemini-3.5-transcribe',
            audio: {
              type: 'provider-file',
              provider: 'gemini-transcription',
              reference: temporary.uri,
              mediaType: 'audio/mpeg',
            },
          });
          expect(transcript.text.trim().length).toBeGreaterThan(0);
          expect(requests.slice(beforeTranscribe)).toEqual([
            {
              method: 'POST',
              path: '/v1beta/interactions',
              interaction: {
                model: 'gemini-3.5-transcribe',
                store: false,
                inputType: 'audio',
                inputMimeType: 'audio/mpeg',
                transcriptionConfig: { mode: 'verbatim' },
              },
            },
          ]);
          assertTranscriptionTerminal(events, { source: 'provider-file', cleanup: 'not_required' });
          assertNoRecordedAudioInEvents(events, temporary.name, temporary.uri);
        } finally {
          await deleteTemporaryGeminiAudio(uploaded.name);
        }
        expect(
          requests.filter(
            (request) => request.method === 'DELETE' && request.path.startsWith('/v1beta/files/'),
          ),
        ).toHaveLength(1);
        expect(
          requests.filter(
            (request) =>
              request.method === 'POST' &&
              request.path === '/upload/v1beta/files' &&
              request.uploadCommand === 'start',
          ),
        ).toHaveLength(1);
        expect(
          requests.filter((request) => request.uploadCommand === 'upload, finalize'),
        ).toHaveLength(1);
      });
    });
  },
);

describe('transcription local [L10]: Anthropic unsupported preflight', () => {
  it('[L10] rejects Anthropic with no fetch before a transcription provider is resolved', async () => {
    await observeFetch(async (requests) => {
      const { context } = liveContext();
      await expect(
        context.transcribe({
          model: 'anthropic-transcription:claude-sonnet-4-5',
          audio: { type: 'bytes', data: RECORDED_CALL_BYTES, mediaType: 'audio/mpeg' },
        }),
      ).rejects.toMatchObject({
        name: 'UnsupportedTranscriptionInputError',
        code: 'UNSUPPORTED_TRANSCRIPTION_INPUT',
      });
      expect(requests).toHaveLength(0);
    });
  });
});

describe.skipIf(!TRANSCRIPTION_RUN || !process.env.OPENROUTER_API_KEY)(
  'transcription live [L17]: OpenRouter openai/whisper-1',
  () => {
    it('[L17] maps fixture bytes to the dedicated STT endpoint with honest accounting', async () => {
      await observeFetch(async (requests) => {
        const { context, events } = liveContext();
        const transcript = await context.transcribe({
          model: 'openrouter-transcription:openai/whisper-1',
          audio: { type: 'bytes', data: RECORDED_CALL_BYTES, mediaType: 'audio/mpeg' },
        });
        expect(transcript.text.trim().length).toBeGreaterThan(0);
        expect(requests).toEqual([{ method: 'POST', path: '/api/v1/audio/transcriptions' }]);
        expect(transcript.usage?.audioSeconds).toBeGreaterThan(0);
        expect(transcript.usage?.cost).toEqual(expect.any(Number));
        expect(Number.isFinite(transcript.usage?.cost)).toBe(true);
        expect(transcript.usage?.cost).toBeGreaterThanOrEqual(0);
        expect(transcript.pricingStatus).toBe('priced');
        assertTranscriptionTerminal(events, { source: 'bytes', cleanup: 'not_required' });
        const end = completedTranscriptionEnd(events);
        expect(end.data.usage).toEqual(transcript.usage);
        expect(end.data.pricingStatus).toBe(transcript.pricingStatus);
        expect(end.cost).toBe(transcript.usage?.cost);
        assertNoRecordedAudioInEvents(events);
      });
    });
  },
);

const RECIPE_RUN = TRANSCRIPTION_RUN && process.env.AXL_TRANSCRIPTION_RECIPE_LIVE === '1';

function recordedCallRecipe(model: string, analystModel: string) {
  return async () => {
    const { context, events } = liveContext();
    const transcript = await context.transcribe({
      model,
      audio: { type: 'bytes', data: RECORDED_CALL_BYTES, mediaType: 'audio/mpeg' },
    });
    const analyst = agent({
      model: analystModel,
      system:
        'Return only a JSON object with a concise summary and at least one concrete action item. Do not invent an empty action list.',
    });
    const analysisPrompt = `Transcript:\n${transcript.text}`;
    const summary = await context.ask(
      analyst,
      analystModel.startsWith('google:')
        ? ([{ type: 'text', text: analysisPrompt }] as const)
        : analysisPrompt,
      {
        maxTokens: analystModel.startsWith('google:') ? 256 : 160,
        temperature: 0,
        ...(analystModel.startsWith('google:') ? { effort: 'none' as const } : {}),
        schema: z.object({
          summary: z.string().trim().min(1),
          actionItems: z.array(z.string().trim().min(1)).min(1),
        }),
        ...(analystModel.startsWith('google:') ? { retries: 0 } : {}),
      },
    );
    expect(summary.summary.trim().length).toBeGreaterThan(0);
    expect(summary.actionItems.length).toBeGreaterThan(0);
    assertTranscriptionTerminal(events, {
      source: 'bytes',
      cleanup: model.startsWith('gemini-transcription:') ? 'deleted' : 'not_required',
    });
    expect(events.some((event) => event.type === 'ask_end')).toBe(true);
    assertNoRecordedAudioInEvents(events);
  };
}

describe.skipIf(!RECIPE_RUN || !process.env.OPENAI_API_KEY)(
  'recorded-call recipe [R7]: OpenAI transcription then text analysis',
  () =>
    it(
      '[R7] explicitly passes the transcript to a normal low-cost agent',
      recordedCallRecipe('openai-transcription:gpt-transcribe', 'openai-responses:gpt-4o-mini'),
    ),
);

describe.skipIf(!RECIPE_RUN || (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY))(
  'recorded-call recipe [R8]: Gemini transcription then text analysis',
  () =>
    it(
      '[R8] explicitly passes the transcript to a normal low-cost agent',
      recordedCallRecipe('gemini-transcription:gemini-3.5-transcribe', 'google:gemini-3.7-flash'),
    ),
);

describe.skipIf(!RECIPE_RUN || !process.env.OPENROUTER_API_KEY)(
  'recorded-call recipe [R17]: OpenRouter transcription then text analysis',
  () =>
    it(
      '[R17] explicitly passes the transcript to a normal low-cost agent',
      recordedCallRecipe(
        'openrouter-transcription:openai/whisper-1',
        'openrouter:openai/gpt-4o-mini',
      ),
    ),
);

describe('multimodal local L6: preflight', () => {
  it('[L6] rejects a known text-only Responses model before any dispatch', () => {
    const provider = new OpenAIResponsesProvider({ apiKey: 'not-used' });
    expect(() =>
      provider.validateInput({
        model: 'gpt-4.1-nano',
        input: input({ type: 'base64', data: PNG_BASE64, mediaType: 'image/png' }),
        history: [],
        stream: false,
        hasTools: false,
        responseMode: 'text',
      }),
    ).toThrow(UnsupportedModelInputError);
  });

  it('the absolute kill switch wins over an armed live flag', () => {
    expect(liveEnabled({ AXL_MULTIMODAL_LIVE: '1', AXL_DISABLE_LIVE_INTEGRATION: '1' })).toBe(
      false,
    );
  });

  it('the absolute kill switch also wins over transcription and recipe flags', () => {
    expect(
      transcriptionLiveEnabled({
        AXL_TRANSCRIPTION_LIVE: '1',
        AXL_DISABLE_LIVE_INTEGRATION: '1',
      }),
    ).toBe(false);
  });
});
