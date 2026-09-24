/**
 * A16.6 — bound method stability on the scoped provider facade.
 *
 * A `Proxy` that binds on every `get` returns a fresh function object each
 * time, which quietly breaks two very ordinary things: identity comparison
 * (`p.chat === p.chat`, used to detect wrapping) and listener removal (a
 * handler registered as `p.onX` can never be removed again). The facade caches
 * per property, and a cached bound method must still work detached from the
 * facade — including one that reads a class `#private` field.
 */

import { describe, it, expect } from 'vitest';

import { AxlRuntime } from '../runtime.js';
import { createScopedProvider } from '../providers/scoped-provider.js';
import type {
  ChatMessage,
  ChatOptions,
  EffortResolution,
  InputModalitySupport,
  Provider,
  StreamChunk,
} from '../providers/types.js';
import type { ProviderResponse } from '../types.js';

class BindingProvider implements Provider {
  readonly name = 'binding';
  #label = 'private-label';

  inputCapabilities(model: string): InputModalitySupport {
    // Reads a private field, so a detached call with the wrong `this` throws.
    return { image: { sources: [`${this.#label}:${model}` as never] } };
  }

  effortResolution(): EffortResolution | undefined {
    return { requested: 'high', effective: 'high', clamped: false } as EffortResolution;
  }

  async chat(_messages: ChatMessage[], _options: ChatOptions): Promise<ProviderResponse> {
    return { content: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }

  // eslint-disable-next-line require-yield
  async *stream(): AsyncGenerator<StreamChunk> {
    throw new Error('unused');
  }
}

describe('A16.6: the facade returns the same bound function on every read', () => {
  it('keeps `f1 === f2` for a forwarded capability method', () => {
    const facade = createScopedProvider(new BindingProvider());

    const f1 = facade.inputCapabilities;
    const f2 = facade.inputCapabilities;

    expect(typeof f1).toBe('function');
    expect(f1).toBe(f2);
    // Distinct properties are cached separately, not collapsed onto one entry.
    expect(facade.effortResolution).not.toBe(f1);
    expect(facade.effortResolution).toBe(facade.effortResolution);
  });

  it('lets the detached reference run with the raw adapter as its receiver', () => {
    const facade = createScopedProvider(new BindingProvider());

    const detached = facade.inputCapabilities!;
    // Called with no receiver at all: only a function bound to the RAW instance
    // can read `#label` here.
    expect(detached('gpt-x')).toEqual({ image: { sources: ['private-label:gpt-x'] } });
  });

  it('keeps chat and stream stable too, so identity checks on them still work', () => {
    const facade = createScopedProvider(new BindingProvider());

    expect(facade.chat).toBe(facade.chat);
    expect(facade.stream).toBe(facade.stream);
    // The intercepted methods are the facade's own, never the raw adapter's.
    expect(facade.chat).not.toBe(BindingProvider.prototype.chat);
  });

  it('holds across resolutions from one runtime, which share a single facade', () => {
    const raw = new BindingProvider();
    const runtime = new AxlRuntime({ defaultProvider: 'binding' });
    runtime.registerProvider('binding', raw);

    const first = runtime.resolveProvider('binding:a').provider;
    const second = runtime.resolveProvider('binding:b').provider;

    expect(second).toBe(first);
    expect(first.inputCapabilities).toBe(second.inputCapabilities);
  });
});
