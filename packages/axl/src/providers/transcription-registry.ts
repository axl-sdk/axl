import type { AxlConfig } from '../config.js';
import { UnsupportedTranscriptionInputError } from '../errors.js';
import type { TranscriptionProvider } from './transcription-types.js';

export type TranscriptionProviderFactory = (config: AxlConfig) => TranscriptionProvider;
export type ResolvedTranscriptionProvider = {
  provider: TranscriptionProvider;
  model: string;
  providerName: string;
};

/** Dedicated registry: transcription URIs are always explicit `provider:model`.
 * It intentionally has no chat-provider/default-model or test fallback. */
export class TranscriptionProviderRegistry {
  private instances = new Map<string, TranscriptionProvider>();
  private factories = new Map<string, TranscriptionProviderFactory>();

  register(name: string, factory: TranscriptionProviderFactory): void {
    this.factories.set(name, factory);
    this.instances.delete(name);
  }

  registerInstance(name: string, provider: TranscriptionProvider): void {
    this.instances.set(name, provider);
  }

  has(name: string): boolean {
    return this.instances.has(name) || this.factories.has(name);
  }

  get(name: string, config: AxlConfig = {}): TranscriptionProvider {
    const instance = this.instances.get(name);
    if (instance) return instance;
    const factory = this.factories.get(name);
    if (factory) {
      const created = factory(config);
      this.instances.set(name, created);
      return created;
    }
    throw new UnsupportedTranscriptionInputError({
      provider: name,
      model: '',
      feature: 'transcription',
    });
  }

  resolve(uri: string, config: AxlConfig = {}): ResolvedTranscriptionProvider {
    const colon = typeof uri === 'string' ? uri.indexOf(':') : -1;
    if (colon <= 0 || colon === uri.length - 1 || uri.indexOf(':', colon + 1) !== -1) {
      throw new UnsupportedTranscriptionInputError({
        provider: 'unknown',
        model: '',
        feature: 'an explicit transcription provider:model URI',
      });
    }
    const providerName = uri.slice(0, colon);
    const model = uri.slice(colon + 1);
    return { provider: this.get(providerName, config), model, providerName };
  }
}
