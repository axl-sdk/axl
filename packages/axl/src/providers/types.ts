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
 * Unified thinking/reasoning level that works across all providers.
 *
 * Simple form (`'low' | 'medium' | 'high' | 'max'`) is portable across all providers:
 * - **OpenAI** (o1/o3/o4-mini): maps to `reasoning_effort` (`'max'` → `'xhigh'`)
 * - **OpenAI Responses**: maps to `reasoning.effort` (`'max'` → `'xhigh'`)
 * - **Anthropic** (4.6): maps to adaptive mode + `output_config.effort`
 * - **Anthropic** (older): maps to `thinking.budget_tokens` (`'max'` → `32000`)
 * - **Gemini** (2.5+): maps to `generationConfig.thinkingConfig.thinkingBudget` (`'max'` → `24576`)
 *
 * Budget form (`{ budgetTokens: number }`) gives explicit control over thinking tokens.
 * For OpenAI, budget is mapped to the nearest effort level.
 */
export type Thinking = 'low' | 'medium' | 'high' | 'max' | { budgetTokens: number };

/**
 * Reasoning effort level for OpenAI reasoning models.
 *
 * This is a low-level, OpenAI-specific escape hatch. Prefer `thinking` for cross-provider use.
 *
 * Supported values:
 * - **OpenAI** (o1/o3/o4-mini): all values — `'none'`, `'minimal'`, `'low'`, `'medium'`, `'high'`, `'xhigh'`
 * - **OpenAI Responses**: all values (via `reasoning.effort`)
 * - **Anthropic**: not supported
 * - **Gemini**: not supported
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

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
  thinking?: Thinking;
  reasoningEffort?: ReasoningEffort;
  toolChoice?: ToolChoice;
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
