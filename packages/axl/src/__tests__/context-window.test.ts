import { describe, it, expect, vi } from 'vitest';
import { WorkflowContext } from '../context.js';
import type { WorkflowContextInit } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import type { ChatMessage } from '../types.js';
import { MemoryStore } from '../state/memory.js';
import { z } from 'zod';

// ── Mock Provider ────────────────────────────────────────────────────────

class TestProvider {
  readonly name = 'test';
  private responses: Array<{
    content: string;
    tool_calls?: any[];
    cost?: number;
    providerMetadata?: Record<string, unknown>;
  }>;
  private callIndex = 0;
  calls: any[] = [];

  constructor(
    responses: Array<{
      content: string;
      tool_calls?: any[];
      cost?: number;
      providerMetadata?: Record<string, unknown>;
    }>,
  ) {
    this.responses = responses;
  }

  async chat(messages: any[], options: any) {
    this.calls.push({ messages, options });
    const resp = this.responses[this.callIndex] ?? this.responses[this.responses.length - 1];
    this.callIndex++;
    return {
      content: resp.content,
      tool_calls: resp.tool_calls,
      providerMetadata: resp.providerMetadata,
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
    executionId: init?.executionId ?? 'test-exec-ctx-window',
    metadata: init?.metadata ?? {},
    config: { defaultProvider: 'test', ...init?.config },
    providerRegistry: registry,
    onTrace: init?.onTrace ?? vi.fn(),
    sessionHistory: init?.sessionHistory,
    stateStore: init?.stateStore,
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
  it.each([undefined, 10000])(
    'includes a stored session summary when maxContext is %s and history fits',
    async (maxContext) => {
      const provider = new TestProvider([{ content: 'response' }]);
      const ctx = createTestContext(provider, {
        metadata: { summaryCache: 'The user chose blue.' },
        sessionHistory: [{ role: 'user', content: 'What color did I choose?' }],
      });
      await ctx.ask(agent({ model: 'test:test-model', maxContext }), 'Please answer');

      expect(provider.calls[0].messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: 'Summary of earlier conversation:\nThe user chose blue.',
          }),
        ]),
      );
    },
  );

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

  it('never moves a cached tail past messages the summary did not cover', async () => {
    const history = generateHistory(24, 400);
    const provider = new TestProvider([
      { content: 'First summary.' },
      { content: 'First answer.' },
      { content: 'Second summary.' },
      { content: 'Second answer.' },
    ]);
    const ctx = createTestContext(provider, { sessionHistory: history });
    const compactAgent = agent({ model: 'test:test-model', maxContext: 3300 });

    await ctx.ask(compactAgent, 'First question');
    const firstAnswer = provider.calls[1].messages;
    const retained = firstAnswer.filter((m: ChatMessage) => m.role !== 'system');
    const displacedFact = retained[0].content as string;

    // A later user turn gives the old cache implementation a new anchor. Its
    // sliding suffix could skip displacedFact without adding it to the summary.
    for (let i = 0; i < 12; i++) {
      history.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `new-${i}: ${'y'.repeat(400)}`,
      });
    }
    await ctx.ask(compactAgent, 'Second question');

    const laterSummaryCalls = provider.calls
      .slice(2)
      .filter((call) => String(call.messages[0]?.content).includes('Summarize'));
    const secondAnswer = provider.calls[provider.calls.length - 1].messages;
    expect(
      laterSummaryCalls.some((call) => String(call.messages[1]?.content).includes(displacedFact)) ||
        secondAnswer.some((message: ChatMessage) => message.content === displacedFact),
    ).toBe(true);
  });

  it('invalidates an ask summary when its covered history changes in place', async () => {
    const history = generateHistory(24, 400);
    const provider = new TestProvider([
      { content: 'First summary.' },
      { content: 'First answer.' },
      { content: 'Updated summary.' },
      { content: 'Second answer.' },
    ]);
    const ctx = createTestContext(provider, { sessionHistory: history });
    const compactAgent = agent({ model: 'test:test-model', maxContext: 3300 });

    await ctx.ask(compactAgent, 'First question');
    history[0].content = 'Changed covered fact';
    await ctx.ask(compactAgent, 'Second question');

    const summaryCalls = provider.calls.filter((call) =>
      String(call.messages[0]?.content).includes('Summarize'),
    );
    expect(summaryCalls).toHaveLength(2);
    expect(String(summaryCalls[1].messages[1].content)).toContain('Changed covered fact');
  });

  it('invalidates an ask summary when its summary model changes', async () => {
    const provider = new TestProvider([
      { content: 'First summary.' },
      { content: 'First answer.' },
      { content: 'Updated summary.' },
      { content: 'Second answer.' },
    ]);
    const ctx = createTestContext(provider, { sessionHistory: generateHistory(24, 400) });

    await ctx.ask(agent({ model: 'test:first-model', maxContext: 3300 }), 'First question');
    await ctx.ask(agent({ model: 'test:second-model', maxContext: 3300 }), 'Second question');

    const summaryCalls = provider.calls.filter((call) =>
      String(call.messages[0]?.content).includes('Summarize'),
    );
    expect(summaryCalls.map((call) => call.options.model)).toEqual(['first-model', 'second-model']);
  });

  it('keeps a stored session summary separate from ask projection and large-agent history', async () => {
    const store = new MemoryStore();
    await store.saveSessionMeta('summary-session', 'summaryCache', 'Durable fact: blue');
    const history = generateHistory(24, 400);
    const provider = new TestProvider([
      { content: 'Temporary ask summary.' },
      { content: 'Small answer.' },
      { content: 'Large answer.' },
    ]);
    const ctx = createTestContext(provider, {
      metadata: { sessionId: 'summary-session', summaryCache: 'Durable fact: blue' },
      sessionHistory: history,
      stateStore: store,
    });

    await ctx.ask(agent({ model: 'test:test-model', maxContext: 3300 }), 'Small question');
    expect(String(provider.calls[0].messages[1].content)).toContain('Durable fact: blue');
    expect(await store.getSessionMeta('summary-session', 'summaryCache')).toBe(
      'Durable fact: blue',
    );

    await ctx.ask(agent({ model: 'test:test-model', maxContext: 10000 }), 'Large question');
    const largeRequest = provider.calls[provider.calls.length - 1].messages;
    expect(
      largeRequest.some((m: ChatMessage) => String(m.content).includes('Durable fact: blue')),
    ).toBe(true);
    expect(largeRequest.some((m: ChatMessage) => String(m.content).includes('Message 0:'))).toBe(
      true,
    );
  });

  it('removes stale Anthropic thinking from a compacted tail but keeps later thinking', async () => {
    const history = generateHistory(24, 400);
    history[history.length - 1].providerMetadata = {
      anthropicThinkingBlocks: [{ type: 'thinking', thinking: 'old', signature: 'old-signature' }],
      otherProviderKey: 'keep',
    };
    const provider = new TestProvider([
      { content: 'Summary.' },
      {
        content: 'First answer.',
        providerMetadata: {
          anthropicThinkingBlocks: [
            { type: 'thinking', thinking: 'new', signature: 'new-signature' },
          ],
        },
      },
      { content: 'Second answer.' },
    ]);
    const ctx = createTestContext(provider, { sessionHistory: history });
    const compactAgent = agent({ model: 'test:test-model', maxContext: 3300 });

    await ctx.ask(compactAgent, 'First question');
    const firstRequest = provider.calls[1].messages;
    const oldTurn = firstRequest.find((m: ChatMessage) => m.content === history[23].content);
    expect(oldTurn.providerMetadata).toEqual({ otherProviderKey: 'keep' });
    expect(history[23].providerMetadata).toHaveProperty('anthropicThinkingBlocks');

    await ctx.ask(compactAgent, 'Second question');
    const secondRequest = provider.calls[provider.calls.length - 1].messages;
    const newTurn = secondRequest.find((m: ChatMessage) => m.content === 'First answer.');
    expect(newTurn?.providerMetadata?.anthropicThinkingBlocks).toBeDefined();
  });

  it('keeps thinking produced by an active tool turn after summarization', async () => {
    const provider = new TestProvider([
      { content: 'Summary.' },
      {
        content: 'Calling the tool',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          },
        ],
        providerMetadata: {
          anthropicThinkingBlocks: [
            { type: 'thinking', thinking: 'active', signature: 'active-signature' },
          ],
        },
      },
      { content: 'Done.' },
    ]);
    const ctx = createTestContext(provider, { sessionHistory: generateHistory(24, 400) });
    const lookup = tool({ name: 'lookup', input: z.object({}), handler: () => 'found' });

    await ctx.ask(
      agent({ model: 'test:test-model', maxContext: 3300, tools: [lookup] }),
      'Use the lookup tool',
    );

    const continuation = provider.calls[2].messages;
    const activeTurn = continuation.find(
      (m: ChatMessage) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'call-1',
    );
    expect(activeTurn.providerMetadata.anthropicThinkingBlocks).toEqual([
      { type: 'thinking', thinking: 'active', signature: 'active-signature' },
    ]);
    expect(continuation.some((m: ChatMessage) => m.role === 'tool')).toBe(true);
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

  it('keeps the agent system prompt first and injected system messages after it', async () => {
    // The Anthropic adapter places its prompt-cache breakpoint on the FIRST
    // system block on the strength of this ordering: the agent's own prompt is
    // pushed before history, and the rolling summary is appended later as a
    // separate system message. If either moved, a summarizing session would
    // re-write the cache every turn.
    const longHistory = generateHistory(40, 200);
    const provider = new TestProvider([{ content: 'Summary.' }, { content: 'Response.' }]);
    const ctx = createTestContext(provider, { sessionHistory: longHistory });
    await ctx.ask(
      agent({ model: 'test:test-model', system: 'AGENT PROMPT', maxContext: 500 }),
      'Question',
    );

    const sent = provider.calls[provider.calls.length - 1].messages;
    const systemIdx = sent
      .map((m: any, i: number) => (m.role === 'system' ? i : -1))
      .filter((i: number) => i >= 0);
    expect(systemIdx.length).toBeGreaterThanOrEqual(2);
    expect(sent[systemIdx[0]].content).toBe('AGENT PROMPT');
    expect(sent[systemIdx[0]].origin).toBeUndefined();
    expect(String(sent[systemIdx[1]].content)).toContain('Summary of earlier conversation');
    // The runtime marks what it synthesizes so adapters never anchor on it.
    expect(sent[systemIdx[1]].origin).toBe('runtime');
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

  describe('persisted ask summaries', () => {
    const SUMMARY_SYSTEM =
      'Summarize the following conversation concisely, preserving key facts, decisions, and context needed for continuing the conversation.';
    const isSummaryCall = (call: any) => call.messages[0]?.content === SUMMARY_SYSTEM;

    /** A JSON-backed store that also reverses object key order on every read,
     * the way a jsonb column or a hand-rolled store might. The ask-summary
     * boundary must survive that round trip. */
    class ReorderingJsonStore extends MemoryStore {
      private static reorder(value: unknown): unknown {
        if (Array.isArray(value)) return value.map((v) => ReorderingJsonStore.reorder(v));
        if (value && typeof value === 'object') {
          return Object.fromEntries(
            Object.keys(value)
              .reverse()
              .map((k) => [k, ReorderingJsonStore.reorder((value as any)[k])]),
          );
        }
        return value;
      }
      override async getSession(id: string): Promise<ChatMessage[]> {
        const raw = JSON.parse(JSON.stringify(await super.getSession(id)));
        return ReorderingJsonStore.reorder(raw) as ChatMessage[];
      }
      override async getSessionMeta(id: string, key: string): Promise<unknown | null> {
        const value = await super.getSessionMeta(id, key);
        return value === null
          ? null
          : ReorderingJsonStore.reorder(JSON.parse(JSON.stringify(value)));
      }
    }

    async function firstExecution(
      store: MemoryStore,
      options: { history?: ChatMessage[]; agentName?: string } = {},
    ) {
      const history = options.history ?? generateHistory(24, 400);
      history.push({ role: 'user', content: 'First question' });
      const provider = new TestProvider([
        { content: 'Persisted summary.' },
        { content: 'First answer.' },
      ]);
      const ctx = createTestContext(provider, {
        metadata: { sessionId: 'persisted-session' },
        sessionHistory: history,
        stateStore: store,
      });
      await ctx.ask(
        agent({ name: options.agentName ?? 'compact', model: 'test:test-model', maxContext: 3300 }),
        'First question',
      );
      await store.saveSession('persisted-session', history);
      return { provider, history };
    }

    async function secondExecution(
      store: MemoryStore,
      options: { agentName?: string; edit?: (h: ChatMessage[]) => ChatMessage[] } = {},
    ) {
      let history = await store.getSession('persisted-session');
      if (options.edit) history = options.edit(history);
      history.push({ role: 'user', content: 'Second question' });
      const provider = new TestProvider([
        { content: 'Regenerated summary.' },
        { content: 'Second answer.' },
      ]);
      const events: any[] = [];
      const ctx = createTestContext(provider, {
        executionId: 'second-execution',
        metadata: { sessionId: 'persisted-session' },
        sessionHistory: history,
        stateStore: store,
        onTrace: (event: any) => events.push(event),
      });
      await ctx.ask(
        agent({ name: options.agentName ?? 'compact', model: 'test:test-model', maxContext: 3300 }),
        'Second question',
      );
      return { provider, events, history };
    }

    it('reuses the persisted summary in a later execution when the tail fits', async () => {
      const store = new ReorderingJsonStore();
      const first = await firstExecution(store);
      const firstTail = (first.provider.calls[1].messages as ChatMessage[]).filter(
        (m) => m.role !== 'system',
      );

      const second = await secondExecution(store);

      expect(second.provider.calls.filter(isSummaryCall)).toEqual([]);
      const sent = second.provider.calls[0].messages as ChatMessage[];
      expect(sent[0]).toEqual({
        role: 'system',
        origin: 'runtime',
        content: 'Summary of earlier conversation:\nPersisted summary.',
      });
      // Exact covered prefix: the whole earlier tail, then everything since.
      // Each request ends with the ask input; these direct contexts have no
      // Session dedup marker, so the history's own user turn precedes it.
      expect(sent.slice(1).map((m) => m.content)).toEqual([
        ...firstTail.slice(0, -1).map((m) => m.content),
        'First answer.',
        'Second question',
        'Second question',
      ]);
      expect(firstTail.at(-2)?.content).toBe('First question');
      expect(second.events.some((e) => e.data?.purpose === 'summary')).toBe(false);
    });

    it('regenerates when a session trim changes the covered prefix', async () => {
      const store = new ReorderingJsonStore();
      await firstExecution(store);

      const second = await secondExecution(store, { edit: (history) => history.slice(2) });

      const summaryCalls = second.provider.calls.filter(isSummaryCall);
      expect(summaryCalls).toHaveLength(1);
      expect(String(summaryCalls[0].messages[1].content)).toContain('Message 2:');
      expect(String(summaryCalls[0].messages[1].content)).not.toContain('Message 0:');
      expect(second.provider.calls[1].messages[0].content).toBe(
        'Summary of earlier conversation:\nRegenerated summary.',
      );
    });

    it('does not share a persisted summary with a different agent', async () => {
      const store = new ReorderingJsonStore();
      await firstExecution(store, { agentName: 'compact' });

      const second = await secondExecution(store, { agentName: 'other' });

      expect(second.provider.calls.filter(isSummaryCall)).toHaveLength(1);
      expect(second.provider.calls[1].messages[0].content).toBe(
        'Summary of earlier conversation:\nRegenerated summary.',
      );
      expect(await store.getSessionMeta('persisted-session', 'askSummary:compact')).toMatchObject({
        summary: 'Persisted summary.',
      });
      expect(await store.getSessionMeta('persisted-session', 'askSummary:other')).toMatchObject({
        summary: 'Regenerated summary.',
      });
    });

    it('does not share an in-memory summary with a different agent in one execution', async () => {
      const provider = new TestProvider([
        { content: 'Compact summary.' },
        { content: 'Compact answer.' },
        { content: 'Other summary.' },
        { content: 'Other answer.' },
      ]);
      const ctx = createTestContext(provider, { sessionHistory: generateHistory(24, 400) });

      await ctx.ask(agent({ name: 'compact', model: 'test:test-model', maxContext: 3300 }), 'One');
      await ctx.ask(agent({ name: 'other', model: 'test:test-model', maxContext: 3300 }), 'Two');

      expect(provider.calls.filter(isSummaryCall)).toHaveLength(2);
      expect(provider.calls[3].messages[0].content).toBe(
        'Summary of earlier conversation:\nOther summary.',
      );
    });

    it('stores a prefix hash, never the serialized prefix, and keeps summaryCache intact', async () => {
      const store = new MemoryStore();
      await store.saveSessionMeta('persisted-session', 'summaryCache', 'Durable fact.');
      const history = generateHistory(24, 400);
      history.push({ role: 'user', content: 'First question' });
      const provider = new TestProvider([{ content: 'Ask summary.' }, { content: 'Answer.' }]);
      const ctx = createTestContext(provider, {
        metadata: { sessionId: 'persisted-session', summaryCache: 'Durable fact.' },
        sessionHistory: history,
        stateStore: store,
      });
      await ctx.ask(agent({ name: 'compact', model: 'test:test-model', maxContext: 3300 }), 'Q');

      const record = (await store.getSessionMeta('persisted-session', 'askSummary:compact')) as any;
      expect(Object.keys(record).sort()).toEqual([
        'coveredCount',
        'invalidatedThinkingThrough',
        'prefixHash',
        'sourceSummary',
        'summary',
        'summaryModelUri',
      ]);
      expect(record.summary).toBe('Ask summary.');
      expect(record.prefixHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(record)).not.toContain('Message 0:');
      expect(record.sourceSummary).toBe('Durable fact.');
      expect(await store.getSessionMeta('persisted-session', 'summaryCache')).toBe('Durable fact.');
    });

    it('stamps turn 0 on both summary call events', async () => {
      const events: any[] = [];
      const provider = new TestProvider([{ content: 'Summary.' }, { content: 'Answer.' }]);
      const ctx = createTestContext(provider, {
        sessionHistory: generateHistory(24, 400),
        onTrace: (event: any) => events.push(event),
      });
      await ctx.ask(agent({ model: 'test:test-model', maxContext: 3300 }), 'Question');

      const calls = events.filter(
        (e) => e.type === 'agent_call_start' || e.type === 'agent_call_end',
      );
      expect(calls.map((e) => [e.type, e.data.purpose, e.turn, e.data.turn])).toEqual([
        ['agent_call_start', 'summary', 0, 0],
        ['agent_call_end', 'summary', undefined, 0],
        ['agent_call_start', undefined, 1, 1],
        ['agent_call_end', undefined, undefined, 1],
      ]);
    });

    it('reports client-side thinking removal with the exact removed block count', async () => {
      const history = generateHistory(24, 400);
      history[21].providerMetadata = {
        anthropicThinkingBlocks: [
          { type: 'thinking', thinking: 'a', signature: 'sig-a' },
          { type: 'redacted_thinking', data: 'opaque' },
        ],
      };
      history[23].providerMetadata = {
        anthropicThinkingBlocks: [{ type: 'thinking', thinking: 'b', signature: 'sig-b' }],
        otherProviderKey: 'keep',
      };
      const events: any[] = [];
      const provider = new TestProvider([{ content: 'Summary.' }, { content: 'Answer.' }]);
      const ctx = createTestContext(provider, {
        sessionHistory: history,
        onTrace: (event: any) => events.push(event),
      });
      await ctx.ask(agent({ model: 'test:test-model', maxContext: 3300 }), 'Question');

      const sent = provider.calls[1].messages as ChatMessage[];
      expect(sent.some((m) => m.content === history[21].content)).toBe(true);
      expect(sent.some((m) => m.providerMetadata?.anthropicThinkingBlocks)).toBe(false);
      const diagnostics = events.filter((e) => e.type === 'provider_diagnostic');
      expect(diagnostics.map((e) => e.data)).toEqual([
        {
          kind: 'reasoning_context_reset',
          provider: 'test',
          model: 'test-model',
          droppedBlocks: 3,
          reasons: { client_prefix_rewrite: 3 },
        },
      ]);
      const order = events.map((e) => `${e.type}:${e.data?.purpose ?? e.turn ?? ''}`);
      expect(order.indexOf('provider_diagnostic:')).toBeGreaterThan(
        order.indexOf('agent_call_end:summary'),
      );
      expect(order.indexOf('provider_diagnostic:')).toBeLessThan(
        order.indexOf('agent_call_start:1'),
      );
    });

    it('reports thinking removal on a reused persisted summary', async () => {
      const store = new ReorderingJsonStore();
      const history = generateHistory(24, 400);
      history[23].providerMetadata = {
        anthropicThinkingBlocks: [{ type: 'thinking', thinking: 'old', signature: 'sig-old' }],
      };
      await firstExecution(store, { history });

      const second = await secondExecution(store);

      expect(second.provider.calls.filter(isSummaryCall)).toEqual([]);
      const reused = second.provider.calls[0].messages as ChatMessage[];
      expect(reused.some((m) => m.content === history[23].content)).toBe(true);
      expect(reused.some((m) => m.providerMetadata?.anthropicThinkingBlocks)).toBe(false);
      const diagnostics = second.events.filter((e) => e.type === 'provider_diagnostic');
      expect(diagnostics.map((e) => [e.data.droppedBlocks, e.data.reasons])).toEqual([
        [1, { client_prefix_rewrite: 1 }],
      ]);
    });

    it('emits no client rewrite diagnostic when no thinking blocks were removed', async () => {
      const events: any[] = [];
      const provider = new TestProvider([{ content: 'Summary.' }, { content: 'Answer.' }]);
      const ctx = createTestContext(provider, {
        sessionHistory: generateHistory(24, 400),
        onTrace: (event: any) => events.push(event),
      });
      await ctx.ask(agent({ model: 'test:test-model', maxContext: 3300 }), 'Question');

      expect(provider.calls.filter(isSummaryCall)).toHaveLength(1);
      expect(provider.calls[1].messages[0].content).toBe(
        'Summary of earlier conversation:\nSummary.',
      );
      expect(events.filter((e) => e.type === 'provider_diagnostic')).toEqual([]);
    });
  });
});
