import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { AxlRuntime } from '@axlsdk/axl';
import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';
import type { Scorer } from '../scorer.js';
import { runEval } from '../runner.js';
import { evaluateScorerTolerance } from '../utils.js';

const mockRuntime = {} as AxlRuntime;

/** Build an N-item dataset whose `q` runs 1..N (string-keyed for easy matching). */
function ds(n: number) {
  return dataset({
    name: `ds-${n}`,
    schema: z.object({ q: z.number() }),
    items: Array.from({ length: n }, (_, i) => ({ input: { q: i + 1 } })),
  });
}

const echo = async (input: any) => ({ output: String(input.q) });

/** A plain async LLM-typed scorer literal (the `scorer()` factory is sync-only
 *  and stamps `isLlm: false`). Fails — by throwing — on items where `failOn`
 *  returns true, otherwise returns a valid score. */
function flakyLlm(name: string, failOn: (q: number) => boolean): Scorer {
  return {
    name,
    description: 'flaky judge',
    isLlm: true,
    score: async (_output: unknown, input: unknown) => {
      if (failOn((input as { q: number }).q)) throw new Error('judge unavailable');
      return 0.9;
    },
  } as Scorer;
}

describe('evaluateScorerTolerance (shared gate primitive)', () => {
  it('deterministic: any failure exceeds, regardless of limit', () => {
    expect(evaluateScorerTolerance(9, 1, 'deterministic', 0.9)).toMatchObject({
      exceeds: true,
      zeroSample: false,
    });
    expect(evaluateScorerTolerance(10, 0, 'deterministic', 0).exceeds).toBe(false);
  });

  it('llm: exceeds strictly above the limit (rate == limit passes)', () => {
    // 1/10 = 0.1; limit 0.1 → not exceeded (strict >).
    expect(evaluateScorerTolerance(9, 1, 'llm', 0.1).exceeds).toBe(false);
    // 2/10 = 0.2 > 0.1 → exceeded.
    expect(evaluateScorerTolerance(8, 2, 'llm', 0.1).exceeds).toBe(true);
  });

  it('llm: limit 0 means any failure exceeds; limit 1 tolerates all', () => {
    expect(evaluateScorerTolerance(9, 1, 'llm', 0).exceeds).toBe(true);
    expect(evaluateScorerTolerance(1, 9, 'llm', 1).exceeds).toBe(false);
  });

  it('zero-sample: never exceeds, flags zeroSample, rate 0', () => {
    expect(evaluateScorerTolerance(0, 0, 'deterministic', 0)).toEqual({
      attempted: 0,
      rate: 0,
      exceeds: false,
      zeroSample: true,
    });
    expect(evaluateScorerTolerance(0, 0, 'llm', 0.5).zeroSample).toBe(true);
  });

  it('computes rate over attempted (scored + failed), not total', () => {
    expect(evaluateScorerTolerance(6, 2, 'llm', 0.1).rate).toBeCloseTo(0.25, 5);
  });
});

describe('failure-rate trust signal — scored/failed counts', () => {
  it('counts valid scores as scored and throws/out-of-range as failed', async () => {
    // q=1 → valid, q=2 → valid, q=3 → throw, q=4 → out-of-range.
    const mixed = scorer({
      name: 'mixed',
      description: 'mixed',
      score: (_o, input) => {
        const q = (input as { q: number }).q;
        if (q === 3) throw new Error('boom');
        if (q === 4) return 1.5; // out of range → null + recorded duration
        return q === 1 ? 1 : 0.5;
      },
    });

    const result = await runEval(
      { workflow: 'w', dataset: ds(4), scorers: [mixed] },
      echo,
      mockRuntime,
    );

    const s = result.summary.scorers.mixed;
    expect(s.scored).toBe(2);
    expect(s.failed).toBe(2);
    // The mean covers only the 2 valid scores ((1 + 0.5) / 2 = 0.75).
    expect(s.mean).toBe(0.75);
  });

  it('excludes workflow-errored items from both buckets', async () => {
    const execute = async (input: any) => {
      if (input.q === 2) throw new Error('workflow crashed');
      return { output: String(input.q) };
    };
    const always1 = scorer({ name: 's', description: 's', score: () => 1 });

    const result = await runEval(
      { workflow: 'w', dataset: ds(3), scorers: [always1] },
      execute,
      mockRuntime,
    );

    expect(result.summary.failures).toBe(1); // the workflow error
    const s = result.summary.scorers.s;
    // q=2 errored before scoring → counted in neither scored nor failed.
    expect(s.scored).toBe(2);
    expect(s.failed).toBe(0);
  });

  it('puts cancelled-mid-scoring (AbortError) in neither bucket and records no error', async () => {
    // A scorer that rejects with an AbortError-named error mimics a call
    // cancelled mid-flight: scoreItem leaves the pre-seeded null with NO
    // duration, so the item is neither scored nor failed.
    const abortLike: Scorer = {
      name: 'judge',
      description: 'aborts on q=2',
      isLlm: true,
      score: async (_o: unknown, input: unknown) => {
        if ((input as { q: number }).q === 2) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        return 0.8;
      },
    } as Scorer;

    const result = await runEval(
      { workflow: 'w', dataset: ds(3), scorers: [abortLike] },
      echo,
      mockRuntime,
    );

    const s = result.summary.scorers.judge;
    expect(s.scored).toBe(2);
    expect(s.failed).toBe(0); // q=2 cancelled → neither bucket
    // No scorerError recorded for a cancellation.
    expect(result.items[1].scorerErrors).toBeUndefined();
  });

  it('always populates scored/failed even without failOnScorerErrorRate', async () => {
    const ok = scorer({ name: 'ok', description: 'ok', score: () => 1 });
    const result = await runEval(
      { workflow: 'w', dataset: ds(2), scorers: [ok] },
      echo,
      mockRuntime,
    );
    expect(result.summary.scorers.ok.scored).toBe(2);
    expect(result.summary.scorers.ok.failed).toBe(0);
    expect(result.summary.degraded).toBeUndefined();
  });
});

describe('failure-rate trust signal — degradation gate (opt-in)', () => {
  it('does NOT set degraded when the gate is unconfigured, even with failures', async () => {
    const flaky = flakyLlm('judge', (q) => q <= 5); // 5 of 10 fail
    const result = await runEval(
      { workflow: 'w', dataset: ds(10), scorers: [flaky] },
      echo,
      mockRuntime,
    );
    expect(result.summary.scorers.judge.failed).toBe(5);
    expect(result.summary.degraded).toBeUndefined();
  });

  it('flags an LLM scorer over the rate without throwing', async () => {
    const flaky = flakyLlm('judge', (q) => q <= 5); // 50% failure
    const result = await runEval(
      { workflow: 'w', dataset: ds(10), scorers: [flaky], failOnScorerErrorRate: 0.1 },
      echo,
      mockRuntime,
    );
    expect(result.summary.degraded).toHaveLength(1);
    const d = result.summary.degraded![0];
    expect(d.scorer).toBe('judge');
    expect(d.type).toBe('llm');
    expect(d.rate).toBeCloseTo(0.5, 5);
    expect(d.limit).toBe(0.1);
    expect(d.failed).toBe(5);
    expect(d.scored).toBe(5);
  });

  it('does NOT flag an LLM scorer at or under the rate', async () => {
    const flaky = flakyLlm('judge', (q) => q === 1); // 1 of 10 → 0.1
    const atLimit = await runEval(
      { workflow: 'w', dataset: ds(10), scorers: [flaky], failOnScorerErrorRate: 0.1 },
      echo,
      mockRuntime,
    );
    // rate (0.1) is NOT > limit (0.1) → not degraded.
    expect(atLimit.summary.degraded).toBeUndefined();
  });

  it('flags a deterministic scorer on ANY failure regardless of the configured rate', async () => {
    // Deterministic scorer throws on exactly 1 of 10 items; the configured
    // rate is generous (0.9) but deterministic scorers tolerate zero failures.
    const det = scorer({
      name: 'det',
      description: 'det',
      score: (_o, input) => {
        if ((input as { q: number }).q === 1) throw new Error('bug');
        return 1;
      },
    });
    const result = await runEval(
      { workflow: 'w', dataset: ds(10), scorers: [det], failOnScorerErrorRate: 0.9 },
      echo,
      mockRuntime,
    );
    expect(result.summary.degraded).toHaveLength(1);
    const d = result.summary.degraded![0];
    expect(d.type).toBe('deterministic');
    expect(d.limit).toBe(0);
    expect(d.failed).toBe(1);
  });

  it('ignores an out-of-range failOnScorerErrorRate with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const flaky = flakyLlm('judge', (q) => q <= 5);
      const result = await runEval(
        { workflow: 'w', dataset: ds(10), scorers: [flaky], failOnScorerErrorRate: 1.5 },
        echo,
        mockRuntime,
      );
      // Gate disabled → not degraded, but the run still completes and counts.
      expect(result.summary.degraded).toBeUndefined();
      expect(result.summary.scorers.judge.failed).toBe(5);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring invalid failOnScorerErrorRate'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('does not gate a scorer that never produced an attempt (0/0)', async () => {
    // All items error in the workflow → the scorer never runs → attempted=0,
    // so the rate gate has nothing to divide and skips it (no false degrade).
    const execute = async () => {
      throw new Error('always fails');
    };
    const ok = scorer({ name: 'ok', description: 'ok', score: () => 1 });
    const result = await runEval(
      { workflow: 'w', dataset: ds(3), scorers: [ok], failOnScorerErrorRate: 0 },
      execute,
      mockRuntime,
    );
    expect(result.summary.scorers.ok.scored).toBe(0);
    expect(result.summary.scorers.ok.failed).toBe(0);
    expect(result.summary.degraded).toBeUndefined();
  });
});
