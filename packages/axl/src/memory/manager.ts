import type {
  VectorStore,
  Embedder,
  VectorResult,
  RememberOptions,
  RecallOptions,
} from './types.js';
import type { StateStore } from '../state/types.js';

/**
 * Coordinates key-value memory and vector store for semantic search.
 * All key-value operations delegate to the StateStore.
 * Vector operations use the configured VectorStore + Embedder.
 */
export class MemoryManager {
  private vectorStore?: VectorStore;
  private embedder?: Embedder;

  constructor(options?: { vectorStore?: VectorStore; embedder?: Embedder }) {
    this.vectorStore = options?.vectorStore;
    this.embedder = options?.embedder;

    if (this.vectorStore && !this.embedder) {
      throw new Error('An embedder is required when a vectorStore is configured');
    }
  }

  /**
   * Store a key-value pair in memory.
   * If a vector store and embedder are configured and embed is true,
   * also embeds the value for semantic search.
   */
  async remember(
    key: string,
    value: unknown,
    stateStore: StateStore,
    sessionId: string | undefined,
    options?: RememberOptions,
  ): Promise<void> {
    const scope = options?.scope ?? 'session';

    // Determine the storage scope string
    if (scope === 'session' && !sessionId) {
      throw new Error(
        'sessionId is required for session-scoped memory. Use { scope: "global" } or provide a sessionId in metadata.',
      );
    }
    const storeScope = scope === 'session' ? `session:${sessionId}` : 'global';

    // Use dedicated memory methods if available, otherwise fall back to sessionMeta
    if (stateStore.saveMemory) {
      await stateStore.saveMemory(storeScope, key, value);
    } else {
      const storeKey = `memory:${storeScope}:${key}`;
      await stateStore.saveSessionMeta(storeKey, 'value', value);
      if (options?.metadata) {
        await stateStore.saveSessionMeta(storeKey, 'metadata', options.metadata);
      }
    }

    // Optionally embed for semantic search (opt-in: embed must be explicitly true)
    if (options?.embed === true && this.vectorStore && this.embedder) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const [embedding] = await this.embedder.embed([text]);
      await this.vectorStore.upsert([
        {
          id: `${storeScope}:${key}`,
          content: text,
          embedding,
          metadata: { key, scope, ...options?.metadata },
        },
      ]);
    }
  }

  /**
   * Recall a value from memory by key, or perform semantic search if query is provided.
   */
  async recall(
    key: string,
    stateStore: StateStore,
    sessionId: string | undefined,
    options?: RecallOptions,
  ): Promise<unknown | VectorResult[] | null> {
    // Semantic search mode
    if (options?.query && this.vectorStore && this.embedder) {
      const [embedding] = await this.embedder.embed([options.query]);
      const topK = options?.topK ?? 5;

      // Determine the target scope for filtering
      const searchScope = options?.scope ?? 'session';
      if (searchScope === 'session' && !sessionId) {
        throw new Error(
          'sessionId is required for session-scoped memory. Use { scope: "global" } or provide a sessionId in metadata.',
        );
      }

      // Fetch extra results to account for scope filtering, then filter by scope
      const rawResults = await this.vectorStore.search(embedding, topK * 3);
      const filtered = rawResults.filter((r) => {
        // Global entries are always visible
        if (r.id.startsWith('global:')) return true;
        // Session entries only visible to the same session
        if (searchScope === 'session') return r.id.startsWith(`session:${sessionId}:`);
        return true;
      });
      return filtered.slice(0, topK);
    }

    // Key-value lookup
    const scope = options?.scope ?? 'session';
    if (scope === 'session' && !sessionId) {
      throw new Error(
        'sessionId is required for session-scoped memory. Use { scope: "global" } or provide a sessionId in metadata.',
      );
    }
    const storeScope = scope === 'session' ? `session:${sessionId}` : 'global';

    if (stateStore.getMemory) {
      return stateStore.getMemory(storeScope, key);
    }

    // Fallback to sessionMeta
    const storeKey = `memory:${storeScope}:${key}`;
    return stateStore.getSessionMeta(storeKey, 'value');
  }

  /** Delete a memory entry. If a vector store is configured, also removes the embedding. */
  async forget(
    key: string,
    stateStore: StateStore,
    sessionId: string | undefined,
    options?: { scope?: 'session' | 'global' },
  ): Promise<void> {
    const scope = options?.scope ?? 'session';
    if (scope === 'session' && !sessionId) {
      throw new Error(
        'sessionId is required for session-scoped memory. Use { scope: "global" } or provide a sessionId in metadata.',
      );
    }
    const storeScope = scope === 'session' ? `session:${sessionId}` : 'global';

    if (stateStore.deleteMemory) {
      await stateStore.deleteMemory(storeScope, key);
    } else {
      // Fallback: save null to effectively "delete" both value and metadata keys
      const storeKey = `memory:${storeScope}:${key}`;
      await stateStore.saveSessionMeta(storeKey, 'value', null);
      await stateStore.saveSessionMeta(storeKey, 'metadata', null);
    }

    // Remove from vector store if present
    if (this.vectorStore) {
      await this.vectorStore.delete([`${storeScope}:${key}`]);
    }
  }

  /** Shut down the vector store if it has a close method. */
  async close(): Promise<void> {
    if (this.vectorStore?.close) {
      await this.vectorStore.close();
    }
  }
}
