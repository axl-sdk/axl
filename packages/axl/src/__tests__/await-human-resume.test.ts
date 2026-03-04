import { describe, it, expect } from 'vitest';
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

describe('awaitHuman suspend/resume', () => {
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

    // Give it a tick to reach the awaitHuman
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    await new Promise((resolve) => setTimeout(resolve, 50));

    const pending = await runtime.getPendingDecisions();
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
    await new Promise((resolve) => setTimeout(resolve, 50));

    const pending = await runtime.getPendingDecisions();
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
});
