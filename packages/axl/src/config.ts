/** Provider configuration */
export type ProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
};

/** MCP server configuration */
export type McpServerConfig = {
  name: string;
  command?: string;
  uri?: string;
  env?: Record<string, string>;
};

/** Trace configuration */
export type TraceConfig = {
  enabled?: boolean;
  level?: 'off' | 'steps' | 'full';
  output?: 'console' | 'json' | 'file';
  /** When true, redact prompt/response data from agent_call trace events to prevent PII leakage. */
  redact?: boolean;
};

/** State store configuration */
export type StateConfig = {
  store?: 'memory' | 'sqlite' | 'redis';
  sqlite?: { path: string };
  redis?: { url: string };
};

/** Global defaults */
export type DefaultsConfig = {
  timeout?: string;
  maxRetries?: number;
  budgetPolicy?: 'finish_and_stop' | 'hard_stop' | 'warn';
};

/** Context window management configuration */
export type ContextManagementConfig = {
  summaryModel?: string;
  reserveTokens?: number;
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
    resolved.state = {
      ...resolved.state,
      store: process.env.AXL_STATE_STORE as 'memory' | 'sqlite' | 'redis',
    };
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
