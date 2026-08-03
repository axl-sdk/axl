import type { PricingTable, ProviderProfile } from './openai-compatible.js';

type BuiltinTablePricingPolicy = {
  canonicalBaseUrl?: string;
  supportedServiceTiers?: readonly string[];
  requireCacheSplit?: boolean;
  functionToolsOnly?: boolean;
  chargedRequestModifiers?: readonly string[];
};

type PricingContext = {
  baseUrl: string;
  request?: Record<string, unknown>;
  response?: {
    service_tier?: unknown;
    serviceTier?: unknown;
    usage?: {
      prompt_tokens: number;
      prompt_cache_hit_tokens?: number;
      prompt_cache_miss_tokens?: number;
    };
  };
};

const policies = new WeakMap<PricingTable, BuiltinTablePricingPolicy>();

/** Internal registration for built-in, source-specific table constraints. */
export function attachBuiltinTablePricingPolicy(
  profile: ProviderProfile,
  policy: BuiltinTablePricingPolicy,
): void {
  if (profile.pricing.kind !== 'table') {
    throw new Error('Built-in table pricing policy requires table pricing.');
  }
  policies.set(profile.pricing.table, policy);
}

function hasFunctionToolsOnly(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (tool) =>
          tool !== null &&
          typeof tool === 'object' &&
          (tool as { type?: unknown }).type === 'function',
      ))
  );
}

function hasValidRequiredCacheSplit(context: PricingContext): boolean {
  const usage = context.response?.usage;
  const hit = usage?.prompt_cache_hit_tokens;
  const miss = usage?.prompt_cache_miss_tokens;
  return (
    typeof hit === 'number' &&
    typeof miss === 'number' &&
    Number.isSafeInteger(hit) &&
    Number.isSafeInteger(miss) &&
    hit >= 0 &&
    miss >= 0 &&
    hit + miss === usage?.prompt_tokens
  );
}

/** Applies only to registered built-in profiles; custom tables retain legacy policy. */
export function isBuiltinTablePricingEligible(
  profile: ProviderProfile,
  context: PricingContext,
): boolean {
  const policy = profile.pricing.kind === 'table' ? policies.get(profile.pricing.table) : undefined;
  if (!policy) return true;

  if (policy.canonicalBaseUrl && context.baseUrl !== policy.canonicalBaseUrl) return false;
  if (policy.requireCacheSplit && !hasValidRequiredCacheSplit(context)) return false;
  if (policy.functionToolsOnly && !hasFunctionToolsOnly(context.request?.tools)) return false;
  if (
    policy.chargedRequestModifiers?.some((modifier) => context.request?.[modifier] !== undefined)
  ) {
    return false;
  }

  if (!policy.supportedServiceTiers) return true;
  const requestTier = context.request?.service_tier ?? context.request?.serviceTier;
  const responseTier = context.response?.service_tier ?? context.response?.serviceTier;
  const effectiveTier = responseTier ?? requestTier;
  // No explicit tier is the standard on-demand request. `auto` requires the
  // response to resolve to one of the source-documented billable tiers.
  if (effectiveTier === undefined) return true;
  return typeof effectiveTier === 'string' && policy.supportedServiceTiers.includes(effectiveTier);
}
