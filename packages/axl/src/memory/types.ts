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

/** Embedder interface for converting text to vectors. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

/** Memory configuration. */
export type MemoryConfig = {
  /** Vector store for semantic memory (optional). */
  vectorStore?: VectorStore;
  /** Embedder for converting text to vectors (required if vectorStore is set). */
  embedder?: Embedder;
};
