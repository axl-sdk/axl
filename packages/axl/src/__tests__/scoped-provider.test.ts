/**
 * Scoped provider facade compatibility (plan A16, I10).
 *
 * `resolveProvider()` no longer returns the registered instance — a documented
 * breaking change. Everything a caller could reasonably do with an adapter has
 * to keep working anyway, and outside an accounting scope the facade must be
 * indistinguishable from the raw adapter.
 */

import { describe, it, expect, vi } from 'vitest';

import { AxlRuntime } from '../runtime.js';
import { AdmissionController } from '../accounting.js';
import { createScopedProvider } from '../providers/scoped-provider.js';
import type { ChatMessage, ChatOptions, Provider, StreamChunk } from '../providers/types.js';
import type { EffortResolution, InputModalitySupport } from '../providers/types.js';
import { deferred } from './accounting-helpers.js';

/**
 * A deliberately awkward adapter: class private fields, an accessor, a mutable
 * property, and the full capability surface. If the facade forwards this, it
 * forwards anything short of exotic reflection.
 */
class RichProvider implements Provider {
  readonly name = 'rich';
  readonly reportsRequestLifecycle = true as const;
  /** Mutable public state a caller may write through the facade. */
  label = 'initial';
  #secret = 'private-field-value';
  #calls = 0;

  get callCount(): number {
    return this.#calls;
  }

  /** Reads a private field — throws if `this` is a Proxy rather than the raw. */
  revealSecret(): string {
    return this.#secret;
  }

  inputCapabilities(): InputModalitySupport {
    return { image: { sources: ['url'] } };
  }

  validateInput(): { effectiveModel: string } {
    return { effectiveModel: 'validated' };
  }

  nativeStructuredOutputSupport(): 'schema' {
    return 'schema';
  }

  realizesPromptCache(): boolean {
    return true;
  }

  effortResolution(): EffortResolution | undefined {
    return { requested: 'high', effective: 'high', clamped: false } as EffortResolution;
  }

  async chat(_messages: ChatMessage[], options: ChatOptions) {
    this.#calls += 1;
    return {
      content: 'rich',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      cost: 0.5,
      costProvenance: 'price_table_estimate' as const,
      // Echo back what the facade threaded through, for assertions.
      providerMetadata: { sawDispatchAdmission: options.dispatchAdmission !== undefined },
    };
  }

  async *stream(_messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    this.#calls += 1;
    yield { type: 'text_delta', content: 'rich' };
    yield {
      type: 'done',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      cost: 0.5,
      providerMetadata: { sawDispatchAdmission: options.dispatchAdmission !== undefined },
    };
  }
}

function runtimeWith(raw: Provider): AxlRuntime {
  const runtime = new AxlRuntime({ defaultProvider: raw.name ?? 'rich' });
  runtime.registerProvider(raw.name ?? 'rich', raw);
  return runtime;
}

describe('I10: the facade forwards everything but chat and stream', () => {
  it('does not let a hostile timing field interrupt a successful settlement', async () => {
    const runtime = runtimeWith({
      name: 'rich',
      async chat() {
        const timing = {} as { queuedMs: number };
        Object.defineProperty(timing, 'queuedMs', {
          get() {
            throw new Error('hostile timing');
          },
        });
        return { content: 'ok', cost: 0.1, timing: timing as never };
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('unused');
      },
    });
    const provider = runtime.resolveProvider('rich:m').provider;
    const admission = new AdmissionController({ limit: 1 });
    const outcome = await runtime.trackOutcome(
      () => provider.chat([], { model: 'm', accountingModelUri: 'rich:m' }),
      { admission },
    );
    expect(outcome.status).toBe('fulfilled');
    expect(outcome.accounting.knownCost).toBe(0.1);
    expect(admission.knownSpend).toBe(0.1);
    expect(outcome.modelTiming).toBeUndefined();
  });
  it('returns a stable facade that is NOT the registered instance', () => {
    const raw = new RichProvider();
    const runtime = runtimeWith(raw);

    const first = runtime.resolveProvider('rich:m').provider;
    const second = runtime.resolveProvider('rich:other-model').provider;

    // Documented break.
    expect(first).not.toBe(raw);
    // Stable per runtime per adapter, so caching a resolution still works.
    expect(second).toBe(first);
  });

  it('keeps ordinary instanceof working', () => {
    const raw = new RichProvider();
    const facade = createScopedProvider(raw);
    expect(facade).toBeInstanceOf(RichProvider);
    expect(Object.getPrototypeOf(facade)).toBe(Object.getPrototypeOf(raw));
  });

  it('forwards custom properties, accessors and private-field methods', () => {
    const raw = new RichProvider();
    const facade = createScopedProvider(raw) as RichProvider;

    expect(facade.name).toBe('rich');
    expect(facade.label).toBe('initial');
    // A method that reads `this.#secret` would throw on a Proxy receiver.
    expect(facade.revealSecret()).toBe('private-field-value');
    expect(facade.callCount).toBe(0);
  });

  it('forwards property writes to the raw adapter', () => {
    const raw = new RichProvider();
    const facade = createScopedProvider(raw) as RichProvider;

    facade.label = 'written through the facade';
    expect(raw.label).toBe('written through the facade');
    expect(facade.label).toBe('written through the facade');
  });

  it('reflects accessor state that changes on the raw instance', async () => {
    const raw = new RichProvider();
    const facade = createScopedProvider(raw) as RichProvider;
    await facade.chat([], { model: 'm' });
    // Evaluated on the raw instance at read time, not snapshotted.
    expect(facade.callCount).toBe(1);
    expect(raw.callCount).toBe(1);
  });

  it('forwards every capability method', () => {
    const raw = new RichProvider();
    const facade = createScopedProvider(raw);

    expect(facade.inputCapabilities?.('m')).toEqual({ image: { sources: ['url'] } });
    expect(facade.validateInput?.({} as never)).toEqual({ effectiveModel: 'validated' });
    expect(facade.nativeStructuredOutputSupport?.('m')).toBe('schema');
    expect(facade.realizesPromptCache?.('m')).toBe(true);
    expect(facade.effortResolution?.({ model: 'm' })).toMatchObject({ clamped: false });
    expect(facade.reportsRequestLifecycle).toBe(true);
  });

  it('exposes the same own keys as the raw adapter', () => {
    const raw = new RichProvider();
    const facade = createScopedProvider(raw);
    expect(Object.keys(facade)).toEqual(Object.keys(raw));
    expect('label' in facade).toBe(true);
    expect('nope' in facade).toBe(false);
  });
});

describe('I10: outside an accounting scope the facade delegates verbatim', () => {
  it('does not thread a dispatch admission hook into chat', async () => {
    const raw = new RichProvider();
    const facade = createScopedProvider(raw);
    const response = await facade.chat([], { model: 'm' });
    expect(response.providerMetadata).toEqual({ sawDispatchAdmission: false });
  });

  it('does not thread a dispatch admission hook into stream', async () => {
    const raw = new RichProvider();
    const facade = createScopedProvider(raw);
    const chunks: StreamChunk[] = [];
    for await (const chunk of facade.stream([], { model: 'm' })) chunks.push(chunk);
    const done = chunks.at(-1) as Extract<StreamChunk, { type: 'done' }>;
    expect(done.providerMetadata).toEqual({ sawDispatchAdmission: false });
  });

  it('threads the hook once a scope is active, and preserves a caller lifecycle observer', async () => {
    const raw = new RichProvider();
    const runtime = runtimeWith(raw);
    const facade = runtime.resolveProvider('rich:m').provider;
    const onDispatch = vi.fn();

    const outcome = await runtime.trackOutcome(async () =>
      facade.chat([], { model: 'm', requestLifecycle: { onDispatch } }),
    );

    expect(outcome.status).toBe('fulfilled');
    expect(outcome.accounting.knownCost).toBe(0.5);
    expect(outcome.accounting.provenance).toEqual({ price_table_estimate: 0.5 });
    if (outcome.status === 'fulfilled') {
      expect(outcome.value.providerMetadata).toEqual({ sawDispatchAdmission: true });
    }
    // The caller's own observer still fires — the facade chains, not replaces.
    // (RichProvider never reports dispatch, so this asserts non-interference.)
    expect(onDispatch).not.toHaveBeenCalled();
  });
});

describe('I10: a stream resolves its scope at the first next(), not at construction', () => {
  it('attributes the stream to the scope iterating it', async () => {
    const raw = new RichProvider();
    const runtime = runtimeWith(raw);
    const facade = runtime.resolveProvider('rich:m').provider;

    // Built OUTSIDE any scope.
    const iterator = facade.stream([], { model: 'm' });
    expect(raw.callCount).toBe(0);

    const outcome = await runtime.trackOutcome(async () => {
      for await (const _chunk of iterator) void _chunk;
      return null;
    });

    // Opened and settled inside the scope that iterated it.
    expect(raw.callCount).toBe(1);
    expect(outcome.accounting.operations.byKind.stream).toBe(1);
    expect(outcome.accounting.knownCost).toBe(0.5);
  });

  it('forwards an early return() straight to the adapter without waiting on next()', async () => {
    const closed = deferred();
    let returnCalls = 0;
    const stalling: Provider = {
      name: 'stalling',
      async chat() {
        throw new Error('unused');
      },
      stream: () =>
        ({
          [Symbol.asyncIterator]() {
            return {
              // Never settles — a `return()` that waited on it would hang.
              next: () => new Promise<never>(() => {}),
              return: async () => {
                returnCalls += 1;
                closed.resolve();
                return { done: true as const, value: undefined };
              },
            };
          },
        }) as unknown as AsyncGenerator<StreamChunk>,
    };
    const runtime = runtimeWith(stalling);
    const facade = runtime.resolveProvider('stalling:m').provider;

    const outcome = await runtime.trackOutcome(async () => {
      const iterator = facade.stream([], { model: 'm' });
      void iterator.next();
      await iterator.return(undefined);
      await closed.promise;
      return null;
    });

    expect(returnCalls).toBe(1);
    // Dispatched work closed without a `done` chunk is unknown, never free.
    expect(outcome.accounting.completeness).toBe('incomplete');
    expect(outcome.accounting.reasons).toEqual({ usage_missing: 1 });
  });
});

describe('I5: the facade rethrows the original value', () => {
  it.each([
    ['a frozen object', Object.freeze({ vendor: 'down' })],
    ['a string', 'plain failure'],
  ])('preserves %s thrown by chat', async (_label, thrown) => {
    const failing: Provider = {
      name: 'failing',
      async chat() {
        throw thrown;
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw thrown;
      },
    };
    const runtime = runtimeWith(failing);
    const facade = runtime.resolveProvider('failing:m').provider;

    const outcome = await runtime.trackOutcome(() => facade.chat([], { model: 'm' }));
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.error).toBe(thrown);
    expect(outcome.accounting.reasons).toEqual({ usage_missing: 1 });
  });
});

describe('I10: an adapter that throws synchronously from stream() settles its operation', () => {
  it('does not leave an opened operation behind for the scope to abandon', async () => {
    // A non-generator `stream` that validates eagerly throws on the CALL, not
    // on the first `next()`. The operation is already open at that point and
    // nothing later can settle it, because the generator is finished.
    const boom = new Error('stream() rejected its arguments');
    const eager: Provider = {
      name: 'eager',
      async chat() {
        return { content: 'unused' };
      },
      stream(): AsyncGenerator<StreamChunk> {
        throw boom;
      },
    };
    const runtime = runtimeWith(eager);
    const facade = runtime.resolveProvider('eager:m').provider;

    const outcome = await runtime.trackOutcome(async () => {
      const iterator = facade.stream([], { model: 'm' });
      await iterator.next();
      return null;
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.error).toBe(boom);
    // `usage_missing`, not `abandoned`: it reached a terminal state at the
    // throw rather than being swept up at finalization.
    expect(outcome.accounting.reasons).toEqual({ usage_missing: 1 });
    expect(outcome.accounting.operations.unknown).toBe(1);
    expect(outcome.accounting.operations.total).toBe(1);
    expect(outcome.accounting.completeness).toBe('incomplete');
  });
});
