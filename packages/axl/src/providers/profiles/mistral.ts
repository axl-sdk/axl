import { reasoningEffortEmit, type ProviderProfile } from '../openai-compatible.js';

/**
 * Mistral. OpenAI-compatible at `https://api.mistral.ai/v1`.
 *
 * `reasoning_effort` accepts only `'low'` | `'medium'` ... no: Mistral's
 * supported values are narrow — it rejects (422) anything other than the
 * documented set, so Axl maps any active effort to `'high'` and omits the field
 * when reasoning is disabled. `magistral-*` reasoning models reject
 * `reasoning_effort` entirely (they always reason) → omitted for them.
 */
export const MISTRAL_PROFILE: ProviderProfile = {
  name: 'mistral',
  label: 'Mistral',
  defaultBaseUrl: 'https://api.mistral.ai/v1',
  envApiKey: 'MISTRAL_API_KEY',
  envBaseUrl: 'MISTRAL_BASE_URL',
  pricing: { kind: 'unknown' },
  reasoning: {
    emit: reasoningEffortEmit((resolved, model) => {
      if (model.startsWith('magistral')) return undefined; // always-reasoning; rejects the field
      if (resolved.thinkingDisabled || !resolved.activeEffort) return undefined;
      return 'high'; // Mistral's reasoning_effort vocabulary is too narrow to map low/medium
    }),
    capture: 'reasoning_content',
  },
};
