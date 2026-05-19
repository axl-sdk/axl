import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
import { z } from 'zod';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { MemoryStore } from '../state/memory.js';

// ── Mock Provider ────────────────────────────────────────────────────────

class TestProvider {
  readonly name = 'test';
  calls: any[] = [];

  async chat(messages: any[], options: any) {
    this.calls.push({ messages, options });
    return {
      content: 'approved result',
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      cost: 0.001,
    };
  }

  async *stream(messages: any[], options: any) {
    const resp = await this.chat(messages, options);
    yield { type: 'text_delta' as const, content: resp.content };
    yield { type: 'done' as const, usage: resp.usage };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════

/** Poll until at least one pending decision appears (avoids flaky fixed-time sleeps). */
async function waitForPendingDecision(runtime: AxlRuntime, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const pending = await runtime.getPendingDecisions();
    if (pending.length > 0) return pending;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for pending decision');
}

describe('awaitHuman suspend/resume', () => {
  // MemoryStore persists awaitHuman state to a shared temp file.
  // Clean it up before each test to prevent cross-run contamination.
  const TEMP_FILE = join(tmpdir(), 'axl-memory-store', 'await-human-state.json');

  beforeEach(() => {
    try {
      unlinkSync(TEMP_FILE);
    } catch {
      // File may not exist
    }
  });

  it('awaitHuman persists execution state to store', async () => {
    const provider = new TestProvider();

    const approvalWorkflow = workflow({
      name: 'approval-flow',
      input: z.object({ action: z.string() }),
      handler: async (ctx) => {
        const decision = await ctx.awaitHuman({
          channel: 'slack',
          prompt: `Approve action: ${ctx.input.action}?`,
        });
        return { approved: decision.approved };
      },
    });

    const runtime = new AxlRuntime({
      state: { store: 'memory' },
    });
    runtime.registerProvider('test', provider);
    runtime.register(approvalWorkflow);

    // Start execution in background (it will block on awaitHuman)
    const resultPromise = runtime.execute('approval-flow', { action: 'deploy' });

    // Wait for the workflow to reach awaitHuman
    await waitForPendingDecision(runtime);

    // Check that pending decisions exist
    const pending = await runtime.getPendingDecisions();
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0].channel).toBe('slack');
    expect(pending[0].prompt).toContain('deploy');

    // Check that execution state was persisted
    const stateStore = runtime.getStateStore();
    const execState = await stateStore.getExecutionState(pending[0].executionId);
    expect(execState).not.toBeNull();
    expect(execState!.status).toBe('waiting');
    expect(execState!.workflow).toBe('approval-flow');

    // Resolve the decision
    await runtime.resolveDecision(pending[0].executionId, {
      approved: true,
      data: 'lgtm',
    });

    const result = await resultPromise;
    expect(result).toEqual({ approved: true });

    // After resolution, execution state should be updated to running
    const postState = await stateStore.getExecutionState(pending[0].executionId);
    expect(postState!.status).toBe('running');
  });

  it('resolveDecision triggers resume of waiting workflow', async () => {
    const provider = new TestProvider();

    const wf = workflow({
      name: 'review-flow',
      input: z.object({ pr: z.number() }),
      handler: async (ctx) => {
        const decision = await ctx.awaitHuman({
          channel: 'github',
          prompt: `Review PR #${ctx.input.pr}`,
        });
        if (decision.approved) {
          return 'merged';
        }
        return 'rejected';
      },
    });

    const runtime = new AxlRuntime();
    runtime.registerProvider('test', provider);
    runtime.register(wf);

    const resultPromise = runtime.execute('review-flow', { pr: 42 });

    const pending = await waitForPendingDecision(runtime);
    expect(pending).toHaveLength(1);

    // Approve the PR
    await runtime.resolveDecision(pending[0].executionId, { approved: true });

    const result = await resultPromise;
    expect(result).toBe('merged');
  });

  it('rejected decision flows through correctly', async () => {
    const provider = new TestProvider();

    const wf = workflow({
      name: 'gate-flow',
      input: z.object({ item: z.string() }),
      handler: async (ctx) => {
        const decision = await ctx.awaitHuman({
          channel: 'email',
          prompt: `Gate check: ${ctx.input.item}`,
        });
        return decision.approved
          ? 'pass'
          : `blocked: ${decision.approved === false ? ((decision as any).reason ?? 'no reason') : ''}`;
      },
    });

    const runtime = new AxlRuntime();
    runtime.registerProvider('test', provider);
    runtime.register(wf);

    const resultPromise = runtime.execute('gate-flow', { item: 'release' });

    const pending = await waitForPendingDecision(runtime);
    await runtime.resolveDecision(pending[0].executionId, {
      approved: false,
      reason: 'not ready',
    });

    const result = await resultPromise;
    expect(result).toContain('blocked');
  });

  it('pending executions survive simulated restart with shared store', async () => {
    const store = new MemoryStore();

    // Simulate: save execution state and pending decision to the store
    await store.saveExecutionState('exec-restart-1', {
      workflow: 'deploy-flow',
      input: { env: 'production' },
      step: 5,
      status: 'waiting',
    });
    await store.savePendingDecision('exec-restart-1', {
      executionId: 'exec-restart-1',
      channel: 'slack',
      prompt: 'Approve deploy to production?',
      createdAt: new Date().toISOString(),
    });

    // "Restart": verify the store has the pending data
    const pendingIds = await store.listPendingExecutions();
    expect(pendingIds).toContain('exec-restart-1');

    const decisions = await store.getPendingDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].prompt).toContain('production');

    const state = await store.getExecutionState('exec-restart-1');
    expect(state).not.toBeNull();
    expect(state!.status).toBe('waiting');
    expect(state!.workflow).toBe('deploy-flow');
  });

  it('deleteExecution unblocks a workflow awaiting human decision (signal-driven abort)', async () => {
    // Regression for the C2 gap surfaced by the scenario-verification
    // review: `runtime.deleteExecution` aborts the controller and cleans
    // up the runtime's pendingDecisionResolvers map, but pre-fix the
    // `_awaitHumanImpl` Promise had no signal listener, so the workflow
    // hung forever waiting for a resolver that was never going to come.
    const provider = new TestProvider();
    const approvalWorkflow = workflow({
      name: 'approval-flow',
      input: z.object({ action: z.string() }),
      handler: async (ctx) => {
        const decision = await ctx.awaitHuman({
          channel: 'slack',
          prompt: `Approve action: ${ctx.input.action}?`,
        });
        return { approved: decision.approved };
      },
    });

    const runtime = new AxlRuntime({ state: { store: 'memory' } });
    runtime.registerProvider('test', provider);
    runtime.register(approvalWorkflow);

    const resultPromise = runtime.execute('approval-flow', { action: 'deploy' });
    // Suppress unhandled rejection — we assert it rejects below
    resultPromise.catch(() => {});

    // Wait for the workflow to land in awaitHuman
    const pending = await waitForPendingDecision(runtime);
    const executionId = pending[0].executionId;

    // Delete the in-flight execution. This must:
    //   (a) abort the workflow (signal fires inside _awaitHumanImpl),
    //   (b) clean up pendingDecisionResolvers + the persisted decision,
    //   (c) NOT resurrect the row after the workflow tears down.
    const deletePromise = runtime.deleteExecution(executionId);

    // The workflow promise must reject — within a tight timeout so a
    // future regression (no abort listener, infinite hang) trips this.
    await expect(
      Promise.race([
        resultPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 1000)),
      ]),
    ).rejects.toThrow();

    expect(await deletePromise).toBe(true);

    // No resurrected row
    expect(await runtime.getExecution(executionId)).toBeUndefined();
    // Decision row cleaned up
    expect(await runtime.getPendingDecisions()).toHaveLength(0);
  });

  it('awaitHuman that is already resolved does not double-throw when abort fires after', async () => {
    // Race scenario: resolveDecision fires, awaitHuman returns normally,
    // THEN the execution is aborted. The signal-abort listener must not
    // attempt a second reject — the Promise is already settled.
    const provider = new TestProvider();
    const wf = workflow({
      name: 'race-flow',
      input: z.object({}).strict(),
      handler: async (ctx) => {
        const decision = await ctx.awaitHuman({ channel: 'slack', prompt: 'go?' });
        return { approved: decision.approved };
      },
    });
    const runtime = new AxlRuntime({ state: { store: 'memory' } });
    runtime.registerProvider('test', provider);
    runtime.register(wf);

    const resultPromise = runtime.execute('race-flow', {});
    const pending = await waitForPendingDecision(runtime);
    const executionId = pending[0].executionId;

    // Resolve normally — workflow completes
    await runtime.resolveDecision(executionId, { approved: true });
    const result = (await resultPromise) as { approved: boolean };
    expect(result.approved).toBe(true);

    // Now fire delete AFTER the workflow completed. The audit event
    // should still fire (we always emit), but no abort-throw because
    // the awaitHuman Promise has long since resolved.
    let deletedEventFired = false;
    runtime.on('execution_deleted', () => {
      deletedEventFired = true;
    });
    await runtime.deleteExecution(executionId);
    expect(deletedEventFired).toBe(true);
  });

  it('awaitHuman wakes on external AbortSignal passed to runtime.execute()', async () => {
    // The signal-abort wiring should work for any abort source, not just
    // runtime.deleteExecution. External signals (e.g., from an HTTP
    // request's AbortController) must also wake a paused awaitHuman.
    const provider = new TestProvider();
    const wf = workflow({
      name: 'ext-signal-flow',
      input: z.object({}).strict(),
      handler: async (ctx) => {
        await ctx.awaitHuman({ channel: 'slack', prompt: 'approve?' });
        return 'done';
      },
    });
    const runtime = new AxlRuntime({ state: { store: 'memory' } });
    runtime.registerProvider('test', provider);
    runtime.register(wf);

    const controller = new AbortController();
    const resultPromise = runtime.execute('ext-signal-flow', {}, { signal: controller.signal });
    resultPromise.catch(() => {});

    await waitForPendingDecision(runtime);

    // External abort — should wake the awaitHuman call
    controller.abort();

    await expect(
      Promise.race([
        resultPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 1000)),
      ]),
    ).rejects.toThrow();
  });

  it('awaitHuman fast-path: aborted signal at entry skips in-memory resolver registration', async () => {
    // If the context signal is already aborted by the time awaitHuman
    // runs, the Promise rejects via the fast-path BEFORE the resolver
    // gets added to the in-process `pendingDecisions` Map. The persisted
    // decision row IS written (the persist happens upstream of the
    // resolver registration), but the workflow tears down cleanly with
    // AbortError and `runtime.deleteExecution` then sweeps the persisted
    // row as part of normal GDPR cleanup.
    const provider = new TestProvider();
    const wf = workflow({
      name: 'fast-abort-flow',
      input: z.object({}).strict(),
      handler: async (ctx) => {
        // Pre-abort the context signal. In production this happens when
        // `runtime.abort()` fires synchronously between two awaits in the
        // handler (e.g., shutdown signal racing a checkpoint resolution).
        (ctx as unknown as { signal: AbortSignal | undefined }).signal = (() => {
          const ac = new AbortController();
          ac.abort();
          return ac.signal;
        })();
        await ctx.awaitHuman({ channel: 'slack', prompt: 'too late' });
        return 'unreachable';
      },
    });
    const runtime = new AxlRuntime({ state: { store: 'memory' } });
    runtime.registerProvider('test', provider);
    runtime.register(wf);

    await expect(runtime.execute('fast-abort-flow', {})).rejects.toThrow();

    // In-memory resolver map stays empty (the fast-path bailed before
    // `pendingDecisions.set` ran) — proves the fast-path's value vs. the
    // full registration path that would leak a resolver closure.
    const resolvers = (runtime as unknown as { pendingDecisionResolvers: Map<string, unknown> })
      .pendingDecisionResolvers;
    expect(resolvers.size).toBe(0);
  });
});
