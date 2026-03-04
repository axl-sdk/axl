import type { Provider } from './types.js';
import { OpenAIProvider } from './openai.js';
import { OpenAIResponsesProvider } from './openai-responses.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import type { AxlConfig } from '../config.js';

/**
 * Resolved result from a provider:model URI.
 */
export type ResolvedProvider = {
  provider: Provider;
  model: string;
};

type ProviderFactory = (config: AxlConfig) => Provider;

// ---------------------------------------------------------------------------
// Built-in provider factories
// ---------------------------------------------------------------------------

const builtinFactories: Record<string, ProviderFactory> = {
  openai: (config) => {
    const opts = config.providers?.openai ?? {};
    return new OpenAIProvider({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  },
  'openai-responses': (config) => {
    const opts = config.providers?.['openai-responses'] ?? config.providers?.openai ?? {};
    return new OpenAIResponsesProvider({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  },
  anthropic: (config) => {
    const opts = config.providers?.anthropic ?? {};
    return new AnthropicProvider({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  },
  google: (config) => {
    const opts = config.providers?.google ?? {};
    return new GeminiProvider({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  },
};

// ---------------------------------------------------------------------------
// Provider Registry
// ---------------------------------------------------------------------------

/**
 * Registry for LLM providers. Holds cached provider instances and supports
 * custom provider registration.
 *
 * Usage:
 *   const registry = new ProviderRegistry();
 *   registry.register('custom', (config) => new MyProvider(config));
 *   const { provider, model } = registry.resolve('openai:gpt-4o', config);
 */
export class ProviderRegistry {
  /** Cached provider instances, keyed by provider name */
  private instances = new Map<string, Provider>();

  /** Factory functions, keyed by provider name */
  private factories = new Map<string, ProviderFactory>();

  /** Fallback provider returned when no factory or instance matches */
  private fallbackInstance?: Provider;

  constructor() {
    // Register built-in providers
    for (const [name, factory] of Object.entries(builtinFactories)) {
      this.factories.set(name, factory);
    }
  }

  /**
   * Register a custom provider factory.
   * If a provider with this name already exists, it is replaced and
   * any cached instance is evicted.
   */
  register(name: string, factory: ProviderFactory): void {
    this.factories.set(name, factory);
    this.instances.delete(name); // evict stale cache
  }

  /**
   * Register a pre-instantiated provider directly.
   */
  registerInstance(name: string, provider: Provider): void {
    this.instances.set(name, provider);
  }

  /**
   * Check whether a provider with the given name is registered.
   */
  has(name: string): boolean {
    return this.factories.has(name) || this.instances.has(name);
  }

  /**
   * List all registered provider names.
   */
  list(): string[] {
    const names = new Set([...this.factories.keys(), ...this.instances.keys()]);
    return [...names];
  }

  /**
   * Set a fallback provider returned when no factory or instance matches.
   * Useful for testing where a single mock provider covers all agents.
   */
  setFallback(provider: Provider): void {
    this.fallbackInstance = provider;
  }

  /**
   * Get a provider instance by name, creating it lazily via its factory.
   */
  get(name: string, config: AxlConfig = {}): Provider {
    // Return cached instance if available
    const cached = this.instances.get(name);
    if (cached) return cached;

    // Create via factory
    const factory = this.factories.get(name);
    if (factory) {
      const instance = factory(config);
      this.instances.set(name, instance);
      return instance;
    }

    // Fall back to the fallback provider if set
    if (this.fallbackInstance) {
      return this.fallbackInstance;
    }

    throw new Error(`Unknown provider "${name}". Registered providers: ${this.list().join(', ')}`);
  }

  /**
   * Resolve a "provider:model" URI string into a Provider instance and model name.
   *
   * Supported formats:
   *   - "openai:gpt-4o"        -> provider=openai, model=gpt-4o
   *   - "anthropic:claude-3"   -> provider=anthropic, model=claude-3
   *   - "gpt-4o"               -> uses defaultProvider from config, model=gpt-4o
   *   - undefined / empty      -> uses defaultProvider and defaultModel from config
   *
   * @param uri  Provider:model string, or just a model name
   * @param config  Axl configuration for provider options and defaults
   */
  resolve(uri: string | undefined, config: AxlConfig = {}): ResolvedProvider {
    if (!uri) {
      // Fall back to config defaults
      const providerName = config.defaultProvider ?? 'openai';
      const model = config.defaultModel ?? 'gpt-4o';
      return { provider: this.get(providerName, config), model };
    }

    const colonIndex = uri.indexOf(':');

    if (colonIndex === -1) {
      // No colon -> treat entire string as model name, use default provider
      const providerName = config.defaultProvider ?? 'openai';
      return { provider: this.get(providerName, config), model: uri };
    }

    const providerName = uri.slice(0, colonIndex);
    const model = uri.slice(colonIndex + 1);

    if (!providerName || !model) {
      throw new Error(
        `Invalid provider URI "${uri}". Expected format: "provider:model" (e.g. "openai:gpt-4o")`,
      );
    }

    return { provider: this.get(providerName, config), model };
  }

  /**
   * Clear all cached provider instances. Useful for testing or reconfiguration.
   */
  clearCache(): void {
    this.instances.clear();
  }

  /**
   * Clear all registered factories (including built-ins).
   * Useful for test runtimes where only explicitly registered instances should be used.
   */
  clearFactories(): void {
    this.factories.clear();
  }
}

// ---------------------------------------------------------------------------
// Default singleton registry
// ---------------------------------------------------------------------------

/**
 * Default global provider registry.
 * Import this for convenience; create your own ProviderRegistry for isolation.
 */
export const defaultRegistry = new ProviderRegistry();

/**
 * Convenience function: resolve a provider:model URI using the default registry.
 */
export function resolveProvider(uri: string | undefined, config: AxlConfig = {}): ResolvedProvider {
  return defaultRegistry.resolve(uri, config);
}
