import type {
  VectorStore,
  Embedder,
  EmbedUsage,
  VectorResult,
  RememberOptions,
  RecallOptions,
} from './types.js';
import type { StateStore } from '../state/types.js';

/**
 * Result of a `MemoryManager.remember()` call.
 *
 * Exposes embedder `usage` so callers (WorkflowContext) can attribute
 * cost to the current execution scope and surface it in trace events.
 * `usage` is absent when no embedding happened (embed option not set,
 * or no vector store configured).
 */
export type RememberResult = {
  usage?: EmbedUsage;
};

/**
 * Result of a `MemoryManager.recall()` call.
 *
 * Wraps the original return shape (key-value payload or vector search
 * results) with optional embedder `usage`. Semantic recall populates
 * `usage` when the embedder reported it; key-value lookups never do.
 */
export type RecallResult = {
  data: unknown | VectorResult[] | null;
  usage?: EmbedUsage;
};

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
   *
   * Returns `{ usage }` when embedding happened, carrying the embedder's
   * cost/token reporting out to the caller for cost attribution.
   */
  async remember(
    key: string,
    value: unknown,
    stateStore: StateStore,
    sessionId: string | undefined,
    options?: RememberOptions,
    signal?: AbortSignal,
  ): Promise<RememberResult> {
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
      const { vectors, usage } = await this.embedder.embed([text], signal);
      // The embed API call already happened — the user has been billed.
      // If the downstream vectorStore.upsert fails, we must preserve the
      // usage attribution so the caller's error handler can still record
      // cost for the completed embed. Without this, a transient vector-store
      // failure silently decouples real API spend from the cost tracker,
      // and the user's reported costs diverge from their provider bill.
      try {
        await this.vectorStore.upsert([
          {
            id: `${storeScope}:${key}`,
            content: text,
            embedding: vectors[0],
            metadata: { key, scope, ...options?.metadata },
          },
        ]);
      } catch (err) {
        if (usage && typeof err === 'object' && err !== null) {
          // Non-enumerable so it doesn't pollute `JSON.stringify(err)` or
          // stack-trace output, but code that knows to look for it can
          // recover the cost attribution on the failure path.
          Object.defineProperty(err, 'axlEmbedUsage', {
            value: usage,
            enumerable: false,
            writable: true,
            configurable: true,
          });
        }
        throw err;
      }
      return usage ? { usage } : {};
    }

    return {};
  }

  /**
   * Recall a value from memory by key, or perform semantic search if query is provided.
   *
   * Always returns `{ data }`; semantic recalls additionally include
   * `usage` from the embedder (when the embedder reported it).
   */
  async recall(
    key: string,
    stateStore: StateStore,
    sessionId: string | undefined,
    options?: RecallOptions,
    signal?: AbortSignal,
  ): Promise<RecallResult> {
    // Semantic search mode
    if (options?.query && this.vectorStore && this.embedder) {
      const { vectors, usage } = await this.embedder.embed([options.query], signal);
      const topK = options?.topK ?? 5;

      // Determine the target scope for filtering
      const searchScope = options?.scope ?? 'session';
      if (searchScope === 'session' && !sessionId) {
        throw new Error(
          'sessionId is required for session-scoped memory. Use { scope: "global" } or provide a sessionId in metadata.',
        );
      }

      // Fetch extra results to account for scope filtering, then filter by scope
      const rawResults = await this.vectorStore.search(vectors[0], topK * 3);
      const filtered = rawResults.filter((r) => {
        // Global entries are always visible
        if (r.id.startsWith('global:')) return true;
        // Session entries only visible to the same session
        if (searchScope === 'session') return r.id.startsWith(`session:${sessionId}:`);
        return true;
      });
      const data = filtered.slice(0, topK);
      return usage ? { data, usage } : { data };
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
      return { data: await stateStore.getMemory(storeScope, key) };
    }

    // Fallback to sessionMeta
    const storeKey = `memory:${storeScope}:${key}`;
    return { data: await stateStore.getSessionMeta(storeKey, 'value') };
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
