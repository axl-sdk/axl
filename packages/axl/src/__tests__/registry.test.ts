import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderRegistry, defaultRegistry, resolveProvider } from '../providers/registry.js';
import type { Provider } from '../providers/types.js';
import type { AxlConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock provider with a given name. */
function createMockProvider(name: string): Provider {
  return {
    name,
    chat: async () => ({
      content: 'mock',
      toolCalls: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    stream: async function* () {
      yield { type: 'done' as const };
    },
  };
}

/** Create a factory that returns a mock provider and tracks call count. */
function createTrackedFactory(name: string) {
  let callCount = 0;
  const factory = (_config: AxlConfig): Provider => {
    callCount++;
    return createMockProvider(name);
  };
  return {
    factory,
    get callCount() {
      return callCount;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  // -----------------------------------------------------------------------
  // register()
  // -----------------------------------------------------------------------
  describe('register()', () => {
    it('registers a custom provider factory', () => {
      const { factory } = createTrackedFactory('custom');
      registry.register('custom', factory);

      expect(registry.has('custom')).toBe(true);
    });

    it('allows retrieving a provider created by the registered factory', () => {
      const { factory } = createTrackedFactory('custom');
      registry.register('custom', factory);

      const provider = registry.get('custom');
      expect(provider.name).toBe('custom');
    });

    it('evicts cached instance when re-registering same name', () => {
      const first = createTrackedFactory('custom-v1');
      const second = createTrackedFactory('custom-v2');

      registry.register('custom', first.factory);
      const p1 = registry.get('custom');
      expect(p1.name).toBe('custom-v1');

      // Re-register under the same name
      registry.register('custom', second.factory);
      const p2 = registry.get('custom');
      expect(p2.name).toBe('custom-v2');
      expect(p2).not.toBe(p1);
    });

    it('overrides a built-in provider when registered with same name', () => {
      const { factory } = createTrackedFactory('my-openai');
      registry.register('openai', factory);

      const provider = registry.get('openai');
      expect(provider.name).toBe('my-openai');
    });
  });

  // -----------------------------------------------------------------------
  // registerInstance()
  // -----------------------------------------------------------------------
  describe('registerInstance()', () => {
    it('registers a pre-made provider instance', () => {
      const mock = createMockProvider('prebuilt');
      registry.registerInstance('prebuilt', mock);

      expect(registry.has('prebuilt')).toBe(true);
    });

    it('returns the exact same instance from get()', () => {
      const mock = createMockProvider('prebuilt');
      registry.registerInstance('prebuilt', mock);

      const result = registry.get('prebuilt');
      expect(result).toBe(mock);
    });

    it('is retrievable via resolve()', () => {
      const mock = createMockProvider('prebuilt');
      registry.registerInstance('prebuilt', mock);

      const resolved = registry.resolve('prebuilt:some-model');
      expect(resolved.provider).toBe(mock);
      expect(resolved.model).toBe('some-model');
    });

    it('takes precedence over factory when both exist for same name', () => {
      const factoryProvider = createMockProvider('from-factory');
      const instanceProvider = createMockProvider('from-instance');

      registry.register('test', () => factoryProvider);
      registry.registerInstance('test', instanceProvider);

      // Instance should win because get() checks instances first
      const result = registry.get('test');
      expect(result).toBe(instanceProvider);
    });
  });

  // -----------------------------------------------------------------------
  // has()
  // -----------------------------------------------------------------------
  describe('has()', () => {
    it('returns true for built-in providers', () => {
      expect(registry.has('openai')).toBe(true);
      expect(registry.has('anthropic')).toBe(true);
    });

    it('returns false for unknown providers', () => {
      expect(registry.has('nonexistent')).toBe(false);
      expect(registry.has('')).toBe(false);
    });

    it('returns true for custom-registered factories', () => {
      registry.register('custom', () => createMockProvider('custom'));
      expect(registry.has('custom')).toBe(true);
    });

    it('returns true for registered instances', () => {
      registry.registerInstance('injected', createMockProvider('injected'));
      expect(registry.has('injected')).toBe(true);
    });

    it('returns true for instance-only provider (no factory)', () => {
      const mock = createMockProvider('instance-only');
      registry.registerInstance('instance-only', mock);
      expect(registry.has('instance-only')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // list()
  // -----------------------------------------------------------------------
  describe('list()', () => {
    it('includes built-in providers by default', () => {
      const names = registry.list();
      expect(names).toContain('openai');
      expect(names).toContain('anthropic');
    });

    it('includes custom-registered providers', () => {
      registry.register('custom', () => createMockProvider('custom'));
      const names = registry.list();
      expect(names).toContain('custom');
      expect(names).toContain('openai');
      expect(names).toContain('anthropic');
    });

    it('includes instance-only providers', () => {
      registry.registerInstance('injected', createMockProvider('injected'));
      const names = registry.list();
      expect(names).toContain('injected');
    });

    it('does not duplicate names when factory and instance share a name', () => {
      registry.register('dup', () => createMockProvider('dup'));
      registry.registerInstance('dup', createMockProvider('dup'));

      const names = registry.list();
      const dupCount = names.filter((n) => n === 'dup').length;
      expect(dupCount).toBe(1);
    });

    it('returns an array (not a Set or other type)', () => {
      const names = registry.list();
      expect(Array.isArray(names)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // get()
  // -----------------------------------------------------------------------
  describe('get()', () => {
    it('lazily instantiates a provider via its factory', () => {
      const tracked = createTrackedFactory('lazy');
      registry.register('lazy', tracked.factory);

      expect(tracked.callCount).toBe(0);
      registry.get('lazy');
      expect(tracked.callCount).toBe(1);
    });

    it('caches the provider instance after first creation', () => {
      const tracked = createTrackedFactory('cached');
      registry.register('cached', tracked.factory);

      const first = registry.get('cached');
      const second = registry.get('cached');

      expect(first).toBe(second);
      expect(tracked.callCount).toBe(1);
    });

    it('passes config to the factory function', () => {
      let capturedConfig: AxlConfig | undefined;
      registry.register('configurable', (config) => {
        capturedConfig = config;
        return createMockProvider('configurable');
      });

      const config: AxlConfig = {
        defaultProvider: 'configurable',
        providers: { configurable: { apiKey: 'test-key' } },
      };
      registry.get('configurable', config);

      expect(capturedConfig).toBe(config);
    });

    it('throws for unknown provider names', () => {
      expect(() => registry.get('nonexistent')).toThrow('Unknown provider "nonexistent"');
    });

    it('error message lists registered providers', () => {
      registry.register('alpha', () => createMockProvider('alpha'));

      expect(() => registry.get('unknown')).toThrow(/Registered providers:/);
      expect(() => registry.get('unknown')).toThrow(/alpha/);
    });

    it('defaults config to empty object when not provided', () => {
      let capturedConfig: AxlConfig | undefined;
      registry.register('noconfig', (config) => {
        capturedConfig = config;
        return createMockProvider('noconfig');
      });

      registry.get('noconfig');
      expect(capturedConfig).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // resolve()
  // -----------------------------------------------------------------------
  describe('resolve()', () => {
    // Replace built-in providers with mocks to avoid needing API keys
    beforeEach(() => {
      registry.register('openai', () => createMockProvider('openai'));
      registry.register('anthropic', () => createMockProvider('anthropic'));
    });

    it('parses "openai:gpt-4o" into provider=openai, model=gpt-4o', () => {
      const { provider, model } = registry.resolve('openai:gpt-4o');
      expect(provider.name).toBe('openai');
      expect(model).toBe('gpt-4o');
    });

    it('parses "anthropic:claude-3-opus" correctly', () => {
      const { provider, model } = registry.resolve('anthropic:claude-3-opus');
      expect(provider.name).toBe('anthropic');
      expect(model).toBe('claude-3-opus');
    });

    it('handles model names containing colons (e.g. "custom:ns:model-v1")', () => {
      registry.register('custom', () => createMockProvider('custom'));
      // Only the first colon separates provider from model
      const { provider, model } = registry.resolve('custom:ns:model-v1');
      expect(provider.name).toBe('custom');
      expect(model).toBe('ns:model-v1');
    });

    it('uses defaultProvider when URI has no colon ("gpt-4o")', () => {
      const { provider, model } = registry.resolve('gpt-4o');
      expect(provider.name).toBe('openai');
      expect(model).toBe('gpt-4o');
    });

    it('uses custom defaultProvider from config when no colon', () => {
      const { provider, model } = registry.resolve('claude-3-opus', {
        defaultProvider: 'anthropic',
      });
      expect(provider.name).toBe('anthropic');
      expect(model).toBe('claude-3-opus');
    });

    it('uses config defaults when URI is undefined', () => {
      const { provider, model } = registry.resolve(undefined);
      expect(provider.name).toBe('openai');
      expect(model).toBe('gpt-4o');
    });

    it('uses config defaults when URI is empty string', () => {
      const { provider, model } = registry.resolve('');
      expect(provider.name).toBe('openai');
      expect(model).toBe('gpt-4o');
    });

    it('respects defaultProvider and defaultModel from config when URI is undefined', () => {
      const { provider, model } = registry.resolve(undefined, {
        defaultProvider: 'anthropic',
        defaultModel: 'claude-3-sonnet',
      });
      expect(provider.name).toBe('anthropic');
      expect(model).toBe('claude-3-sonnet');
    });

    it('throws on ":" (empty provider and model)', () => {
      expect(() => registry.resolve(':')).toThrow('Invalid provider URI ":"');
    });

    it('throws on ":model" (empty provider)', () => {
      expect(() => registry.resolve(':gpt-4o')).toThrow('Invalid provider URI ":gpt-4o"');
    });

    it('throws on "openai:" (empty model)', () => {
      expect(() => registry.resolve('openai:')).toThrow('Invalid provider URI "openai:"');
    });

    it('error message includes expected format hint', () => {
      expect(() => registry.resolve(':')).toThrow(/Expected format: "provider:model"/);
    });

    it('passes config through to the factory during resolve()', () => {
      let capturedConfig: AxlConfig | undefined;
      registry.register('tracked', (config) => {
        capturedConfig = config;
        return createMockProvider('tracked');
      });

      const config: AxlConfig = { providers: { tracked: { apiKey: 'key123' } } };
      registry.resolve('tracked:some-model', config);

      expect(capturedConfig).toBe(config);
    });

    it('caches provider across multiple resolve() calls with same provider name', () => {
      const tracked = createTrackedFactory('openai-mock');
      registry.register('openai', tracked.factory);

      registry.resolve('openai:gpt-4o');
      registry.resolve('openai:gpt-4-turbo');

      // Factory should only be called once
      expect(tracked.callCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // clearCache()
  // -----------------------------------------------------------------------
  describe('clearCache()', () => {
    it('clears all cached provider instances', () => {
      const tracked = createTrackedFactory('clearable');
      registry.register('clearable', tracked.factory);

      registry.get('clearable');
      expect(tracked.callCount).toBe(1);

      registry.clearCache();

      // Next get() should re-invoke the factory
      registry.get('clearable');
      expect(tracked.callCount).toBe(2);
    });

    it('returns a new instance after cache is cleared', () => {
      const tracked = createTrackedFactory('clearable');
      registry.register('clearable', tracked.factory);

      const first = registry.get('clearable');
      registry.clearCache();
      const second = registry.get('clearable');

      expect(first).not.toBe(second);
    });

    it('does not remove registered factories', () => {
      registry.register('custom', () => createMockProvider('custom'));
      registry.get('custom'); // populate cache

      registry.clearCache();

      expect(registry.has('custom')).toBe(true);
      expect(() => registry.get('custom')).not.toThrow();
    });

    it('also clears instances registered via registerInstance()', () => {
      const mock = createMockProvider('direct');
      registry.registerInstance('direct', mock);

      expect(registry.get('direct')).toBe(mock);

      registry.clearCache();

      // Without a factory, this should now throw
      expect(() => registry.get('direct')).toThrow('Unknown provider "direct"');
    });

    it('has() returns false for instance-only providers after clearCache()', () => {
      registry.registerInstance('ephemeral', createMockProvider('ephemeral'));
      expect(registry.has('ephemeral')).toBe(true);

      registry.clearCache();

      // No factory was registered, so has() should now return false
      expect(registry.has('ephemeral')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Built-in providers (existence check only, no instantiation)
  // -----------------------------------------------------------------------
  describe('built-in providers', () => {
    it('has openai and anthropic factories by default', () => {
      expect(registry.has('openai')).toBe(true);
      expect(registry.has('anthropic')).toBe(true);
    });

    it('lists exactly openai, openai-responses, anthropic, and google for a fresh registry', () => {
      const names = registry.list().sort();
      expect(names).toEqual(['anthropic', 'google', 'openai', 'openai-responses']);
    });
  });

  // -----------------------------------------------------------------------
  // Isolation between registries
  // -----------------------------------------------------------------------
  describe('isolation between instances', () => {
    it('separate ProviderRegistry instances do not share state', () => {
      const r1 = new ProviderRegistry();
      const r2 = new ProviderRegistry();

      r1.register('custom', () => createMockProvider('custom'));

      expect(r1.has('custom')).toBe(true);
      expect(r2.has('custom')).toBe(false);
    });

    it('clearCache on one registry does not affect another', () => {
      const r1 = new ProviderRegistry();
      const r2 = new ProviderRegistry();

      r1.register('shared', () => createMockProvider('shared'));
      r2.register('shared', () => createMockProvider('shared'));

      const p1 = r1.get('shared');
      const p2 = r2.get('shared');

      r1.clearCache();

      // r2's cache should be untouched
      expect(r2.get('shared')).toBe(p2);
      // r1's cache was cleared, should get a new instance
      expect(r1.get('shared')).not.toBe(p1);
    });
  });
});

// ---------------------------------------------------------------------------
// Module-level exports
// ---------------------------------------------------------------------------

describe('defaultRegistry (module export)', () => {
  it('is a ProviderRegistry instance', () => {
    expect(defaultRegistry).toBeInstanceOf(ProviderRegistry);
  });

  it('has built-in providers', () => {
    expect(defaultRegistry.has('openai')).toBe(true);
    expect(defaultRegistry.has('anthropic')).toBe(true);
  });
});

describe('resolveProvider() convenience function', () => {
  it('delegates to defaultRegistry.resolve()', () => {
    // Override built-in openai in defaultRegistry with a mock
    defaultRegistry.register('openai', () => createMockProvider('openai'));

    const { provider, model } = resolveProvider('openai:gpt-4o');
    expect(provider.name).toBe('openai');
    expect(model).toBe('gpt-4o');

    // Clean up: clear cache so other tests aren't affected
    defaultRegistry.clearCache();
  });
});
