import type { ProviderProfile } from '../openai-compatible.js';
import { OPENROUTER_PROFILE } from './openrouter.js';
import { AZURE_PROFILE } from './azure.js';
import { XAI_PROFILE } from './xai.js';
import { DEEPSEEK_PROFILE } from './deepseek.js';
import { MISTRAL_PROFILE } from './mistral.js';
import { GROQ_PROFILE } from './groq.js';
import { BEDROCK_PROFILE } from './bedrock.js';
import { LOCAL_PROFILES } from './local.js';

export { OPENROUTER_PROFILE } from './openrouter.js';
export { AZURE_PROFILE } from './azure.js';
export { XAI_PROFILE } from './xai.js';
export { DEEPSEEK_PROFILE } from './deepseek.js';
export { MISTRAL_PROFILE } from './mistral.js';
export { GROQ_PROFILE } from './groq.js';
export { BEDROCK_PROFILE } from './bedrock.js';
export {
  OLLAMA_PROFILE,
  VLLM_PROFILE,
  LMSTUDIO_PROFILE,
  LLAMACPP_PROFILE,
  SGLANG_PROFILE,
  LOCAL_PROFILES,
} from './local.js';

/**
 * Built-in OpenAI-compatible presets, each served by the generic
 * {@link OpenAICompatibleProvider}. The registry registers one factory per
 * profile under `profile.name` (the `provider:` URI key).
 */
export const BUILTIN_PROFILES: ProviderProfile[] = [
  OPENROUTER_PROFILE,
  AZURE_PROFILE,
  XAI_PROFILE,
  DEEPSEEK_PROFILE,
  MISTRAL_PROFILE,
  GROQ_PROFILE,
  BEDROCK_PROFILE,
  ...LOCAL_PROFILES,
];
