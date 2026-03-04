import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Session } from '../session.js';
import { MemoryStore } from '../state/memory.js';
import { AxlStream } from '../stream.js';
import type { AxlRuntime } from '../runtime.js';
import type { ChatMessage } from '../types.js';

// ── Mock Runtime ────────────────────────────────────────────────────────

function createMockRuntime(overrides?: Partial<Pick<AxlRuntime, 'execute' | 'stream' | 'emit'>>) {
  return {
    execute: overrides?.execute ?? vi.fn().mockResolvedValue('mock result'),
    stream:
      overrides?.stream ??
      vi.fn(() => {
        const s = new AxlStream();
        // Auto-complete stream after a tick
        queueMicrotask(() => s._done('stream result'));
        return s;
      }),
    emit: overrides?.emit ?? vi.fn(),
  } as unknown as AxlRuntime;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Session', () => {
  let store: MemoryStore;
  let runtime: ReturnType<typeof createMockRuntime>;

  beforeEach(() => {
    store = new MemoryStore();
    runtime = createMockRuntime();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // session.id
  // ═══════════════════════════════════════════════════════════════════════

  describe('id', () => {
    it('returns the session id', () => {
      const session = new Session('sess-123', runtime, store);
      expect(session.id).toBe('sess-123');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // session.send()
  // ═══════════════════════════════════════════════════════════════════════

  describe('send()', () => {
    it('executes workflow with session history and returns result', async () => {
      // Capture the sessionHistory at call time (before it gets mutated)
      let capturedHistory: ChatMessage[] | undefined;
      const executeFn = vi.fn().mockImplementation((_name: string, _input: unknown, opts: any) => {
        capturedHistory = [...opts.metadata.sessionHistory];
        return Promise.resolve('hello back');
      });
      runtime = createMockRuntime({ execute: executeFn });
      const session = new Session('sess-1', runtime, store);

      const result = await session.send('chat', 'hello');

      expect(result).toBe('hello back');
      expect(executeFn).toHaveBeenCalledTimes(1);

      // Verify the workflow name and input
      expect(executeFn.mock.calls[0][0]).toBe('chat');
      expect(executeFn.mock.calls[0][1]).toBe('hello');

      // Verify metadata shape
      const metadata = executeFn.mock.calls[0][2].metadata;
      expect(metadata.sessionId).toBe('sess-1');

      // Verify history at call time only had the user message
      expect(capturedHistory).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('persists user and assistant messages to the store', async () => {
      const executeFn = vi.fn().mockResolvedValue('response-1');
      runtime = createMockRuntime({ execute: executeFn });
      const session = new Session('sess-2', runtime, store);

      await session.send('chat', 'question');

      const history = await store.getSession('sess-2');
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: 'user', content: 'question' });
      expect(history[1]).toEqual({ role: 'assistant', content: 'response-1' });
    });

    it('accumulates history across multiple send() calls', async () => {
      let callCount = 0;
      const capturedHistories: ChatMessage[][] = [];
      const executeFn = vi.fn().mockImplementation((_name: string, _input: unknown, opts: any) => {
        callCount++;
        // Capture the history snapshot at call time
        capturedHistories.push([...opts.metadata.sessionHistory]);
        return Promise.resolve(`response-${callCount}`);
      });
      runtime = createMockRuntime({ execute: executeFn });
      const session = new Session('sess-3', runtime, store);

      await session.send('chat', 'first');
      await session.send('chat', 'second');

      const history = await store.getSession('sess-3');
      expect(history).toHaveLength(4);
      expect(history[0]).toEqual({ role: 'user', content: 'first' });
      expect(history[1]).toEqual({ role: 'assistant', content: 'response-1' });
      expect(history[2]).toEqual({ role: 'user', content: 'second' });
      expect(history[3]).toEqual({ role: 'assistant', content: 'response-2' });

      // Second call should have included full history at call time:
      // 2 from first exchange + 1 new user message = 3
      expect(capturedHistories[1]).toHaveLength(3);
      expect(capturedHistories[1][0]).toEqual({ role: 'user', content: 'first' });
      expect(capturedHistories[1][1]).toEqual({ role: 'assistant', content: 'response-1' });
      expect(capturedHistories[1][2]).toEqual({ role: 'user', content: 'second' });
    });

    it('serializes non-string input as JSON for user message', async () => {
      const executeFn = vi.fn().mockResolvedValue('ok');
      runtime = createMockRuntime({ execute: executeFn });
      const session = new Session('sess-4', runtime, store);

      await session.send('chat', { action: 'greet', name: 'Alice' });

      const history = await store.getSession('sess-4');
      expect(history[0].content).toBe('{"action":"greet","name":"Alice"}');
    });

    it('serializes non-string result as JSON for assistant message', async () => {
      const executeFn = vi.fn().mockResolvedValue({ status: 'ok', count: 42 });
      runtime = createMockRuntime({ execute: executeFn });
      const session = new Session('sess-5', runtime, store);

      await session.send('chat', 'query');

      const history = await store.getSession('sess-5');
      expect(history[1].content).toBe('{"status":"ok","count":42}');
    });

    it('passes cached summaryCache from session metadata', async () => {
      let capturedMetadata: Record<string, unknown> | undefined;
      let capturedHistory: ChatMessage[] | undefined;
      const executeFn = vi.fn().mockImplementation((_name: string, _input: unknown, opts: any) => {
        capturedMetadata = { ...opts.metadata };
        capturedHistory = [...opts.metadata.sessionHistory];
        return Promise.resolve('result');
      });
      runtime = createMockRuntime({ execute: executeFn });

      // Pre-populate session metadata with a summaryCache
      await store.saveSessionMeta(
        'sess-sc',
        'summaryCache',
        'This is a summary of prior conversation',
      );

      const session = new Session('sess-sc', runtime, store);
      await session.send('chat', 'hello');

      expect(capturedMetadata!.sessionId).toBe('sess-sc');
      expect(capturedMetadata!.summaryCache).toBe('This is a summary of prior conversation');
      expect(capturedHistory).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('does not include summaryCache in metadata when none exists', async () => {
      const executeFn = vi.fn().mockResolvedValue('result');
      runtime = createMockRuntime({ execute: executeFn });

      const session = new Session('sess-no-sc', runtime, store);
      await session.send('chat', 'hello');

      const metadata = executeFn.mock.calls[0][2].metadata;
      expect(metadata).not.toHaveProperty('summaryCache');
    });

    it('throws when sending on a closed session', async () => {
      const session = new Session('sess-closed', runtime, store);
      await session.end();

      await expect(session.send('chat', 'test')).rejects.toThrow('Session has been ended');
    });

    it('propagates errors from runtime.execute()', async () => {
      const executeFn = vi.fn().mockRejectedValue(new Error('workflow failed'));
      runtime = createMockRuntime({ execute: executeFn });
      const session = new Session('sess-err', runtime, store);

      await expect(session.send('chat', 'test')).rejects.toThrow('workflow failed');
    });

    it('does not persist assistant message if runtime.execute() throws', async () => {
      const executeFn = vi.fn().mockRejectedValue(new Error('boom'));
      runtime = createMockRuntime({ execute: executeFn });
      const session = new Session('sess-no-persist', runtime, store);

      await expect(session.send('chat', 'test')).rejects.toThrow('boom');

      // The user message was pushed to a local array but saveSession was never called
      // so the store should have no history for this session
      const history = await store.getSession('sess-no-persist');
      expect(history).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // session.stream()
  // ═══════════════════════════════════════════════════════════════════════

  describe('stream()', () => {
    it('returns an AxlStream', async () => {
      const session = new Session('sess-s1', runtime, store);
      const stream = await session.stream('chat', 'hello');

      expect(stream).toBeInstanceOf(AxlStream);
    });

    it('calls runtime.stream() with session history', async () => {
      let capturedMetadata: Record<string, unknown> | undefined;
      let capturedHistory: ChatMessage[] | undefined;
      const streamFn = vi.fn((_name: string, _input: unknown, opts: any) => {
        capturedMetadata = { ...opts.metadata };
        capturedHistory = [...opts.metadata.sessionHistory];
        const s = new AxlStream();
        queueMicrotask(() => s._done('streamed'));
        return s;
      });
      runtime = createMockRuntime({ stream: streamFn });
      const session = new Session('sess-s2', runtime, store);

      await session.stream('chat', 'hello');

      expect(streamFn).toHaveBeenCalledTimes(1);
      expect(streamFn.mock.calls[0][0]).toBe('chat');
      expect(streamFn.mock.calls[0][1]).toBe('hello');
      expect(capturedMetadata!.sessionId).toBe('sess-s2');
      expect(capturedHistory).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('updates history in store when the stream emits done', async () => {
      const axlStream = new AxlStream();
      const streamFn = vi.fn(() => axlStream);
      runtime = createMockRuntime({ stream: streamFn });
      const session = new Session('sess-s3', runtime, store);

      await session.stream('chat', 'question');

      // History should not yet include assistant message
      let history = await store.getSession('sess-s3');
      expect(history).toHaveLength(0); // store hasn't been saved yet

      // Emit done event
      axlStream._done('the answer');

      // Wait for the async updateHistory to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      history = await store.getSession('sess-s3');
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: 'user', content: 'question' });
      expect(history[1]).toEqual({ role: 'assistant', content: 'the answer' });
    });

    it('serializes non-string stream result as JSON for assistant message', async () => {
      const axlStream = new AxlStream();
      const streamFn = vi.fn(() => axlStream);
      runtime = createMockRuntime({ stream: streamFn });
      const session = new Session('sess-s4', runtime, store);

      await session.stream('chat', 'question');
      axlStream._done({ answer: 42 });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const history = await store.getSession('sess-s4');
      expect(history[1].content).toBe('{"answer":42}');
    });

    it('throws when streaming on a closed session', async () => {
      const session = new Session('sess-s-closed', runtime, store);
      await session.end();

      await expect(session.stream('chat', 'test')).rejects.toThrow('Session has been ended');
    });

    it('emits error on runtime when history save fails in stream mode', async () => {
      const axlStream = new AxlStream();
      const streamFn = vi.fn(() => axlStream);
      const emitFn = vi.fn();
      runtime = createMockRuntime({ stream: streamFn, emit: emitFn });

      // Create a store that will fail on saveSession
      const failStore = new MemoryStore();
      vi.spyOn(failStore, 'saveSession').mockRejectedValue(new Error('disk full'));

      const session = new Session('sess-err-save', runtime, failStore);
      await session.stream('chat', 'hello');

      // Emit done to trigger the history save
      axlStream._done('result');

      // Wait for the async error to propagate
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(emitFn).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({
          type: 'session_history_save_failed',
          sessionId: 'sess-err-save',
          error: 'disk full',
        }),
      );
    });

    it('accumulates history across send then stream', async () => {
      // First: send()
      const executeFn = vi.fn().mockResolvedValue('send-result');
      const axlStream = new AxlStream();
      const streamFn = vi.fn(() => axlStream);
      runtime = createMockRuntime({ execute: executeFn, stream: streamFn });
      const session = new Session('sess-mix', runtime, store);

      await session.send('chat', 'first');

      // Now stream
      await session.stream('chat', 'second');
      axlStream._done('stream-result');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const history = await store.getSession('sess-mix');
      expect(history).toHaveLength(4);
      expect(history[0]).toEqual({ role: 'user', content: 'first' });
      expect(history[1]).toEqual({ role: 'assistant', content: 'send-result' });
      expect(history[2]).toEqual({ role: 'user', content: 'second' });
      expect(history[3]).toEqual({ role: 'assistant', content: 'stream-result' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // session.history()
  // ═══════════════════════════════════════════════════════════════════════

  describe('history()', () => {
    it('returns empty array for a new session', async () => {
      const session = new Session('sess-h1', runtime, store);
      const history = await session.history();
      expect(history).toEqual([]);
    });

    it('returns current session history from store', async () => {
      const executeFn = vi.fn().mockResolvedValue('answer');
      runtime = createMockRuntime({ execute: executeFn });
      const session = new Session('sess-h2', runtime, store);

      await session.send('chat', 'question');

      const history = await session.history();
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: 'user', content: 'question' });
      expect(history[1]).toEqual({ role: 'assistant', content: 'answer' });
    });

    it('returns a copy of history (not a mutable reference)', async () => {
      const executeFn = vi.fn().mockResolvedValue('answer');
      runtime = createMockRuntime({ execute: executeFn });
      const session = new Session('sess-h3', runtime, store);

      await session.send('chat', 'question');

      const history1 = await session.history();
      const history2 = await session.history();

      // Should be equal but not the same reference (MemoryStore uses structuredClone)
      expect(history1).toEqual(history2);
      expect(history1).not.toBe(history2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // session.end()
  // ═══════════════════════════════════════════════════════════════════════

  describe('end()', () => {
    it('marks session as closed', async () => {
      const session = new Session('sess-end1', runtime, store);
      await session.end();

      await expect(session.send('chat', 'test')).rejects.toThrow('Session has been ended');
    });

    it('deletes session data from the store', async () => {
      const executeFn = vi.fn().mockResolvedValue('answer');
      runtime = createMockRuntime({ execute: executeFn });
      const session = new Session('sess-end2', runtime, store);

      await session.send('chat', 'hello');

      // Verify data exists
      let history = await store.getSession('sess-end2');
      expect(history).toHaveLength(2);

      await session.end();

      // Verify data is deleted
      history = await store.getSession('sess-end2');
      expect(history).toEqual([]);
    });

    it('deletes session metadata from the store', async () => {
      await store.saveSessionMeta('sess-end3', 'summaryCache', 'some summary');
      const session = new Session('sess-end3', runtime, store);

      await session.end();

      const meta = await store.getSessionMeta('sess-end3', 'summaryCache');
      expect(meta).toBeNull();
    });

    it('throws on subsequent send() after end()', async () => {
      const session = new Session('sess-end4', runtime, store);
      await session.end();

      await expect(session.send('chat', 'test')).rejects.toThrow('Session has been ended');
    });

    it('throws on subsequent stream() after end()', async () => {
      const session = new Session('sess-end5', runtime, store);
      await session.end();

      await expect(session.stream('chat', 'test')).rejects.toThrow('Session has been ended');
    });

    it('can be called multiple times without error', async () => {
      const session = new Session('sess-end6', runtime, store);
      await session.end();
      await expect(session.end()).resolves.toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // session.fork()
  // ═══════════════════════════════════════════════════════════════════════

  describe('fork()', () => {
    it('creates a new session with copied history', async () => {
      const executeFn = vi.fn().mockResolvedValue('response');
      runtime = createMockRuntime({ execute: executeFn });
      const session = new Session('sess-fork1', runtime, store);

      await session.send('chat', 'hello');

      const forked = await session.fork('sess-fork1-copy');

      expect(forked).toBeInstanceOf(Session);
      expect(forked.id).toBe('sess-fork1-copy');

      const forkedHistory = await forked.history();
      expect(forkedHistory).toHaveLength(2);
      expect(forkedHistory[0]).toEqual({ role: 'user', content: 'hello' });
      expect(forkedHistory[1]).toEqual({ role: 'assistant', content: 'response' });
    });

    it('forked session has independent history from the original', async () => {
      let callCount = 0;
      const executeFn = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(`response-${callCount}`);
      });
      runtime = createMockRuntime({ execute: executeFn });
      const session = new Session('sess-fork2', runtime, store);

      await session.send('chat', 'original');

      const forked = await session.fork('sess-fork2-copy');

      // Send on the forked session
      await forked.send('chat', 'forked message');

      // Original should still have only 2 messages
      const originalHistory = await session.history();
      expect(originalHistory).toHaveLength(2);

      // Forked should have 4 messages
      const forkedHistory = await forked.history();
      expect(forkedHistory).toHaveLength(4);
      expect(forkedHistory[2]).toEqual({ role: 'user', content: 'forked message' });
    });

    it('copies session metadata (summaryCache) to the forked session', async () => {
      await store.saveSessionMeta('sess-fork3', 'summaryCache', 'cached summary content');
      const session = new Session('sess-fork3', runtime, store);

      await session.fork('sess-fork3-copy');

      const forkedMeta = await store.getSessionMeta('sess-fork3-copy', 'summaryCache');
      expect(forkedMeta).toBe('cached summary content');

      // Verify the forked session's summaryCache is passed to execute via send()
      let capturedMetadata: Record<string, unknown> | undefined;
      let capturedHistory: ChatMessage[] | undefined;
      const executeFn = vi.fn().mockImplementation((_name: string, _input: unknown, opts: any) => {
        capturedMetadata = { ...opts.metadata };
        capturedHistory = [...opts.metadata.sessionHistory];
        return Promise.resolve('result');
      });
      const forkedRuntime = createMockRuntime({ execute: executeFn });
      const forkedSession = new Session('sess-fork3-copy', forkedRuntime, store);

      await forkedSession.send('chat', 'hi');

      expect(capturedMetadata!.sessionId).toBe('sess-fork3-copy');
      expect(capturedMetadata!.summaryCache).toBe('cached summary content');
      expect(capturedHistory).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('does not copy summaryCache if it does not exist on the original', async () => {
      const session = new Session('sess-fork4', runtime, store);
      await session.fork('sess-fork4-copy');

      const forkedMeta = await store.getSessionMeta('sess-fork4-copy', 'summaryCache');
      expect(forkedMeta).toBeNull();
    });

    it('forked session can be independently ended without affecting original', async () => {
      const executeFn = vi.fn().mockResolvedValue('r');
      runtime = createMockRuntime({ execute: executeFn });
      const session = new Session('sess-fork5', runtime, store);

      await session.send('chat', 'msg');

      const forked = await session.fork('sess-fork5-copy');
      await forked.end();

      // Forked session is closed
      await expect(forked.send('chat', 'test')).rejects.toThrow('Session has been ended');

      // Original session is still open
      const result = await session.send('chat', 'another');
      expect(result).toBe('r');
    });

    it('forked session from empty original creates an empty copy', async () => {
      const session = new Session('sess-fork6', runtime, store);
      const forked = await session.fork('sess-fork6-copy');

      const history = await forked.history();
      expect(history).toEqual([]);
    });
  });
});
