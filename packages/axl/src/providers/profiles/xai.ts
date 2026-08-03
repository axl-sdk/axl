import { reasoningEffortEmit, type ProviderProfile } from '../openai-compatible.js';

// Exact Chat Completions descriptors only. Reviewed 2026-08-03 against the
// first-party xAI model catalog and capability pages. Unknown siblings
// intentionally pass through untouched: xAI model names are not a capability
// contract.
const GROK_45 = new Set(['grok-4.5', 'grok-4.5-latest', 'grok-build-latest']);
const GROK_43 = new Set(['grok-4.3', 'grok-4.3-latest', 'grok-latest']);
const GROK_420_REASONING = new Set([
  'grok-4.20-0309-reasoning',
  'grok-4.20-reasoning-latest',
  'grok-4.20',
  'grok-4.20-reasoning',
  'grok-4.20-0309',
  'grok-4.20-beta-0309-reasoning',
  'grok-4.20-beta',
  'grok-4.20-beta-0309',
  'grok-4.20-beta-latest',
  'grok-4.20-beta-latest-reasoning',
  'grok-4.20-beta-reasoning',
  'grok-4.20-experimental-beta-0304-reasoning',
  'grok-4.20-experimental-beta-0304',
  'grok-4.20-experimental-beta-reasoning-latest',
  'grok-4.20-experimental-beta-latest',
  'grok-4.20-reasoning-gv2',
]);
const GROK_420_NON_REASONING = new Set([
  'grok-4.20-0309-non-reasoning',
  'grok-4.20-non-reasoning',
  'grok-4.20-non-reasoning-latest',
  'grok-4.20-beta-non-reasoning',
  'grok-4.20-beta-latest-non-reasoning',
  'grok-4.20-experimental-beta-0304-non-reasoning',
  'grok-4.20-experimental-beta-non-reasoning-latest',
  'grok-4.20-beta-0309-non-reasoning',
  'grok-4.20-non-reasoning-gv2',
]);

const warnedIrreducible45 = new Set<string>();
const warnedEffortClamp = new Set<string>();
function warnIrreducible45(model: string): void {
  if (warnedIrreducible45.has(model)) return;
  warnedIrreducible45.add(model);
  console.warn(
    `[axl] effort: 'none' on xAI ${model} maps to 'low'; Grok 4.5 cannot disable reasoning.`,
  );
}

function warnEffortClamp(model: string, effort: 'xhigh' | 'max'): void {
  const key = `${model}:${effort}`;
  if (warnedEffortClamp.has(key)) return;
  warnedEffortClamp.add(key);
  console.warn(
    `[axl] effort: '${effort}' on xAI ${model} maps to 'high'; this model supports at most 'high'.`,
  );
}

const isReasoningChatModel = (model: string) =>
  GROK_45.has(model) || GROK_43.has(model) || GROK_420_REASONING.has(model);

/**
 * xAI (Grok) Chat Completions at `https://api.x.ai/v1`.
 *
 * Pricing is the exact response total in `usage.cost_in_usd_ticks`; it already
 * includes cache, service-tier, and server-side-tool charges. Grok 4.20
 * multi-agent is Responses-only, so it deliberately has no Chat descriptor.
 */
export const XAI_PROFILE: ProviderProfile = {
  name: 'xai',
  label: 'xAI',
  defaultBaseUrl: 'https://api.x.ai/v1',
  envApiKey: 'XAI_API_KEY',
  envBaseUrl: 'XAI_BASE_URL',
  pricing: { kind: 'from-response' },
  reasoning: {
    emit: reasoningEffortEmit((resolved, model) => {
      if (GROK_45.has(model)) {
        if (resolved.thinkingDisabled) {
          warnIrreducible45(model);
          return 'low';
        }
        if (!resolved.activeEffort) return undefined;
        if (resolved.activeEffort === 'xhigh' || resolved.activeEffort === 'max') {
          warnEffortClamp(model, resolved.activeEffort);
          return 'high';
        }
        return resolved.activeEffort;
      }
      if (GROK_43.has(model)) {
        if (resolved.thinkingDisabled) return 'none';
        if (!resolved.activeEffort) return undefined;
        if (resolved.activeEffort === 'xhigh' || resolved.activeEffort === 'max') {
          warnEffortClamp(model, resolved.activeEffort);
          return 'high';
        }
        return resolved.activeEffort;
      }
      if (GROK_420_NON_REASONING.has(model)) return undefined;
      // The documented 4.20 Chat reasoning aliases have parameter restrictions,
      // but no established Chat `reasoning_effort` control. Do not infer one.
      return undefined;
    }),
    capture: 'reasoning',
  },
  capabilities: {
    forbiddenParams: (model) =>
      isReasoningChatModel(model) ? ['stop', 'presence_penalty', 'frequency_penalty'] : [],
  },
};
