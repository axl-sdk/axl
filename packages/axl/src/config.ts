import type { RateLimitConfig } from './providers/rate-limiter.js';
import type { ApiKeySource } from './providers/types.js';
import type { AuthHeader } from './providers/openai-compatible.js';
import type { McpServerConfig } from './mcp/types.js';

/** Provider configuration */
export type ProviderConfig = {
  /** API key, or a function resolving one per request (for expiring tokens —
   *  Azure-Entra, Databricks/IBM OAuth, Bedrock short-term). A plain string is
   *  the common case. See {@link ApiKeySource}. */
  apiKey?: ApiKeySource;
  baseUrl?: string;
  /**
   * Allow a non-loopback HTTP endpoint for this provider. HTTP can expose
   * prompts and credentials in transit; prefer HTTPS whenever possible.
   */
  dangerouslyAllowInsecureHttp?: boolean;
  /** OpenAI-compatible presets only: override the profile auth header shape. */
  authHeader?: AuthHeader;
  /**
   * Opt-in client-side rate governor for this provider's HTTP calls (see
   * {@link RateLimitConfig}). Bounds in-flight request concurrency (and,
   * optionally, request spacing) through the shared `fetchWithRetry` chokepoint.
   * Omitted ⇒ no governor (behavior unchanged). Caveat: governs **chat** calls
   * through this provider instance only — NOT memory-embedder calls (constructed
   * outside the registry) and NOT other processes sharing the same API key.
   */
  rateLimit?: RateLimitConfig;
};

/** Trace configuration */
export type TraceConfig = {
  enabled?: boolean;
  level?: 'off' | 'steps' | 'full';
  output?: 'console' | 'json' | 'file';
  /** When true, redact prompt/response data from agent_call trace events to prevent PII leakage. */
  redact?: boolean;
};

import type { StateStore } from './state/types.js';

/** State store configuration */
export type StateConfig = {
  store?: StateStore | 'memory' | 'sqlite';
  sqlite?: { path: string };
  /**
   * Maximum number of events retained in `ExecutionInfo.events` per
   * execution. Token and partial_object events are already excluded
   * from the array (high-volume, stream-only); this cap bounds the
   * remaining structural events (`agent_call_*`, `tool_call_*`, gate
   * events, pipeline, etc).
   *
   * Pathological workloads (e.g., 50 nested asks × 20-turn tool loops)
   * can otherwise accumulate tens of thousands of events totalling
   * hundreds of MB before the terminal `done` event fires. When the
   * cap is hit, further events are dropped from the array and a single
   * `log` event with `data.event === 'events_truncated'` is appended
   * recording the truncation. The trace channel (`runtime.on('trace')`)
   * and WS broadcast continue to receive every event — only the
   * in-memory `ExecutionInfo.events` array is bounded. The execution's
   * `observation` becomes `persistence_truncated`.
   *
   * Default: 50_000. Set to `Infinity` to disable the cap (legacy
   * behavior; only safe for short-lived executions). Must be a positive
   * integer or `Infinity`.
   */
  maxEventsPerExecution?: number;
  /**
   * When to persist execution events to the state store.
   *
   * - `'terminal'` (default, back-compat) — events are buffered in memory
   *   and written to `executionHistory` only at the terminal `done`/`error`
   *   event. Fastest path; if the process crashes mid-run, the events are
   *   lost. Fine for development and short-running workflows.
   *
   * - `'streaming'` — events are batched and written to a streaming buffer
   *   throughout the run (via `StateStore.appendStreamingEvents`), then the
   *   buffer is finalized when the canonical `executionHistory` is saved at
   *   terminal exit. If the process crashes mid-run, call
   *   `runtime.recoverIncompleteStreams()` on the next process to reconstruct
   *   the partial `ExecutionInfo` from the streaming buffer (status: `'failed'`,
   *   error: `'process terminated'`, observation: `process_interrupted`). Use
   *   this in production when you need to
   *   know "what did the workflow do up to the crash."
   *
   * Excluded from streaming flush even in `'streaming'` mode: `token`,
   * `partial_object`, `string_delta` (high-volume, reconstructable from
   * the persisted `agent_call_end.data`).
   */
  persist?: 'terminal' | 'streaming';
  /**
   * Number of events buffered before flushing to the streaming store.
   * Default `100`. Set to `1` for per-event flush (highest durability,
   * one Redis round-trip per emit — adds latency proportional to RTT).
   *
   * Only meaningful when `persist === 'streaming'`.
   */
  streamingBatchSize?: number;
  /**
   * Max milliseconds between flushes when the batch hasn't filled up.
   * Default `1000`. Together with `streamingBatchSize`, bounds the
   * "events lost on crash" window to `min(batchSize-of-events, interval-of-time)`.
   *
   * Only meaningful when `persist === 'streaming'`.
   */
  streamingBatchInterval?: number;
};

/** Global defaults */
export type DefaultsConfig = {
  timeout?: string;
  stallTimeout?: string;
  maxRetries?: number;
  budgetPolicy?: 'finish_and_stop' | 'hard_stop' | 'warn';
};

/** Context window management configuration */
export type ContextManagementConfig = {
  summaryModel?: string;
  reserveTokens?: number;
};

/** Schema-capability diagnostics configuration (spec 22, Problem E). */
export type DiagnosticsConfig = {
  /**
   * Token threshold above which an appended prompt schema — or a provider
   * tool-definition schema — emits a `prompt_schema_oversized`
   * `schema_diagnostic`. Measured with the same ~4-chars/token estimator used
   * for context management. Default `4000`.
   */
  schemaOversizedTokens?: number;
  /**
   * Silence the one-time `console.warn` diagnostics (the structured
   * `schema_diagnostic` events still fire). Also silenceable process-wide via
   * `AXL_DIAGNOSTICS_SILENT=true`.
   */
  silent?: boolean;
};

import type { TelemetryConfig } from './telemetry/types.js';
import type { MemoryConfig } from './memory/types.js';

/** Full Axl configuration */
export type AxlConfig = {
  providers?: Record<string, ProviderConfig>;
  defaultProvider?: string;
  defaultModel?: string;
  mcp?: {
    servers?: McpServerConfig[];
  };
  state?: StateConfig;
  trace?: TraceConfig;
  defaults?: DefaultsConfig;
  contextManagement?: ContextManagementConfig;
  diagnostics?: DiagnosticsConfig;
  memory?: MemoryConfig;
  telemetry?: TelemetryConfig;
};

/**
 * Create a type-safe Axl configuration object for providers, state, tracing, and defaults.
 * @param config - The full Axl configuration (providers, state store, tracing, defaults, context management).
 * @returns The same configuration object, validated at the type level.
 */
export function defineConfig(config: AxlConfig): AxlConfig {
  return config;
}

/** Parse duration strings like "30s", "500ms", "5m" to milliseconds */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/);
  if (!match) throw new Error(`Invalid duration format: "${duration}"`);

  const value = parseFloat(match[1]);
  const unit = match[2];

  switch (unit) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    default:
      throw new Error(`Unknown duration unit: "${unit}"`);
  }
}

/** Parse cost strings like "$5.00" to number */
export function parseCost(cost: string): number {
  const match = cost.match(/^\$?([\d.]+)$/);
  if (!match) throw new Error(`Invalid cost format: "${cost}"`);
  return parseFloat(match[1]);
}

/** Merge config with environment variable overrides */
export function resolveConfig(config: AxlConfig): AxlConfig {
  const resolved = { ...config };

  // Env overrides
  if (process.env.AXL_DEFAULT_PROVIDER) {
    resolved.defaultProvider = process.env.AXL_DEFAULT_PROVIDER;
  }
  if (process.env.AXL_STATE_STORE) {
    const envStore = process.env.AXL_STATE_STORE;
    if (envStore === 'memory' || envStore === 'sqlite') {
      resolved.state = {
        ...resolved.state,
        store: envStore,
      };
    }
  }
  if (process.env.AXL_TRACE_ENABLED !== undefined) {
    resolved.trace = { ...resolved.trace, enabled: process.env.AXL_TRACE_ENABLED === 'true' };
  }
  if (process.env.AXL_TRACE_LEVEL) {
    resolved.trace = {
      ...resolved.trace,
      level: process.env.AXL_TRACE_LEVEL as 'off' | 'steps' | 'full',
    };
  }

  // Standard API key env vars — create provider entry if it doesn't exist
  if (process.env.OPENAI_API_KEY) {
    if (!resolved.providers) resolved.providers = {};
    resolved.providers.openai = {
      ...(resolved.providers.openai ?? {}),
      apiKey: process.env.OPENAI_API_KEY,
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    if (!resolved.providers) resolved.providers = {};
    resolved.providers.anthropic = {
      ...(resolved.providers.anthropic ?? {}),
      apiKey: process.env.ANTHROPIC_API_KEY,
    };
  }

  const googleKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (googleKey) {
    if (!resolved.providers) resolved.providers = {};
    resolved.providers.google = {
      ...(resolved.providers.google ?? {}),
      apiKey: googleKey,
    };
  }

  return resolved;
}
