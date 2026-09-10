/**
 * A13.1 — a rescore reports the spend IT incurred, and names the generation
 * spend it rests on without absorbing it.
 *
 * Summing the two would tell a reader that re-judging a saved run cost as much
 * as producing it, which is the exact number a cost-comparison would then act
 * on. The source run's own accounting must also come back byte-identical: a
 * rescore reads history, it does not rewrite it.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { AxlRuntime as AxlRuntimeType, Provider } from '@axlsdk/axl';

import { dataset } from '../dataset.js';
import { llmScorer } from '../llm-scorer.js';
import { runEval } from '../runner.js';
import { rescore } from '../rescore.js';
import { askExecute, scriptedRuntime } from './accounting-helpers.js';

function ds(n: number) {
  return dataset({
    name: `ds-${n}`,
    schema: z.object({ q: z.string() }),
    items: Array.from({ length: n }, (_, i) => ({ input: { q: `q${i}` } })),
  });
}

function registerJudge(runtime: AxlRuntimeType, cost: number): void {
  runtime.registerProvider('judgep', {
    name: 'judgep',
    chat: async () => ({
      content: JSON.stringify({ score: 1, reasoning: 'x' }),
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      cost,
    }),
  } as unknown as Provider);
}

const paidJudge = llmScorer({
  name: 'judge',
  description: 'judge',
  model: 'judgep:model',
  system: 'Rate it',
  schema: z.object({ score: z.number(), reasoning: z.string() }),
});

describe('A13.1: rescore spend excludes the original generation', () => {
  it('reports only the new judging, and carries the generation record as provenance', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.75 }]);
    registerJudge(runtime, 0.2);

    const original = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [] },
      askExecute(),
      runtime,
    );
    expect(original.accounting!.knownCost).toBeCloseTo(0.75, 10);
    const originalSnapshot = JSON.parse(JSON.stringify(original.accounting));

    const rescored = await rescore(original, [paidJudge], runtime);

    // The rescore's OWN total: judging only. $0.95 would mean the historical
    // generation had been folded into a number that describes new spend.
    expect(rescored.accounting!.scope).toBe('rescore');
    expect(rescored.accounting!.knownCost).toBeCloseTo(0.2, 10);
    expect(rescored.accounting!.breakdown.generation).toBe(0);
    expect(rescored.accounting!.breakdown.judging).toBeCloseTo(0.2, 10);
    expect(rescored.accounting!.breakdown.external).toBe(0);
    expect(rescored.totalCost).toBeCloseTo(0.2, 10);
    expect(rescored.accounting!.completeness).toBe('complete');

    // Provenance: which run, and what that run's generation actually cost.
    expect(rescored.accounting!.source!.runId).toBe(original.id);
    expect(rescored.accounting!.source!.generation).toEqual(original.accounting);
    expect(rescored.accounting!.source!.generation!.knownCost).toBeCloseTo(0.75, 10);
    expect(rescored.accounting!.source!.generation!.scope).toBe('run');

    // The source artifact is untouched — no in-place mutation of the record the
    // provenance points at.
    expect(JSON.parse(JSON.stringify(original.accounting))).toEqual(originalSnapshot);

    // The per-item view agrees: no generation this time, the judge's cost here.
    expect(rescored.items[0].cost).toBe(0);
    expect(rescored.items[0].scorerCost).toBeCloseTo(0.2, 10);
    expect(rescored.items[0].scoreDetails!.judge.accounting!.knownCost).toBeCloseTo(0.2, 10);
  });
});
