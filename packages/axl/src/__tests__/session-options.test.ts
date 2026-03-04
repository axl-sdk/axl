import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Session } from '../session.js';
import { MemoryStore } from '../state/memory.js';
import { AxlStream } from '../stream.js';
import type { AxlRuntime } from '../runtime.js';
import type { ChatMessage } from '../types.js';

// ── Mock Runtime ────────────────────────────────────────────────────────

function createMockRuntime(
  overrides?: Partial<Pick<AxlRuntime, 'execute' | 'stream' | 'emit' | 'summarizeMessages'>>,
) {
  return {
    execute: overrides?.execute ?? vi.fn().mockResolvedValue('mock result'),
    stream:
      overrides?.stream ??
      vi.fn(() => {
        const s = new AxlStream();
        queueMicrotask(() => s._done('stream result'));
        return s;
      }),
    emit: overrides?.emit ?? vi.fn(),
    summarizeMessages: overrides?.summarizeMessages ?? vi.fn().mockResolvedValue('default summary'),
  } as unknown as AxlRuntime;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('SessionOptions', () => {
  let store: MemoryStore;
  let runtime: ReturnType<typeof createMockRuntime>;

  beforeEach(() => {
    store = new MemoryStore();
    runtime = createMockRuntime();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // history.maxMessages
  // ═══════════════════════════════════════════════════════════════════════

  describe('history.maxMessages', () => {
    it('trims history to maxMessages before each send()', async () => {
      let callCount = 0;
      const capturedHistories: ChatMessage[][] = [];
      const executeFn = vi.fn().mockImplementation((_name: string, _input: unknown, opts: any) => {
        callCount++;
        capturedHistories.push([...opts.metadata.sessionHistory]);
        return Promise.resolve(`response-${callCount}`);
      });
      runtime = createMockRuntime({ execute: executeFn });

      // maxMessages: 4 means we keep only the last 4 messages from stored history
      const session = new Session('sess-max', runtime, store, { history: { maxMessages: 4 } });

      // Send 1: history is empty, adds user msg -> [user1] passed to execute
      await session.send('chat', 'msg1');
      // Store now: [user1, assistant1] (2 messages)

      // Send 2: history loaded = [user1, assistant1], <= 4 so no trim, adds user2 -> [user1, assistant1, user2]
      await session.send('chat', 'msg2');
      // Store now: [user1, assistant1, user2, assistant2] (4 messages)

      // Send 3: history loaded = [user1, assistant1, user2, assistant2], <= 4 so no trim, adds user3
      await session.send('chat', 'msg3');
      // Store now: [user1, assistant1, user2, assistant2, user3, assistant3] (6 messages)

      // Send 4: history loaded = 6 messages, > 4 so trim to last 4: [user2, assistant2, user3, assistant3], adds user4
      await session.send('chat', 'msg4');

      // The 4th call should have received a trimmed history + the new user message
      expect(capturedHistories[3]).toHaveLength(5); // 4 trimmed + 1 new user message
      expect(capturedHistories[3][0]).toEqual({ role: 'user', content: 'msg2' });
      expect(capturedHistories[3][1]).toEqual({ role: 'assistant', content: 'response-2' });
      expect(capturedHistories[3][2]).toEqual({ role: 'user', content: 'msg3' });
      expect(capturedHistories[3][3]).toEqual({ role: 'assistant', content: 'response-3' });
      expect(capturedHistories[3][4]).toEqual({ role: 'user', content: 'msg4' });
    });

    it('does not trim when history is within maxMessages limit', async () => {
      const capturedHistories: ChatMessage[][] = [];
      const executeFn = vi.fn().mockImplementation((_name: string, _input: unknown, opts: any) => {
        capturedHistories.push([...opts.metadata.sessionHistory]);
        return Promise.resolve('ok');
      });
      runtime = createMockRuntime({ execute: executeFn });

      const session = new Session('sess-no-trim', runtime, store, { history: { maxMessages: 10 } });

      await session.send('chat', 'msg1');
      await session.send('chat', 'msg2');

      // Second call: stored history has 2 messages (< 10), no trimming
      expect(capturedHistories[1]).toHaveLength(3); // 2 stored + 1 new user message
    });

    it('trims history in stream() mode', async () => {
      // Pre-populate store with 6 messages
      const existingHistory: ChatMessage[] = [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'r2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'r3' },
      ];
      await store.saveSession('sess-stream-trim', existingHistory);

      let capturedHistory: ChatMessage[] | undefined;
      const axlStream = new AxlStream();
      const streamFn = vi.fn((_name: string, _input: unknown, opts: any) => {
        capturedHistory = [...opts.metadata.sessionHistory];
        return axlStream;
      });
      runtime = createMockRuntime({ stream: streamFn });

      const session = new Session('sess-stream-trim', runtime, store, {
        history: { maxMessages: 4 },
      });

      await session.stream('chat', 'msg4');

      // Should have trimmed to last 4 + added new user message = 5
      expect(capturedHistory).toHaveLength(5);
      expect(capturedHistory![0]).toEqual({ role: 'user', content: 'msg2' });
      expect(capturedHistory![1]).toEqual({ role: 'assistant', content: 'r2' });
      expect(capturedHistory![2]).toEqual({ role: 'user', content: 'msg3' });
      expect(capturedHistory![3]).toEqual({ role: 'assistant', content: 'r3' });
      expect(capturedHistory![4]).toEqual({ role: 'user', content: 'msg4' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // persist
  // ═══════════════════════════════════════════════════════════════════════

  describe('persist', () => {
    it('persist: false does not save history on send()', async () => {
      const executeFn = vi.fn().mockResolvedValue('result');
      runtime = createMockRuntime({ execute: executeFn });

      const session = new Session('sess-no-persist', runtime, store, { persist: false });
      await session.send('chat', 'hello');

      const history = await store.getSession('sess-no-persist');
      expect(history).toHaveLength(0);
    });

    it('persist: false does not save history on stream()', async () => {
      const axlStream = new AxlStream();
      const streamFn = vi.fn(() => axlStream);
      runtime = createMockRuntime({ stream: streamFn });

      const session = new Session('sess-no-persist-stream', runtime, store, { persist: false });
      await session.stream('chat', 'hello');

      axlStream._done('stream result');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const history = await store.getSession('sess-no-persist-stream');
      expect(history).toHaveLength(0);
    });

    it('persist: true (explicit) saves history normally', async () => {
      const executeFn = vi.fn().mockResolvedValue('result');
      runtime = createMockRuntime({ execute: executeFn });

      const session = new Session('sess-persist-true', runtime, store, { persist: true });
      await session.send('chat', 'hello');

      const history = await store.getSession('sess-persist-true');
      expect(history).toHaveLength(2);
    });

    it('persist: undefined (default) saves history normally', async () => {
      const executeFn = vi.fn().mockResolvedValue('result');
      runtime = createMockRuntime({ execute: executeFn });

      const session = new Session('sess-persist-default', runtime, store);
      await session.send('chat', 'hello');

      const history = await store.getSession('sess-persist-default');
      expect(history).toHaveLength(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // runtime.session() integration
  // ═══════════════════════════════════════════════════════════════════════

  describe('runtime.session() integration', () => {
    it('Session constructed without options works normally', () => {
      const session = new Session('sess-no-opts', runtime, store);
      expect(session.id).toBe('sess-no-opts');
    });

    it('Session constructed with empty options works normally', async () => {
      const executeFn = vi.fn().mockResolvedValue('result');
      runtime = createMockRuntime({ execute: executeFn });

      const session = new Session('sess-empty-opts', runtime, store, {});
      await session.send('chat', 'hello');

      const history = await store.getSession('sess-empty-opts');
      expect(history).toHaveLength(2);
    });

    it('fork() inherits options from parent session', async () => {
      const executeFn = vi.fn().mockResolvedValue('result');
      runtime = createMockRuntime({ execute: executeFn });

      const session = new Session('sess-fork-opts', runtime, store, { persist: false });
      await session.send('chat', 'hello');

      // persist: false means nothing saved
      let history = await store.getSession('sess-fork-opts');
      expect(history).toHaveLength(0);

      // Manually save so fork has something to copy
      await store.saveSession('sess-fork-opts', [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'result' },
      ]);

      const forked = await session.fork('sess-fork-opts-child');

      // Send on forked session (inherits persist: false)
      await forked.send('chat', 'world');

      // The fork copied existing history, but the new send should not persist
      // because persist: false is inherited
      history = await store.getSession('sess-fork-opts-child');
      // fork() itself calls saveSession directly (not through send), so we check
      // that the forked history from fork() exists (2 messages from the copy),
      // but the new send did not add to it
      expect(history).toHaveLength(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // history.summarize
  // ═══════════════════════════════════════════════════════════════════════

  describe('history.summarize', () => {
    it('summarizes dropped messages when summarize is true', async () => {
      const summarizeFn = vi.fn().mockResolvedValue('Summary of old messages');
      const executeFn = vi.fn().mockResolvedValue('result');
      const mockRuntime = createMockRuntime({
        execute: executeFn,
        summarizeMessages: summarizeFn,
      });

      const session = new Session('sess-summarize', mockRuntime, store, {
        history: { maxMessages: 4, summarize: true, summaryModel: 'mock:summarizer' },
      });

      // Pre-populate with 6 messages to trigger trimming
      await store.saveSession('sess-summarize', [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'r2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'r3' },
      ]);

      await session.send('chat', 'msg4');

      // Should have called summarizeMessages with the dropped messages
      expect(summarizeFn).toHaveBeenCalledTimes(1);
      const [messages, modelUri] = summarizeFn.mock.calls[0];
      expect(modelUri).toBe('mock:summarizer');
      // 2 messages dropped (6 - 4 = 2), no existing summary so no system prefix
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ role: 'user', content: 'msg1' });
      expect(messages[1]).toEqual({ role: 'assistant', content: 'r1' });

      // Should have saved the summary
      const summary = await store.getSessionMeta('sess-summarize', 'summaryCache');
      expect(summary).toBe('Summary of old messages');
    });

    it('includes existing summary as context when re-summarizing', async () => {
      const summarizeFn = vi.fn().mockResolvedValue('Updated summary');
      const executeFn = vi.fn().mockResolvedValue('result');
      const mockRuntime = createMockRuntime({
        execute: executeFn,
        summarizeMessages: summarizeFn,
      });

      // Pre-populate with existing summary
      await store.saveSessionMeta('sess-resummarize', 'summaryCache', 'Old summary');
      await store.saveSession('sess-resummarize', [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'r2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'r3' },
      ]);

      const session = new Session('sess-resummarize', mockRuntime, store, {
        history: { maxMessages: 4, summarize: true, summaryModel: 'mock:summarizer' },
      });

      await session.send('chat', 'msg4');

      // The first message should be the previous summary as context
      const [messages] = summarizeFn.mock.calls[0];
      expect(messages[0]).toEqual({
        role: 'system',
        content: 'Previous conversation summary: Old summary',
      });
      // Then the 2 dropped messages
      expect(messages[1]).toEqual({ role: 'user', content: 'msg1' });
      expect(messages[2]).toEqual({ role: 'assistant', content: 'r1' });
      expect(messages).toHaveLength(3);
    });

    it('throws if summarize is true but summaryModel is missing', async () => {
      const executeFn = vi.fn().mockResolvedValue('result');
      const mockRuntime = createMockRuntime({ execute: executeFn });

      await store.saveSession('sess-no-model', [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'r2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'r3' },
      ]);

      const session = new Session('sess-no-model', mockRuntime, store, {
        history: { maxMessages: 4, summarize: true },
      });

      await expect(session.send('chat', 'msg4')).rejects.toThrow('summaryModel is required');
    });

    it('summarizes in stream() mode', async () => {
      const summarizeFn = vi.fn().mockResolvedValue('Stream summary');
      const axlStream = new AxlStream();
      const streamFn = vi.fn(() => axlStream);
      const mockRuntime = createMockRuntime({
        stream: streamFn,
        summarizeMessages: summarizeFn,
      });

      await store.saveSession('sess-stream-summarize', [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'r2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'r3' },
      ]);

      const session = new Session('sess-stream-summarize', mockRuntime, store, {
        history: { maxMessages: 4, summarize: true, summaryModel: 'mock:summarizer' },
      });

      await session.stream('chat', 'msg4');

      expect(summarizeFn).toHaveBeenCalledTimes(1);
      const summary = await store.getSessionMeta('sess-stream-summarize', 'summaryCache');
      expect(summary).toBe('Stream summary');
    });

    it('throws in stream() if summarize is true but summaryModel is missing', async () => {
      const axlStream = new AxlStream();
      const streamFn = vi.fn(() => axlStream);
      const mockRuntime = createMockRuntime({ stream: streamFn });

      await store.saveSession('sess-stream-no-model', [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'r2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'r3' },
      ]);

      const session = new Session('sess-stream-no-model', mockRuntime, store, {
        history: { maxMessages: 4, summarize: true },
      });

      await expect(session.stream('chat', 'msg4')).rejects.toThrow('summaryModel is required');
    });

    it('passes fresh summary in metadata to execute()', async () => {
      const summarizeFn = vi.fn().mockResolvedValue('Fresh summary');
      let capturedMeta: Record<string, unknown> | undefined;
      const executeFn = vi.fn().mockImplementation((_name: string, _input: unknown, opts: any) => {
        capturedMeta = opts.metadata;
        return Promise.resolve('result');
      });
      const mockRuntime = createMockRuntime({
        execute: executeFn,
        summarizeMessages: summarizeFn,
      });

      await store.saveSession('sess-fresh-summary', [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'r2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'r3' },
      ]);

      const session = new Session('sess-fresh-summary', mockRuntime, store, {
        history: { maxMessages: 4, summarize: true, summaryModel: 'mock:summarizer' },
      });

      await session.send('chat', 'msg4');

      // The metadata passed to execute should contain the NEW summary, not the old one
      expect(capturedMeta?.summaryCache).toBe('Fresh summary');
    });

    it('does not summarize when summarize is false (just trims)', async () => {
      const summarizeFn = vi.fn().mockResolvedValue('Should not be called');
      const executeFn = vi.fn().mockResolvedValue('result');
      const mockRuntime = createMockRuntime({
        execute: executeFn,
        summarizeMessages: summarizeFn,
      });

      await store.saveSession('sess-no-summarize', [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'r2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'r3' },
      ]);

      const session = new Session('sess-no-summarize', mockRuntime, store, {
        history: { maxMessages: 4 },
      });

      await session.send('chat', 'msg4');

      // summarizeMessages should never be called
      expect(summarizeFn).not.toHaveBeenCalled();

      // History should still be trimmed
      const savedHistory = await store.getSession('sess-no-summarize');
      // 4 trimmed + 1 user + 1 assistant = 6
      expect(savedHistory).toHaveLength(6);
    });
  });
});
