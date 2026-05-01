import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import { AxlRuntime } from '../runtime.js';
import { MemoryStore } from '../state/memory.js';
import { MockProvider } from '../../../axl-testing/src/mock-provider.js';
import type { ChatMessage } from '../types.js';
import type { StateStore } from '../state/types.js';

/**
 * Adversarial tests for the per-session-id serializer added to AxlRuntime
 * (`runtime._serializeSession`) and the corresponding lock acquisition in
 * `Session.send()` / `Session.stream()`.
 *
 * The bug being pinned: `send()` and `stream()` previously had a
 * read-modify-write race on `StateStore.saveSession`. Two concurrent calls
 * on the same session id would both read history, both append, and the
 * last writer would clobber the first. The fix adds an in-process Promise
 * chain on the runtime, keyed by session id.
 *
 * Each test uses a real `AxlRuntime` instance (not a mock) so the
 * serializer is exercised end-to-end. Concurrency bugs are intermittent —
 * race scenarios loop many iterations to make hidden orderings surface.
 */

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build a runtime with a one-agent, one-workflow setup that echoes the
 * last user message in the assistant reply (so we can correlate which
 * user prompt produced which assistant reply in serialized history).
 *
 * The MockProvider is fed via `MockProvider.fn(...)` which inspects the
 * messages on each call and returns the last user content prefixed with
 * "reply-to-".
 */
function makeEchoRuntime(stateStore?: StateStore) {
  const provider = MockProvider.fn((messages) => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return { content: `reply-to-${lastUser?.content ?? ''}` };
  });
  const runtime = new AxlRuntime({
    defaultProvider: 'mock',
    ...(stateStore ? { state: { store: stateStore } } : {}),
  });
  runtime.registerProvider('mock', provider);
  const a = agent({ name: 'echo', model: 'mock:test', system: 'echo system' });
  const wf = workflow({
    name: 'chat',
    input: z.string(),
    handler: async (ctx) => ctx.ask(a, ctx.input as string),
  });
  runtime.register(wf);
  return { runtime, provider };
}

/**
 * Build a runtime whose workflow handler delays for `delayMs` before
 * resolving. Useful for asserting cross-id non-blocking and for window
 * tests.
 */
function makeDelayedRuntime(delayMs: number, stateStore?: StateStore) {
  const provider = MockProvider.fn(async (messages) => {
    await new Promise((r) => setTimeout(r, delayMs));
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return { content: `reply-to-${lastUser?.content ?? ''}` };
  });
  const runtime = new AxlRuntime({
    defaultProvider: 'mock',
    ...(stateStore ? { state: { store: stateStore } } : {}),
  });
  runtime.registerProvider('mock', provider);
  const a = agent({ name: 'echo-slow', model: 'mock:test', system: 'echo system' });
  const wf = workflow({
    name: 'chat',
    input: z.string(),
    handler: async (ctx) => ctx.ask(a, ctx.input as string),
  });
  runtime.register(wf);
  return { runtime };
}

/**
 * Build a runtime whose workflow always throws. Pairs are validated by
 * checking the next call on the same id can still proceed.
 */
function makeFailingRuntime(stateStore?: StateStore) {
  const provider = MockProvider.fn(() => ({ content: 'unused' }));
  const runtime = new AxlRuntime({
    defaultProvider: 'mock',
    ...(stateStore ? { state: { store: stateStore } } : {}),
  });
  runtime.registerProvider('mock', provider);
  // Always-throwing workflow — not even the agent gets to run.
  const wf = workflow({
    name: 'fail',
    input: z.string(),
    handler: async () => {
      throw new Error('boom');
    },
  });
  // A separate workflow that succeeds, used to verify lock release.
  const okWf = workflow({
    name: 'ok',
    input: z.string(),
    handler: async () => 'ok-result',
  });
  runtime.register(wf);
  runtime.register(okWf);
  return { runtime };
}

/** Validates that a session history alternates user/assistant strictly,
 *  with the user content matching some permutation of `userInputs` and
 *  each assistant reply being the `reply-to-<user>` for the immediately
 *  preceding user message. Returns the order the user inputs landed in. */
function assertCleanInterleave(history: ChatMessage[], userInputs: readonly string[]): string[] {
  expect(history.length).toBe(userInputs.length * 2);
  const observedUsers: string[] = [];
  for (let i = 0; i < userInputs.length; i++) {
    const user = history[i * 2];
    const asst = history[i * 2 + 1];
    expect(user.role).toBe('user');
    expect(asst.role).toBe('assistant');
    expect(asst.content).toBe(`reply-to-${user.content}`);
    observedUsers.push(user.content as string);
  }
  // Every input appears exactly once.
  expect([...observedUsers].sort()).toEqual([...userInputs].sort());
  return observedUsers;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Session concurrency — per-session serializer', () => {
  // ────────────────────────────────────────────────────────────────────
  // 1. Sequenced send: parallel send() produces ordered history
  // ────────────────────────────────────────────────────────────────────
  describe('parallel send()', () => {
    it('produces clean alternating user/assistant history (50 iterations)', async () => {
      for (let iter = 0; iter < 50; iter++) {
        const { runtime } = makeEchoRuntime();
        const session = runtime.session(`sess-${iter}`);

        const [resA, resB] = await Promise.all([
          session.send('chat', `A-${iter}`),
          session.send('chat', `B-${iter}`),
        ]);

        // Both results are correct echoes of their inputs.
        expect(resA).toBe(`reply-to-A-${iter}`);
        expect(resB).toBe(`reply-to-B-${iter}`);

        const history = await session.history();
        assertCleanInterleave(history, [`A-${iter}`, `B-${iter}`]);

        await runtime.shutdown();
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 2. Sequenced stream: parallel stream() produces ordered history
  // ────────────────────────────────────────────────────────────────────
  describe('parallel stream()', () => {
    it('produces clean alternating user/assistant history (50 iterations)', async () => {
      for (let iter = 0; iter < 50; iter++) {
        const { runtime } = makeEchoRuntime();
        const session = runtime.session(`sess-stream-${iter}`);

        const [streamA, streamB] = await Promise.all([
          session.stream('chat', `A-${iter}`),
          session.stream('chat', `B-${iter}`),
        ]);

        // Drain both streams to completion.
        const drain = async (s: Awaited<ReturnType<typeof session.stream>>) => {
          for await (const ev of s) {
            if (ev.type === 'done' || ev.type === 'error') break;
          }
        };
        await Promise.all([drain(streamA), drain(streamB)]);

        const history = await session.history();
        assertCleanInterleave(history, [`A-${iter}`, `B-${iter}`]);

        await runtime.shutdown();
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 3. Mixed send + stream
  // ────────────────────────────────────────────────────────────────────
  describe('mixed send() + stream()', () => {
    it('serializes correctly so neither sees the other in flight (30 iterations)', async () => {
      for (let iter = 0; iter < 30; iter++) {
        const { runtime } = makeEchoRuntime();
        const session = runtime.session(`sess-mix-${iter}`);

        const sendPromise = session.send('chat', `S-${iter}`);
        const streamPromise = session.stream('chat', `T-${iter}`);

        const [, stream] = await Promise.all([sendPromise, streamPromise]);
        for await (const ev of stream) {
          if (ev.type === 'done' || ev.type === 'error') break;
        }
        // Wait for both to finish so save has landed for both.
        await sendPromise;

        const history = await session.history();
        assertCleanInterleave(history, [`S-${iter}`, `T-${iter}`]);

        await runtime.shutdown();
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 4. Two Session instances on the same id share the lock
  // ────────────────────────────────────────────────────────────────────
  it('two Session objects on the same id share the runtime lock (20 iterations)', async () => {
    for (let iter = 0; iter < 20; iter++) {
      const { runtime } = makeEchoRuntime();
      const sess1 = runtime.session('shared-id');
      const sess2 = runtime.session('shared-id');
      expect(sess1).not.toBe(sess2);

      await Promise.all([sess1.send('chat', `via1-${iter}`), sess2.send('chat', `via2-${iter}`)]);

      const history = await runtime['stateStore'].getSession('shared-id');
      assertCleanInterleave(history, [`via1-${iter}`, `via2-${iter}`]);

      await runtime.shutdown();
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // 5. Different session ids do NOT serialize against each other
  // ────────────────────────────────────────────────────────────────────
  it('different session ids run concurrently (both reach in-flight before either finishes)', async () => {
    // Counter-based assertion (not wall-clock) so the test does not flake
    // under CI load. Two sessions on different ids should both enter the
    // workflow handler before either completes — proving the per-id locks
    // don't cross-contaminate.
    let inFlight = 0;
    let maxInFlight = 0;
    const provider = MockProvider.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield long enough for the sibling to enter as well.
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return { content: 'done' };
    });
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const a = agent({ name: 'echo', model: 'mock:test', system: 'sys' });
    runtime.register(
      workflow({
        name: 'chat',
        input: z.string(),
        handler: async (ctx) => ctx.ask(a, ctx.input as string),
      }),
    );

    await Promise.all([
      runtime.session('a').send('chat', 'one'),
      runtime.session('b').send('chat', 'two'),
    ]);

    expect(maxInFlight).toBe(2);
    await runtime.shutdown();
  });

  // ────────────────────────────────────────────────────────────────────
  // 6. Failing send() does not deadlock the chain
  // ────────────────────────────────────────────────────────────────────
  it('a failing send() releases the lock for the next call', async () => {
    const { runtime } = makeFailingRuntime();
    const session = runtime.session('failing-id');

    await expect(session.send('fail', 'first')).rejects.toThrow(/boom/);

    // The next call MUST proceed within a short timeout — if not, the
    // lock chain is wedged.
    const second = await Promise.race([
      session.send('ok', 'second'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('deadlock')), 1000)),
    ]);
    expect(second).toBe('ok-result');

    await runtime.shutdown();
  });

  // ────────────────────────────────────────────────────────────────────
  // 7. Failing stream() does not deadlock
  // ────────────────────────────────────────────────────────────────────
  it('a failing stream() releases the lock for the next call', async () => {
    const { runtime } = makeFailingRuntime();
    const session = runtime.session('failing-stream-id');

    const stream = await session.stream('fail', 'first');
    // Drain — expect an error event (or a thrown async iter) to fire.
    let sawError = false;
    try {
      for await (const ev of stream) {
        if (ev.type === 'error') {
          sawError = true;
          break;
        }
        if (ev.type === 'done') break;
      }
    } catch {
      sawError = true;
    }
    expect(sawError).toBe(true);

    // Next call must proceed. Bound with a timeout to surface deadlock.
    const second = await Promise.race([
      session.send('ok', 'second'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('deadlock')), 1500)),
    ]);
    expect(second).toBe('ok-result');

    await runtime.shutdown();
  });

  // ────────────────────────────────────────────────────────────────────
  // 8. Abandoned stream eventually releases the lock
  // ────────────────────────────────────────────────────────────────────
  it('a stream() whose consumer never iterates still releases the lock', async () => {
    const { runtime } = makeEchoRuntime();
    const session = runtime.session('abandoned-id');

    // Get the stream but never iterate it. The workflow runs anyway and
    // emits `done`, which triggers the save and releases the lock.
    const stream = await session.stream('chat', 'abandoned');
    // Attach a no-op error listener to keep stream-bus errors from crashing
    // the test process if any infrastructure error occurs.
    stream.on('error', () => {});

    // Next call must proceed within a reasonable bound. If this hangs,
    // the lock isn't released for unobserved streams — flag as a bug.
    const result = await Promise.race([
      session.send('chat', 'after-abandoned'),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('lock not released for unobserved stream')), 2500),
      ),
    ]);
    expect(result).toBe('reply-to-after-abandoned');

    // Both messages should have made it into history (the abandoned stream's
    // `done` event triggers `updateHistory`).
    const history = await session.history();
    // First exchange (abandoned stream) + second exchange (send) = 4 entries.
    expect(history.length).toBe(4);
    expect(history[0]).toEqual({ role: 'user', content: 'abandoned' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'reply-to-abandoned' });
    expect(history[2]).toEqual({ role: 'user', content: 'after-abandoned' });
    expect(history[3]).toEqual({ role: 'assistant', content: 'reply-to-after-abandoned' });

    await runtime.shutdown();
  });

  // ────────────────────────────────────────────────────────────────────
  // 9. History save error propagates but does not deadlock
  // ────────────────────────────────────────────────────────────────────
  it('a saveSession failure surfaces via runtime emit and does not deadlock', async () => {
    class ThrowingSaveStore extends MemoryStore {
      throwOnNextSave = false;
      override async saveSession(id: string, history: ChatMessage[]): Promise<void> {
        if (this.throwOnNextSave) {
          this.throwOnNextSave = false;
          throw new Error('disk full');
        }
        await super.saveSession(id, history);
      }
    }

    const store = new ThrowingSaveStore();
    const { runtime } = makeEchoRuntime(store);

    // For send(): the saveSession throw should propagate as a rejection.
    const session = runtime.session('save-fail-send');
    store.throwOnNextSave = true;
    await expect(session.send('chat', 'first')).rejects.toThrow(/disk full/);
    // Next call proceeds.
    const second = await Promise.race([
      session.send('chat', 'second'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('deadlock')), 1500)),
    ]);
    expect(second).toBe('reply-to-second');

    // The failed first turn must NOT be in persisted history (its save threw),
    // and the second turn must be the only thing recorded — pinning the
    // "failed save → no resurrected partial state" contract.
    const persisted = await session.history();
    expect(persisted).toEqual([
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply-to-second' },
    ]);

    // For stream(): the saveSession failure is caught inside the `done`
    // handler and surfaced via `runtime.emit('error', ...)`. The lock is
    // still released so the next call proceeds.
    const errorListener = vi.fn();
    runtime.on('error', errorListener);
    const streamSession = runtime.session('save-fail-stream');
    store.throwOnNextSave = true;
    const stream = await streamSession.stream('chat', 'streamed');
    for await (const ev of stream) {
      if (ev.type === 'done' || ev.type === 'error') break;
    }
    // Give the post-done updateHistory chain a moment to flush.
    await new Promise((r) => setTimeout(r, 50));
    // The runtime should have emitted a session_history_save_failed error.
    expect(errorListener).toHaveBeenCalled();
    const errArgs = errorListener.mock.calls.flat() as Array<{ type?: string }>;
    expect(errArgs.some((arg) => arg && arg.type === 'session_history_save_failed')).toBe(true);

    // And the lock is released for the next call.
    const next = await Promise.race([
      streamSession.send('chat', 'after-fail'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('deadlock')), 1500)),
    ]);
    expect(next).toBe('reply-to-after-fail');

    await runtime.shutdown();
  });

  // ────────────────────────────────────────────────────────────────────
  // 10. Lock cleanup: idle sessions don't leak
  // ────────────────────────────────────────────────────────────────────
  it('sessionLocks map drops the entry after settle', async () => {
    const { runtime } = makeEchoRuntime();
    const session = runtime.session('cleanup-id');
    await session.send('chat', 'hello');
    // Allow the .finally cleanup tick to run.
    await new Promise((r) => setTimeout(r, 20));
    const locks = (runtime as unknown as { sessionLocks: Map<string, unknown> }).sessionLocks;
    expect(locks.has('cleanup-id')).toBe(false);

    await runtime.shutdown();
  });

  // ────────────────────────────────────────────────────────────────────
  // 11. session.end() during in-flight send — must serialize cleanly
  // ────────────────────────────────────────────────────────────────────
  it('session.end() during in-flight send waits for the send and then deletes', async () => {
    // end() routes through _serializeSession, so it queues behind any
    // in-flight send/stream and the resulting delete is the final state —
    // no "resurrected session" from a save landing after the delete.
    const { runtime } = makeDelayedRuntime(80);
    const session = runtime.session('end-mid-flight');

    const sendPromise = session.send('chat', 'in-flight');
    await new Promise((r) => setTimeout(r, 10));
    await session.end();
    const result = await sendPromise;
    expect(result).toBe('reply-to-in-flight');

    // After end(), the session should be empty regardless of the
    // in-flight send having saved first.
    const after = await runtime['stateStore'].getSession('end-mid-flight');
    expect(after).toEqual([]);

    // Further sends fail fast (closed is set on this Session instance).
    await expect(session.send('chat', 'after-end')).rejects.toThrow(/ended/);

    await runtime.shutdown();
  });

  // ────────────────────────────────────────────────────────────────────
  // 12. session.fork() during in-flight send — captures committed history
  // ────────────────────────────────────────────────────────────────────
  it('session.fork() during in-flight send waits for the send and forks the committed history', async () => {
    // fork() routes through _serializeSession on the source id, so the
    // history it reads reflects the in-flight send's commit, not a torn
    // pre-save snapshot.
    const { runtime } = makeDelayedRuntime(80);
    const session = runtime.session('fork-mid-flight');

    const sendPromise = session.send('chat', 'concurrent');
    await new Promise((r) => setTimeout(r, 10));
    const forked = await session.fork('forked-mid-flight');
    await sendPromise;

    const sourceHistory = await session.history();
    const forkedHistory = await forked.history();

    // Source committed [user, assistant].
    expect(sourceHistory.length).toBe(2);
    // Fork captures the same committed history.
    expect(forkedHistory.length).toBe(2);
    expect(forkedHistory).toEqual(sourceHistory);

    await runtime.shutdown();
  });

  // ────────────────────────────────────────────────────────────────────
  // 13. Adversarial: forced interleaving via a delayed store
  // ────────────────────────────────────────────────────────────────────
  it('serializes 20 concurrent sends even when getSession/saveSession have random delays', async () => {
    // Without the fix, randomized I/O delay would let some sends read a
    // stale snapshot and clobber siblings on save. With the fix, every
    // send queues behind the prior settle, so all 20 messages must land.
    class DelayingMemoryStore extends MemoryStore {
      override async getSession(id: string): Promise<ChatMessage[]> {
        await new Promise((r) => setTimeout(r, Math.random() * 8));
        return super.getSession(id);
      }
      override async saveSession(id: string, h: ChatMessage[]): Promise<void> {
        await new Promise((r) => setTimeout(r, Math.random() * 8));
        return super.saveSession(id, h);
      }
    }

    const store = new DelayingMemoryStore();
    const { runtime } = makeEchoRuntime(store);
    const session = runtime.session('forced-interleave');

    const inputs = Array.from({ length: 20 }, (_, i) => `msg-${i}`);
    await Promise.all(inputs.map((m) => session.send('chat', m)));

    const history = await session.history();
    expect(history.length).toBe(40); // 20 user + 20 assistant
    // Every message in `inputs` shows up exactly once.
    const observedUsers = history.filter((m) => m.role === 'user').map((m) => m.content);
    expect([...observedUsers].sort()).toEqual([...inputs].sort());
    // Every assistant reply correctly matches its preceding user.
    for (let i = 0; i < 20; i++) {
      expect(history[i * 2].role).toBe('user');
      expect(history[i * 2 + 1].role).toBe('assistant');
      expect(history[i * 2 + 1].content).toBe(`reply-to-${history[i * 2].content}`);
    }

    await runtime.shutdown();
  });

  // ────────────────────────────────────────────────────────────────────
  // 14. shutdown() drains in-flight session work before closing the store
  // ────────────────────────────────────────────────────────────────────
  it('shutdown() awaits in-flight session locks before closing the state store', async () => {
    let saveSessionCalledAfterClose = false;
    let storeClosed = false;
    class TrackingStore extends MemoryStore {
      override async close(): Promise<void> {
        storeClosed = true;
      }
      override async saveSession(id: string, h: ChatMessage[]): Promise<void> {
        if (storeClosed) saveSessionCalledAfterClose = true;
        await super.saveSession(id, h);
      }
    }
    const store = new TrackingStore();
    const { runtime } = makeDelayedRuntime(60, store);
    const session = runtime.session('shutdown-race');

    // Fire send and shut down before it can save.
    const sendPromise = session.send('chat', 'in-flight');
    await new Promise((r) => setTimeout(r, 10));
    await runtime.shutdown();
    // The send must have finished before shutdown returned.
    await sendPromise;

    expect(storeClosed).toBe(true);
    expect(saveSessionCalledAfterClose).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────
  // 15. _serializeSession primitive: synchronous throw in fn does not wedge the chain
  // ────────────────────────────────────────────────────────────────────
  it('_serializeSession recovers from a synchronous throw in fn', async () => {
    const { runtime } = makeEchoRuntime();
    // The serializer signature requires a Promise<T> return. A "synchronous
    // throw" in this codebase manifests as an async function that throws
    // before the first await — both should leave the chain in a usable
    // state.
    const failed = runtime._serializeSession('id', async () => {
      throw new Error('sync-ish');
    });
    await expect(failed).rejects.toThrow(/sync-ish/);

    const next = await Promise.race([
      runtime._serializeSession('id', async () => 'recovered'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('deadlock')), 1000)),
    ]);
    expect(next).toBe('recovered');

    await runtime.shutdown();
  });

  // ────────────────────────────────────────────────────────────────────
  // 16. Lock map does not accumulate under churn of distinct ids
  // ────────────────────────────────────────────────────────────────────
  it('sessionLocks map drops every entry after churn of 200 distinct ids', async () => {
    const { runtime } = makeEchoRuntime();
    const ids = Array.from({ length: 200 }, (_, i) => `churn-${i}`);
    await Promise.all(ids.map((id) => runtime.session(id).send('chat', 'x')));
    // Allow the .finally cleanup tick to drain.
    await new Promise((r) => setTimeout(r, 50));
    const locks = (runtime as unknown as { sessionLocks: Map<string, unknown> }).sessionLocks;
    expect(locks.size).toBe(0);
    await runtime.shutdown();
  });
});
