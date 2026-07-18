import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AxlRuntime, workflow } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';

/**
 * End-to-end tests for the per-execution lifecycle: tag-and-filter via
 * `ExecutionInfo.metadata`, audit-event emission on `runtime.deleteExecution`,
 * total per-surface sweep, and the GDPR right-to-be-forgotten contract
 * through every runtime layer.
 *
 * Unit tests cover individual behaviors (`packages/axl/src/__tests__/`).
 * This file proves they compose: a customer running multiple workflows
 * with metadata tags, listing by tenant, deleting per a user's DSR
 * request, and verifying every surface is clean.
 */
describe('Execution Lifecycle E2E: tag, list, delete, audit', () => {
  it('tags executions via metadata, filters by tenant, deletes per-user', async () => {
    const runtime = new AxlRuntime();
    runtime.registerProvider(
      'test',
      MockProvider.sequence([
        { content: 'ok' },
        { content: 'ok' },
        { content: 'ok' },
        { content: 'ok' },
      ]) as never,
    );

    const wf = workflow({
      name: 'analyze',
      input: z.object({ text: z.string() }),
      handler: async (ctx) => `processed: ${ctx.input.text}`,
    });
    runtime.register(wf);

    // Capture audit events
    const audit: Array<{
      executionId: string;
      workflow?: string;
      wasActive: boolean;
      hadPendingDecision: boolean;
      removed: boolean;
    }> = [];
    runtime.on('execution_deleted', (e) => audit.push(e));

    // Multi-tenant workload: two users across two tenants
    await runtime.execute(
      'analyze',
      { text: 'a' },
      { metadata: { tenantId: 't-1', userId: 'alice', correlationId: 'r-1' } },
    );
    await runtime.execute(
      'analyze',
      { text: 'b' },
      { metadata: { tenantId: 't-1', userId: 'alice', correlationId: 'r-2' } },
    );
    await runtime.execute(
      'analyze',
      { text: 'c' },
      { metadata: { tenantId: 't-1', userId: 'bob', correlationId: 'r-3' } },
    );
    await runtime.execute(
      'analyze',
      { text: 'd' },
      { metadata: { tenantId: 't-2', userId: 'carol', correlationId: 'r-4' } },
    );

    // ── Tag filtering ───────────────────────────────────────────────
    const all = await runtime.getExecutions();
    expect(all).toHaveLength(4);

    const t1Runs = all.filter((e) => e.metadata?.tenantId === 't-1');
    expect(t1Runs).toHaveLength(3);

    const aliceRuns = all.filter((e) => e.metadata?.userId === 'alice');
    expect(aliceRuns).toHaveLength(2);
    expect(aliceRuns[0].metadata?.correlationId).toMatch(/^r-\d$/);

    // ── GDPR delete for one user ────────────────────────────────────
    for (const exec of aliceRuns) {
      const deleted = await runtime.deleteExecution(exec.executionId);
      expect(deleted).toBe(true);
    }

    // Alice's data is gone
    const afterDelete = await runtime.getExecutions();
    expect(afterDelete).toHaveLength(2);
    expect(afterDelete.find((e) => e.metadata?.userId === 'alice')).toBeUndefined();

    // Bob (same tenant) is unaffected
    expect(afterDelete.find((e) => e.metadata?.userId === 'bob')).toBeDefined();

    // Carol (different tenant) is unaffected
    expect(afterDelete.find((e) => e.metadata?.userId === 'carol')).toBeDefined();

    // ── Audit trail ─────────────────────────────────────────────────
    expect(audit).toHaveLength(2);
    for (const e of audit) {
      expect(e.workflow).toBe('analyze');
      expect(e.removed).toBe(true);
      expect(e.wasActive).toBe(false);
      expect(e.hadPendingDecision).toBe(false);
    }

    await runtime.shutdown();
  });

  it('strips internal control-plane keys from persisted metadata', async () => {
    // Customers may use `metadata.sessionId` / `sessionHistory`
    // as control-plane channels. These must NOT leak into the persisted
    // `ExecutionInfo.metadata` queryable surface.
    const runtime = new AxlRuntime();
    runtime.registerProvider('test', MockProvider.sequence([{ content: 'ok' }]) as never);

    const wf = workflow({
      name: 'tag-strip',
      input: z.object({}).strict(),
      handler: async () => 'ok',
    });
    runtime.register(wf);

    await runtime.execute(
      'tag-strip',
      {},
      {
        metadata: {
          tenantId: 't-1', // user tag → persisted
          userId: 'u-1', // user tag → persisted
          sessionHistory: [{ role: 'user', content: 'big buffer' }], // internal → stripped
          sessionId: 'sess-internal', // internal → stripped
        },
      },
    );

    const [exec] = await runtime.getExecutions();
    expect(exec.metadata).toEqual({ tenantId: 't-1', userId: 'u-1' });

    await runtime.shutdown();
  });

  it('emits execution_deleted with audit metadata for unknown ids too', async () => {
    // Compliance pipelines want to log attempted-but-noop deletes so
    // they can detect operators fishing for ids that don't exist.
    const runtime = new AxlRuntime();
    runtime.registerProvider('test', MockProvider.sequence([{ content: 'ok' }]) as never);

    const audit: Array<{
      executionId: string;
      workflow?: string;
      removed: boolean;
    }> = [];
    runtime.on('execution_deleted', (e) => audit.push(e));

    const result = await runtime.deleteExecution('does-not-exist');
    expect(result).toBe(false);

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      executionId: 'does-not-exist',
      workflow: undefined, // unknown id, no workflow lookup
      removed: false,
    });

    await runtime.shutdown();
  });

  it('eval_deleted symmetric to execution_deleted — same audit shape', async () => {
    const runtime = new AxlRuntime();

    const audit: Array<{ id: string; eval?: string; removed: boolean }> = [];
    runtime.on('eval_deleted', (e) => audit.push(e));

    await runtime.saveEvalResult({
      id: 'ev-known',
      eval: 'accuracy',
      timestamp: 1000,
      data: { score: 0.9 },
    });

    await runtime.deleteEvalResult('ev-known');
    await runtime.deleteEvalResult('does-not-exist');

    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ id: 'ev-known', eval: 'accuracy', removed: true });
    expect(audit[1]).toMatchObject({ id: 'does-not-exist', eval: undefined, removed: false });

    await runtime.shutdown();
  });

  it('metadata snapshot isolates from caller mutation', async () => {
    // A multi-tenant request handler reusing a metadata object across
    // executions (with mutation between calls) must not surface those
    // mutations through `getExecution(id)`.
    const runtime = new AxlRuntime();
    runtime.registerProvider(
      'test',
      MockProvider.sequence([{ content: 'ok' }, { content: 'ok' }]) as never,
    );

    const wf = workflow({
      name: 'isolation',
      input: z.object({}).strict(),
      handler: async () => 'ok',
    });
    runtime.register(wf);

    const sharedMeta: Record<string, unknown> = { tenantId: 't-1', userId: 'u-1' };
    await runtime.execute('isolation', {}, { metadata: sharedMeta });
    const firstList = await runtime.getExecutions();
    const firstId = firstList[0].executionId;

    // Mutate the shared bag for the next call
    sharedMeta.userId = 'u-2';
    await runtime.execute('isolation', {}, { metadata: sharedMeta });

    // Find both executions by id (not by array position — equal ms-level
    // startedAt timestamps make the sort order non-deterministic).
    const all = await runtime.getExecutions();
    const first = all.find((e) => e.executionId === firstId);
    const second = all.find((e) => e.executionId !== firstId);
    expect(first?.metadata?.userId).toBe('u-1');
    expect(second?.metadata?.userId).toBe('u-2');

    // Mutate again post-execution — must not surface
    sharedMeta.userId = 'mutated-after-fact';
    const refetch = await runtime.getExecution(firstId);
    expect(refetch?.metadata?.userId).toBe('u-1');

    await runtime.shutdown();
  });
});
