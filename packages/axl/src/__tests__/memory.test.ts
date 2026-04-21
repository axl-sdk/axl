import { describe, it, expect } from 'vitest';
import { MemoryManager } from '../memory/manager.js';
import { InMemoryVectorStore } from '../memory/vector-memory.js';
import { SqliteVectorStore } from '../memory/vector-sqlite.js';
import { MemoryStore } from '../state/memory.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { AxlRuntime } from '../runtime.js';
import { randomUUID } from 'node:crypto';
import type { Embedder, EmbedResult } from '../memory/types.js';
import type { AxlEvent } from '../types.js';

/** Memory-event shape with typed `data`, for use with `.find` narrowing. */
type MemoryEvent = Extract<
  AxlEvent,
  { type: 'memory_remember' | 'memory_recall' | 'memory_forget' }
>;

/**
 * Mock embedder that returns predictable vectors plus optional usage
 * reporting so we can exercise the cost-attribution path without a
 * real pricing table or network call.
 */
class MockEmbedder implements Embedder {
  readonly dimensions = 3;
  /** Number of times `embed()` has been called (counts calls, not texts). */
  callCount = 0;
  /** When set, each embed() call reports this usage. */
  reportUsage?: { cost?: number; tokens?: number; model?: string };
  /** When set, `embed()` throws with this error on every call. */
  throwError?: Error;

  async embed(texts: string[]): Promise<EmbedResult> {
    this.callCount++;
    if (this.throwError) throw this.throwError;
    const vectors = texts.map((text) => {
      // Simple deterministic embedding based on text content
      if (text.includes('cat')) return [1, 0, 0];
      if (text.includes('dog')) return [0.9, 0.1, 0];
      if (text.includes('fish')) return [0, 0, 1];
      return [0.5, 0.5, 0];
    });
    return this.reportUsage ? { vectors, usage: this.reportUsage } : { vectors };
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
      const { data } = await mgr.recall('name', stateStore, 'sess-1');
      expect(data).toBe('Alice');
    });

    it('remember and recall key-value (global scope)', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();

      await mgr.remember('setting', 'dark', stateStore, 'sess-1', { scope: 'global' });
      // Can recall from different session
      const { data } = await mgr.recall('setting', stateStore, 'sess-2', { scope: 'global' });
      expect(data).toBe('dark');
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
      const { data } = await mgr.recall('', stateStore, 'sess-1', { query: 'cat', topK: 2 });
      expect(Array.isArray(data)).toBe(true);
      const arr = data as any[];
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
      expect(before.data).toBe('Alice');

      await mgr.forget('name', stateStore, 'sess-1');
      const after = await mgr.recall('name', stateStore, 'sess-1');
      expect(after.data).toBeNull();
    });

    it('forget removes a global-scoped memory entry', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();

      await mgr.remember('setting', 'dark', stateStore, undefined, { scope: 'global' });
      const before = await mgr.recall('setting', stateStore, undefined, { scope: 'global' });
      expect(before.data).toBe('dark');

      await mgr.forget('setting', stateStore, undefined, { scope: 'global' });
      const after = await mgr.recall('setting', stateStore, undefined, { scope: 'global' });
      expect(after.data).toBeNull();
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

    it('remember propagates embedder usage when embedding happens', async () => {
      const stateStore = new MemoryStore();
      const vectorStore = new InMemoryVectorStore();
      const embedder = new MockEmbedder();
      embedder.reportUsage = { cost: 0.000002, tokens: 5, model: 'mock-embed' };
      const mgr = new MemoryManager({ vectorStore, embedder });

      const result = await mgr.remember('pet', 'I love my cat', stateStore, 'sess-1', {
        embed: true,
      });
      expect(result.usage).toEqual({ cost: 0.000002, tokens: 5, model: 'mock-embed' });
    });

    it('remember without embed does not report usage', async () => {
      const stateStore = new MemoryStore();
      const vectorStore = new InMemoryVectorStore();
      const embedder = new MockEmbedder();
      embedder.reportUsage = { cost: 0.000002, tokens: 5 };
      const mgr = new MemoryManager({ vectorStore, embedder });

      // Not embedding — no embedder call, so no usage.
      const result = await mgr.remember('pet', 'I love my cat', stateStore, 'sess-1');
      expect(result.usage).toBeUndefined();
    });

    it('semantic recall propagates embedder usage', async () => {
      const stateStore = new MemoryStore();
      const vectorStore = new InMemoryVectorStore();
      const embedder = new MockEmbedder();
      embedder.reportUsage = { cost: 0.0000015, tokens: 3, model: 'mock-embed' };
      const mgr = new MemoryManager({ vectorStore, embedder });

      await mgr.remember('pet', 'I love my cat', stateStore, 'sess-1', { embed: true });
      embedder.reportUsage = { cost: 0.0000008, tokens: 2, model: 'mock-embed' };
      const result = await mgr.recall('', stateStore, 'sess-1', { query: 'cat' });
      expect(result.usage).toEqual({ cost: 0.0000008, tokens: 2, model: 'mock-embed' });
    });

    it('key-value recall does not report usage (no embedder call)', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();

      await mgr.remember('name', 'Alice', stateStore, 'sess-1');
      const result = await mgr.recall('name', stateStore, 'sess-1');
      expect(result.usage).toBeUndefined();
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

    it('emits memory_remember / memory_recall / memory_forget trace events with operation metadata only', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();
      const traces: AxlEvent[] = [];
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
        stateStore,
        memoryManager: mgr,
        metadata: { sessionId: 'audit' },
        onTrace: (e) => traces.push(e),
      });

      await ctx.remember('audit_key', { ssn: '123-45-6789' });
      await ctx.recall('audit_key');
      await ctx.recall('missing_key');
      await ctx.forget('audit_key');

      const memoryEvents = traces.filter(
        (t): t is MemoryEvent =>
          t.type === 'memory_remember' || t.type === 'memory_recall' || t.type === 'memory_forget',
      );
      expect(memoryEvents).toHaveLength(4);

      const remember = memoryEvents.find((e) => e.type === 'memory_remember');
      expect(remember).toBeDefined();
      expect(remember!.data.key).toBe('audit_key');
      expect(remember!.data.scope).toBe('session');
      // Critically: the value (which contains PII) is NOT in the trace
      expect('value' in remember!.data).toBe(false);

      const recallHit = memoryEvents.find(
        (e) => e.type === 'memory_recall' && e.data.key === 'audit_key',
      );
      expect(recallHit).toBeDefined();
      expect(recallHit!.data.hit).toBe(true);

      const recallMiss = memoryEvents.find(
        (e) => e.type === 'memory_recall' && e.data.key === 'missing_key',
      );
      expect(recallMiss).toBeDefined();
      expect(recallMiss!.data.hit).toBe(false);

      const forget = memoryEvents.find((e) => e.type === 'memory_forget');
      expect(forget).toBeDefined();
      expect(forget!.data.key).toBe('audit_key');
    });

    it('emits memory_remember audit event with error field on failure (compliance)', async () => {
      // Mock store that rejects writes — simulates a Redis outage or permission denial.
      const failingStore: MemoryStore = new MemoryStore();
      const origSaveMemory = failingStore.saveMemory;
      failingStore.saveMemory = async () => {
        throw new Error('store unavailable');
      };
      const mgr = new MemoryManager();
      const traces: AxlEvent[] = [];
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
        stateStore: failingStore,
        memoryManager: mgr,
        metadata: { sessionId: 'audit' },
        onTrace: (e) => traces.push(e),
      });

      await expect(ctx.remember('audit_key', { foo: 'bar' })).rejects.toThrow('store unavailable');

      // The audit trail MUST record the attempted write even though it failed
      // — that's the whole point of a compliance audit log. Before the fix
      // this event was only emitted on success, leaving failed writes invisible.
      const rememberEvent = traces.find((t): t is MemoryEvent => t.type === 'memory_remember');
      expect(rememberEvent).toBeDefined();
      expect(rememberEvent!.data.key).toBe('audit_key');
      expect(rememberEvent!.data.error).toBe('store unavailable');

      // Restore for other tests in the suite
      failingStore.saveMemory = origSaveMemory;
    });

    it('preserves numeric usage fields under redaction (one-level walk)', async () => {
      // Under `trace.redact`, the log event should keep `usage.tokens` and
      // `usage.cost` visible (numeric observability, non-PII) while
      // scrubbing `usage.model` (could carry tenant info). Top-level
      // `event.cost` is also preserved — it's load-bearing for the
      // trackExecution cost rail.
      const stateStore = new MemoryStore();
      const vectorStore = new InMemoryVectorStore();
      const embedder = new MockEmbedder();
      embedder.reportUsage = {
        cost: 0.000007,
        tokens: 12,
        model: 'text-embedding-3-small',
      };
      const mgr = new MemoryManager({ vectorStore, embedder });
      const traces: AxlEvent[] = [];
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: { trace: { redact: true } },
        providerRegistry: new ProviderRegistry(),
        stateStore,
        memoryManager: mgr,
        metadata: { sessionId: 'compliance' },
        onTrace: (e) => traces.push(e),
      });

      await ctx.remember('pet', 'I love my cat', { embed: true });

      const remember = traces.find((t): t is MemoryEvent => t.type === 'memory_remember');
      expect(remember).toBeDefined();
      // Top-level cost preserved (non-PII, load-bearing for trackExecution)
      expect(remember!.cost).toBe(0.000007);
      // data.usage is an object now; numeric fields inside preserved
      const usage = remember!.data.usage!;
      expect(usage.tokens).toBe(12);
      expect(usage.cost).toBe(0.000007);
      // Model name scrubbed (could carry tenant ID)
      expect(usage.model).toBe('[redacted]');
      // Top-level key still redacted (conservative policy for strings)
      expect(remember!.data.key).toBe('[redacted]');
    });

    it('preserves embedder cost when vectorStore.upsert fails after successful embed', async () => {
      // The user has been billed for the API call even though the memory
      // write ultimately failed — we must NOT lose cost attribution, or
      // their reported spend diverges from their real provider bill.
      const stateStore = new MemoryStore();
      // Custom vector store that succeeds on the first couple of ops but
      // fails on upsert so we can exercise the partial-failure path.
      const failingVectorStore: InMemoryVectorStore = new InMemoryVectorStore();
      let allowUpsert = true;
      const origUpsert = failingVectorStore.upsert.bind(failingVectorStore);
      failingVectorStore.upsert = async (entries) => {
        if (!allowUpsert) throw new Error('vectorStore write failed');
        return origUpsert(entries);
      };
      const embedder = new MockEmbedder();
      embedder.reportUsage = { cost: 0.000009, tokens: 18, model: 'mock-embed' };
      const mgr = new MemoryManager({ vectorStore: failingVectorStore, embedder });
      const traces: AxlEvent[] = [];
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
        stateStore,
        memoryManager: mgr,
        metadata: { sessionId: 'partial-session' },
        onTrace: (e) => traces.push(e),
      });

      allowUpsert = false;
      await expect(ctx.remember('pet', 'cat', { embed: true })).rejects.toThrow(
        'vectorStore write failed',
      );

      const errorEvent = traces.find(
        (t): t is MemoryEvent => t.type === 'memory_remember' && t.data.error !== undefined,
      );
      expect(errorEvent).toBeDefined();
      // CRITICAL: cost attribution must survive the partial failure.
      expect(errorEvent!.cost).toBe(0.000009);
      expect(errorEvent!.data.usage).toEqual({
        cost: 0.000009,
        tokens: 18,
        model: 'mock-embed',
      });
      expect(errorEvent!.data.error).toBe('vectorStore write failed');
    });

    it('emits memory_remember audit event without cost on embedder failure', async () => {
      // When the embedder throws mid-operation, the error-path trace must
      // NOT carry a stale usage/cost from a prior call or fabricated data.
      const stateStore = new MemoryStore();
      const vectorStore = new InMemoryVectorStore();
      const embedder = new MockEmbedder();
      embedder.reportUsage = { cost: 0.0001, tokens: 20, model: 'mock' };
      embedder.throwError = new Error('embedder network failure');
      const mgr = new MemoryManager({ vectorStore, embedder });
      const traces: AxlEvent[] = [];
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
        stateStore,
        memoryManager: mgr,
        metadata: { sessionId: 'err-session' },
        onTrace: (e) => traces.push(e),
      });

      await expect(ctx.remember('pet', 'cat', { embed: true })).rejects.toThrow(
        'embedder network failure',
      );

      const errorEvent = traces.find(
        (t): t is MemoryEvent => t.type === 'memory_remember' && t.data.error !== undefined,
      );
      expect(errorEvent).toBeDefined();
      // Critically: cost must NOT be attributed for a failed embed call.
      // The embedder threw — no tokens consumed, no money spent.
      expect(errorEvent!.cost).toBeUndefined();
      // Error message is recorded for audit purposes.
      expect(errorEvent!.data.error).toBe('embedder network failure');
    });

    it('redacts memory key when config.trace.redact is on', async () => {
      const stateStore = new MemoryStore();
      const mgr = new MemoryManager();
      const traces: AxlEvent[] = [];
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: { trace: { redact: true } },
        providerRegistry: new ProviderRegistry(),
        stateStore,
        memoryManager: mgr,
        metadata: { sessionId: 'compliance' },
        onTrace: (e) => traces.push(e),
      });

      await ctx.remember('user:john@acme.com', { foo: 'bar' });

      const remember = traces.find((t): t is MemoryEvent => t.type === 'memory_remember');
      expect(remember).toBeDefined();
      // Type discriminator preserved at the top level (not scrubbed)
      expect(remember!.type).toBe('memory_remember');
      // Key (potentially PII) scrubbed
      expect(remember!.data.key).toBe('[redacted]');
      // Scope is a string too, so it's redacted under the conservative policy
      expect(remember!.data.scope).toBe('[redacted]');
      // Booleans still visible
      expect(remember!.data.embed).toBe(false);
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

    it('surfaces embedder cost as top-level cost on memory_remember/recall log events', async () => {
      const stateStore = new MemoryStore();
      const vectorStore = new InMemoryVectorStore();
      const embedder = new MockEmbedder();
      embedder.reportUsage = { cost: 0.000005, tokens: 10, model: 'mock-embed' };
      const mgr = new MemoryManager({ vectorStore, embedder });

      const traces: AxlEvent[] = [];
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
        stateStore,
        memoryManager: mgr,
        metadata: { sessionId: 'cost-session' },
        onTrace: (e) => traces.push(e),
      });

      await ctx.remember('pet1', 'I love my cat', { embed: true });
      await ctx.recall('any-key', { query: 'cat' });

      const rememberEvent = traces.find((t): t is MemoryEvent => t.type === 'memory_remember');
      expect(rememberEvent).toBeDefined();
      // Top-level cost is what trackExecution's listener aggregates.
      expect(rememberEvent!.cost).toBe(0.000005);
      // usage is also nested into data for trace-explorer visibility.
      expect(rememberEvent!.data.usage).toEqual({
        cost: 0.000005,
        tokens: 10,
        model: 'mock-embed',
      });

      const recallEvent = traces.find((t): t is MemoryEvent => t.type === 'memory_recall');
      expect(recallEvent).toBeDefined();
      expect(recallEvent!.cost).toBe(0.000005);
    });

    it('embedder cost accumulates into ctx.budget() totalCost', async () => {
      // Memory ops must feed into the same budgetContext as agent_call —
      // otherwise heavy semantic recall workloads silently breach a
      // hard_stop budget. Regression for Gap C.
      const stateStore = new MemoryStore();
      const vectorStore = new InMemoryVectorStore();
      const embedder = new MockEmbedder();
      embedder.reportUsage = { cost: 0.3, tokens: 10, model: 'mock-embed' };
      const mgr = new MemoryManager({ vectorStore, embedder });
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
        stateStore,
        memoryManager: mgr,
        metadata: { sessionId: 'budget-session' },
      });

      // Spin up a budget of $0.5 with hard_stop policy.
      await ctx.budget({ cost: '$0.5', onExceed: 'hard_stop' }, async () => {
        // First remember spends $0.3, under the limit
        await ctx.remember('a', 'I love cats', { embed: true });
        // Second remember would push totalCost to $0.6, over the limit.
        // After this call, budgetContext.exceeded = true.
        await ctx.remember('b', 'I love dogs', { embed: true });
        // Third op should be rejected because budget was exceeded on the
        // previous call.
        await expect(ctx.remember('c', 'I love fish', { embed: true })).rejects.toThrow(
          /Budget exceeded/,
        );
      });
    });

    it('memory ops throw BudgetExceededError when budget already exceeded', async () => {
      // Covers the top-of-function gate: if budget was exceeded by a
      // prior operation (e.g. ctx.ask), subsequent memory ops must not
      // start. Regression for Gap D.
      const stateStore = new MemoryStore();
      const vectorStore = new InMemoryVectorStore();
      const embedder = new MockEmbedder();
      embedder.reportUsage = { cost: 0.0001, tokens: 2 };
      const mgr = new MemoryManager({ vectorStore, embedder });
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
        stateStore,
        memoryManager: mgr,
        metadata: { sessionId: 'gate-session' },
      });

      await ctx.budget({ cost: '$0.01', onExceed: 'finish_and_stop' }, async () => {
        // Directly flip the budget to exceeded (simulating a prior ctx.ask
        // that already breached it). This is the pre-check path.
        (ctx as unknown as { budgetContext: { exceeded: boolean } }).budgetContext.exceeded = true;
        await expect(ctx.remember('x', 'y', { embed: true })).rejects.toThrow(/Budget exceeded/);
        await expect(ctx.recall('x', { query: 'anything' })).rejects.toThrow(/Budget exceeded/);
      });
    });

    it('embedder cost flows through runtime.trackExecution to totalCost', async () => {
      // End-to-end validation of the architectural choice: embedder
      // cost lands at `event.cost` (top-level), which the trackExecution
      // listener aggregates into `scope.totalCost`. No special-case
      // plumbing — it rides the existing cost-aggregation rail.
      const embedder = new MockEmbedder();
      embedder.reportUsage = { cost: 0.000007, tokens: 14, model: 'mock-embed' };
      const runtime = new AxlRuntime({
        memory: {
          vectorStore: new InMemoryVectorStore(),
          embedder,
        },
      });

      const { cost } = await runtime.trackExecution(async () => {
        const ctx = runtime.createContext({ metadata: { sessionId: 'track-session' } });
        await ctx.remember('pet', 'I love my cat', { embed: true });
        await ctx.recall('any', { query: 'cat' });
      });

      // Two embedder calls: 0.000007 * 2 = 0.000014
      expect(cost).toBeCloseTo(0.000014, 9);
    });

    it('non-semantic recall emits no cost (no embedder call)', async () => {
      const stateStore = new MemoryStore();
      const vectorStore = new InMemoryVectorStore();
      const embedder = new MockEmbedder();
      embedder.reportUsage = { cost: 0.000005, tokens: 10 };
      const mgr = new MemoryManager({ vectorStore, embedder });

      const traces: AxlEvent[] = [];
      const ctx = new WorkflowContext({
        input: 'test',
        executionId: randomUUID(),
        config: {},
        providerRegistry: new ProviderRegistry(),
        stateStore,
        memoryManager: mgr,
        metadata: { sessionId: 'cost-session' },
        onTrace: (e) => traces.push(e),
      });

      // Non-embedding remember + key-value recall — neither should invoke the embedder.
      await ctx.remember('name', 'Alice');
      await ctx.recall('name');

      const memEvents = traces.filter(
        (t): t is MemoryEvent =>
          t.type === 'memory_remember' || t.type === 'memory_recall' || t.type === 'memory_forget',
      );
      // Neither operation hit the embedder, so no cost should be attached.
      for (const ev of memEvents) {
        expect(ev.cost).toBeUndefined();
      }
    });
  });
});
