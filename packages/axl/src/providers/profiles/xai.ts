import { reasoningEffortEmit, type ProviderProfile } from '../openai-compatible.js';

// xAI reasoning support is per-model:
//  - grok-3-mini family exposes reasoning_effort (low | high).
//  - grok-4 / grok-4-1-fast reason automatically and 400 if you SEND
//    reasoning_effort — so effort is a (documented) no-op there.
//  - All xAI reasoning models 400 on `stop` and the penalty params.
// We emit reasoning_effort only for the family that accepts it, and strip
// stop/penalties for every reasoning model. (Model-prefix heuristics; live in
// the adapter where rot is acceptable, overridable via providerOptions.)
const acceptsReasoningEffort = (model: string) => model.startsWith('grok-3-mini');
const isReasoningModel = (model: string) => /^grok-(3-mini|4)/.test(model);

/**
 * xAI (Grok). OpenAI-compatible at `https://api.x.ai/v1`.
 *
 * - `reasoning_effort` (`low` for effort `low`, else `high`) for grok-3-mini;
 *   omitted for grok-4* (auto-reasoning) and non-reasoning models.
 * - `stop` + penalty params are stripped on reasoning models (they 400).
 *   Penalties aren't engine-computed, so they only matter if a user adds them.
 */
export const XAI_PROFILE: ProviderProfile = {
  name: 'xai',
  label: 'xAI',
  defaultBaseUrl: 'https://api.x.ai/v1',
  envApiKey: 'XAI_API_KEY',
  envBaseUrl: 'XAI_BASE_URL',
  pricing: { kind: 'unknown' },
  reasoning: {
    emit: reasoningEffortEmit((resolved, model) => {
      if (!acceptsReasoningEffort(model)) return undefined;
      if (resolved.thinkingDisabled || !resolved.activeEffort) return undefined;
      return resolved.activeEffort === 'low' ? 'low' : 'high'; // grok-3-mini: low | high only
    }),
    capture: 'reasoning',
  },
  capabilities: {
    forbiddenParams: (model) =>
      isReasoningModel(model) ? ['stop', 'presence_penalty', 'frequency_penalty'] : [],
  },
};
