import { isOSeriesModel, openaiReasoningEmit, OPENAI_PRICING } from '../openai.js';
import type { ProviderProfile } from '../openai-compatible.js';

/**
 * Azure OpenAI (v1 API).
 *
 * The mid-2026 v1 surface drops the old `/deployments/{id}/` path and
 * `api-version` query param: the deployment name goes in the `model` field and
 * the base URL is `https://{resource}.openai.azure.com/openai/v1`. Set it via
 * the `azure` provider's `baseUrl` config or `AZURE_OPENAI_BASE_URL` — the
 * placeholder default below fails loudly if neither is provided.
 *
 * Auth: API-key auth uses the `api-key` header (NOT `Authorization: Bearer`).
 * Entra/AAD bearer-token auth needs the async key callback (Tier 2) and is not
 * wired here.
 *
 * Azure serves OpenAI models, so the OpenAI reasoning logic and pricing table
 * are reused. Caveat: deployment names are arbitrary, so o-series/GPT-5
 * detection and pricing only fire when the deployment is named after the model;
 * otherwise effort is a no-op and cost is `undefined` (honest, not a fake $0).
 */
export const AZURE_PROFILE: ProviderProfile = {
  name: 'azure',
  label: 'Azure OpenAI',
  // Intentionally a placeholder — Azure base URLs are resource-specific.
  defaultBaseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1',
  envApiKey: 'AZURE_OPENAI_API_KEY',
  envBaseUrl: 'AZURE_OPENAI_BASE_URL',
  authHeader: 'api-key',
  pricing: { kind: 'table', table: OPENAI_PRICING },
  reasoning: { emit: openaiReasoningEmit, capture: 'none' },
  roleFor: (role, model) => (role === 'system' && isOSeriesModel(model) ? 'developer' : role),
  maxTokensField: 'max_completion_tokens',
  parallelToolCalls: (model) => !isOSeriesModel(model),
};
