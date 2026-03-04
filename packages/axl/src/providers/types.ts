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
  reasoningEffort?: 'low' | 'medium' | 'high';
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
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
