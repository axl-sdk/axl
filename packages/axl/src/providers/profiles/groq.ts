import { reasoningEffortEmit, type ProviderProfile } from '../openai-compatible.js';

// Groq serves both reasoning (gpt-oss, qwen3, deepseek-r1 distills, qwq) and
// plain open-weight models. reasoning_effort 400s on the non-reasoning ones, so
// emit it only for reasoning families. (Model-prefix heuristic; lives in the
// adapter where rot is acceptable, and is overridable via providerOptions.)
const isReasoningModel = (model: string) => /gpt-oss|qwen3|deepseek-r1|qwq/i.test(model);

/**
 * Groq — fastest inference (LPU), OpenAI-compatible at
 * `https://api.groq.com/openai/v1`. Open-weight models only.
 *
 * - 400s on `messages[].name` → not emitted.
 * - `reasoning_effort` only for reasoning families (above); `xhigh`/`max` clamp
 *   to `high`.
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
      if (!isReasoningModel(model) || resolved.thinkingDisabled || !resolved.activeEffort) {
        return undefined;
      }
      const e = resolved.activeEffort;
      return e === 'xhigh' || e === 'max' ? 'high' : e;
    }),
    capture: 'reasoning',
  },
  capabilities: {
    emitsMessageName: false,
  },
};
