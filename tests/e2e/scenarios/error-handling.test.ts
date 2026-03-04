import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  agent,
  workflow,
  AxlError,
  VerifyError,
  QuorumNotMet,
  NoConsensus,
  TimeoutError,
  GuardrailError,
  MaxTurnsError,
} from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createTestRuntime } from '../helpers/setup.js';

describe('Error Handling E2E', () => {
  it('error classes are catchable by instanceof', () => {
    const verifyErr = new VerifyError('bad', { message: 'invalid' } as never, 3);
    expect(verifyErr).toBeInstanceOf(VerifyError);
    expect(verifyErr).toBeInstanceOf(AxlError);
    expect(verifyErr).toBeInstanceOf(Error);

    const quorumErr = new QuorumNotMet(3, 1, []);
    expect(quorumErr).toBeInstanceOf(QuorumNotMet);
    expect(quorumErr).toBeInstanceOf(AxlError);

    const timeoutErr = new TimeoutError('test', 5000);
    expect(timeoutErr).toBeInstanceOf(TimeoutError);
    expect(timeoutErr).toBeInstanceOf(AxlError);

    const guardrailErr = new GuardrailError('input', 'blocked content');
    expect(guardrailErr).toBeInstanceOf(GuardrailError);
    expect(guardrailErr).toBeInstanceOf(AxlError);
    expect(guardrailErr.guardrailType).toBe('input');

    const maxTurnsErr = new MaxTurnsError('agent', 5);
    expect(maxTurnsErr).toBeInstanceOf(MaxTurnsError);
    expect(maxTurnsErr).toBeInstanceOf(AxlError);
    expect(maxTurnsErr.maxTurns).toBe(5);

    const noConsensusErr = new NoConsensus('agents disagreed');
    expect(noConsensusErr).toBeInstanceOf(NoConsensus);
    expect(noConsensusErr).toBeInstanceOf(AxlError);
    expect(noConsensusErr).toBeInstanceOf(Error);
    expect(noConsensusErr.message).toContain('agents disagreed');
  });

  it('failed workflow sets execution status to failed', async () => {
    const { runtime } = createTestRuntime();
    const wf = workflow({
      name: 'fail-wf',
      input: z.object({ message: z.string() }),
      handler: async () => {
        throw new Error('intentional failure');
      },
    });
    runtime.register(wf);

    await expect(runtime.execute('fail-wf', { message: 'fail' })).rejects.toThrow(
      'intentional failure',
    );

    const executions = runtime.getExecutions();
    expect(executions.length).toBe(1);
    expect(executions[0].status).toBe('failed');
    expect(executions[0].error).toBe('intentional failure');
  });

  it('agent with input guardrail that blocks throws GuardrailError', async () => {
    const blockedProvider = MockProvider.sequence([{ content: 'should not reach' }]);
    const { runtime } = createTestRuntime(blockedProvider);

    const a = agent({
      name: 'guarded-agent',
      model: 'mock:test',
      system: 'test',
      guardrails: {
        input: (prompt) => ({
          block: prompt.includes('blocked'),
          reason: 'Content is blocked',
        }),
        onBlock: 'throw',
      },
    });

    const wf = workflow({
      name: 'guardrail-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    await expect(
      runtime.execute('guardrail-wf', { message: 'this is blocked content' }),
    ).rejects.toThrow(GuardrailError);
  });

  it('agent with maxTurns=1 and tool-calling provider throws MaxTurnsError', async () => {
    // Provider always returns tool calls, never a final text answer
    const provider = MockProvider.fn(() => ({
      content: '',
      tool_calls: [
        {
          id: 'tc_1',
          type: 'function' as const,
          function: { name: 'greet', arguments: JSON.stringify({ name: 'test' }) },
        },
      ],
    }));

    const { runtime } = createTestRuntime(provider);

    const greet = (await import('@axlsdk/axl')).tool({
      name: 'greet',
      description: 'Greet',
      input: z.object({ name: z.string() }),
      handler: (input) => `Hello, ${input.name}!`,
    });

    const a = agent({
      name: 'max-turns-agent',
      model: 'mock:test',
      system: 'test',
      tools: [greet],
      maxTurns: 1,
    });

    const wf = workflow({
      name: 'max-turns-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    await expect(runtime.execute('max-turns-wf', { message: 'hi' })).rejects.toThrow(MaxTurnsError);
  });
});
