import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { randomUUID } from 'node:crypto';
import type { TraceEvent, ToolCallMessage } from '../types.js';
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

    const agentCall = traces.find((t) => t.type === 'agent_call');
    expect(agentCall).toBeDefined();
    const data = agentCall!.data as Record<string, unknown>;
    expect(data.system).toBe('You are a helpful assistant.');
    expect(data.turn).toBe(1);
    const params = data.params as Record<string, unknown>;
    expect(params.temperature).toBe(0.5);
    expect(params.maxTokens).toBe(1024);
    expect(params.effort).toBe('low');
    expect(params.toolChoice).toBe('auto');
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

    const agentCall = traces.find((t) => t.type === 'agent_call');
    expect((agentCall!.data as Record<string, unknown>).system).toBe('Tenant: acme');
  });

  it('omits messages snapshot by default (verbose off)', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'sys' });
    const { ctx, traces } = createTestCtx({ provider: createSequenceProvider(['ok']) });
    await ctx.ask(a, 'hi');

    const agentCall = traces.find((t) => t.type === 'agent_call');
    expect((agentCall!.data as Record<string, unknown>).messages).toBeUndefined();
  });

  it('includes messages snapshot when trace.level === full', async () => {
    const a = agent({ name: 'a', model: 'mock:test', system: 'you are helpful' });
    const provider = createSequenceProvider(['ok']);
    const registry = new ProviderRegistry();
    registry.registerInstance('mock', provider);
    const traces: TraceEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { level: 'full' } },
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
    });
    await ctx.ask(a, 'hi');

    const agentCall = traces.find((t) => t.type === 'agent_call');
    const data = agentCall!.data as Record<string, unknown>;
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

    const agentCall = traces.find((t) => t.type === 'agent_call');
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

    const calls = traces.filter((t) => t.type === 'agent_call');
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
    const traces: TraceEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { level: 'full' } },
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
    });
    await ctx.ask(a, 'hi', { schema: z.object({ answer: z.string() }) });

    const calls = traces.filter((t) => t.type === 'agent_call');
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
  it('stamps parentToolCallId on nested agent_call events so consumers can join to the outer tool_call', async () => {
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

    // The outer tool_call gets the `callId: 'outer-tc-1'` on its data,
    // and any nested trace events (e.g. child agent_call) carry the same
    // id as `parentToolCallId` at the top level.
    const outerToolCall = traces.find((t) => t.type === 'tool_call' && t.tool === 'nested_call');
    expect(outerToolCall).toBeDefined();

    const childEvents = traces.filter((t) => t.parentToolCallId === 'outer-tc-1');
    expect(childEvents.length).toBeGreaterThan(0);
    // The child agent's LLM call should be in that set
    const childAgentCall = childEvents.find((t) => t.type === 'agent_call' && t.agent === 'child');
    expect(childAgentCall).toBeDefined();
    // Outer parent agent_call should NOT carry parentToolCallId
    const parentAgentCall = traces.find((t) => t.type === 'agent_call' && t.agent === 'parent');
    expect(parentAgentCall!.parentToolCallId).toBeUndefined();
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
    const calls = traces.filter((t) => t.type === 'agent_call');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect((call.data as Record<string, unknown>).retryReason).toBeUndefined();
    }
    // Child agent's call should show system: 'child system', not 'parent'
    const childCall = calls.find((c) => c.agent === 'child');
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
    const traces: TraceEvent[] = [];
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
    const call = traces.find((t) => t.type === 'agent_call');
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
      (t) =>
        t.type === 'guardrail' && (t.data as Record<string, unknown>)?.guardrailType === 'output',
    );
    expect(outputChecks).toHaveLength(2);
    const first = outputChecks[0].data as Record<string, unknown>;
    expect(first.blocked).toBe(true);
    expect(first.attempt).toBe(1);
    expect(first.maxAttempts).toBe(3);
    expect(first.feedbackMessage).toContain('blocked by a safety guardrail');

    // Second agent_call should be tagged as a guardrail retry
    const calls = traces.filter((t) => t.type === 'agent_call');
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

    const calls = traces.filter((t) => t.type === 'agent_call');
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

    const calls = traces.filter((t) => t.type === 'agent_call');
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

    const handoffs = traces.filter((t) => t.type === 'handoff');
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

    const handoffs = traces.filter((t) => t.type === 'handoff');
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
    const traces: TraceEvent[] = [];
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
    const traces: TraceEvent[] = [];
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

    const successEnd = traces.find((t) => t.type === 'workflow_end' && t.workflow === 'success-wf');
    const failedEnd = traces.find((t) => t.type === 'workflow_end' && t.workflow === 'failing-wf');
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
    const traces: TraceEvent[] = [];
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
    const traces: TraceEvent[] = [];
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
    const traces: TraceEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { level: 'full', redact: true } },
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
    });
    await ctx.ask(a, 'secret prompt');

    const agentCall = traces.find((t) => t.type === 'agent_call');
    const data = agentCall!.data as Record<string, unknown>;
    expect(data.prompt).toBe('[redacted]');
    expect(data.response).toBe('[redacted]');
    expect(data.system).toBe('[redacted]');
    expect(data.thinking).toBe('[redacted]');
    // messages must stay an array so downstream narrowers don't crash
    expect(Array.isArray(data.messages)).toBe(true);
    const messages = data.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toMatch(/messages redacted/);
    // Non-sensitive structural fields remain visible
    expect(data.turn).toBe(1);
    expect(data.params).toBeDefined();
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
    const traces: TraceEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { redact: true } },
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
    });
    const a = agent({ model: 'mock:test', system: 'sys', tools: [myTool] });
    await ctx.ask(a, 'lookup');

    const toolCallEvents = traces.filter((t) => t.type === 'tool_call');
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
    const traces: TraceEvent[] = [];
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
    const traces: TraceEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { redact: true } },
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
    });
    await ctx.ask(source, 'help');

    const handoffs = traces.filter((t) => t.type === 'handoff');
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
    const traces: TraceEvent[] = [];
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
    const traces: TraceEvent[] = [];
    const ctx = new WorkflowContext({
      input: 'test',
      executionId: randomUUID(),
      config: { trace: { redact: true } },
      providerRegistry: registry,
      onTrace: (e) => traces.push(e),
    });
    await ctx.ask(a, 'hi', { schema: z.object({ answer: z.string() }) });

    const failed = traces.find(
      (t) => t.type === 'schema_check' && (t.data as Record<string, unknown>).valid === false,
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
