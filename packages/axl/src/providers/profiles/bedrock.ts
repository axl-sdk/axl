import { reasoningEffortEmit, type ProviderProfile } from '../openai-compatible.js';

// Bedrock's OpenAI-compatible endpoint serves gpt-oss (and Claude, but Claude is
// deferred to Tier 3 on the native anthropic adapter). gpt-oss exposes
// reasoning_effort (low/medium/high); emit it only for that family.
const isGptOss = (model: string) => /gpt-oss/i.test(model);

/**
 * AWS Bedrock — OpenAI-compatible surface (gpt-oss), bearer-token auth.
 *
 * - Base URL is region-specific, so `requireExplicitBaseUrl` forces a real value
 *   (`providers.bedrock.baseUrl` or `BEDROCK_BASE_URL`). Prefer the current
 *   `bedrock-mantle` endpoint: `https://bedrock-mantle.{region}.api.aws/v1`
 *   (legacy: `https://bedrock-runtime.{region}.amazonaws.com/openai/v1`).
 * - Auth: a bearer API key (`AWS_BEARER_TOKEN_BEDROCK`); short-term tokens can use
 *   the async `apiKey` callback (T2.2). No SigV4.
 * - Model ids are AWS-namespaced WITH a version suffix — pass them in full, e.g.
 *   `bedrock:openai.gpt-oss-120b-1:0` / `bedrock:openai.gpt-oss-20b-1:0`.
 * - Pricing: `unknown` — Bedrock returns the standard OpenAI usage object with no
 *   `cost` field, so per-call cost can't be derived (surfaced honestly, never $0).
 *
 * Scope: gpt-oss for Tier 2. Claude-on-Bedrock is a Tier-3 native-adapter mode.
 */
export const BEDROCK_PROFILE: ProviderProfile = {
  name: 'bedrock',
  label: 'AWS Bedrock',
  // Never used — requireExplicitBaseUrl forces a real (region-specific) value first.
  defaultBaseUrl: 'https://bedrock-mantle.us-east-1.api.aws/v1',
  requireExplicitBaseUrl: true,
  envApiKey: 'AWS_BEARER_TOKEN_BEDROCK',
  envBaseUrl: 'BEDROCK_BASE_URL',
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
};
