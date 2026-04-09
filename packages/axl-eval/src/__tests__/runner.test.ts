import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { AxlRuntime } from '@axlsdk/axl';
import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';
import type { Scorer } from '../scorer.js';
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
    expect(result.metadata).toEqual({ scorerTypes: { exact: 'deterministic' } });
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

    expect(result.metadata).toEqual({
      version: '1.0',
      model: 'gpt-4',
      scorerTypes: { exact: 'deterministic' },
    });
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
    expect(result.items[0].scorerErrors).toBeDefined();
    expect(result.items[0].scorerErrors![0]).toContain('Unknown provider');
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
    expect(result.items[0].scorerErrors).toBeDefined();
    expect(result.totalCost).toBeCloseTo(0.006, 6); // $0.001 workflow + $0.005 scorer
  });

  it('does not double-count LLM scorer cost when provider returns no cost', async () => {
    let callCount = 0;
    const mockProvider = {
      chat: async () => {
        callCount++;
        // First call has cost, second call has no cost field
        return callCount === 1
          ? { content: JSON.stringify({ score: 0.9, reasoning: 'Good' }), cost: 0.01 }
          : { content: JSON.stringify({ score: 0.8, reasoning: 'OK' }) };
      },
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
      name: 'two-items',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'a' } }, { input: { q: 'b' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [llmScore], concurrency: 1 },
      async () => ({ output: 'output' }),
      mockRuntimeWithResolver,
    );

    // Item 1: $0.01 scorer cost. Item 2: no scorer cost.
    // Verify: provider with no cost on second call should not carry over first call's cost
    expect(result.totalCost).toBeCloseTo(0.01, 6);
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
    expect(result.items[0].scorerErrors).toBeDefined();
    expect(result.items[0].scorerErrors![0]).toContain('resolveProvider');
    expect(result.items[0].scorerErrors![0]).toContain('real AxlRuntime');
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

  it('one failing scorer does not prevent other scorers from running', async () => {
    const goodScorer = scorer({
      name: 'good',
      description: 'Always passes',
      score: () => 1,
    });

    const badScorer = scorer({
      name: 'bad',
      description: 'Always throws',
      score: () => {
        throw new Error('boom');
      },
    });

    const anotherGoodScorer = scorer({
      name: 'also-good',
      description: 'Also passes',
      score: () => 0.5,
    });

    const ds = dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [goodScorer, badScorer, anotherGoodScorer] },
      async () => ({ output: 'output' }),
      mockRuntime,
    );

    // The bad scorer should not prevent good and also-good from running
    expect(result.items[0].scores['good']).toBe(1);
    expect(result.items[0].scores['bad']).toBeNull();
    expect(result.items[0].scores['also-good']).toBe(0.5);
    expect(result.items[0].scorerErrors).toHaveLength(1);
    expect(result.items[0].scorerErrors![0]).toContain('boom');
  });

  it('workflow errors on some items do not affect other items', async () => {
    const ds = dataset({
      name: 'ds',
      schema: z.object({ id: z.number() }),
      items: [{ input: { id: 1 } }, { input: { id: 2 } }, { input: { id: 3 } }],
    });

    const simpleScorer = scorer({
      name: 'pass',
      description: 'Always passes',
      score: () => 1,
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [simpleScorer], concurrency: 1 },
      async (input: any) => {
        if (input.id === 2) throw new Error('item 2 failed');
        return { output: `result-${input.id}` };
      },
      mockRuntime,
    );

    // Items 1 and 3 should succeed, item 2 should fail
    expect(result.summary.failures).toBe(1);
    const successful = result.items.filter((i) => !i.error);
    expect(successful).toHaveLength(2);
    expect(successful.every((i) => i.scores['pass'] === 1)).toBe(true);

    const failed = result.items.find((i) => i.error);
    expect(failed!.error).toBe('item 2 failed');
    expect(Object.keys(failed!.scores)).toHaveLength(0);
  });

  it('eval results include correct item count even when some fail', async () => {
    const ds = dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: Array.from({ length: 10 }, (_, i) => ({ input: { q: String(i) } })),
    });

    const simpleScorer = scorer({
      name: 'check',
      description: 'Passes for even items',
      score: (output) => (Number(output) % 2 === 0 ? 1 : 0),
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [simpleScorer] },
      async (input: any) => {
        if (Number(input.q) >= 8) throw new Error('too high');
        return { output: input.q };
      },
      mockRuntime,
    );

    expect(result.summary.count).toBe(10);
    expect(result.summary.failures).toBe(2);
    expect(result.items).toHaveLength(10);
  });

  it('treats NaN score as an error', async () => {
    const nanScorer = scorer({
      name: 'nan',
      description: 'Returns NaN',
      score: () => NaN,
    });

    const ds = dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [nanScorer] },
      async () => ({ output: 'output' }),
      mockRuntime,
    );

    // NaN should not be stored as a valid score
    expect(result.items[0].scores['nan']).toBeNull();
    expect(result.items[0].scorerErrors).toBeDefined();
    // Summary mean should be 0 (no valid scores), not NaN
    expect(Number.isNaN(result.summary.scorers['nan'].mean)).toBe(false);
  });

  it('score of exactly 0 is valid (not an error)', async () => {
    const zeroScorer = scorer({
      name: 'zero',
      description: 'Always returns 0',
      score: () => 0,
    });

    const ds = dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [zeroScorer] },
      async () => ({ output: 'output' }),
      mockRuntime,
    );

    expect(result.items[0].scores['zero']).toBe(0);
    expect(result.items[0].scorerErrors).toBeUndefined();
  });

  it('score of exactly 1 is valid (not an error)', async () => {
    const oneScorer = scorer({
      name: 'one',
      description: 'Always returns 1',
      score: () => 1,
    });

    const ds = dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [oneScorer] },
      async () => ({ output: 'output' }),
      mockRuntime,
    );

    expect(result.items[0].scores['one']).toBe(1);
    expect(result.items[0].scorerErrors).toBeUndefined();
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

  it('populates per-item duration and cost', async () => {
    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [exactScorer] },
      executeWorkflow,
      mockRuntime,
    );

    for (const item of result.items) {
      expect(typeof item.duration).toBe('number');
      expect(item.duration!).toBeGreaterThanOrEqual(0);
    }
    // executeWorkflow returns cost: 0.001 for all items
    expect(result.items[0].cost).toBe(0.001);
  });

  it('captures duration even on workflow error', async () => {
    const ds = dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [exactScorer] },
      async () => {
        throw new Error('fail');
      },
      mockRuntime,
    );

    expect(result.items[0].error).toBe('fail');
    expect(typeof result.items[0].duration).toBe('number');
    expect(result.items[0].duration!).toBeGreaterThanOrEqual(0);
  });

  it('populates scoreDetails for deterministic scorers (no metadata)', async () => {
    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [exactScorer] },
      executeWorkflow,
      mockRuntime,
    );

    const item = result.items[0];
    expect(item.scoreDetails).toBeDefined();
    expect(item.scoreDetails!['exact']).toBeDefined();
    expect(item.scoreDetails!['exact'].score).toBe(1);
    expect(item.scoreDetails!['exact'].metadata).toBeUndefined();
    expect(typeof item.scoreDetails!['exact'].duration).toBe('number');
  });

  it('populates scoreDetails with metadata for LLM scorers', async () => {
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
    });

    const ds = dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [llmScore] },
      async () => ({ output: 'output' }),
      mockRuntimeWithResolver,
    );

    const detail = result.items[0].scoreDetails!['judge'];
    expect(detail.score).toBe(0.9);
    expect(detail.metadata).toEqual({ reasoning: 'Good' });
    expect(detail.cost).toBe(0.002);
    expect(typeof detail.duration).toBe('number');
    expect(result.items[0].scorerCost).toBe(0.002);
  });

  it('computes summary.timing stats from item durations', async () => {
    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [exactScorer] },
      executeWorkflow,
      mockRuntime,
    );

    expect(result.summary.timing).toBeDefined();
    expect(typeof result.summary.timing!.mean).toBe('number');
    expect(typeof result.summary.timing!.p50).toBe('number');
    expect(typeof result.summary.timing!.p95).toBe('number');
    expect(typeof result.summary.timing!.min).toBe('number');
    expect(typeof result.summary.timing!.max).toBe('number');
  });

  it('preserves metadata in scoreDetails when score is out of range', async () => {
    const richScorer: Scorer = {
      name: 'rich-oor',
      description: 'Returns out-of-range with metadata',
      isLlm: false,
      score: () => ({ score: 1.5, metadata: { reasoning: 'very confident' } }),
    };

    const ds = dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [richScorer] },
      async () => ({ output: 'output' }),
      mockRuntime,
    );

    expect(result.items[0].scores['rich-oor']).toBeNull();
    expect(result.items[0].scoreDetails!['rich-oor'].score).toBeNull();
    expect(result.items[0].scoreDetails!['rich-oor'].metadata).toEqual({
      reasoning: 'very confident',
    });
  });

  it('scorer factory accepts ScorerResult return value', async () => {
    const richScorer = scorer({
      name: 'rich',
      description: 'Returns ScorerResult',
      score: () => ({ score: 0.8, metadata: { reasoning: 'good' } }),
    });

    const ds = dataset({
      name: 'ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    const result = await runEval(
      { workflow: 'test', dataset: ds, scorers: [richScorer] },
      async () => ({ output: 'output' }),
      mockRuntime,
    );

    expect(result.items[0].scores['rich']).toBe(0.8);
    expect(result.items[0].scoreDetails!['rich'].metadata).toEqual({ reasoning: 'good' });
  });

  // ── scorerTypes metadata tests ────────────────────────────────

  it('stores scorerTypes in result metadata', async () => {
    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [exactScorer] },
      executeWorkflow,
      mockRuntime,
    );

    expect(result.metadata.scorerTypes).toEqual({ exact: 'deterministic' });
  });

  it('stores mixed LLM and deterministic scorerTypes', async () => {
    const llmScorerDef: Scorer = {
      name: 'quality',
      description: 'LLM-based quality',
      isLlm: true,
      score: () => 0.9,
    };

    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [exactScorer, llmScorerDef] },
      executeWorkflow,
      mockRuntime,
    );

    expect(result.metadata.scorerTypes).toEqual({
      exact: 'deterministic',
      quality: 'llm',
    });
  });
});
