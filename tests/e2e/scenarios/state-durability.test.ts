import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AxlRuntime, workflow, type StateStore } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';

/**
 * End-to-end tests for `state.persist: 'streaming'` + crash recovery.
 *
 * Unit tests (`packages/axl/src/__tests__/runtime.test.ts`) cover the
 * `StreamingFlusher` and `recoverIncompleteStreams()` in isolation. This
 * file ties the three layers together: a runtime running streaming-mode
 * workflows, a simulated crash (no `shutdown()` — the buffer survives),
 * then a fresh runtime against the same shared store reconstructs the
 * partial executions.
 *
 * Uses two runtimes against a shared in-process `StateStore` instance to
 * simulate the process-restart boundary without actually crashing Node.
 * Same shape as a real Redis-backed deployment where Pod B reads from the
 * same Redis Pod A wrote to.
 */
describe('State Durability E2E: streaming-mode crash recovery', () => {
  /**
   * A minimal in-memory StateStore that two runtimes can share by
   * reference. Matches the shape of how `RedisStore` would behave across
   * processes — same store object, different runtime instances.
   * Implements only the methods the streaming path actually exercises.
   */
  function createSharedStore(): StateStore {
    const executionHistory = new Map();
    const checkpoints = new Map();
    const executionStates = new Map();
    const streamingEvents = new Map<string, unknown[]>();
    const sessions = new Map();
    const sessionMeta = new Map();
    const decisions = new Map();
    const evalHistory = new Map();

    return {
      saveCheckpoint: async (id, name, data) => {
        let m = checkpoints.get(id);
        if (!m) {
          m = new Map();
          checkpoints.set(id, m);
        }
        m.set(name, data);
      },
      getCheckpoint: async (id, name) => checkpoints.get(id)?.get(name) ?? null,
      saveSession: async (id, history) => {
        sessions.set(id, history);
      },
      getSession: async (id) => sessions.get(id) ?? [],
      deleteSession: async (id) => {
        sessions.delete(id);
      },
      saveSessionMeta: async (id, key, value) => {
        let m = sessionMeta.get(id);
        if (!m) {
          m = new Map();
          sessionMeta.set(id, m);
        }
        m.set(key, value);
      },
      getSessionMeta: async (id, key) => sessionMeta.get(id)?.get(key) ?? null,
      savePendingDecision: async (id, d) => {
        decisions.set(id, d);
      },
      getPendingDecisions: async () => Array.from(decisions.values()),
      resolveDecision: async (id) => {
        decisions.delete(id);
      },
      saveExecutionState: async (id, state) => {
        executionStates.set(id, state);
      },
      getExecutionState: async (id) => executionStates.get(id) ?? null,
      listPendingExecutions: async () => Array.from(executionStates.keys()),
      saveMemory: async () => {},
      getMemory: async () => null,
      getAllMemory: async () => [],
      deleteMemory: async () => {},
      saveExecution: async (exec) => {
        executionHistory.set(exec.executionId, exec);
      },
      getExecution: async (id) => executionHistory.get(id) ?? null,
      listExecutions: async () => Array.from(executionHistory.values()),
      deleteExecution: async (id) => {
        const had = executionHistory.delete(id);
        checkpoints.delete(id);
        executionStates.delete(id);
        streamingEvents.delete(id);
        decisions.delete(id);
        return had;
      },
      saveEvalResult: async (e) => {
        evalHistory.set(e.id, e);
      },
      listEvalResults: async () => Array.from(evalHistory.values()),
      deleteEvalResult: async (id) => evalHistory.delete(id),
      appendStreamingEvents: async (id, events) => {
        const existing = streamingEvents.get(id) ?? [];
        existing.push(...events);
        streamingEvents.set(id, existing);
      },
      finalizeStreamingEvents: async (id) => {
        streamingEvents.delete(id);
      },
      listStreamingExecutions: async () => Array.from(streamingEvents.keys()),
      getStreamingEvents: async (id) => (streamingEvents.get(id) ?? []) as never,
      listSessions: async () => Array.from(sessions.keys()),
    };
  }

  it('recovers a crashed workflow as a failed ExecutionInfo with surviving events', async () => {
    const store = createSharedStore();

    // Process A: kick off a workflow, emit some events, then "crash"
    // (don't call shutdown — the streaming buffer stays in the store).
    const runtimeA = new AxlRuntime({
      state: { store, persist: 'streaming', streamingBatchSize: 1 },
    });
    runtimeA.registerProvider('test', MockProvider.sequence([{ content: 'ok' }]) as never);

    let release: (() => void) | undefined;
    const block = new Promise<void>((res) => {
      release = res;
    });
    const wf = workflow({
      name: 'long-analysis',
      input: z.object({}).strict(),
      handler: async (ctx) => {
        // Emit some structural events that the streaming flusher will
        // batch to the store (token/partial_object/string_delta excluded
        // per STREAMING_EXCLUDED_TYPES).
        (ctx as never as { emitEvent: (e: unknown) => void }).emitEvent({
          type: 'log',
          executionId: ctx.executionId,
          step: 0,
          timestamp: Date.now(),
          data: { msg: 'phase-1' },
        });
        (ctx as never as { emitEvent: (e: unknown) => void }).emitEvent({
          type: 'agent_call_start',
          executionId: ctx.executionId,
          step: 1,
          timestamp: Date.now(),
          agent: 'analyzer',
        });
        await block; // never resolves — simulates a hang/crash
        return 'never-reached';
      },
    });
    runtimeA.register(wf);

    // Kick off — don't await. The handler hangs at `block`.
    const inflight = runtimeA.execute('long-analysis', {});
    inflight.catch(() => {}); // suppress unhandled-rejection on abort

    // Let the flusher drain the early events to the store
    await new Promise((r) => setTimeout(r, 100));

    // Verify the streaming buffer has content (events were flushed)
    const beforeCrash = await store.listStreamingExecutions!();
    expect(beforeCrash).toHaveLength(1);
    const crashedId = beforeCrash[0];
    const buffered = await store.getStreamingEvents!(crashedId);
    expect(buffered.length).toBeGreaterThanOrEqual(2); // at least our two events

    // "Crash" — abort the runtime WITHOUT calling shutdown. The buffer
    // stays in the store, the workflow_end never fires for this execution,
    // and on a real process this is where the OS would SIGKILL us.
    runtimeA.abort(crashedId);
    release!();
    await inflight.catch(() => {});

    // Even after the abort processes, the streaming buffer should NOT be
    // finalized because we never let persistExecution complete its chain
    // (we aborted the runtime mid-flight; the test's contract is that
    // shutdown was never called). On a real crash this is guaranteed by
    // SIGKILL.
    //
    // The aborted workflow_end emit DOES route through persistExecution
    // which finalizes the streaming buffer. To genuinely simulate a crash
    // we need to suppress that — we instead test the recovery path
    // against the canonical "buffer survives" scenario by stuffing
    // events directly into a fresh buffer entry below.

    // Simulate the buffer-survives state by directly seeding a separate
    // crashed-run buffer. This matches what would happen if the process
    // was SIGKILLed before persistExecution ran.
    await store.appendStreamingEvents!('crashed-from-kill', [
      {
        type: 'workflow_start',
        executionId: 'crashed-from-kill',
        workflow: 'long-analysis',
        step: 0,
        timestamp: 1000,
        data: { input: {} },
      },
      {
        type: 'agent_call_end',
        executionId: 'crashed-from-kill',
        step: 1,
        timestamp: 2000,
        agent: 'analyzer',
        cost: 0.0042,
        data: { response: 'partial answer' },
      },
    ] as never);

    // Process B: fresh runtime against the SAME store. Wire recovery
    // BEFORE accepting new work, per the documented contract.
    const runtimeB = new AxlRuntime({
      state: { store, persist: 'streaming' },
    });
    runtimeB.registerProvider('test', MockProvider.sequence([{ content: 'ok' }]) as never);

    await runtimeB.getExecutions(); // hydrate cache
    const recovered = await runtimeB.recoverIncompleteStreams();

    // The simulated SIGKILL'd buffer should be recovered as a synthesized
    // failed ExecutionInfo. The aborted-then-finalized A-side execution
    // is finalized cleanly so it should NOT be in the recovery list.
    const recoveredIds = recovered.map((e) => e.executionId);
    expect(recoveredIds).toContain('crashed-from-kill');

    const synth = recovered.find((e) => e.executionId === 'crashed-from-kill')!;
    expect(synth.status).toBe('failed');
    expect(synth.error).toContain('process terminated');
    expect(synth.workflow).toBe('long-analysis'); // pulled from workflow_start
    expect(synth.totalCost).toBeCloseTo(0.0042); // sum of cost-bearing leaves
    expect(synth.events).toHaveLength(2);
    expect(synth.events[0].type).toBe('workflow_start');

    // Buffer is cleaned up after successful recovery
    expect(await store.listStreamingExecutions!()).not.toContain('crashed-from-kill');

    // The recovered row is in historicalExecutions + getExecutions
    const visible = await runtimeB.getExecution('crashed-from-kill');
    expect(visible?.status).toBe('failed');

    await runtimeB.shutdown();
  });

  it('uses __axl/recovered sentinel when buffer has no workflow_start', async () => {
    const store = createSharedStore();

    // Seed a buffer with no workflow_start event (truly truncated crash)
    await store.appendStreamingEvents!('headless', [
      {
        type: 'log',
        executionId: 'headless',
        step: 5,
        timestamp: 1000,
        data: { msg: 'mid-workflow event' },
      },
    ] as never);

    const runtime = new AxlRuntime({
      state: { store, persist: 'streaming' },
    });
    runtime.registerProvider('test', MockProvider.sequence([{ content: 'ok' }]) as never);
    await runtime.getExecutions();
    const recovered = await runtime.recoverIncompleteStreams();

    expect(recovered).toHaveLength(1);
    expect(recovered[0].workflow).toBe('__axl/recovered');
    expect(recovered[0].status).toBe('failed');

    await runtime.shutdown();
  });

  it('recovery is idempotent — re-running on a clean store is a no-op', async () => {
    const store = createSharedStore();
    const runtime = new AxlRuntime({
      state: { store, persist: 'streaming' },
    });
    runtime.registerProvider('test', MockProvider.sequence([{ content: 'ok' }]) as never);

    // No crashes — empty store
    const first = await runtime.recoverIncompleteStreams();
    expect(first).toEqual([]);

    // Run a normal workflow that completes cleanly (no streaming buffer left)
    const wf = workflow({
      name: 'clean-wf',
      input: z.object({}).strict(),
      handler: async () => 'done',
    });
    runtime.register(wf);
    await runtime.execute('clean-wf', {});

    // Recovery should still be a no-op — nothing to recover
    const second = await runtime.recoverIncompleteStreams();
    expect(second).toEqual([]);

    await runtime.shutdown();
  });
});
