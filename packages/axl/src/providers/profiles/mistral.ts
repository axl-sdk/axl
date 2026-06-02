import { reasoningEffortEmit, type ProviderProfile } from '../openai-compatible.js';

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
  pricing: { kind: 'unknown' },
  reasoning: {
    emit: reasoningEffortEmit((resolved, model) => {
      if (!acceptsReasoningEffort(model)) return undefined;
      if (resolved.thinkingDisabled || !resolved.activeEffort) return undefined;
      return 'high'; // Mistral's reasoning_effort vocabulary is too narrow to map low/medium
    }),
    capture: 'reasoning_content',
  },
};
