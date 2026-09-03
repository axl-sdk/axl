import type { ChatMessage, ProviderResponse, ToolCallMessage } from '../types.js';
import type { InputMediaSource, ModelInput } from '../input.js';

// Re-export for convenience
export type { ChatMessage, ProviderResponse, ToolCallMessage };

export type InputModalitySupport = {
  image?: { sources: readonly InputMediaSource['type'][] };
};

export type ProviderInputValidationRequest = {
  model: string;
  input: ModelInput;
  /** Application-owned history that will accompany this input. Validators must
   * cover every rich part/source across both input and history. */
  history: readonly ChatMessage[];
  stream: boolean;
  hasTools: boolean;
  responseMode: 'text' | 'structured';
  providerOptions?: Record<string, unknown>;
};

export type ProviderInputValidationResult = { effectiveModel: string };

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
 * - `'xhigh'` — Extra-high tier between `'high'` and `'max'`. Supported natively on
 *   Anthropic Opus 4.7 (`output_config.effort: 'xhigh'`) and OpenAI gpt-5.2+
 *   (`reasoning_effort: 'xhigh'`). Clamps to `'high'` on providers/models that
 *   don't expose a distinct xhigh level.
 *
 * Provider mapping:
 * - Anthropic 4.7: adaptive thinking + output_config.effort (incl. 'xhigh')
 * - Anthropic 4.6: adaptive thinking + output_config.effort (xhigh clamps to 'high')
 * - Anthropic Opus 4.5: output_config.effort (no adaptive; xhigh clamps to 'high')
 * - Anthropic older: thinking.budget_tokens fallback
 * - OpenAI o-series: reasoning_effort
 * - OpenAI GPT-5.x: reasoning.effort / reasoning_effort (xhigh on gpt-5.2+)
 * - Gemini 3.x: thinkingLevel (`'none'` → model min: `'minimal'` or `'low'` for 3.1 Pro; xhigh → 'high')
 * - Gemini 2.x: thinkingBudget (`'none'` → 0; some models have minimums)
 */
export type Effort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
        /** Tokens written to a provider prompt cache during this call, when reported. */
        cache_write_tokens?: number;
      };
      /** Estimated cost in USD for this call, computed the same way as ProviderResponse.cost. */
      cost?: number;
      /** Provider-specific opaque metadata (e.g. raw Gemini parts with thought signatures). */
      providerMetadata?: Record<string, unknown>;
    };

/**
 * Core provider interface. Every LLM adapter must implement this.
 */
export interface Provider {
  /** Human-readable name for the provider (e.g. "openai", "anthropic") */
  readonly name?: string;
  /** Coarse, model-aware input metadata for UI/documentation. */
  inputCapabilities?(model: string): InputModalitySupport;
  /** Authoritative request-scoped rich-input validation. Omission means text-only. */
  validateInput?(request: ProviderInputValidationRequest): ProviderInputValidationResult;

  /**
   * Send a chat completion request and return the full response.
   */
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse>;

  /**
   * Stream a chat completion, yielding chunks as they arrive.
   */
  stream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk>;

  /**
   * How this provider honors a `responseFormat: { type: 'json_schema' }` derived
   * from the caller's Zod schema, for `model` (spec 22, Problem B / R10). Used by
   * the runtime to warn — via a `schema_diagnostic` — when `nativeStructuredOutput`
   * can't be honored, WITHOUT failing the call (portable multi-provider code must
   * still run). Optional: an adapter that omits it is assumed to honor the schema
   * fully (`'schema'`), so unknown adapters simply opt out of the warning.
   *
   *  - `'schema'` — accepts a `json_schema` response format for this model (the
   *    strongest tier; e.g. OpenAI/Responses). Note: Axl currently sends
   *    NON-strict `json_schema` (it does not set `strict: true`), so on OpenAI
   *    this is schema-as-guidance, not hard constrained decoding — true strict
   *    mode needs an OpenAI-strict-subset schema transform and is a follow-up.
   *  - `'downgraded'` — accepted but downgraded to plain `json_object`; the schema
   *    shape is NOT enforced structurally (e.g. an OpenAI-compatible profile with
   *    `supportsJsonSchema: false`).
   *  - `'lossy'` — accepted but the schema is sanitized and may lose keywords
   *    (e.g. Gemini strips `$ref`/`$defs`/`additionalProperties`).
   *  - `'unsupported'` — ignored structurally; the provider relies on the prompt
   *    JSON instruction instead (e.g. Anthropic).
   */
  nativeStructuredOutputSupport?(model: string): 'schema' | 'downgraded' | 'lossy' | 'unsupported';

  /**
   * How this provider resolved the unified `effort` knob for this request.
   *
   * Adapters clamp `effort` to what each model actually accepts (Gemini 3.x
   * cannot disable thinking; OpenAI Chat Completions caps `'max'` at `'xhigh'`;
   * Anthropic models that always think fall back to adaptive `'low'`). That
   * clamp used to be invisible to run provenance. The runtime calls this once
   * per ask, right after provider resolution, and emits a
   * `provider_diagnostic { kind: 'effort_clamped' }` event plus a deduped
   * `console.warn` when `clamped` is true — the adapter only *reports*, the
   * runtime decides how to surface it (only the runtime can see
   * `AxlConfig.diagnostics.silent`).
   *
   * The adapter applies its own `providerOptions.model` override before
   * resolving, so the report describes the model actually sent.
   *
   * Optional, and optional to answer: return `undefined` when there is nothing
   * to report (no effort requested, the model is unknown, or the effort is
   * honored verbatim). An adapter MAY also report an honored resolution with
   * `clamped: false`; the runtime stays silent for those.
   */
  effortResolution?(
    options: Pick<
      ChatOptions,
      'model' | 'effort' | 'thinkingBudget' | 'includeThoughts' | 'providerOptions'
    >,
  ): EffortResolution | undefined;
}

/**
 * An adapter's report of how it resolved the unified `effort` for one request.
 *
 * `effective` is a provider-NATIVE level string rather than an `Effort` because
 * not every effective value maps back onto the unified union (Gemini's
 * `'minimal'`, OpenAI's `'minimal'`, Anthropic's adaptive `'low'`).
 */
export type EffortResolution = {
  /** The unified effort the caller asked for. */
  requested: Effort;
  /** The provider-native level actually sent (e.g. `'minimal'`, `'xhigh'`, `'low'`). */
  effective: string;
  /** True when `effective` is not what `requested` asked for. */
  clamped: boolean;
  /** Human-readable reason, surfaced verbatim on the diagnostic event. */
  cause?: string;
};

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

/**
 * An API key, or a function that produces one per request. The function form
 * supports expiring credentials (Azure-Entra, Databricks/IBM OAuth, Bedrock
 * short-term tokens): the caller's callback owns refresh/caching; Axl invokes it
 * once per request and does not memoize. See `docs/providers.md`.
 */
export type ApiKeySource = string | (() => string | Promise<string>);

/** Resolve an {@link ApiKeySource} to a concrete key for a single request. */
export async function resolveApiKey(source: ApiKeySource | undefined): Promise<string> {
  if (typeof source === 'function') return (await source()) ?? '';
  return source ?? '';
}
