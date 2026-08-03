import type { Effort, ApiKeySource } from './types.js';
import type { RateLimitConfig } from './rate-limiter.js';
import {
  OpenAICompatibleProvider,
  type ProviderProfile,
  type PricingTable,
  type ReasoningEmit,
} from './openai-compatible.js';
import type { ProviderResponse } from '../types.js';

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

type DirectOpenAIModel = {
  /** Every catalog id is explicit; aliases never imply snapshot pricing. */
  aliases: readonly string[];
  snapshotBase?: string;
  short: OpenAIRates;
  long?: OpenAIRates;
  contextBoundary?: number;
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
 * Direct OpenAI Standard text pricing, per token. This is deliberately private:
 * the public tuple API cannot faithfully express cache writes or context tiers.
 * Every catalog id is explicit; arbitrary siblings and unlisted snapshots
 * never inherit an alias price.
 */
const DIRECT_OPENAI_CATALOG: readonly DirectOpenAIModel[] = [
  {
    aliases: ['gpt-5.6', 'gpt-5.6-sol'],
    snapshotBase: 'gpt-5.6-sol',
    short: { input: 5 / M, cachedInput: 0.5 / M, cacheWrite: 6.25 / M, output: 30 / M },
    long: withLongContext({
      input: 5 / M,
      cachedInput: 0.5 / M,
      cacheWrite: 6.25 / M,
      output: 30 / M,
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

const CANONICAL_OPENAI_BASE_URL = 'https://api.openai.com/v1';

function isEligibleDirectOpenAIContext(context: DirectOpenAIPricingContext | undefined): boolean {
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
  const reasoning = request?.reasoning;
  if (
    reasoning !== null &&
    typeof reasoning === 'object' &&
    'mode' in reasoning &&
    (reasoning as { mode?: unknown }).mode !== undefined
  ) {
    return false;
  }
  if (
    ['modalities', 'audio', 'image_generation', 'web_search_options'].some(
      (key) => request?.[key] !== undefined,
    )
  ) {
    return false;
  }
  if (
    Array.isArray(request?.tools) &&
    request.tools.some(
      (tool) =>
        tool === null ||
        typeof tool !== 'object' ||
        (tool as { type?: unknown }).type !== 'function',
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

/** Internal native OpenAI estimator; undefined means deliberately unpriced. */
export function estimateDirectOpenAICost(
  model: string,
  usage: NonNullable<ProviderResponse['usage']>,
  context?: DirectOpenAIPricingContext,
): number | undefined {
  if (!isEligibleDirectOpenAIContext(context)) return undefined;
  const entry = directOpenAIModel(model);
  if (!entry) return undefined;
  const { prompt_tokens, completion_tokens, cached_tokens, cache_write_tokens } = usage;
  const cached = cached_tokens ?? 0;
  const cacheWrite = cache_write_tokens ?? 0;
  if (
    ![prompt_tokens, completion_tokens, cached, cacheWrite].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    ) ||
    cached + cacheWrite > prompt_tokens
  ) {
    return undefined;
  }
  const rates =
    entry.long !== undefined &&
    entry.contextBoundary !== undefined &&
    prompt_tokens > entry.contextBoundary
      ? entry.long
      : entry.short;
  if (
    (cached > 0 && rates.cachedInput === undefined) ||
    (cacheWrite > 0 && rates.cacheWrite === undefined)
  ) {
    return undefined;
  }
  const ordinary = prompt_tokens - cached - cacheWrite;
  return (
    ordinary * rates.input +
    cached * (rates.cachedInput ?? 0) +
    cacheWrite * (rates.cacheWrite ?? 0) +
    completion_tokens * rates.output
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

/** Returns true for o-series models (o1, o3, o4-mini) that always reason. */
export function isOSeriesModel(model: string): boolean {
  return /^(o1|o3|o4-mini)/.test(model);
}

/** Returns true for models that accept reasoning_effort. */
export function supportsReasoningEffort(model: string): boolean {
  return isOSeriesModel(model) || /^gpt-5/.test(model);
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Returns true for models that support reasoning_effort: 'none' (gpt-5.1+). */
export function supportsReasoningNone(model: string): boolean {
  return /^gpt-5\.[1-9]/.test(model);
}

/**
 * Returns true for models that support reasoning_effort: 'xhigh'.
 * Per OpenAI docs: "xhigh is supported for all models after gpt-5.1-codex-max."
 * This means gpt-5.2+ (gpt-5.1 itself does NOT support xhigh).
 */
export function supportsXhigh(model: string): boolean {
  // gpt-5.2+ — models after gpt-5.1-codex-max
  return /^gpt-5\.([2-9]|\d{2,})/.test(model);
}

/**
 * Clamp reasoning_effort to model-supported range.
 *
 * Model constraints (from OpenAI API reference):
 * - gpt-5-pro: only supports 'high'
 * - gpt-5.1+: supports 'none', 'low', 'medium', 'high'
 * - Pre-gpt-5.1 (o-series, gpt-5, gpt-5-mini, gpt-5-nano): no 'none', default 'medium'
 * - xhigh: only models after gpt-5.1-codex-max (gpt-5.2+)
 */
export function clampReasoningEffort(model: string, effort: ReasoningEffort): ReasoningEffort {
  // gpt-5-pro only supports 'high'
  if (model.startsWith('gpt-5-pro')) return 'high';

  // 'none' only supported on gpt-5.1+; clamp to 'minimal' (closest to 'none')
  if (effort === 'none' && !supportsReasoningNone(model)) return 'minimal';

  // 'xhigh' only supported on gpt-5.2+
  if (effort === 'xhigh' && !supportsXhigh(model)) return 'high';

  return effort;
}

/** Map Effort to OpenAI reasoning_effort wire value. */
export function effortToReasoningEffort(effort: Exclude<Effort, 'none'>): ReasoningEffort {
  return effort === 'max' ? 'xhigh' : effort;
}

/** Map budgetTokens to nearest OpenAI reasoning_effort. */
export function budgetToReasoningEffort(budget: number): ReasoningEffort {
  if (budget <= 1024) return 'low';
  if (budget <= 8192) return 'medium';
  return 'high';
}

/**
 * OpenAI Chat Completions reasoning emit. Computes `reasoning_effort` for
 * o-series / GPT-5.x models from the unified effort/thinkingBudget knobs and
 * signals when to strip `temperature` (always for o-series; for GPT-5.x only
 * when reasoning is active). Non-reasoning models get neither.
 */
export const openaiReasoningEmit: ReasoningEmit = (body, resolved, model) => {
  const oSeries = isOSeriesModel(model);
  const reasoningCapable = supportsReasoningEffort(model);
  const { thinkingBudget, thinkingDisabled, activeEffort, hasBudgetOverride } = resolved;

  let wireEffort: ReasoningEffort | undefined;
  if (reasoningCapable) {
    if (hasBudgetOverride) {
      // Explicit budget always takes precedence (consistent with Anthropic/Gemini)
      wireEffort = clampReasoningEffort(model, budgetToReasoningEffort(thinkingBudget!));
    } else if (!thinkingDisabled && activeEffort) {
      wireEffort = clampReasoningEffort(model, effortToReasoningEffort(activeEffort));
    } else if (thinkingDisabled) {
      // Disable reasoning: covers both effort='none' and thinkingBudget=0
      wireEffort = clampReasoningEffort(model, 'none');
    }
  }

  if (wireEffort) body.reasoning_effort = wireEffort;

  return { stripTemperature: oSeries || (reasoningCapable && wireEffort !== undefined) };
};

/** Canonical OpenAI Chat Completions profile. */
export const OPENAI_PROFILE: ProviderProfile = {
  name: 'openai',
  label: 'OpenAI',
  defaultBaseUrl: 'https://api.openai.com/v1',
  envApiKey: 'OPENAI_API_KEY',
  envBaseUrl: 'OPENAI_BASE_URL',
  pricing: { kind: 'table', table: OPENAI_PRICING, match: 'exact' },
  reasoning: { emit: openaiReasoningEmit, capture: 'none' },
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
    options: { apiKey?: ApiKeySource; baseUrl?: string; rateLimit?: RateLimitConfig } = {},
  ) {
    super({ profile: OPENAI_PROFILE, ...options });
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
