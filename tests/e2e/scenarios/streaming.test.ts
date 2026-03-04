import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent, workflow } from '@axlsdk/axl';
import { MockProvider } from '@axlsdk/testing';
import type { StreamEvent } from '@axlsdk/axl';
import { createTestRuntime } from '../helpers/setup.js';

describe('Streaming E2E', () => {
  it('streams tokens and fullText matches concatenation', async () => {
    const provider = MockProvider.sequence([{ content: 'Hello streaming world' }]);
    const { runtime } = createTestRuntime(provider);
    const a = agent({ name: 'stream-agent', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'stream-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const stream = runtime.stream('stream-wf', { message: 'hello' });
    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data);
      if (event.type === 'done') break;
    }

    expect(tokens.length).toBeGreaterThan(0);
    expect(stream.fullText).toBe(tokens.join(''));
  });

  it('stream.promise resolves with workflow output', async () => {
    const provider = MockProvider.sequence([{ content: 'promise result' }]);
    const { runtime } = createTestRuntime(provider);
    const a = agent({ name: 'promise-agent', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'promise-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const stream = runtime.stream('promise-wf', { message: 'hello' });
    const result = await stream.promise;
    expect(result).toBe('promise result');
  });

  it('stream emits agent_start, step, and done events', async () => {
    const provider = MockProvider.sequence([{ content: 'streamed result' }]);
    const { runtime } = createTestRuntime(provider);
    const a = agent({
      name: 'step-stream-agent',
      model: 'mock:test',
      system: 'test',
    });
    const wf = workflow({
      name: 'step-stream-wf',
      input: z.object({ message: z.string() }),
      handler: async (ctx) => ctx.ask(a, ctx.input.message),
    });
    runtime.register(wf);

    const stream = runtime.stream('step-stream-wf', { message: 'hello' });
    const allEvents: StreamEvent[] = [];
    for await (const event of stream) {
      allEvents.push(event);
      if (event.type === 'done') break;
    }

    const types = allEvents.map((e) => e.type);
    expect(types).toContain('agent_start');
    expect(types).toContain('step'); // agent_call trace is emitted as a step event
    expect(types).toContain('done');

    // Verify the step event contains an agent_call trace
    const stepEvents = allEvents.filter((e) => e.type === 'step');
    const agentCallStep = stepEvents.find(
      (e) => (e as { data: { type?: string } }).data?.type === 'agent_call',
    );
    expect(agentCallStep).toBeDefined();
  });

  it('stream rejects with error when workflow throws', async () => {
    const { runtime } = createTestRuntime();
    const wf = workflow({
      name: 'error-stream-wf',
      input: z.object({ message: z.string() }),
      handler: async () => {
        throw new Error('workflow failed');
      },
    });
    runtime.register(wf);

    const stream = runtime.stream('error-stream-wf', { message: 'hello' });
    await expect(stream.promise).rejects.toThrow('workflow failed');
  });
});
