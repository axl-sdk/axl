import { reasoningEffortEmit, type ProviderProfile } from '../openai-compatible.js';

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
  pricing: { kind: 'unknown' },
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
