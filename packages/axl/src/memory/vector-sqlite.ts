import type { VectorStore, VectorEntry, VectorResult } from './types.js';

/** Minimal interface for a better-sqlite3 database instance. */
interface BetterSqlite3Database {
  pragma(pragma: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T extends (...args: never[]) => void>(fn: T): T;
  close(): void;
}

/**
 * SQLite-backed vector store using better-sqlite3.
 * Uses a simple serialized embedding column with brute-force cosine similarity in JS.
 * For production workloads, consider a dedicated vector database.
 *
 * This avoids dependency on sqlite-vec extension by computing similarity in JS
 * after retrieving all rows (brute-force scan). Suitable for small-to-medium datasets.
 */
export class SqliteVectorStore implements VectorStore {
  private db: BetterSqlite3Database;

  constructor(options: { path?: string } = {}) {
    let Database: new (path: string) => BetterSqlite3Database;
    try {
      Database = require('better-sqlite3');
    } catch {
      throw new Error(
        'better-sqlite3 is required for SqliteVectorStore. Install it with: npm install better-sqlite3',
      );
    }
    this.db = new Database(options.path ?? ':memory:');
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL,
        metadata TEXT
      )
    `);
  }

  async upsert(entries: VectorEntry[]): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO vectors (id, content, embedding, metadata) VALUES (?, ?, ?, ?)',
    );
    const tx = this.db.transaction((items: VectorEntry[]) => {
      for (const entry of items) {
        stmt.run(
          entry.id,
          entry.content,
          JSON.stringify(entry.embedding),
          entry.metadata ? JSON.stringify(entry.metadata) : null,
        );
      }
    });
    tx(entries);
  }

  async search(embedding: number[], topK: number): Promise<VectorResult[]> {
    const rows = this.db
      .prepare('SELECT id, content, embedding, metadata FROM vectors')
      .all() as Array<{
      id: string;
      content: string;
      embedding: string;
      metadata: string | null;
    }>;

    const results: VectorResult[] = rows.map((row) => {
      const storedEmbedding = JSON.parse(row.embedding) as number[];
      const score = cosineSimilarity(embedding, storedEmbedding);
      return {
        id: row.id,
        content: row.content,
        score,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      };
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM vectors WHERE id IN (${placeholders})`).run(...ids);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

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
