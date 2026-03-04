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
    const result = await ctx.checkpoint(async () => {
      callCount++;
      return { data: 'computed-result' };
    });

    expect(result).toEqual({ data: 'computed-result' });
    expect(callCount).toBe(1);

    // Verify it was saved to the store
    const saved = await store.getCheckpoint('exec-cp-1', 0);
    expect(saved).toEqual({ data: 'computed-result' });
  });

  it('returns saved result on replay without re-executing', async () => {
    const store = new MemoryStore();
    const provider = new TestProvider([{ content: 'ok' }]);

    // Pre-save a checkpoint (simulating a previous run)
    await store.saveCheckpoint('exec-cp-2', 0, { data: 'saved-result' });

    const ctx = createTestContext(provider, store, 'exec-cp-2');

    let callCount = 0;
    const result = await ctx.checkpoint(async () => {
      callCount++;
      return { data: 'new-result' };
    });

    // Should return saved result, not execute the function
    expect(result).toEqual({ data: 'saved-result' });
    expect(callCount).toBe(0);
  });

  it('multiple checkpoints use sequential step numbers', async () => {
    const store = new MemoryStore();
    const provider = new TestProvider([{ content: 'ok' }]);
    const ctx = createTestContext(provider, store, 'exec-cp-3');

    const r1 = await ctx.checkpoint(async () => 'first');
    const r2 = await ctx.checkpoint(async () => 'second');
    const r3 = await ctx.checkpoint(async () => 'third');

    expect(r1).toBe('first');
    expect(r2).toBe('second');
    expect(r3).toBe('third');

    // Verify all checkpoints saved
    expect(await store.getCheckpoint('exec-cp-3', 0)).toBe('first');
    expect(await store.getCheckpoint('exec-cp-3', 1)).toBe('second');
    expect(await store.getCheckpoint('exec-cp-3', 2)).toBe('third');
  });

  it('replays completed steps and executes in-progress step on resume', async () => {
    const store = new MemoryStore();
    const provider = new TestProvider([{ content: 'ok' }]);

    // Simulate: steps 0 and 1 completed in previous run, step 2 not saved
    await store.saveCheckpoint('exec-cp-4', 0, 'result-0');
    await store.saveCheckpoint('exec-cp-4', 1, 'result-1');

    const ctx = createTestContext(provider, store, 'exec-cp-4');

    const executionLog: string[] = [];

    const r0 = await ctx.checkpoint(async () => {
      executionLog.push('executed-step-0');
      return 'fresh-result-0';
    });

    const r1 = await ctx.checkpoint(async () => {
      executionLog.push('executed-step-1');
      return 'fresh-result-1';
    });

    const r2 = await ctx.checkpoint(async () => {
      executionLog.push('executed-step-2');
      return 'fresh-result-2';
    });

    // Steps 0 and 1 should return saved results (no execution)
    expect(r0).toBe('result-0');
    expect(r1).toBe('result-1');

    // Step 2 should actually execute
    expect(r2).toBe('fresh-result-2');

    // Only step 2 was actually executed
    expect(executionLog).toEqual(['executed-step-2']);
  });

  it('tool calls are not duplicated on replay', async () => {
    const store = new MemoryStore();
    const provider = new TestProvider([{ content: 'tool result from LLM' }]);

    // Simulate: tool execution was checkpointed in previous run
    await store.saveCheckpoint('exec-cp-5', 0, { toolOutput: 'saved-tool-result' });

    const ctx = createTestContext(provider, store, 'exec-cp-5');

    let toolExecuted = false;
    const result = await ctx.checkpoint(async () => {
      toolExecuted = true;
      return { toolOutput: 'new-tool-result' };
    });

    expect(result).toEqual({ toolOutput: 'saved-tool-result' });
    expect(toolExecuted).toBe(false);
  });

  it('LLM calls are not re-sent on replay', async () => {
    const store = new MemoryStore();
    const provider = new TestProvider([{ content: 'hello' }]);

    // Simulate: LLM response was checkpointed
    await store.saveCheckpoint('exec-cp-6', 0, 'saved-llm-response');

    const ctx = createTestContext(provider, store, 'exec-cp-6');

    const result = await ctx.checkpoint(async () => {
      return await ctx.ask(testAgent, 'Say hello');
    });

    expect(result).toBe('saved-llm-response');
    // Provider should NOT have been called
    expect(provider.calls.length).toBe(0);
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
    const result = await ctx.checkpoint(async () => {
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

    // Pre-save step 0 for replay
    await store.saveCheckpoint('exec-cp-trace', 0, 'saved');

    const ctx = createTestContext(provider, store, 'exec-cp-trace', { onTrace });

    // Step 0: replay
    await ctx.checkpoint(async () => 'new');
    // Step 1: fresh execution
    await ctx.checkpoint(async () => 'fresh');

    const traceEvents = onTrace.mock.calls.map((c) => c[0]);
    const cpEvents = traceEvents.filter(
      (e: any) => e.type === 'log' && e.data?.event?.startsWith('checkpoint_'),
    );

    expect(cpEvents.length).toBe(2);
    expect(cpEvents[0].data.event).toBe('checkpoint_replay');
    expect(cpEvents[1].data.event).toBe('checkpoint_save');
  });
});
