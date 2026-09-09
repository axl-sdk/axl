/**
 * Eval budgets and the item/scorer outcome taxonomy (matrix A5–A7, A9, A15).
 *
 * A budget is a THRESHOLD, not a reservation: Axl stops scheduling new spend
 * once known spend reaches the limit, and reports how far past it the in-flight
 * calls carried the run. These cases pin that contract, and pin that "we
 * stopped paying" stays distinguishable from "the workflow broke".
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AxlError, BudgetExceededError } from '@axlsdk/axl';
import type { AxlRuntime as AxlRuntimeType } from '@axlsdk/axl';

import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';
import { llmScorer } from '../llm-scorer.js';
import { runEval } from '../runner.js';
import { askExecute, deferred, fixtureAgent, scriptedRuntime } from './accounting-helpers.js';

const pass = scorer({ name: 'pass', description: 'always 1', score: () => 1 });

function ds(n: number) {
  return dataset({
    name: `ds-${n}`,
    schema: z.object({ q: z.string() }),
    items: Array.from({ length: n }, (_, i) => ({ input: { q: `q${i}` } })),
  });
}

/** A judge on its own provider, so its spend is attributable. */
function judgeOn(runtime: AxlRuntimeType, cost: number, name = 'judge') {
  runtime.registerProvider('judgep', {
    name: 'judgep',
    chat: async () => ({
      content: JSON.stringify({ score: 1, reasoning: 'x' }),
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      cost,
    }),
  } as never);
  return llmScorer({
    name,
    description: 'judge',
    model: 'judgep:model',
    system: 'Rate it',
    schema: z.object({ score: z.number(), reasoning: z.string() }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// A5 — the limit is validated before anything is spent or even loaded
// ═══════════════════════════════════════════════════════════════════════════

describe('A5: an unusable budget fails before the run starts', () => {
  // A5.6
  it.each([['-1'], ['abc'], ['$'], [''], ['1.2.3'], ['Infinity'], ['$1,000'], [{ limit: 1 }]])(
    'rejects %p without loading the dataset',
    async (budget) => {
      const data = ds(2);
      const getItems = vi.spyOn(data, 'getItems');
      const { runtime } = scriptedRuntime([{ cost: 0.1 }]);

      await expect(
        runEval(
          { workflow: 'w', dataset: data, scorers: [pass], budget: budget as string },
          askExecute(),
          runtime,
        ),
      ).rejects.toThrow(AxlError);

      // Loading a dataset can be expensive (a file read, a fetch). A budget the
      // runner can never honor must be caught before any of that happens.
      expect(getItems).not.toHaveBeenCalled();
    },
  );

  // A5.6b
  it.each([[undefined], [null]])(
    'treats %p as "no budget" rather than as an invalid one',
    async (budget) => {
      // A JSON/YAML eval config that omits the key deserializes to `null`. That
      // is an absent budget, not a malformed one — refusing to run would make
      // every unbudgeted config file an error.
      const { runtime } = scriptedRuntime([{ cost: 0.1 }]);
      const result = await runEval(
        { workflow: 'w', dataset: ds(2), scorers: [pass], budget: budget as undefined },
        askExecute(),
        runtime,
      );
      expect(result.accounting!.budget).toBeUndefined();
      expect(result.items.every((i) => i.outcome === 'completed')).toBe(true);
    },
  );

  // A5.7
  it.each([['$1'], ['1'], ['0.50'], ['$0.50'], ['$10.00']])(
    'accepts the documented shape %p',
    async (budget) => {
      const { runtime } = scriptedRuntime([{ cost: 0 }]);
      const result = await runEval(
        { workflow: 'w', dataset: ds(1), scorers: [pass], budget },
        askExecute(),
        runtime,
      );
      expect(result.accounting!.budget!.limit).toBeCloseTo(Number(budget.replace('$', '')), 10);
    },
  );

  // A5.8
  it('admits nothing at all under a $0 budget', async () => {
    const { runtime, provider } = scriptedRuntime([{ cost: 0.1 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(3), scorers: [pass], budget: '$0' },
      askExecute(),
      runtime,
    );

    expect(provider.callCount).toBe(0);
    expect(result.items.every((i) => i.outcome === 'budget_skipped')).toBe(true);
    expect(result.accounting!.knownCost).toBe(0);
    expect(result.accounting!.budget).toMatchObject({
      limit: 0,
      status: 'closed',
      knownSpend: 0,
      knownOvershoot: 0,
    });
    // Nothing ran, so nothing failed — a $0 budget is not a broken eval.
    expect(result.summary.coverage!.items.failed).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A6 — the threshold, and what crossing it does to concurrent work
// ═══════════════════════════════════════════════════════════════════════════

describe('A6: crossing the limit stops scheduling, and says by how much', () => {
  // A6.5
  it('closes at exactly the limit (>=, not >)', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.5 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(3), scorers: [pass], budget: '$1', concurrency: 1 },
      askExecute(),
      runtime,
    );

    // Two items reach exactly $1.00. `>=` means the third never starts.
    expect(result.items.map((i) => i.outcome)).toEqual([
      'completed',
      'completed',
      'budget_skipped',
    ]);
    expect(result.accounting!.budget!.knownOvershoot).toBe(0);
    expect(result.accounting!.budget!.status).toBe('closed');
  });

  // A6.6
  it('lets concurrent in-flight calls settle and reports the overshoot', async () => {
    // Both items are dispatched before either settles, so both are admitted
    // against a $1 limit and together carry the run to $1.50. That is the
    // documented threshold behavior — the run must report the $0.50, not
    // pretend it did not happen and not cancel a paid call mid-flight.
    const gate = deferred();
    let dispatched = 0;
    const bothDispatched = deferred();
    const { runtime } = scriptedRuntime([{ cost: 0.75 }], {
      onCall: async () => {
        if (++dispatched === 2) bothDispatched.resolve();
        await gate.promise;
      },
    });

    const running = runEval(
      { workflow: 'w', dataset: ds(3), scorers: [pass], budget: '$1', concurrency: 2 },
      askExecute(),
      runtime,
    );
    await bothDispatched.promise;
    gate.resolve();
    const result = await running;

    expect(result.items[0].outcome).toBe('completed');
    expect(result.items[1].outcome).toBe('completed');
    expect(result.items[2].outcome).toBe('budget_skipped');
    expect(result.accounting!.knownCost).toBeCloseTo(1.5, 10);
    expect(result.accounting!.budget).toMatchObject({
      limit: 1,
      status: 'closed',
      knownOvershoot: 0.5,
    });
    expect(result.accounting!.budget!.knownSpend).toBeCloseTo(1.5, 10);
  });

  // A6.7
  it('stays open, with no overshoot, when the run never reaches the limit', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.1 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(2), scorers: [pass], budget: '$5' },
      askExecute(),
      runtime,
    );

    expect(result.accounting!.budget).toMatchObject({ status: 'open', knownOvershoot: 0 });
    expect(result.accounting!.budget!.closedBy).toBeUndefined();
    expect(result.items.every((i) => i.outcome === 'completed')).toBe(true);
  });

  // A6.8
  it('stops a case mid-flight when its NEXT call is denied, keeping the earlier charge', async () => {
    // The single case asks twice. The first ask alone exhausts the budget, so
    // the second is refused — the case cannot finish, but the money already
    // spent on it is real and must survive on the item.
    const { runtime } = scriptedRuntime([{ cost: 1 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass], budget: '$1' },
      askExecute({ askCount: 2 }),
      runtime,
    );

    const item = result.items[0];
    expect(item.outcome).toBe('budget_interrupted');
    expect(item.error).toBe('Budget interrupted');
    expect(item.accounting!.breakdown.generation).toBeCloseTo(1, 10);
    expect(result.accounting!.knownCost).toBeCloseTo(1, 10);
    // A budget stop is not a workflow failure.
    expect(result.summary.coverage!.items.failed).toBe(0);
    expect(result.summary.coverage!.items.budget_interrupted).toBe(1);
  });

  // A6.9
  it("does not apply an unbudgeted run's spend to any threshold", async () => {
    const { runtime } = scriptedRuntime([{ cost: 5 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(3), scorers: [pass] },
      askExecute(),
      runtime,
    );

    expect(result.accounting!.budget).toBeUndefined();
    expect(result.items.every((i) => i.outcome === 'completed')).toBe(true);
    expect(result.accounting!.knownCost).toBeCloseTo(15, 10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A7 — judging spend counts against the budget too
// ═══════════════════════════════════════════════════════════════════════════

describe('A7: a judge can exhaust the budget, and the run says so', () => {
  // A7.1 / A7.2
  it('stops later cases AND later LLM scorers, while deterministic scorers finish', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    const judge = judgeOn(runtime, 2, 'llmJudge');
    const deterministic = scorer({
      name: 'exact',
      description: 'no model call',
      score: () => 1,
    });

    const result = await runEval(
      {
        workflow: 'w',
        dataset: ds(3),
        scorers: [judge, deterministic],
        budget: '$1',
        concurrency: 1,
        scorerConcurrency: 1,
      },
      askExecute(),
      runtime,
    );

    // Item 0's judge alone blows past $1.
    expect(result.items[0].scoreDetails!.llmJudge.outcome).toBe('scored');
    expect(result.items[0].outcome).toBe('completed');
    // Subsequent cases never start...
    expect(result.items[1].outcome).toBe('budget_skipped');
    expect(result.items[2].outcome).toBe('budget_skipped');
    // ...and the deterministic scorer still runs on the item that did.
    expect(result.items[0].scoreDetails!.exact.outcome).toBe('scored');
    expect(result.items[0].scoreDetails!.exact.score).toBe(1);

    expect(result.accounting!.breakdown.judging).toBeCloseTo(2, 10);
    expect(result.accounting!.budget).toMatchObject({
      status: 'closed',
      closedBy: 'scorer',
      knownOvershoot: 1,
    });
  });

  // A7.3
  it('skips a further LLM scorer on an item whose earlier judge closed the budget', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    const expensive = judgeOn(runtime, 2, 'first');
    const second = llmScorer({
      name: 'second',
      description: 'judge',
      model: 'judgep:model',
      system: 'Rate it',
      schema: z.object({ score: z.number(), reasoning: z.string() }),
    });
    const deterministic = scorer({ name: 'exact', description: 'local', score: () => 0.25 });

    const result = await runEval(
      {
        workflow: 'w',
        dataset: ds(1),
        scorers: [expensive, second, deterministic],
        budget: '$1',
        scorerConcurrency: 1,
      },
      askExecute(),
      runtime,
    );

    const details = result.items[0].scoreDetails!;
    expect(details.first.outcome).toBe('scored');
    expect(details.second.outcome).toBe('budget_skipped');
    expect(details.second.score).toBeNull();
    expect(details.exact.outcome).toBe('scored');
  });

  // A7.4
  it('excludes budget-skipped judges from the scorer mean and the failure rate', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    const judge = judgeOn(runtime, 2, 'llmJudge');

    const result = await runEval(
      { workflow: 'w', dataset: ds(3), scorers: [judge], budget: '$1', concurrency: 1 },
      askExecute(),
      runtime,
    );

    const stats = result.summary.scorers.llmJudge;
    // Exactly one judge ran and scored 1; the unrun ones must not drag the mean
    // toward 0 nor be counted as scorer errors.
    expect(stats.mean).toBe(1);
    expect(stats.scored).toBe(1);
    expect(stats.failed).toBe(0);
    // The two unrun cases are budget-skipped at the CASE level, so the judge
    // never reached a decision on them — that is reported on item coverage,
    // not as two phantom scorer decisions.
    expect(result.summary.coverage!.items.budget_skipped).toBe(2);
    expect(result.summary.coverage!.scorers.llmJudge.scored).toBe(1);
  });

  // A7.5
  it('attributes closure to the case when a case call crossed the limit', async () => {
    const { runtime } = scriptedRuntime([{ cost: 2 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(2), scorers: [pass], budget: '$1', concurrency: 1 },
      askExecute(),
      runtime,
    );

    expect(result.accounting!.budget!.closedBy).toBe('case');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A9 / A15 — outcomes stay distinguishable, and coverage adds up
// ═══════════════════════════════════════════════════════════════════════════

describe('A9/A15: a stopped run reads differently from a broken one', () => {
  // A15.1
  it('separates cancellation from a budget stop and from a failure', async () => {
    const controller = new AbortController();
    const { runtime } = scriptedRuntime([{ cost: 0 }]);

    const running = runEval(
      { workflow: 'w', dataset: ds(4), scorers: [pass], concurrency: 1 },
      askExecute({
        afterAsks: (input) => {
          if ((input as { q: string }).q === 'q0') controller.abort();
        },
      }),
      runtime,
      { signal: controller.signal },
    );
    const result = await running;

    expect(result.items[0].outcome).toBe('completed');
    expect(result.items.slice(1).every((i) => i.outcome === 'cancelled')).toBe(true);
    // Cancellation is its own bucket — never `failed`, never `budget_skipped`.
    expect(result.summary.coverage!.items).toMatchObject({
      completed: 1,
      cancelled: 3,
      failed: 0,
      budget_skipped: 0,
      budget_interrupted: 0,
    });
    expect(result.accounting!.budget).toBeUndefined();
  });

  // A15.2
  it('keeps a workflow-author ctx.budget separate from the eval run budget', async () => {
    // `ctx.budget` is the WORKFLOW author's own limit and stops only that
    // branch: it catches its own overrun and reports `budgetExceeded`. The case
    // therefore COMPLETES, its spend is accounted, and the eval run — which has
    // no budget of its own here — must not acquire one or report a stop.
    const { runtime } = scriptedRuntime([{ cost: 0.4 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] },
      async (_input, rt) => {
        const ctx = rt.createContext();
        const budgeted = await ctx.budget({ cost: '$0.50' }, async () => {
          await ctx.ask(fixtureAgent, 'a');
          await ctx.ask(fixtureAgent, 'b');
          await ctx.ask(fixtureAgent, 'c');
        });
        return { output: { budgetExceeded: budgeted.budgetExceeded } };
      },
      runtime,
    );

    expect(result.items[0].outcome).toBe('completed');
    expect((result.items[0].output as { budgetExceeded: boolean }).budgetExceeded).toBe(true);
    // Two calls were admitted before the author's limit refused the third.
    expect(result.accounting!.knownCost).toBeCloseTo(0.8, 10);
    expect(result.accounting!.budget).toBeUndefined();
    expect(result.summary.coverage!.items.budget_interrupted).toBe(0);
  });

  // A15.2b
  it('classifies a BudgetExceededError escaping the workflow as a failure', async () => {
    // A workflow that rethrows its own overrun is a case that broke, not the
    // eval deciding to stop spending — conflating them would make an unbudgeted
    // run report a budget stop it never had.
    const { runtime } = scriptedRuntime([{ cost: 0.4 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(1), scorers: [pass] },
      async (_input, rt) => {
        const ctx = rt.createContext();
        const budgeted = await ctx.budget({ cost: '$0.10' }, async () => {
          await ctx.ask(fixtureAgent, 'a');
          await ctx.ask(fixtureAgent, 'b');
        });
        if (budgeted.budgetExceeded) {
          throw new BudgetExceededError(0.1, budgeted.totalCost, 'finish_and_stop');
        }
        return { output: 'out' };
      },
      runtime,
    );

    expect(result.items[0].outcome).toBe('failed');
    expect(result.items[0].error).not.toBe('Budget interrupted');
    expect(result.summary.coverage!.items).toMatchObject({
      failed: 1,
      budget_interrupted: 0,
      budget_skipped: 0,
    });
    // The charge that was already incurred survives the failure.
    expect(result.accounting!.knownCost).toBeCloseTo(0.4, 10);
  });

  // A15.3
  it('keeps coverage counts equal to the item and scorer populations', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.6 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(4), scorers: [pass], budget: '$1', concurrency: 1 },
      askExecute({
        afterAsks: (input) => {
          if ((input as { q: string }).q === 'q1') throw new Error('broke');
        },
      }),
      runtime,
    );

    const items = result.summary.coverage!.items;
    const total =
      items.completed +
      items.failed +
      items.cancelled +
      items.budget_skipped +
      items.budget_interrupted;
    expect(total).toBe(result.items.length);
    expect(total).toBe(result.summary.count);

    // Scorer coverage counts scorer DECISIONS, so its population is the items
    // that produced an output to score — a case that failed or never started
    // gives every scorer nothing to decide about.
    const scorerCoverage = result.summary.coverage!.scorers.pass;
    const scorerTotal =
      scorerCoverage.scored +
      scorerCoverage.failed +
      scorerCoverage.skipped +
      scorerCoverage.budget_skipped +
      scorerCoverage.budget_interrupted +
      scorerCoverage.cancelled;
    expect(scorerTotal).toBe(items.completed);
    expect(scorerCoverage.scored).toBe(items.completed);
  });

  // A15.4
  it('keeps summary.failures legacy, and makes coverage the surface that explains it', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.6 }]);

    const result = await runEval(
      { workflow: 'w', dataset: ds(4), scorers: [pass], budget: '$1', concurrency: 1 },
      askExecute({
        afterAsks: (input) => {
          if ((input as { q: string }).q === 'q0') throw new Error('broke');
        },
      }),
      runtime,
    );

    // `failures` keeps its pre-0.24 meaning — items that produced no output —
    // so it counts the budget-stopped cases too. It is deliberately NOT the
    // regression signal any more: only `coverage` separates "the workflow
    // broke" from "we stopped paying", which is why the CLI's wipeout logic
    // reads coverage rather than this number.
    const coverage = result.summary.coverage!.items;
    expect(result.summary.failures).toBe(result.items.filter((i) => i.error).length);
    expect(result.summary.failures).toBe(
      coverage.failed + coverage.budget_skipped + coverage.budget_interrupted + coverage.cancelled,
    );
    expect(coverage.failed).toBe(1);
    expect(coverage.budget_skipped).toBeGreaterThan(0);
  });
});
