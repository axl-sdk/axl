import {
  reasoningEffortEmit,
  type PricingTable,
  type ProviderProfile,
} from '../openai-compatible.js';
import { attachBuiltinTablePricingPolicy } from '../builtin-table-pricing.js';

/**
 * Direct `/v1/chat/completions` text model prices, sourced 2026-08-03 from
 * https://mistral.ai/pricing/api/. Cached input is documented as 90% off.
 * Regional, enterprise, Agents/tool, batch, and non-text products are not
 * represented here and therefore remain unpriced.
 */
const MISTRAL_PRICING: PricingTable = {
  'mistral-medium-latest': [1.5e-6, 7.5e-6, 0.1],
  'mistral-small-latest': [0.15e-6, 0.6e-6, 0.1],
  'mistral-large-latest': [0.5e-6, 1.5e-6, 0.1],
  'devstral-medium-latest': [0.4e-6, 2e-6, 0.1],
  'devstral-small-latest': [0.1e-6, 0.3e-6, 0.1],
  'codestral-latest': [0.3e-6, 0.9e-6, 0.1],
  'magistral-medium-latest': [2e-6, 5e-6, 0.1],
  'magistral-small-latest': [0.5e-6, 1.5e-6, 0.1],
  'ministral-3b-latest': [0.1e-6, 0.1e-6, 0.1],
  'ministral-8b-latest': [0.15e-6, 0.15e-6, 0.1],
  'ministral-14b-latest': [0.2e-6, 0.2e-6, 0.1],
  'open-mistral-nemo': [0.15e-6, 0.15e-6, 0.1],
  'open-mixtral-8x7b': [0.7e-6, 0.7e-6, 0.1],
  'open-mixtral-8x22b': [2e-6, 6e-6, 0.1],
};

// `reasoning_effort` on Mistral is supported only by the small/medium families
// (e.g. mistral-small-*, mistral-medium-*) and its accepted vocabulary is
// narrow, so Axl maps any active effort to 'high'. Other models 422 on the
// field; the `magistral-*` reasoning models always reason and reject it too. So
// emit ONLY for the supporting families, and omit everywhere else (a documented
// no-op). (Model-prefix heuristic; lives in the adapter, overridable via
// providerOptions.)
const acceptsReasoningEffort = (model: string) => /^mistral-(small|medium)/i.test(model);

/**
 * Mistral. OpenAI-compatible at `https://api.mistral.ai/v1`.
 *
 * `reasoning_effort` is emitted as `'high'` for the small/medium families when
 * effort is active, and omitted otherwise (other models 422; `magistral-*`
 * always-reason and reject the field).
 */
export const MISTRAL_PROFILE: ProviderProfile = {
  name: 'mistral',
  label: 'Mistral',
  defaultBaseUrl: 'https://api.mistral.ai/v1',
  envApiKey: 'MISTRAL_API_KEY',
  envBaseUrl: 'MISTRAL_BASE_URL',
  pricing: { kind: 'table', table: MISTRAL_PRICING, match: 'exact' },
  reasoning: {
    emit: reasoningEffortEmit((resolved, model) => {
      if (!acceptsReasoningEffort(model)) return undefined;
      if (resolved.thinkingDisabled || !resolved.activeEffort) return undefined;
      return 'high'; // Mistral's reasoning_effort vocabulary is too narrow to map low/medium
    }),
    capture: 'reasoning_content',
  },
};

attachBuiltinTablePricingPolicy(MISTRAL_PROFILE, {
  canonicalBaseUrl: 'https://api.mistral.ai/v1',
});
