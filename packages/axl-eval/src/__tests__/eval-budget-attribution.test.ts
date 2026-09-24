/**
 * Budget attribution rows the first budget suite leaves open.
 *
 * Matrix rows: A6.8 (failed-but-charged cases still trip the threshold),
 * A7.2 (a budget-skipped judge never enters the mean as a 0), A7.3 (judges
 * already launched when the limit is crossed still settle), A7.7 (`closedBy`
 * discriminates case / scorer / operation) and A16.9 (a judge resolves the same
 * provider facade the runtime does, which is what makes A7 enforceable at all).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { AxlRuntime as AxlRuntimeType, Provider } from '@axlsdk/axl';

import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';
import type { Scorer, ScorerContext } from '../scorer.js';
import { llmScorer } from '../llm-scorer.js';
import { runEval } from '../runner.js';
import { askExecute, deferred, scriptedRuntime } from './accounting-helpers.js';

const pass = scorer({ name: 'pass', description: 'always 1', score: () => 1 });

function ds(n: number) {
  return dataset({
    name: `ds-${n}`,
    schema: z.object({ q: z.string() }),
    items: Array.from({ length: n }, (_, i) => ({ input: { q: `q${i}` } })),
  });
}

const JUDGE_SCHEMA = z.object({ score: z.number(), reasoning: z.string() });

/**
 * Register a judge provider whose per-call cost is scripted and whose calls can
 * be held open, so a test can prove that two judges were BOTH in flight before
 * either settled without touching a timer.
 */
function registerJudgeProvider(
  runtime: AxlRuntimeType,
  costs: number[],
  onCall?: (index: number) => Promise<void> | void,
): { calls: number } {
  const state = { calls: 0 };
  const provider: Provider = {
    name: 'judgep',
    chat: async () => {
      const index = state.calls++;
      await onCall?.(index);
      return {
        content: JSON.stringify({ score: 1, reasoning: 'x' }),
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: costs[Math.min(index, costs.length - 1)],
      };
    },
  } as never;
  runtime.registerProvider('judgep', provider);
  return state;
}

function judge(name: string) {
  return llmScorer({
    name,
    description: 'judge',
    model: 'judgep:model',
    system: 'Rate it',
    schema: JUDGE_SCHEMA,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// A6.8 — a case that paid and then broke still counts toward the threshold
// ═══════════════════════════════════════════════════════════════════════════

describe('A6.8: a FAILED but charged case trips the budget like a successful one', () => {
  it('closes after two paid failures and skips the third case', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.75 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(3), scorers: [pass], budget: '$1', concurrency: 1 },
      askExecute({
        afterAsks: () => {
          throw new Error('the workflow broke after paying');
        },
      }),
      runtime,
    );

    // Both failures spent real money. An implementation that only counted
    // successful cases would leave the budget open forever on a failing run.
    expect(result.items[0].outcome).toBe('failed');
    expect(result.items[1].outcome).toBe('failed');
    expect(result.items[2].outcome).toBe('budget_skipped');
    expect(result.accounting!.knownCost).toBeCloseTo(1.5, 10);
    expect(result.accounting!.budget).toMatchObject({
      limit: 1,
      status: 'closed',
      knownOvershoot: 0.5,
    });
    expect(result.summary.coverage!.items.failed).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A7.2 — a skipped judge is absent from the sample, not a zero in it
// ═══════════════════════════════════════════════════════════════════════════

describe('A7.2: a budget-skipped judge never enters its scorer mean as a 0', () => {
  it('keeps the mean at the one score it actually produced', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    // Call order under `concurrency: 1, scorerConcurrency: 1`:
    // item0/first $0.40, item0/second $0.30 (total 0.70, still open),
    // item1/first $0.40 (total 1.10, closes) → item1/second is refused.
    registerJudgeProvider(runtime, [0.4, 0.3, 0.4, 0.4]);

    const result = await runEval(
      {
        workflow: 'w',
        dataset: ds(2),
        scorers: [judge('first'), judge('second')],
        budget: '$1',
        concurrency: 1,
        scorerConcurrency: 1,
      },
      askExecute(),
      runtime,
    );

    expect(result.items[0].scoreDetails!.second.outcome).toBe('scored');
    expect(result.items[1].scoreDetails!.second.outcome).toBe('budget_skipped');
    expect(result.items[1].scoreDetails!.second.score).toBeNull();

    const stats = result.summary.scorers.second;
    // One real decision of 1. Averaging the skipped judge in as a 0 would make
    // this 0.5 and report a quality regression that never happened.
    expect(stats.scored).toBe(1);
    expect(stats.mean).toBe(1);
    expect(stats.failed).toBe(0);
    expect(result.summary.coverage!.scorers.second).toMatchObject({
      scored: 1,
      budget_skipped: 1,
      failed: 0,
    });
    // The item that lost its judge is still a completed item with its output.
    expect(result.items[1].outcome).toBe('completed');
    expect(result.items[1].output).toBe('out');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A7.3 — judges already dispatched when the limit is crossed are not killed
// ═══════════════════════════════════════════════════════════════════════════

describe('A7.3: judges launched before the crossing settle, and the overshoot is reported', () => {
  it('lets two concurrent judges finish while a third is refused', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    const release = deferred();
    const bothDispatched = deferred();
    let dispatched = 0;
    const judgeCalls = registerJudgeProvider(runtime, [0.7], async () => {
      // Hold both judges inside the adapter until the test says otherwise, so
      // neither can settle before the other was admitted.
      if (++dispatched === 2) bothDispatched.resolve();
      await release.promise;
    });

    const running = runEval(
      {
        workflow: 'w',
        dataset: ds(1),
        scorers: [judge('a'), judge('b'), judge('c')],
        budget: '$1',
        scorerConcurrency: 2,
      },
      askExecute(),
      runtime,
    );

    await bothDispatched.promise;
    release.resolve();
    const result = await running;

    const details = result.items[0].scoreDetails!;
    // Killing an in-flight judge is explicitly forbidden: the money is already
    // committed, so throwing away its answer buys nothing.
    expect(details.a.outcome).toBe('scored');
    expect(details.b.outcome).toBe('scored');
    expect(details.c.outcome).toBe('budget_skipped');
    // `c` was refused at scheduling, so it never reached the adapter.
    expect(judgeCalls.calls).toBe(2);

    expect(result.accounting!.breakdown.judging).toBeCloseTo(1.4, 10);
    expect(result.accounting!.budget).toMatchObject({ status: 'closed' });
    expect(result.accounting!.budget!.knownOvershoot).toBeCloseTo(0.4, 10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A7.7 — closedBy names what first observed the crossing
// ═══════════════════════════════════════════════════════════════════════════

describe('A7.7: closedBy discriminates a case, a scorer and an in-case operation', () => {
  it('reports `case` when a completed case carried the run past the limit', async () => {
    const { runtime } = scriptedRuntime([{ cost: 2 }]);
    const result = await runEval(
      { workflow: 'w', dataset: ds(2), scorers: [pass], budget: '$1', concurrency: 1 },
      askExecute(),
      runtime,
    );
    expect(result.items[0].outcome).toBe('completed');
    expect(result.accounting!.budget!.closedBy).toBe('case');
  });

  it('reports `scorer` when a judge on an affordable case crossed it', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.1 }]);
    registerJudgeProvider(runtime, [2]);
    const result = await runEval(
      {
        workflow: 'w',
        dataset: ds(2),
        scorers: [judge('llmJudge')],
        budget: '$1',
        concurrency: 1,
        scorerConcurrency: 1,
      },
      askExecute(),
      runtime,
    );
    expect(result.items[0].outcome).toBe('completed');
    expect(result.accounting!.budget!.closedBy).toBe('scorer');
  });

  it('reports `operation` when a call INSIDE a running case was denied', async () => {
    const { runtime } = scriptedRuntime([{ cost: 1 }]);
    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass], budget: '$1' },
      askExecute({ askCount: 2 }),
      runtime,
    );
    expect(result.items[0].outcome).toBe('budget_interrupted');
    expect(result.accounting!.budget!.closedBy).toBe('operation');
  });

  it('never reports a closedBy for a run that stayed open', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.1 }]);
    const result = await runEval(
      { workflow: 'w', dataset: ds(2), scorers: [pass], budget: '$5' },
      askExecute(),
      runtime,
    );
    expect(result.accounting!.budget!.status).toBe('open');
    expect(result.accounting!.budget!.closedBy).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A16.9 — a judge resolves the same facade the runtime hands anyone else
// ═══════════════════════════════════════════════════════════════════════════

describe('A16.9: ScorerContext.resolveProvider returns the runtime facade, not the raw adapter', () => {
  it('hands a scorer the identical object runtime.resolveProvider returns', async () => {
    const { runtime, provider } = scriptedRuntime([{ cost: 0 }]);

    let seen: { provider: unknown; model: string } | undefined;
    let sawContext = false;
    const probe: Scorer = {
      name: 'probe',
      description: 'captures the resolution its context offers',
      isLlm: true,
      score: (_output, _input, _annotations, context?: ScorerContext) => {
        sawContext = context !== undefined;
        seen = context?.resolveProvider('mock:m');
        return 1;
      },
    };

    await runEval({ workflow: 'w', dataset: ds(1), scorers: [probe] }, askExecute(), runtime);

    expect(sawContext).toBe(true);
    const fromRuntime = runtime.resolveProvider!('mock:m');
    // Strict identity: a judge resolving the RAW adapter would bypass the
    // accounting/admission facade entirely, which is what makes judge spend
    // invisible and every A7 budget row unenforceable.
    expect(seen!.provider).toBe(fromRuntime.provider);
    expect(seen!.model).toBe(fromRuntime.model);
    // …and the facade is emphatically not the registered instance.
    expect(seen!.provider).not.toBe(provider);
  });

  it('routes a real llmScorer call through that facade, so its spend is measured', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    registerJudgeProvider(runtime, [0.2]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [judge('llmJudge')] },
      askExecute(),
      runtime,
    );

    expect(result.items[0].scoreDetails!.llmJudge.outcome).toBe('scored');
    expect(result.accounting!.breakdown.judging).toBeCloseTo(0.2, 10);
    expect(result.items[0].scoreDetails!.llmJudge.accounting!.knownCost).toBeCloseTo(0.2, 10);
  });
});
