import type {
  ChatOptions,
  EffortResolution,
  ApiKeySource,
  ResolvedThinkingOptions,
} from './types.js';
import { resolveThinkingOptions } from './types.js';
import type { RateLimitConfig } from './rate-limiter.js';
import { OPENAI_DEFAULT_BASE_URL } from './default-endpoints.js';
import {
  OpenAICompatibleProvider,
  type ProviderProfile,
  type PricingTable,
  type ReasoningEmit,
} from './openai-compatible.js';
import { OPENAI_CHAT_AUDIO_FORMATS } from './audio-format.js';
import type { ProviderResponse } from '../types.js';
import { UnsupportedModelOptionError } from '../errors.js';

// ---------------------------------------------------------------------------
// Public flat compatibility table. It intentionally cannot represent the
// direct-OpenAI catalog's context tiers or cache-write rates; native OpenAI
// calls use `estimateDirectOpenAICost` below instead. Keep this export and its
// tuple shape source-compatible for custom OpenAI-compatible profiles.
// ---------------------------------------------------------------------------

export const OPENAI_PRICING: PricingTable = {
  // Flat, exact Standard rows only. Context-tiered and cache-write-priced
  // models intentionally stay out of this compatibility view.
  'gpt-4o': [2.5e-6, 10e-6, 0.5],
  'gpt-4o-mini': [0.15e-6, 0.6e-6, 0.5],
  o1: [15e-6, 60e-6, 0.5],
  'gpt-4.1': [2e-6, 8e-6, 0.25],
  'gpt-4.1-mini': [0.4e-6, 1.6e-6, 0.25],
  'gpt-4.1-nano': [0.1e-6, 0.4e-6, 0.25],
  o3: [2e-6, 8e-6, 0.25],
  'o3-mini': [1.1e-6, 4.4e-6, 0.25],
  'o4-mini': [1.1e-6, 4.4e-6, 0.25],
  'gpt-5': [1.25e-6, 10e-6, 0.1],
  'gpt-5-mini': [0.25e-6, 2e-6, 0.1],
  'gpt-5-nano': [0.05e-6, 0.4e-6, 0.1],
  'gpt-5.1': [1.25e-6, 10e-6, 0.1],
  'gpt-5.2': [1.75e-6, 14e-6, 0.1],
};

type OpenAIRates = {
  input: number;
  cachedInput?: number;
  cacheWrite?: number;
  output: number;
};

/**
 * Per-token audio rates. Audio tokens are billed from their own row and are
 * NEVER folded into the text `input`/`output` rates — on the audio models the
 * two differ by an order of magnitude. `output` is present only for a model
 * whose audio replies have a published price; without it, a response carrying
 * audio output tokens is unpriced rather than billed at the text output rate.
 */
type OpenAIAudioRates = {
  input: number;
  output?: number;
};

type DirectOpenAIModel = {
  /** Every catalog id is explicit; aliases never imply snapshot pricing. */
  aliases: readonly string[];
  snapshotBase?: string;
  short: OpenAIRates;
  long?: OpenAIRates;
  contextBoundary?: number;
  /** Absent ⇒ this model's audio price is unknown, so audio work is unpriced. */
  audio?: OpenAIAudioRates;
};

const M = 1_000_000;
const LONG_CONTEXT_BOUNDARY = 272_000;

const withLongContext = (short: OpenAIRates): DirectOpenAIModel['long'] => ({
  input: short.input * 2,
  cachedInput: short.cachedInput === undefined ? undefined : short.cachedInput * 2,
  cacheWrite: short.cacheWrite === undefined ? undefined : short.cacheWrite * 2,
  output: short.output * 1.5,
});

/**
 * Direct OpenAI Standard text pricing, per token. Reviewed 2026-09-03 against
 * https://developers.openai.com/api/docs/pricing. Promotional rates are recorded
 * at their current value, never as a forward-dated transition: an announced
 * revert can be cancelled, and a clock-gated table then silently misprices from
 * the date it predicted. GPT-5.6 Sol's promotion is announced as running at
 * least through 2026-11-21; re-verify then instead of encoding the change here.
 * This is deliberately private:
 * the public tuple API cannot faithfully express cache writes or context tiers.
 * Every catalog id is explicit; arbitrary siblings and unlisted snapshots
 * never inherit an alias price.
 */
const DIRECT_OPENAI_CATALOG: readonly DirectOpenAIModel[] = [
  {
    aliases: ['gpt-6-astra'],
    short: { input: 10 / M, cachedInput: 1 / M, cacheWrite: 12.5 / M, output: 50 / M },
    long: { input: 20 / M, cachedInput: 2 / M, cacheWrite: 25 / M, output: 75 / M },
    contextBoundary: LONG_CONTEXT_BOUNDARY,
  },
  {
    aliases: ['gpt-6-sol'],
    short: { input: 2 / M, cachedInput: 0.2 / M, cacheWrite: 2.5 / M, output: 10 / M },
    long: { input: 4 / M, cachedInput: 0.4 / M, cacheWrite: 5 / M, output: 15 / M },
    contextBoundary: LONG_CONTEXT_BOUNDARY,
  },
  {
    aliases: ['gpt-6-luna'],
    short: { input: 0.1 / M, cachedInput: 0.01 / M, cacheWrite: 0.125 / M, output: 0.5 / M },
    long: { input: 0.2 / M, cachedInput: 0.02 / M, cacheWrite: 0.25 / M, output: 0.75 / M },
    contextBoundary: LONG_CONTEXT_BOUNDARY,
  },
  {
    aliases: ['gpt-5.6', 'gpt-5.6-sol'],
    snapshotBase: 'gpt-5.6-sol',
    short: { input: 4 / M, cachedInput: 0.4 / M, cacheWrite: 5 / M, output: 20 / M },
    long: withLongContext({
      input: 4 / M,
      cachedInput: 0.4 / M,
      cacheWrite: 5 / M,
      output: 20 / M,
    }),
    contextBoundary: LONG_CONTEXT_BOUNDARY,
  },
  {
    aliases: ['gpt-5.6-terra'],
    snapshotBase: 'gpt-5.6-terra',
    short: { input: 2 / M, cachedInput: 0.2 / M, cacheWrite: 2.5 / M, output: 12 / M },
    long: withLongContext({
      input: 2 / M,
      cachedInput: 0.2 / M,
      cacheWrite: 2.5 / M,
      output: 12 / M,
    }),
    contextBoundary: LONG_CONTEXT_BOUNDARY,
  },
  {
    aliases: ['gpt-5.6-luna'],
    snapshotBase: 'gpt-5.6-luna',
    short: { input: 0.2 / M, cachedInput: 0.02 / M, cacheWrite: 0.25 / M, output: 1.2 / M },
    long: withLongContext({
      input: 0.2 / M,
      cachedInput: 0.02 / M,
      cacheWrite: 0.25 / M,
      output: 1.2 / M,
    }),
    contextBoundary: LONG_CONTEXT_BOUNDARY,
  },
  // Audio-capable models. Audio rates reviewed 2026-09-08 against
  // https://developers.openai.com/api/docs/pricing (no version stamp on the
  // page): `gpt-audio-1.5` and `gpt-audio` both list Text $2.50 in / $10.00
  // out and Audio $32.00 in / $64.00 out per 1M tokens, with no cached-input
  // row — hence no `cachedInput` here, which makes a cache-hit report unpriced
  // rather than silently billed at the full input rate. Only these exact ids
  // are listed: no snapshot id is published for either, and inventing one
  // would price an unknown model.
  {
    aliases: ['gpt-audio-1.5'],
    snapshotBase: 'gpt-audio-1.5',
    short: { input: 2.5 / M, output: 10 / M },
    audio: { input: 32 / M, output: 64 / M },
  },
  {
    aliases: ['gpt-audio'],
    snapshotBase: 'gpt-audio',
    short: { input: 2.5 / M, output: 10 / M },
    audio: { input: 32 / M, output: 64 / M },
  },
  // Existing direct models retain literal current Standard rows. These flat
  // rows keep native pricing aligned with the compatibility wrapper while the
  // private estimator still validates categories and billing mode strictly.
  {
    aliases: ['gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20'],
    snapshotBase: 'gpt-4o',
    short: { input: 2.5 / M, cachedInput: 1.25 / M, output: 10 / M },
  },
  {
    aliases: ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18'],
    snapshotBase: 'gpt-4o-mini',
    short: { input: 0.15 / M, cachedInput: 0.075 / M, output: 0.6 / M },
  },
  {
    aliases: ['gpt-3.5-turbo'],
    snapshotBase: 'gpt-3.5-turbo',
    short: { input: 0.5 / M, output: 1.5 / M },
  },
  {
    aliases: ['o1', 'o1-2024-12-17'],
    snapshotBase: 'o1',
    short: { input: 15 / M, cachedInput: 7.5 / M, output: 60 / M },
  },
  {
    aliases: ['o1-pro', 'o1-pro-2025-03-19'],
    snapshotBase: 'o1-pro',
    short: { input: 150 / M, output: 600 / M },
  },
  {
    aliases: ['gpt-4.1', 'gpt-4.1-2025-04-14'],
    snapshotBase: 'gpt-4.1',
    short: { input: 2 / M, cachedInput: 0.5 / M, output: 8 / M },
  },
  {
    aliases: ['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'],
    snapshotBase: 'gpt-4.1-mini',
    short: { input: 0.4 / M, cachedInput: 0.1 / M, output: 1.6 / M },
  },
  {
    aliases: ['gpt-4.1-nano', 'gpt-4.1-nano-2025-04-14'],
    snapshotBase: 'gpt-4.1-nano',
    short: { input: 0.1 / M, cachedInput: 0.025 / M, output: 0.4 / M },
  },
  {
    aliases: ['o3', 'o3-2025-04-16'],
    snapshotBase: 'o3',
    short: { input: 2 / M, cachedInput: 0.5 / M, output: 8 / M },
  },
  {
    aliases: ['o3-mini', 'o3-mini-2025-01-31'],
    snapshotBase: 'o3-mini',
    short: { input: 1.1 / M, cachedInput: 0.55 / M, output: 4.4 / M },
  },
  {
    aliases: ['o3-pro', 'o3-pro-2025-06-10'],
    snapshotBase: 'o3-pro',
    short: { input: 20 / M, output: 80 / M },
  },
  {
    aliases: ['o4-mini', 'o4-mini-2025-04-16'],
    snapshotBase: 'o4-mini',
    short: { input: 1.1 / M, cachedInput: 0.275 / M, output: 4.4 / M },
  },
  {
    aliases: ['gpt-5', 'gpt-5-2025-08-07'],
    snapshotBase: 'gpt-5',
    short: { input: 1.25 / M, cachedInput: 0.125 / M, output: 10 / M },
  },
  {
    aliases: ['gpt-5-mini', 'gpt-5-mini-2025-08-07'],
    snapshotBase: 'gpt-5-mini',
    short: { input: 0.25 / M, cachedInput: 0.025 / M, output: 2 / M },
  },
  {
    aliases: ['gpt-5-nano', 'gpt-5-nano-2025-08-07'],
    snapshotBase: 'gpt-5-nano',
    short: { input: 0.05 / M, cachedInput: 0.005 / M, output: 0.4 / M },
  },
  {
    aliases: ['gpt-5.1', 'gpt-5.1-2025-11-13'],
    snapshotBase: 'gpt-5.1',
    short: { input: 1.25 / M, cachedInput: 0.125 / M, output: 10 / M },
  },
  {
    aliases: ['gpt-5.2', 'gpt-5.2-2025-12-11'],
    snapshotBase: 'gpt-5.2',
    short: { input: 1.75 / M, cachedInput: 0.175 / M, output: 14 / M },
  },
  {
    aliases: ['gpt-5.4', 'gpt-5.4-2026-03-05'],
    snapshotBase: 'gpt-5.4',
    short: { input: 2.5 / M, cachedInput: 0.25 / M, output: 15 / M },
    long: withLongContext({ input: 2.5 / M, cachedInput: 0.25 / M, output: 15 / M }),
    contextBoundary: LONG_CONTEXT_BOUNDARY,
  },
  {
    aliases: ['gpt-5.4-pro', 'gpt-5.4-pro-2026-03-05'],
    snapshotBase: 'gpt-5.4-pro',
    short: { input: 30 / M, output: 180 / M },
    long: withLongContext({ input: 30 / M, output: 180 / M }),
    contextBoundary: LONG_CONTEXT_BOUNDARY,
  },
  {
    aliases: ['gpt-5.5', 'gpt-5.5-2026-04-23'],
    snapshotBase: 'gpt-5.5',
    short: { input: 5 / M, cachedInput: 0.5 / M, output: 30 / M },
    long: withLongContext({ input: 5 / M, cachedInput: 0.5 / M, output: 30 / M }),
    contextBoundary: LONG_CONTEXT_BOUNDARY,
  },
  {
    aliases: ['gpt-5.5-pro', 'gpt-5.5-pro-2026-04-23'],
    snapshotBase: 'gpt-5.5-pro',
    short: { input: 30 / M, output: 180 / M },
    long: withLongContext({ input: 30 / M, output: 180 / M }),
    contextBoundary: LONG_CONTEXT_BOUNDARY,
  },
  {
    aliases: ['gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17'],
    short: { input: 0.75 / M, cachedInput: 0.075 / M, output: 4.5 / M },
  },
  {
    aliases: ['gpt-5.4-nano', 'gpt-5.4-nano-2026-03-17'],
    short: { input: 0.2 / M, cachedInput: 0.02 / M, output: 1.25 / M },
  },
  {
    aliases: ['gpt-5.2-pro', 'gpt-5.2-pro-2025-12-11'],
    short: { input: 21 / M, output: 168 / M },
  },
  { aliases: ['gpt-5-pro', 'gpt-5-pro-2025-10-06'], short: { input: 15 / M, output: 120 / M } },
  { aliases: ['gpt-3.5-turbo-instruct'], short: { input: 1.5 / M, output: 2 / M } },
  { aliases: ['davinci-002'], short: { input: 2 / M, output: 2 / M } },
  { aliases: ['babbage-002'], short: { input: 0.4 / M, output: 0.4 / M } },
  // Explicit snapshots with their own current dedicated-table rows. Do not
  // generalize these dates: a plausible-looking unlisted snapshot is unpriced.
  { aliases: ['gpt-4o-2024-05-13'], short: { input: 5 / M, output: 15 / M } },
  { aliases: ['gpt-4-turbo-2024-04-09'], short: { input: 10 / M, output: 30 / M } },
  { aliases: ['gpt-4-0613'], short: { input: 30 / M, output: 60 / M } },
  {
    aliases: ['gpt-3.5-turbo-0125'],
    short: { input: 0.5 / M, output: 1.5 / M },
  },
  { aliases: ['gpt-3.5-turbo-1106'], short: { input: 1 / M, output: 2 / M } },
];

function directOpenAIModel(model: string): DirectOpenAIModel | undefined {
  return DIRECT_OPENAI_CATALOG.find((entry) => entry.aliases.includes(model));
}

const CANONICAL_OPENAI_BASE_URL = OPENAI_DEFAULT_BASE_URL;

function isTextContentPart(value: unknown, type: 'text' | 'input_text'): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === type &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}

function isChatAudioContentPart(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const part = value as { type?: unknown; input_audio?: unknown };
  return (
    part.type === 'input_audio' && part.input_audio !== null && typeof part.input_audio === 'object'
  );
}

/**
 * How faithfully the direct catalog can price this request's content.
 *
 * - `text` — every content part is text, so the text rows price it exactly.
 * - `audio` — every non-text part is a Chat Completions `input_audio` part, so
 *   the call prices from `prompt_tokens_details.audio_tokens` × the model's
 *   audio row. The provider MUST report that count: a missing one is unknown,
 *   never zero, and audio tokens are never billed at the text rate.
 * - `unmodeled` — an image, an unknown part, or a malformed shape. Unpriced.
 *
 * Classification spans the WHOLE request (rich session history and tool
 * continuations included), because every message in it is billed.
 */
type DirectOpenAIContentClass = 'text' | 'audio' | 'unmodeled';

function classifyDirectOpenAIContent(
  request: Record<string, unknown> | undefined,
): DirectOpenAIContentClass {
  // The pure estimator is also used without a captured request context in
  // unit-level callers. There is no content shape to classify in that case.
  if (!request) return 'text';

  if ('messages' in request) {
    if (!Array.isArray(request.messages)) return 'unmodeled';
    let carriesAudio = false;
    for (const message of request.messages) {
      if (message === null || typeof message !== 'object') return 'unmodeled';
      const content = (message as { content?: unknown }).content;
      if (content === undefined || content === null || typeof content === 'string') continue;
      if (!Array.isArray(content)) return 'unmodeled';
      for (const part of content) {
        if (isTextContentPart(part, 'text')) continue;
        if (isChatAudioContentPart(part)) {
          carriesAudio = true;
          continue;
        }
        return 'unmodeled';
      }
    }
    return carriesAudio ? 'audio' : 'text';
  }

  if ('input' in request) {
    const input = request.input;
    if (typeof input === 'string') return 'text';
    if (!Array.isArray(input)) return 'unmodeled';
    for (const item of input) {
      if (item === null || typeof item !== 'object') return 'unmodeled';
      const typed = item as {
        type?: unknown;
        content?: unknown;
        input?: unknown;
        output?: unknown;
      };
      switch (typed.type) {
        case 'message': {
          const content = typed.content;
          if (typeof content === 'string') break;
          if (
            !Array.isArray(content) ||
            content.some((part) => !isTextContentPart(part, 'input_text'))
          ) {
            // The Responses transport rejects audio before dispatch, so an
            // audio part here is not a priceable shape — it is unmodeled.
            return 'unmodeled';
          }
          break;
        }
        case 'function_call':
          break;
        case 'function_call_output': {
          const output = typed.output;
          if (typeof output === 'string') break;
          if (
            !Array.isArray(output) ||
            output.some((part) => !isTextContentPart(part, 'input_text'))
          ) {
            return 'unmodeled';
          }
          break;
        }
        case 'custom_tool_call':
          if (typeof typed.input !== 'string') return 'unmodeled';
          break;
        case 'custom_tool_call_output':
          if (typeof typed.output !== 'string') return 'unmodeled';
          break;
        case 'reasoning':
          break;
        default:
          return 'unmodeled';
      }
    }
    return 'text';
  }

  return 'text';
}

function isEligibleDirectOpenAIContext(
  context: DirectOpenAIPricingContext | undefined,
  entry: DirectOpenAIModel,
): boolean {
  const request = context?.request;
  const response = context?.response;
  if (context?.baseUrl !== undefined && context.baseUrl !== CANONICAL_OPENAI_BASE_URL) return false;
  const tier =
    response?.service_tier ??
    response?.serviceTier ??
    request?.service_tier ??
    request?.serviceTier;
  if (
    tier !== undefined &&
    (typeof tier !== 'string' || !['standard', 'default'].includes(tier.toLowerCase()))
  ) {
    return false;
  }
  if (['region', 'inference_geo', 'data_residency'].some((key) => request?.[key] !== undefined)) {
    return false;
  }
  // These references can make input billing depend on server-side state that
  // is not represented in the local token totals, so direct table pricing
  // cannot account for them faithfully.
  if (
    ['previous_response_id', 'conversation', 'prompt'].some((key) => request?.[key] !== undefined)
  ) {
    return false;
  }
  const reasoning = request?.reasoning;
  if (
    reasoning !== null &&
    typeof reasoning === 'object' &&
    'mode' in reasoning &&
    (reasoning as { mode?: unknown }).mode !== undefined
  ) {
    return false;
  }
  // Spoken output is representable only for a model with a published audio
  // OUTPUT rate; otherwise the reply's audio tokens have no price and the call
  // must stay unpriced rather than be billed at the text output rate.
  const audioOutputRated = entry.audio?.output !== undefined;
  if (
    request?.modalities !== undefined &&
    (!Array.isArray(request.modalities) ||
      request.modalities.length === 0 ||
      request.modalities.some(
        (modality) => modality !== 'text' && !(modality === 'audio' && audioOutputRated),
      ))
  ) {
    return false;
  }
  if (request?.audio !== undefined && !audioOutputRated) return false;
  if (['image_generation', 'web_search_options'].some((key) => request?.[key] !== undefined)) {
    return false;
  }
  if (
    Array.isArray(request?.tools) &&
    request.tools.some(
      (tool) =>
        tool === null ||
        typeof tool !== 'object' ||
        !['function', 'custom'].includes((tool as { type?: unknown }).type as string),
    )
  ) {
    return false;
  }
  return true;
}

export type DirectOpenAIPricingContext = {
  /** Only the canonical direct API endpoint has a usable catalog. */
  baseUrl?: string;
  request?: Record<string, unknown>;
  response?: { service_tier?: unknown; serviceTier?: unknown };
};

/**
 * Internal native OpenAI estimator; undefined means deliberately unpriced.
 *
 * Audio-aware. The prompt splits into four disjoint buckets —
 * `cached + cacheWrite + audio + ordinary = prompt_tokens` — and the completion
 * splits into audio and text. Every bucket needs a published rate for the call
 * to price at all: a missing rate, a missing count on an audio-bearing request,
 * or an arithmetic contradiction yields `undefined`, never a partial number and
 * never `0`.
 */
export function estimateDirectOpenAICost(
  model: string,
  usage: NonNullable<ProviderResponse['usage']>,
  context?: DirectOpenAIPricingContext,
): number | undefined {
  const entry = directOpenAIModel(model);
  if (!entry) return undefined;
  const content = classifyDirectOpenAIContent(context?.request);
  if (content === 'unmodeled') return undefined;
  if (!isEligibleDirectOpenAIContext(context, entry)) return undefined;
  const {
    prompt_tokens,
    completion_tokens,
    cached_tokens,
    cache_write_tokens,
    audio_input_tokens,
    audio_output_tokens,
  } = usage;
  // An audio-bearing request must come back with a usable audio prompt-token
  // count. A missing or malformed one (`toUsage` omits those) is UNKNOWN, not
  // zero — pricing it as pure text would silently under-report by ~13x.
  if (content === 'audio' && audio_input_tokens === undefined) return undefined;
  const cached = cached_tokens ?? 0;
  const cacheWrite = cache_write_tokens ?? 0;
  // Usage is authoritative: a provider that reports audio tokens for a request
  // Axl classified as text still prices from the audio row (or stays unpriced
  // when the model has none), rather than being billed at the text rate.
  const audioInput = audio_input_tokens ?? 0;
  const audioOutput = audio_output_tokens ?? 0;
  if (
    ![prompt_tokens, completion_tokens, cached, cacheWrite, audioInput, audioOutput].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    ) ||
    (resolveOpenAIModelDescriptor(model).strictUsageTotals &&
      (!Number.isSafeInteger(usage.total_tokens) ||
        usage.total_tokens !== prompt_tokens + completion_tokens)) ||
    cached + cacheWrite + audioInput > prompt_tokens ||
    audioOutput > completion_tokens
  ) {
    return undefined;
  }
  if (
    (audioInput > 0 && entry.audio === undefined) ||
    (audioOutput > 0 && entry.audio?.output === undefined)
  ) {
    return undefined;
  }
  // The DECISION is settled: the audio rate is never applied to cached or
  // cache-write tokens. What is NOT settled is whether OpenAI's
  // `cached_tokens` can include audio tokens — the pricing page says nothing,
  // and prompt caching engages automatically above a token threshold that
  // seconds of speech cross. The bucket subtraction below is a partition only
  // if the two never overlap, so any co-occurrence is unpriced until a live
  // probe settles it (plan §9 L1 / V2), matching the long-context branch.
  if (audioInput > 0 && cached + cacheWrite > 0) return undefined;
  const crossesLongContext =
    entry.long !== undefined &&
    entry.contextBoundary !== undefined &&
    prompt_tokens > entry.contextBoundary;
  // No long-context AUDIO rate is published for any model. A crossing that
  // carries audio is therefore unpriced rather than billed at the short-context
  // audio rate; relaxing this later is cheaper than under-reporting now.
  if (crossesLongContext && (audioInput > 0 || audioOutput > 0)) return undefined;
  const rates = crossesLongContext ? entry.long! : entry.short;
  if (
    (cached > 0 && rates.cachedInput === undefined) ||
    (cacheWrite > 0 && rates.cacheWrite === undefined)
  ) {
    return undefined;
  }
  const ordinary = prompt_tokens - cached - cacheWrite - audioInput;
  const textOutput = completion_tokens - audioOutput;
  return (
    ordinary * rates.input +
    cached * (rates.cachedInput ?? 0) +
    cacheWrite * (rates.cacheWrite ?? 0) +
    audioInput * (entry.audio?.input ?? 0) +
    textOutput * rates.output +
    audioOutput * (entry.audio?.output ?? 0)
  );
}

/**
 * Estimate OpenAI call cost from token usage. Exact match first, then
 * longest-prefix match for versioned models (e.g. `gpt-4o-2024-05-13`).
 *
 * Returns `undefined` when the model is not in the table — callers must treat
 * that as "unknown cost", never as free (a silent `0` would break
 * `ctx.budget()` and mislead cost dashboards). See spec §6.
 */
export function estimateOpenAICost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens?: number,
): number | undefined {
  return estimateDirectOpenAICost(model, {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    cached_tokens: cachedTokens,
  });
}

// ---------------------------------------------------------------------------
// OpenAI model descriptors. One table answers every model-dependent request
// question for BOTH OpenAI endpoints (Chat Completions and Responses), so an
// exact-model rule cannot be applied by one endpoint and missed by the other.
// Exact IDs win; otherwise ordered family fallbacks reproduce the historical
// regex baseline. An unknown ID resolves to a family (or the non-reasoning
// default) and never inherits an exact model's capabilities or pricing.
// ---------------------------------------------------------------------------

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type OpenAIEndpoint = 'chat' | 'responses';

/**
 * When a portable `ChatOptions.temperature` is dropped from the synthesized
 * body. Raw `providerOptions` fields are never stripped; a descriptor with
 * `validatesFinalBody` rejects them in {@link validateOpenAIFinalRequestBody}.
 *
 * - `never` — the portable value is always forwarded.
 * - `always` — the model rejects sampling even at its default reasoning.
 * - `when-effort-sent` — stripped only when Axl emits a reasoning effort
 *   (the historical GPT-5.x baseline).
 * - `unless-effort-none` — stripped unless the effective effort (the emitted
 *   one, or the model's declared default) is `none`.
 */
export type OpenAISamplingRestriction =
  | 'never'
  | 'always'
  | 'when-effort-sent'
  | 'unless-effort-none';

/** Chat Completions function-tool constraint. */
export type OpenAIChatToolPolicy = 'allowed' | 'never' | 'effort-none-only';

export type OpenAIModelDescriptor = {
  /** Exact model ID, or the family name for a fallback descriptor. */
  readonly id: string;
  readonly family: 'gpt-6' | 'gpt-5.6' | 'gpt-5-pro' | 'gpt-5' | 'o-series' | 'default';
  /** Whether Axl emits a reasoning effort for this model at all. */
  readonly reasoning: boolean;
  /**
   * Wire effort levels each endpoint accepts. A requested level outside the
   * list walks {@link EFFORT_FALLBACK} to the nearest accepted one: this is
   * where `max` is either native or mapped to `xhigh`, and where `none` and
   * `minimal` either pass through, become `minimal`, or become `low`.
   */
  readonly efforts: Readonly<Record<OpenAIEndpoint, readonly ReasoningEffort[]>>;
  /** The model's effort when none is sent. Declared only where it is documented. */
  readonly defaultEffort?: ReasoningEffort;
  readonly sampling: Readonly<Record<OpenAIEndpoint, OpenAISamplingRestriction>>;
  readonly chatTools: OpenAIChatToolPolicy;
  /**
   * Axl validates the final merged request (after `providerOptions`) against
   * this descriptor and rejects forbidden combinations before dispatch.
   */
  readonly validatesFinalBody: boolean;
  /** Pricing requires `total_tokens === prompt_tokens + completion_tokens`. */
  readonly strictUsageTotals: boolean;
};

/**
 * Nearest accepted level for an unsupported one. `high` is terminal: every
 * descriptor accepts it, and {@link clampToDescriptor} throws if one does not.
 */
const EFFORT_FALLBACK: Readonly<Partial<Record<ReasoningEffort, ReasoningEffort>>> = {
  none: 'minimal',
  minimal: 'low',
  low: 'medium',
  medium: 'high',
  max: 'xhigh',
  xhigh: 'high',
};

const BASE_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

function bothEndpoints<T>(value: T): Readonly<Record<OpenAIEndpoint, T>> {
  return { chat: value, responses: value };
}

/** GPT-6: native `max` on both endpoints; Axl owns the exact wire contract. */
function gpt6(
  id: string,
  efforts: readonly ReasoningEffort[],
  chatTools: OpenAIChatToolPolicy,
): OpenAIModelDescriptor {
  return {
    id,
    family: 'gpt-6',
    reasoning: true,
    efforts: bothEndpoints(efforts),
    defaultEffort: 'medium',
    sampling: bothEndpoints<OpenAISamplingRestriction>('never'),
    chatTools,
    validatesFinalBody: true,
    strictUsageTotals: true,
  };
}

/** GPT-5.6: native `max` on Responses only; Chat Completions caps it at `xhigh`. */
function gpt56(id: string): OpenAIModelDescriptor {
  const chat: readonly ReasoningEffort[] = ['none', ...BASE_EFFORTS, 'xhigh'];
  return {
    id,
    family: 'gpt-5.6',
    reasoning: true,
    efforts: { chat, responses: [...chat, 'max'] },
    // Responses rejects temperature even at the provider-default effort.
    sampling: { chat: 'when-effort-sent', responses: 'always' },
    chatTools: 'allowed',
    validatesFinalBody: false,
    strictUsageTotals: false,
  };
}

const OPENAI_EXACT_MODELS: ReadonlyMap<string, OpenAIModelDescriptor> = new Map(
  [
    gpt6('gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max'], 'never'),
    gpt6('gpt-6-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'effort-none-only'),
    gpt6('gpt-6-luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'effort-none-only'),
    gpt56('gpt-5.6'),
    gpt56('gpt-5.6-sol'),
    gpt56('gpt-5.6-terra'),
    gpt56('gpt-5.6-luna'),
  ].map((descriptor) => [descriptor.id, descriptor]),
);

const O_SERIES_DESCRIPTOR: OpenAIModelDescriptor = {
  id: 'o-series',
  family: 'o-series',
  reasoning: true,
  efforts: bothEndpoints(BASE_EFFORTS),
  defaultEffort: 'medium',
  sampling: bothEndpoints('always'),
  chatTools: 'allowed',
  validatesFinalBody: false,
  strictUsageTotals: false,
};

const GPT_5_PRO_DESCRIPTOR: OpenAIModelDescriptor = {
  id: 'gpt-5-pro',
  family: 'gpt-5-pro',
  reasoning: true,
  efforts: bothEndpoints(['high']),
  defaultEffort: 'high',
  sampling: bothEndpoints('when-effort-sent'),
  chatTools: 'allowed',
  validatesFinalBody: false,
  strictUsageTotals: false,
};

const DEFAULT_DESCRIPTOR: OpenAIModelDescriptor = {
  id: 'default',
  family: 'default',
  reasoning: false,
  // Never emitted (the model is not reasoning-capable); keeps the clamp total.
  efforts: bothEndpoints(BASE_EFFORTS),
  sampling: bothEndpoints('never'),
  chatTools: 'allowed',
  validatesFinalBody: false,
  strictUsageTotals: false,
};

/**
 * GPT-5.x family fallback for IDs without an exact entry, including unknown
 * snapshots. `none` arrives with gpt-5.1 and `xhigh` with the models after
 * gpt-5.1-codex-max (gpt-5.2+). Pre-5.1 models default to `medium`.
 */
function gpt5FamilyDescriptor(model: string): OpenAIModelDescriptor {
  const none = /^gpt-5\.[1-9]/.test(model);
  const xhigh = /^gpt-5\.([2-9]|\d{2,})/.test(model);
  const efforts: readonly ReasoningEffort[] = [
    ...(none ? (['none'] as const) : []),
    ...BASE_EFFORTS,
    ...(xhigh ? (['xhigh'] as const) : []),
  ];
  return {
    id: 'gpt-5',
    family: 'gpt-5',
    reasoning: true,
    efforts: bothEndpoints(efforts),
    ...(none ? {} : { defaultEffort: 'medium' as const }),
    sampling: bothEndpoints('when-effort-sent'),
    chatTools: 'allowed',
    validatesFinalBody: false,
    strictUsageTotals: false,
  };
}

/** Ordered family fallbacks; the first match wins after exact IDs. */
const OPENAI_FAMILY_FALLBACKS: readonly {
  readonly match: RegExp;
  readonly describe: (model: string) => OpenAIModelDescriptor;
}[] = [
  { match: /^(o1|o3|o4-mini)/, describe: () => O_SERIES_DESCRIPTOR },
  { match: /^gpt-5-pro/, describe: () => GPT_5_PRO_DESCRIPTOR },
  { match: /^gpt-5/, describe: gpt5FamilyDescriptor },
];

/** Resolve the one descriptor both OpenAI endpoints use for `model`. */
export function resolveOpenAIModelDescriptor(model: string): OpenAIModelDescriptor {
  const exact = OPENAI_EXACT_MODELS.get(model);
  if (exact) return exact;
  const family = OPENAI_FAMILY_FALLBACKS.find((entry) => entry.match.test(model));
  return family ? family.describe(model) : DEFAULT_DESCRIPTOR;
}

/** Nearest level `endpoint` accepts for `effort` on this descriptor. */
function clampToDescriptor(
  descriptor: OpenAIModelDescriptor,
  endpoint: OpenAIEndpoint,
  effort: ReasoningEffort,
): ReasoningEffort {
  const accepted = descriptor.efforts[endpoint];
  let candidate: ReasoningEffort | undefined = effort;
  while (candidate !== undefined && !accepted.includes(candidate)) {
    candidate = EFFORT_FALLBACK[candidate];
  }
  if (candidate === undefined) {
    throw new Error(
      `OpenAI descriptor '${descriptor.id}' accepts no ${endpoint} effort reachable from '${effort}'`,
    );
  }
  return candidate;
}

/** Whether the portable `temperature` is dropped from the synthesized body. */
export function stripsPortableSampling(
  descriptor: OpenAIModelDescriptor,
  endpoint: OpenAIEndpoint,
  wireEffort: ReasoningEffort | undefined,
): boolean {
  switch (descriptor.sampling[endpoint]) {
    case 'never':
      return false;
    case 'always':
      return true;
    case 'when-effort-sent':
      return wireEffort !== undefined;
    case 'unless-effort-none':
      return (wireEffort ?? descriptor.defaultEffort) !== 'none';
  }
}

/** Returns true for o-series models (o1, o3, o4-mini) that always reason. */
export function isOSeriesModel(model: string): boolean {
  return resolveOpenAIModelDescriptor(model).family === 'o-series';
}

/** Returns true for models that accept reasoning_effort. */
export function supportsReasoningEffort(model: string): boolean {
  return resolveOpenAIModelDescriptor(model).reasoning;
}

/** Returns true when the Responses endpoint accepts native `max` for `model`. */
export function supportsMaxReasoningEffort(model: string): boolean {
  return resolveOpenAIModelDescriptor(model).efforts.responses.includes('max');
}

/** Returns true for models that support reasoning_effort: 'none' (gpt-5.1+). */
export function supportsReasoningNone(model: string): boolean {
  return resolveOpenAIModelDescriptor(model).efforts.responses.includes('none');
}

/**
 * Returns true for models that support reasoning_effort: 'xhigh'.
 * Per OpenAI docs: "xhigh is supported for all models after gpt-5.1-codex-max."
 */
export function supportsXhigh(model: string): boolean {
  return resolveOpenAIModelDescriptor(model).efforts.responses.includes('xhigh');
}

/**
 * Clamp reasoning_effort to the levels Responses accepts for `model`. Chat
 * Completions clamps against its own list in {@link resolveOpenAIChatReasoningEffort}.
 */
export function clampReasoningEffort(model: string, effort: ReasoningEffort): ReasoningEffort {
  return clampToDescriptor(resolveOpenAIModelDescriptor(model), 'responses', effort);
}

/** Map budgetTokens to nearest OpenAI reasoning_effort. */
export function budgetToReasoningEffort(budget: number): ReasoningEffort {
  if (budget <= 1024) return 'low';
  if (budget <= 8192) return 'medium';
  return 'high';
}

function resolveEndpointReasoningEffort(
  model: string,
  endpoint: OpenAIEndpoint,
  resolved: ResolvedThinkingOptions,
): ReasoningEffort | undefined {
  const descriptor = resolveOpenAIModelDescriptor(model);
  if (!descriptor.reasoning) return undefined;
  const requested: ReasoningEffort | undefined = resolved.hasBudgetOverride
    ? budgetToReasoningEffort(resolved.thinkingBudget!)
    : !resolved.thinkingDisabled && resolved.activeEffort
      ? resolved.activeEffort
      : resolved.thinkingDisabled
        ? 'none'
        : undefined;
  return requested === undefined ? undefined : clampToDescriptor(descriptor, endpoint, requested);
}

/** Resolve portable thinking controls to the Responses `reasoning.effort` value. */
export function resolveOpenAIReasoningEffort(
  model: string,
  resolved: ResolvedThinkingOptions,
): ReasoningEffort | undefined {
  return resolveEndpointReasoningEffort(model, 'responses', resolved);
}

/** Resolve portable thinking controls to the Chat Completions `reasoning_effort` value. */
export function resolveOpenAIChatReasoningEffort(
  model: string,
  resolved: ResolvedThinkingOptions,
): ReasoningEffort | undefined {
  return resolveEndpointReasoningEffort(model, 'chat', resolved);
}

/**
 * Validate the final merged request (after `providerOptions`) for descriptors
 * with `validatesFinalBody`. Portable options are reconciled while the body is
 * built; anything still forbidden here was injected through a raw
 * `providerOptions` field and is rejected before dispatch.
 */
export function validateOpenAIFinalRequestBody(
  body: Record<string, unknown>,
  endpoint: OpenAIEndpoint,
): void {
  const model = body.model;
  if (typeof model !== 'string') return;
  const descriptor = resolveOpenAIModelDescriptor(model);
  if (!descriptor.validatesFinalBody) return;
  const provider = endpoint === 'chat' ? 'openai' : 'openai-responses';
  const fail = (option: string, remediation: string): never => {
    throw new UnsupportedModelOptionError({ provider, model, option, remediation });
  };
  const rawEffort =
    endpoint === 'chat'
      ? body.reasoning_effort
      : body.reasoning !== null && typeof body.reasoning === 'object'
        ? (body.reasoning as { effort?: unknown }).effort
        : undefined;
  const accepted = descriptor.efforts[endpoint];
  if (rawEffort !== undefined && !accepted.includes(rawEffort as ReasoningEffort)) {
    fail('reasoning effort', `Use one of: ${accepted.join(', ')}.`);
  }
  // Omitting effort uses the model's declared default, not `none`.
  const activeReasoning = (rawEffort ?? descriptor.defaultEffort) !== 'none';
  if (endpoint === 'chat' && descriptor.chatTools !== 'allowed') {
    const toolChoice = body.tool_choice;
    const toolIntent =
      (Array.isArray(body.tools) && body.tools.length > 0) ||
      (toolChoice !== undefined &&
        toolChoice !== null &&
        toolChoice !== 'none' &&
        toolChoice !== 'auto');
    if (toolIntent && (descriptor.chatTools === 'never' || activeReasoning)) {
      fail(
        'Chat Completions tool calling',
        descriptor.chatTools === 'never'
          ? `Use openai-responses:${model} for tools.`
          : `Use openai-responses:${model} for reasoning with tools, or set effective reasoning_effort to 'none'.`,
      );
    }
  }
  if (activeReasoning) {
    const forbidden =
      endpoint === 'chat'
        ? ['temperature', 'top_p', 'top_logprobs', 'logprobs']
        : ['temperature', 'top_p', 'top_logprobs'];
    for (const key of forbidden) {
      if (body[key] !== undefined)
        fail(key, `Remove ${key} or set reasoning effort to 'none' on Sol or Luna.`);
    }
    if (
      endpoint === 'responses' &&
      Array.isArray(body.include) &&
      body.include.includes('message.output_text.logprobs')
    ) {
      fail(
        'message.output_text.logprobs',
        'Remove it from include or set reasoning effort to none on Sol or Luna.',
      );
    }
  }
}

/**
 * Shared `Provider.effortResolution` body for both OpenAI endpoints: compare the
 * unified effort against the `reasoning_effort` the request actually carries.
 * Every OpenAI clamp (`'max'`→`'xhigh'` on Chat, `'none'`→`'minimal'` on
 * pre-5.1 models, `'xhigh'`→`'high'` below gpt-5.2, gpt-5-pro's `'high'`-only
 * floor) shows up as a difference, so no clamp list is duplicated here.
 *
 * An explicit `thinkingBudget` is documented to override `effort`, and a model
 * without reasoning support ignores the knob entirely — neither is reported.
 */
export function resolveOpenAIEffortResolution(
  options: Pick<
    ChatOptions,
    'model' | 'effort' | 'thinkingBudget' | 'includeThoughts' | 'providerOptions'
  >,
  resolveWireEffort: (model: string, resolved: ResolvedThinkingOptions) => string | undefined,
  endpoint: string,
): EffortResolution | undefined {
  const resolved = resolveThinkingOptions(options);
  if (resolved.effort === undefined || resolved.hasBudgetOverride) return undefined;
  const model =
    typeof options.providerOptions?.model === 'string'
      ? options.providerOptions.model
      : options.model;
  const effective = resolveWireEffort(model, resolved);
  if (effective === undefined || effective === resolved.effort) return undefined;
  return {
    requested: resolved.effort,
    effective,
    clamped: true,
    cause: `${endpoint} does not accept reasoning effort '${resolved.effort}' for ${model}; using '${effective}'`,
  };
}

/**
 * OpenAI Chat Completions reasoning emit. Computes `reasoning_effort` from the
 * unified effort/thinkingBudget knobs and signals when to strip the portable
 * `temperature`, both from the model's {@link OpenAIModelDescriptor}.
 * Non-reasoning models get neither.
 */
export const openaiReasoningEmit: ReasoningEmit = (body, resolved, model) => {
  const wireEffort = resolveOpenAIChatReasoningEffort(model, resolved);

  if (wireEffort) body.reasoning_effort = wireEffort;

  return {
    stripTemperature: stripsPortableSampling(
      resolveOpenAIModelDescriptor(model),
      'chat',
      wireEffort,
    ),
  };
};

/** Canonical OpenAI Chat Completions profile. */
export const OPENAI_PROFILE: ProviderProfile = {
  name: 'openai',
  label: 'OpenAI',
  defaultBaseUrl: OPENAI_DEFAULT_BASE_URL,
  envApiKey: 'OPENAI_API_KEY',
  envBaseUrl: 'OPENAI_BASE_URL',
  pricing: { kind: 'table', table: OPENAI_PRICING, match: 'exact' },
  reasoning: { emit: openaiReasoningEmit, capture: 'none' },
  capabilities: {
    // Chat Completions carries recorded audio via `input_audio` (wav/mp3 only).
    // Images are deliberately NOT declared: the Responses API serves images, and
    // Chat-Completions image pricing is unmodeled here (fork F4).
    inputModalities: {
      audio: { sources: ['bytes', 'base64'], formats: OPENAI_CHAT_AUDIO_FORMATS },
    },
  },
  roleFor: (role, model) => (role === 'system' && isOSeriesModel(model) ? 'developer' : role),
  maxTokensField: 'max_completion_tokens',
  parallelToolCalls: (model) => !isOSeriesModel(model),
};

/**
 * OpenAI provider (Chat Completions) — the canonical {@link OpenAICompatibleProvider}
 * profile. Preserved as a named export with its original constructor signature.
 *
 * Supports chat, tool calling, SSE streaming, structured output, and reasoning
 * models (o1/o3/o4-mini + GPT-5.x) via `reasoning_effort`.
 */
export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(
    options: {
      apiKey?: ApiKeySource;
      baseUrl?: string;
      dangerouslyAllowInsecureHttp?: boolean;
      rateLimit?: RateLimitConfig;
    } = {},
  ) {
    super({ profile: OPENAI_PROFILE, ...options });
  }

  /** Report a clamped `effort` — Chat Completions caps `'max'` at `'xhigh'` and
   *  rejects `'none'` before gpt-5.1 (clamped to `'minimal'`). */
  effortResolution(
    options: Pick<
      ChatOptions,
      'model' | 'effort' | 'thinkingBudget' | 'includeThoughts' | 'providerOptions'
    >,
  ): EffortResolution | undefined {
    return resolveOpenAIEffortResolution(
      options,
      resolveOpenAIChatReasoningEffort,
      'OpenAI Chat Completions',
    );
  }

  protected override validateFinalRequestBody(body: Record<string, unknown>): void {
    validateOpenAIFinalRequestBody(body, 'chat');
  }

  protected override computeCost(
    model: string,
    usage: ProviderResponse['usage'],
    _reportedCost: number | undefined,
    context?: DirectOpenAIPricingContext,
  ): number | undefined {
    return usage
      ? estimateDirectOpenAICost(model, usage, { ...context, baseUrl: this.baseUrl })
      : undefined;
  }
}
