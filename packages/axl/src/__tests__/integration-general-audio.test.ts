import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { UnsupportedModelInputError } from '../errors.js';
import { ProviderError } from '../providers/errors.js';
import type { InputContentPart } from '../input.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { OPENROUTER_PROFILE } from '../providers/profiles/openrouter.js';
import { ProviderRegistry } from '../providers/registry.js';
import { TranscriptionProviderRegistry } from '../providers/transcription-registry.js';
import type {
  Provider,
  ProviderInputValidationRequest,
  ProviderResponse,
  StreamChunk,
} from '../providers/types.js';
import { tool } from '../tool.js';
import type { AxlEvent, ChatMessage } from '../types.js';

// ---------------------------------------------------------------------------
// General audio input (Phase 4 / plan §7) live certification, rows GA1–GA8.
//
// SPEND NOTES — this file is intentionally DOUBLE-GATED: a provider key alone
// never spends. Every paid row needs BOTH `AXL_MULTIMODAL_LIVE=1` (the shared
// multimodal live switch) AND `AXL_GENERAL_AUDIO_LIVE=1` (this file's arming
// flag), plus that row's provider key. `AXL_DISABLE_LIVE_INTEGRATION=1` is the
// absolute kill switch and wins over both. GA5 and GA7 are local rows: they
// assert a fail-closed rejection with fetch forbidden, need no key, and always
// run.
//
// Budget per paid row: at most 2 model requests, `maxTokens` <= 200, audio
// fixtures <= ~10 s. Fixtures are the checked-in `recorded-call.mp3.b64`
// (speech, ~10 s) and an in-test generated ~3 s 16 kHz mono PCM WAV
// (non-speech rising tone then silence) — no new binary asset. GA2 is the
// priciest row (audio input is billed well above text on `gpt-audio-1.5`).
//
// Each paid row prints one compact `[GA<n>] …` evidence line (cost, unpriced,
// tokens, answer) for `docs/verification/`. Everything printed is passed
// through `redact()` first, so fixture base64 can never reach a log.
//
// Run ONE row at a time with its ID as the `-t` selector:
//
//   AXL_MULTIMODAL_LIVE=1 AXL_GENERAL_AUDIO_LIVE=1 \
//     pnpm --filter @axlsdk/axl exec vitest run \
//     --config vitest.integration.config.ts \
//     src/__tests__/integration-general-audio.test.ts -t '\[GA1\]'
//
// Row → selector → key:
//   [GA1]        google:      GOOGLE_API_KEY / GEMINI_API_KEY
//   [GA1-OR]     openrouter:  OPENROUTER_API_KEY   (E1 fallback lighthouse)
//   [GA2]        openai:      OPENAI_API_KEY       (+ AXL_GENERAL_AUDIO_OPENAI_TOOL_LIVE=1)
//   [GA2-text]   openai:      OPENAI_API_KEY
//   [GA3]        google:      GOOGLE_API_KEY / GEMINI_API_KEY
//   [GA4]        google:      GOOGLE_API_KEY / GEMINI_API_KEY
//   [GA4-openai] openai:      OPENAI_API_KEY       (optional second lane)
//   [GA5]        local        — no key, always runs
//   [GA6]        openrouter:  OPENROUTER_API_KEY
//   [GA6-tool]   openrouter:  OPENROUTER_API_KEY
//   [GA7]        local        — no key, always runs
//   [GA8]        google:      GOOGLE_API_KEY / GEMINI_API_KEY
//   [GA8-OR]     openrouter:  OPENROUTER_API_KEY
//
// Models are env-overridable representative defaults, never allowlists:
// `GEMINI_AUDIO_MODEL`, `OPENAI_AUDIO_MODEL`, `OPENROUTER_AUDIO_MODEL`.
// ---------------------------------------------------------------------------

function liveEnabled(env: Record<string, string | undefined>): boolean {
  return env.AXL_MULTIMODAL_LIVE === '1' && env.AXL_DISABLE_LIVE_INTEGRATION !== '1';
}

function generalAudioLiveEnabled(env: Record<string, string | undefined>): boolean {
  return liveEnabled(env) && env.AXL_GENERAL_AUDIO_LIVE === '1';
}

const RUN = generalAudioLiveEnabled(process.env);
const GOOGLE_KEY = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
const GEMINI_AUDIO_MODEL = process.env.GEMINI_AUDIO_MODEL ?? 'gemini-3.7-flash';
const OPENAI_AUDIO_MODEL = process.env.OPENAI_AUDIO_MODEL ?? 'gpt-audio-1.5';
const OPENROUTER_AUDIO_MODEL = process.env.OPENROUTER_AUDIO_MODEL ?? 'google/gemini-2.5-flash';

// ── Fixtures ────────────────────────────────────────────────────────────

/**
 * A ~3 s 16 kHz mono 16-bit PCM WAV: a rising tone for the first 1.5 s, then
 * silence. Generated rather than checked in — it is small, fully described by
 * this function, and keeps the repo free of another binary asset.
 *
 * The rising sweep is the point of GA1: a model that only transcribes speech
 * cannot answer "does the pitch change?", so a correct answer is evidence the
 * bytes were actually understood as audio rather than ignored.
 */
function generateToneWav(): Uint8Array {
  const sampleRate = 16_000;
  const toneSamples = sampleRate * 1.5;
  const silenceSamples = sampleRate * 1.5;
  const totalSamples = toneSamples + silenceSamples;
  const dataBytes = totalSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  // Canonical 44-byte RIFF/WAVE header for PCM (fmt chunk of 16 bytes).
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // chunk size = header remainder + data
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = rate * blockAlign
  view.setUint16(32, 2, true); // block align = channels * bytesPerSample
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  const startHz = 220;
  const endHz = 1200;
  const fadeSamples = 400; // ~25 ms, enough to avoid a click at each edge
  let phase = 0;
  for (let i = 0; i < totalSamples; i++) {
    let sample = 0;
    if (i < toneSamples) {
      const progress = i / toneSamples;
      phase += (2 * Math.PI * (startHz + (endHz - startHz) * progress)) / sampleRate;
      const fadeIn = Math.min(1, i / fadeSamples);
      const fadeOut = Math.min(1, (toneSamples - i) / fadeSamples);
      sample = Math.sin(phase) * 0.4 * fadeIn * fadeOut;
    }
    view.setInt16(44 + i * 2, Math.round(sample * 32_767), true);
  }
  return new Uint8Array(buffer);
}

const TONE_WAV_BYTES = generateToneWav();
const TONE_WAV_BASE64 = Buffer.from(TONE_WAV_BYTES).toString('base64');
/** Taken from inside the tone (not the header, not the all-zero silence tail),
 *  so the substring is genuinely distinctive rather than a run of `A`s. */
const TONE_SENTINEL = TONE_WAV_BASE64.slice(4096, 4224);

const RECORDED_CALL_BASE64 = readFileSync(
  new URL('./fixtures/recorded-call.mp3.b64', import.meta.url),
  'utf8',
).replace(/\s/g, '');
const RECORDED_CALL_SENTINEL = RECORDED_CALL_BASE64.slice(0, 128);

const FIXTURE_BASE64 = [TONE_WAV_BASE64, RECORDED_CALL_BASE64] as const;

const TONE_QUESTION = 'Describe this sound in one sentence. Does the pitch change?';
/** Text-only control for the streaming rows' event-type comparison. */
const CONTROL_QUESTION = 'In one short sentence, what is two plus two?';
const CALL_QUESTION = 'What is this call about?';

function toneInput(): readonly InputContentPart[] {
  return [
    { type: 'audio', source: { type: 'bytes', data: TONE_WAV_BYTES, mediaType: 'audio/wav' } },
    { type: 'text', text: TONE_QUESTION },
  ];
}

function toneBase64Input(): readonly InputContentPart[] {
  return [
    { type: 'audio', source: { type: 'base64', data: TONE_WAV_BASE64, mediaType: 'audio/wav' } },
    { type: 'text', text: TONE_QUESTION },
  ];
}

function callInput(text: string): readonly InputContentPart[] {
  return [
    {
      type: 'audio',
      source: { type: 'base64', data: RECORDED_CALL_BASE64, mediaType: 'audio/mpeg' },
    },
    { type: 'text', text },
  ];
}

/** The canned local tool the tool-continuation rows (GA2/GA3/GA6-tool) use. */
const lookupAccount = tool({
  name: 'lookup_account',
  description: 'Look up the account record for a person named in the recording.',
  input: z.object({ name: z.string().trim().min(1).max(120) }),
  handler: ({ name }) => `Account for ${name}: status active, plan pro, no open tickets.`,
});

// The speech fixture reads neutral sample sentences and names nobody, so the
// instruction supplies a fallback name: the row certifies the continuation
// transport, not the model's willingness to invent a caller.
// Gemini 3.x clamps 'none' to its minimum; 2.x models reject the mapped
// 'minimal' level, so the effort is overridable for cross-family probes.
const GEMINI_EFFORT = (process.env.GEMINI_AUDIO_EFFORT ?? 'none') as 'none' | 'low';

const TOOL_SYSTEM =
  'You must call lookup_account exactly once before answering. Use a name spoken in the recording; if no name is spoken, use the name "caller". Then answer in one short sentence.';

// ── Wire capture ────────────────────────────────────────────────────────

type CapturedCall = {
  method: string;
  path: string;
  rawRequest: string;
  requestBody: unknown;
  responseBody: unknown;
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Pass-through fetch capture. Unlike the multimodal precedent's `observeFetch`
 * (which records only method/path/model), the audio rows must assert on the
 * FULL request body — which audio object, at which content index, byte-identical
 * across a continuation — so the parsed body is retained. Response bodies are
 * captured for JSON responses only: `providerMetadata` is a projection of the
 * response, so a response body free of the fixture is proof the metadata is too,
 * and a streaming (SSE) body is left untouched so the adapter reads it first.
 *
 * Nothing captured here is ever logged raw; see `redact()`.
 */
async function observeWire<T>(fn: (calls: readonly CapturedCall[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: CapturedCall[] = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const rawRequest = typeof init?.body === 'string' ? init.body : '';
    const call: CapturedCall = {
      method: init?.method ?? request?.method ?? 'GET',
      path: url.pathname,
      rawRequest,
      requestBody: rawRequest ? parseJson(rawRequest) : undefined,
      responseBody: undefined,
    };
    calls.push(call);
    const response = await original(input, init);
    if ((response.headers.get('content-type') ?? '').includes('application/json')) {
      call.responseBody = parseJson(await response.clone().text());
    }
    return response;
  };
  try {
    return await fn(calls);
  } catch (error) {
    // Redacted wire dump so a failing paid row is diagnosable from its log
    // alone; `brief` strips fixture bytes and long base64 runs first.
    for (const [index, call] of calls.entries()) {
      console.info(
        `[wire ${index}] ${call.method} ${call.path}\n  request=${brief(call.requestBody, 1200)}\n  response=${brief(call.responseBody, 600)}`,
      );
    }
    throw error;
  } finally {
    globalThis.fetch = original;
  }
}

const MODEL_PATHS = ['/chat/completions', '/v1beta/interactions'];
// String-only Gemini asks (the streaming rows' text control) stay on
// `generateContent`; rich asks use Interactions.
const GEMINI_GENERATE_CONTENT = /:(stream)?generateContent$/i;

/** The model requests among the captured calls — the budgeted unit per row. */
function modelCalls(calls: readonly CapturedCall[]): readonly CapturedCall[] {
  return calls.filter(
    (call) =>
      MODEL_PATHS.some((path) => call.path.endsWith(path)) ||
      GEMINI_GENERATE_CONTENT.test(call.path),
  );
}

/** A fetch replacement that fails the test on any request at all. */
async function forbidFetch<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const attempted: string[] = [];
  globalThis.fetch = (input) => {
    attempted.push(String(input instanceof Request ? input.url : input));
    throw new Error('provider request issued for a locally-rejected audio input');
  };
  try {
    const value = await fn();
    expect(attempted).toEqual([]);
    return value;
  } finally {
    globalThis.fetch = original;
  }
}

// ── Body readers ────────────────────────────────────────────────────────

type WireContent = Array<Record<string, unknown>>;

/** The single array-content user turn of an OpenAI-compatible chat request. */
function compatibleUserContent(call: CapturedCall): WireContent {
  const body = call.requestBody as { messages?: Array<Record<string, unknown>> } | undefined;
  const rich = (body?.messages ?? []).filter(
    (message) => message.role === 'user' && Array.isArray(message.content),
  );
  expect(rich).toHaveLength(1);
  return rich[0].content as WireContent;
}

/** The content of the first `user_input` step of a Gemini Interactions request. */
function geminiUserContent(call: CapturedCall): WireContent {
  const body = call.requestBody as
    | { input?: Array<{ type?: string; content?: WireContent }> }
    | undefined;
  const step = (body?.input ?? []).find((entry) => entry.type === 'user_input');
  if (!step?.content) throw new Error(`no user_input step in request to ${call.path}`);
  return step.content;
}

// ── Assertions ──────────────────────────────────────────────────────────

type Terminal = { readonly cost: number; readonly unpriced: boolean };

/**
 * Rich input may legitimately be unpriced. A priced `0` is never accepted as
 * evidence that an audio request was free.
 */
function assertHonestTerminal(events: readonly AxlEvent[]): Terminal {
  const end = events.find((event) => event.type === 'ask_end');
  expect(end).toBeDefined();
  if (!end || end.type !== 'ask_end') throw new Error('missing ask_end');
  expect(end.outcome.ok).toBe(true);
  expect(Number.isFinite(end.cost)).toBe(true);
  expect(end.cost > 0 || end.unpriced === true).toBe(true);
  return { cost: end.cost, unpriced: end.unpriced === true };
}

/** No event or trace payload may carry the fixture bytes. */
function assertSentinelAbsentFromEvents(events: readonly AxlEvent[], sentinel: string): void {
  for (const event of events) {
    expect(JSON.stringify(event) ?? '').not.toContain(sentinel);
  }
}

/**
 * Replace every string that IS a fixture with a placeholder, so a surviving
 * sentinel occurrence is necessarily a stray echo (a provider that copied the
 * audio into a step, a reasoning blob, or `providerMetadata`) rather than the
 * legitimate audio part.
 */
function withoutFixtureAudio(value: unknown): unknown {
  if (typeof value === 'string') {
    return FIXTURE_BASE64.includes(value as (typeof FIXTURE_BASE64)[number])
      ? '<audio-bytes>'
      : value;
  }
  if (Array.isArray(value)) return value.map(withoutFixtureAudio);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        withoutFixtureAudio(entry),
      ]),
    );
  }
  return value;
}

/** True when the payload echoes the fixture somewhere other than the audio part. */
function echoesAudio(value: unknown, sentinel: string): boolean {
  return JSON.stringify(withoutFixtureAudio(value) ?? null).includes(sentinel);
}

/**
 * `providerMetadata` is derived from the provider response, so a response body
 * with no stray fixture echo cannot produce a metadata blob that carries one.
 */
function assertNoStrayAudioEcho(value: unknown, sentinel: string): void {
  expect(echoesAudio(value, sentinel)).toBe(false);
}

/** Streaming rows: only the ordinary lifecycle types, and nothing audio-shaped. */
/**
 * The audio ask must introduce no event type that an equivalent text-only
 * streaming ask on the same route does not already emit. Comparing against a
 * same-row control (rather than the canonical `AXL_EVENT_TYPES` list, which
 * would make the check a tautology) is what makes a new audio-specific event
 * observable.
 */
function assertNoNewEventTypes(
  audioEvents: readonly AxlEvent[],
  controlEvents: readonly AxlEvent[],
): void {
  const control = new Set(controlEvents.map((event) => event.type));
  console.info(
    `[events] audio=${[...new Set(audioEvents.map((event) => event.type))].join(',')} control=${[...control].join(',')}`,
  );
  expect(audioEvents.some((event) => event.type === 'token')).toBe(true);
  expect(controlEvents.some((event) => event.type === 'token')).toBe(true);
  const unexpected = [...new Set(audioEvents.map((event) => event.type))].filter(
    (type) => !control.has(type),
  );
  // A new audio-specific event type would be a public surface change that this
  // plan explicitly does not ship: audio rides the ordinary text path.
  expect(unexpected).toEqual([]);
}

// ── Evidence logging ────────────────────────────────────────────────────

/** Strip fixture bytes and any long base64-looking run before anything is logged. */
function redact(text: string): string {
  let out = text;
  for (const fixture of FIXTURE_BASE64) out = out.split(fixture).join('<audio-bytes>');
  return out.replace(/[A-Za-z0-9+/]{64,}={0,2}/g, '<base64>');
}

function brief(value: unknown, limit = 300): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const collapsed = redact(text).replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/** The provider-reported usage object, whatever the lane calls it. */
function rawUsage(call: CapturedCall | undefined): unknown {
  const body = call?.responseBody as Record<string, unknown> | undefined;
  return body?.usage ?? body?.usage_metadata ?? body?.usageMetadata;
}

/** OpenRouter reports a per-request `cost` inside `usage`. */
function reportedCost(call: CapturedCall | undefined): number | undefined {
  const usage = rawUsage(call) as { cost?: unknown } | undefined;
  return typeof usage?.cost === 'number' ? usage.cost : undefined;
}

function evidence(id: string, fields: Record<string, unknown>): void {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${brief(value)}`)
    .join(', ');
  console.info(`[${id}] ${rendered}`);
}

// ── Context ─────────────────────────────────────────────────────────────

function liveContext(
  registry: ProviderRegistry = new ProviderRegistry(),
  sessionHistory?: ChatMessage[],
) {
  const events: AxlEvent[] = [];
  const context = new WorkflowContext({
    input: 'general-audio',
    executionId: `general-audio-${randomUUID()}`,
    config: {},
    providerRegistry: registry,
    ...(sessionHistory ? { sessionHistory } : {}),
    transcriptionProviderRegistry: new TranscriptionProviderRegistry(),
    onTrace: (event) => events.push(event),
  });
  return { context, events };
}

// ---------------------------------------------------------------------------
// GA1 — non-speech understanding on the Gemini lighthouse.
// ---------------------------------------------------------------------------

describe.skipIf(!RUN || !GOOGLE_KEY)(
  `general audio live [GA1]: Gemini Interactions ${GEMINI_AUDIO_MODEL}`,
  () => {
    it('[GA1] answers a non-speech pitch question from inline WAV bytes without leaking them', async () => {
      await observeWire(async (calls) => {
        const { context, events } = liveContext();
        const listener = agent({
          model: `google:${GEMINI_AUDIO_MODEL}`,
          system: 'Answer in one short sentence.',
        });
        const result = await context.ask(listener, toneInput(), { maxTokens: 200, effort: 'none' });

        expect(result.trim().length).toBeGreaterThan(0);
        const model = modelCalls(calls);
        expect(model).toHaveLength(1);
        expect(geminiUserContent(model[0])[0]).toEqual({
          type: 'audio',
          data: TONE_WAV_BASE64,
          mime_type: 'audio/wav',
        });
        // Positive control: the bytes really are on the wire, so the "absent
        // from events" assertion below is discriminating rather than vacuous.
        expect(model[0].rawRequest).toContain(TONE_SENTINEL);
        assertSentinelAbsentFromEvents(events, TONE_SENTINEL);
        const terminal = assertHonestTerminal(events);

        evidence('GA1', {
          model: `google:${GEMINI_AUDIO_MODEL}`,
          cost: terminal.cost,
          unpriced: terminal.unpriced,
          tokens: rawUsage(model[0]),
          // Plan §10 open question L1: does Interactions echo the input audio
          // back into `steps[]` (and therefore into providerMetadata)?
          responseEchoesAudio: echoesAudio(model[0].responseBody, TONE_SENTINEL),
          answer: result,
        });
      });
    });
  },
);

// ---------------------------------------------------------------------------
// GA1-OR — the plan's E1 fallback lighthouse. Same scenario, OpenRouter route.
// ---------------------------------------------------------------------------

describe.skipIf(!RUN || !process.env.OPENROUTER_API_KEY)(
  `general audio live [GA1-OR]: OpenRouter ${OPENROUTER_AUDIO_MODEL}`,
  () => {
    it('[GA1-OR] answers the same non-speech pitch question through input_audio', async () => {
      await observeWire(async (calls) => {
        const { context, events } = liveContext();
        const listener = agent({
          model: `openrouter:${OPENROUTER_AUDIO_MODEL}`,
          system: 'Answer in one short sentence.',
        });
        const result = await context.ask(listener, toneBase64Input(), { maxTokens: 200 });

        expect(result.trim().length).toBeGreaterThan(0);
        const model = modelCalls(calls);
        expect(model).toHaveLength(1);
        expect(compatibleUserContent(model[0])[0]).toEqual({
          type: 'input_audio',
          input_audio: { data: TONE_WAV_BASE64, format: 'wav' },
        });
        expect(model[0].rawRequest).toContain(TONE_SENTINEL);
        assertSentinelAbsentFromEvents(events, TONE_SENTINEL);
        // providerMetadata is a projection of this response body.
        assertNoStrayAudioEcho(model[0].responseBody, TONE_SENTINEL);
        const terminal = assertHonestTerminal(events);
        const cost = reportedCost(model[0]);
        expect(cost === undefined || Number.isFinite(cost)).toBe(true);

        evidence('GA1-OR', {
          model: `openrouter:${OPENROUTER_AUDIO_MODEL}`,
          cost: terminal.cost,
          unpriced: terminal.unpriced,
          reportedUsageCost: cost ?? 'absent',
          tokens: rawUsage(model[0]),
          answer: result,
        });
      });
    });
  },
);

// ---------------------------------------------------------------------------
// GA2 / GA3 / GA6-tool — speech + one local tool, then a continuation. The
// audio object must be byte-identical, at the same content index, in both
// requests: the continuation is rebuilt from history, so a re-encode, a
// placeholder substitution, or a dropped part all fail here.
// ---------------------------------------------------------------------------

// 2026-09-08: gpt-audio-1.5 accepted the first turn (tool call returned, usage
// reported `prompt_tokens_details.audio_tokens`) but answered every
// continuation with HTTP 500 `model_error` "The model produced invalid
// content" — five attempts, including `parallel_tool_calls:false` and
// `modalities:['text']` variants. The wire shape matches the Chat Completions
// tool-continuation contract, so this is recorded as a provider-side failure:
// the row stays a certification gate, separately armed so the routine lane is
// not red on a composition Axl does not advertise.
const OPENAI_AUDIO_TOOL_RUN = RUN && process.env.AXL_GENERAL_AUDIO_OPENAI_TOOL_LIVE === '1';

describe.skipIf(!OPENAI_AUDIO_TOOL_RUN || !process.env.OPENAI_API_KEY)(
  `general audio live [GA2]: OpenAI Chat Completions ${OPENAI_AUDIO_MODEL}`,
  () => {
    it('[GA2] keeps the speech input_audio identical across a tool continuation', async () => {
      await observeWire(async (calls) => {
        const { context, events } = liveContext();
        const listener = agent({
          model: `openai:${OPENAI_AUDIO_MODEL}`,
          system: TOOL_SYSTEM,
          tools: [lookupAccount],
          maxTurns: 2,
        });
        const result = await context.ask(
          listener,
          callInput('Look up the account for the caller, then summarise the call.'),
          { maxTokens: 200 },
        );

        expect(result.trim().length).toBeGreaterThan(0);
        const model = modelCalls(calls);
        expect(model).toHaveLength(2);
        const first = compatibleUserContent(model[0]);
        const second = compatibleUserContent(model[1]);
        const expectedAudio = {
          type: 'input_audio',
          input_audio: { data: RECORDED_CALL_BASE64, format: 'mp3' },
        };
        expect(first[0]).toEqual(expectedAudio);
        expect(second[0]).toEqual(first[0]);
        expect(first.filter((part) => part.type === 'input_audio')).toHaveLength(1);
        expect(second.filter((part) => part.type === 'input_audio')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'tool_call_end')).toHaveLength(1);
        assertSentinelAbsentFromEvents(events, RECORDED_CALL_SENTINEL);
        // Nothing but the audio part itself may carry the fixture — including
        // whatever providerMetadata round-tripped into the continuation.
        assertNoStrayAudioEcho(model[1].requestBody, RECORDED_CALL_SENTINEL);
        assertNoStrayAudioEcho(model[0].responseBody, RECORDED_CALL_SENTINEL);
        const terminal = assertHonestTerminal(events);

        const usage = rawUsage(model[0]) as
          | { prompt_tokens_details?: { audio_tokens?: unknown } }
          | undefined;
        evidence('GA2', {
          model: `openai:${OPENAI_AUDIO_MODEL}`,
          cost: terminal.cost,
          unpriced: terminal.unpriced,
          tokens: usage,
          // Plan E2: does OpenAI break out audio prompt tokens?
          audioTokensPopulated: typeof usage?.prompt_tokens_details?.audio_tokens === 'number',
          answer: result,
        });
      });
    });
  },
);

describe.skipIf(!RUN || !GOOGLE_KEY)(
  `general audio live [GA9]: Gemini Interactions ${GEMINI_AUDIO_MODEL}`,
  () => {
    it('[GA9] re-sends an audio user turn as application history on a later ask', async () => {
      await observeWire(async (calls) => {
        const { context } = liveContext();
        const listener = agent({
          model: `google:${GEMINI_AUDIO_MODEL}`,
          system: 'Answer in one short sentence.',
        });
        const first = await context.ask(listener, callInput('What is this recording?'), {
          maxTokens: 400,
          effort: GEMINI_EFFORT,
        });
        const history = [
          { role: 'user' as const, content: callInput('What is this recording?') },
          { role: 'assistant' as const, content: first },
        ];
        // Session history is a context-construction input, not an ask
        // option: a later turn in the same application session carries the
        // earlier audio user turn in the context it is asked through.
        const { context: later } = liveContext(undefined, history);
        const second = await later.ask(listener, 'How many speakers were there?', {
          maxTokens: 400,
          effort: GEMINI_EFFORT,
        });
        const model = modelCalls(calls);
        expect(model).toHaveLength(2);
        // The history-borne audio part is re-sent verbatim, at index 0 of the
        // first user_input step, and the provider accepts it.
        expect(geminiUserContent(model[1])[0]).toEqual({
          type: 'audio',
          data: RECORDED_CALL_BASE64,
          mime_type: 'audio/mpeg',
        });
        expect(second.trim().length).toBeGreaterThan(0);
        evidence('GA9', { model: `google:${GEMINI_AUDIO_MODEL}`, first, second });
      });
    });
  },
);

describe.skipIf(!RUN || !GOOGLE_KEY)(
  `general audio live [GA3]: Gemini Interactions ${GEMINI_AUDIO_MODEL}`,
  () => {
    it('[GA3] keeps the speech audio part identical across a stateless tool continuation', async () => {
      await observeWire(async (calls) => {
        const { context, events } = liveContext();
        const listener = agent({
          model: `google:${GEMINI_AUDIO_MODEL}`,
          system: TOOL_SYSTEM,
          tools: [lookupAccount],
          maxTurns: 2,
        });
        const result = await context.ask(
          listener,
          callInput('Look up the account for the caller, then summarise the call.'),
          // Gemini 3.x cannot disable thinking and its thought tokens count
          // against max_output_tokens; 200 ended the interaction `incomplete`.
          { maxTokens: 800, effort: GEMINI_EFFORT },
        );

        expect(result.trim().length).toBeGreaterThan(0);
        const model = modelCalls(calls);
        expect(model).toHaveLength(2);
        const first = geminiUserContent(model[0]);
        const second = geminiUserContent(model[1]);
        const expectedAudio = {
          type: 'audio',
          data: RECORDED_CALL_BASE64,
          mime_type: 'audio/mpeg',
        };
        expect(first[0]).toEqual(expectedAudio);
        expect(second[0]).toEqual(first[0]);
        expect(first.filter((part) => part.type === 'audio')).toHaveLength(1);
        expect(second.filter((part) => part.type === 'audio')).toHaveLength(1);
        // Stateless: the continuation resends the turn instead of resuming one.
        for (const call of model) {
          expect(call.requestBody).not.toHaveProperty('previous_interaction_id');
          expect((call.requestBody as { store?: unknown }).store).toBe(false);
        }
        expect(events.filter((event) => event.type === 'tool_call_end')).toHaveLength(1);
        assertSentinelAbsentFromEvents(events, RECORDED_CALL_SENTINEL);
        assertNoStrayAudioEcho(model[1].requestBody, RECORDED_CALL_SENTINEL);
        const terminal = assertHonestTerminal(events);

        evidence('GA3', {
          model: `google:${GEMINI_AUDIO_MODEL}`,
          cost: terminal.cost,
          unpriced: terminal.unpriced,
          tokens: rawUsage(model[0]),
          responseEchoesAudio: echoesAudio(model[0].responseBody, RECORDED_CALL_SENTINEL),
          answer: result,
        });
      });
    });
  },
);

// ---------------------------------------------------------------------------
// GA4 — audio composed with structured output.
// ---------------------------------------------------------------------------

const CALL_SUMMARY_SCHEMA = z.object({
  summary: z.string().trim().min(1),
  speakerCount: z.number().int().min(1),
});

describe.skipIf(!RUN || !GOOGLE_KEY)(
  `general audio live [GA4]: Gemini structured audio ${GEMINI_AUDIO_MODEL}`,
  () => {
    it('[GA4] returns a schema-valid object from speech audio', async () => {
      await observeWire(async (calls) => {
        const { context, events } = liveContext();
        const listener = agent({
          model: `google:${GEMINI_AUDIO_MODEL}`,
          system: 'Return only the requested JSON object.',
        });
        const result = await context.ask(listener, callInput('Summarise this recording.'), {
          maxTokens: 200,
          effort: 'none',
          schema: CALL_SUMMARY_SCHEMA,
          // No schema retry: a retry would resend the audio and double the row's
          // budgeted request count.
          retries: 0,
        });

        expect(CALL_SUMMARY_SCHEMA.safeParse(result).success).toBe(true);
        const model = modelCalls(calls);
        expect(model).toHaveLength(1);
        expect(geminiUserContent(model[0])[0]).toEqual({
          type: 'audio',
          data: RECORDED_CALL_BASE64,
          mime_type: 'audio/mpeg',
        });
        assertSentinelAbsentFromEvents(events, RECORDED_CALL_SENTINEL);
        const terminal = assertHonestTerminal(events);

        evidence('GA4', {
          model: `google:${GEMINI_AUDIO_MODEL}`,
          cost: terminal.cost,
          unpriced: terminal.unpriced,
          tokens: rawUsage(model[0]),
          answer: result,
        });
      });
    });
  },
);

describe.skipIf(!RUN || !process.env.OPENAI_API_KEY)(
  `general audio live [GA2-text]: OpenAI Chat Completions ${OPENAI_AUDIO_MODEL}`,
  () => {
    // The single-turn composition openai: advertises. GA2 (tool continuation)
    // fails provider-side today, so this row is the passing evidence behind
    // the capability-table entry, not a subset of GA2.
    it('[GA2-text] answers a question about speech audio in one request', async () => {
      await observeWire(async (calls) => {
        const { context, events } = liveContext();
        const listener = agent({
          model: `openai:${OPENAI_AUDIO_MODEL}`,
          system: 'Answer in one short sentence.',
        });
        const result = await context.ask(listener, callInput(CALL_QUESTION), { maxTokens: 200 });

        expect(result.trim().length).toBeGreaterThan(0);
        const model = modelCalls(calls);
        expect(model).toHaveLength(1);
        expect(compatibleUserContent(model[0])[0]).toEqual({
          type: 'input_audio',
          input_audio: { data: RECORDED_CALL_BASE64, format: 'mp3' },
        });
        expect(model[0].rawRequest).toContain(RECORDED_CALL_SENTINEL);
        assertSentinelAbsentFromEvents(events, RECORDED_CALL_SENTINEL);
        assertNoStrayAudioEcho(model[0].responseBody, RECORDED_CALL_SENTINEL);
        const terminal = assertHonestTerminal(events);
        // Audio-bearing openai: calls are unpriced by design (no audio rates).
        expect(terminal.unpriced).toBe(true);
        evidence('GA2-text', {
          model: `openai:${OPENAI_AUDIO_MODEL}`,
          cost: terminal.cost,
          unpriced: terminal.unpriced,
          tokens: rawUsage(model[0]),
          answer: result,
        });
      });
    });
  },
);

describe.skipIf(!RUN || !process.env.OPENAI_API_KEY)(
  `general audio live [GA4-openai]: OpenAI structured audio ${OPENAI_AUDIO_MODEL}`,
  () => {
    // Optional second lane. Only a passing row lets `openai:` audio+structured
    // enter the advertised capability table (plan §3).
    it('[GA4-openai] surfaces the provider rejection of structured output with speech audio', async () => {
      await observeWire(async (calls) => {
        const { context, events } = liveContext();
        const listener = agent({
          model: `openai:${OPENAI_AUDIO_MODEL}`,
          system: 'Return only the requested JSON object.',
        });
        // 2026-09-08: gpt-audio-1.5 rejects both of Axl's structured modes —
        // `json_object` (default) and native `json_schema` — with HTTP 400
        // "'response_format' of type '…' is not supported with this model". The
        // row therefore certifies the *rejection*: a typed ProviderError, no
        // silent downgrade, no dropped audio. Audio+structured is not
        // advertised for `openai:`.
        const error = await context
          .ask(listener, callInput('Summarise this recording.'), {
            maxTokens: 200,
            schema: CALL_SUMMARY_SCHEMA,
            nativeStructuredOutput: true,
            retries: 0,
          })
          .then(
            () => undefined,
            (err: unknown) => err,
          );
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).status).toBe(400);
        expect((error as Error).message).toContain('response_format');
        expect((error as Error).message).not.toContain(RECORDED_CALL_SENTINEL);
        const model = modelCalls(calls);
        expect(model).toHaveLength(1);
        expect(compatibleUserContent(model[0])[0]).toEqual({
          type: 'input_audio',
          input_audio: { data: RECORDED_CALL_BASE64, format: 'mp3' },
        });
        assertSentinelAbsentFromEvents(events, RECORDED_CALL_SENTINEL);
        evidence('GA4-openai', {
          model: `openai:${OPENAI_AUDIO_MODEL}`,
          rejected: brief((error as Error).message),
        });
      });
    });
  },
);

// ---------------------------------------------------------------------------
// GA5 (local, unkeyed) — the fail-closed negative row.
//
// `anthropic:` is a documented negative: the Claude Messages API reference
// (https://platform.claude.com/docs/en/api/messages, checked 2026-09-07) lists
// text, image, document, search-result, thinking, tool and container content
// blocks — no audio block. `openai-responses:` documents text and image input
// only. The third case is the regression that matters most: a provider written
// before audio existed validates input but declares no `inputCapabilities`, so
// audio must fail closed on the capability gate rather than fall through to
// `validateInput` (which would happily accept it) or to a request.
// ---------------------------------------------------------------------------

/** A provider that predates audio: validates input, declares no capabilities. */
class LegacyValidatingProvider implements Provider {
  readonly name = 'legacy';
  validations = 0;
  chatCalls = 0;

  validateInput(request: ProviderInputValidationRequest): { effectiveModel: string } {
    this.validations++;
    return { effectiveModel: request.model };
  }

  async chat(): Promise<ProviderResponse> {
    this.chatCalls++;
    return { content: 'never', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }

  async *stream(): AsyncGenerator<StreamChunk> {
    yield { type: 'done', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  }
}

describe('general audio local [GA5]: fail-closed providers', () => {
  it('[GA5] rejects audio on anthropic:, openai-responses:, and a capability-less provider with no fetch', async () => {
    const legacy = new LegacyValidatingProvider();
    const registry = new ProviderRegistry();
    registry.registerInstance('anthropic', new AnthropicProvider({ apiKey: 'not-used' }));
    registry.registerInstance(
      'openai-responses',
      new OpenAIResponsesProvider({ apiKey: 'not-used' }),
    );
    registry.registerInstance('legacy', legacy);

    const lanes = [
      ['anthropic', 'anthropic:claude-sonnet-4-5'],
      ['openai-responses', 'openai-responses:gpt-4o-mini'],
      ['legacy', 'legacy:some-model'],
    ] as const;

    await forbidFetch(async () => {
      for (const [provider, model] of lanes) {
        const { context, events } = liveContext(registry);
        const error = await context
          .ask(agent({ model, system: 'Listen.' }), toneInput(), { maxTokens: 64 })
          .then(
            () => undefined,
            (thrown: unknown) => thrown,
          );

        expect(error).toBeInstanceOf(UnsupportedModelInputError);
        const unsupported = error as UnsupportedModelInputError;
        expect(unsupported.modality).toBe('audio');
        expect(unsupported.provider).toBe(provider);
        // No silent downgrade to text and no transcription fallback.
        expect(unsupported.message).not.toContain(TONE_SENTINEL);
        assertSentinelAbsentFromEvents(events, TONE_SENTINEL);
      }
    });

    // The gate runs BEFORE validation, so the legacy provider never sees the
    // input it would have wrongly accepted, and never dispatches.
    expect(legacy.validations).toBe(0);
    expect(legacy.chatCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GA6 / GA6-tool — OpenRouter speech rows.
// ---------------------------------------------------------------------------

describe.skipIf(!RUN || !process.env.OPENROUTER_API_KEY)(
  `general audio live [GA6]: OpenRouter ${OPENROUTER_AUDIO_MODEL}`,
  () => {
    it('[GA6] answers a question about base64 speech audio and records reported cost honestly', async () => {
      await observeWire(async (calls) => {
        const { context, events } = liveContext();
        const listener = agent({
          model: `openrouter:${OPENROUTER_AUDIO_MODEL}`,
          system: 'Answer in one short sentence.',
        });
        const result = await context.ask(listener, callInput(CALL_QUESTION), { maxTokens: 200 });

        expect(result.trim().length).toBeGreaterThan(0);
        const model = modelCalls(calls);
        expect(model).toHaveLength(1);
        expect(compatibleUserContent(model[0])[0]).toEqual({
          type: 'input_audio',
          input_audio: { data: RECORDED_CALL_BASE64, format: 'mp3' },
        });
        expect(model[0].rawRequest).toContain(RECORDED_CALL_SENTINEL);
        assertSentinelAbsentFromEvents(events, RECORDED_CALL_SENTINEL);
        assertNoStrayAudioEcho(model[0].responseBody, RECORDED_CALL_SENTINEL);
        const terminal = assertHonestTerminal(events);
        const cost = reportedCost(model[0]);
        // Either the route reported a usable number or the ask is unpriced —
        // a priced zero would be a false "this was free".
        expect(typeof cost === 'number' ? Number.isFinite(cost) : terminal.unpriced).toBe(true);

        evidence('GA6', {
          model: `openrouter:${OPENROUTER_AUDIO_MODEL}`,
          cost: terminal.cost,
          unpriced: terminal.unpriced,
          reportedUsageCost: cost ?? 'absent',
          tokens: rawUsage(model[0]),
          answer: result,
        });
      });
    });
  },
);

describe.skipIf(!RUN || !process.env.OPENROUTER_API_KEY)(
  `general audio live [GA6-tool]: OpenRouter ${OPENROUTER_AUDIO_MODEL}`,
  () => {
    it('[GA6-tool] keeps the speech input_audio identical across a tool continuation', async () => {
      await observeWire(async (calls) => {
        const { context, events } = liveContext();
        const listener = agent({
          model: `openrouter:${OPENROUTER_AUDIO_MODEL}`,
          system: TOOL_SYSTEM,
          tools: [lookupAccount],
          maxTurns: 2,
        });
        const result = await context.ask(
          listener,
          callInput('Look up the account for the caller, then summarise the call.'),
          { maxTokens: 200 },
        );

        expect(result.trim().length).toBeGreaterThan(0);
        const model = modelCalls(calls);
        expect(model).toHaveLength(2);
        const first = compatibleUserContent(model[0]);
        const second = compatibleUserContent(model[1]);
        expect(first[0]).toEqual({
          type: 'input_audio',
          input_audio: { data: RECORDED_CALL_BASE64, format: 'mp3' },
        });
        expect(second[0]).toEqual(first[0]);
        expect(second.filter((part) => part.type === 'input_audio')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'tool_call_end')).toHaveLength(1);
        assertSentinelAbsentFromEvents(events, RECORDED_CALL_SENTINEL);
        assertNoStrayAudioEcho(model[1].requestBody, RECORDED_CALL_SENTINEL);
        const terminal = assertHonestTerminal(events);

        evidence('GA6-tool', {
          model: `openrouter:${OPENROUTER_AUDIO_MODEL}`,
          cost: terminal.cost,
          unpriced: terminal.unpriced,
          reportedUsageCost: reportedCost(model[1]) ?? 'absent',
          tokens: rawUsage(model[1]),
          answer: result,
        });
      });
    });
  },
);

// ---------------------------------------------------------------------------
// GA7 (local, unkeyed) — an unmappable media type is rejected here, naming the
// type, rather than sent for the provider to 400 on.
// ---------------------------------------------------------------------------

describe('general audio local [GA7]: unmappable media type', () => {
  it('[GA7] rejects audio/x-unknown on openai: and openrouter: with no fetch', async () => {
    const registry = new ProviderRegistry();
    registry.registerInstance('openai', new OpenAIProvider({ apiKey: 'not-used' }));
    registry.registerInstance(
      'openrouter',
      new OpenAICompatibleProvider({ profile: OPENROUTER_PROFILE, apiKey: 'not-used' }),
    );

    const unknownAudio: readonly InputContentPart[] = [
      {
        type: 'audio',
        source: { type: 'base64', data: TONE_WAV_BASE64, mediaType: 'audio/x-unknown' },
      },
      { type: 'text', text: TONE_QUESTION },
    ];

    await forbidFetch(async () => {
      for (const model of [
        `openai:${OPENAI_AUDIO_MODEL}`,
        `openrouter:${OPENROUTER_AUDIO_MODEL}`,
      ]) {
        const { context, events } = liveContext(registry);
        const error = await context
          .ask(agent({ model, system: 'Listen.' }), unknownAudio, { maxTokens: 64 })
          .then(
            () => undefined,
            (thrown: unknown) => thrown,
          );

        expect(error).toBeInstanceOf(UnsupportedModelInputError);
        const unsupported = error as UnsupportedModelInputError;
        expect(unsupported.modality).toBe('audio');
        // Naming the media type is the point: "unsupported input" alone gives
        // the developer nothing to act on.
        expect(unsupported.message).toContain('audio/x-unknown');
        expect(unsupported.message).not.toContain(TONE_SENTINEL);
        assertSentinelAbsentFromEvents(events, TONE_SENTINEL);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// GA8 / GA8-OR — streaming GA1. Audio rides the ordinary text path: normal
// token deltas, no new event type, bytes on the wire and nowhere else.
// ---------------------------------------------------------------------------

describe.skipIf(!RUN || !GOOGLE_KEY)(
  `general audio live [GA8]: Gemini streaming ${GEMINI_AUDIO_MODEL}`,
  () => {
    it('[GA8] streams ordinary text deltas for a non-speech audio ask', async () => {
      await observeWire(async (calls) => {
        const { context, events } = liveContext();
        void context.events; // opt into the provider streaming path before ask
        const listener = agent({
          model: `google:${GEMINI_AUDIO_MODEL}`,
          system: 'Answer in one short sentence.',
        });
        // Text-only control on the same route: the event-type comparison below
        // is only meaningful against what an ordinary streaming ask emits.
        const control = liveContext();
        void control.context.events;
        await control.context.ask(listener, CONTROL_QUESTION, { maxTokens: 50, effort: 'none' });
        control.context.disposeEvents();
        const result = await context.ask(listener, toneInput(), { maxTokens: 200, effort: 'none' });
        context.disposeEvents();

        expect(result.trim().length).toBeGreaterThan(0);
        // Two model requests: the text-only control, then the audio ask.
        const model = modelCalls(calls);
        expect(model).toHaveLength(2);
        expect(model[0].rawRequest).not.toContain(TONE_SENTINEL);
        expect(geminiUserContent(model[1])[0]).toEqual({
          type: 'audio',
          data: TONE_WAV_BASE64,
          mime_type: 'audio/wav',
        });
        expect(model[1].rawRequest).toContain(TONE_SENTINEL);
        assertNoNewEventTypes(events, control.events);
        assertSentinelAbsentFromEvents(events, TONE_SENTINEL);
        const terminal = assertHonestTerminal(events);

        evidence('GA8', {
          model: `google:${GEMINI_AUDIO_MODEL}`,
          cost: terminal.cost,
          unpriced: terminal.unpriced,
          tokenEvents: events.filter((event) => event.type === 'token').length,
          answer: result,
        });
      });
    });
  },
);

describe.skipIf(!RUN || !process.env.OPENROUTER_API_KEY)(
  `general audio live [GA8-OR]: OpenRouter streaming ${OPENROUTER_AUDIO_MODEL}`,
  () => {
    it('[GA8-OR] streams ordinary text deltas for a non-speech audio ask', async () => {
      await observeWire(async (calls) => {
        const { context, events } = liveContext();
        void context.events;
        const listener = agent({
          model: `openrouter:${OPENROUTER_AUDIO_MODEL}`,
          system: 'Answer in one short sentence.',
        });
        const control = liveContext();
        void control.context.events;
        await control.context.ask(listener, CONTROL_QUESTION, { maxTokens: 50 });
        control.context.disposeEvents();
        const result = await context.ask(listener, toneBase64Input(), { maxTokens: 200 });
        context.disposeEvents();

        expect(result.trim().length).toBeGreaterThan(0);
        // Two model requests: the text-only control, then the audio ask.
        const model = modelCalls(calls);
        expect(model).toHaveLength(2);
        expect(model[0].rawRequest).not.toContain(TONE_SENTINEL);
        expect(compatibleUserContent(model[1])[0]).toEqual({
          type: 'input_audio',
          input_audio: { data: TONE_WAV_BASE64, format: 'wav' },
        });
        expect(model[1].rawRequest).toContain(TONE_SENTINEL);
        assertNoNewEventTypes(events, control.events);
        assertSentinelAbsentFromEvents(events, TONE_SENTINEL);
        const terminal = assertHonestTerminal(events);

        evidence('GA8-OR', {
          model: `openrouter:${OPENROUTER_AUDIO_MODEL}`,
          cost: terminal.cost,
          unpriced: terminal.unpriced,
          tokenEvents: events.filter((event) => event.type === 'token').length,
          answer: result,
        });
      });
    });
  },
);

// ---------------------------------------------------------------------------
// Gating self-checks (local): the kill switch and the arming flag must both
// behave, or every "skipped" above is meaningless.
// ---------------------------------------------------------------------------

describe('general audio local: gating', () => {
  it('a provider key alone never arms a paid row', () => {
    expect(generalAudioLiveEnabled({ OPENROUTER_API_KEY: 'sk-test' })).toBe(false);
    expect(generalAudioLiveEnabled({ AXL_MULTIMODAL_LIVE: '1' })).toBe(false);
    expect(generalAudioLiveEnabled({ AXL_GENERAL_AUDIO_LIVE: '1' })).toBe(false);
    expect(generalAudioLiveEnabled({ AXL_MULTIMODAL_LIVE: '1', AXL_GENERAL_AUDIO_LIVE: '1' })).toBe(
      true,
    );
  });

  it('the absolute kill switch wins over both armed flags', () => {
    expect(
      generalAudioLiveEnabled({
        AXL_MULTIMODAL_LIVE: '1',
        AXL_GENERAL_AUDIO_LIVE: '1',
        AXL_DISABLE_LIVE_INTEGRATION: '1',
      }),
    ).toBe(false);
  });

  it('the generated tone fixture is a well-formed ~3 s 16 kHz mono PCM WAV', () => {
    const view = new DataView(
      TONE_WAV_BYTES.buffer,
      TONE_WAV_BYTES.byteOffset,
      TONE_WAV_BYTES.byteLength,
    );
    const text = (offset: number, length: number) =>
      String.fromCharCode(...TONE_WAV_BYTES.slice(offset, offset + length));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(text(36, 4)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(4, true)).toBe(TONE_WAV_BYTES.byteLength - 8);
    expect(view.getUint32(40, true)).toBe(TONE_WAV_BYTES.byteLength - 44);
    expect(TONE_WAV_BYTES.byteLength).toBe(44 + 3 * 16_000 * 2);
    // The tone half is audible and the tail is silent — otherwise GA1's
    // "does the pitch change?" question has no correct answer.
    expect(view.getInt16(44 + 8_000 * 2, true)).not.toBe(0);
    expect(view.getInt16(44 + 40_000 * 2, true)).toBe(0);
    // The sentinel must be distinctive, not a run of padding.
    expect(TONE_SENTINEL).toHaveLength(128);
    expect(new Set(TONE_SENTINEL).size).toBeGreaterThan(8);
  });
});
