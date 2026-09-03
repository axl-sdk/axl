import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { randomUUID } from 'node:crypto';
import type { AxlEvent, ChatMessage } from '../types.js';
import type { Provider, ProviderResponse } from '../providers/types.js';

/**
 * The shape of the conversation the model sees on a gate retry. Every adapter
 * hoists `system` messages out of the turn list, so feedback delivered as a
 * system message leaves the request ending on the model's own rejected
 * attempt (an Anthropic prefill; a hard throw on Gemini 3.5/3.6). Feedback
 * must therefore be a `user` turn after the attempt.
 */
function createRecordingProvider(responses: string[]): Provider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    name: 'recording',
    calls,
    chat: async (messages) => {
      calls.push(messages.map((m) => ({ ...m })));
      const content = responses[calls.length - 1] ?? responses[responses.length - 1];
      const resp: ProviderResponse = {
        content,
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        cost: 0.001,
        providerMetadata: {
          geminiParts: [{ text: content, thoughtSignature: `sig-${calls.length}` }],
        },
      };
      return resp;
    },
    stream: async function* () {
      yield { type: 'text_delta' as const, content: '' };
      throw new Error('streaming is not exercised by this suite');
    },
  };
}

function createCtx(responses: string[]) {
  const registry = new ProviderRegistry();
  const provider = createRecordingProvider(responses);
  registry.registerInstance('mock', provider);
  const traces: AxlEvent[] = [];
  const ctx = new WorkflowContext({
    input: 'test',
    executionId: randomUUID(),
    config: {},
    providerRegistry: registry,
    onTrace: (e) => traces.push(e),
  });
  return { ctx, provider, traces };
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
  // Only the initial system prompt is a system message.
  expect(messages.slice(1).every((m) => m.role !== 'system')).toBe(true);
  return last;
}

describe('retry turn shape', () => {
  it('validate: feedback is a user turn after the assistant attempt', async () => {
    const { ctx, provider } = createCtx(['{"value": 1}', '{"value": 2}']);
    const a = agent({ model: 'mock:test', system: 'Return JSON.' });
    const result = await ctx.ask(a, 'go', {
      schema: ValueSchema,
      validate: (o) =>
        o.value === 1 ? { valid: false, reason: 'must not be 1' } : { valid: true },
    });
    expect(result).toEqual({ value: 2 });
    expect(provider.calls).toHaveLength(2);
    const feedback = expectRetryTurn(provider.calls[1], '{"value": 1}');
    expect(feedback.content).toContain('must not be 1');
    expect(feedback.content).not.toContain('parsed correctly');
    expect(feedback.content).not.toContain('visible above');
  });

  it('schema: feedback is a user turn after the assistant attempt', async () => {
    const { ctx, provider } = createCtx(['not json', '{"value": 2}']);
    const a = agent({ model: 'mock:test', system: 'Return JSON.' });
    await ctx.ask(a, 'go', { schema: ValueSchema });
    const feedback = expectRetryTurn(provider.calls[1], 'not json');
    expect(feedback.content).toContain('did not match the required schema');
  });

  it('guardrail: feedback is a user turn after the assistant attempt', async () => {
    const { ctx, provider } = createCtx(['bad', 'good']);
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
    const feedback = expectRetryTurn(provider.calls[1], 'bad');
    expect(feedback.content).toContain('not nice');
  });

  it('accumulates attempt/feedback pairs across retries and reports the sent text on events', async () => {
    const { ctx, provider, traces } = createCtx(['{"value": 1}', '{"value": 1}', '{"value": 2}']);
    const a = agent({ model: 'mock:test', system: 'Return JSON.' });
    await ctx.ask(a, 'go', {
      schema: ValueSchema,
      validate: (o) =>
        o.value === 1 ? { valid: false, reason: 'must not be 1' } : { valid: true },
    });
    const third = provider.calls[2];
    expect(third.slice(-4).map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user']);
    const failed = traces.filter((e) => e.type === 'pipeline' && e.status === 'failed');
    expect(failed).toHaveLength(2);
    for (const [i, e] of failed.entries()) {
      // `reason` is exactly the user turn that was appended for that retry.
      expect((e as { reason: string }).reason).toBe(provider.calls[i + 1].at(-1)!.content);
    }
  });
});
