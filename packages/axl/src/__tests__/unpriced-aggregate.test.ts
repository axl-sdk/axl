import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { workflow } from '../workflow.js';
import { AxlRuntime } from '../runtime.js';
import type { Provider, ProviderResponse, StreamChunk } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Execution-level honesty: the `unpriced` lower-bound signal must surface on the
// aggregate cost surfaces a user actually reads — `ExecutionInfo.unpriced`
// (runtime.execute / stream / getExecutions) and `trackExecution().unpriced` —
// not only on `ask_end.unpriced` / `BudgetResult.unpriced`. An unpriced model
// (positive tokens, no usable cost) flips the flag; a priced run leaves it
// false; a mixed run is a lower bound. Uses real ProviderResponses (MockProvider
// coerces cost to 0, which we can't use here).
// ---------------------------------------------------------------------------

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function seqProvider(responses: ProviderResponse[]): Provider {
  let i = 0;
  return {
    name: 'test',
    async chat() {
      return responses[Math.min(i++, responses.length - 1)];
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r.content) yield { type: 'text_delta', content: r.content };
      yield {
        type: 'done',
        ...(r.usage ? { usage: r.usage } : {}),
        ...(r.cost !== undefined ? { cost: r.cost } : {}),
      };
    },
  };
}

function makeRuntime(provider: Provider): AxlRuntime {
  const runtime = new AxlRuntime({ defaultProvider: 'test', defaultModel: 'test-model' });
  runtime.registerProvider('test', provider);
  return runtime;
}

const askWorkflow = workflow({
  name: 'ask-wf',
  input: z.string(),
  handler: async (ctx) => {
    const a = agent({ name: 'a', model: 'test:test-model', system: 's' });
    return ctx.ask(a, 'hi');
  },
});

describe('ExecutionInfo.unpriced — execute() path', () => {
  it('is TRUE when an agent call returned usage but NO cost (unpriced model)', async () => {
    const runtime = makeRuntime(seqProvider([{ content: 'ok', usage }]));
    runtime.register(askWorkflow);
    await runtime.execute('ask-wf', 'go');

    const [info] = await runtime.getExecutions();
    expect(info.unpriced).toBe(true);
    expect(info.totalCost).toBe(0); // unpriced spend is unmeasured → lower bound
  });

  it('is FALSE for a fully priced execution', async () => {
    const runtime = makeRuntime(seqProvider([{ content: 'ok', usage, cost: 0.002 }]));
    runtime.register(askWorkflow);
    await runtime.execute('ask-wf', 'go');

    const [info] = await runtime.getExecutions();
    expect(info.unpriced).toBe(false);
    expect(info.totalCost).toBeCloseTo(0.002, 6);
  });

  it('is FALSE for a known-free call (cost: 0 is a real zero, not unknown)', async () => {
    const runtime = makeRuntime(seqProvider([{ content: 'ok', usage, cost: 0 }]));
    runtime.register(askWorkflow);
    await runtime.execute('ask-wf', 'go');

    const [info] = await runtime.getExecutions();
    expect(info.unpriced).toBe(false);
  });

  it('is a lower bound when a run MIXES priced + unpriced asks', async () => {
    const provider = seqProvider([
      { content: 'first', usage, cost: 0.003 }, // priced
      { content: 'second', usage }, // unpriced
    ]);
    const runtime = makeRuntime(provider);
    runtime.register(
      workflow({
        name: 'two-asks',
        input: z.string(),
        handler: async (ctx) => {
          const a = agent({ name: 'a', model: 'test:test-model', system: 's' });
          await ctx.ask(a, 'one');
          await ctx.ask(a, 'two');
          return 'done';
        },
      }),
    );
    await runtime.execute('two-asks', 'go');

    const [info] = await runtime.getExecutions();
    expect(info.unpriced).toBe(true);
    expect(info.totalCost).toBeCloseTo(0.003, 6); // only the priced ask counted
  });
});

describe('ExecutionInfo.unpriced — stream() path', () => {
  it('is TRUE when the streamed done chunk carried usage but no cost', async () => {
    const runtime = makeRuntime(seqProvider([{ content: 'ok', usage }]));
    runtime.register(askWorkflow);

    const stream = runtime.stream('ask-wf', 'go');
    // Drain the stream so the execution completes and is recorded.
    for await (const _ of stream) void _;

    const [info] = await runtime.getExecutions();
    expect(info.unpriced).toBe(true);
  });

  it('is FALSE for a priced streamed execution', async () => {
    const runtime = makeRuntime(seqProvider([{ content: 'ok', usage, cost: 0.002 }]));
    runtime.register(askWorkflow);

    const stream = runtime.stream('ask-wf', 'go');
    for await (const _ of stream) void _;

    const [info] = await runtime.getExecutions();
    expect(info.unpriced).toBe(false);
  });
});

describe('trackExecution().unpriced', () => {
  it('is TRUE when a tracked call was unpriced; cost is a lower bound', async () => {
    const runtime = makeRuntime(seqProvider([{ content: 'ok', usage }]));
    runtime.register(askWorkflow);

    const tracked = await runtime.trackExecution(() => runtime.execute('ask-wf', 'go'));
    expect(tracked.unpriced).toBe(true);
    expect(tracked.cost).toBe(0);
  });

  it('is FALSE when every tracked call was priced', async () => {
    const runtime = makeRuntime(seqProvider([{ content: 'ok', usage, cost: 0.002 }]));
    runtime.register(askWorkflow);

    const tracked = await runtime.trackExecution(() => runtime.execute('ask-wf', 'go'));
    expect(tracked.unpriced).toBe(false);
    expect(tracked.cost).toBeCloseTo(0.002, 6);
  });
});

describe('trackCost().unpriced', () => {
  it('is TRUE when a tracked call was unpriced; cost is a lower bound', async () => {
    const runtime = makeRuntime(seqProvider([{ content: 'ok', usage }]));
    runtime.register(askWorkflow);

    const tracked = await runtime.trackCost(() => runtime.execute('ask-wf', 'go'));
    expect(tracked.unpriced).toBe(true);
    expect(tracked.cost).toBe(0);
  });

  it('is FALSE when every tracked call was priced', async () => {
    const runtime = makeRuntime(seqProvider([{ content: 'ok', usage, cost: 0.002 }]));
    runtime.register(askWorkflow);

    const tracked = await runtime.trackCost(() => runtime.execute('ask-wf', 'go'));
    expect(tracked.unpriced).toBe(false);
    expect(tracked.cost).toBeCloseTo(0.002, 6);
  });
});
