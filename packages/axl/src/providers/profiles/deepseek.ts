import type { PricingTable, ProviderProfile, ReasoningEmit } from '../openai-compatible.js';
import { attachBuiltinTablePricingPolicy } from '../builtin-table-pricing.js';

/**
 * Direct V4 Chat prices, sourced 2026-08-03 from
 * https://api-docs.deepseek.com/quick_start/pricing. The documented future
 * 2x peak multiplier has no effective date, so this remains a flat-current table.
 */
const DEEPSEEK_PRICING: PricingTable = {
  'deepseek-v4-flash': [0.14e-6, 0.28e-6, 0.02],
  'deepseek-v4-pro': [0.435e-6, 0.87e-6, 1 / 120],
};

// Thinking models: the classic `deepseek-reasoner` (retires 2026-07-24) and the
// V4 thinking families. They reason automatically and reject/ignore sampling
// params; non-thinking `deepseek-chat` keeps them.
const isReasoner = (model: string) => /reasoner|v4/i.test(model);

/**
 * DeepSeek thinking models (`deepseek-reasoner`) reason automatically — there is
 * no `reasoning_effort` knob — and they reject sampling params (`temperature`,
 * `top_p`, penalties) while thinking. So effort is a no-op here; we only strip
 * temperature for reasoner models. `deepseek-chat` behaves like a normal model.
 */
const deepseekEmit: ReasoningEmit = (_body, _resolved, model) => ({
  stripTemperature: isReasoner(model),
});

/**
 * DeepSeek. OpenAI-compatible at `https://api.deepseek.com/v1`.
 *
 * - Reasoning text arrives in `message.reasoning_content` (captured to
 *   thinking) and MUST be echoed back on tool-call turns or the API 400s mid
 *   tool-loop — the turn-aware `on-tool-call-turns` round-trip handles that.
 * - No strict `json_schema`; falls back to `json_object`.
 * - Reasoner models reject sampling params (temperature stripped; `top_p` and
 *   penalties stripped if engine-set — they are user-only here, so listed for
 *   intent + future-proofing).
 */
export const DEEPSEEK_PROFILE: ProviderProfile = {
  name: 'deepseek',
  label: 'DeepSeek',
  defaultBaseUrl: 'https://api.deepseek.com/v1',
  envApiKey: 'DEEPSEEK_API_KEY',
  envBaseUrl: 'DEEPSEEK_BASE_URL',
  pricing: { kind: 'table', table: DEEPSEEK_PRICING, match: 'exact' },
  reasoning: {
    emit: deepseekEmit,
    capture: 'reasoning_content',
    roundTrip: 'on-tool-call-turns',
  },
  capabilities: {
    supportsJsonSchema: false,
    forbiddenParams: (model) =>
      isReasoner(model) ? ['top_p', 'presence_penalty', 'frequency_penalty'] : [],
  },
};

attachBuiltinTablePricingPolicy(DEEPSEEK_PROFILE, {
  canonicalBaseUrl: 'https://api.deepseek.com/v1',
  requireCacheSplit: true,
});
