import type { ChatMessage, ProviderResponse, ToolCallMessage } from '../types.js';

// Re-export for convenience
export type { ChatMessage, ProviderResponse, ToolCallMessage };

/**
 * Tool definition in OpenAI-compatible format.
 * All providers normalize to this format internally.
 */
export type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown; // JSON Schema
    strict?: boolean;
  };
};

/**
 * Unified effort level controlling how thoroughly the model responds.
 *
 * - `'none'` — Disable thinking/reasoning. On Gemini 3.x, maps to the model's
 *   minimum thinking level (3.1 Pro: 'low', others: 'minimal'). On other providers,
 *   fully disables reasoning.
 * - `'low'` through `'max'` — Increasing levels of reasoning depth and token spend.
 *
 * Provider mapping:
 * - Anthropic 4.6: adaptive thinking + output_config.effort
 * - Anthropic Opus 4.5: output_config.effort (no adaptive)
 * - Anthropic older: thinking.budget_tokens fallback
 * - OpenAI o-series: reasoning_effort
 * - OpenAI GPT-5.x: reasoning.effort / reasoning_effort
 * - Gemini 3.x: thinkingLevel (`'none'` → model min: `'minimal'` or `'low'` for 3.1 Pro)
 * - Gemini 2.x: thinkingBudget (`'none'` → 0; some models have minimums)
 */
export type Effort = 'none' | 'low' | 'medium' | 'high' | 'max';

/** Tool choice strategy for LLM calls. */
export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

/**
 * Options passed to provider chat/stream calls.
 */
export type ChatOptions = {
  model: string;
  temperature?: number;
  tools?: ToolDefinition[];
  maxTokens?: number;
  responseFormat?: ResponseFormat;
  stop?: string[];
  signal?: AbortSignal;
  /** How hard should the model try? Primary param for cost/quality tradeoff.
   *  'none' disables thinking/reasoning (Gemini 3.x: maps to minimal).
   *  Omit to use provider defaults. */
  effort?: Effort;
  /** Precise thinking token budget (advanced). When set alongside `effort`, overrides the
   *  thinking/reasoning allocation. On Anthropic 4.6, `effort` still controls output quality
   *  independently. On all other providers, `thinkingBudget` fully overrides `effort` for
   *  reasoning behavior. Set to 0 to disable thinking while keeping effort for output control
   *  (Anthropic-specific optimization; on other providers, simply disables reasoning). */
  thinkingBudget?: number;
  /** Show reasoning summaries in responses (thinking_content / thinking_delta).
   *  Supported on OpenAI Responses API and Gemini. No-op on Anthropic. */
  includeThoughts?: boolean;
  toolChoice?: ToolChoice;
  /** Provider-specific options merged LAST into the raw API request body.
   *  Can override any computed field including model and messages — use with care.
   *  NOT portable across providers — use effort/thinkingBudget/includeThoughts for cross-provider behavior. */
  providerOptions?: Record<string, unknown>;
};

/**
 * Response format for structured output (JSON mode).
 */
export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; strict?: boolean; schema: unknown } };

/**
 * Chunks emitted during streaming.
 */
export type StreamChunk =
  | { type: 'text_delta'; content: string }
  | { type: 'thinking_delta'; content: string }
  | { type: 'tool_call_delta'; id: string; name?: string; arguments?: string }
  | {
      type: 'done';
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        reasoning_tokens?: number;
        cached_tokens?: number;
      };
      /** Provider-specific opaque metadata (e.g. raw Gemini parts with thought signatures). */
      providerMetadata?: Record<string, unknown>;
    };

/**
 * Core provider interface. Every LLM adapter must implement this.
 */
export interface Provider {
  /** Human-readable name for the provider (e.g. "openai", "anthropic") */
  readonly name?: string;

  /**
   * Send a chat completion request and return the full response.
   */
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse>;

  /**
   * Stream a chat completion, yielding chunks as they arrive.
   */
  stream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk>;
}

/**
 * Alias for Provider. Used for backward compatibility with index.ts exports.
 */
export type ProviderAdapter = Provider;

/** Normalized thinking options computed once, used by all providers. */
export type ResolvedThinkingOptions = {
  /** Raw effort value from user. */
  effort: Effort | undefined;
  /** Raw thinking budget from user. */
  thinkingBudget: number | undefined;
  /** Whether to include thought summaries in responses. */
  includeThoughts: boolean;
  /** True when thinking/reasoning should be disabled (effort: 'none' or thinkingBudget: 0). */
  thinkingDisabled: boolean;
  /** Effort level with 'none' stripped (undefined when effort is 'none' or unset). */
  activeEffort: Exclude<Effort, 'none'> | undefined;
  /** True when an explicit positive budget overrides effort-based allocation. */
  hasBudgetOverride: boolean;
};

/** Resolve effort/thinkingBudget/includeThoughts into normalized form.
 *  Validates inputs and computes derived flags used by all provider adapters. */
export function resolveThinkingOptions(
  options: Pick<ChatOptions, 'effort' | 'thinkingBudget' | 'includeThoughts'>,
): ResolvedThinkingOptions {
  if (options.thinkingBudget !== undefined && options.thinkingBudget < 0) {
    throw new Error(`thinkingBudget must be non-negative, got ${options.thinkingBudget}`);
  }
  const effort = options.effort;
  const thinkingBudget = options.thinkingBudget;
  const hasBudgetOverride = thinkingBudget !== undefined && thinkingBudget > 0;
  return {
    effort,
    thinkingBudget,
    includeThoughts: options.includeThoughts ?? false,
    // Budget override wins: effort: 'none' + thinkingBudget: 5000 → thinking enabled
    thinkingDisabled: (effort === 'none' || thinkingBudget === 0) && !hasBudgetOverride,
    activeEffort: effort && effort !== 'none' ? effort : undefined,
    hasBudgetOverride,
  };
}
