import type { VectorStore, VectorEntry, VectorResult } from './types.js';

/** Compute cosine similarity between two vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * In-memory vector store using brute-force cosine similarity.
 * Suitable for testing and small datasets only.
 */
export class InMemoryVectorStore implements VectorStore {
  private entries = new Map<string, VectorEntry>();

  async upsert(entries: VectorEntry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.set(entry.id, { ...entry });
    }
  }

  async search(embedding: number[], topK: number): Promise<VectorResult[]> {
    const results: VectorResult[] = [];

    for (const entry of this.entries.values()) {
      const score = cosineSimilarity(embedding, entry.embedding);
      results.push({
        id: entry.id,
        content: entry.content,
        score,
        metadata: entry.metadata,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.entries.delete(id);
    }
  }
}
