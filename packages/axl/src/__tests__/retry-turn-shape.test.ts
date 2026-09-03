import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { createSequenceProvider, createTestCtx, type SequenceResponse } from './helpers.js';
import type { AxlEvent, ChatMessage } from '../types.js';

/**
 * The shape of the conversation the model sees on a gate retry. Every adapter
 * hoists `system` messages out of the turn list, so feedback delivered as a
 * system message leaves the request ending on the model's own rejected
 * attempt (an Anthropic prefill; a hard throw on Gemini 3.5/3.6). Feedback
 * must therefore be a `user` turn after the attempt.
 */
function withSignature(content: string, signature: string): SequenceResponse {
  return {
    content,
    providerMetadata: { geminiParts: [{ text: content, thoughtSignature: signature }] },
  };
}

function createCtx(responses: SequenceResponse[]) {
  const traces: AxlEvent[] = [];
  const { ctx, provider } = createTestCtx({
    provider: createSequenceProvider(responses),
    onTrace: (e: AxlEvent) => traces.push(e),
  });
  return { ctx, provider, traces };
}

/** The messages of call `index`, which the runtime clones per call. */
function messagesOf(
  provider: { calls: Array<{ messages: unknown[] }> },
  index: number,
): ChatMessage[] {
  return provider.calls[index].messages as ChatMessage[];
}

const ValueSchema = z.object({ value: z.number() });

function expectRetryTurn(messages: ChatMessage[], attempt: string): ChatMessage {
  const last = messages.at(-1)!;
  const attemptTurn = messages.at(-2)!;
  expect(attemptTurn.role).toBe('assistant');
  expect(attemptTurn.content).toBe(attempt);
  expect(attemptTurn.providerMetadata).toEqual({
    geminiParts: [{ text: attempt, thoughtSignature: 'sig-1' }],
  });
  expect(last.role).toBe('user');
  // Every system message belongs to the leading system block; the retry appends none.
  const firstNonSystem = messages.findIndex((m) => m.role !== 'system');
  expect(firstNonSystem).toBeGreaterThan(-1);
  expect(messages.slice(firstNonSystem).some((m) => m.role === 'system')).toBe(false);
  return last;
}

describe('retry turn shape', () => {
  it('validate: feedback is a user turn after the assistant attempt', async () => {
    const { ctx, provider } = createCtx([
      withSignature('{"value": 1}', 'sig-1'),
      withSignature('{"value": 2}', 'sig-2'),
    ]);
    const a = agent({ model: 'mock:test', system: 'Return JSON.' });
    const result = await ctx.ask(a, 'go', {
      schema: ValueSchema,
      validate: (o) =>
        o.value === 1 ? { valid: false, reason: 'must not be 1' } : { valid: true },
    });
    expect(result).toEqual({ value: 2 });
    expect(provider.calls).toHaveLength(2);
    const feedback = expectRetryTurn(messagesOf(provider, 1), '{"value": 1}');
    expect(feedback.content).toContain('must not be 1');
    expect(feedback.content).not.toContain('parsed correctly');
    expect(feedback.content).not.toContain('visible above');
  });

  it('schema: feedback is a user turn after the assistant attempt', async () => {
    const { ctx, provider } = createCtx([
      withSignature('not json', 'sig-1'),
      withSignature('{"value": 2}', 'sig-2'),
    ]);
    const a = agent({ model: 'mock:test', system: 'Return JSON.' });
    await ctx.ask(a, 'go', { schema: ValueSchema });
    const feedback = expectRetryTurn(messagesOf(provider, 1), 'not json');
    expect(feedback.content).toContain('did not match the required schema');
  });

  it('guardrail: feedback is a user turn after the assistant attempt', async () => {
    const { ctx, provider } = createCtx([
      withSignature('bad', 'sig-1'),
      withSignature('good', 'sig-2'),
    ]);
    const a = agent({
      model: 'mock:test',
      system: 'Be nice.',
      guardrails: {
        output: (c) => ({ block: c === 'bad', reason: 'not nice' }),
        onBlock: 'retry',
      },
    });
    const result = await ctx.ask(a, 'go');
    expect(result).toBe('good');
    const feedback = expectRetryTurn(messagesOf(provider, 1), 'bad');
    expect(feedback.content).toContain('not nice');
  });

  it('accumulates attempt/feedback pairs across retries and reports the sent text on events', async () => {
    const { ctx, provider, traces } = createCtx([
      withSignature('{"value": 1}', 'sig-1'),
      withSignature('{"value": 1}', 'sig-2'),
      withSignature('{"value": 2}', 'sig-3'),
    ]);
    const a = agent({ model: 'mock:test', system: 'Return JSON.' });
    await ctx.ask(a, 'go', {
      schema: ValueSchema,
      validate: (o) =>
        o.value === 1 ? { valid: false, reason: 'must not be 1' } : { valid: true },
    });
    const third = messagesOf(provider, 2);
    expect(third.slice(-4).map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user']);
    const failed = traces.filter((e) => e.type === 'pipeline' && e.status === 'failed');
    expect(failed).toHaveLength(2);
    for (const [i, e] of failed.entries()) {
      // `reason` is exactly the user turn that was appended for that retry.
      expect((e as { reason: string }).reason).toBe(messagesOf(provider, i + 1).at(-1)!.content);
    }
  });
});
