import { describe, it, expect, vi } from 'vitest';
import { WorkflowContext } from '../context.js';
import type { WorkflowContextInit } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { MemoryStore } from '../state/memory.js';
import { agent } from '../agent.js';

// ── Mock Provider ────────────────────────────────────────────────────────

class TestProvider {
  readonly name = 'test';
  private responses: Array<{ content: string; cost?: number }>;
  private callIndex = 0;
  calls: any[] = [];

  constructor(responses: Array<{ content: string; cost?: number }>) {
    this.responses = responses;
  }

  async chat(messages: any[], options: any) {
    this.calls.push({ messages, options });
    const resp = this.responses[this.callIndex] ?? this.responses[this.responses.length - 1];
    this.callIndex++;
    return {
      content: resp.content,
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      cost: resp.cost ?? 0.001,
    };
  }

  async *stream(messages: any[], options: any) {
    const resp = await this.chat(messages, options);
    yield { type: 'text_delta' as const, content: resp.content };
    yield { type: 'done' as const, usage: (resp as any).usage };
  }
}

// ── Helper ───────────────────────────────────────────────────────────────

function createTestContext(
  provider: TestProvider,
  store: MemoryStore,
  executionId: string,
  init?: Partial<WorkflowContextInit>,
) {
  const registry = new ProviderRegistry();
  registry.registerInstance('test', provider as any);
  return new WorkflowContext({
    input: init?.input ?? 'test input',
    executionId,
    metadata: init?.metadata ?? {},
    config: { defaultProvider: 'test' },
    providerRegistry: registry,
    onTrace: init?.onTrace ?? vi.fn(),
    stateStore: store,
    ...init,
  });
}

const testAgent = agent({
  model: 'test:test-model',
  system: 'You are a test agent',
});

// ═════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════

describe('ctx.checkpoint()', () => {
  it('executes function and saves result on first run', async () => {
    const store = new MemoryStore();
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider, store, 'exec-cp-1');

    let callCount = 0;
    const result = await ctx.checkpoint('compute', async () => {
      callCount++;
      return { data: 'computed-result' };
    });

    expect(result).toEqual({ data: 'computed-result' });
    expect(callCount).toBe(1);

    // Verify it was saved to the store under the caller-supplied name.
    const saved = await store.getCheckpoint('exec-cp-1', 'compute');
    expect(saved).toEqual({ data: 'computed-result' });
  });

  it('returns saved result on replay without re-executing', async () => {
    const store = new MemoryStore();
    const provider = new TestProvider([{ content: 'ok' }]);

    // Pre-save a checkpoint (simulating a previous run).
    await store.saveCheckpoint('exec-cp-2', 'compute', { data: 'saved-result' });

    const ctx = createTestContext(provider, store, 'exec-cp-2');

    let callCount = 0;
    const result = await ctx.checkpoint('compute', async () => {
      callCount++;
      return { data: 'new-result' };
    });

    // Should return saved result, not execute the function.
    expect(result).toEqual({ data: 'saved-result' });
    expect(callCount).toBe(0);
  });

  it('multiple checkpoints with distinct names persist independently', async () => {
    const store = new MemoryStore();
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider, store, 'exec-cp-3');

    const r1 = await ctx.checkpoint('first', async () => 'first');
    const r2 = await ctx.checkpoint('second', async () => 'second');
    const r3 = await ctx.checkpoint('third', async () => 'third');

    expect(r1).toBe('first');
    expect(r2).toBe('second');
    expect(r3).toBe('third');

    expect(await store.getCheckpoint('exec-cp-3', 'first')).toBe('first');
    expect(await store.getCheckpoint('exec-cp-3', 'second')).toBe('second');
    expect(await store.getCheckpoint('exec-cp-3', 'third')).toBe('third');
  });

  it('replays completed checkpoints and executes only missing ones', async () => {
    const store = new MemoryStore();
    const provider = new TestProvider([{ content: 'ok' }]);

    // Simulate two checkpoints completed in a previous run; third missing.
    await store.saveCheckpoint('exec-cp-4', 'a', 'result-0');
    await store.saveCheckpoint('exec-cp-4', 'b', 'result-1');

    const ctx = createTestContext(provider, store, 'exec-cp-4');

    const executionLog: string[] = [];

    const r0 = await ctx.checkpoint('a', async () => {
      executionLog.push('executed-a');
      return 'fresh-result-0';
    });

    const r1 = await ctx.checkpoint('b', async () => {
      executionLog.push('executed-b');
      return 'fresh-result-1';
    });

    const r2 = await ctx.checkpoint('c', async () => {
      executionLog.push('executed-c');
      return 'fresh-result-2';
    });

    expect(r0).toBe('result-0');
    expect(r1).toBe('result-1');
    expect(r2).toBe('fresh-result-2');
    expect(executionLog).toEqual(['executed-c']);
  });

  it('tool calls are not duplicated on replay', async () => {
    const store = new MemoryStore();
    const provider = new TestProvider([{ content: 'tool result from LLM' }]);

    await store.saveCheckpoint('exec-cp-5', 'tool', { toolOutput: 'saved-tool-result' });

    const ctx = createTestContext(provider, store, 'exec-cp-5');

    let toolExecuted = false;
    const result = await ctx.checkpoint('tool', async () => {
      toolExecuted = true;
      return { toolOutput: 'new-tool-result' };
    });

    expect(result).toEqual({ toolOutput: 'saved-tool-result' });
    expect(toolExecuted).toBe(false);
  });

  it('LLM calls are not re-sent on replay', async () => {
    const store = new MemoryStore();
    const provider = new TestProvider([{ content: 'hello' }]);

    await store.saveCheckpoint('exec-cp-6', 'llm', 'saved-llm-response');

    const ctx = createTestContext(provider, store, 'exec-cp-6');

    const result = await ctx.checkpoint('llm', async () => {
      return await ctx.ask(testAgent, 'Say hello');
    });

    expect(result).toBe('saved-llm-response');
    expect(provider.calls.length).toBe(0);
  });

  it('rejects names reserved for runtime auto-checkpoints', async () => {
    const store = new MemoryStore();
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider, store, 'exec-cp-reserved');

    await expect(ctx.checkpoint('__auto/foo', async () => 'x')).rejects.toThrow(/reserved/);
  });

  it('works without a state store (no-op, always executes)', async () => {
    const provider = new TestProvider([{ content: 'ok' }]);
    const registry = new ProviderRegistry();
    registry.registerInstance('test', provider as any);

    const ctx = new WorkflowContext({
      input: 'test',
      executionId: 'exec-no-store',
      config: { defaultProvider: 'test' },
      providerRegistry: registry,
      onTrace: vi.fn(),
      // No stateStore
    });

    let callCount = 0;
    const result = await ctx.checkpoint('compute', async () => {
      callCount++;
      return 'result';
    });

    expect(result).toBe('result');
    expect(callCount).toBe(1);
  });

  it('emits trace events for checkpoint save and replay', async () => {
    const store = new MemoryStore();
    const provider = new TestProvider([{ content: 'ok' }]);
    const onTrace = vi.fn();

    await store.saveCheckpoint('exec-cp-trace', 'replayed', 'saved');

    const ctx = createTestContext(provider, store, 'exec-cp-trace', { onTrace });

    await ctx.checkpoint('replayed', async () => 'new');
    await ctx.checkpoint('fresh', async () => 'fresh');

    const traceEvents = onTrace.mock.calls.map((c) => c[0]);
    const cpEvents = traceEvents.filter(
      (e: any) => e.type === 'checkpoint_save' || e.type === 'checkpoint_replay',
    );

    expect(cpEvents.length).toBe(2);
    expect(cpEvents[0].type).toBe('checkpoint_replay');
    expect(cpEvents[0].data.name).toBe('replayed');
    expect(cpEvents[1].type).toBe('checkpoint_save');
    expect(cpEvents[1].data.name).toBe('fresh');
  });

  it('child contexts share the auto-checkpoint counter so nested asks do not collide', async () => {
    // Prior to the named-checkpoint change, each WorkflowContext had its
    // own counter starting at 0; a tool handler's nested ctx.ask() (which
    // auto-checkpoints) wrote step 0 over the parent's step 0 in the
    // store. The shared counter ref makes auto-checkpoint names globally
    // unique within an execution.
    const store = new MemoryStore();
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider, store, 'exec-cp-child');

    const child = ctx.createChildContext('tool-call-id');

    // Each ctx.ask is internally auto-checkpointed. Run one in each
    // context and verify the names don't collide.
    await ctx.ask(testAgent, 'parent');
    await child.ask(testAgent, 'child');

    // Each agent has its own per-agent counter. The shared counter ref
    // means parent and child contexts both bump the same map, but since
    // they're calling different agents (this test calls testAgent in
    // both, so the same agent), the counter increments per agent. The
    // parent claims testAgent/ask/0; the child claims testAgent/ask/1.
    expect(
      await store.getCheckpoint('exec-cp-child', `__auto/${testAgent._name}/ask/0`),
    ).not.toBeNull();
    expect(
      await store.getCheckpoint('exec-cp-child', `__auto/${testAgent._name}/ask/1`),
    ).not.toBeNull();
  });
});
