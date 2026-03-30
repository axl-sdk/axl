import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { AxlRuntime } from '@axlsdk/axl';
import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
      mockRuntime,
    );

    expect(result.items).toHaveLength(0);
    expect(result.summary.count).toBe(0);
    expect(result.summary.failures).toBe(0);
  });

  it('marks score as -1 when scorer throws', async () => {
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
      undefined,
      mockRuntime,
    );

    for (const item of result.items) {
      expect(item.scores.throws).toBe(-1);
    }
  });

  it('marks score as -1 when score is out of range (> 1)', async () => {
    const outOfRangeScorer = scorer({
      name: 'bad-range',
      description: 'Returns out of range',
      score: () => 1.5,
    });

    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [outOfRangeScorer] },
      executeWorkflow,
      undefined,
      mockRuntime,
    );

    for (const item of result.items) {
      expect(item.scores['bad-range']).toBe(-1);
    }
  });

  it('marks score as -1 when score is out of range (< 0)', async () => {
    const negativeScorer = scorer({
      name: 'negative',
      description: 'Returns negative',
      score: () => -0.5,
    });

    const result = await runEval(
      { workflow: 'test', dataset: testDataset, scorers: [negativeScorer] },
      executeWorkflow,
      undefined,
      mockRuntime,
    );

    for (const item of result.items) {
      expect(item.scores.negative).toBe(-1);
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
      undefined,
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
      undefined,
      mockRuntime,
    );

    expect(result.items).toHaveLength(10);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('injects provider into LLM scorers', async () => {
    const mockLlmScorer = {
      name: 'llm-score',
      description: 'Mock LLM scorer',
      isLlm: true,
      _provider: undefined as any,
      async score() {
        return 0.9;
      },
    };

    const mockProvider = { chat: async () => ({ content: '{}' }) };

    const singleItemDataset = dataset({
      name: 'single-ds',
      schema: z.object({ q: z.string() }),
      items: [{ input: { q: 'test' } }],
    });

    await runEval(
      { workflow: 'test', dataset: singleItemDataset, scorers: [mockLlmScorer as any] },
      async () => ({ output: 'output' }),
      mockProvider,
      mockRuntime,
    );

    expect(mockLlmScorer._provider).toBe(mockProvider);
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
      undefined,
      mockRuntime,
    );

    expect(receivedAnnotations).toEqual({ answer: '2' });
    expect(result.items[0].scores['ann-scorer']).toBe(1);
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
      undefined,
      testRuntime,
    );

    expect(receivedRuntime).toBe(testRuntime);
    expect(result.items).toHaveLength(3);
  });
});
