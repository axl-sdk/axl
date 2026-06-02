import type { Effort, ApiKeySource } from './types.js';
import type { RateLimitConfig } from './rate-limiter.js';
import {
  OpenAICompatibleProvider,
  priceFromTable,
  type ProviderProfile,
  type PricingTable,
  type ReasoningEmit,
} from './openai-compatible.js';

// ---------------------------------------------------------------------------
// Approximate per-token pricing (USD) for common OpenAI models.
// Format: [promptCostPerToken, completionCostPerToken, cacheMultiplier]
// cacheMultiplier is the fraction of input rate charged for cached tokens.
// These are approximations for budget estimation, not billing.
// Actual pricing may differ; check OpenAI's pricing page for current rates.
// ---------------------------------------------------------------------------

export const OPENAI_PRICING: PricingTable = {
  // gpt-4o era — cache reads at 50% of input rate
  'gpt-4o': [2.5e-6, 10e-6, 0.5],
  'gpt-4o-mini': [0.15e-6, 0.6e-6, 0.5],
  'gpt-4-turbo': [10e-6, 30e-6, 0.5],
  'gpt-4': [30e-6, 60e-6, 0.5],
  'gpt-3.5-turbo': [0.5e-6, 1.5e-6, 0.5],
  o1: [15e-6, 60e-6, 0.5],
  'o1-mini': [3e-6, 12e-6, 0.5],
  'o1-pro': [150e-6, 600e-6, 0.5],
  // gpt-4.1 / o3 / o4 era — cache reads at 25% of input rate
  'gpt-4.1': [2e-6, 8e-6, 0.25],
  'gpt-4.1-mini': [0.4e-6, 1.6e-6, 0.25],
  'gpt-4.1-nano': [0.1e-6, 0.4e-6, 0.25],
  o3: [10e-6, 40e-6, 0.25],
  'o3-mini': [1.1e-6, 4.4e-6, 0.25],
  'o3-pro': [20e-6, 80e-6, 0.25],
  'o4-mini': [1.1e-6, 4.4e-6, 0.25],
  // gpt-5 era — cache reads at 10% of input rate
  'gpt-5': [1.25e-6, 10e-6, 0.1],
  'gpt-5-mini': [0.25e-6, 2e-6, 0.1],
  'gpt-5-nano': [0.05e-6, 0.4e-6, 0.1],
  'gpt-5.1': [1.25e-6, 10e-6, 0.1],
  'gpt-5.2': [1.75e-6, 14e-6, 0.1],
  'gpt-5.3': [1.75e-6, 14e-6, 0.1],
  'gpt-5.4': [2.5e-6, 15e-6, 0.1],
  'gpt-5.4-pro': [30e-6, 180e-6, 0.1],
  // gpt-5.5 era (flagship released 2026-04) — cache reads at 10% of input rate
  'gpt-5.5': [5e-6, 30e-6, 0.1],
  'gpt-5.5-pro': [30e-6, 180e-6, 0.1],
};

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
  return priceFromTable(OPENAI_PRICING, model, promptTokens, completionTokens, cachedTokens);
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
  pricing: { kind: 'table', table: OPENAI_PRICING },
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
}
