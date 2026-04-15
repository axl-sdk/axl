/** A single vector entry in the store. */
export type VectorEntry = {
  id: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
};

/** A result from a vector similarity search. */
export type VectorResult = {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
};

/** Options for ctx.remember(). */
export type RememberOptions = {
  /** 'session' (default) scopes to current session, 'global' scopes to all sessions. */
  scope?: 'session' | 'global';
  /** Arbitrary metadata stored alongside the value. */
  metadata?: Record<string, unknown>;
  /** When true and a vector store is configured, also embed for semantic search. */
  embed?: boolean;
};

/** Options for ctx.recall(). */
export type RecallOptions = {
  /** 'session' (default) scopes to current session, 'global' scopes to all sessions. */
  scope?: 'session' | 'global';
  /** When provided, performs semantic similarity search instead of exact key lookup. */
  query?: string;
  /** Number of results for semantic search. Defaults to 5. */
  topK?: number;
};

/** Vector store interface for semantic memory. */
export interface VectorStore {
  upsert(entries: VectorEntry[]): Promise<void>;
  search(embedding: number[], topK: number): Promise<VectorResult[]>;
  delete(ids: string[]): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Usage info reported by an embedder for a single `embed()` call.
 *
 * Mirrors the provider `usage` namespace — nested rather than flat so
 * future additions (latency, cache-hit info, rate-limit headers) extend
 * this type without breaking the `Embedder` return shape.
 *
 * All fields are optional so embedders without cost/pricing knowledge
 * (e.g. local models, self-hosted) can still conform to the interface.
 */
export type EmbedUsage = {
  /** Total input tokens consumed. */
  tokens?: number;
  /** Cost in USD, computed from tokens × per-model pricing. */
  cost?: number;
  /** The underlying model identifier (e.g. "text-embedding-3-small"). */
  model?: string;
};

/**
 * Result of an `Embedder.embed()` call.
 *
 * Always contains `vectors`. `usage` is optional so embedders can omit
 * it entirely (non-OpenAI, local, test fakes).
 */
export type EmbedResult = {
  vectors: number[][];
  usage?: EmbedUsage;
};

/** Embedder interface for converting text to vectors. */
export interface Embedder {
  /**
   * Embed one or more texts into vectors.
   *
   * @param texts   Input strings to embed.
   * @param signal  Optional `AbortSignal` — when triggered, the underlying
   *                network call should abort. Passed through from
   *                `ctx.remember` / `ctx.recall` so user cancellation and
   *                hard_stop budget aborts propagate to the embedder fetch.
   *                Impls are free to ignore it (the call just runs to
   *                completion like before), but OpenAIEmbedder honors it
   *                via `fetchWithRetry`.
   */
  embed(texts: string[], signal?: AbortSignal): Promise<EmbedResult>;
  readonly dimensions: number;
}

/** Memory configuration. */
export type MemoryConfig = {
  /** Vector store for semantic memory (optional). */
  vectorStore?: VectorStore;
  /** Embedder for converting text to vectors (required if vectorStore is set). */
  embedder?: Embedder;
};
