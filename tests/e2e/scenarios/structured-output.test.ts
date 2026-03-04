import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent, workflow } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import { createTestRuntime } from '../helpers/setup.js';

describe('Structured Output E2E', () => {
  it('agent asked with Zod schema returns parsed JSON matching schema', async () => {
    const provider = MockProvider.sequence([
      { content: JSON.stringify({ name: 'Alice', age: 30 }) },
    ]);
    const { runtime } = createTestRuntime(provider);

    const UserSchema = z.object({ name: z.string(), age: z.number() });

    const a = agent({ name: 'struct-agent', model: 'mock:test', system: 'Return JSON.' });
    const wf = workflow({
      name: 'struct-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => {
        const result = await ctx.ask(a, ctx.input.message, { schema: UserSchema });
        return result;
      },
    });
    runtime.register(wf);

    const result = await runtime.execute('struct-wf', { message: 'get user' });
    expect(result).toEqual({ name: 'Alice', age: 30 });
  });

  it('workflow output schema with coercion is applied', async () => {
    const provider = MockProvider.sequence([{ content: '99' }]);
    const { runtime } = createTestRuntime(provider);

    const a = agent({ name: 'coerce-agent', model: 'mock:test', system: 'Return a number.' });
    const wf = workflow({
      name: 'coerce-output-wf',
      input: z.object({ message: z.string() }),
      output: z.coerce.number(),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const result = await runtime.execute('coerce-output-wf', { message: 'number please' });
    expect(result).toBe(99);
    expect(typeof result).toBe('number');
  });
});
