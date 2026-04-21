import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import { AxlRuntime } from '../runtime.js';
import { MockProvider } from '../../../axl-testing/src/mock-provider.js';

/**
 * AxlStream.fullText commit-on-pipeline-committed (spec/16 §4.3).
 *
 * In 0.15.x, retried attempts' tokens leaked into `fullText` — the chat
 * UI rendered garbled output across schema/validate/guardrail retries.
 *
 * 0.16.x splits the buffer into in-progress and committed halves;
 * `pipeline(committed)` flushes in-progress to committed; `pipeline(failed)`
 * discards in-progress. `fullText` returns committed + in-progress so
 * mid-attempt reads are sane and post-`done` reads are canonical.
 */
describe('AxlStream.fullText — commit-on-pipeline-committed', () => {
  it('discards retried attempt tokens; only the winning attempt appears in fullText', async () => {
    // Schema retry: first attempt returns garbled text, second returns
    // valid JSON. Only the winning JSON should appear in fullText.
    const provider = MockProvider.sequence([
      { content: 'garbled-attempt-one', chunks: ['gar', 'bled-', 'attempt-one'] },
      { content: '{"x":42}', chunks: ['{"x":', '42}'] },
    ]);
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const a = agent({ name: 'retry-stream', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'retry-stream-wf',
      input: z.object({}),
      handler: async (ctx) => ctx.ask(a, 'q', { schema: z.object({ x: z.number() }), retries: 3 }),
    });
    runtime.register(wf);

    const stream = runtime.stream('retry-stream-wf', {});
    for await (const event of stream) {
      if (event.type === 'done') break;
    }

    // The garbled first attempt is gone; only the winning '{"x":42}' is
    // committed to fullText.
    expect(stream.fullText).toBe('{"x":42}');
    expect(stream.fullText).not.toContain('garbled');
  });

  it('on success path (no retries), fullText equals the single attempt content', async () => {
    const provider = MockProvider.sequence([
      { content: 'Hello world', chunks: ['Hello ', 'world'] },
    ]);
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const a = agent({ name: 'happy-stream', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'happy-stream-wf',
      input: z.object({}),
      handler: async (ctx) => ctx.ask(a, 'q'),
    });
    runtime.register(wf);

    const stream = runtime.stream('happy-stream-wf', {});
    for await (const event of stream) {
      if (event.type === 'done') break;
    }

    expect(stream.fullText).toBe('Hello world');
  });

  it('mid-attempt fullText reflects in-progress tokens until pipeline(committed) commits them', async () => {
    const provider = MockProvider.sequence([
      { content: 'one two three', chunks: ['one ', 'two ', 'three'] },
    ]);
    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    const a = agent({ name: 'mid-stream', model: 'mock:test', system: 'test' });
    const wf = workflow({
      name: 'mid-stream-wf',
      input: z.object({}),
      handler: async (ctx) => ctx.ask(a, 'q'),
    });
    runtime.register(wf);

    const stream = runtime.stream('mid-stream-wf', {});
    let midAttemptText = '';
    let postCommitText = '';
    for await (const event of stream) {
      if (event.type === 'token') {
        midAttemptText = stream.fullText; // in-progress at this point
      }
      if (event.type === 'pipeline' && event.status === 'committed') {
        postCommitText = stream.fullText;
      }
      if (event.type === 'done') break;
    }

    // Mid-attempt reads see the growing in-progress buffer.
    expect(midAttemptText.length).toBeGreaterThan(0);
    // Post-commit text equals the canonical winning attempt.
    expect(postCommitText).toBe('one two three');
    expect(stream.fullText).toBe('one two three');
  });
});
