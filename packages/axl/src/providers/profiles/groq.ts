import {
  reasoningEffortEmit,
  type PricingTable,
  type ProviderProfile,
} from '../openai-compatible.js';
import { attachBuiltinTablePricingPolicy } from '../builtin-table-pricing.js';

/**
 * Direct production text prices, sourced 2026-08-03 from
 * https://console.groq.com/docs/models. GPT-OSS prompt-cache reads are 50% of
 * input; the other rows have no documented cache discount. On-demand and Flex
 * share these rates; Performance, Compound, preview, and contact-sales
 * offerings are unpriced.
 */
const GROQ_PRICING: PricingTable = {
  'llama-3.1-8b-instant': [0.05e-6, 0.08e-6, 1],
  'llama-3.3-70b-versatile': [0.59e-6, 0.79e-6, 1],
  'openai/gpt-oss-120b': [0.15e-6, 0.6e-6, 0.5],
  'openai/gpt-oss-20b': [0.075e-6, 0.3e-6, 0.5],
};

// `reasoning_effort` is per-FAMILY on Groq, not just per-reasoning-model:
//  - gpt-oss accepts low | medium | high.
//  - qwen3 / qwq / deepseek-r1 distills accept only none | default — passing
//    low/medium/high 400s ("reasoning_effort must be one of none or default").
// So map the unified effort to a wire value ONLY for gpt-oss; for the other
// reasoning families, omit the field and let the model default (effort is a
// documented no-op there). Plain open-weight models also 400 on the field, so
// they're omitted too. (Model-prefix heuristic; lives in the adapter where rot
// is acceptable, overridable via providerOptions.)
const isGptOss = (model: string) => /gpt-oss/i.test(model);

/**
 * Groq — fastest inference (LPU), OpenAI-compatible at
 * `https://api.groq.com/openai/v1`. Open-weight models only.
 *
 * - 400s on `messages[].name` → not emitted.
 * - `reasoning_effort` (low/medium/high; `xhigh`/`max`→`high`) for gpt-oss only;
 *   a no-op on other models (whose vocab differs / who reject the field).
 * - Reasoning text comes back in `message.reasoning` (gpt-oss).
 */
export const GROQ_PROFILE: ProviderProfile = {
  name: 'groq',
  label: 'Groq',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  envApiKey: 'GROQ_API_KEY',
  envBaseUrl: 'GROQ_BASE_URL',
  pricing: {
    kind: 'table',
    table: GROQ_PRICING,
    match: 'exact',
  },
  reasoning: {
    emit: reasoningEffortEmit((resolved, model) => {
      if (!isGptOss(model) || resolved.thinkingDisabled || !resolved.activeEffort) {
        return undefined;
      }
      const e = resolved.activeEffort;
      return e === 'xhigh' || e === 'max' ? 'high' : e;
    }),
    capture: 'reasoning',
  },
  capabilities: {
    emitsMessageName: false,
    // Groq's `response_format: json_schema` is supported only on a subset of
    // models — the `openai/gpt-oss-*` family accepts it; llama/gemma/etc 400
    // with "This model does not support response format `json_schema`".
    // Per-model so `nativeStructuredOutput` engages the native path only where
    // it works and otherwise downgrades cleanly to `json_object` (verified live).
    supportsJsonSchema: isGptOss,
  },
};

attachBuiltinTablePricingPolicy(GROQ_PROFILE, {
  canonicalBaseUrl: 'https://api.groq.com/openai/v1',
  supportedServiceTiers: ['on_demand', 'flex'],
  functionToolsOnly: true,
  chargedRequestModifiers: [
    'browser_search',
    'code_interpreter',
    'web_search',
    'visit_website',
    'wolfram_alpha',
    'remote_mcp',
    'mcp',
    'compound_custom',
  ],
});
