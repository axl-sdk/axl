import type {
  Provider,
  ChatOptions,
  ChatMessage,
  ProviderResponse,
  StreamChunk,
  Effort,
} from './types.js';
import type { ChatRole } from '../types.js';
import { resolveThinkingOptions, type ResolvedThinkingOptions } from './types.js';
import { fetchWithRetry } from './retry.js';
import { RateLimiter, type RateLimitConfig } from './rate-limiter.js';

// ===========================================================================
// Generic OpenAI-compatible provider engine.
//
// Every endpoint that speaks the OpenAI `/v1/chat/completions` wire format
// (aggregators, non-Big-3 labs, self-hosted runtimes, enterprise clouds) is
// served by ONE engine parameterized by a `ProviderProfile`. `OpenAIProvider`
// (in openai.ts) is the canonical profile. New providers are profiles + a
// registry factory line — no new request builder or SSE parser per provider.
//
// Design ref: .internal/spec/19-provider-expansion.md
// ===========================================================================

/**
 * A profile value that may legitimately differ per model within one provider.
 * Mirrors the model-aware shape of OpenAI's `clampReasoningEffort(model, …)`.
 * Use a function ONLY where the provider's constraints are genuinely per-model
 * (e.g. xAI reasoning vs chat variants, Mistral `magistral-*`); a plain value
 * otherwise.
 */
export type PerModel<T> = T | ((model: string) => T);

/** Resolve a {@link PerModel} value against a concrete model id. */
export function resolvePerModel<T>(value: PerModel<T> | undefined, model: string, fallback: T): T {
  if (value === undefined) return fallback;
  return typeof value === 'function' ? (value as (m: string) => T)(model) : value;
}

/**
 * Auth header shape.
 * - `'bearer'` → `Authorization: Bearer <key>` (OpenAI and most providers).
 * - `'api-key'` → `api-key: <key>` (Azure OpenAI key auth — no scheme).
 * - object → arbitrary header name + optional scheme prefix.
 */
export type AuthHeader = 'bearer' | 'api-key' | { header: string; scheme?: string };

/** `[inputRatePerToken, outputRatePerToken, cachedInputMultiplier]`. */
export type PricingTable = Record<string, [number, number, number]>;

/**
 * How per-call cost is derived. A miss is **never** silently `0` — it surfaces
 * as `undefined` ("unmeasured") so `ctx.budget()` doesn't treat paid models as
 * free. See spec §6.
 */
export type PricingSource =
  | { kind: 'table'; table: PricingTable }
  /** Provider reports per-call cost in `usage.cost` (OpenRouter credits ≈ USD). */
  | { kind: 'from-response' }
  /** Local/self-hosted: cost is genuinely 0. */
  | { kind: 'zero' }
  /** Non-token billing (credits/DBU/neurons): cost is unknowable → `undefined`. */
  | { kind: 'unknown' };

/** How reasoning/thinking text is captured from a response (chat + stream). */
export type ReasoningCapture =
  /** None — OpenAI Chat Completions has no reasoning surface. */
  | 'none'
  /** `message.reasoning_content` / `delta.reasoning_content` (DeepSeek, Fireworks, Together…). */
  | 'reasoning_content'
  /** `message.reasoning` / `delta.reasoning` (Groq, Cloudflare). */
  | 'reasoning'
  /** OpenRouter: `message.reasoning` text + `reasoning_details[]` for round-tripping. */
  | 'reasoning_details'
  /** Inline `<think>…</think>` tags inside content (local R1-style models). */
  | 'think_tags';

/**
 * Stateful, TURN-AWARE round-trip of captured reasoning on the next request.
 * `'on-tool-call-turns'`: echo the captured reasoning back (via
 * `providerMetadata`) on an assistant message that carried `tool_calls`, and
 * only then. DeepSeek's `deepseek-reasoner` 400s on a tool loop if reasoning is
 * not echoed on the tool-call turn; on a plain turn it must NOT be echoed.
 */
export type ReasoningRoundTrip = 'none' | 'on-tool-call-turns';

/**
 * Mutates the request body to encode the resolved effort/thinking options into
 * this provider's wire vocabulary. Returns `{ stripTemperature }` when the
 * provider rejects/ignores `temperature` while reasoning is active.
 */
export type ReasoningEmit = (
  body: Record<string, unknown>,
  resolved: ResolvedThinkingOptions,
  model: string,
) => { stripTemperature?: boolean } | void;

/** Per-profile reasoning behavior — decoupled from any model-name regex. */
export type ReasoningProfile = {
  /** Write the unified `effort`/`thinkingBudget` into the request body. */
  emit: ReasoningEmit;
  /** Read reasoning text out of responses/streams. */
  capture: ReasoningCapture;
  /** Echo captured reasoning back on subsequent requests. Default `'none'`. */
  roundTrip?: ReasoningRoundTrip;
};

/** Wire-quirk capability flags. Each defaults to the OpenAI-correct value. */
export type CapabilityFlags = {
  /**
   * Emit `messages[].name` when set on a ChatMessage. OpenAI: true. Groq 400s
   * on it → false. Message-level (not reachable via `providerOptions`).
   */
  emitsMessageName?: boolean;
  /**
   * Engine-COMPUTED request params to strip before sending (provider rejects
   * them). `PerModel` because constraints are often per-model (e.g. `stop`
   * 400s only on Grok reasoning variants). Stripping runs AFTER the
   * `providerOptions` merge but EXEMPTS keys the user set explicitly there —
   * re-introducing a forbidden param via `providerOptions` is "you-asked-for-it".
   */
  forbiddenParams?: PerModel<string[]>;
  /**
   * Provider honors `response_format` `json_schema` strict mode. When false and
   * a `json_schema` format is requested, fall back to `{ type: 'json_object' }`.
   */
  supportsJsonSchema?: PerModel<boolean>;
  /**
   * Provider returns usage in the final stream chunk via
   * `stream_options.include_usage`. When false, don't request it.
   */
  supportsStreamUsage?: boolean;
};

/**
 * A provider definition. The engine reads ONLY this — adding a provider is
 * adding a profile, not new engine code.
 */
export type ProviderProfile = {
  /** Machine name = `Provider.name` and the `provider:` URI scheme key. */
  name: string;
  /** Human label used in error messages (defaults to {@link name}). */
  label?: string;
  /** Base URL used when neither a constructor arg nor env var is set. */
  defaultBaseUrl: string;
  /** Env var consulted for the base URL (after the constructor arg). */
  envBaseUrl?: string;
  /** Env var consulted for the API key (after the constructor arg). */
  envApiKey?: string;
  /** Auth header shape. Default `'bearer'`. */
  authHeader?: AuthHeader;
  /** Extra static headers merged into every request. */
  headers?: Record<string, string>;
  /** Allow an empty API key (local servers) → no auth header. Default false. */
  allowMissingApiKey?: boolean;
  /** How cost is derived. */
  pricing: PricingSource;
  /** Reasoning behavior. */
  reasoning: ReasoningProfile;
  /** Wire-quirk capability flags. */
  capabilities?: CapabilityFlags;
  /** Map a message role → wire role for a model. Default identity. */
  roleFor?: (role: ChatRole, model: string) => string;
  /** Output-token field name. Default `'max_completion_tokens'`. */
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  /** Send `parallel_tool_calls: true` when tools are present. Default off. */
  parallelToolCalls?: PerModel<boolean>;
  /**
   * Static body fields merged BEFORE `providerOptions` (e.g. OpenRouter
   * `usage: { include: true }`). Treated as engine-computed for forbiddenParams.
   */
  requestDefaults?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Generic table pricing (shared with openai.ts's estimateOpenAICost).
// ---------------------------------------------------------------------------

const SORTED_KEYS_CACHE = new WeakMap<PricingTable, string[]>();

function sortedKeys(table: PricingTable): string[] {
  let keys = SORTED_KEYS_CACHE.get(table);
  if (!keys) {
    keys = Object.keys(table).sort((a, b) => b.length - a.length);
    SORTED_KEYS_CACHE.set(table, keys);
  }
  return keys;
}

/**
 * Look up per-token pricing by exact match, then longest-prefix match (for
 * versioned snapshots like `gpt-4o-2024-05-13`). Returns `undefined` on a miss —
 * callers MUST treat that as "unknown cost", never as free.
 */
export function priceFromTable(
  table: PricingTable,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens?: number,
): number | undefined {
  let pricing = table[model];
  if (!pricing) {
    for (const key of sortedKeys(table)) {
      if (model.startsWith(key)) {
        pricing = table[key];
        break;
      }
    }
  }
  if (!pricing) return undefined;
  const [inputRate, outputRate, cacheMultiplier] = pricing;
  const cached = cachedTokens ?? 0;
  const inputCost = (promptTokens - cached) * inputRate + cached * inputRate * cacheMultiplier;
  return inputCost + completionTokens * outputRate;
}

// ---------------------------------------------------------------------------
// <think> tag streaming scanner (for the `think_tags` capture mode).
//
// A `<think>` or `</think>` tag can split across SSE chunk boundaries, so we
// keep a small buffer of trailing characters that could be the start of a tag.
// ---------------------------------------------------------------------------

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** Longest suffix of `s` that is a strict prefix of `tag` (for partial-tag carry). */
function partialTagSuffixLen(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

/**
 * Incremental scanner that separates streamed content into visible text and
 * `<think>…</think>` reasoning, tolerating tags split across chunks.
 */
export class ThinkTagScanner {
  private buffer = '';
  private inside = false;

  push(chunk: string): { text: string; thinking: string } {
    this.buffer += chunk;
    let text = '';
    let thinking = '';

    // Process complete tags while present; otherwise emit all-but-a-possible
    // partial-tag tail and keep the tail buffered.
    for (;;) {
      const tag = this.inside ? THINK_CLOSE : THINK_OPEN;
      const idx = this.buffer.indexOf(tag);
      if (idx === -1) {
        // No full tag. Hold back a tail that could be the start of `tag`.
        const hold = partialTagSuffixLen(this.buffer, tag);
        const emit = this.buffer.slice(0, this.buffer.length - hold);
        if (this.inside) thinking += emit;
        else text += emit;
        this.buffer = this.buffer.slice(this.buffer.length - hold);
        break;
      }
      // Emit everything before the tag to the current channel, then flip.
      const before = this.buffer.slice(0, idx);
      if (this.inside) thinking += before;
      else text += before;
      this.buffer = this.buffer.slice(idx + tag.length);
      this.inside = !this.inside;
    }

    return { text, thinking };
  }

  /** Flush any residual buffer at stream end (treat as the current channel). */
  flush(): { text: string; thinking: string } {
    const rest = this.buffer;
    this.buffer = '';
    return this.inside ? { text: '', thinking: rest } : { text: rest, thinking: '' };
  }
}

/** Strip `<think>…</think>` from a complete (non-streamed) content string. */
export function extractThinkTags(content: string): { content: string; thinking: string } {
  const scanner = new ThinkTagScanner();
  const a = scanner.push(content);
  const b = scanner.flush();
  return { content: a.text + b.text, thinking: a.thinking + b.thinking };
}

// ---------------------------------------------------------------------------
// Reasoning emit builders (shared by presets).
// ---------------------------------------------------------------------------

/**
 * Build a {@link ReasoningEmit} that writes a top-level `reasoning_effort`
 * string (OpenAI-style; used by xAI, Groq, Mistral). `map` returns the wire
 * value for the resolved options + model, or `undefined` to emit nothing
 * (e.g. reasoning disabled, or a model that rejects the field).
 */
export function reasoningEffortEmit(
  map: (resolved: ResolvedThinkingOptions, model: string) => string | undefined,
  opts: { stripTemperatureWhenActive?: boolean } = {},
): ReasoningEmit {
  return (body, resolved, model) => {
    const value = map(resolved, model);
    if (value) body.reasoning_effort = value;
    return { stripTemperature: opts.stripTemperatureWhenActive ? value !== undefined : false };
  };
}

/**
 * Build a {@link ReasoningEmit} that writes OpenRouter/Vercel's nested
 * `reasoning` object. effort and max_tokens are MUTUALLY EXCLUSIVE there, so a
 * positive `thinkingBudget` emits `{ max_tokens }`, an active effort emits
 * `{ effort }`, and disabled reasoning emits `{ enabled: false }`.
 */
export function reasoningObjectEmit(
  mapEffort: (effort: Exclude<Effort, 'none'>, model: string) => string,
): ReasoningEmit {
  return (body, resolved, model) => {
    if (resolved.hasBudgetOverride) {
      body.reasoning = { max_tokens: resolved.thinkingBudget };
    } else if (resolved.activeEffort) {
      body.reasoning = { effort: mapEffort(resolved.activeEffort, model) };
    } else if (resolved.thinkingDisabled) {
      body.reasoning = { enabled: false };
    }
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Round-trip payload stashed in `providerMetadata` for reasoning echo. */
type RoundTripReasoning = { field: string; value: unknown };

export type OpenAICompatibleOptions = {
  profile: ProviderProfile;
  apiKey?: string;
  baseUrl?: string;
  rateLimit?: RateLimitConfig;
};

/**
 * Generic provider over the OpenAI `/v1/chat/completions` wire format, raw
 * `fetch`, zero SDK dependencies. Parameterized by a {@link ProviderProfile}.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  protected readonly profile: ProviderProfile;
  protected readonly baseUrl: string;
  protected readonly apiKey: string;
  protected readonly governor?: RateLimiter;

  constructor(options: OpenAICompatibleOptions) {
    const p = options.profile;
    this.profile = p;
    this.name = p.name;
    this.apiKey = options.apiKey ?? (p.envApiKey ? process.env[p.envApiKey] : undefined) ?? '';
    const envBase = p.envBaseUrl ? process.env[p.envBaseUrl] : undefined;
    this.baseUrl = (options.baseUrl ?? envBase ?? p.defaultBaseUrl).replace(/\/$/, '');
    this.governor = options.rateLimit ? new RateLimiter(options.rateLimit) : undefined;

    if (!this.apiKey && !p.allowMissingApiKey) {
      const label = p.label ?? p.name;
      const env = p.envApiKey ?? 'the API key env var';
      throw new Error(`${label} API key is required. Set ${env} or pass apiKey in options.`);
    }
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    const body = this.buildRequestBody(messages, options, false);

    const res = await fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: options.signal,
      },
      { governor: this.governor },
    );

    if (!res.ok) {
      throw new Error(this.extractErrorMessage(await res.text(), res.status));
    }

    const json = (await res.json()) as OpenAIChatResponse;
    return this.parseResponse(json, options.model);
  }

  async *stream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const body = this.buildRequestBody(messages, options, true);

    const res = await fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: options.signal,
      },
      { governor: this.governor },
    );

    if (!res.ok) {
      throw new Error(this.extractErrorMessage(await res.text(), res.status));
    }
    if (!res.body) {
      throw new Error(`${this.profile.label ?? this.profile.name} stream response has no body`);
    }

    yield* this.parseSSEStream(res.body, options.model);
  }

  // ---------------------------------------------------------------------------
  // Request building
  // ---------------------------------------------------------------------------

  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.profile.headers ?? {}),
    };
    if (this.apiKey) {
      const auth = this.profile.authHeader ?? 'bearer';
      if (auth === 'bearer') headers.Authorization = `Bearer ${this.apiKey}`;
      else if (auth === 'api-key') headers['api-key'] = this.apiKey;
      else headers[auth.header] = auth.scheme ? `${auth.scheme} ${this.apiKey}` : this.apiKey;
    }
    return headers;
  }

  protected buildRequestBody(
    messages: ChatMessage[],
    options: ChatOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const profile = this.profile;
    const resolved = resolveThinkingOptions(options);

    const body: Record<string, unknown> = {
      model: options.model,
      messages: messages.map((m) => this.formatMessage(m, options.model)),
      stream,
    };

    // Reasoning emit (may request temperature stripping).
    const emitResult = profile.reasoning.emit(body, resolved, options.model) ?? {};
    const stripTemperature = emitResult.stripTemperature ?? false;

    if (options.temperature !== undefined && !stripTemperature) {
      body.temperature = options.temperature;
    }

    if (options.maxTokens !== undefined) {
      body[profile.maxTokensField ?? 'max_completion_tokens'] = options.maxTokens;
    }

    if (options.stop) body.stop = options.stop;

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      if (resolvePerModel(profile.parallelToolCalls, options.model, false)) {
        body.parallel_tool_calls = true;
      }
    }

    if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;

    if (options.responseFormat) {
      const supportsSchema = resolvePerModel(
        profile.capabilities?.supportsJsonSchema,
        options.model,
        true,
      );
      body.response_format =
        options.responseFormat.type === 'json_schema' && !supportsSchema
          ? { type: 'json_object' }
          : options.responseFormat;
    }

    if (stream && (profile.capabilities?.supportsStreamUsage ?? true)) {
      body.stream_options = { include_usage: true };
    }

    // Static profile defaults, then user providerOptions (user wins).
    if (profile.requestDefaults) Object.assign(body, profile.requestDefaults);
    const userKeys = options.providerOptions ? Object.keys(options.providerOptions) : [];
    if (options.providerOptions) Object.assign(body, options.providerOptions);

    // Strip engine-computed forbidden params, but never the user's explicit overrides.
    const forbidden = resolvePerModel(profile.capabilities?.forbiddenParams, options.model, []);
    for (const key of forbidden) {
      if (!userKeys.includes(key)) delete body[key];
    }

    return body;
  }

  protected formatMessage(msg: ChatMessage, model: string): Record<string, unknown> {
    const out: Record<string, unknown> = {
      role: this.profile.roleFor ? this.profile.roleFor(msg.role, model) : msg.role,
      content: msg.content,
    };
    if (msg.name && (this.profile.capabilities?.emitsMessageName ?? true)) out.name = msg.name;
    if (msg.tool_calls) out.tool_calls = msg.tool_calls;
    if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;

    // Turn-aware reasoning round-trip: echo captured reasoning only on assistant
    // messages that carried tool_calls.
    if (
      this.profile.reasoning.roundTrip === 'on-tool-call-turns' &&
      msg.role === 'assistant' &&
      msg.tool_calls &&
      msg.tool_calls.length > 0
    ) {
      const rt = msg.providerMetadata?.openaiCompatReasoning as RoundTripReasoning | undefined;
      if (rt && rt.value !== undefined && rt.value !== null) out[rt.field] = rt.value;
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------------------

  protected extractErrorMessage(body: string, status: number): string {
    const label = this.profile.label ?? this.profile.name;
    try {
      const json = JSON.parse(body) as {
        error?: { message?: string };
        message?: string;
        detail?: string;
      };
      const message = json.error?.message ?? json.message ?? json.detail;
      if (message) return `${label} API error (${status}): ${message}`;
    } catch {
      // Not JSON — fall through to raw body.
    }
    return `${label} API error (${status}): ${body}`;
  }

  private toUsage(raw: OpenAIUsage | undefined): ProviderResponse['usage'] {
    if (!raw) return undefined;
    return {
      prompt_tokens: raw.prompt_tokens,
      completion_tokens: raw.completion_tokens,
      total_tokens: raw.total_tokens,
      reasoning_tokens: raw.completion_tokens_details?.reasoning_tokens,
      cached_tokens: raw.prompt_tokens_details?.cached_tokens,
    };
  }

  private computeCost(
    model: string,
    usage: ProviderResponse['usage'],
    reportedCost: number | undefined,
  ): number | undefined {
    if (!usage) return undefined;
    const p = this.profile.pricing;
    switch (p.kind) {
      case 'zero':
        return 0;
      case 'unknown':
        return undefined;
      case 'from-response':
        return typeof reportedCost === 'number' && Number.isFinite(reportedCost)
          ? reportedCost
          : undefined;
      case 'table':
        return priceFromTable(
          p.table,
          model,
          usage.prompt_tokens,
          usage.completion_tokens,
          usage.cached_tokens,
        );
    }
  }

  protected parseResponse(json: OpenAIChatResponse, model: string): ProviderResponse {
    const message = json.choices?.[0]?.message ?? {};
    let content = message.content ?? '';
    let thinking: string | undefined;
    let roundTrip: RoundTripReasoning | undefined;

    switch (this.profile.reasoning.capture) {
      case 'reasoning_content':
        if (typeof message.reasoning_content === 'string') {
          thinking = message.reasoning_content;
          roundTrip = { field: 'reasoning_content', value: message.reasoning_content };
        }
        break;
      case 'reasoning':
        if (typeof message.reasoning === 'string') {
          thinking = message.reasoning;
          roundTrip = { field: 'reasoning', value: message.reasoning };
        }
        break;
      case 'reasoning_details':
        if (typeof message.reasoning === 'string') thinking = message.reasoning;
        if (message.reasoning_details !== undefined) {
          roundTrip = { field: 'reasoning_details', value: message.reasoning_details };
        }
        break;
      case 'think_tags': {
        const ex = extractThinkTags(content);
        content = ex.content;
        if (ex.thinking) thinking = ex.thinking;
        break;
      }
      case 'none':
        break;
    }

    const usage = this.toUsage(json.usage);
    const cost = this.computeCost(model, usage, json.usage?.cost);

    return {
      content,
      thinking_content: thinking || undefined,
      tool_calls: message.tool_calls?.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
      usage,
      cost,
      providerMetadata: this.roundTripMetadata(roundTrip),
    };
  }

  private roundTripMetadata(
    rt: RoundTripReasoning | undefined,
  ): Record<string, unknown> | undefined {
    if (
      !rt ||
      this.profile.reasoning.roundTrip === undefined ||
      this.profile.reasoning.roundTrip === 'none'
    ) {
      return undefined;
    }
    return rt.value === undefined || rt.value === null ? undefined : { openaiCompatReasoning: rt };
  }

  // ---------------------------------------------------------------------------
  // SSE streaming
  // ---------------------------------------------------------------------------

  protected async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
    model: string,
  ): AsyncGenerator<StreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usageData: OpenAIUsage | undefined;

    const capture = this.profile.reasoning.capture;
    const thinkScanner = capture === 'think_tags' ? new ThinkTagScanner() : undefined;
    // Accumulators for reasoning round-trip during streaming.
    let reasoningText = '';
    const reasoningDetails: unknown[] = [];

    const indexToId = new Map<number, string>();

    const makeDone = (): StreamChunk => {
      const usage = this.toUsage(usageData);
      let providerMetadata: Record<string, unknown> | undefined;
      if (this.profile.reasoning.roundTrip === 'on-tool-call-turns') {
        if (capture === 'reasoning_details' && reasoningDetails.length > 0) {
          providerMetadata = {
            openaiCompatReasoning: { field: 'reasoning_details', value: reasoningDetails },
          };
        } else if ((capture === 'reasoning_content' || capture === 'reasoning') && reasoningText) {
          providerMetadata = {
            openaiCompatReasoning: { field: capture, value: reasoningText },
          };
        }
      }
      return {
        type: 'done',
        usage,
        cost: this.computeCost(model, usage, usageData?.cost),
        providerMetadata,
      };
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed === 'data: [DONE]') {
            if (thinkScanner) {
              const flushed = thinkScanner.flush();
              if (flushed.text) yield { type: 'text_delta', content: flushed.text };
              if (flushed.thinking) yield { type: 'thinking_delta', content: flushed.thinking };
            }
            yield makeDone();
            return;
          }

          if (!trimmed.startsWith('data: ')) continue;

          let parsed: OpenAIStreamChunk;
          try {
            parsed = JSON.parse(trimmed.slice(6)) as OpenAIStreamChunk;
          } catch {
            continue;
          }

          if (parsed.usage) {
            usageData = parsed.usage;
            // Some providers send a usage-only final chunk with no choices.
            if (!parsed.choices || parsed.choices.length === 0) continue;
          }

          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          // Reasoning capture (sidecar fields).
          const deltaReasoning =
            capture === 'reasoning_content'
              ? delta.reasoning_content
              : capture === 'reasoning' || capture === 'reasoning_details'
                ? delta.reasoning
                : undefined;
          if (typeof deltaReasoning === 'string' && deltaReasoning.length > 0) {
            reasoningText += deltaReasoning;
            yield { type: 'thinking_delta', content: deltaReasoning };
          }
          if (capture === 'reasoning_details' && Array.isArray(delta.reasoning_details)) {
            reasoningDetails.push(...delta.reasoning_details);
          }

          // Content (possibly with inline <think> tags).
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            if (thinkScanner) {
              const { text, thinking } = thinkScanner.push(delta.content);
              if (text) yield { type: 'text_delta', content: text };
              if (thinking) yield { type: 'thinking_delta', content: thinking };
            } else {
              yield { type: 'text_delta', content: delta.content };
            }
          }

          // Tool-call deltas.
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.id) indexToId.set(tc.index, tc.id);
              yield {
                type: 'tool_call_delta',
                id: indexToId.get(tc.index) ?? `__pending_${tc.index}`,
                name: tc.function?.name,
                arguments: tc.function?.arguments,
              };
            }
          }
        }
      }

      // Stream ended without an explicit [DONE].
      if (thinkScanner) {
        const flushed = thinkScanner.flush();
        if (flushed.text) yield { type: 'text_delta', content: flushed.text };
        if (flushed.thinking) yield { type: 'thinking_delta', content: flushed.thinking };
      }
      yield makeDone();
    } finally {
      reader.releaseLock();
    }
  }
}

// ---------------------------------------------------------------------------
// Wire types (superset of OpenAI Chat Completions — extra fields are the
// reasoning sidecars and per-call cost other providers add).
// ---------------------------------------------------------------------------

type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
  /** OpenRouter / Vercel Gateway: per-call cost in USD. */
  cost?: number;
};

type OpenAIChatMessage = {
  content: string | null;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: unknown;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
};

type OpenAIChatResponse = {
  choices: Array<{ message: OpenAIChatMessage; finish_reason: string }>;
  usage?: OpenAIUsage;
};

type OpenAIStreamChunk = {
  choices?: Array<{
    delta: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_details?: unknown[];
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: OpenAIUsage;
};
