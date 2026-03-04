import { describe, it, expect } from 'vitest';
import { MemoryManager } from '../memory/manager.js';
import { InMemoryVectorStore } from '../memory/vector-memory.js';
import { SqliteVectorStore } from '../memory/vector-sqlite.js';
import { MemoryStore } from '../state/memory.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { randomUUID } from 'node:crypto';
import type { Embedder } from '../memory/types.js';

/** Mock embedder that returns predictable vectors. */
class MockEmbedder implements Embedder {
  readonly dimensions = 3;
  private callCount = 0;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      this.callCount++;
      // Simple deterministic embedding based on text content
      if (text.includes('cat')) return [1, 0, 0];
      if (text.includes('dog')) return [0.9, 0.1, 0];
      if (text.includes('fish')) return [0, 0, 1];
      return [0.5, 0.5, 0];
    });
  }
}

describe('memory', () => {
  describe('InMemoryVectorStore', () => {
    it('upsert and search', async () => {
      const store = new InMemoryVectorStore();
      await store.upsert([
        { id: '1', content: 'cat', embedding: [1, 0, 0] },
        { id: '2', content: 'dog', embedding: [0.9, 0.1, 0] },
        { id: '3', content: 'fish', embedding: [0, 0, 1] },
      ]);

      const results = await store.search([1, 0, 0], 2);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('1'); // cat is exact match
      expect(results[1].id).toBe('2'); // dog is close
    });

    it('delete removes entries', async () => {
      const store = new InMemoryVectorStore();
      await store.upsert([
        { id: '1', content: 'a', embedding: [1, 0] },
        { id: '2', content: 'b', embedding: [0, 1] },
      ]);
      await store.delete(['1']);
      const results = await store.search([1, 0], 5);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('2');
    });
  });

  describe('SqliteVectorStore', () => {
    it('upsert and search', async () => {
      const store = new SqliteVectorStore();
      await store.upsert([
        { id: '1', content: 'cat', embedding: [1, 0, 0] },
        { id: '2', content: 'dog', embedding: [0.9, 0.1, 0] },
        { id: '3', content: 'fish', embedding: [0, 0, 1] },
      ]);

      const results = await store.search([1, 0, 0], 2);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('1'); // cat is exact match
      expect(results[1].id).toBe('2'); // dog is close
      await store.close();
    });

    it('delete removes entries', async () => {
      const store = new SqliteVectorStore();
      await store.upsert([
        { id: '1', content: 'a', embedding: [1, 0] },
        { id: '2', content: 'b', embedding: [0, 1] },
      ]);
      await store.delete(['1']);
      const results = await store.search([1, 0], 5);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('2');
      await store.close();
    });

    it('upsert replaces existing entries', async () => {
      const store = new SqliteVectorStore();
      await store.upsert([{ id: '1', content: 'original', embedding: [1, 0, 0] }]);
      await store.upsert([{ id: '1', content: 'updated', embedding: [0, 1, 0] }]);

      const results = await store.search([0, 1, 0], 5);
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('updated');
      await store.close();
    });

    it('stores and retrieves metadata', async () => {
      const store = new SqliteVectorStore();
      await store.upsert([
        { id: '1', content: 'cat', embedding: [1, 0, 0], metadata: { type: 'animal' } },
      ]);

      const results = await store.search([1, 0, 0], 1);
      expect(results[0].metadata).toEqual({ type: 'animal' });
      await store.close();
    });
  });

  describe('MemoryManager', () => {
    it('remember and recall key-value (session scope)', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();

      await mgr.remember('name', 'Alice', stateStore, 'sess-1');
      const result = await mgr.recall('name', stateStore, 'sess-1');
      expect(result).toBe('Alice');
    });

    it('remember and recall key-value (global scope)', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();

      await mgr.remember('setting', 'dark', stateStore, 'sess-1', { scope: 'global' });
      // Can recall from different session
      const result = await mgr.recall('setting', stateStore, 'sess-2', { scope: 'global' });
      expect(result).toBe('dark');
    });

    it('semantic recall with vector store', async () => {
      const stateStore = new MemoryStore();
      const vectorStore = new InMemoryVectorStore();
      const embedder = new MockEmbedder();
      const mgr = new MemoryManager({ vectorStore, embedder });

      await mgr.remember('pet1', 'I love my cat', stateStore, 'sess-1', { embed: true });
      await mgr.remember('pet2', 'My dog is friendly', stateStore, 'sess-1', { embed: true });
      await mgr.remember('pet3', 'The fish swims', stateStore, 'sess-1', { embed: true });

      // Search for cat-like things
      const results = await mgr.recall('', stateStore, 'sess-1', { query: 'cat', topK: 2 });
      expect(Array.isArray(results)).toBe(true);
      const arr = results as any[];
      expect(arr).toHaveLength(2);
      expect(arr[0].content).toContain('cat');
    });

    it('throws if vectorStore without embedder', () => {
      const vectorStore = new InMemoryVectorStore();
      expect(() => new MemoryManager({ vectorStore })).toThrow('embedder is required');
    });

    it('forget removes a session-scoped memory entry', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();

      await mgr.remember('name', 'Alice', stateStore, 'sess-1');
      const before = await mgr.recall('name', stateStore, 'sess-1');
      expect(before).toBe('Alice');

      await mgr.forget('name', stateStore, 'sess-1');
      const after = await mgr.recall('name', stateStore, 'sess-1');
      expect(after).toBeNull();
    });

    it('forget removes a global-scoped memory entry', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();

      await mgr.remember('setting', 'dark', stateStore, undefined, { scope: 'global' });
      const before = await mgr.recall('setting', stateStore, undefined, { scope: 'global' });
      expect(before).toBe('dark');

      await mgr.forget('setting', stateStore, undefined, { scope: 'global' });
      const after = await mgr.recall('setting', stateStore, undefined, { scope: 'global' });
      expect(after).toBeNull();
    });

    it('forget also removes vector embedding', async () => {
      const stateStore = new MemoryStore();
      const vectorStore = new InMemoryVectorStore();
      const embedder = new MockEmbedder();
      const mgr = new MemoryManager({ vectorStore, embedder });

      await mgr.remember('pet', 'I love my cat', stateStore, 'sess-1', { embed: true });
      // Vector store should have the entry
      let searchResults = await vectorStore.search([1, 0, 0], 5);
      expect(searchResults.length).toBeGreaterThan(0);

      await mgr.forget('pet', stateStore, 'sess-1');
      // Vector store entry should be removed
      searchResults = await vectorStore.search([1, 0, 0], 5);
      expect(searchResults).toHaveLength(0);
    });

    it('session-scoped remember throws without sessionId', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();

      await expect(mgr.remember('key', 'val', stateStore, undefined)).rejects.toThrow(
        'sessionId is required for session-scoped memory',
      );
    });

    it('session-scoped recall throws without sessionId', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();

      await expect(mgr.recall('key', stateStore, undefined)).rejects.toThrow(
        'sessionId is required for session-scoped memory',
      );
    });

    it('session-scoped forget throws without sessionId', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();

      await expect(mgr.forget('key', stateStore, undefined)).rejects.toThrow(
        'sessionId is required for session-scoped memory',
      );
    });
  });

  describe('StateStore dedicated memory methods (MemoryStore)', () => {
    it('saveMemory and getMemory round-trip', async () => {
      const store = new MemoryStore();
      await store.saveMemory('session:s1', 'name', 'Alice');
      const result = await store.getMemory('session:s1', 'name');
      expect(result).toBe('Alice');
    });

    it('getMemory returns null for missing key', async () => {
      const store = new MemoryStore();
      const result = await store.getMemory('session:s1', 'nonexistent');
      expect(result).toBeNull();
    });

    it('getAllMemory returns all entries for scope', async () => {
      const store = new MemoryStore();
      await store.saveMemory('global', 'a', 1);
      await store.saveMemory('global', 'b', 2);
      await store.saveMemory('other', 'c', 3);

      const entries = await store.getAllMemory('global');
      expect(entries).toHaveLength(2);
      expect(entries).toEqual(
        expect.arrayContaining([
          { key: 'a', value: 1 },
          { key: 'b', value: 2 },
        ]),
      );
    });

    it('getAllMemory returns empty array for unknown scope', async () => {
      const store = new MemoryStore();
      const entries = await store.getAllMemory('nonexistent');
      expect(entries).toEqual([]);
    });

    it('deleteMemory removes an entry', async () => {
      const store = new MemoryStore();
      await store.saveMemory('session:s1', 'name', 'Alice');
      await store.deleteMemory('session:s1', 'name');
      const result = await store.getMemory('session:s1', 'name');
      expect(result).toBeNull();
    });

    it('saveMemory overwrites existing value', async () => {
      const store = new MemoryStore();
      await store.saveMemory('global', 'key', 'old');
      await store.saveMemory('global', 'key', 'new');
      const result = await store.getMemory('global', 'key');
      expect(result).toBe('new');
    });
  });

  describe('ctx.remember and ctx.recall', () => {
    it('round-trip through WorkflowContext', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
        stateStore,
        memoryManager: mgr,
        metadata: { sessionId: 'test-session' },
      });

      await ctx.remember('key1', 'value1');
      const result = await ctx.recall('key1');
      expect(result).toBe('value1');
    });

    it('global scope works across sessions', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();

      const ctx1 = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
        stateStore,
        memoryManager: mgr,
        metadata: { sessionId: 'session-a' },
      });

      const ctx2 = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
        stateStore,
        memoryManager: mgr,
        metadata: { sessionId: 'session-b' },
      });

      await ctx1.remember('shared', 'hello', { scope: 'global' });
      const result = await ctx2.recall('shared', { scope: 'global' });
      expect(result).toBe('hello');
    });

    it('ctx.forget removes memory entry', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
        stateStore,
        memoryManager: mgr,
        metadata: { sessionId: 'test-session' },
      });

      await ctx.remember('temp', 'data');
      expect(await ctx.recall('temp')).toBe('data');

      await ctx.forget('temp');
      expect(await ctx.recall('temp')).toBeNull();
    });

    it('ctx.forget throws without memoryManager', async () => {
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
      });

      await expect(ctx.forget('key')).rejects.toThrow('Memory is not configured');
    });

    it('ctx.forget throws without stateStore', async () => {
      const mgr = new MemoryManager();
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
        memoryManager: mgr,
      });

      await expect(ctx.forget('key')).rejects.toThrow('state store is required');
    });

    it('session-scoped memory without sessionId throws from ctx', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
        stateStore,
        memoryManager: mgr,
        // No sessionId in metadata
      });

      await expect(ctx.remember('key', 'value')).rejects.toThrow(
        'sessionId is required for session-scoped memory',
      );
      await expect(ctx.recall('key')).rejects.toThrow(
        'sessionId is required for session-scoped memory',
      );
      await expect(ctx.forget('key')).rejects.toThrow(
        'sessionId is required for session-scoped memory',
      );
    });
  });
});
