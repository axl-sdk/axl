import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { AxlRuntime } from '@axlsdk/axl';
import type { EvalResult } from '../types.js';
import type { Scorer } from '../scorer.js';
import { rescore } from '../rescore.js';
import { runEval } from '../runner.js';
import { dataset } from '../dataset.js';
import { llmScorer } from '../llm-scorer.js';
import { askExecute, scriptedRuntime } from './accounting-helpers.js';

const mockRuntime = {} as AxlRuntime;

function makeResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    id: 'original-id',
    dataset: 'test-ds',
    metadata: { workflows: ['test-wf'] },
    timestamp: '2024-01-01T00:00:00.000Z',
    totalCost: 0.01,
    duration: 500,
    items: [
      { input: { q: '1' }, output: 'answer-1', scores: { old: 0.5 } },
      { input: { q: '2' }, output: 'answer-2', scores: { old: 0.7 } },
      {
        input: { q: '3' },
        output: 'answer-3',
        scores: { old: 0.9 },
        annotations: { expected: 'x' },
      },
    ],
    summary: {
      count: 3,
      failures: 0,
      scorers: { old: { mean: 0.7, min: 0.5, max: 0.9, p50: 0.7, p95: 0.9 } },
    },
    ...overrides,
  };
}

const alwaysOneScorer: Scorer = {
  name: 'always-one',
  description: 'Returns 1',
  isLlm: false,
  score: () => 1,
};

const halfScorer: Scorer = {
  name: 'half',
  description: 'Returns 0.5',
  isLlm: false,
  score: () => 0.5,
};

describe('rescore()', () => {
  it('re-scores items with new scorers', async () => {
    const result = makeResult();
    const rescored = await rescore(result, [alwaysOneScorer], mockRuntime);

    expect(rescored.items).toHaveLength(3);
    for (const item of rescored.items) {
      expect(item.scores['always-one']).toBe(1);
    }
    // Old scorer should not be present
    expect(rescored.items[0].scores['old']).toBeUndefined();
  });

  it('preserves original input/output/annotations', async () => {
    const result = makeResult();
    const rescored = await rescore(result, [alwaysOneScorer], mockRuntime);

    expect(rescored.items[0].input).toEqual({ q: '1' });
    expect(rescored.items[0].output).toBe('answer-1');
    expect(rescored.items[2].annotations).toEqual({ expected: 'x' });
  });

  it('produces new id and timestamp', async () => {
    const result = makeResult();
    const rescored = await rescore(result, [alwaysOneScorer], mockRuntime);

    expect(rescored.id).not.toBe('original-id');
    expect(rescored.timestamp).not.toBe('2024-01-01T00:00:00.000Z');
  });

  it('recomputes summary stats from rescored items', async () => {
    const result = makeResult();
    const rescored = await rescore(result, [halfScorer], mockRuntime);

    expect(rescored.summary.scorers['half']).toBeDefined();
    expect(rescored.summary.scorers['half'].mean).toBe(0.5);
    expect(rescored.summary.scorers['half'].min).toBe(0.5);
    expect(rescored.summary.scorers['half'].max).toBe(0.5);
  });

  it('surfaces scored/failed counts (but never a degraded gate)', async () => {
    // Rescore reports the same trust-signal counts as runEval, but takes
    // RescoreOptions (no failOnScorerErrorRate) — so there is no degradation
    // gate on this path even when a scorer fails.
    const flakyScorer: Scorer = {
      name: 'flaky',
      description: 'throws on q=2',
      isLlm: true,
      score: (_o, input) => {
        if ((input as { q: string }).q === '2') throw new Error('boom');
        return 1;
      },
    };
    const rescored = await rescore(makeResult(), [flakyScorer], mockRuntime);
    const s = rescored.summary.scorers['flaky'];
    expect(s.scored).toBe(2);
    expect(s.failed).toBe(1);
    // No degradation gate exists on the rescore path.
    expect((rescored.summary as { degraded?: unknown }).degraded).toBeUndefined();
  });

  it('skips scoring for error items and preserves them', async () => {
    const result = makeResult({
      items: [
        { input: { q: '1' }, output: 'answer-1', scores: { old: 0.5 } },
        { input: { q: '2' }, output: null, error: 'failed', scores: {} },
      ],
      summary: { count: 2, failures: 1, scorers: {} },
    });

    const rescored = await rescore(result, [alwaysOneScorer], mockRuntime);

    expect(rescored.items[0].scores['always-one']).toBe(1);
    expect(rescored.items[1].error).toBe('failed');
    expect(rescored.items[1].scores).toEqual({});
    expect(rescored.summary.failures).toBe(1);
  });

  it('reports no measured spend on an uninstrumented runtime, keeping the caller value per scorer', async () => {
    const costScorer: Scorer = {
      name: 'costly',
      description: 'Returns cost',
      isLlm: true,
      score: () => ({ score: 0.8, cost: 0.01 }),
    };

    const result = makeResult();
    const rescored = await rescore(result, [costScorer], mockRuntime);

    // This runtime has no measurement rail, so the honest total is $0 with an
    // explicit `uninstrumented` reason — NOT the sum of what the scorer claimed.
    expect(rescored.totalCost).toBe(0);
    expect(rescored.accounting!.scope).toBe('rescore');
    expect(rescored.accounting!.completeness).toBe('incomplete');
    expect(rescored.accounting!.reasons.uninstrumented).toBe(1);
    // The claim survives for inspection on each scorer detail.
    for (const item of rescored.items) {
      expect(item.scoreDetails!.costly.cost).toBe(0.01);
      expect(item.scorerCost).toBe(0);
    }
    // The source run's generation spend is recorded, never added to the total.
    expect(rescored.accounting!.source).toEqual({
      runId: 'original-id',
      generation: null,
    });
  });

  it('stores rescored metadata with originalId', async () => {
    const result = makeResult();
    const rescored = await rescore(result, [alwaysOneScorer], mockRuntime);

    expect(rescored.metadata.rescored).toBe(true);
    expect(rescored.metadata.originalId).toBe('original-id');
    expect(rescored.metadata.scorerTypes).toEqual({ 'always-one': 'deterministic' });
  });

  it('records null score and error when scorer throws', async () => {
    const failScorer: Scorer = {
      name: 'fail',
      description: 'Always throws',
      isLlm: false,
      score: () => {
        throw new Error('boom');
      },
    };

    const result = makeResult();
    const rescored = await rescore(result, [failScorer], mockRuntime);

    for (const item of rescored.items) {
      expect(item.scores['fail']).toBeNull();
      expect(item.scorerErrors).toBeDefined();
      expect(item.scorerErrors![0]).toContain('boom');
    }
  });

  it('handles empty items array', async () => {
    const result = makeResult({
      items: [],
      summary: { count: 0, failures: 0, scorers: {} },
    });
    const rescored = await rescore(result, [alwaysOneScorer], mockRuntime);

    expect(rescored.items).toHaveLength(0);
    expect(rescored.summary.count).toBe(0);
    expect(rescored.summary.failures).toBe(0);
  });

  it('handles array input (multi-run output) by rescoring each result', async () => {
    const results = [
      makeResult({ id: 'run-1' }),
      makeResult({ id: 'run-2' }),
      makeResult({ id: 'run-3' }),
    ];

    const rescored: EvalResult[] = [];
    for (const resultData of results) {
      rescored.push(await rescore(resultData, [alwaysOneScorer, halfScorer], mockRuntime));
    }

    expect(rescored).toHaveLength(3);
    for (const r of rescored) {
      expect(r.metadata.rescored).toBe(true);
      expect(r.items).toHaveLength(3);
      for (const item of r.items) {
        expect(item.scores['always-one']).toBe(1);
        expect(item.scores['half']).toBe(0.5);
      }
    }
    // Each rescored result should reference its original
    expect(rescored[0].metadata.originalId).toBe('run-1');
    expect(rescored[1].metadata.originalId).toBe('run-2');
    expect(rescored[2].metadata.originalId).toBe('run-3');
    // Each gets a unique new id
    const ids = new Set(rescored.map((r) => r.id));
    expect(ids.size).toBe(3);
  });

  it('records null score and error for out-of-range score', async () => {
    const outOfRangeScorer: Scorer = {
      name: 'oor',
      description: 'Returns 1.5',
      isLlm: false,
      score: () => 1.5,
    };

    const result = makeResult();
    const rescored = await rescore(result, [outOfRangeScorer], mockRuntime);

    for (const item of rescored.items) {
      expect(item.scores['oor']).toBeNull();
      expect(item.scorerErrors).toBeDefined();
      expect(item.scorerErrors![0]).toContain('out-of-range');
      expect(item.scorerErrors![0]).toContain('1.5');
    }
  });

  it('captures cost from error with .cost property', async () => {
    const costErrorScorer: Scorer = {
      name: 'cost-err',
      description: 'Throws with cost',
      isLlm: true,
      score: () => {
        const err = new Error('fail');
        (err as any).cost = 0.01;
        throw err;
      },
    };

    const result = makeResult();
    const rescored = await rescore(result, [costErrorScorer], mockRuntime);

    // The cost attached to the thrown error is still surfaced per scorer; it is
    // a caller report, so it does not become the run's measured total.
    expect(rescored.totalCost).toBe(0);
    for (const item of rescored.items) {
      expect(item.scores['cost-err']).toBeNull();
      expect(item.scorerCost).toBe(0);
      expect(item.scoreDetails!['cost-err'].cost).toBe(0.01);
      expect(item.scoreDetails!['cost-err'].outcome).toBe('failed');
    }
  });

  it('strips runGroupId and runIndex from metadata while preserving other fields', async () => {
    const result = makeResult({
      metadata: { runGroupId: 'group-1', runIndex: 2, customField: 'keep' },
    });
    const rescored = await rescore(result, [alwaysOneScorer], mockRuntime);

    expect(rescored.metadata.runGroupId).toBeUndefined();
    expect(rescored.metadata.runIndex).toBeUndefined();
    expect(rescored.metadata.customField).toBe('keep');
    expect(rescored.metadata.rescored).toBe(true);
    expect(rescored.metadata.originalId).toBe('original-id');
  });

  it('handles multiple scorers correctly', async () => {
    const result = makeResult();
    const rescored = await rescore(result, [alwaysOneScorer, halfScorer], mockRuntime);

    for (const item of rescored.items) {
      expect(item.scores['always-one']).toBe(1);
      expect(item.scores['half']).toBe(0.5);
      expect(item.scoreDetails!['always-one']).toBeDefined();
      expect(item.scoreDetails!['half']).toBeDefined();
    }
    expect(rescored.metadata.scorerTypes).toEqual({
      'always-one': 'deterministic',
      half: 'deterministic',
    });
    expect(rescored.summary.scorers['always-one'].mean).toBe(1);
    expect(rescored.summary.scorers['half'].mean).toBe(0.5);
  });

  it('preserves per-item metadata from original result', async () => {
    const result = makeResult();
    // Add metadata to each item (simulating what the runner would do)
    for (const item of result.items) {
      item.metadata = { models: ['openai:gpt-4o'], agentCalls: 1 };
    }

    const rescored = await rescore(result, [alwaysOneScorer], mockRuntime);

    for (const item of rescored.items) {
      if (!item.error) {
        expect(item.metadata).toBeDefined();
        expect(item.metadata!.models).toEqual(['openai:gpt-4o']);
        expect(item.metadata!.agentCalls).toBe(1);
      }
    }
  });

  describe('signal propagation', () => {
    it('forwards signal into ScorerContext so LLM scorers can abort mid-flight', async () => {
      const result = makeResult();
      const controller = new AbortController();
      let capturedSignal: AbortSignal | undefined;

      const signalCapturingScorer: Scorer = {
        name: 'capture',
        description: 'captures the signal',
        isLlm: true,
        score: (_o, _i, _a, ctx) => {
          capturedSignal = ctx?.signal;
          return 1;
        },
      };

      await rescore(result, [signalCapturingScorer], mockRuntime, {
        signal: controller.signal,
      });

      expect(capturedSignal).toBe(controller.signal);
    });

    it('omits signal from ScorerContext when none provided', async () => {
      const result = makeResult();
      let capturedSignal: AbortSignal | undefined = new AbortController().signal;

      const signalCapturingScorer: Scorer = {
        name: 'capture',
        description: 'captures the signal',
        isLlm: true,
        score: (_o, _i, _a, ctx) => {
          capturedSignal = ctx?.signal;
          return 1;
        },
      };

      await rescore(result, [signalCapturingScorer], mockRuntime);

      expect(capturedSignal).toBeUndefined();
    });

    it('short-circuits remaining items when signal is already aborted', async () => {
      const result = makeResult();
      const controller = new AbortController();
      controller.abort();

      const rescored = await rescore(result, [alwaysOneScorer], mockRuntime, {
        signal: controller.signal,
      });

      // Every item should be marked cancelled — none should have been scored.
      for (const item of rescored.items) {
        expect(item.error).toBe('cancelled');
        expect(item.scores['always-one']).toBeUndefined();
      }
    });
  });

  it('strips a stale scorerFiltered/scorersRun stamp from the source run', async () => {
    // A full rescore of a --scorers-filtered run must NOT inherit the filtered
    // stamp — whether THIS rescore ran a subset is a property of the rescore,
    // not the source. Otherwise it would falsely trip the compare gate/banner.
    const result = makeResult({
      metadata: { workflows: ['test-wf'], scorerFiltered: true, scorersRun: ['old-subset'] },
    });
    const rescored = await rescore(result, [alwaysOneScorer, halfScorer], mockRuntime);

    expect(rescored.metadata.scorerFiltered).toBeUndefined();
    expect(rescored.metadata.scorersRun).toBeUndefined();
    expect(rescored.metadata.rescored).toBe(true);
    // Unrelated metadata is preserved.
    expect(rescored.metadata.workflows).toEqual(['test-wf']);
  });

  describe('concurrent scorers', () => {
    const costScorer = (name: string, cost: number): Scorer => ({
      name,
      description: name,
      isLlm: false,
      score: async () => ({ score: 1, cost }),
    });

    it('runs scorers concurrently and accumulates their cost', async () => {
      const result = makeResult();
      const rescored = await rescore(
        result,
        [costScorer('a', 0.01), costScorer('b', 0.02)],
        mockRuntime,
        {
          scorerConcurrency: 2,
        },
      );

      // Both judges ran concurrently and each reported its own claim; neither
      // is summed into the measured total on an uninstrumented runtime.
      expect(rescored.totalCost).toBe(0);
      for (const item of rescored.items) {
        expect(item.scores.a).toBe(1);
        expect(item.scores.b).toBe(1);
        expect(item.scoreDetails!.a.cost).toBe(0.01);
        expect(item.scoreDetails!.b.cost).toBe(0.02);
      }
    });

    it('one throwing scorer does not reject the batch', async () => {
      const bad: Scorer = {
        name: 'bad',
        description: 'b',
        isLlm: false,
        score: async () => {
          throw new Error('kaboom');
        },
      };
      const result = makeResult();
      const rescored = await rescore(result, [alwaysOneScorer, bad], mockRuntime, {
        scorerConcurrency: 2,
      });

      for (const item of rescored.items) {
        expect(item.scores['always-one']).toBe(1);
        expect(item.scores.bad).toBeNull();
        expect(item.scorerErrors![0]).toContain('kaboom');
      }
    });
  });

  describe('budget (A13.4)', () => {
    /** A judge on its own provider so judging spend is exactly predictable. */
    function judgeOn(runtime: AxlRuntime, cost: number, name: string): Scorer {
      (
        runtime as unknown as { registerProvider: (n: string, p: unknown) => void }
      ).registerProvider('judgep', {
        name: 'judgep',
        chat: async () => ({
          content: JSON.stringify({ score: 1, reasoning: 'x' }),
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          cost,
        }),
      });
      return llmScorer({
        name,
        description: 'judge',
        model: 'judgep:model',
        system: 'Rate it',
        schema: z.object({ score: z.number(), reasoning: z.string() }),
      }) as unknown as Scorer;
    }

    it("does NOT seed the source run's spend into the rescore budget", async () => {
      // This is the load-bearing claim of a rescore budget: the original run's
      // cost is history. Seeding it would make a $2 rescore budget useless after
      // a $2 run — the controller would open already closed and refuse every
      // judge, which reads as "your judges are broken" rather than "you already
      // spent this".
      const { runtime } = scriptedRuntime([{ cost: 0.5 }]);
      const original = await runEval(
        {
          workflow: 'w',
          dataset: dataset({
            name: 'd',
            schema: z.object({ q: z.string() }),
            items: [{ input: { q: 'a' } }, { input: { q: 'b' } }],
          }),
          scorers: [],
        },
        askExecute(),
        runtime,
      );
      expect(original.accounting!.knownCost).toBeCloseTo(1, 10);

      const judge = judgeOn(runtime, 0.1, 'judge');
      const rescored = await rescore(original, [judge], runtime, { budget: '$1' });

      // A $1 budget against $0.20 of new judging: nothing is refused, even
      // though the source run alone already spent the whole $1.
      expect(rescored.accounting!.budget).toMatchObject({ limit: 1, status: 'open' });
      expect(rescored.accounting!.knownCost).toBeCloseTo(0.2, 10);
      expect(rescored.items.every((i) => i.scores.judge === 1)).toBe(true);
      expect(rescored.summary.coverage!.scorers.judge.budget_skipped).toBe(0);
    });

    it('closes on new judging spend and marks later judges budget_skipped', async () => {
      const { runtime } = scriptedRuntime([{ cost: 0 }]);
      const original = await runEval(
        {
          workflow: 'w',
          dataset: dataset({
            name: 'd',
            schema: z.object({ q: z.string() }),
            items: [{ input: { q: 'a' } }, { input: { q: 'b' } }, { input: { q: 'c' } }],
          }),
          scorers: [],
        },
        askExecute(),
        runtime,
      );

      const judge = judgeOn(runtime, 0.6, 'judge');
      const rescored = await rescore(original, [judge], runtime, {
        budget: '$1',
        concurrency: 1,
      });

      // Two judges reach $1.20; the third is refused.
      expect(rescored.accounting!.budget).toMatchObject({ status: 'closed', limit: 1 });
      const outcomes = rescored.items.map((i) => i.scoreDetails!.judge.outcome);
      expect(outcomes).toEqual(['scored', 'scored', 'budget_skipped']);
      expect(rescored.summary.coverage!.scorers.judge.budget_skipped).toBe(1);
      // A skipped judge is not a scorer failure and not a scored 0.
      expect(rescored.summary.scorers.judge.scored).toBe(2);
      expect(rescored.summary.scorers.judge.failed).toBe(0);
      expect(rescored.summary.scorers.judge.mean).toBe(1);
    });

    it('rejects an invalid rescore budget before scoring anything', async () => {
      const { runtime, provider } = scriptedRuntime([{ cost: 0 }]);
      const original = await runEval(
        {
          workflow: 'w',
          dataset: dataset({
            name: 'd',
            schema: z.object({ q: z.string() }),
            items: [{ input: { q: 'a' } }],
          }),
          scorers: [],
        },
        askExecute(),
        runtime,
      );
      const callsBefore = provider.callCount;
      const judge = judgeOn(runtime, 0.1, 'judge');

      await expect(rescore(original, [judge], runtime, { budget: 'free' })).rejects.toThrow(
        /INVALID_BUDGET|budget/i,
      );
      expect(provider.callCount).toBe(callsBefore);
    });

    it('leaves the source run untouched', async () => {
      const { runtime } = scriptedRuntime([{ cost: 0.5 }]);
      const original = await runEval(
        {
          workflow: 'w',
          dataset: dataset({
            name: 'd',
            schema: z.object({ q: z.string() }),
            items: [{ input: { q: 'a' } }],
          }),
          scorers: [],
        },
        askExecute(),
        runtime,
      );
      const snapshot = JSON.stringify(original);

      const judge = judgeOn(runtime, 2, 'judge');
      await rescore(original, [judge], runtime, { budget: '$0.10' });

      expect(JSON.stringify(original)).toBe(snapshot);
    });
  });
});
