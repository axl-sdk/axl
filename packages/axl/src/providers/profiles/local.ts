import type { ProviderProfile } from '../openai-compatible.js';

/**
 * Self-hosted / local OpenAI-compatible runtimes.
 *
 * They all speak `/v1/chat/completions`, so this is a config job, not a fleet of
 * adapters. Shared traits:
 * - No auth by default (`allowMissingApiKey`) — pass a key only if your server
 *   enforces one.
 * - Cost is explicitly `0` (NEVER a table miss — a local model named `gpt-4o`
 *   must not be billed at OpenAI rates).
 * - Reasoning, when present, is inline `<think>…</think>` (R1-style) — captured
 *   and stripped by the streaming-safe scanner.
 * - `max_tokens` (the field these servers accept).
 *
 * Caveats worth knowing (server-side, not Axl bugs): Ollama's `/v1` drops
 * streaming `tool_calls` deltas and lacks `tool_choice` (use its native
 * `/api/chat` for heavy tool use); vLLM/SGLang/LM Studio tool-calling depends on
 * server launch flags + per-model parsers; `effort` is largely deploy-time on
 * these, so the unified knob is mostly a no-op.
 */
function localProfile(
  name: string,
  label: string,
  port: number,
  envApiKey: string,
): ProviderProfile {
  return {
    name,
    label,
    defaultBaseUrl: `http://localhost:${port}/v1`,
    envApiKey,
    envBaseUrl: `${envApiKey.replace(/_API_KEY$/, '')}_BASE_URL`,
    allowMissingApiKey: true,
    pricing: { kind: 'zero' },
    reasoning: { emit: () => {}, capture: 'think_tags' },
    maxTokensField: 'max_tokens',
  };
}

export const OLLAMA_PROFILE = localProfile('ollama', 'Ollama', 11434, 'OLLAMA_API_KEY');
export const VLLM_PROFILE = localProfile('vllm', 'vLLM', 8000, 'VLLM_API_KEY');
export const LMSTUDIO_PROFILE = localProfile('lmstudio', 'LM Studio', 1234, 'LMSTUDIO_API_KEY');
export const LLAMACPP_PROFILE = localProfile('llamacpp', 'llama.cpp', 8080, 'LLAMACPP_API_KEY');
export const SGLANG_PROFILE = localProfile('sglang', 'SGLang', 30000, 'SGLANG_API_KEY');

export const LOCAL_PROFILES: ProviderProfile[] = [
  OLLAMA_PROFILE,
  VLLM_PROFILE,
  LMSTUDIO_PROFILE,
  LLAMACPP_PROFILE,
  SGLANG_PROFILE,
];
