import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent, workflow, type AxlEvent } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createTestRuntime } from '../helpers/setup.js';

describe('Handoffs E2E', () => {
  it('oneway handoff: source agent hands off to target, target returns final answer', async () => {
    const targetAgent = agent({
      name: 'target-agent',
      model: 'mock:test',
      system: 'You are the target agent.',
    });

    const sourceAgent = agent({
      name: 'source-agent',
      model: 'mock:test',
      system: 'You are the source agent. Hand off to the target.',
      handoffs: [{ agent: targetAgent, description: 'Hand off to target' }],
    });

    // Source returns a handoff tool_call, then target returns final answer
    const provider = MockProvider.fn((_msgs, callIndex) => {
      if (callIndex === 0) {
        return {
          content: '',
          tool_calls: [
            {
              id: 'handoff_1',
              type: 'function' as const,
              function: {
                name: 'handoff_to_target-agent',
                arguments: JSON.stringify({ message: 'handle this' }),
              },
            },
          ],
        };
      }
      return { content: 'Target handled it.' };
    });

    const { runtime, traces } = createTestRuntime(provider);
    const wf = workflow({
      name: 'handoff-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(sourceAgent, ctx.input.message),
    });
    runtime.register(wf);

    const result = await runtime.execute('handoff-wf', { message: 'start handoff' });
    expect(result).toBe('Target handled it.');

    // `handoff_start` always fires before the target ask begins; oneway
    // handoffs emit no `handoff_return` because control doesn't return
    // to the source.
    const handoffTraces = traces.filter(
      (t): t is Extract<AxlEvent, { type: 'handoff_start' }> => t.type === 'handoff_start',
    );
    expect(handoffTraces.length).toBeGreaterThanOrEqual(1);
  });

  it('roundtrip handoff: target returns result back to source', async () => {
    const targetAgent = agent({
      name: 'rt-target',
      model: 'mock:test',
      system: 'Return data to source.',
    });

    const sourceAgent = agent({
      name: 'rt-source',
      model: 'mock:test',
      system: 'Hand off then process the response.',
      handoffs: [{ agent: targetAgent, description: 'Roundtrip handoff', mode: 'roundtrip' }],
    });

    let callIdx = 0;
    const provider = MockProvider.fn(() => {
      callIdx++;
      if (callIdx === 1) {
        // Source hands off to target
        return {
          content: '',
          tool_calls: [
            {
              id: 'rt_1',
              type: 'function' as const,
              function: {
                name: 'handoff_to_rt-target',
                arguments: JSON.stringify({ message: 'need data' }),
              },
            },
          ],
        };
      }
      if (callIdx === 2) {
        // Target responds
        return { content: 'target data' };
      }
      // Source continues after roundtrip
      return { content: 'Source got target data and finished.' };
    });

    const { runtime } = createTestRuntime(provider);
    const wf = workflow({
      name: 'roundtrip-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(sourceAgent, ctx.input.message),
    });
    runtime.register(wf);

    const result = await runtime.execute('roundtrip-wf', { message: 'start roundtrip' });
    expect(result).toBe('Source got target data and finished.');
  });

  it('ctx.delegate() selects best agent via inline router and returns its response', async () => {
    const billingAgent = agent({
      name: 'billing',
      model: 'mock:specialist',
      system: 'You handle billing inquiries.',
    });

    const shippingAgent = agent({
      name: 'shipping',
      model: 'mock:specialist',
      system: 'You handle shipping inquiries.',
    });

    // Call 0: router picks billing via handoff tool call
    // Call 1: billing agent answers
    const provider = MockProvider.fn((_msgs, callIndex) => {
      if (callIndex === 0) {
        return {
          content: '',
          tool_calls: [
            {
              id: 'delegate_1',
              type: 'function' as const,
              function: {
                name: 'handoff_to_billing',
                arguments: JSON.stringify({}),
              },
            },
          ],
        };
      }
      return { content: 'Your balance is $100' };
    });

    const { runtime, traces } = createTestRuntime(provider);
    const wf = workflow({
      name: 'delegate-wf',
      input: z.object({ question: z.string() }),
      handler: async (ctx) => ctx.delegate([billingAgent, shippingAgent], ctx.input.question),
    });
    runtime.register(wf);

    const result = await runtime.execute('delegate-wf', { question: 'What is my balance?' });
    expect(result).toBe('Your balance is $100');

    const delegateTraces = traces.filter(
      (t): t is Extract<AxlEvent, { type: 'delegate' }> => t.type === 'delegate',
    );
    expect(delegateTraces.length).toBe(1);
    expect(delegateTraces[0].data.candidates).toEqual(['billing', 'shipping']);
  });

  it('handoff trace events include correct target', async () => {
    const targetAgent = agent({
      name: 'trace-target',
      model: 'mock:test',
      system: 'Target',
    });

    const sourceAgent = agent({
      name: 'trace-source',
      model: 'mock:test',
      system: 'Source',
      handoffs: [{ agent: targetAgent, description: 'Test handoff' }],
    });

    const provider = MockProvider.fn((_msgs, callIndex) => {
      if (callIndex === 0) {
        return {
          content: '',
          tool_calls: [
            {
              id: 'ht_1',
              type: 'function' as const,
              function: {
                name: 'handoff_to_trace-target',
                arguments: JSON.stringify({ message: 'go' }),
              },
            },
          ],
        };
      }
      return { content: 'done' };
    });

    const { runtime, traces } = createTestRuntime(provider);
    const wf = workflow({
      name: 'trace-handoff-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(sourceAgent, ctx.input.message),
    });
    runtime.register(wf);

    await runtime.execute('trace-handoff-wf', { message: 'test' });

    // `handoff_start.data.target` names the destination agent; fired
    // before the target ask begins.
    const handoffTraces = traces.filter(
      (t): t is Extract<AxlEvent, { type: 'handoff_start' }> => t.type === 'handoff_start',
    );
    expect(handoffTraces.length).toBeGreaterThanOrEqual(1);
    expect(handoffTraces[0].data.target).toBe('trace-target');
  });
});
