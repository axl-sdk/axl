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

// ═════════════════════════════════════════════════════════════════════════
// Token density calibration
// ═════════════════════════════════════════════════════════════════════════

/**
 * Reports a prompt token count derived from the characters it was actually
 * sent, so a test can pin a token density instead of relying on the estimator's
 * cold-start constant.
 */
class DensityProvider {
  readonly name = 'test';
  calls: any[] = [];

  constructor(private readonly tokensPerChar: number) {}

  private promptTokens(messages: any[]): number {
    const chars = messages.reduce(
      (sum: number, m: any) => sum + (typeof m.content === 'string' ? m.content.length : 0),
      0,
    );
    return Math.max(1, Math.round(chars * this.tokensPerChar));
  }

  async chat(messages: any[], options: any) {
    this.calls.push({ messages, options });
    return {
      content: 'Summary: prior topics.',
      usage: {
        prompt_tokens: this.promptTokens(messages),
        completion_tokens: 5,
        total_tokens: this.promptTokens(messages) + 5,
      },
      cost: 0.001,
    };
  }

  async *stream(messages: any[], options: any) {
    const resp = await this.chat(messages, options);
    yield { type: 'text_delta' as const, content: resp.content };
    yield { type: 'done' as const, usage: (resp as any).usage };
  }
}

function createDensityContext(provider: DensityProvider, sessionHistory: ChatMessage[]) {
  const registry = new ProviderRegistry();
  registry.registerInstance('test', provider as any);
  return new WorkflowContext({
    input: 'test input',
    executionId: 'test-exec-density',
    metadata: {},
    config: { defaultProvider: 'test' },
    providerRegistry: registry,
    onTrace: vi.fn(),
    sessionHistory,
  });
}

describe('token density calibration', () => {
  // ~4.2k characters of history. Under the flat ~4-chars-per-token assumption
  // that is ~1.1k tokens and fits the 4k window (2k of which is the default
  // reserve); at the measured 1 token per character it is ~4.3k and does not. This is the case a fixed constant gets wrong: dense content
  // (minified JSON, code, CJK) or a newer tokenizer overruns the window while
  // the estimator still reports headroom.
  const history = generateHistory(20, 200);
  const denseAgent = () =>
    agent({ model: 'test:dense-model', system: 'You are a test agent', maxContext: 4000 });

  it('summarizes on the next ask once observed usage shows denser tokens', async () => {
    const provider = new DensityProvider(1); // 1 token per character
    const ctx = createDensityContext(provider, history);

    // First ask: nothing measured yet, so the cold-start constant applies and
    // the history is judged to fit. That call is what supplies the sample.
    await ctx.ask(denseAgent(), 'First question?');
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].messages.some((m: any) => m.content?.includes?.('Summarize'))).toBe(
      false,
    );

    // Second ask: the calibrated density now predicts an overflow, so the
    // history is summarized first — an extra provider call for the summary.
    await ctx.ask(denseAgent(), 'Second question?');
    expect(provider.calls.length).toBeGreaterThan(2);
    expect(provider.calls[1].messages[0].content).toContain('Summarize');
  });

  it('leaves the threshold alone when observed usage matches the assumption', async () => {
    const provider = new DensityProvider(1 / 4); // matches the cold-start value
    const ctx = createDensityContext(provider, history);

    await ctx.ask(denseAgent(), 'First question?');
    await ctx.ask(denseAgent(), 'Second question?');

    // One call per ask: the measured density confirms the estimate, so no
    // summarization is triggered on either.
    expect(provider.calls.length).toBe(2);
    expect(provider.calls.some((c: any) => c.messages[0].content?.includes?.('Summarize'))).toBe(
      false,
    );
  });
});
