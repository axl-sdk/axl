import { reasoningEffortEmit, type ProviderProfile } from '../openai-compatible.js';

/**
 * xAI (Grok). OpenAI-compatible at `https://api.x.ai/v1`.
 *
 * - `reasoning_effort` uses the same vocabulary as Axl's effort; `xhigh`/`max`
 *   clamp to `high` (xAI rejects `xhigh`).
 * - Grok-4 reasoning models 400 on `stop` and the penalty params — stripped via
 *   `forbiddenParams` for `grok-4*` only (chat variants keep `stop`). Penalties
 *   aren't engine-computed, so they only matter if a user adds them.
 */
export const XAI_PROFILE: ProviderProfile = {
  name: 'xai',
  label: 'xAI',
  defaultBaseUrl: 'https://api.x.ai/v1',
  envApiKey: 'XAI_API_KEY',
  envBaseUrl: 'XAI_BASE_URL',
  pricing: { kind: 'unknown' },
  reasoning: {
    emit: reasoningEffortEmit((resolved) => {
      if (resolved.thinkingDisabled || !resolved.activeEffort) return undefined;
      const e = resolved.activeEffort;
      return e === 'xhigh' || e === 'max' ? 'high' : e;
    }),
    capture: 'reasoning',
  },
  capabilities: {
    forbiddenParams: (model) =>
      model.startsWith('grok-4') ? ['stop', 'presence_penalty', 'frequency_penalty'] : [],
  },
};
