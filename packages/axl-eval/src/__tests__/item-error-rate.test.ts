/**
 * The default-on item coverage gate (adaptive-rate-governance AC1–AC6, matrix
 * E-01…E-06).
 *
 * The origin is two committed baseline runs that silently lost 250 of 339 and
 * 157 of 340 items, exited clean, and were scored over the survivors. These
 * cases pin that such a run is flagged at produce time (`runEval` →
 * `summary.itemErrorRate`) and refused at consume time
 * (`evaluateItemErrorRateGate`), with one rate definition shared by both.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AxlError, ProviderError } from '@axlsdk/axl';

import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';
import { runEval } from '../runner.js';
import { evaluateItemErrorRateGate } from '../compare.js';
import { validateEvalConfig } from '../cli-validate.js';
import { parseEvalArgs, KNOWN_FLAGS, VALUE_FLAGS } from '../cli-args.js';
import { formatCoverageLine, itemErrorRateMessage } from '../cli-format.js';
import { evaluateItemErrorRate } from '../utils.js';
import type { EvalConfig, EvalItem, EvalResult } from '../types.js';
import { askExecute, scriptedRuntime } from './accounting-helpers.js';

const pass = scorer({ name: 'pass', description: 'always 1', score: () => 1 });

function ds(n: number) {
  return dataset({
    name: `ds-${n}`,
    schema: z.object({ i: z.number() }),
    items: Array.from({ length: n }, (_, i) => ({ input: { i } })),
  });
}

/** Fails the items whose index is in `failing` with a 429, completes the rest. */
function failingExecute(failing: (i: number) => boolean) {
  return async (input: unknown) => {
    const { i } = input as { i: number };
    if (failing(i)) {
      throw new ProviderError({
        provider: 'openai',
        status: 429,
        retryable: true,
        message: 'Rate limit reached',
      });
    }
    return { output: `ok ${i}` };
  };
}

function config(n: number, extra?: Partial<EvalConfig>): EvalConfig {
  return {
    workflow: 'w',
    dataset: ds(n) as EvalConfig['dataset'],
    scorers: [pass] as EvalConfig['scorers'],
    concurrency: 4,
    ...extra,
  };
}

function runtime() {
  return scriptedRuntime([{ cost: 0 }]).runtime;
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1 / AC3 / AC4 — produce time
// ═══════════════════════════════════════════════════════════════════════════

describe('runEval: item error rate at produce time', () => {
  // E-01 / AC1: the customer's lock, 250 of 339.
  it('flags the 250-of-339 lock with the exact rate and the default limit', async () => {
    const result = await runEval(
      config(339),
      failingExecute((i) => i < 250),
      runtime(),
    );

    expect(result.summary.coverage!.items.failed).toBe(250);
    expect(result.summary.coverage!.items.completed).toBe(89);
    expect(result.summary.itemErrorRate).toEqual({
      failed: 250,
      attempted: 339,
      rate: 250 / 339,
      limit: 0.05,
      exceeded: true,
    });
    const message = itemErrorRateMessage(result, 'lock.eval.ts')!;
    expect(message).toContain('ITEM ERROR RATE EXCEEDED: lock.eval.ts');
    expect(message).toContain('item error rate 73.7%');
    expect(message).toContain('over the 5% limit');
    expect(message).toContain('250 of 339');
  });

  // E-02 / AC2 (guard): a clean run's summary gains no key at all.
  it('leaves a fully successful run without an itemErrorRate key or a coverage line', async () => {
    const result = await runEval(
      config(20),
      failingExecute(() => false),
      runtime(),
    );

    expect('itemErrorRate' in result.summary).toBe(false);
    expect(result.items.every((i) => i.outcome === 'completed')).toBe(true);
    expect(formatCoverageLine(result)).toBeUndefined();
    expect(itemErrorRateMessage(result, 'x')).toBeNull();
  });

  // E-03a / E-04b / AC3 / AC4: the default is 0.05 and fires on strictly `>`.
  it('does not fire at exactly 5 of 100 and fires at 6 of 100', async () => {
    const atLimit = await runEval(
      config(100),
      failingExecute((i) => i < 5),
      runtime(),
    );
    expect(atLimit.summary.itemErrorRate).toMatchObject({
      failed: 5,
      attempted: 100,
      limit: 0.05,
      exceeded: false,
    });
    expect(itemErrorRateMessage(atLimit, 'x')).toBeNull();

    const overLimit = await runEval(
      config(100),
      failingExecute((i) => i < 6),
      runtime(),
    );
    expect(overLimit.summary.itemErrorRate).toMatchObject({
      failed: 6,
      attempted: 100,
      limit: 0.05,
      exceeded: true,
    });
  });

  // E-03b / AC3: a configured limit round-trips into the summary.
  it('records the configured limit, and does not flag a run under it', async () => {
    const result = await runEval(
      config(100, { failOnItemErrorRate: 0.1 }),
      failingExecute((i) => i < 6),
      runtime(),
    );

    expect(result.summary.itemErrorRate).toMatchObject({ limit: 0.1, exceeded: false });
    // The rate is still shown, informationally, on the coverage line.
    expect(formatCoverageLine(result)).toBe(
      '  Items: 94 completed, 6 failed — item error rate 6% (limit 10%)',
    );
  });

  // E-03d / AC3: `1` disables the gate but keeps the rate visible.
  it('never fires at a limit of 1, even when 90% of items fail', async () => {
    const result = await runEval(
      config(10, { failOnItemErrorRate: 1 }),
      failingExecute((i) => i < 9),
      runtime(),
    );

    expect(result.summary.itemErrorRate).toMatchObject({
      failed: 9,
      attempted: 10,
      limit: 1,
      exceeded: false,
    });
    expect(itemErrorRateMessage(result, 'x')).toBeNull();
    expect(formatCoverageLine(result)).toContain('item error rate 90% (limit 100%)');
  });

  // E-03e / Q2: programmatic runEval THROWS, before the dataset loads.
  it.each([[1.5], [-0.1], [Number.NaN], [Number.POSITIVE_INFINITY], ['0.5']])(
    'throws INVALID_ITEM_ERROR_RATE on %p without loading the dataset',
    async (limit) => {
      const cfg = config(3, { failOnItemErrorRate: limit as number });
      const getItems = vi.spyOn(cfg.dataset, 'getItems');
      const execute = vi.fn(failingExecute(() => false));

      const run = runEval(cfg, execute, runtime());
      await expect(run).rejects.toThrow(AxlError);
      await expect(run).rejects.toMatchObject({ code: 'INVALID_ITEM_ERROR_RATE' });
      expect(getItems).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  // `null` is "unset", as it is for `budget`: the default applies, never "off".
  it('applies the default when the limit is null', async () => {
    const result = await runEval(
      config(10, { failOnItemErrorRate: null as unknown as number }),
      failingExecute((i) => i < 1),
      runtime(),
    );
    expect(result.summary.itemErrorRate).toMatchObject({ limit: 0.05, exceeded: true });
  });

  // E-04a / AC4 / Q1: cancelled and budget-stopped items leave the denominator.
  it('excludes cancelled items from the denominator and never counts them as failed', async () => {
    const controller = new AbortController();
    // Sequential, so the item order is the dataset order: 0–1 fail, 2–3
    // complete, then the abort cancels 4–9.
    const result = await runEval(
      config(10, { concurrency: 1 }),
      async (input) => {
        const { i } = input as { i: number };
        if (i < 2) throw new Error(`boom ${i}`);
        if (i === 3) controller.abort();
        return { output: i };
      },
      runtime(),
      { signal: controller.signal },
    );

    expect(result.summary.coverage!.items).toMatchObject({
      failed: 2,
      completed: 2,
      cancelled: 6,
    });
    // 2 / (10 − 6) = 0.5, NOT 2/10 and NOT legacy `failures` (8) / 4.
    expect(result.summary.itemErrorRate).toEqual({
      failed: 2,
      attempted: 4,
      rate: 0.5,
      limit: 0.05,
      exceeded: true,
    });
    expect(result.summary.failures).toBe(8);
  });

  // E-04c / AC4: a budget-stopped run does not trip the item gate a second time.
  it('does not flag a budget stop with no workflow failures', async () => {
    const { runtime: rt } = scriptedRuntime([{ cost: 0.5 }]);
    const result = await runEval(config(4, { budget: '$1', concurrency: 1 }), askExecute(), rt);

    expect(result.summary.coverage!.items.budget_skipped).toBeGreaterThan(0);
    expect(result.summary.coverage!.items.failed).toBe(0);
    expect('itemErrorRate' in result.summary).toBe(false);
  });

  // E-04d / AC4: nothing attempted → no NaN, no fire.
  it('reports no rate for a run whose every item was cancelled before starting', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runEval(
      config(5),
      failingExecute(() => true),
      runtime(),
      {
        signal: controller.signal,
      },
    );

    expect(result.summary.coverage!.items.cancelled).toBe(5);
    expect('itemErrorRate' in result.summary).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });
});

describe('evaluateItemErrorRate (shared rule)', () => {
  const zeros = { completed: 0, failed: 0, cancelled: 0, budget_skipped: 0, budget_interrupted: 0 };

  it('uses count minus cancelled and both budget outcomes as the denominator', () => {
    // E-04a exactly: 2 failed, 3 cancelled, 2 budget_skipped, 1 budget_interrupted, 2 completed.
    const verdict = evaluateItemErrorRate(
      { completed: 2, failed: 2, cancelled: 3, budget_skipped: 2, budget_interrupted: 1 },
      10,
      0.05,
    );
    expect(verdict).toEqual({ failed: 2, attempted: 4, rate: 0.5, limit: 0.05, exceeded: true });
  });

  it('never fires on a zero denominator, even at a limit of 0', () => {
    const verdict = evaluateItemErrorRate({ ...zeros, cancelled: 3 }, 3, 0);
    expect(verdict).toEqual({ failed: 0, attempted: 0, rate: 0, limit: 0, exceeded: false });
  });

  it('fires on any failure at a limit of 0', () => {
    expect(evaluateItemErrorRate({ ...zeros, completed: 99, failed: 1 }, 100, 0).exceeded).toBe(
      true,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 — load-time validation and the CLI flag
// ═══════════════════════════════════════════════════════════════════════════

describe('failOnItemErrorRate validation at load', () => {
  const base = {
    workflow: 'w',
    dataset: { getItems: async () => [] },
    scorers: [{ score: () => 1 }],
  };

  it.each([[1.5], [-0.1], [Number.NaN], ['0.5']])('rejects %p', (v) => {
    expect(validateEvalConfig({ ...base, failOnItemErrorRate: v })).toMatch(
      /invalid failOnItemErrorRate .*between 0 and 1/,
    );
  });

  it.each([[0], [0.05], [1], [undefined], [null]])('accepts %p', (v) => {
    expect(validateEvalConfig({ ...base, failOnItemErrorRate: v })).toBeUndefined();
  });
});

describe('--max-item-error-rate (run command)', () => {
  it('is a known, value-taking flag', () => {
    expect(KNOWN_FLAGS.has('--max-item-error-rate')).toBe(true);
    expect(VALUE_FLAGS.has('--max-item-error-rate')).toBe(true);
  });

  it('parses a clean decimal and keeps the path', () => {
    const parsed = parseEvalArgs(['a.eval.ts', '--max-item-error-rate', '0.02']);
    expect(parsed.maxItemErrorRate).toBe(0.02);
    expect(parsed.paths).toEqual(['a.eval.ts']);
  });

  it.each([['1.5'], ['5'], ['0.5abc'], ['-0.1'], ['abc']])('exits on %p', (raw) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => parseEvalArgs(['a.eval.ts', '--max-item-error-rate', raw])).toThrow('exit 1');
      expect(error).toHaveBeenCalledWith(
        `Error: --max-item-error-rate must be a number in [0, 1], got "${raw}"`,
      );
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 / AC6 — consume time
// ═══════════════════════════════════════════════════════════════════════════

/** A minimal current-format artifact with `failed` of `count` items failed. */
function artifact(id: string, count: number, failed: number): EvalResult {
  const items: EvalItem[] = Array.from({ length: count }, (_, i) =>
    i < failed
      ? { input: i, output: null, error: 'boom', outcome: 'failed', scores: {} }
      : { input: i, output: i, outcome: 'completed', scores: { pass: 1 } },
  );
  return {
    id,
    dataset: 'ds',
    metadata: {},
    timestamp: '2026-09-22T00:00:00.000Z',
    totalCost: 0,
    duration: 0,
    items,
    summary: {
      count,
      failures: failed,
      coverage: {
        items: {
          completed: count - failed,
          failed,
          cancelled: 0,
          budget_skipped: 0,
          budget_interrupted: 0,
        },
        scorers: {},
      },
      scorers: { pass: { mean: 1, min: 1, max: 1, p50: 1, p95: 1 } },
    },
  };
}

/** The same artifact as a pre-0.24 file: no coverage, no item outcomes. */
function legacy(id: string, count: number, failed: number): EvalResult {
  const a = artifact(id, count, failed);
  delete a.summary.coverage;
  for (const item of a.items) delete item.outcome;
  return a;
}

describe('evaluateItemErrorRateGate (compare floor)', () => {
  // E-05a: refuses by default and names coverage and the side.
  it('refuses a thinned candidate by default, naming coverage and the candidate', () => {
    const reason = evaluateItemErrorRateGate(artifact('base', 100, 0), artifact('cand', 100, 10));
    expect(reason).toMatch(/^coverage: candidate \(cand\) item error rate 10%/);
    expect(reason).toContain('(10/100 attempted items failed)');
    expect(reason).toContain('exceeds the 5% limit');
  });

  it('names the baseline when the baseline is the thinned side', () => {
    const reason = evaluateItemErrorRateGate(artifact('base', 100, 10), artifact('cand', 100, 0));
    expect(reason).toMatch(/^coverage: baseline \(base\)/);
  });

  // E-05b: the flag overrides the default.
  it('allows the same comparison under a looser explicit limit', () => {
    expect(
      evaluateItemErrorRateGate(artifact('base', 100, 0), artifact('cand', 100, 10), 0.2),
    ).toBeNull();
  });

  it('fires on strictly `>` against the limit', () => {
    expect(
      evaluateItemErrorRateGate(artifact('base', 100, 0), artifact('cand', 100, 5)),
    ).toBeNull();
    expect(
      evaluateItemErrorRateGate(artifact('base', 100, 0), artifact('cand', 100, 6)),
    ).not.toBeNull();
  });

  // E-05c / m7: a legacy artifact is gated on its derived rate, never skipped.
  it('gates a pre-0.24 artifact on the rate derived from its items', () => {
    const reason = evaluateItemErrorRateGate(legacy('base', 100, 0), legacy('cand', 100, 10));
    expect(reason).toContain('candidate (cand) item error rate 10%');
    expect(reason).toContain('derived from the items of a pre-0.24 artifact');
    expect(evaluateItemErrorRateGate(legacy('base', 100, 0), legacy('cand', 100, 3))).toBeNull();
  });

  // E-05d: a rescore artifact keeps the source's outcomes and is gated on them.
  it('gates a rescore artifact on the outcomes it carried through', () => {
    const rescored = artifact('rescored', 20, 4);
    rescored.accounting = {
      scope: 'rescore',
    } as EvalResult['accounting'];
    expect(evaluateItemErrorRateGate(artifact('base', 20, 0), rescored)).toContain(
      'candidate (rescored) item error rate 20%',
    );
  });

  // AC6 applied at consume time: runs are gated one by one, not pooled.
  it('refuses a multi-run side when one run is thinned, even though the pool is not', () => {
    const baseline = [artifact('b1', 100, 0), artifact('b2', 100, 0), artifact('b3', 100, 0)];
    // Pooled: 10/300 ≈ 3.3%, under the limit. Run 2 alone: 10%.
    const candidate = [artifact('c1', 100, 0), artifact('c2', 100, 10), artifact('c3', 100, 0)];
    expect(evaluateItemErrorRateGate(baseline, candidate)).toMatch(
      /^coverage: candidate run 2 \(c2\) item error rate 10%/,
    );
  });

  it('ignores runs outside the truncated pool evalCompare compares', () => {
    // Baseline has 2 runs, so only the first 2 candidate runs are compared.
    const baseline = [artifact('b1', 100, 0), artifact('b2', 100, 0)];
    const candidate = [artifact('c1', 100, 0), artifact('c2', 100, 0), artifact('c3', 100, 50)];
    expect(evaluateItemErrorRateGate(baseline, candidate)).toBeNull();
  });

  it('throws on an invalid limit rather than disabling the floor', () => {
    expect(() => evaluateItemErrorRateGate(artifact('b', 1, 0), artifact('c', 1, 0), 2)).toThrow(
      /Invalid maxItemErrorRate/,
    );
  });
});
