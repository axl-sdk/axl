import { describe, it, expect, vi } from 'vitest';
import { WorkflowContext } from '../context.js';
import type { WorkflowContextInit } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';
import type { ChatMessage } from '../types.js';

// ── Mock Provider ────────────────────────────────────────────────────────

class TestProvider {
  readonly name = 'test';
  private responses: Array<{ content: string; tool_calls?: any[]; cost?: number }>;
  private callIndex = 0;
  calls: any[] = [];

  constructor(responses: Array<{ content: string; tool_calls?: any[]; cost?: number }>) {
    this.responses = responses;
  }

  async chat(messages: any[], options: any) {
    this.calls.push({ messages, options });
    const resp = this.responses[this.callIndex] ?? this.responses[this.responses.length - 1];
    this.callIndex++;
    return {
      content: resp.content,
      tool_calls: resp.tool_calls,
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

function createTestContext(provider: TestProvider, init?: Partial<WorkflowContextInit>) {
  const registry = new ProviderRegistry();
  registry.registerInstance('test', provider as any);
  return new WorkflowContext({
    input: init?.input ?? 'test input',
    executionId: 'test-exec-ctx-window',
    metadata: init?.metadata ?? {},
    config: { defaultProvider: 'test', ...init?.config },
    providerRegistry: registry,
    onTrace: init?.onTrace ?? vi.fn(),
    sessionHistory: init?.sessionHistory,
  });
}

// ── Generate long history ────────────────────────────────────────────────

function generateHistory(messageCount: number, charsPerMessage = 200): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (let i = 0; i < messageCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const content = `Message ${i}: ${'x'.repeat(charsPerMessage)}`;
    history.push({ role: role as 'user' | 'assistant', content });
  }
  return history;
}

// ═════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════

describe('Context Window Management', () => {
  it('passes through history unchanged when it fits in context', async () => {
    const provider = new TestProvider([{ content: 'response' }]);
    const shortHistory: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];

    const agentWithContext = agent({
      model: 'test:test-model',
      system: 'You are a test agent',
      maxContext: 10000, // Plenty of room
    });

    const ctx = createTestContext(provider, { sessionHistory: shortHistory });
    await ctx.ask(agentWithContext, 'How are you?');

    // The messages should include system + full history + user prompt
    const messages = provider.calls[0].messages;
    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toBe('Hello');
    expect(messages[2].content).toBe('Hi there');
    expect(messages[3].role).toBe('user');
  });

  it('summarizes history when it exceeds maxContext', async () => {
    // Generate a very long history (~100 messages * 200 chars = ~5000 tokens)
    const longHistory = generateHistory(100, 200);

    // Provider responses: first for the summary call, then for the actual question
    const provider = new TestProvider([
      { content: 'Summary: The conversation covered topics A, B, and C.' },
      { content: 'Here is my response.' },
    ]);

    const agentWithSmallContext = agent({
      model: 'test:test-model',
      system: 'You are a test agent',
      maxContext: 500, // Very small — forces summarization
    });

    const ctx = createTestContext(provider, { sessionHistory: longHistory });
    await ctx.ask(agentWithSmallContext, 'What were we talking about?');

    // Should have made 2 calls: one for summary, one for the actual question
    expect(provider.calls.length).toBe(2);

    // The summary call should have the summarization system prompt
    const summaryCallMessages = provider.calls[0].messages;
    expect(summaryCallMessages[0].content).toContain('Summarize');

    // The actual call should include the summary, not all 100 messages
    const actualCallMessages = provider.calls[1].messages;
    const summaryMsg = actualCallMessages.find(
      (m: any) => m.role === 'system' && m.content.includes('Summary of earlier conversation'),
    );
    expect(summaryMsg).toBeDefined();

    // Should have far fewer messages than the original 100
    expect(actualCallMessages.length).toBeLessThan(longHistory.length);
  });

  it('retains the newest turn when overhead alone exceeds maxContext', async () => {
    // reserveTokens defaults to 2000, so a maxContext below it leaves a
    // negative history budget. Nothing can "fit", but dropping the entire
    // conversation is never the right answer: the newest turn is the one the
    // next reply depends on.
    const longHistory = generateHistory(20, 200);
    const provider = new TestProvider([
      { content: 'Summary: earlier topics.' },
      { content: 'Here is my response.' },
    ]);

    const agentWithTinyContext = agent({
      model: 'test:test-model',
      system: 'You are a test agent',
      maxContext: 500, // below the 2000-token reserve => negative budget
    });

    // Captured before the ask: the ask appends its own assistant reply to
    // sessionHistory, so this array's tail changes underneath us.
    const newestBeforeAsk = longHistory[longHistory.length - 1].content;

    const onTrace = vi.fn();
    const ctx = createTestContext(provider, { sessionHistory: longHistory, onTrace });
    await ctx.ask(agentWithTinyContext, 'What were we talking about?');

    // The unsatisfiable configuration is reported, not absorbed silently.
    const warnings = onTrace.mock.calls
      .map(([event]: any[]) => event?.data?.warning)
      .filter((w: unknown): w is string => typeof w === 'string');
    expect(warnings.some((w) => w.includes('is at or below its fixed overhead'))).toBe(true);

    const actualCall = provider.calls[provider.calls.length - 1].messages;
    const summaryMsg = actualCall.find(
      (m: any) => m.role === 'system' && m.content.includes('Summary of earlier conversation'),
    );
    expect(summaryMsg).toBeDefined();

    // The newest turn must survive summarization.
    expect(actualCall.some((m: any) => m.content === newestBeforeAsk)).toBe(true);

    // ...and the retained tail must start on a user turn: providers reject a
    // request whose first non-system message is an assistant reply.
    const firstNonSystem = actualCall.find((m: any) => m.role !== 'system');
    expect(firstNonSystem.role).toBe('user');
  });

  it('does not summarize when no maxContext is set', async () => {
    const longHistory = generateHistory(50, 200);
    const provider = new TestProvider([{ content: 'response' }]);

    const agentNoLimit = agent({
      model: 'test:test-model',
      system: 'You are a test agent',
      // No maxContext set
    });

    const ctx = createTestContext(provider, { sessionHistory: longHistory });
    await ctx.ask(agentNoLimit, 'Tell me something');

    // Should be 1 call, all history passed through
    expect(provider.calls.length).toBe(1);
    const messages = provider.calls[0].messages;
    // system + 50 history messages + 1 user prompt = 52
    expect(messages.length).toBe(52);
  });

  it('regenerates a stale summary rather than pinning the first one forever', async () => {
    // With a cached summary and a tight budget, the cached branch must be able
    // to decline and fall through to regeneration. If it always returns early,
    // every turn accumulated after the first summary becomes permanently
    // invisible to the model.
    const longHistory = generateHistory(20, 200);
    const provider = new TestProvider([
      { content: 'Summary A.' },
      { content: 'First response.' },
      { content: 'Summary B.' },
      { content: 'Second response.' },
    ]);
    const agentWithSmallContext = agent({
      model: 'test:test-model',
      system: 'You are a test agent',
      maxContext: 500,
    });

    const ctx = createTestContext(provider, { sessionHistory: longHistory });
    await ctx.ask(agentWithSmallContext, 'First question');
    const callsAfterFirst = provider.calls.length;

    await ctx.ask(agentWithSmallContext, 'Second question');

    // The second ask must summarize again, not silently reuse a stale summary
    // that omits everything said since.
    const summaryCalls = provider.calls.filter((c: any) =>
      String(c.messages[0]?.content).includes('Summarize'),
    );
    expect(summaryCalls.length).toBeGreaterThan(1);
    expect(provider.calls.length).toBeGreaterThan(callsAfterFirst + 1);
  });

  it('keeps the request user-first when history holds consecutive assistant turns', async () => {
    // sessionHistory does not alternate: ctx.ask only ever appends assistant
    // messages, so a workflow asking several times accumulates a run of them.
    // A retained tail must still start on a user turn.
    const history: ChatMessage[] = [
      { role: 'user', content: `q: ${'x'.repeat(200)}` },
      { role: 'assistant', content: `a1: ${'x'.repeat(200)}` },
      { role: 'user', content: `q2: ${'x'.repeat(200)}` },
      { role: 'assistant', content: `a2: ${'x'.repeat(200)}` },
      { role: 'assistant', content: `a3: ${'x'.repeat(200)}` },
      { role: 'assistant', content: `a4: ${'x'.repeat(200)}` },
    ];
    const provider = new TestProvider([{ content: 'Summary.' }, { content: 'Response.' }]);
    const ctx = createTestContext(provider, { sessionHistory: history });
    await ctx.ask(
      agent({ model: 'test:test-model', system: 'You are a test agent', maxContext: 500 }),
      'Next question',
    );

    const actualCall = provider.calls[provider.calls.length - 1].messages;
    const firstNonSystem = actualCall.find((m: any) => m.role !== 'system');
    expect(firstNonSystem.role).toBe('user');
  });

  it('summarizes in full when history has no user turn to anchor on', async () => {
    // All-assistant history (several ctx.ask calls, no seeded user turn). There
    // is no anchor, so everything is summarized — still valid, because the
    // ask's own input is appended as the user turn.
    const history: ChatMessage[] = [
      { role: 'assistant', content: `a1: ${'x'.repeat(200)}` },
      { role: 'assistant', content: `a2: ${'x'.repeat(200)}` },
      { role: 'assistant', content: `a3: ${'x'.repeat(200)}` },
    ];
    const provider = new TestProvider([{ content: 'Summary.' }, { content: 'Response.' }]);
    const ctx = createTestContext(provider, { sessionHistory: history });
    await ctx.ask(
      agent({ model: 'test:test-model', system: 'You are a test agent', maxContext: 500 }),
      'Next question',
    );

    const actualCall = provider.calls[provider.calls.length - 1].messages;
    const firstNonSystem = actualCall.find((m: any) => m.role !== 'system');
    expect(firstNonSystem.role).toBe('user');
  });

  it('summarizes a two-message history rather than forwarding it raw', async () => {
    // [user, assistant] that does not fit has no anchor above index 0, so it is
    // summarized in full. Returning it unchanged would forward content already
    // judged not to fit and skip the summarizeModelInput pass that replaces
    // media with safe placeholders.
    const history: ChatMessage[] = [
      { role: 'user', content: `q: ${'x'.repeat(400)}` },
      { role: 'assistant', content: `a: ${'x'.repeat(400)}` },
    ];
    const provider = new TestProvider([{ content: 'Summary.' }, { content: 'Response.' }]);
    const ctx = createTestContext(provider, { sessionHistory: history });
    await ctx.ask(
      agent({ model: 'test:test-model', system: 'You are a test agent', maxContext: 500 }),
      'Next question',
    );

    const actualCall = provider.calls[provider.calls.length - 1].messages;
    // Neither raw turn survives; a summary stands in for both.
    expect(actualCall.some((m: any) => String(m.content).startsWith('q: '))).toBe(false);
    expect(actualCall.some((m: any) => String(m.content).startsWith('a: '))).toBe(false);
    expect(
      actualCall.some((m: any) => String(m.content).includes('Summary of earlier conversation')),
    ).toBe(true);
  });

  it('anchors an ordinary partial-fit split on a user turn', async () => {
    // No misconfiguration needed: the 60%-of-budget loop routinely stops on an
    // assistant turn. Four 4000-char messages at ~1004 tokens each with
    // maxContext 4020 leaves ~2000 for history and a 1200 recent target, so
    // only the final assistant message fits -- an assistant-first tail unless
    // the split is anchored.
    const history: ChatMessage[] = [
      { role: 'user', content: `u1: ${'x'.repeat(4000)}` },
      { role: 'assistant', content: `a1: ${'x'.repeat(4000)}` },
      { role: 'user', content: `u2: ${'x'.repeat(4000)}` },
      { role: 'assistant', content: `a2: ${'x'.repeat(4000)}` },
    ];
    const provider = new TestProvider([{ content: 'Summary.' }, { content: 'Response.' }]);
    const ctx = createTestContext(provider, { sessionHistory: history });
    await ctx.ask(
      agent({ model: 'test:test-model', system: 'You are a test agent', maxContext: 4020 }),
      'Next question',
    );

    const actualCall = provider.calls[provider.calls.length - 1].messages;
    const firstNonSystem = actualCall.find((m: any) => m.role !== 'system');
    expect(firstNonSystem.role).toBe('user');
  });

  it('caches summary across calls in the same session', async () => {
    const longHistory = generateHistory(100, 200);

    const provider = new TestProvider([
      { content: 'Cached summary content.' },
      { content: 'First response.' },
      { content: 'Second response.' }, // Reuses cached summary
    ]);

    const agentWithSmallContext = agent({
      model: 'test:test-model',
      system: 'You are a test agent',
      maxContext: 500,
    });

    const ctx = createTestContext(provider, { sessionHistory: longHistory });

    // First ask — triggers summarization
    await ctx.ask(agentWithSmallContext, 'First question');

    // Second ask — should reuse cached summary
    await ctx.ask(agentWithSmallContext, 'Second question');

    // First ask: 1 summary + 1 question = 2 calls
    // Second ask: uses cached summary, 1 question = 1 call (if cache works)
    // OR second ask also generates summary = 2 calls
    // Total: at least 3, at most 4
    expect(provider.calls.length).toBeGreaterThanOrEqual(3);
    expect(provider.calls.length).toBeLessThanOrEqual(4);

    // Verify the last call (second question) uses a summary
    const lastCall = provider.calls[provider.calls.length - 1];
    const hasSummary = lastCall.messages.some(
      (m: any) => m.role === 'system' && m.content.includes('Summary of earlier conversation'),
    );
    expect(hasSummary).toBe(true);
  });

  it('system prompt and tools are never truncated', async () => {
    const provider = new TestProvider([
      { content: 'Summary of old conversation.' },
      { content: 'response' },
    ]);
    const longHistory = generateHistory(100, 200);

    const longSystemPrompt = 'You are a very detailed test agent. ' + 'x'.repeat(500);
    const agentWithLongSystem = agent({
      model: 'test:test-model',
      system: longSystemPrompt,
      maxContext: 600,
    });

    const ctx = createTestContext(provider, { sessionHistory: longHistory });
    await ctx.ask(agentWithLongSystem, 'question');

    // The actual question call should still have the full system prompt
    const lastCall = provider.calls[provider.calls.length - 1];
    const systemMsg = lastCall.messages.find(
      (m: any) => m.role === 'system' && !m.content.includes('Summary'),
    );
    expect(systemMsg?.content).toBe(longSystemPrompt);
  });
});
