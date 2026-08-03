import { reasoningObjectEmit, type ProviderProfile } from '../openai-compatible.js';

/**
 * OpenRouter — one key fronts 300+ models across vendors.
 *
 * - Reasoning is the unified `reasoning` object (`{ effort }` XOR `{ max_tokens }`,
 *   or `{ enabled: false }`); reasoning text comes back in `message.reasoning`
 *   with a structured `reasoning_details[]` we round-trip on tool-call turns.
 * - Cost is provider-reported in `usage.cost` (USD), so Axl keeps
 *   cost-as-a-primitive working across the whole catalog where a static table
 *   never could. OpenRouter now returns it automatically; no request opt-in.
 * - Model ids are `vendor/model` slugs (e.g. `anthropic/claude-opus-4.7`); the
 *   registry's first-colon split keeps `openrouter:anthropic/claude-…` intact.
 *
 * Capability (json_schema, tool calling) is per-MODEL on a marketplace — the
 * profile defaults are optimistic; use `providerOptions` for per-call overrides.
 */
export const OPENROUTER_PROFILE: ProviderProfile = {
  name: 'openrouter',
  label: 'OpenRouter',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  envApiKey: 'OPENROUTER_API_KEY',
  envBaseUrl: 'OPENROUTER_BASE_URL',
  pricing: { kind: 'from-response' },
  reasoning: {
    // OpenRouter's effort vocabulary is low|medium|high; xhigh/max clamp to high.
    emit: reasoningObjectEmit((effort) =>
      effort === 'xhigh' || effort === 'max' ? 'high' : effort,
    ),
    capture: 'reasoning_details',
    roundTrip: 'on-tool-call-turns',
  },
  // OpenRouter normalizes to max_tokens across its backends.
  maxTokensField: 'max_tokens',
};
