import { isOSeriesModel, openaiReasoningEmit, OPENAI_PRICING } from '../openai.js';
import type { ProviderProfile } from '../openai-compatible.js';

/**
 * Azure OpenAI (v1 API).
 *
 * The mid-2026 v1 surface drops the old `/deployments/{id}/` path and
 * `api-version` query param: the deployment name goes in the `model` field and
 * the base URL is `https://{resource}.openai.azure.com/openai/v1`. It is
 * resource-specific, so `requireExplicitBaseUrl` makes the constructor throw if
 * neither `providers.azure.baseUrl` nor `AZURE_OPENAI_BASE_URL` is set.
 *
 * Auth: API-key auth uses the `api-key` header (NOT `Authorization: Bearer`).
 * Entra/AAD bearer-token auth uses the async key callback plus an `authHeader:
 * 'bearer'` override.
 *
 * Azure serves OpenAI models, so the OpenAI reasoning logic and pricing table
 * are reused. Caveat: deployment names are arbitrary, so o-series/GPT-5
 * detection and pricing only fire when the deployment is named after the model;
 * otherwise effort is a no-op and cost is `undefined` (honest, not a fake $0).
 */
export const AZURE_PROFILE: ProviderProfile = {
  name: 'azure',
  label: 'Azure OpenAI',
  // Never actually used — requireExplicitBaseUrl forces a real value first.
  defaultBaseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1',
  requireExplicitBaseUrl: true,
  envApiKey: 'AZURE_OPENAI_API_KEY',
  envBaseUrl: 'AZURE_OPENAI_BASE_URL',
  authHeader: 'api-key',
  pricing: { kind: 'table', table: OPENAI_PRICING },
  reasoning: { emit: openaiReasoningEmit, capture: 'none' },
  roleFor: (role, model) => (role === 'system' && isOSeriesModel(model) ? 'developer' : role),
  maxTokensField: 'max_completion_tokens',
  parallelToolCalls: (model) => !isOSeriesModel(model),
};
