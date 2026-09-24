import type { Provider } from './types.js';
import { OpenAIProvider } from './openai.js';
import { OpenAIResponsesProvider } from './openai-responses.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { OpenAICompatibleProvider, type ProviderProfile } from './openai-compatible.js';
import { BUILTIN_PROFILES } from './profiles/index.js';
import type { AxlConfig } from '../config.js';
import { bindGovernorPool, GovernorPool } from './governor-pool.js';

/**
 * Resolved result from a provider:model URI.
 */
export type ResolvedProvider = {
  provider: Provider;
  model: string;
};

/** A user factory registered with {@link ProviderRegistry.register}. */
type ProviderFactory = (config: AxlConfig) => Provider;

/**
 * What the registry hands a built-in factory besides the config. Internal:
 * user factories registered with `register()` receive only the config.
 */
type BuiltinFactoryContext = {
  /** The registry's per-runtime governor pool; see `governor-pool.ts`. */
  governors: GovernorPool;
};

type BuiltinProviderFactory = (config: AxlConfig, context: BuiltinFactoryContext) => Provider;

type RegisteredFactory =
  | { kind: 'builtin'; create: BuiltinProviderFactory }
  | { kind: 'custom'; create: ProviderFactory };

// ---------------------------------------------------------------------------
// Built-in provider factories
// ---------------------------------------------------------------------------

// Rate governors are pooled per registry (i.e. per runtime), one per scope =
// provider family + base-URL origin + credential source + model. Each factory
// binds the registry's pool to the adapter it builds, so `openai:` and
// `openai-responses:` on one key and origin share ONE governor per model (not
// one per adapter, whose caps used to add up). Two provider blocks reaching one
// scope merge their `rateLimit` strictest-per-field with one warning. Sharing
// across runtimes is explicit: register one provider instance in both. See
// `governor-pool.ts` and the "Rate limiting" section of docs/providers.md.
const builtinFactories: Record<string, BuiltinProviderFactory> = {
  openai: (config, { governors }) => {
    const opts = config.providers?.openai ?? {};
    return bindGovernorPool(
      new OpenAIProvider({
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        dangerouslyAllowInsecureHttp: opts.dangerouslyAllowInsecureHttp,
        rateLimit: opts.rateLimit,
      }),
      governors,
    );
  },
  'openai-responses': (config, { governors }) => {
    // Falls back to the `openai` provider config (incl. its rateLimit). On the
    // same key and origin both adapters are one scope family, so the fallback
    // governs both through the SAME governor per model.
    const opts = config.providers?.['openai-responses'] ?? config.providers?.openai ?? {};
    return bindGovernorPool(
      new OpenAIResponsesProvider({
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        dangerouslyAllowInsecureHttp: opts.dangerouslyAllowInsecureHttp,
        rateLimit: opts.rateLimit,
      }),
      governors,
    );
  },
  anthropic: (config, { governors }) => {
    const opts = config.providers?.anthropic ?? {};
    return bindGovernorPool(
      new AnthropicProvider({
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        dangerouslyAllowInsecureHttp: opts.dangerouslyAllowInsecureHttp,
        rateLimit: opts.rateLimit,
      }),
      governors,
    );
  },
  google: (config, { governors }) => {
    const opts = config.providers?.google ?? {};
    return bindGovernorPool(
      new GeminiProvider({
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        dangerouslyAllowInsecureHttp: opts.dangerouslyAllowInsecureHttp,
        rateLimit: opts.rateLimit,
      }),
      governors,
    );
  },
};

/**
 * Factory for an OpenAI-compatible preset: the generic engine + a profile,
 * reading per-provider config under the profile's name. The key/baseURL fall
 * back to the profile's env vars inside the engine when config omits them.
 */
function presetFactory(profile: ProviderProfile): BuiltinProviderFactory {
  return (config, { governors }) => {
    const opts = config.providers?.[profile.name] ?? {};
    return bindGovernorPool(
      new OpenAICompatibleProvider({
        profile,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        dangerouslyAllowInsecureHttp: opts.dangerouslyAllowInsecureHttp,
        authHeader: opts.authHeader,
        rateLimit: opts.rateLimit,
      }),
      governors,
    );
  };
}

// OpenAI-compatible presets (openrouter, azure, xai, deepseek, mistral, groq,
// bedrock, ollama, vllm, lmstudio, llamacpp, sglang). Registered under each
// profile name.
for (const profile of BUILTIN_PROFILES) {
  // Built-in adapters above take precedence over a same-named preset.
  if (!(profile.name in builtinFactories)) {
    builtinFactories[profile.name] = presetFactory(profile);
  }
}

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
  private factories = new Map<string, RegisteredFactory>();

  /**
   * Rate governors for the adapters built-in factories construct, one per
   * scope. Per registry, so per runtime: the state dies with the runtime.
   */
  private governors = new GovernorPool();

  /** Fallback provider returned when no factory or instance matches */
  private fallbackInstance?: Provider;

  constructor() {
    // Register built-in providers
    for (const [name, create] of Object.entries(builtinFactories)) {
      this.factories.set(name, { kind: 'builtin', create });
    }
  }

  /**
   * Register a custom provider factory.
   * If a provider with this name already exists, it is replaced and
   * any cached instance is evicted.
   */
  register(name: string, factory: ProviderFactory): void {
    this.factories.set(name, { kind: 'custom', create: factory });
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
      const instance =
        factory.kind === 'builtin'
          ? factory.create(config, { governors: this.governors })
          : factory.create(config);
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
   * Also starts a fresh governor pool, so adapters rebuilt from a changed
   * `rateLimit` are not merged with the discarded ones. A call already in
   * flight finishes on the governor it holds.
   */
  clearCache(): void {
    this.instances.clear();
    this.governors = new GovernorPool();
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
