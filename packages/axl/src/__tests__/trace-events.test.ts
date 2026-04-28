import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { randomUUID } from 'node:crypto';
import type { AxlEvent, ToolCallMessage } from '../types.js';
import type { HumanDecision } from '../types.js';
import { createSequenceProvider, createTestCtx } from './helpers.js';

/**
 * Trace observability coverage — these tests pin the contract that the trace
 * explorer relies on: retry visibility, system prompt capture, resolved
 * params, retry feedback, verbose message snapshots, and approval events.
 */

describe('trace events — agent_call enrichment', () => {
  it('captures resolved system prompt, params, and turn on agent_call', async () => {
    const a = agent({
      name: 'helper',
      model: 'mock:test',
      system: 'You are a helpful assistant.',
      temperature: 0.5,
      maxTokens: 1024,
    });
    const { ctx, traces } = createTestCtx({ provider: createSequenceProvider(['ok']) });
    await ctx.ask(a, 'hi', { effort: 'low', toolChoice: 'auto' });

    // Request-side metadata lives on agent_call_start.
    const agentCallStart = traces.find((t) => t.type === 'agent_call_start');
    expect(agentCallStart).toBeDefined();
    const startData = agentCallStart!.data as Record<string, unknown>;
    expect(startData.system).toBe('You are a helpful assistant.');
    expect(startData.turn).toBe(1);
    const params = startData.params as Record<string, unknown>;
    expect(params.temperature).toBe(0.5);
    expect(params.maxTokens).toBe(1024);
    expect(params.effort).toBe('low');
    expect(params.toolChoice).toBe('auto');
    // agent_call_end mirrors `turn` so cost-bucketing consumers reading the end event have it.
    const agentCallEnd = traces.find((t) => t.type === 'agent_call_end');
    expect((agentCallEnd!.data as Record<string, unknown>).turn).toBe(1);
  });

  it('resolves dynamic system prompt at call time', async () => {
    const a = agent({
      name: 'dynamic',
      model: 'mock:test',
      system: (ctx) => `Tenant: ${ctx.metadata?.tenant ?? 'default'}`,
    });
    const { ctx, traces } = createTestCtx({
      provider: createSequenceProvider(['ok']),
      metadata: { tenant: 'acme' },
    });
    await ctx.ask(a, 'hi');

    const agentCallStart = traces.find((t) => t.type === 'agent_call_start');
    expect((agentCallStart!.data as Record<string, unknown>).system).toBe('Tenant: acme');
  });

  it('omits messages snapshot by default (verbose off)', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'sys' });
    const { ctx, traces } = createTestCtx({ provider: createSequenceProvider(['ok']) });
    await ctx.ask(a, 'hi');

    const agentCallStart = traces.find((t) => t.type === 'agent_call_start');
    expect((agentCallStart!.data as Record<string, unknown>).messages).toBeUndefined();
  });

  it('includes messages snapshot when trace.level === full', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'you are helpful' });
    const provider = createSequenceProvider(['ok']);
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', provider);
    const traces: AxlEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { level: 'full' } },
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
    });
    await ctx.ask(a, 'hi');

    const agentCallStart = traces.find((t) => t.type === 'agent_call_start');
    const data = agentCallStart!.data as Record<string, unknown>;
    expect(Array.isArray(data.messages)).toBe(true);
    const messages = data.messages as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.role === 'system' && m.content === 'you are helpful')).toBe(true);
    expect(messages.some((m) => m.role === 'user' && m.content.includes('hi'))).toBe(true);
  });

  it('includes thinking content when provider returns it', async () => {
    const provider = createSequenceProvider([]);
    // Override chat to return thinking_content
    provider.chat = async () => ({
      content: 'final answer',
      thinking_content: 'Let me think about this...',
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      cost: 0.001,
    });
    const a = agent({ name: 'thinker', model: 'mock:test', system: 'sys' });
    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(a, 'hi');

    const agentCall = traces.find((t) => t.type === 'agent_call_end');
    expect((agentCall!.data as Record<string, unknown>).thinking).toBe(
      'Let me think about this...',
    );
  });
});

describe('trace events — schema_check', () => {
  it('emits schema_check with valid: true on successful parse', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'return JSON' });
    const { ctx, traces } = createTestCtx({
      provider: createSequenceProvider([JSON.stringify({ answer: 'hello' })]),
    });
    await ctx.ask(a, 'hi', { schema: z.object({ answer: z.string() }) });

    const checks = traces.filter((t) => t.type === 'schema_check');
    expect(checks).toHaveLength(1);
    const data = checks[0].data as Record<string, unknown>;
    expect(data.valid).toBe(true);
    expect(data.attempt).toBe(1);
    expect(data.maxAttempts).toBe(4); // retries default 3 → 4 attempts
    expect(data.feedbackMessage).toBeUndefined();
  });

  it('emits schema_check with valid: false and feedbackMessage on retry', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'return JSON' });
    const { ctx, traces } = createTestCtx({
      provider: createSequenceProvider(['not json', JSON.stringify({ answer: 'ok' })]),
    });
    await ctx.ask(a, 'hi', { schema: z.object({ answer: z.string() }) });

    const checks = traces.filter((t) => t.type === 'schema_check');
    expect(checks).toHaveLength(2);

    const first = checks[0].data as Record<string, unknown>;
    expect(first.valid).toBe(false);
    expect(first.attempt).toBe(1);
    expect(first.reason).toBeDefined();
    // feedback is the exact retry message the LLM sees on the next turn
    expect(first.feedbackMessage).toContain('not valid JSON');

    const second = checks[1].data as Record<string, unknown>;
    expect(second.valid).toBe(true);
    expect(second.attempt).toBe(2);
  });

  it('sets retryReason on the follow-up agent_call after schema failure', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'return JSON' });
    const { ctx, traces } = createTestCtx({
      provider: createSequenceProvider(['not json', JSON.stringify({ answer: 'ok' })]),
    });
    await ctx.ask(a, 'hi', { schema: z.object({ answer: z.string() }) });

    const calls = traces.filter((t) => t.type === 'agent_call_end');
    expect(calls).toHaveLength(2);
    const firstData = calls[0].data as Record<string, unknown>;
    const secondData = calls[1].data as Record<string, unknown>;
    expect(firstData.retryReason).toBeUndefined();
    expect(secondData.retryReason).toBe('schema');
    expect(secondData.turn).toBe(2);
  });
});

describe('trace events — verbose messages snapshot across retries', () => {
  it('captures accumulated retry feedback in messages[] across turns', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'sys' });
    const provider = createSequenceProvider(['not json', '{"answer":"ok"}']);
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', provider);
    const traces: AxlEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { level: 'full' } },
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
    });
    await ctx.ask(a, 'hi', { schema: z.object({ answer: z.string() }) });

    const calls = traces.filter((t) => t.type === 'agent_call_start');
    expect(calls).toHaveLength(2);
    const turn1Messages = (calls[0].data as Record<string, unknown>).messages as Array<{
      role: string;
      content: string;
    }>;
    const turn2Messages = (calls[1].data as Record<string, unknown>).messages as Array<{
      role: string;
      content: string;
    }>;
    // Turn 1: system + user only
    expect(turn1Messages.length).toBeLessThanOrEqual(2);
    // Turn 2: system + user + assistant (bad attempt) + system (retry feedback)
    expect(turn2Messages.length).toBeGreaterThan(turn1Messages.length);
    // The corrective feedback is visible in turn 2's view of what the model saw
    const feedbackPresent = turn2Messages.some((m) => m.content?.includes('not valid JSON'));
    expect(feedbackPresent).toBe(true);
  });
});

describe('trace events — nested child contexts (agent-as-tool)', () => {
  it('stamps parentAskId on nested agent_call events so consumers can join to the outer ask', async () => {
    // Replaces the pre-0.16.0 `parentToolCallId` test. Correlation is now
    // entirely via `parentAskId` (on `AskScoped`) — the outer ask's askId
    // appears on every event emitted from the nested ask. The deprecated
    // `parentToolCallId` field was removed in 0.16.0.
    const childAgent = agent({
      name: 'child',
      model: 'mock:test',
      system: 'child',
    });
    const nestedTool = tool({
      name: 'nested_call',
      description: 'nested',
      input: z.object({}),
      handler: async (_input, childCtx) => childCtx.ask(childAgent, 'nested prompt'),
    });
    const parentAgent = agent({
      name: 'parent',
      model: 'mock:test',
      system: 'parent',
      tools: [nestedTool],
    });

    const toolCalls: ToolCallMessage[] = [
      { id: 'outer-tc-1', type: 'function', function: { name: 'nested_call', arguments: '{}' } },
    ];
    const provider = createSequenceProvider([
      { tool_calls: toolCalls },
      'nested result',
      'parent final',
    ]);
    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(parentAgent, 'go');

    // The outer ask's ask_start gives us the parent askId; the nested
    // ask's events should all carry that as `parentAskId`.
    const parentAskStart = traces.find(
      (t): t is Extract<AxlEvent, { type: 'ask_start' }> =>
        t.type === 'ask_start' && t.agent === 'parent',
    );
    expect(parentAskStart).toBeDefined();
    const parentAskId = parentAskStart!.askId;

    // Every event from the nested ask carries parentAskId === parent's askId
    // and has depth >= 1 (root parent ask is depth 0). `parentAskId` is on
    // the AskScoped mixin so workflow_start/end (no AskScoped) need an
    // `'parentAskId' in t` guard before the read.
    const nestedEvents = traces.filter((t) => 'parentAskId' in t && t.parentAskId === parentAskId);
    expect(nestedEvents.length).toBeGreaterThan(0);
    const childAgentCall = nestedEvents.find(
      (t): t is Extract<AxlEvent, { type: 'agent_call_end' }> =>
        t.type === 'agent_call_end' && t.agent === 'child',
    );
    expect(childAgentCall).toBeDefined();
    expect((childAgentCall!.depth ?? 0) >= 1).toBe(true);

    // The outer parent agent_call is the root ask — no parentAskId.
    const parentAgentCall = traces.find(
      (t): t is Extract<AxlEvent, { type: 'agent_call_end' }> =>
        t.type === 'agent_call_end' && t.agent === 'parent',
    );
    expect(parentAgentCall!.parentAskId).toBeUndefined();
  });

  it('isolates retryReason between parent and child ctx.ask()', async () => {
    const childAgent = agent({
      name: 'child',
      model: 'mock:test',
      system: 'child system',
    });

    // The parent tool handler calls ctx.ask() on a nested agent.
    const nestedTool = tool({
      name: 'nested_call',
      description: 'call nested agent',
      input: z.object({}),
      handler: async (_input, childCtx) => {
        return childCtx.ask(childAgent, 'nested prompt');
      },
    });

    const parentAgent = agent({
      name: 'parent',
      model: 'mock:test',
      system: 'parent',
      tools: [nestedTool],
    });

    const toolCalls: ToolCallMessage[] = [
      { id: 'tc1', type: 'function', function: { name: 'nested_call', arguments: '{}' } },
    ];
    // Parent sequence: tool call → final. Nested: 'nested result'.
    const provider = createSequenceProvider([
      { tool_calls: toolCalls },
      'nested result',
      'parent final',
    ]);
    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(parentAgent, 'go');

    // Both parent and child agent_calls should appear, but neither should
    // carry retryReason since neither hit a gate failure.
    const ends = traces.filter((t) => t.type === 'agent_call_end');
    expect(ends.length).toBeGreaterThanOrEqual(2);
    for (const call of ends) {
      expect((call.data as Record<string, unknown>).retryReason).toBeUndefined();
    }
    // Child agent's call should show system: 'child system', not 'parent'.
    // The system prompt lives on agent_call_start (request side).
    const starts = traces.filter((t) => t.type === 'agent_call_start');
    const childCall = starts.find((c) => c.agent === 'child');
    expect(childCall).toBeDefined();
    expect((childCall!.data as Record<string, unknown>).system).toBe('child system');
  });
});

describe('trace events — streaming path captures thinking', () => {
  it('includes thinking content on agent_call when streaming provides thinking deltas', async () => {
    // Minimal streaming provider yielding thinking_delta + text_delta + done
    const provider = {
      name: 'mock',
      chat: async () => ({
        content: 'fallback',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
      stream: async function* () {
        yield { type: 'thinking_delta' as const, content: 'let me think' };
        yield { type: 'text_delta' as const, content: 'answer' };
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          cost: 0.001,
        };
      },
    };
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', provider);
    const traces: AxlEvent[] = [];
    const tokens: string[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: {},
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
      onToken: (tok) => tokens.push(tok),
    });
    const a = agent({ name: 'streamer', model: 'mock:test', system: 'sys' });
    await ctx.ask(a, 'hi');

    expect(tokens.join('')).toBe('answer');
    const call = traces.find((t) => t.type === 'agent_call_end');
    expect(call).toBeDefined();
    expect((call!.data as Record<string, unknown>).thinking).toBe('let me think');
  });
});

describe('trace events — delegate shape consistency', () => {
  it('multi-agent delegate event carries reason: routed', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'a' });
    const b = agent({ name: 'b', model: 'mock:test', system: 'b' });
    const toolCalls: ToolCallMessage[] = [
      { id: 'tc1', type: 'function', function: { name: 'handoff_to_a', arguments: '{}' } },
    ];
    const provider = createSequenceProvider([{ tool_calls: toolCalls }, 'a response']);
    const { ctx, traces } = createTestCtx({ provider });
    await ctx.delegate([a, b], 'go');

    const delegates = traces.filter((t) => t.type === 'delegate');
    expect(delegates).toHaveLength(1);
    const data = delegates[0].data as Record<string, unknown>;
    expect(data.reason).toBe('routed');
    expect(data.candidates).toEqual(['a', 'b']);
    expect(data.routerModel).toBeDefined();
  });
});

describe('trace events — guardrail attempt tracking', () => {
  it('emits feedbackMessage and sets retryReason on output guardrail retry', async () => {
    const a = agent({
      model: 'mock:test',
      system: 'helpful',
      guardrails: {
        output: async (response) =>
          response.includes('bad')
            ? { block: true, reason: 'contains bad word' }
            : { block: false },
        onBlock: 'retry',
        maxRetries: 2,
      },
    });
    const { ctx, traces } = createTestCtx({
      provider: createSequenceProvider(['this is bad', 'this is good']),
    });
    await ctx.ask(a, 'hi');

    const outputChecks = traces.filter(
      (t): t is Extract<AxlEvent, { type: 'guardrail' }> =>
        t.type === 'guardrail' && (t.data as Record<string, unknown>)?.guardrailType === 'output',
    );
    expect(outputChecks).toHaveLength(2);
    const first = outputChecks[0].data as Record<string, unknown>;
    expect(first.blocked).toBe(true);
    expect(first.attempt).toBe(1);
    expect(first.maxAttempts).toBe(3);
    expect(first.feedbackMessage).toContain('blocked by a safety guardrail');

    // Second agent_call should be tagged as a guardrail retry
    const calls = traces.filter(
      (t): t is Extract<AxlEvent, { type: 'agent_call_end' }> => t.type === 'agent_call_end',
    );
    expect((calls[1].data as Record<string, unknown>).retryReason).toBe('guardrail');
  });
});

describe('trace events — validate attempt tracking', () => {
  it('emits feedbackMessage and sets retryReason on validate retry', async () => {
    const a = agent({ model: 'mock:test', system: 'sys' });
    const { ctx, traces } = createTestCtx({
      provider: createSequenceProvider([
        JSON.stringify({ value: 1 }),
        JSON.stringify({ value: 99 }),
      ]),
    });
    await ctx.ask(a, 'hi', {
      schema: z.object({ value: z.number() }),
      validate: (out) => (out.value > 50 ? { valid: true } : { valid: false, reason: 'too low' }),
    });

    const validateChecks = traces.filter((t) => t.type === 'validate');
    expect(validateChecks).toHaveLength(2);
    const first = validateChecks[0].data as Record<string, unknown>;
    expect(first.valid).toBe(false);
    expect(first.attempt).toBe(1);
    expect(first.maxAttempts).toBe(3);
    expect(first.feedbackMessage).toContain('failed validation');

    const calls = traces.filter((t) => t.type === 'agent_call_end');
    expect((calls[1].data as Record<string, unknown>).retryReason).toBe('validate');
  });
});

describe('trace events — tool_approval', () => {
  it('emits tool_approval with approved: true', async () => {
    const myTool = tool({
      name: 'risky',
      description: 'risky',
      input: z.object({ x: z.number() }),
      handler: (input) => `got ${input.x}`,
      requireApproval: true,
    });
    const toolCalls: ToolCallMessage[] = [
      { id: 'tc1', type: 'function', function: { name: 'risky', arguments: '{"x":1}' } },
    ];
    const provider = createSequenceProvider([{ tool_calls: toolCalls }, 'done']);
    const handler = vi.fn(async (): Promise<HumanDecision> => ({ approved: true }));
    const { ctx, traces } = createTestCtx({ provider, awaitHumanHandler: handler });
    const a = agent({ model: 'mock:test', system: 'sys', tools: [myTool] });
    await ctx.ask(a, 'go');

    const approvals = traces.filter((t) => t.type === 'tool_approval');
    expect(approvals).toHaveLength(1);
    const data = approvals[0].data as Record<string, unknown>;
    expect(data.approved).toBe(true);
    expect(data.args).toEqual({ x: 1 });
    expect(data.reason).toBeUndefined();
  });

  it('emits tool_approval with approved: false and reason on denial', async () => {
    const myTool = tool({
      name: 'risky',
      description: 'risky',
      input: z.object({ x: z.number() }),
      handler: (input) => `got ${input.x}`,
      requireApproval: true,
    });
    const toolCalls: ToolCallMessage[] = [
      { id: 'tc1', type: 'function', function: { name: 'risky', arguments: '{"x":1}' } },
    ];
    const provider = createSequenceProvider([{ tool_calls: toolCalls }, 'stopped']);
    const handler = vi.fn(
      async (): Promise<HumanDecision> => ({ approved: false, reason: 'nope' }),
    );
    const { ctx, traces } = createTestCtx({ provider, awaitHumanHandler: handler });
    const a = agent({ model: 'mock:test', system: 'sys', tools: [myTool] });
    await ctx.ask(a, 'go');

    const approvals = traces.filter((t) => t.type === 'tool_approval');
    expect(approvals).toHaveLength(1);
    const data = approvals[0].data as Record<string, unknown>;
    expect(data.approved).toBe(false);
    expect(data.reason).toBe('nope');
  });
});

describe('trace events — delegate', () => {
  it('emits delegate on single-agent short-circuit', async () => {
    const solo = agent({ name: 'solo', model: 'mock:test', system: 'sys' });
    const { ctx, traces } = createTestCtx({ provider: createSequenceProvider(['ok']) });
    await ctx.delegate([solo], 'go');

    const delegates = traces.filter((t) => t.type === 'delegate');
    expect(delegates).toHaveLength(1);
    expect(delegates[0].data).toMatchObject({
      candidates: ['solo'],
      selected: 'solo',
      reason: 'single_candidate',
    });
  });
});

describe('trace events — handoff clears retryReason', () => {
  it('retryReason applies only to the source agents retry turn, not to the handed-off target', async () => {
    const target = agent({ name: 'target', model: 'mock:test', system: 'target' });
    const source = agent({
      name: 'source',
      model: 'mock:test',
      system: 'source',
      handoffs: [{ agent: target }],
    });

    const handoffCall: ToolCallMessage[] = [
      { id: 'h1', type: 'function', function: { name: 'handoff_to_target', arguments: '{}' } },
    ];
    // Source: attempt 1 fails schema, attempt 2 emits handoff. Target: final answer.
    const provider = createSequenceProvider([
      'not json',
      { tool_calls: handoffCall },
      JSON.stringify({ answer: 'ok' }),
    ]);
    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(source, 'hi', { schema: z.object({ answer: z.string() }) });

    const calls = traces.filter((t) => t.type === 'agent_call_end');
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const sourceCalls = calls.filter((c) => c.agent === 'source');
    const targetCalls = calls.filter((c) => c.agent === 'target');
    expect(sourceCalls.length).toBeGreaterThanOrEqual(2);
    expect(targetCalls.length).toBeGreaterThanOrEqual(1);
    // Source turn 2 should be marked as a schema retry
    const sourceRetry = sourceCalls.find(
      (c) => (c.data as Record<string, unknown>).retryReason === 'schema',
    );
    expect(sourceRetry).toBeDefined();
    // Target turn 1 should NOT carry retryReason — it's a fresh call, not a retry
    for (const targetCall of targetCalls) {
      expect((targetCall.data as Record<string, unknown>).retryReason).toBeUndefined();
    }
  });
});

describe('trace events — retry exhaustion edge cases', () => {
  it('final schema_check attempt omits feedbackMessage and throws VerifyError', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'sys' });
    const { ctx, traces } = createTestCtx({
      provider: createSequenceProvider(['nope', 'still nope']),
    });
    await expect(
      ctx.ask(a, 'hi', { schema: z.object({ answer: z.string() }), retries: 1 }),
    ).rejects.toThrow();

    const checks = traces.filter((t) => t.type === 'schema_check');
    expect(checks).toHaveLength(2);
    const first = checks[0].data as Record<string, unknown>;
    const last = checks[1].data as Record<string, unknown>;
    expect(first.attempt).toBe(1);
    expect(first.maxAttempts).toBe(2);
    expect(first.feedbackMessage).toBeDefined();
    // Final attempt: no retry possible → no feedbackMessage
    expect(last.attempt).toBe(2);
    expect(last.maxAttempts).toBe(2);
    expect(last.feedbackMessage).toBeUndefined();
  });

  it('retries: 0 allows exactly one attempt', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'sys' });
    const { ctx, traces } = createTestCtx({ provider: createSequenceProvider(['nope']) });
    await expect(
      ctx.ask(a, 'hi', { schema: z.object({ answer: z.string() }), retries: 0 }),
    ).rejects.toThrow();

    const checks = traces.filter((t) => t.type === 'schema_check');
    expect(checks).toHaveLength(1);
    const only = checks[0].data as Record<string, unknown>;
    expect(only.attempt).toBe(1);
    expect(only.maxAttempts).toBe(1);
    expect(only.feedbackMessage).toBeUndefined();
  });

  it('validateRetries: 0 allows exactly one attempt before throwing', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'sys' });
    const { ctx, traces } = createTestCtx({
      provider: createSequenceProvider([JSON.stringify({ value: 1 })]),
    });
    await expect(
      ctx.ask(a, 'hi', {
        schema: z.object({ value: z.number() }),
        validate: () => ({ valid: false, reason: 'always invalid' }),
        validateRetries: 0,
      }),
    ).rejects.toThrow();

    const checks = traces.filter((t) => t.type === 'validate');
    expect(checks).toHaveLength(1);
    const only = checks[0].data as Record<string, unknown>;
    expect(only.attempt).toBe(1);
    expect(only.maxAttempts).toBe(1);
    expect(only.feedbackMessage).toBeUndefined();
  });
});

describe('trace events — verify emission', () => {
  it('emits verify event with passed: true on success', async () => {
    const { ctx, traces } = createTestCtx();
    const schema = z.object({ n: z.number() });
    const result = await ctx.verify(async () => ({ n: 42 }), schema);
    expect(result).toEqual({ n: 42 });

    const verifyEvents = traces.filter((t) => t.type === 'verify');
    expect(verifyEvents).toHaveLength(1);
    const data = verifyEvents[0].data as Record<string, unknown>;
    expect(data.passed).toBe(true);
    expect(data.attempts).toBe(1);
    expect(data.lastError).toBeUndefined();
  });

  it('emits verify event with passed: false and lastError on exhaustion', async () => {
    const { ctx, traces } = createTestCtx();
    const schema = z.object({ n: z.number() });
    await expect(
      ctx.verify(async () => ({ n: 'not a number' }), schema, { retries: 1 }),
    ).rejects.toThrow();

    const verifyEvents = traces.filter((t) => t.type === 'verify');
    expect(verifyEvents).toHaveLength(1);
    const data = verifyEvents[0].data as Record<string, unknown>;
    expect(data.passed).toBe(false);
    expect(data.attempts).toBe(2); // retries=1 → 2 attempts total
    expect(data.lastError).toBeDefined();
  });

  it('emits verify event with passed: false on fallback path', async () => {
    const { ctx, traces } = createTestCtx();
    const schema = z.object({ n: z.number() });
    const result = await ctx.verify(async () => ({ n: 'bad' }), schema, {
      retries: 0,
      fallback: { n: 0 },
    });
    expect(result).toEqual({ n: 0 });

    const verifyEvents = traces.filter((t) => t.type === 'verify');
    expect(verifyEvents).toHaveLength(1);
    const data = verifyEvents[0].data as Record<string, unknown>;
    expect(data.passed).toBe(false);
    expect(data.attempts).toBe(1);
  });
});

describe('trace events — onTrace consumer safety', () => {
  it('does not crash the workflow when onTrace handler throws', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'sys' });
    const provider = createSequenceProvider(['ok']);
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', provider);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: {},
      providerRegistry: registry,
      onTrace: () => {
        throw new Error('buggy logger');
      },
    });
    // Workflow should still complete despite the logger crashing
    const result = await ctx.ask(a, 'hi');
    expect(result).toBe('ok');
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('onTrace handler threw'),
      expect.any(String),
    );
    errSpy.mockRestore();
  });
});

describe('trace events — handoff data completeness', () => {
  it('handoff event includes source and roundtrip message', async () => {
    const target = agent({ name: 'target', model: 'mock:test', system: 'target' });
    const source = agent({
      name: 'source',
      model: 'mock:test',
      system: 'source',
      handoffs: [{ agent: target, mode: 'roundtrip' }],
    });

    const handoffCall: ToolCallMessage[] = [
      {
        id: 'h1',
        type: 'function',
        function: { name: 'handoff_to_target', arguments: '{"message":"fetch invoice 42"}' },
      },
    ];
    const provider = createSequenceProvider([{ tool_calls: handoffCall }, 'fetched', 'done']);
    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(source, 'help');

    // `handoff_start` carries source/target/mode and (for roundtrip) the
    // user-supplied message; fired before the target ask begins.
    const handoffs = traces.filter((t) => t.type === 'handoff_start');
    expect(handoffs).toHaveLength(1);
    const data = handoffs[0].data as Record<string, unknown>;
    expect(data.source).toBe('source');
    expect(data.target).toBe('target');
    expect(data.mode).toBe('roundtrip');
    expect(data.message).toBe('fetch invoice 42');
  });

  it('oneway handoff includes source but no message', async () => {
    const target = agent({ name: 'target', model: 'mock:test', system: 'target' });
    const source = agent({
      name: 'source',
      model: 'mock:test',
      system: 'source',
      handoffs: [{ agent: target }],
    });
    const handoffCall: ToolCallMessage[] = [
      { id: 'h1', type: 'function', function: { name: 'handoff_to_target', arguments: '{}' } },
    ];
    const provider = createSequenceProvider([{ tool_calls: handoffCall }, 'done']);
    const { ctx, traces } = createTestCtx({ provider });
    await ctx.ask(source, 'help');

    // Oneway emits only `handoff_start` (no return trip); message is
    // never populated on oneway — only roundtrip carries user content.
    const handoffs = traces.filter((t) => t.type === 'handoff_start');
    expect(handoffs).toHaveLength(1);
    const data = handoffs[0].data as Record<string, unknown>;
    expect(data.source).toBe('source');
    expect(data.target).toBe('target');
    expect(data.mode).toBe('oneway');
    expect(data.message).toBeUndefined();
  });
});

describe('trace events — workflow_start/end redaction', () => {
  it('redacts workflow_start.input under trace.redact', async () => {
    const { workflow, AxlRuntime } = await import('../index.js');
    const runtime = new AxlRuntime({ trace: { redact: true } });
    const traces: AxlEvent[] = [];
    runtime.on('trace', (e) => traces.push(e));

    runtime.register(
      workflow({
        name: 'secret-wf',
        input: z.object({ ssn: z.string() }),
        handler: async () => 'ok',
      }),
    );
    await runtime.execute('secret-wf', { ssn: '123-45-6789' });

    const startEvent = traces.find((t) => t.type === 'workflow_start');
    expect(startEvent).toBeDefined();
    const data = startEvent!.data as Record<string, unknown>;
    // Input (potentially PII) scrubbed
    expect(data.input).toBe('[redacted]');
    // Workflow name on the event top-level remains visible for filtering
    expect(startEvent!.workflow).toBe('secret-wf');
  });

  it('redacts workflow_end.result and workflow_end.error under trace.redact', async () => {
    const { workflow, AxlRuntime } = await import('../index.js');
    const runtime = new AxlRuntime({ trace: { redact: true } });
    const traces: AxlEvent[] = [];
    runtime.on('trace', (e) => traces.push(e));

    runtime.register(
      workflow({
        name: 'success-wf',
        input: z.any(),
        handler: async () => ({ email: 'user@acme.com' }),
      }),
    );
    runtime.register(
      workflow({
        name: 'failing-wf',
        input: z.any(),
        handler: async () => {
          throw new Error(`Failed to process user 'jane@acme.com'`);
        },
      }),
    );

    await runtime.execute('success-wf', {});
    await expect(runtime.execute('failing-wf', {})).rejects.toThrow();

    const successEnd = traces.find(
      (t): t is Extract<AxlEvent, { type: 'workflow_end' }> =>
        t.type === 'workflow_end' && t.workflow === 'success-wf',
    );
    const failedEnd = traces.find(
      (t): t is Extract<AxlEvent, { type: 'workflow_end' }> =>
        t.type === 'workflow_end' && t.workflow === 'failing-wf',
    );
    expect(successEnd).toBeDefined();
    expect(failedEnd).toBeDefined();

    const successData = successEnd!.data as Record<string, unknown>;
    // Result (potentially PII) scrubbed, structural fields stay visible
    expect(successData.result).toBe('[redacted]');
    expect(successData.status).toBe('completed');
    expect(typeof successData.duration).toBe('number');

    const failedData = failedEnd!.data as Record<string, unknown>;
    // Error message (echoes user data) scrubbed
    expect(failedData.error).toBe('[redacted]');
    expect(failedData.status).toBe('failed');
  });

  it('leaves workflow_start/end fields visible when trace.redact is off', async () => {
    const { workflow, AxlRuntime } = await import('../index.js');
    const runtime = new AxlRuntime();
    const traces: AxlEvent[] = [];
    runtime.on('trace', (e) => traces.push(e));

    runtime.register(
      workflow({
        name: 'open-wf',
        input: z.object({ greeting: z.string() }),
        handler: async (ctx) => `Hello, ${(ctx.input as { greeting: string }).greeting}`,
      }),
    );
    await runtime.execute('open-wf', { greeting: 'world' });

    const start = traces.find((t) => t.type === 'workflow_start');
    const end = traces.find((t) => t.type === 'workflow_end');
    expect((start!.data as Record<string, unknown>).input).toEqual({ greeting: 'world' });
    expect((end!.data as Record<string, unknown>).result).toBe('Hello, world');
  });

  it('auto-stamps workflow name on every trace event from a workflow context', async () => {
    // Regression for Gap B: previously only workflow_start/end had
    // `event.workflow` set. All other events (agent_call, log, etc.)
    // had it undefined in production, so Studio's byWorkflow.cost
    // accumulation was effectively broken. emitTrace now auto-stamps
    // from this.workflowName, so every event from a workflow context
    // carries the workflow name and cost-aggregation works end-to-end.
    const { workflow: mkWorkflow, AxlRuntime } = await import('../index.js');
    const runtime = new AxlRuntime();
    const traces: AxlEvent[] = [];
    runtime.on('trace', (e) => traces.push(e));

    runtime.register(
      mkWorkflow({
        name: 'attributed-wf',
        input: z.object({ anything: z.boolean() }),
        handler: async (ctx) => {
          ctx.log('custom_event', { foo: 'bar' });
          return 'ok';
        },
      }),
    );
    await runtime.execute('attributed-wf', { anything: true });

    // Every event emitted from inside the workflow should carry the name.
    const workflowEvents = traces.filter((t) => t.workflow === 'attributed-wf');
    expect(workflowEvents.length).toBeGreaterThanOrEqual(3);
    // Confirm at least workflow_start, workflow_end, and the user log event.
    expect(workflowEvents.find((t) => t.type === 'workflow_start')).toBeDefined();
    expect(workflowEvents.find((t) => t.type === 'workflow_end')).toBeDefined();
    expect(
      workflowEvents.find(
        (t) => t.type === 'log' && (t.data as Record<string, unknown>)?.event === 'custom_event',
      ),
    ).toBeDefined();
  });
});

describe('trace events — token redaction', () => {
  it('redacts token.data under trace.redact (closes three-layer contract gap)', async () => {
    // Reviewer bug: the core emit-time redactor had no `token` case.
    // Direct `runtime.on('trace', ...)` consumers bypassed the
    // Studio WS-layer `redactStreamEvent` scrub and received raw
    // LLM output. The CLAUDE.md three-layer contract (a) AxlEvents
    // at emitEvent emission (b) Studio REST serialization (c) Studio
    // WS — (a) must cover the highest-volume variant too.
    const { workflow, AxlRuntime, agent } = await import('../index.js');
    const { MockProvider } = await import('../../../axl-testing/src/mock-provider.js');
    const provider = MockProvider.sequence([
      { content: 'secret-response', chunks: ['secret-', 'response'] },
    ]);
    const runtime = new AxlRuntime({ defaultProvider: 'mock', trace: { redact: true } });
    runtime.registerProvider('mock', provider);
    const a = agent({ name: 'token-redact-test', model: 'mock:m', system: 'test' });
    runtime.register(
      workflow({
        name: 'token-redact-wf',
        input: z.object({}),
        handler: async (ctx) => ctx.ask(a, 'q'),
      }),
    );

    const tokens: Array<{ data: unknown }> = [];
    runtime.on('trace', (e: unknown) => {
      const ev = e as { type: string; data: unknown };
      if (ev.type === 'token') tokens.push(ev as { data: unknown });
    });

    // Streaming surfaces tokens
    const stream = runtime.stream('token-redact-wf', {});
    for await (const event of stream) {
      if (event.type === 'done') break;
    }

    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      expect(t.data).toBe('[redacted]');
      expect(t.data).not.toContain('secret');
    }
  });

  it('leaves token.data raw when trace.redact is off', async () => {
    const { workflow, AxlRuntime, agent } = await import('../index.js');
    const { MockProvider } = await import('../../../axl-testing/src/mock-provider.js');
    const provider = MockProvider.sequence([
      { content: 'visible-token', chunks: ['visible-', 'token'] },
    ]);
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const a = agent({ name: 'token-visible', model: 'mock:m', system: 'test' });
    runtime.register(
      workflow({
        name: 'token-visible-wf',
        input: z.object({}),
        handler: async (ctx) => ctx.ask(a, 'q'),
      }),
    );

    const tokenData: string[] = [];
    runtime.on('trace', (e: unknown) => {
      const ev = e as { type: string; data: unknown };
      if (ev.type === 'token' && typeof ev.data === 'string') tokenData.push(ev.data);
    });

    const stream = runtime.stream('token-visible-wf', {});
    for await (const event of stream) {
      if (event.type === 'done') break;
    }

    expect(tokenData.join('')).toBe('visible-token');
  });
});

describe('trace events — ask_start / ask_end redaction (spec/16 §3.8)', () => {
  it('redacts ask_start.prompt under trace.redact', async () => {
    const { agent, workflow, AxlRuntime } = await import('../index.js');
    const runtime = new AxlRuntime({ trace: { redact: true } });
    const traces: AxlEvent[] = [];
    runtime.on('trace', (e) => traces.push(e));

    const a = agent({ name: 'redact-ask', model: 'mock:m', system: 'sys' });
    runtime.registerProvider('mock', {
      name: 'mock',
      chat: async () => ({
        content: 'ok',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 0.001,
      }),
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    });
    runtime.register(
      workflow({
        name: 'redact-ask-wf',
        input: z.object({}),
        handler: async (ctx) => ctx.ask(a, 'sensitive-prompt-with-ssn-123-45-6789'),
      }),
    );
    await runtime.execute('redact-ask-wf', {});

    const askStart = traces.find((t) => t.type === 'ask_start') as
      | (AxlEvent & { type: 'ask_start'; prompt: string })
      | undefined;
    expect(askStart).toBeDefined();
    expect(askStart!.prompt).toBe('[redacted]');
  });

  it('redacts ask_end.outcome.result and outcome.error under trace.redact', async () => {
    const { agent, workflow, AxlRuntime } = await import('../index.js');
    const runtime = new AxlRuntime({ trace: { redact: true } });
    const traces: AxlEvent[] = [];
    runtime.on('trace', (e) => traces.push(e));

    const a = agent({ name: 'redact-end', model: 'mock:m', system: 'sys' });
    runtime.registerProvider('mock', {
      name: 'mock',
      chat: async () => ({
        content: 'sensitive-response-john@acme.com',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 0.001,
      }),
      stream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      },
    });
    runtime.register(
      workflow({
        name: 'redact-end-wf',
        input: z.object({}),
        handler: async (ctx) => ctx.ask(a, 'q'),
      }),
    );
    await runtime.execute('redact-end-wf', {});

    const askEnd = traces.find((t) => t.type === 'ask_end') as
      | (AxlEvent & {
          type: 'ask_end';
          outcome: { ok: true; result: unknown } | { ok: false; error: string };
          cost: number;
        })
      | undefined;
    expect(askEnd).toBeDefined();
    expect(askEnd!.outcome.ok).toBe(true);
    if (askEnd!.outcome.ok) {
      expect(askEnd!.outcome.result).toBe('[redacted]');
    }
    // Cost is structural metadata — never scrubbed.
    expect(askEnd!.cost).toBeGreaterThan(0);
  });
});

describe('trace events — redaction', () => {
  it('redacts sensitive fields on agent_call when trace.redact is true', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'secret system prompt' });
    const provider = createSequenceProvider([]);
    provider.chat = async () => ({
      content: 'final answer',
      thinking_content: 'secret thinking',
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      cost: 0.001,
    });
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', provider);
    const traces: AxlEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { level: 'full', redact: true } },
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
    });
    await ctx.ask(a, 'secret prompt');

    // Request-side fields (prompt, system, messages) live on agent_call_start.
    const startCall = traces.find((t) => t.type === 'agent_call_start');
    const startData = startCall!.data as Record<string, unknown>;
    expect(startData.prompt).toBe('[redacted]');
    expect(startData.system).toBe('[redacted]');
    // messages must stay an array so downstream narrowers don't crash
    expect(Array.isArray(startData.messages)).toBe(true);
    const messages = startData.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toMatch(/messages redacted/);
    // Non-sensitive structural fields remain visible on start
    expect(startData.turn).toBe(1);
    expect(startData.params).toBeDefined();

    // Response-side fields (response, thinking) live on agent_call_end.
    const endCall = traces.find((t) => t.type === 'agent_call_end');
    const endData = endCall!.data as Record<string, unknown>;
    expect(endData.response).toBe('[redacted]');
    expect(endData.thinking).toBe('[redacted]');
    expect(endData.turn).toBe(1);
  });

  it('redacts tool_call args and result when trace.redact is true', async () => {
    const myTool = tool({
      name: 'lookup_user',
      description: 'lookup',
      input: z.object({ ssn: z.string() }),
      handler: (input) => ({ name: 'John', ssn: input.ssn }),
    });
    const toolCalls: ToolCallMessage[] = [
      {
        id: 'tc1',
        type: 'function',
        function: { name: 'lookup_user', arguments: '{"ssn":"123-45-6789"}' },
      },
    ];
    const provider = createSequenceProvider([{ tool_calls: toolCalls }, 'done']);
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', provider);
    const traces: AxlEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { redact: true } },
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
    });
    const a = agent({ model: 'mock:test', system: 'sys', tools: [myTool] });
    await ctx.ask(a, 'lookup');

    const toolCallEvents = traces.filter((t) => t.type === 'tool_call_end');
    expect(toolCallEvents).toHaveLength(1);
    const data = toolCallEvents[0].data as Record<string, unknown>;
    expect(data.args).toBe('[redacted]');
    expect(data.result).toBe('[redacted]');
  });

  it('redacts tool_approval args when trace.redact is true', async () => {
    const myTool = tool({
      name: 'risky',
      description: 'risky',
      input: z.object({ ssn: z.string() }),
      handler: (input) => `ok ${input.ssn}`,
      requireApproval: true,
    });
    const toolCalls: ToolCallMessage[] = [
      {
        id: 'tc1',
        type: 'function',
        function: { name: 'risky', arguments: '{"ssn":"123-45-6789"}' },
      },
    ];
    const provider = createSequenceProvider([{ tool_calls: toolCalls }, 'done']);
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', provider);
    const traces: AxlEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { redact: true } },
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
      awaitHumanHandler: async () => ({ approved: true }),
    });
    const a = agent({ model: 'mock:test', system: 'sys', tools: [myTool] });
    await ctx.ask(a, 'approve');

    const approvals = traces.filter((t) => t.type === 'tool_approval');
    expect(approvals).toHaveLength(1);
    const data = approvals[0].data as Record<string, unknown>;
    expect(data.args).toBe('[redacted]');
  });

  it('redacts handoff roundtrip message when trace.redact is true', async () => {
    const target = agent({ name: 'target', model: 'mock:test', system: 'target' });
    const source = agent({
      name: 'source',
      model: 'mock:test',
      system: 'source',
      handoffs: [{ agent: target, mode: 'roundtrip' }],
    });
    const handoffCall: ToolCallMessage[] = [
      {
        id: 'h1',
        type: 'function',
        function: { name: 'handoff_to_target', arguments: '{"message":"user@acme.com details"}' },
      },
    ];
    const provider = createSequenceProvider([{ tool_calls: handoffCall }, 'fetched', 'done']);
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', provider);
    const traces: AxlEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { redact: true } },
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
    });
    await ctx.ask(source, 'help');

    // Redaction applies to `handoff_start.data.message` — the user-supplied
    // roundtrip content. Structural fields (source/target/mode) are never
    // scrubbed.
    const handoffs = traces.filter((t) => t.type === 'handoff_start');
    expect(handoffs).toHaveLength(1);
    const data = handoffs[0].data as Record<string, unknown>;
    // Structural fields stay
    expect(data.target).toBe('target');
    expect(data.source).toBe('source');
    expect(data.mode).toBe('roundtrip');
    // User-supplied message scrubbed
    expect(data.message).toBe('[redacted]');
  });

  it('redacts log event string fields but preserves event name', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'sys' });
    const provider = createSequenceProvider(['ok']);
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', provider);
    const traces: AxlEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { redact: true } },
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
    });
    ctx.log('user_action', { detail: 'john@acme.com clicked submit', count: 42 });
    await ctx.ask(a, 'hi');

    const logEvents = traces.filter((t) => t.type === 'log');
    const userLog = logEvents.find(
      (t) => (t.data as Record<string, unknown>)?.event === 'user_action',
    );
    expect(userLog).toBeDefined();
    const data = userLog!.data as Record<string, unknown>;
    // event name preserved
    expect(data.event).toBe('user_action');
    // string field redacted
    expect(data.detail).toBe('[redacted]');
    // numeric field preserved
    expect(data.count).toBe(42);
  });

  it('redacts feedbackMessage on gate events when trace.redact is true', async () => {
    const a = agent({ model: 'mock:test', system: 'sys' });
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', createSequenceProvider(['not json', '{"answer":"ok"}']));
    const traces: AxlEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { redact: true } },
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
    });
    await ctx.ask(a, 'hi', { schema: z.object({ answer: z.string() }) });

    const failed = traces.find(
      (t): t is Extract<AxlEvent, { type: 'schema_check' }> =>
        t.type === 'schema_check' && (t.data as Record<string, unknown>).valid === false,
    );
    expect(failed).toBeDefined();
    const data = failed!.data as Record<string, unknown>;
    expect(data.feedbackMessage).toBe('[redacted]');
    // `reason` can echo user input — must also be redacted
    expect(data.reason).toBe('[redacted]');
    // Structural fields still visible
    expect(data.attempt).toBe(1);
    expect(data.maxAttempts).toBe(4);
  });
});
