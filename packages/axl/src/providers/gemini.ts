import type {
  EffortResolution,
  Provider,
  ChatOptions,
  ChatMessage,
  ProviderResponse,
  StreamChunk,
  ToolDefinition,
  ToolCallMessage,
  ProviderInputValidationRequest,
  ProviderInputValidationResult,
  ResolvedThinkingOptions,
} from './types.js';
import { resolveThinkingOptions, resolveApiKey, type ApiKeySource } from './types.js';
import { fetchWithRetry } from './retry.js';
import { CallTimingRecorder, withCallTiming, withChatTiming } from './call-timing.js';
import { buildProviderError, ProviderError } from './errors.js';
import { RateLimiter, type RateLimitConfig } from './rate-limiter.js';
import { assertSafeProviderBaseUrl } from '../http-transport.js';
import type { InputContentPart, InputMediaSource } from '../input.js';
import { UnsupportedModelInputError } from '../errors.js';

function hasRichGeminiMessages(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) => Array.isArray(message.content));
}

function geminiImageBase64(
  source: Extract<InputMediaSource, { type: 'bytes' | 'base64' }>,
): string {
  return source.type === 'base64'
    ? source.data
    : Buffer.from(source.data.buffer, source.data.byteOffset, source.data.byteLength).toString(
        'base64',
      );
}

function geminiInteractionContent(
  parts: readonly InputContentPart[],
  model: string,
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text });
      continue;
    }
    const { source } = part;
    if (source.type === 'provider-file') {
      if (source.provider !== 'google') {
        throw new UnsupportedModelInputError({
          provider: 'google',
          model,
          modality: 'image',
          source: 'provider-file',
        });
      }
      if (!source.mediaType) {
        throw new UnsupportedModelInputError({
          provider: 'google',
          model,
          modality: 'image',
          source: 'provider-file',
          feature: 'Interactions URI image mediaType',
        });
      }
      content.push({
        type: 'image',
        uri: source.reference,
        mime_type: source.mediaType,
      });
    } else if (source.type === 'url') {
      // Gemini's image guide routes URL-originated images through Files API.
      // Axl deliberately does not retrieve caller URLs or create hidden chat
      // uploads, so a raw HTTPS locator cannot reach this mapping.
      throw new UnsupportedModelInputError({
        provider: 'google',
        model,
        modality: 'image',
        source: 'url',
        feature: 'direct URL image input; pass bytes/base64 or a Gemini provider-file',
      });
    } else {
      content.push({ type: 'image', data: geminiImageBase64(source), mime_type: source.mediaType });
    }
    if (part.label) content.push({ type: 'text', text: `[Image: ${part.label}]` });
  }
  return content;
}

// ---------------------------------------------------------------------------
// Schema sanitization for Gemini's tool/responseSchema dialect.
//
// Gemini accepts a strict subset of OpenAPI 3.0 Schema Object — narrower
// than standard JSON Schema. Zod v4's `z.toJSONSchema()` emits Draft
// 2020-12 fields that Gemini rejects with a 400. Caught in the live
// integration test pass — every Zod-defined tool 400'd on first call.
//
//   Allowed:  type, format, description, nullable, enum, properties,
//             required, items, minItems, maxItems, minLength, maxLength,
//             minimum, maximum, pattern, anyOf, propertyOrdering, default,
//             title, minProperties, maxProperties, example, multipleOf
//   Rejected: additionalProperties, $schema, $ref, $defs, definitions,
//             not, allOf, oneOf, patternProperties, const,
//             unevaluatedProperties, unevaluatedItems
//
// Two fields get TRANSLATED rather than stripped because they're load-
// bearing for common Zod patterns:
//
//   `oneOf`  →  `anyOf`   — `z.discriminatedUnion()` produces `oneOf`.
//                            Naive stripping would erase the entire union
//                            shape and Gemini would have no schema for
//                            the field. The two are semantically identical
//                            for tool-use (the discriminator field already
//                            enforces mutual exclusion at the consumer
//                            site).
//
//   `const: x`  →  `enum: [x]`  — `z.literal('foo')` produces `const`.
//                            Naive stripping would lose the constraint
//                            entirely. `enum` with a single value is
//                            Gemini's supported equivalent. (If both
//                            `const` and `enum` are present, the explicit
//                            `enum` wins — we don't clobber.)
//
// `allOf` is stripped (rare in Zod output and merging it correctly is
// non-trivial — schema intersections that survive `allOf` removal will
// surface as a schema validation retry on our side, which is acceptable
// degradation). The function recurses through every value so an inner
// `additionalProperties: false` on a nested object also gets removed —
// the 400 fires at any depth.
//
// Loss without `additionalProperties: false`: the LLM has slightly less
// guidance about strict-mode schemas, so it may occasionally emit extra
// fields. Default Zod (`z.object`) silently strips them on parse, so the
// user sees clean data; `.strict()` schemas trigger our schema retry
// loop. Net cost: a handful of extra tokens, occasional retry. Not a
// correctness issue.
// ---------------------------------------------------------------------------

const GEMINI_DISALLOWED_SCHEMA_KEYS = new Set([
  'additionalProperties',
  '$schema',
  '$ref',
  '$defs',
  'definitions',
  'not',
  'allOf',
  'patternProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
]);

function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchemaForGemini(item));
  }
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (GEMINI_DISALLOWED_SCHEMA_KEYS.has(key)) continue;
    if (key === 'oneOf') {
      // Translate to anyOf — preserves z.discriminatedUnion's union shape.
      out.anyOf = sanitizeSchemaForGemini(value);
      continue;
    }
    if (key === 'const') {
      // Translate to enum with one element — preserves z.literal's
      // constraint. Skip if `enum` is also set so we don't clobber an
      // explicit enum the schema author already wrote.
      if (!('enum' in src)) out.enum = [value];
      continue;
    }
    out[key] = sanitizeSchemaForGemini(value);
  }
  return out;
}

function parseGeminiFunctionResponse(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { result: content };
  }

  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : { result: parsed };
}

// ---------------------------------------------------------------------------
// Per-token Standard-tier pricing (USD) for supported current Gemini models.
// Reviewed 2026-09-03 against https://ai.google.dev/gemini-api/docs/pricing.
// Promotional rates are recorded at their current value, never as a
// forward-dated transition -- an announced revert can be cancelled, and a
// clock-gated table then silently misprices from the date it predicted.
// The 3.6/3.7/3.8 Flash promotion is announced through 2026-12-31 ($1.50 /
// $0.15 / $7.50 after); re-verify then rather than encoding the change here.
// Model ids deliberately match exactly: a date/version suffix can change the
// billing contract, so an unknown sibling must remain unpriced.
// ---------------------------------------------------------------------------

type GeminiRate = {
  input: number;
  cached: number;
  output: number;
  longContext?: { input: number; cached: number; output: number };
};

const GEMINI_PRICING: Record<string, GeminiRate> = {
  'gemini-2.5-pro': {
    input: 1.25e-6,
    cached: 0.125e-6,
    output: 10e-6,
    longContext: { input: 2.5e-6, cached: 0.25e-6, output: 15e-6 },
  },
  'gemini-2.5-flash': { input: 0.3e-6, cached: 0.03e-6, output: 2.5e-6 },
  'gemini-2.5-flash-lite': { input: 0.1e-6, cached: 0.01e-6, output: 0.4e-6 },
  'gemini-3.1-pro-preview': {
    input: 2e-6,
    cached: 0.2e-6,
    output: 12e-6,
    longContext: { input: 4e-6, cached: 0.4e-6, output: 18e-6 },
  },
  'gemini-3.1-pro-preview-customtools': {
    input: 2e-6,
    cached: 0.2e-6,
    output: 12e-6,
    longContext: { input: 4e-6, cached: 0.4e-6, output: 18e-6 },
  },
  'gemini-3.1-flash-lite': { input: 0.25e-6, cached: 0.025e-6, output: 1.5e-6 },
  'gemini-3.5-flash': { input: 1.5e-6, cached: 0.15e-6, output: 9e-6 },
  'gemini-3.5-flash-lite': { input: 0.3e-6, cached: 0.03e-6, output: 2.5e-6 },
  'gemini-3.6-flash': { input: 0.75e-6, cached: 0.075e-6, output: 3.75e-6 },
  'gemini-3.7-flash': { input: 0.75e-6, cached: 0.075e-6, output: 3.75e-6 },
  'gemini-3.8-flash': { input: 0.75e-6, cached: 0.075e-6, output: 3.75e-6 },
};

type GeminiPriceUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
};

type GeminiPricingContext = {
  model: string;
  serviceTier?: unknown;
  eligibleRequest: boolean;
};

type NormalizedGeminiUsage = {
  usage: NonNullable<ProviderResponse['usage']>;
  pricingUsage: GeminiPriceUsage;
  hasUnmodeledBilledUsage: boolean;
};

function isValidTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStandardGeminiRequestTier(value: unknown): boolean {
  return (
    value === undefined || value === 'SERVICE_TIER_UNSPECIFIED' || value === 'SERVICE_TIER_STANDARD'
  );
}

function isDefinitiveStandardGeminiResponseTier(value: unknown): boolean {
  return (
    value === 'SERVICE_TIER_UNSPECIFIED' ||
    value === 'SERVICE_TIER_STANDARD' ||
    value === 'standard'
  );
}

/** Interactions string codes mapped from Google's current standard API error table. */
function geminiInteractionErrorStatus(code: string | number | undefined): number | undefined {
  if (typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599) {
    return code;
  }
  switch (code) {
    case 'invalid_request':
    case 'invalid_argument':
    case 'parameter_unknown':
    case 'failed_precondition':
      return 400;
    case 'authentication':
    case 'unauthenticated':
      return 401;
    case 'permission_denied':
      return 403;
    case 'not_found':
    case 'model_not_found':
      return 404;
    case 'request_timeout':
      return 408;
    case 'conflict':
    case 'already_exists':
      return 409;
    case 'request_too_large':
      return 413;
    case 'out_of_range':
      return 416;
    case 'quota_exceeded':
    case 'resource_exhausted':
    case 'rate_limit_exceeded':
      return 429;
    case 'cancelled':
      return 499;
    case 'api_error':
    case 'internal':
    case 'internal_server_error':
      return 500;
    case 'bad_gateway':
      return 502;
    case 'unavailable':
    case 'service_unavailable':
      return 503;
    case 'deadline_exceeded':
    case 'gateway_timeout':
      return 504;
    default:
      return undefined;
  }
}

function isEligibleGeminiPricing(
  context: GeminiPricingContext,
  hasDefinitiveStandardResponseTier: boolean,
  hasInvalidResponseTier: boolean,
): boolean {
  return (
    context.eligibleRequest &&
    isStandardGeminiRequestTier(context.serviceTier) &&
    hasDefinitiveStandardResponseTier &&
    !hasInvalidResponseTier
  );
}

function estimateGeminiCost(model: string, usage: GeminiPriceUsage): number | undefined {
  const pricing = GEMINI_PRICING[model];
  const cached = usage.cachedTokens ?? 0;
  if (
    !pricing ||
    !isValidTokenCount(usage.inputTokens) ||
    !isValidTokenCount(usage.outputTokens) ||
    !isValidTokenCount(cached) ||
    cached > usage.inputTokens
  ) {
    return undefined;
  }

  const rate = usage.inputTokens > 200_000 && pricing.longContext ? pricing.longContext : pricing;
  return (
    (usage.inputTokens - cached) * rate.input +
    cached * rate.cached +
    usage.outputTokens * rate.output
  );
}

function safeTokenSum(...values: number[]): number | undefined {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

function normalizeGeminiUsage(raw: GeminiUsageMetadata): NormalizedGeminiUsage | undefined {
  const inputTokens = raw.promptTokenCount;
  const completionTokens = raw.candidatesTokenCount;
  const totalTokens = raw.totalTokenCount;
  const cachedTokens = raw.cachedContentTokenCount ?? 0;
  const reasoningTokens = raw.thoughtsTokenCount ?? 0;
  const toolUsePromptTokens = raw.toolUsePromptTokenCount ?? 0;
  if (
    !isValidTokenCount(inputTokens) ||
    !isValidTokenCount(completionTokens) ||
    !isValidTokenCount(totalTokens) ||
    !isValidTokenCount(cachedTokens) ||
    !isValidTokenCount(reasoningTokens) ||
    !isValidTokenCount(toolUsePromptTokens) ||
    cachedTokens > inputTokens
  ) {
    return undefined;
  }

  // Gemini reports candidate output and thinking output separately. Its public
  // Axl completion count intentionally remains candidatesTokenCount semantics,
  // while billing includes thoughts exactly once.
  const billedOutputTokens = safeTokenSum(completionTokens, reasoningTokens);
  const expectedTotal = safeTokenSum(
    inputTokens,
    completionTokens,
    reasoningTokens,
    toolUsePromptTokens,
  );
  if (
    billedOutputTokens === undefined ||
    expectedTotal === undefined ||
    totalTokens !== expectedTotal
  ) {
    return undefined;
  }

  return {
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      cached_tokens: cachedTokens > 0 ? cachedTokens : undefined,
      reasoning_tokens: reasoningTokens > 0 ? reasoningTokens : undefined,
    },
    pricingUsage: {
      inputTokens,
      outputTokens: billedOutputTokens,
      cachedTokens,
    },
    hasUnmodeledBilledUsage: toolUsePromptTokens !== 0,
  };
}

/** Default thinking budget tokens for each effort level (Gemini 2.x). */
const THINKING_BUDGETS: Record<string, number> = {
  low: 1024,
  medium: 5000,
  high: 10000,
  xhigh: 16384, // between high (10000) and max (24576)
  max: 24576,
};

/** Gemini 3.x thinkingLevel values mapped from unified effort levels. */
const THINKING_LEVELS: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high', // 3.x has no xhigh tier; clamp to 'high'
  max: 'high', // 3.x caps at 'high'
};

/** Exact Gemini 3.x descriptors with thinkingLevel support. */
const GEMINI_3X_MIN_THINKING_LEVEL = new Map<string, string>([
  ['gemini-3-pro-preview', 'minimal'],
  ['gemini-3-flash-preview', 'minimal'],
  ['gemini-3.1-pro-preview', 'low'],
  ['gemini-3.1-pro-preview-customtools', 'low'],
  ['gemini-3.1-flash-lite', 'minimal'],
  ['gemini-3.1-flash-lite-preview', 'minimal'],
  ['gemini-3.5-flash', 'minimal'],
  ['gemini-3.5-flash-lite', 'minimal'],
  ['gemini-3.6-flash', 'minimal'],
  // L4 live evidence: Interactions gemini-3.7-flash accepts low/medium/high,
  // but rejects minimal. Keep this exact entry isolated from legacy aliases.
  ['gemini-3.7-flash', 'low'],
  // Current-model live evidence: gemini-3.8-flash has the same low floor.
  ['gemini-3.8-flash', 'low'],
]);

const GEMINI_MODELS_WITHOUT_PORTABLE_TEMPERATURE = new Set([
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
]);

/** Check whether this exact descriptor uses thinkingLevel rather than thinkingBudget. */
function isGemini3x(model: string): boolean {
  return GEMINI_3X_MIN_THINKING_LEVEL.has(model);
}

/**
 * Map thinkingBudget to Gemini thinkingLevel.
 *
 * Gemini 3.x uses `thinkingLevel` (string enum: 'low' | 'medium' | 'high').
 * Gemini 2.x uses `thinkingBudget` (integer token count).
 * Budget form `{ budgetTokens }` maps to nearest `thinkingLevel` on 3.x,
 * exact `thinkingBudget` on 2.x.
 */
function budgetToThinkingLevel(budgetTokens: number): string {
  if (budgetTokens <= 1024) return 'low';
  if (budgetTokens <= 5000) return 'medium';
  return 'high';
}

/** Get the minimum supported thinkingLevel for a 3.x model. */
function minThinkingLevel(model: string): string {
  return GEMINI_3X_MIN_THINKING_LEVEL.get(model) ?? 'minimal';
}

/**
 * Endpoint-neutral resolution of Gemini's thinking controls.
 *
 * Gemini has two request shapes with different native fields for the SAME
 * portable knobs: the Interactions endpoint always speaks `thinking_level`
 * (even for 2.x), while `generateContent` speaks `thinkingConfig.thinkingLevel`
 * on 3.x and `thinkingConfig.thinkingBudget` on 2.x. This carries the rendering
 * for both so the mapping lives in exactly one place — including for
 * `effortResolution`, which must report what the request builders will send.
 */
type GeminiThinkingResolution = {
  /** `generation_config.thinking_level` for the Interactions endpoint. */
  interactionLevel: string | undefined;
  /** `thinkingConfig.thinkingLevel` for `generateContent` (3.x models). */
  thinkingLevel: string | undefined;
  /** `thinkingConfig.thinkingBudget` for `generateContent` (2.x models). */
  thinkingBudget: number | undefined;
  /** Whether `generateContent` attaches `includeThoughts` to the config. */
  attachThoughts: boolean;
  /** Set only when the unified effort could not be honored as requested. */
  clamp?: { effective: string; cause: string };
};

/**
 * Map the portable thinking knobs onto Gemini's native controls. Pure; the
 * single source of truth for both request builders and `effortResolution`.
 *
 * Clamps reported (R7a): only where the *unified* effort cannot be honored —
 * 3.x `'none'` (thinking cannot be disabled at all, so the model's minimum
 * level is sent) and 3.x `'xhigh'`/`'max'` (3.x caps at `'high'`). A 2.x model
 * disabling thinking honors the request exactly and is not a clamp.
 */
function resolveGeminiThinking(
  model: string,
  resolved: ResolvedThinkingOptions,
): GeminiThinkingResolution {
  const is3x = isGemini3x(model);

  if (resolved.thinkingDisabled) {
    const minLevel = minThinkingLevel(model);
    if (is3x) {
      return {
        interactionLevel: minLevel,
        thinkingLevel: minLevel,
        thinkingBudget: undefined,
        attachThoughts: false,
        // A `thinkingBudget: 0` disable has no unified effort to report against;
        // only an explicit `effort: 'none'` is a clamp of a requested value.
        clamp:
          resolved.effort === 'none'
            ? {
                effective: minLevel,
                cause: `Gemini 3.x models cannot disable thinking; using the model minimum thinking level '${minLevel}'`,
              }
            : undefined,
      };
    }
    return {
      interactionLevel: 'minimal',
      thinkingLevel: undefined,
      thinkingBudget: 0,
      attachThoughts: false,
    };
  }

  if (resolved.hasBudgetOverride) {
    const budget = resolved.thinkingBudget!;
    const level = budgetToThinkingLevel(budget);
    return {
      interactionLevel: level,
      thinkingLevel: is3x ? level : undefined,
      thinkingBudget: is3x ? undefined : budget,
      attachThoughts: resolved.includeThoughts,
    };
  }

  if (resolved.activeEffort) {
    const effort = resolved.activeEffort;
    const budget = THINKING_BUDGETS[effort] ?? 5000;
    if (is3x) {
      const level = THINKING_LEVELS[effort] ?? 'medium';
      return {
        interactionLevel: level,
        thinkingLevel: level,
        thinkingBudget: undefined,
        attachThoughts: resolved.includeThoughts,
        clamp:
          level === effort
            ? undefined
            : {
                effective: level,
                cause: `Gemini 3.x thinking levels cap at 'high'; effort '${effort}' maps to '${level}'`,
              },
      };
    }
    return {
      interactionLevel: budgetToThinkingLevel(budget),
      thinkingLevel: undefined,
      // 2.5 Pro supports a higher max budget (32768) than other 2.5 models (24576).
      thinkingBudget: effort === 'max' && model === 'gemini-2.5-pro' ? 32768 : budget,
      attachThoughts: resolved.includeThoughts,
    };
  }

  return {
    interactionLevel: undefined,
    thinkingLevel: undefined,
    thinkingBudget: undefined,
    attachThoughts: resolved.includeThoughts,
  };
}

/**
 * Google Gemini provider using raw fetch (no SDK dependency).
 *
 * Supports:
 * - Chat completions via generateContent
 * - Tool calling (functionCall / functionResponse)
 * - Streaming via SSE (streamGenerateContent)
 * - Structured output via responseMimeType / responseSchema
 *
 * Message mapping:
 * - "system" role messages are extracted into the top-level `system_instruction` param
 * - "assistant" role is mapped to "model" role
 * - "tool" role messages are mapped to user messages with functionResponse parts
 * - assistant messages with tool_calls are mapped to functionCall parts
 */
export class GeminiProvider implements Provider {
  readonly name = 'google';
  readonly reportsRequestLifecycle = true as const;

  inputCapabilities(model: string): { image?: { sources: readonly InputMediaSource['type'][] } } {
    // Interactions accepts inline data and Gemini Files URIs. Axl never
    // retrieves caller URLs or creates hidden image uploads.
    return model.trim().length > 0
      ? { image: { sources: ['bytes', 'base64', 'provider-file'] } }
      : {};
  }

  validateInput(request: ProviderInputValidationRequest): ProviderInputValidationResult {
    const modelOverride = request.providerOptions?.model;
    const effectiveModel = typeof modelOverride === 'string' ? modelOverride : request.model;
    const fail = (source?: string, feature?: string): never => {
      throw new UnsupportedModelInputError({
        provider: this.name,
        model: effectiveModel || request.model,
        modality: 'image',
        ...(source ? { source } : {}),
        ...(feature ? { feature } : {}),
      });
    };
    if (
      request.providerOptions &&
      'model' in request.providerOptions &&
      (typeof modelOverride !== 'string' || modelOverride.trim().length === 0)
    ) {
      fail(undefined, 'invalid model providerOptions');
    }
    if (effectiveModel.trim().length === 0) {
      fail(undefined, 'image input for this model');
    }
    if (request.providerOptions) {
      const forbidden = [
        'input',
        'contents',
        'messages',
        'previous_interaction_id',
        'background',
        'stream',
        'store',
      ].find((key) => key in request.providerOptions!);
      if (forbidden) fail(undefined, `raw ${forbidden} providerOptions`);
    }
    for (const message of request.history) {
      if (!Array.isArray(message.content)) continue;
      if (message.role !== 'user') fail(undefined, 'rich non-user history');
      for (const part of message.content) {
        if (part.type !== 'image') continue;
        if (part.source.type === 'url')
          fail('url', 'direct URL image input; pass bytes/base64 or a Gemini provider-file');
        if (part.source.type === 'provider-file' && part.source.provider !== this.name)
          fail('provider-file');
        if (part.source.type === 'provider-file' && !part.source.mediaType)
          fail('provider-file', 'Interactions URI image mediaType');
      }
    }
    if (Array.isArray(request.input)) {
      for (const part of request.input) {
        if (part.type !== 'image') continue;
        if (part.source.type === 'url')
          fail('url', 'direct URL image input; pass bytes/base64 or a Gemini provider-file');
        if (part.source.type === 'provider-file' && part.source.provider !== this.name)
          fail('provider-file');
        if (part.source.type === 'provider-file' && !part.source.mediaType)
          fail('provider-file', 'Interactions URI image mediaType');
      }
    }
    return { effectiveModel };
  }

  /** Gemini accepts a `responseSchema` but `sanitizeSchemaForGemini` strips
   *  keywords it doesn't support (`$ref`/`$defs`/`additionalProperties`/…), so a
   *  derived schema can lose constraints — lossy, not faithful. */
  nativeStructuredOutputSupport(): 'lossy' {
    return 'lossy';
  }

  /** Report a clamped `effort` (R7a). Gemini 3.x cannot disable thinking and
   *  caps at `'high'`, so `'none'`, `'xhigh'` and `'max'` are not honored
   *  verbatim there. Everything else — including 2.x disabled thinking — is
   *  sent as asked, so there is nothing to report. */
  effortResolution(
    options: Pick<
      ChatOptions,
      'model' | 'effort' | 'thinkingBudget' | 'includeThoughts' | 'providerOptions'
    >,
  ): EffortResolution | undefined {
    const resolved = resolveThinkingOptions(options);
    if (resolved.effort === undefined) return undefined;
    const clamp = resolveGeminiThinking(this.requestModel(options), resolved).clamp;
    return clamp
      ? {
          requested: resolved.effort,
          effective: clamp.effective,
          clamped: true,
          cause: clamp.cause,
        }
      : undefined;
  }

  private baseUrl: string;
  private apiKeySource: ApiKeySource;
  private callCounter = 0;
  private governor?: RateLimiter;

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
      'Google provider',
      options.dangerouslyAllowInsecureHttp,
    );
    this.governor = options.rateLimit ? new RateLimiter(options.rateLimit) : undefined;

    // Eager validation for the string case; a function source is validated per
    // request in resolveKey().
    if (typeof this.apiKeySource === 'string' && !this.apiKeySource) {
      throw new Error('Google API key is required. Set GOOGLE_API_KEY or pass apiKey in options.');
    }
  }

  /** Resolve the API key for one request (supports an expiring-token callback). */
  private async resolveKey(): Promise<string> {
    const key = await resolveApiKey(this.apiKeySource);
    if (!key) {
      throw new Error('Google API key is required. Set GOOGLE_API_KEY or pass apiKey in options.');
    }
    return key;
  }

  // ---------------------------------------------------------------------------
  // chat - non-streaming completion
  // ---------------------------------------------------------------------------

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    if (hasRichGeminiMessages(messages)) return this.chatInteraction(messages, options);
    const body = this.buildRequestBody(messages, options);
    const pricingContext = this.pricingContext(this.requestModel(options), body);
    this.assertSafeGemini3Continuation(messages, pricingContext.model);
    const headers = this.buildHeaders(await this.resolveKey());

    const recorder = new CallTimingRecorder(options.requestLifecycle);
    const res = await fetchWithRetry(
      `${this.baseUrl}/models/${pricingContext.model}:generateContent`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      },
      { governor: this.governor, provider: this.name, timing: recorder.observer },
    );

    if (!res.ok) {
      const errorBody = await res.text();
      const message = this.extractErrorMessage(errorBody, res.status);
      throw buildProviderError({
        provider: this.name,
        status: res.status,
        headers: res.headers,
        message,
        body: errorBody,
        timing: recorder.chatTiming(),
      });
    }

    const json = (await res.json()) as GeminiResponse;
    return withChatTiming(recorder, this.parseResponse(json, pricingContext));
  }

  // ---------------------------------------------------------------------------
  // stream - SSE streaming completion
  // ---------------------------------------------------------------------------

  async *stream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    if (hasRichGeminiMessages(messages)) {
      yield* this.streamInteraction(messages, options);
      return;
    }
    const body = this.buildRequestBody(messages, options);
    const pricingContext = this.pricingContext(this.requestModel(options), body);
    this.assertSafeGemini3Continuation(messages, pricingContext.model);
    const headers = this.buildHeaders(await this.resolveKey());

    const recorder = new CallTimingRecorder(options.requestLifecycle);
    const res = await fetchWithRetry(
      `${this.baseUrl}/models/${pricingContext.model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      },
      { governor: this.governor, provider: this.name, timing: recorder.observer },
    );

    if (!res.ok) {
      const errorBody = await res.text();
      const message = this.extractErrorMessage(errorBody, res.status);
      throw buildProviderError({
        provider: this.name,
        status: res.status,
        headers: res.headers,
        message,
        body: errorBody,
        timing: recorder.chatTiming(),
      });
    }

    if (!res.body) {
      throw new Error('Gemini stream response has no body');
    }

    yield* withCallTiming(recorder, this.parseSSEStream(res.body, pricingContext, recorder));
  }

  // ---------------------------------------------------------------------------
  // Rich image requests use Gemini Interactions. It is deliberately stateless:
  // Axl sends the complete application-owned history and never asks Google to
  // retain an interaction or follow a previous_interaction_id.
  // ---------------------------------------------------------------------------

  private async chatInteraction(
    messages: ChatMessage[],
    options: ChatOptions,
  ): Promise<ProviderResponse> {
    this.assertSafeInteractionOptions(options);
    const body = this.buildInteractionRequestBody(messages, options, false);
    const headers = this.buildHeaders(await this.resolveKey());
    const recorder = new CallTimingRecorder(options.requestLifecycle);
    const res = await fetchWithRetry(
      `${this.baseUrl}/interactions`,
      { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal },
      { governor: this.governor, provider: this.name, timing: recorder.observer },
    );
    if (!res.ok) {
      const errorBody = await res.text();
      throw buildProviderError({
        provider: this.name,
        status: res.status,
        headers: res.headers,
        message: this.extractErrorMessage(errorBody, res.status),
        body: errorBody,
        timing: recorder.chatTiming(),
      });
    }
    return withChatTiming(
      recorder,
      this.parseInteractionResponse((await res.json()) as GeminiInteractionResponse),
    );
  }

  private async *streamInteraction(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncGenerator<StreamChunk> {
    this.assertSafeInteractionOptions(options);
    const body = this.buildInteractionRequestBody(messages, options, true);
    const headers = this.buildHeaders(await this.resolveKey());
    const recorder = new CallTimingRecorder(options.requestLifecycle);
    const res = await fetchWithRetry(
      `${this.baseUrl}/interactions?alt=sse`,
      { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal },
      { governor: this.governor, provider: this.name, timing: recorder.observer },
    );
    if (!res.ok) {
      const errorBody = await res.text();
      throw buildProviderError({
        provider: this.name,
        status: res.status,
        headers: res.headers,
        message: this.extractErrorMessage(errorBody, res.status),
        body: errorBody,
        timing: recorder.chatTiming(),
      });
    }
    if (!res.body) throw new Error('Gemini Interactions stream has no body');
    yield* withCallTiming(
      recorder,
      this.parseInteractionSSEStream(res.body, res.headers, recorder),
    );
  }

  private buildInteractionRequestBody(
    messages: ChatMessage[],
    options: ChatOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const model = this.requestModel(options);
    const systemInstruction = messages
      .filter((message) => message.role === 'system')
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .filter(Boolean)
      .join('\n\n');
    const body: Record<string, unknown> = {
      model,
      input: this.mapInteractionInput(
        messages.filter((message) => message.role !== 'system'),
        model,
      ),
      stream,
    };
    if (systemInstruction) body.system_instruction = systemInstruction;
    if (options.tools?.length) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: sanitizeSchemaForGemini(tool.function.parameters),
      }));
    }
    const generationConfig: Record<string, unknown> = {};
    if (options.maxTokens !== undefined) generationConfig.max_output_tokens = options.maxTokens;
    if (options.stop) generationConfig.stop_sequences = options.stop;
    if (options.toolChoice !== undefined) {
      generationConfig.tool_choice =
        typeof options.toolChoice === 'string'
          ? options.toolChoice === 'required'
            ? 'any'
            : options.toolChoice
          : { allowed_tools: { mode: 'any', tools: [options.toolChoice.function.name] } };
    }
    const thinking = resolveThinkingOptions(options);
    // The Interactions endpoint is always level-based, even for 2.x.
    const thinkingPlan = resolveGeminiThinking(model, thinking);
    if (thinkingPlan.interactionLevel !== undefined) {
      generationConfig.thinking_level = thinkingPlan.interactionLevel;
    }
    if (thinking.includeThoughts) generationConfig.thinking_summaries = 'auto';
    if (Object.keys(generationConfig).length) body.generation_config = generationConfig;
    if (options.responseFormat?.type && options.responseFormat.type !== 'text') {
      body.response_format = {
        type: 'text',
        mime_type: 'application/json',
        ...(options.responseFormat.type === 'json_schema'
          ? { schema: sanitizeSchemaForGemini(options.responseFormat.json_schema.schema) }
          : {}),
      };
    }
    if (options.providerOptions) {
      const overrides = { ...options.providerOptions };
      delete overrides.model;
      delete overrides.input;
      delete overrides.contents;
      delete overrides.messages;
      delete overrides.previous_interaction_id;
      delete overrides.background;
      delete overrides.stream;
      delete overrides.store;
      const rawGenerationConfig = overrides.generation_config;
      if (
        rawGenerationConfig &&
        typeof rawGenerationConfig === 'object' &&
        !Array.isArray(rawGenerationConfig)
      ) {
        const generationConfigOverrides = { ...(rawGenerationConfig as Record<string, unknown>) };
        delete generationConfigOverrides.temperature;
        if (Object.keys(generationConfigOverrides).length)
          overrides.generation_config = generationConfigOverrides;
        else delete overrides.generation_config;
      }
      Object.assign(body, overrides);
    }
    // Method selection and retention are transport invariants, never an escape hatch.
    body.stream = stream;
    body.store = false;
    return body;
  }

  private assertSafeInteractionOptions(options: ChatOptions): void {
    const modelOverride = options.providerOptions?.model;
    const model = this.requestModel(options);
    const fail = (feature: string): never => {
      throw new UnsupportedModelInputError({
        provider: this.name,
        model,
        modality: 'image',
        feature,
      });
    };
    if (
      options.providerOptions &&
      'model' in options.providerOptions &&
      (typeof modelOverride !== 'string' || modelOverride.trim().length === 0)
    ) {
      fail('invalid model providerOptions');
    }
    if (model.trim().length === 0) fail('image input for this model');
    const forbidden = [
      'input',
      'contents',
      'messages',
      'previous_interaction_id',
      'background',
      'stream',
      'store',
    ].find((key) => key in (options.providerOptions ?? {}));
    if (forbidden) fail(`raw ${forbidden} providerOptions`);
  }

  private mapInteractionInput(messages: ChatMessage[], model: string): GeminiInteractionStep[] {
    const steps: GeminiInteractionStep[] = [];
    for (const message of messages) {
      if (message.role === 'user') {
        steps.push({
          type: 'user_input',
          content: Array.isArray(message.content)
            ? geminiInteractionContent(message.content, model)
            : [{ type: 'text', text: message.content }],
        });
      } else if (message.role === 'assistant') {
        const nativeSteps = message.providerMetadata?.geminiInteractionSteps;
        if (Array.isArray(nativeSteps) && nativeSteps.every(isGeminiInteractionStep)) {
          steps.push(...nativeSteps);
          continue;
        }
        if (typeof message.content === 'string' && message.content) {
          steps.push({ type: 'model_output', content: [{ type: 'text', text: message.content }] });
        }
        for (const call of message.tool_calls ?? []) {
          steps.push({
            type: 'function_call',
            id: call.id,
            name: call.function.name,
            arguments: safeJsonObject(call.function.arguments),
          });
        }
      } else if (message.role === 'tool') {
        steps.push({
          type: 'function_result',
          call_id: message.tool_call_id ?? '',
          result: [
            { type: 'text', text: typeof message.content === 'string' ? message.content : '' },
          ],
        });
      }
    }
    return steps;
  }

  private parseInteractionResponse(json: GeminiInteractionResponse): ProviderResponse {
    let content = '';
    let thinkingContent = '';
    const toolCalls: ToolCallMessage[] = [];
    for (const step of json.steps ?? []) {
      if (step.type === 'model_output') content += interactionText(step.content);
      else if (step.type === 'thought') thinkingContent += interactionText(step.summary);
      else if (step.type === 'function_call' && step.id && step.name) {
        toolCalls.push({
          id: step.id,
          type: 'function',
          function: { name: step.name, arguments: JSON.stringify(step.arguments ?? {}) },
        });
      }
    }
    this.assertInteractionTerminalStatus(json.status, toolCalls.length);
    const usage = normalizeInteractionUsage(json.usage);
    return {
      content,
      thinking_content: thinkingContent || undefined,
      tool_calls: toolCalls.length ? toolCalls : undefined,
      usage,
      // Interactions returns modality usage but no authoritative monetary cost.
      cost: undefined,
      providerMetadata: json.steps?.length
        ? { geminiInteractionSteps: json.steps.filter(isGeminiInteractionStep) }
        : undefined,
    };
  }

  private async *parseInteractionSSEStream(
    body: ReadableStream<Uint8Array>,
    responseHeaders: Headers,
    timing: CallTimingRecorder,
  ): AsyncGenerator<StreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const steps = new Map<number, GeminiInteractionStep>();
    const argumentBuffers = new Map<number, string>();
    const stopped = new Set<number>();
    let completed = false;
    try {
      while (true) {
        const { done, value } = await timing.read(reader);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          if (trimmed.slice(6) === '[DONE]') continue;
          let event: GeminiInteractionSSEEvent;
          try {
            event = JSON.parse(trimmed.slice(6)) as GeminiInteractionSSEEvent;
          } catch {
            continue;
          }
          if (event.event_type === 'error') {
            const status = geminiInteractionErrorStatus(event.error?.code);
            const message = event.error?.message ?? 'Gemini Interactions stream failed';
            // Mid-stream failure: headers and some body already arrived, so
            // stream semantics (read waits, first token) are the honest read.
            if (status !== undefined) {
              throw buildProviderError({
                provider: this.name,
                status,
                headers: responseHeaders,
                message,
                timing: timing.streamTiming(),
              });
            }
            // Unmappable provider error code, but the response is real and
            // partly consumed — same rule as every other mid-stream frame.
            throw new ProviderError({
              provider: this.name,
              status: 0,
              retryable: false,
              message,
              timing: timing.streamTiming(),
            });
          }
          if (event.event_type === 'step.start' && event.step) {
            const index = event.index;
            if (index === undefined || steps.has(index)) {
              throw new Error('Gemini Interactions stream contained an invalid step.start index');
            }
            const step = cloneInteractionStep(event.step);
            steps.set(index, step);
            if (step.type === 'model_output') {
              for (const text of interactionTextChunks(step.content)) {
                yield { type: 'text_delta', content: text };
              }
            } else if (step.type === 'thought') {
              for (const text of interactionTextChunks(step.summary)) {
                yield { type: 'thinking_delta', content: text };
              }
            }
            if (step.type === 'function_call' && step.id && step.name) {
              // The start event's empty object is a placeholder; only real
              // arguments_delta bytes are emitted and replayed.
              argumentBuffers.set(index, '');
              yield { type: 'tool_call_delta', id: step.id, name: step.name };
            }
          } else if (event.event_type === 'step.delta' && event.delta) {
            const delta = event.delta as GeminiInteractionDelta;
            const index = event.index;
            if (index === undefined || stopped.has(index)) {
              throw new Error('Gemini Interactions stream delta arrived outside an active step');
            }
            const step = steps.get(index);
            if (!step)
              throw new Error('Gemini Interactions stream delta arrived before step.start');
            if (
              delta.type === 'text' &&
              typeof delta.text === 'string' &&
              step.type === 'model_output'
            ) {
              appendInteractionContent(step, 'content', { type: 'text', text: delta.text });
              yield { type: 'text_delta', content: delta.text };
            } else if (
              delta.type === 'thought_summary' &&
              step.type === 'thought' &&
              delta.content
            ) {
              appendInteractionContent(step, 'summary', delta.content);
              for (const text of interactionTextChunks([delta.content])) {
                yield { type: 'thinking_delta', content: text };
              }
            } else if (
              delta.type === 'thought_signature' &&
              step.type === 'thought' &&
              typeof delta.signature === 'string'
            ) {
              step.signature = delta.signature;
            } else if (
              delta.type === 'arguments_delta' &&
              step.type === 'function_call' &&
              typeof delta.arguments === 'string'
            ) {
              argumentBuffers.set(index, (argumentBuffers.get(index) ?? '') + delta.arguments);
              if (step.id)
                yield { type: 'tool_call_delta', id: step.id, arguments: delta.arguments };
            }
          } else if (event.event_type === 'step.stop') {
            const index = event.index;
            const step = index === undefined ? undefined : steps.get(index);
            if (step === undefined || stopped.has(index!)) {
              throw new Error('Gemini Interactions stream contained an invalid step.stop index');
            }
            if (step.type === 'function_call') {
              const rawArguments = argumentBuffers.get(index!) ?? '';
              if (rawArguments) {
                try {
                  const parsed: unknown = JSON.parse(rawArguments);
                  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('not an object');
                  }
                  step.arguments = parsed as Record<string, unknown>;
                } catch {
                  throw new Error(
                    'Gemini Interactions function_call arguments were not valid JSON',
                  );
                }
              }
            }
            stopped.add(index!);
          } else if (event.event_type === 'interaction.completed') {
            if (steps.size !== stopped.size) {
              throw new Error('Gemini Interactions stream completed before all steps stopped');
            }
            const toolCallCount = [...steps.values()].filter(
              (step) => step.type === 'function_call' && !!step.id && !!step.name,
            ).length;
            this.assertInteractionTerminalStatus(event.interaction?.status, toolCallCount);
            completed = true;
            yield {
              type: 'done',
              usage: normalizeInteractionUsage(event.interaction?.usage),
              providerMetadata: steps.size
                ? {
                    geminiInteractionSteps: [...steps.entries()]
                      .sort(([a], [b]) => a - b)
                      .map(([, step]) => step),
                  }
                : undefined,
            };
            return;
          }
        }
      }
      if (!completed)
        throw new Error('Gemini Interactions stream ended before interaction.completed');
    } finally {
      reader.releaseLock();
    }
  }

  private assertInteractionTerminalStatus(status: unknown, toolCallCount: number): void {
    if (status === 'completed') return;
    if (status === 'requires_action' && toolCallCount > 0) return;
    const normalizedStatus = typeof status === 'string' ? status : 'unknown';
    throw new ProviderError({
      provider: this.name,
      status: 0,
      retryable: false,
      message: `Gemini Interactions ended with non-success status: ${normalizedStatus}`,
    });
  }

  // ---------------------------------------------------------------------------
  // Internal: request building
  // ---------------------------------------------------------------------------

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    };
  }

  private extractErrorMessage(body: string, status: number): string {
    try {
      const json = JSON.parse(body) as {
        error?: { message?: string; code?: number; status?: string };
      };
      if (json.error?.message) {
        return `Gemini API error (${status}): ${json.error.message}`;
      }
    } catch {
      // Not JSON, use raw body
    }
    return `Gemini API error (${status}): ${body}`;
  }

  private pricingContext(
    fallbackModel: string,
    body: Record<string, unknown>,
  ): GeminiPricingContext {
    return {
      // Gemini's model is normally selected in the URL. providerOptions is an
      // explicit raw escape hatch, so honor a post-merge model override for both
      // the URL and pricing rather than pricing a different request.
      model: typeof body.model === 'string' ? body.model : fallbackModel,
      serviceTier: body.serviceTier,
      eligibleRequest:
        this.baseUrl === 'https://generativelanguage.googleapis.com/v1beta' &&
        this.isTextOnlyClientRequest(body),
    };
  }

  private requestModel(options: Pick<ChatOptions, 'model' | 'providerOptions'>): string {
    return typeof options.providerOptions?.model === 'string'
      ? options.providerOptions.model
      : options.model;
  }

  private assertSafeGemini3Continuation(messages: ChatMessage[], model: string): void {
    // Map into fresh request objects before inspecting the terminal turn. This
    // treats an empty assistant message as absent, does not mutate the caller's
    // history, and catches an actual model/tool-call continuation prefill.
    if (GEMINI_MODELS_WITHOUT_PORTABLE_TEMPERATURE.has(model)) {
      const mapped = this.mapMessages(messages.filter((message) => message.role !== 'system'));
      if (mapped.at(-1)?.role === 'model') {
        throw new Error(
          `${model} does not support a terminal assistant/model prefill; end the request with a user or tool message.`,
        );
      }
    }

    if (!isGemini3x(model)) return;

    const replayedNativeCallIds = new Set<string>();
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.providerMetadata?.geminiParts)) {
        continue;
      }
      for (const part of message.providerMetadata.geminiParts) {
        const id =
          part !== null && typeof part === 'object'
            ? (part as GeminiPart).functionCall?.id
            : undefined;
        if (!id) continue;
        if (replayedNativeCallIds.has(id)) {
          throw new Error(
            `${model} native functionCall ids must be globally unique across a replay.`,
          );
        }
        replayedNativeCallIds.add(id);
      }
    }

    const consumedToolMessages = new Set<number>();
    for (const [assistantIndex, message] of messages.entries()) {
      if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
      const rawParts = message.providerMetadata?.geminiParts;
      if (!Array.isArray(rawParts)) {
        throw new Error(
          `${model} tool continuations require providerMetadata.geminiParts with thought signatures.`,
        );
      }

      const nativeCalls = rawParts.flatMap((part) => {
        const functionCall =
          part !== null && typeof part === 'object' ? (part as GeminiPart).functionCall : undefined;
        return functionCall?.id ? [{ id: functionCall.id, name: functionCall.name, part }] : [];
      });
      const expectedCalls = new Map(
        message.tool_calls.map((call) => [call.id, call.function.name]),
      );
      if (
        expectedCalls.size !== message.tool_calls.length ||
        nativeCalls.length !== message.tool_calls.length ||
        new Set(nativeCalls.map((call) => call.id)).size !== nativeCalls.length ||
        typeof nativeCalls[0]?.part.thoughtSignature !== 'string' ||
        nativeCalls[0].part.thoughtSignature.length === 0 ||
        nativeCalls.some((call) => expectedCalls.get(call.id) !== call.name)
      ) {
        throw new Error(
          `${model} tool continuations require exact native functionCall id/name and a thoughtSignature on the first function call.`,
        );
      }
      const seenResponses = new Set<string>();
      let toolIndex = assistantIndex + 1;
      while (messages[toolIndex]?.role === 'tool') {
        const toolMessage = messages[toolIndex];
        const toolCallId = toolMessage.tool_call_id;
        if (!toolCallId || !expectedCalls.has(toolCallId) || seenResponses.has(toolCallId)) {
          throw new Error(
            `${model} functionResponse requires exactly one matching native functionCall id and name.`,
          );
        }
        seenResponses.add(toolCallId);
        consumedToolMessages.add(toolIndex);
        toolIndex++;
      }
      if (seenResponses.size !== expectedCalls.size) {
        throw new Error(
          `${model} tool continuations require one contiguous functionResponse for every native functionCall.`,
        );
      }
    }

    for (const [index, message] of messages.entries()) {
      if (message.role === 'tool' && !consumedToolMessages.has(index)) {
        throw new Error(
          `${model} functionResponse requires exactly one matching native functionCall id and name.`,
        );
      }
    }
  }

  private isTextOnlyClientRequest(body: Record<string, unknown>): boolean {
    if (!Array.isArray(body.contents) || body.cachedContent !== undefined) return false;
    if (
      body.contents.some(
        (content) =>
          content === null ||
          typeof content !== 'object' ||
          !Array.isArray((content as GeminiContent).parts) ||
          (content as GeminiContent).parts.some((part) => this.isNonTextGeminiPart(part)),
      )
    ) {
      return false;
    }
    if (
      body.tools !== undefined &&
      (!Array.isArray(body.tools) ||
        body.tools.some(
          (tool) =>
            tool === null ||
            typeof tool !== 'object' ||
            !Array.isArray((tool as { functionDeclarations?: unknown }).functionDeclarations) ||
            Object.keys(tool).some((key) => key !== 'functionDeclarations'),
        ))
    ) {
      return false;
    }
    const modalities = (body.generationConfig as { responseModalities?: unknown } | undefined)
      ?.responseModalities;
    return (
      modalities === undefined ||
      modalities === 'TEXT' ||
      (Array.isArray(modalities) && modalities.length === 1 && modalities[0] === 'TEXT')
    );
  }

  private isNonTextGeminiPart(part: unknown): boolean {
    return (
      part === null ||
      typeof part !== 'object' ||
      ['inlineData', 'fileData', 'executableCode', 'codeExecutionResult'].some((key) => key in part)
    );
  }

  private buildRequestBody(messages: ChatMessage[], options: ChatOptions): Record<string, unknown> {
    const requestModel = this.requestModel(options);
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const systemText = systemMessages.map((m) => m.content).join('\n\n');

    const body: Record<string, unknown> = {
      contents: this.mapMessages(nonSystemMessages),
    };

    if (systemText) {
      body.system_instruction = { parts: [{ text: systemText }] };
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: options.tools.map((t) => this.mapToolDefinition(t)),
        },
      ];
    }

    const generationConfig: Record<string, unknown> = {};

    if (
      options.temperature !== undefined &&
      !GEMINI_MODELS_WITHOUT_PORTABLE_TEMPERATURE.has(requestModel)
    ) {
      generationConfig.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = options.maxTokens;
    }
    if (options.stop) {
      generationConfig.stopSequences = options.stop;
    }

    if (options.responseFormat && options.responseFormat.type !== 'text') {
      generationConfig.responseMimeType = 'application/json';
      if (
        options.responseFormat.type === 'json_schema' &&
        options.responseFormat.json_schema?.schema
      ) {
        generationConfig.responseSchema = sanitizeSchemaForGemini(
          options.responseFormat.json_schema.schema,
        );
      }
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    // Map effort/thinkingBudget/includeThoughts to Gemini's thinkingConfig.
    // `generateContent` is level-based on 3.x and budget-based on 2.x; the
    // shared resolver decides which, so both endpoints stay in step.
    const thinkingPlan = resolveGeminiThinking(requestModel, resolveThinkingOptions(options));
    const thinkingConfig: Record<string, unknown> = {};
    if (thinkingPlan.thinkingLevel !== undefined) {
      thinkingConfig.thinkingLevel = thinkingPlan.thinkingLevel;
    }
    if (thinkingPlan.thinkingBudget !== undefined) {
      thinkingConfig.thinkingBudget = thinkingPlan.thinkingBudget;
    }
    if (thinkingPlan.attachThoughts) thinkingConfig.includeThoughts = true;
    // No effort, no budget, no includeThoughts → no thinkingConfig (provider defaults)
    if (Object.keys(thinkingConfig).length > 0) {
      generationConfig.thinkingConfig = thinkingConfig;
      if (!body.generationConfig) body.generationConfig = generationConfig;
    }

    // Map toolChoice to Gemini's toolConfig.functionCallingConfig
    if (options.toolChoice !== undefined) {
      body.toolConfig = { functionCallingConfig: this.mapToolChoice(options.toolChoice) };
    }

    if (options.providerOptions) {
      const bodyOptions = { ...options.providerOptions };
      delete bodyOptions.model;
      Object.assign(body, bodyOptions);
    }

    return body;
  }

  /**
   * Map OpenAI-format ChatMessages to Gemini content format.
   *
   * Key transformations:
   * - assistant role -> model role
   * - assistant messages with tool_calls -> model messages with functionCall parts
   * - tool messages -> user messages with functionResponse parts
   *
   * Two-pass approach: first build a tool_call_id -> function name mapping
   * from assistant messages, then use it when mapping tool result messages.
   */
  private mapMessages(messages: ChatMessage[]): GeminiContent[] {
    // Pass 1: build tool_call_id -> function name mapping, and collect the set of
    // ids that originated natively from Gemini (present in a prior assistant
    // message's providerMetadata.geminiParts). Gemini 3.x requires the id be
    // echoed back in functionResponse; Gemini 2.x doesn't emit ids, so we must
    // NOT send one in that case (preserves 2.x behavior bit-for-bit).
    const toolCallIdToName = new Map<string, string>();
    const geminiNativeIds = new Set<string>();
    const geminiNativeNames = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallIdToName.set(tc.id, tc.function.name);
        }
      }
      if (msg.role === 'assistant') {
        const rawParts = msg.providerMetadata?.geminiParts as GeminiPart[] | undefined;
        if (rawParts) {
          for (const p of rawParts) {
            if (p.functionCall?.id) {
              geminiNativeIds.add(p.functionCall.id);
              geminiNativeNames.set(p.functionCall.id, p.functionCall.name);
            }
          }
        }
      }
    }

    // Pass 2: transform messages
    const result: GeminiContent[] = [];

    for (const msg of messages) {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (msg.role === 'assistant') {
        // If we have raw Gemini parts from a previous response, use them directly.
        // This preserves thoughtSignature and other opaque fields that Gemini requires
        // in subsequent turns for multi-turn reasoning context.
        const rawParts = msg.providerMetadata?.geminiParts as GeminiPart[] | undefined;
        if (rawParts && rawParts.length > 0) {
          result.push({ role: 'model', parts: rawParts });
        } else {
          const parts: GeminiPart[] = [];

          if (text) {
            parts.push({ text });
          }

          if (msg.tool_calls && msg.tool_calls.length > 0) {
            for (const tc of msg.tool_calls) {
              let parsedArgs: Record<string, unknown>;
              try {
                parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
              } catch {
                parsedArgs = {};
              }
              parts.push({
                functionCall: {
                  name: tc.function.name,
                  args: parsedArgs,
                },
              });
            }
          }

          if (parts.length > 0) {
            result.push({ role: 'model', parts });
          }
        }
      } else if (msg.role === 'tool') {
        const functionName =
          (msg.tool_call_id ? geminiNativeNames.get(msg.tool_call_id) : undefined) ??
          toolCallIdToName.get(msg.tool_call_id!) ??
          'unknown';
        const functionResponse: {
          id?: string;
          name: string;
          response: Record<string, unknown>;
        } = {
          name: functionName,
          response: parseGeminiFunctionResponse(text),
        };
        // Gemini 3.x requires the id from the originating functionCall be echoed
        // here. Only include it when this id was native to a prior Gemini turn,
        // so Gemini 2.x payloads stay unchanged.
        if (msg.tool_call_id && geminiNativeIds.has(msg.tool_call_id)) {
          functionResponse.id = msg.tool_call_id;
        }
        result.push({
          role: 'user',
          parts: [{ functionResponse }],
        });
      } else if (msg.role === 'user') {
        result.push({ role: 'user', parts: [{ text }] });
      }
      // system messages already handled at top level
    }

    // Merge consecutive same-role messages
    return this.mergeConsecutiveRoles(result);
  }

  /**
   * Merge consecutive messages with the same role into a single message.
   * Gemini requires alternating user/model turns.
   */
  private mergeConsecutiveRoles(messages: GeminiContent[]): GeminiContent[] {
    if (messages.length === 0) return messages;

    const merged: GeminiContent[] = [messages[0]];

    for (let i = 1; i < messages.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = messages[i];

      if (prev.role === curr.role) {
        prev.parts = [...prev.parts, ...curr.parts];
      } else {
        merged.push(curr);
      }
    }

    return merged;
  }

  /**
   * Map Axl's ToolChoice to Gemini's functionCallingConfig format.
   *
   * - 'auto'     → { mode: 'AUTO' }
   * - 'none'     → { mode: 'NONE' }
   * - 'required' → { mode: 'ANY' }
   * - { type: 'function', function: { name } } → { mode: 'ANY', allowedFunctionNames: [name] }
   */
  private mapToolChoice(choice: NonNullable<ChatOptions['toolChoice']>): Record<string, unknown> {
    if (typeof choice === 'string') {
      const modeMap: Record<string, string> = {
        auto: 'AUTO',
        none: 'NONE',
        required: 'ANY',
      };
      return { mode: modeMap[choice] ?? 'AUTO' };
    }
    // Specific function choice
    return { mode: 'ANY', allowedFunctionNames: [choice.function.name] };
  }

  private mapToolDefinition(tool: ToolDefinition): {
    name: string;
    description: string;
    parameters: unknown;
  } {
    return {
      name: tool.function.name,
      description: tool.function.description,
      parameters: sanitizeSchemaForGemini(tool.function.parameters),
    };
  }

  // ---------------------------------------------------------------------------
  // Internal: response parsing
  // ---------------------------------------------------------------------------

  private parseResponse(
    json: GeminiResponse,
    pricingContext: GeminiPricingContext,
  ): ProviderResponse {
    const candidate = json.candidates?.[0];
    let content = '';
    let thinkingContent = '';
    const toolCalls: ToolCallMessage[] = [];

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.thought && part.text) {
          thinkingContent += part.text;
        } else if (part.text) {
          content += part.text;
        } else if (part.functionCall) {
          // Gemini 3.x returns a unique `id` on every functionCall and requires it
          // back in the matching functionResponse. Use it directly when present so
          // the tool-result echo (handled in mapMessages) can include it.
          toolCalls.push({
            id: part.functionCall.id || `call_${this.callCounter++}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args),
            },
          });
        }
      }
    }

    if (!candidate) {
      throw new Error('Gemini response did not include a candidate.');
    }
    if (candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
      throw new Error(`Gemini returned non-success finish reason: ${candidate.finishReason}`);
    }

    const normalized = json.usageMetadata ? normalizeGeminiUsage(json.usageMetadata) : undefined;
    const effectiveModel =
      typeof json.modelVersion === 'string' ? json.modelVersion : pricingContext.model;
    const cost =
      normalized &&
      !normalized.hasUnmodeledBilledUsage &&
      this.isTextOnlyGeminiResponse(candidate) &&
      isEligibleGeminiPricing(
        pricingContext,
        isDefinitiveStandardGeminiResponseTier(json.usageMetadata?.serviceTier),
        json.usageMetadata?.serviceTier !== undefined &&
          !isDefinitiveStandardGeminiResponseTier(json.usageMetadata.serviceTier),
      )
        ? estimateGeminiCost(effectiveModel, normalized.pricingUsage)
        : undefined;

    // Attach raw Gemini parts as providerMetadata so they can be sent back
    // verbatim in subsequent turns, preserving thoughtSignature and other opaque fields.
    const rawParts = candidate?.content?.parts;
    const providerMetadata = rawParts ? { geminiParts: rawParts } : undefined;

    return {
      content,
      thinking_content: thinkingContent || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: normalized?.usage,
      cost,
      providerMetadata,
    };
  }

  private isTextOnlyGeminiResponse(candidate: GeminiCandidate | undefined): boolean {
    return candidate?.content?.parts.every((part) => !this.isNonTextGeminiPart(part)) ?? false;
  }

  // ---------------------------------------------------------------------------
  // Internal: SSE stream parsing
  // ---------------------------------------------------------------------------

  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
    pricingContext: GeminiPricingContext,
    timing: CallTimingRecorder,
  ): AsyncGenerator<StreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let normalizedUsage: NormalizedGeminiUsage | undefined;
    let effectiveModel = pricingContext.model;
    let hasDefinitiveStandardResponseTier = false;
    let hasInvalidResponseTier = false;
    let responseIsTextOnly = true;
    let terminalFailure: string | undefined;
    // Accumulate raw parts across stream chunks for providerMetadata round-tripping
    const accumulatedParts: Array<Record<string, unknown>> = [];

    try {
      while (true) {
        const { done, value } = await timing.read(reader);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (!trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.slice(6);
          let chunk: GeminiResponse;
          try {
            chunk = JSON.parse(jsonStr) as GeminiResponse;
          } catch {
            continue;
          }

          if (typeof chunk.modelVersion === 'string') effectiveModel = chunk.modelVersion;

          // Extract usage from this chunk. A malformed or incomplete usage
          // report remains unpriced rather than manufacturing token counts.
          if (chunk.usageMetadata) {
            normalizedUsage = normalizeGeminiUsage(chunk.usageMetadata);
            if (chunk.usageMetadata.serviceTier !== undefined) {
              if (isDefinitiveStandardGeminiResponseTier(chunk.usageMetadata.serviceTier)) {
                hasDefinitiveStandardResponseTier = true;
              } else {
                hasInvalidResponseTier = true;
              }
            }
          }

          const candidate = chunk.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if (this.isNonTextGeminiPart(part)) responseIsTextOnly = false;
              // Accumulate raw parts for providerMetadata
              accumulatedParts.push(part);

              if (part.thought && part.text) {
                yield { type: 'thinking_delta', content: part.text };
              } else if (part.text) {
                yield { type: 'text_delta', content: part.text };
              } else if (part.functionCall) {
                // Gemini sends complete functionCall objects (not incremental deltas).
                // Preserve Gemini 3.x's native `id` so mapMessages can echo it back
                // in the matching functionResponse on the next turn.
                yield {
                  type: 'tool_call_delta',
                  id: part.functionCall.id || `call_${this.callCounter++}`,
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args),
                };
              }
            }
          }
          if (candidate?.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
            terminalFailure = candidate.finishReason;
          }
        }
      }

      if (terminalFailure) {
        throw new Error(`Gemini returned non-success finish reason: ${terminalFailure}`);
      }

      const providerMetadata =
        accumulatedParts.length > 0 ? { geminiParts: accumulatedParts } : undefined;
      yield {
        type: 'done',
        usage: normalizedUsage?.usage,
        cost:
          normalizedUsage &&
          !normalizedUsage.hasUnmodeledBilledUsage &&
          responseIsTextOnly &&
          isEligibleGeminiPricing(
            pricingContext,
            hasDefinitiveStandardResponseTier,
            hasInvalidResponseTier,
          )
            ? estimateGeminiCost(effectiveModel, normalizedUsage.pricingUsage)
            : undefined,
        providerMetadata,
      };
    } finally {
      reader.releaseLock();
    }
  }
}

// ---------------------------------------------------------------------------
// Gemini API types (internal)
// ---------------------------------------------------------------------------

type GeminiInteractionContent = { type: 'text'; text: string } | Record<string, unknown>;

type GeminiInteractionStep = {
  type: 'user_input' | 'model_output' | 'thought' | 'function_call' | 'function_result';
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  content?: GeminiInteractionContent[];
  summary?: GeminiInteractionContent[];
  result?: GeminiInteractionContent[];
  [key: string]: unknown;
};

type GeminiInteractionUsage = {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_tokens?: number;
  total_cached_tokens?: number;
  total_thought_tokens?: number;
};

type GeminiInteractionResponse = {
  model?: string;
  status?: string;
  steps?: GeminiInteractionStep[];
  usage?: GeminiInteractionUsage;
};

type GeminiInteractionSSEEvent = {
  event_type?: string;
  index?: number;
  step?: GeminiInteractionStep;
  delta?: GeminiInteractionDelta;
  interaction?: GeminiInteractionResponse;
  error?: { message?: string; code?: string | number; status?: string };
};

type GeminiInteractionDelta = {
  type: 'text' | 'thought_summary' | 'thought_signature' | 'arguments_delta';
  id?: string;
  name?: string;
  text?: string;
  arguments?: Record<string, unknown> | string;
  content?: GeminiInteractionContent;
  signature?: string;
};

function isGeminiInteractionStep(value: unknown): value is GeminiInteractionStep {
  return (
    value !== null &&
    typeof value === 'object' &&
    ['user_input', 'model_output', 'thought', 'function_call', 'function_result'].includes(
      (value as { type?: unknown }).type as string,
    )
  );
}

function interactionText(content: GeminiInteractionContent[] | undefined): string {
  return (
    content
      ?.map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('') ?? ''
  );
}

function interactionTextChunks(content: GeminiInteractionContent[] | undefined): string[] {
  return (
    content?.flatMap((part) =>
      part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    ) ?? []
  );
}

function cloneInteractionStep(step: GeminiInteractionStep): GeminiInteractionStep {
  return JSON.parse(JSON.stringify(step)) as GeminiInteractionStep;
}

function appendInteractionContent(
  step: GeminiInteractionStep,
  field: 'content' | 'summary',
  content: GeminiInteractionContent,
): void {
  const existing = step[field] ?? [];
  const last = existing.at(-1);
  if (
    content.type === 'text' &&
    last?.type === 'text' &&
    typeof content.text === 'string' &&
    typeof last.text === 'string'
  ) {
    last.text += content.text;
  } else {
    existing.push(content);
  }
  step[field] = existing;
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeInteractionUsage(
  usage: GeminiInteractionUsage | undefined,
): ProviderResponse['usage'] | undefined {
  if (
    !usage ||
    !isValidTokenCount(usage.total_input_tokens) ||
    !isValidTokenCount(usage.total_output_tokens) ||
    !isValidTokenCount(usage.total_tokens)
  ) {
    return undefined;
  }
  const cached = usage.total_cached_tokens;
  const thinking = usage.total_thought_tokens;
  if (
    (cached !== undefined && (!isValidTokenCount(cached) || cached > usage.total_input_tokens)) ||
    (thinking !== undefined && !isValidTokenCount(thinking))
  )
    return undefined;
  return {
    prompt_tokens: usage.total_input_tokens,
    completion_tokens: usage.total_output_tokens,
    total_tokens: usage.total_tokens,
    ...(cached ? { cached_tokens: cached } : {}),
    ...(thinking ? { reasoning_tokens: thinking } : {}),
  };
}

/**
 * Gemini part type for request building.
 *
 * Uses an index signature to allow opaque provider fields (e.g. thoughtSignature)
 * to round-trip through conversation history without being stripped.
 */
type GeminiPart = {
  text?: string;
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  [key: string]: unknown;
};

type GeminiContent = {
  role: 'user' | 'model';
  parts: GeminiPart[];
};

type GeminiResponse = {
  modelVersion?: string;
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
};

type GeminiCandidate = {
  content?: {
    role: string;
    parts: Array<{
      text?: string;
      thought?: boolean;
      functionCall?: { id?: string; name: string; args: Record<string, unknown> };
      [key: string]: unknown;
    }>;
  };
  finishReason?: string;
};

type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  serviceTier?: unknown;
};
