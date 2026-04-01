import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { AxlRuntime } from '@axlsdk/axl';
import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';
import { llmScorer } from '../llm-scorer.js';
import { runEval } from '../runner.js';

const mockRuntime = {} as AxlRuntime;

const testDataset = dataset({
  name: 'test-ds',
  schema: z.object({ question: z.string() }),
  items: [
    { input: { question: 'What is 1+1?' } },
    { input: { question: 'What is 2+2?' } },
    { input: { question: 'What is 3+3?' } },
  ],
});

const exactScorer = scorer({
  name: 'exact',
  description: 'Exact match',
  score: (output, input) => {
    if (input.question === 'What is 1+1?' && output === '2') return 1;
    if (input.question === 'What is 2+2?' && output === '4') return 1;
    if (input.question === 'What is 3+3?' && output === '6') return 1;
    return 0;
  },
});

const executeWorkflow = async (input: any): Promise<{ output: unknown; cost?: number }> => {
  if (input.question === 'What is 1+1?') return { output: '2', cost: 0.001 };
  if (input.question === 'What is 2+2?') return { output: '4', cost: 0.001 };
  if (input.question === 'What is 3+3?') return { output: '6', cost: 0.001 };
  return { output: 'unknown' };
};

describe('runEval()', () => {
  it('runs workflow against dataset items and applies scorers', async () => {
    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [exactScorer] },
      executeWorkflow,
      mockRuntime,
    );

    expect(result.items).toHaveLength(3);
    expect(result.summary.count).toBe(3);
    expect(result.summary.failures).toBe(0);
    expect(result.summary.scorers.exact.mean).toBe(1);
  });

  it('returns EvalResult with correct structure', async () => {
    const result = await runEval(
      { workflow: 'math-solver', dataset: testDataset, scorers: [exactScorer] },
      executeWorkflow,
      mockRuntime,
    );

    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe('string');
    expect(result.workflow).toBe('math-solver');
    expect(result.dataset).toBe('test-ds');
    expect(result.timestamp).toBeDefined();
    expect(result.totalCost).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.metadata).toEqual({});
    expect(result.items).toBeInstanceOf(Array);
    expect(result.summary).toBeDefined();
    expect(result.summary.count).toBe(3);
    expect(result.summary.failures).toBe(0);
    expect(result.summary.scorers).toBeDefined();
  });

  it('each eval item has input, output, and scores', async () => {
    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [exactScorer] },
      executeWorkflow,
      mockRuntime,
    );

    for (const item of result.items) {
      expect(item.input).toBeDefined();
      expect(item.output).toBeDefined();
      expect(item.scores).toBeDefined();
      expect(typeof item.scores.exact).toBe('number');
    }
  });

  it('handles workflow failures by setting error field', async () => {
    const failingWorkflow = async (input: any) => {
      if (input.question === 'What is 2+2?') {
        throw new Error('Workflow crashed');
      }
      return { output: '2' };
    };

    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [exactScorer] },
      failingWorkflow,
      mockRuntime,
    );

    expect(result.summary.failures).toBe(1);

    const failedItem = result.items.find((i) => i.error);
    expect(failedItem).toBeDefined();
    expect(failedItem!.error).toBe('Workflow crashed');
    expect(failedItem!.scores).toEqual({});
  });

  it('failed items do not receive scores', async () => {
    const failingWorkflow = async (_input: any) => {
      throw new Error('Always fails');
    };

    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [exactScorer] },
      failingWorkflow,
      mockRuntime,
    );

    expect(result.summary.failures).toBe(3);
    for (const item of result.items) {
      expect(item.error).toBeDefined();
      expect(Object.keys(item.scores)).toHaveLength(0);
    }
  });

  it('computes summary stats (mean, min, max, p50, p95)', async () => {
    const variableScorer = scorer({
      name: 'variable',
      description: 'Returns different scores',
      score: (output, input) => {
        if (input.question === 'What is 1+1?') return 0.2;
        if (input.question === 'What is 2+2?') return 0.6;
        if (input.question === 'What is 3+3?') return 1.0;
        return 0;
      },
    });

    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [variableScorer] },
      executeWorkflow,
      mockRuntime,
    );

    const stats = result.summary.scorers.variable;
    expect(stats.mean).toBeCloseTo(0.6, 2);
    expect(stats.min).toBe(0.2);
    expect(stats.max).toBe(1.0);
    expect(stats.p50).toBeDefined();
    expect(stats.p95).toBeDefined();
  });

  it('handles multiple scorers', async () => {
    const lengthScorer = scorer({
      name: 'length',
      description: 'Score based on output length',
      score: (output) => {
        return typeof output === 'string' && output.length > 0 ? 1 : 0;
      },
    });

    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [exactScorer, lengthScorer] },
      executeWorkflow,
      mockRuntime,
    );

    expect(result.summary.scorers.exact).toBeDefined();
    expect(result.summary.scorers.length).toBeDefined();
    expect(result.summary.scorers.exact.mean).toBe(1);
    expect(result.summary.scorers.length.mean).toBe(1);
  });

  it('metadata is passed through', async () => {
    const result = await runEval(
      {
        workflow: 'test',
        dataset: testDataset,
        scorers: [exactScorer],
        metadata: { version: '1.0', model: 'gpt-4' },
      },
      executeWorkflow,
      mockRuntime,
    );

    expect(result.metadata).toEqual({ version: '1.0', model: 'gpt-4' });
  });

  it('handles empty dataset', async () => {
    const emptyDataset = dataset({
      name: 'empty-ds',
      schema: z.object({ question: z.string() }),
      items: [],
    });

    const result = await runEval(
      { workflow: 'test', dataset: emptyDataset, scorers: [exactScorer] },
      executeWorkflow,
      mockRuntime,
    );

    expect(result.items).toHaveLength(0);
    expect(result.summary.count).toBe(0);
    expect(result.summary.failures).toBe(0);
  });

  it('marks score as null when scorer throws', async () => {
    const throwingScorer = scorer({
      name: 'throws',
      description: 'Always throws',
      score: () => {
        throw new Error('Scorer error');
      },
    });

    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [throwingScorer] },
      executeWorkflow,
      mockRuntime,
    );

    for (const item of result.items) {
      expect(item.scores.throws).toBeNull();
    }
  });

  it('marks score as null when score is out of range (> 1)', async () => {
    const outOfRangeScorer = scorer({
      name: 'bad-range',
      description: 'Returns out of range',
      score: () => 1.5,
    });

    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [outOfRangeScorer] },
      executeWorkflow,
      mockRuntime,
    );

    for (const item of result.items) {
      expect(item.scores['bad-range']).toBeNull();
    }
  });

  it('marks score as null when score is out of range (< 0)', async () => {
    const negativeScorer = scorer({
      name: 'negative',
      description: 'Returns negative',
      score: () => -0.5,
    });

    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [negativeScorer] },
      executeWorkflow,
      mockRuntime,
    );

    for (const item of result.items) {
      expect(item.scores.negative).toBeNull();
    }
  });

  it('concurrent execution processes all items', async () => {
    const largeDataset = dataset({
      name: 'large-ds',
      schema: z.object({ n: z.number() }),
      items: Array.from({ length: 20 }, (_, i) => ({ input: { n: i } })),
    });

    const simpleScorer = scorer({
      name: 'identity',
      description: 'Returns input as score',
      score: (output) => (typeof output === 'number' ? Math.min(output / 19, 1) : 0),
    });

    const result = await runEval(
      { workflow: 'test', dataset: largeDataset, scorers: [simpleScorer], concurrency: 3 },
      async (input: any) => ({ output: input.n }),
      mockRuntime,
    );

    expect(result.items).toHaveLength(20);
    expect(result.summary.count).toBe(20);
    expect(result.summary.failures).toBe(0);
  });

  it('concurrent execution respects concurrency limit', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const concurrencyDataset = dataset({
      name: 'conc-ds',
      schema: z.object({ id: z.number() }),
      items: Array.from({ length: 10 }, (_, i) => ({ input: { id: i } })),
    });

    const simpleScorer = scorer({
      name: 'pass',
      description: 'Always passes',
      score: () => 1,
    });

    const result = await runEval(
      { workflow: 'test', dataset: concurrencyDataset, scorers: [simpleScorer], concurrency: 2 },
      async (input: any) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        currentConcurrent--;
        return { output: input.id };
      },
      mockRuntime,
    );

    expect(result.items).toHaveLength(10);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('resolves provider for LLM scorers from runtime', async () => {
    const mockProvider = {
      chat: async () => ({ content: JSON.stringify({ score: 0.9, reasoning: 'Good' }) }),
    };

    const mockRuntimeWithResolver = {
      resolveProvider: (uri: string) => ({
        provider: mockProvider,
        model: uri.includes(':') ? uri.split(':').slice(1).join(':') : uri,
      }),
    } as unknown as AxlRuntime;

    const llmScore = llmScorer({
      name: 'test-llm',
      description: 'test',
      model: 'mock:test-model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const singleItemDataset = dataset({
      name: 'single-ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: singleItemDataset, scorers: [llmScore] },
      async () => ({ output: 'output' }),
      mockRuntimeWithResolver,
    );

    expect(result.items[0].scores['test-llm']).toBe(0.9);
  });

  it('handles mixed LLM and non-LLM scorers', async () => {
    const mockProvider = {
      chat: async () => ({ content: JSON.stringify({ score: 0.8, reasoning: 'OK' }) }),
    };

    const mockRuntimeWithResolver = {
      resolveProvider: (uri: string) => ({
        provider: mockProvider,
        model: uri.includes(':') ? uri.split(':').slice(1).join(':') : uri,
      }),
    } as unknown as AxlRuntime;

    const llmScore = llmScorer({
      name: 'llm-judge',
      description: 'LLM judge',
      model: 'mock:test-model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const simpleScore = scorer({
      name: 'length',
      description: 'Check length',
      score: (output) => (typeof output === 'string' && output.length > 0 ? 1 : 0),
    });

    const singleItemDataset = dataset({
      name: 'single-ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: singleItemDataset, scorers: [simpleScore, llmScore] },
      async () => ({ output: 'output' }),
      mockRuntimeWithResolver,
    );

    expect(result.items[0].scores['length']).toBe(1);
    expect(result.items[0].scores['llm-judge']).toBe(0.8);
  });

  it('resolves different providers for different LLM scorers', async () => {
    const providers: Record<string, string> = {};

    const mockRuntimeMultiProvider = {
      resolveProvider: (uri: string) => {
        const colonIdx = uri.indexOf(':');
        const providerName = colonIdx > -1 ? uri.slice(0, colonIdx) : 'default';
        const model = colonIdx > -1 ? uri.slice(colonIdx + 1) : uri;
        return {
          provider: {
            chat: async () => {
              providers[providerName] = model;
              return { content: JSON.stringify({ score: 0.7, reasoning: 'Fine' }) };
            },
          },
          model,
        };
      },
    } as unknown as AxlRuntime;

    const scorer1 = llmScorer({
      name: 'judge-a',
      description: 'test',
      model: 'openai:gpt-4o',
      system: 'Rate',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const scorer2 = llmScorer({
      name: 'judge-b',
      description: 'test',
      model: 'google:gemini-flash',
      system: 'Rate',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const ds = dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [scorer1, scorer2] },
      async () => ({ output: 'output' }),
      mockRuntimeMultiProvider,
    );

    expect(providers['openai']).toBe('gpt-4o');
    expect(providers['google']).toBe('gemini-flash');
    expect(result.items[0].scores['judge-a']).toBe(0.7);
    expect(result.items[0].scores['judge-b']).toBe(0.7);
  });

  it('handles resolveProvider failure with null score and error message', async () => {
    const mockRuntimeThatThrows = {
      resolveProvider: () => {
        throw new Error('Unknown provider "bad"');
      },
    } as unknown as AxlRuntime;

    const llmScore = llmScorer({
      name: 'bad-scorer',
      description: 'test',
      model: 'bad:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const ds = dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [llmScore] },
      async () => ({ output: 'output' }),
      mockRuntimeThatThrows,
    );

    expect(result.items[0].scores['bad-scorer']).toBeNull();
    expect(result.items[0].errors).toBeDefined();
    expect(result.items[0].errors![0]).toContain('Unknown provider');
  });

  it('accumulates LLM scorer cost in totalCost', async () => {
    const mockProvider = {
      chat: async () => ({
        content: JSON.stringify({ score: 0.9, reasoning: 'Good' }),
        cost: 0.002,
      }),
    };

    const mockRuntimeWithResolver = {
      resolveProvider: (uri: string) => ({
        provider: mockProvider,
        model: uri.includes(':') ? uri.split(':').slice(1).join(':') : uri,
      }),
    } as unknown as AxlRuntime;

    const llmScore = llmScorer({
      name: 'judge',
      description: 'test',
      model: 'mock:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const ds = dataset({
      name: 'cost-ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'a' } }, { input: { q: 'b' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [llmScore] },
      async () => ({ output: 'output', cost: 0.001 }),
      mockRuntimeWithResolver,
    );

    // 2 items × $0.001 workflow + 2 items × $0.002 scorer = $0.006
    expect(result.totalCost).toBeCloseTo(0.006, 6);
  });

  it('LLM scorer cost counts toward budget', async () => {
    const mockProvider = {
      chat: async () => ({
        content: JSON.stringify({ score: 0.9, reasoning: 'Good' }),
        cost: 0.003,
      }),
    };

    const mockRuntimeWithResolver = {
      resolveProvider: (uri: string) => ({
        provider: mockProvider,
        model: uri.includes(':') ? uri.split(':').slice(1).join(':') : uri,
      }),
    } as unknown as AxlRuntime;

    const llmScore = llmScorer({
      name: 'judge',
      description: 'test',
      model: 'mock:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const ds = dataset({
      name: 'budget-ds',
      schema: z.object({ q: z.string() }),
      items: Array.from({ length: 5 }, (_, i) => ({ input: { q: String(i) } })),
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [llmScore], budget: '$0.010', concurrency: 1 },
      async () => ({ output: 'output', cost: 0.001 }),
      mockRuntimeWithResolver,
    );

    // Each item: $0.001 workflow + $0.003 scorer = $0.004
    // After 3 items: $0.012 > $0.010 budget → remaining items budget-exceeded
    const budgetExceeded = result.items.filter((i) => i.error === 'Budget exceeded');
    expect(budgetExceeded.length).toBeGreaterThan(0);
    expect(result.totalCost).toBeGreaterThan(0.008);
  });

  it('accumulates LLM scorer cost even when scorer throws after LLM call', async () => {
    const mockProvider = {
      chat: async () => ({
        content: 'not valid json',
        cost: 0.005,
      }),
    };

    const mockRuntimeWithResolver = {
      resolveProvider: (uri: string) => ({
        provider: mockProvider,
        model: uri.includes(':') ? uri.split(':').slice(1).join(':') : uri,
      }),
    } as unknown as AxlRuntime;

    const llmScore = llmScorer({
      name: 'broken',
      description: 'test',
      model: 'mock:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const ds = dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [llmScore] },
      async () => ({ output: 'output', cost: 0.001 }),
      mockRuntimeWithResolver,
    );

    // Scorer threw (invalid JSON) but the LLM call cost $0.005 was still incurred
    expect(result.items[0].scores['broken']).toBeNull();
    expect(result.items[0].errors).toBeDefined();
    expect(result.totalCost).toBeCloseTo(0.006, 6); // $0.001 workflow + $0.005 scorer
  });

  it('passes annotations to scorer', async () => {
    const annotatedDataset = dataset({
      name: 'ann-ds',
      schema: z.object({ question: z.string() }),
      annotations: z.object({ answer: z.string() }),
      items: [{ input: { question: 'What is 1+1?' }, annotations: { answer: '2' } }],
    });

    let receivedAnnotations: any;
    const annotationScorer = scorer({
      name: 'ann-scorer',
      description: 'Uses annotations',
      score: (output, _input, annotations) => {
        receivedAnnotations = annotations;
        return output === annotations?.answer ? 1 : 0;
      },
    });

    const result = await runEval(
      { workflow: 'test', dataset: annotatedDataset, scorers: [annotationScorer] },
      async () => ({ output: '2' }),
      mockRuntime,
    );

    expect(receivedAnnotations).toEqual({ answer: '2' });
    expect(result.items[0].scores['ann-scorer']).toBe(1);
  });

  it('gives descriptive error when runtime lacks resolveProvider', async () => {
    const bareRuntime = {} as AxlRuntime;

    const llmScore = llmScorer({
      name: 'test-llm',
      description: 'test',
      model: 'mock:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });

    const ds = dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [llmScore] },
      async () => ({ output: 'output' }),
      bareRuntime,
    );

    expect(result.items[0].scores['test-llm']).toBeNull();
    expect(result.items[0].errors).toBeDefined();
    expect(result.items[0].errors![0]).toContain('resolveProvider');
    expect(result.items[0].errors![0]).toContain('real AxlRuntime');
  });

  it('stops processing when budget is exceeded', async () => {
    const expensiveDataset = dataset({
      name: 'expensive-ds',
      schema: z.object({ id: z.number() }),
      items: Array.from({ length: 5 }, (_, i) => ({ input: { id: i } })),
    });

    const simpleScorer = scorer({
      name: 'pass',
      description: 'Always passes',
      score: () => 1,
    });

    const result = await runEval(
      {
        workflow: 'test',
        dataset: expensiveDataset,
        scorers: [simpleScorer],
        budget: '$0.005',
        concurrency: 1,
      },
      async () => ({ output: 'ok', cost: 0.003 }),
      mockRuntime,
    );

    // First two items cost $0.003 each = $0.006 which exceeds $0.005
    // Remaining items should have 'Budget exceeded' error
    const budgetExceeded = result.items.filter((i) => i.error === 'Budget exceeded');
    expect(budgetExceeded.length).toBeGreaterThan(0);
    expect(result.totalCost).toBeGreaterThan(0);
  });

  it('passes runtime to executeWorkflow as second argument', async () => {
    let receivedRuntime: unknown;
    const testRuntime = { marker: 'test-runtime' } as unknown as AxlRuntime;

    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [exactScorer] },
      async (input: any, runtime: any) => {
        receivedRuntime = runtime;
        if (input.question === 'What is 1+1?') return { output: '2' };
        if (input.question === 'What is 2+2?') return { output: '4' };
        return { output: '6' };
      },
      testRuntime,
    );

    expect(receivedRuntime).toBe(testRuntime);
    expect(result.items).toHaveLength(3);
  });
});
