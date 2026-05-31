import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { AxlRuntime, Provider } from '@axlsdk/axl';
import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';
import type { Scorer, ScorerContext } from '../scorer.js';
import { llmScorer } from '../llm-scorer.js';
import { runEval } from '../runner.js';
import { rescore } from '../rescore.js';
import { scoreItem } from '../score-item.js';
import { scorerCounts } from '../utils.js';
import type { EvalItem, EvalResult, ScorerDetail } from '../types.js';

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

/** A minimal ScorerContext whose resolveProvider returns the given mock. */
function mockContext(
  mockProvider: { chat: (...args: any[]) => Promise<{ content: string; cost?: number }> },
  signal?: AbortSignal,
): ScorerContext {
  return {
    resolveProvider: (uri: string) => ({
      provider: mockProvider as unknown as Provider,
      model: uri.includes(':') ? uri.split(':').slice(1).join(':') : uri,
    }),
    signal,
  };
}

/** A scorable item with the minimal shape scoreItem reads + mutates. */
function item(input: unknown, output: unknown, annotations?: unknown): EvalItem {
  return { input, output, annotations, scores: {} };
}

describe('scorerCounts — three-way bucketing (scored / failed / skipped)', () => {
  it('buckets a full mix exactly; precedence keeps skip and failure disjoint', () => {
    // Hand-build the items so the bucketing logic is tested in isolation from
    // scoreItem — pinning the discriminators scorerCounts reads.
    const items: {
      error?: string;
      scores: Record<string, number | null>;
      scoreDetails?: Record<string, ScorerDetail>;
    }[] = [
      // scored: non-null score wins regardless of anything else.
      { scores: { s: 0.9 }, scoreDetails: { s: { score: 0.9, duration: 3 } } },
      // failed (out-of-range / threw): null score WITH a duration.
      { scores: { s: null }, scoreDetails: { s: { score: null, duration: 4 } } },
      // failed: another ran-and-failed.
      { scores: { s: null }, scoreDetails: { s: { score: null, duration: 1 } } },
      // skipped: applies → false → positive marker, no duration.
      { scores: { s: null }, scoreDetails: { s: { score: null, skipped: true } } },
      // cancelled: null score, NO duration, NO skipped → neither bucket.
      { scores: { s: null }, scoreDetails: { s: { score: null } } },
      // cancelled (no scoreDetails entry at all) → neither bucket.
      { scores: { s: null } },
      // workflow-errored: excluded entirely even though it has a duration.
      { error: 'boom', scores: { s: null }, scoreDetails: { s: { score: null, duration: 9 } } },
    ];

    expect(scorerCounts(items, 's')).toEqual({ scored: 1, failed: 2, skipped: 1 });
  });

  it('skipped wins over duration when BOTH are present (never double-counted as failed)', () => {
    // Adversarial: a detail with skipped:true AND a duration. The precedence in
    // scorerCounts checks `skipped === true` BEFORE the duration heuristic, so
    // this lands in `skipped`, not `failed`. If the order ever flipped, this
    // would silently inflate the failure rate and degrade an honest scorer.
    const items = [
      { scores: { s: null }, scoreDetails: { s: { score: null, skipped: true, duration: 7 } } },
    ];
    expect(scorerCounts(items, 's')).toEqual({ scored: 0, failed: 0, skipped: 1 });
  });

  it('a skipped marker on a workflow-errored item is still excluded (error short-circuits first)', () => {
    const items = [
      { error: 'crash', scores: { s: null }, scoreDetails: { s: { score: null, skipped: true } } },
    ];
    expect(scorerCounts(items, 's')).toEqual({ scored: 0, failed: 0, skipped: 0 });
  });
});

describe('applies predicate gates execution', () => {
  it('false verdict short-circuits: score body never runs, marks skipped, no duration/error', async () => {
    const scoreSpy = vi.fn(() => 1);
    const s = scorer({
      name: 'gated',
      description: 'never applies',
      score: scoreSpy,
      applies: () => false,
    });

    const it0 = item({ q: 1 }, 'out');
    await scoreItem(it0, [s], 1, mockContext({ chat: async () => ({ content: '{}' }) }));

    expect(scoreSpy).not.toHaveBeenCalled();
    expect(it0.scores.gated).toBeNull();
    expect(it0.scoreDetails!.gated).toEqual({ score: null, skipped: true });
    // A skip leaves NO duration and records NO scorerErrors.
    expect(it0.scoreDetails!.gated.duration).toBeUndefined();
    expect(it0.scorerErrors).toBeUndefined();
  });

  it('predicate receives (output, input, annotations) in that order', async () => {
    const seen: unknown[] = [];
    const s = scorer({
      name: 'inspect',
      description: 'records args',
      score: () => 1,
      applies: (output, input, annotations) => {
        seen.push(output, input, annotations);
        return true;
      },
    });
    const it0 = item({ q: 5 }, 'the-output', { gold: 'g' });
    await scoreItem(it0, [s], 1, mockContext({ chat: async () => ({ content: '{}' }) }));
    expect(seen).toEqual(['the-output', { q: 5 }, { gold: 'g' }]);
    expect(it0.scores.inspect).toBe(1);
  });
});

describe('partial application across a dataset', () => {
  it('summary scored counts applied items, skipped counts the rest, failed 0, mean over applied only', async () => {
    // Applies only to odd q. Returns 1 for q=1, 0 for q=3 → mean 0.5 over the
    // two applied items; q=2,q=4 are skipped.
    const conditional = scorer({
      name: 'odd-only',
      description: 'scores odd q',
      score: (_o, input) => ((input as { q: number }).q === 1 ? 1 : 0),
      applies: (_o, input) => (input as { q: number }).q % 2 === 1,
    });

    const result = await runEval(
      { workflow: 'w', dataset: ds(4), scorers: [conditional] },
      echo,
      mockRuntime,
    );

    const s = result.summary.scorers['odd-only'];
    expect(s.scored).toBe(2); // q=1, q=3
    expect(s.skipped).toBe(2); // q=2, q=4
    expect(s.failed).toBe(0);
    expect(s.mean).toBe(0.5); // (1 + 0) / 2 — skipped items excluded
    // The skipped items carry the positive marker; applied ones don't.
    expect(result.items[1].scoreDetails!['odd-only']).toEqual({ score: null, skipped: true });
    expect(result.items[0].scoreDetails!['odd-only'].skipped).toBeUndefined();
  });

  it('can gate on annotations', async () => {
    const dsAnno = dataset({
      name: 'anno-ds',
      schema: z.object({ q: z.number() }),
      annotations: z.object({ kind: z.string() }),
      items: [
        { input: { q: 1 }, annotations: { kind: 'refusal' } },
        { input: { q: 2 }, annotations: { kind: 'normal' } },
        { input: { q: 3 }, annotations: { kind: 'refusal' } },
      ],
    });
    const refusalJudge = scorer({
      name: 'refusal',
      description: 'only refusal-expected items',
      score: () => 0.8,
      applies: (_o, _i, annotations) => (annotations as { kind: string }).kind === 'refusal',
    });

    const result = await runEval(
      { workflow: 'w', dataset: dsAnno, scorers: [refusalJudge] },
      echo,
      mockRuntime,
    );
    const s = result.summary.scorers.refusal;
    expect(s.scored).toBe(2);
    expect(s.skipped).toBe(1);
    expect(s.failed).toBe(0);
  });
});

describe('the regression this feature fixes: skips do not trip the failure-rate gate', () => {
  it('deterministic scorer with failOnScorerErrorRate:0 that SKIPS most items is NOT degraded', async () => {
    // The customer regression: a deterministic conditional scorer that only
    // applies to a subset. With the old NaN workaround it would degrade; with
    // applies-skips it stays clean.
    const conditional = scorer({
      name: 'subset',
      description: 'only q===1',
      score: () => 1,
      applies: (_o, input) => (input as { q: number }).q === 1,
    });
    const result = await runEval(
      { workflow: 'w', dataset: ds(10), scorers: [conditional], failOnScorerErrorRate: 0 },
      echo,
      mockRuntime,
    );
    expect(result.summary.scorers.subset.scored).toBe(1);
    expect(result.summary.scorers.subset.skipped).toBe(9);
    expect(result.summary.scorers.subset.failed).toBe(0);
    expect(result.summary.degraded).toBeUndefined();
  });

  it('CONTROL: the old NaN workaround DOES degrade (proving applies is the fix)', async () => {
    // Returning NaN for inapplicable items (the pre-feature hack) runs the
    // scorer and produces an out-of-range/non-finite score → recorded as a
    // failure with a duration → trips the deterministic zero-tolerance gate.
    const nanHack = scorer({
      name: 'subset',
      description: 'NaN for inapplicable',
      score: (_o, input) => ((input as { q: number }).q === 1 ? 1 : NaN),
    });
    const result = await runEval(
      { workflow: 'w', dataset: ds(10), scorers: [nanHack], failOnScorerErrorRate: 0 },
      echo,
      mockRuntime,
    );
    expect(result.summary.scorers.subset.scored).toBe(1);
    expect(result.summary.scorers.subset.failed).toBe(9); // all NaN runs counted as failures
    expect(result.summary.scorers.subset.skipped).toBe(0);
    expect(result.summary.degraded).toHaveLength(1);
    expect(result.summary.degraded![0].scorer).toBe('subset');
    expect(result.summary.degraded![0].type).toBe('deterministic');
  });
});

describe('fully skipped is zero-sample, not degraded', () => {
  it('applies always false: scored 0, failed 0, skipped all, mean 0, not degraded', async () => {
    const neverApplies = scorer({
      name: 'never',
      description: 'never runs',
      score: () => 1,
      applies: () => false,
    });
    const result = await runEval(
      { workflow: 'w', dataset: ds(5), scorers: [neverApplies], failOnScorerErrorRate: 0 },
      echo,
      mockRuntime,
    );
    const s = result.summary.scorers.never;
    expect(s.scored).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.skipped).toBe(5);
    // empty-sample convention: computeStats([]) → mean 0.
    expect(s.mean).toBe(0);
    // zero-sample scorer (attempted=0) is never degraded at the source.
    expect(result.summary.degraded).toBeUndefined();
  });
});

describe('throwing predicate fails loud (it is a bug, not a skip)', () => {
  it('applies that throws is counted as a failure (has duration), records a scorerError, not skipped', async () => {
    const buggy = scorer({
      name: 'buggy',
      description: 'predicate throws on q=2',
      score: () => 1,
      applies: (_o, input) => {
        if ((input as { q: number }).q === 2) throw new Error('predicate bug');
        return true;
      },
    });
    const result = await runEval(
      { workflow: 'w', dataset: ds(3), scorers: [buggy] },
      echo,
      mockRuntime,
    );
    const s = result.summary.scorers.buggy;
    expect(s.scored).toBe(2); // q=1, q=3
    expect(s.failed).toBe(1); // q=2 — predicate threw
    expect(s.skipped).toBe(0); // NOT a skip
    // The failed item carries a scorerError and a duration, not a skipped marker.
    const failedItem = result.items[1];
    expect(failedItem.scorerErrors).toBeDefined();
    expect(failedItem.scorerErrors![0]).toContain('buggy');
    expect(failedItem.scoreDetails!.buggy.skipped).toBeUndefined();
    expect(failedItem.scoreDetails!.buggy.duration).toBeDefined();
  });

  it('a throwing predicate on a deterministic scorer DOES degrade under failOnScorerErrorRate', async () => {
    const buggy = scorer({
      name: 'buggy',
      description: 'predicate throws on q=2',
      score: () => 1,
      applies: (_o, input) => {
        if ((input as { q: number }).q === 2) throw new Error('predicate bug');
        return true;
      },
    });
    const result = await runEval(
      { workflow: 'w', dataset: ds(3), scorers: [buggy], failOnScorerErrorRate: 0.9 },
      echo,
      mockRuntime,
    );
    // Deterministic zero-tolerance → a single thrown predicate degrades.
    expect(result.summary.degraded).toHaveLength(1);
    expect(result.summary.degraded![0].type).toBe('deterministic');
    expect(result.summary.degraded![0].failed).toBe(1);
  });
});

describe('llmScorer applies skips the provider call', () => {
  it('false verdict never calls the judge and keeps cost at 0', async () => {
    const chat = vi.fn(async () => ({
      content: JSON.stringify({ score: 0.9, reasoning: 'x' }),
      cost: 0.01,
    }));
    const judge = llmScorer({
      name: 'judge',
      description: 'conditional judge',
      model: 'test:model',
      system: 'Rate it',
      applies: () => false,
    });

    const it0 = item({ q: 1 }, 'out');
    const cost = await scoreItem(it0, [judge], 1, mockContext({ chat }));

    expect(chat).not.toHaveBeenCalled();
    expect(cost).toBe(0);
    expect(it0.scoreDetails!.judge).toEqual({ score: null, skipped: true });
    expect(it0.scorerCost).toBeUndefined();
  });

  it('true verdict runs the judge normally and bills its cost', async () => {
    const chat = vi.fn(async () => ({
      content: JSON.stringify({ score: 0.75, reasoning: 'ok' }),
      cost: 0.02,
    }));
    const judge = llmScorer({
      name: 'judge',
      description: 'conditional judge',
      model: 'test:model',
      system: 'Rate it',
      applies: () => true,
    });

    const it0 = item({ q: 1 }, 'out');
    const cost = await scoreItem(it0, [judge], 1, mockContext({ chat }));

    expect(chat).toHaveBeenCalledTimes(1);
    expect(cost).toBe(0.02);
    expect(it0.scores.judge).toBe(0.75);
    expect(it0.scoreDetails!.judge.skipped).toBeUndefined();
    expect(it0.scoreDetails!.judge.duration).toBeDefined();
  });

  it('llmScorer surfaces applies on the returned Scorer object', () => {
    const fn = () => true;
    const judge = llmScorer({
      name: 'j',
      description: 'd',
      model: 'test:model',
      system: 's',
      applies: fn,
    });
    expect(judge.applies).toBe(fn);
  });
});

describe('rescore parity', () => {
  function makeResult(): EvalResult {
    return {
      id: 'orig',
      dataset: 'test-ds',
      metadata: { workflows: ['w'] },
      timestamp: '2024-01-01T00:00:00.000Z',
      totalCost: 0,
      duration: 1,
      items: [
        { input: { q: 1 }, output: 'a', scores: {} },
        { input: { q: 2 }, output: 'b', scores: {} },
        { input: { q: 3 }, output: 'c', scores: {} },
      ],
      summary: { count: 3, failures: 0, scorers: {} },
    };
  }

  it('preserves skip semantics and surfaces skipped in the rescored summary', async () => {
    const conditional = scorer({
      name: 'odd',
      description: 'odd q only',
      score: () => 1,
      applies: (_o, input) => (input as { q: number }).q % 2 === 1,
    });
    const rescored = await rescore(makeResult(), [conditional], mockRuntime);

    const s = rescored.summary.scorers.odd;
    expect(s.scored).toBe(2); // q=1, q=3
    expect(s.skipped).toBe(1); // q=2
    expect(s.failed).toBe(0);
    expect(rescored.items[1].scoreDetails!.odd).toEqual({ score: null, skipped: true });
    expect(rescored.items[0].scores.odd).toBe(1);
  });
});

describe('mixed scorers on the same item', () => {
  it('unconditional scores while conditional skips; deterministic key order preserved', async () => {
    const always = scorer({ name: 'always', description: 'always', score: () => 0.6 });
    const conditional = scorer({
      name: 'conditional',
      description: 'skips q=2',
      score: () => 1,
      applies: (_o, input) => (input as { q: number }).q !== 2,
    });

    // Run scorer order: [conditional, always]. Pre-seed order must be honored
    // regardless of completion order, so JSON key order is deterministic.
    const it0 = item({ q: 2 }, 'out');
    await scoreItem(
      it0,
      [conditional, always],
      5,
      mockContext({ chat: async () => ({ content: '{}' }) }),
    );

    expect(it0.scores.always).toBe(0.6);
    expect(it0.scores.conditional).toBeNull();
    expect(it0.scoreDetails!.conditional.skipped).toBe(true);
    expect(it0.scoreDetails!.always.skipped).toBeUndefined();
    // Pre-seeded in scorers order → keys in that exact order.
    expect(Object.keys(it0.scores)).toEqual(['conditional', 'always']);
    expect(Object.keys(it0.scoreDetails!)).toEqual(['conditional', 'always']);
  });

  it('full dataset: unconditional summary unaffected by sibling skips', async () => {
    const always = scorer({ name: 'always', description: 'always', score: () => 1 });
    const conditional = scorer({
      name: 'conditional',
      description: 'q===1 only',
      score: () => 1,
      applies: (_o, input) => (input as { q: number }).q === 1,
    });
    const result = await runEval(
      { workflow: 'w', dataset: ds(3), scorers: [always, conditional] },
      echo,
      mockRuntime,
    );
    expect(result.summary.scorers.always.scored).toBe(3);
    expect(result.summary.scorers.always.skipped).toBe(0);
    expect(result.summary.scorers.conditional.scored).toBe(1);
    expect(result.summary.scorers.conditional.skipped).toBe(2);
  });
});

describe('abort vs skip remain distinguishable', () => {
  it('a cancelled scorer has no skipped marker and no duration; an applies-skip has skipped:true', async () => {
    // One scorer is cancelled mid-flight (AbortError); a sibling is applies-skipped.
    // They must land in different states so scorerCounts can tell them apart.
    const aborts: Scorer = {
      name: 'aborts',
      description: 'rejects with AbortError',
      isLlm: true,
      score: async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    } as Scorer;
    const skips = scorer({
      name: 'skips',
      description: 'never applies',
      score: () => 1,
      applies: () => false,
    });

    const it0 = item({ q: 1 }, 'out');
    await scoreItem(
      it0,
      [aborts, skips],
      5,
      mockContext({ chat: async () => ({ content: '{}' }) }),
    );

    // Cancelled: pre-seeded null, NO duration, NO skipped marker, NO error.
    expect(it0.scores.aborts).toBeNull();
    expect(it0.scoreDetails!.aborts).toEqual({ score: null });
    expect(it0.scoreDetails!.aborts.skipped).toBeUndefined();
    expect(it0.scoreDetails!.aborts.duration).toBeUndefined();
    expect(it0.scorerErrors).toBeUndefined();

    // Skipped: positive marker, no duration.
    expect(it0.scoreDetails!.skips).toEqual({ score: null, skipped: true });

    // scorerCounts distinguishes them: abort → neither bucket; skip → skipped.
    expect(scorerCounts([it0], 'aborts')).toEqual({ scored: 0, failed: 0, skipped: 0 });
    expect(scorerCounts([it0], 'skips')).toEqual({ scored: 0, failed: 0, skipped: 1 });
  });
});

describe('edge cases & documented behaviors', () => {
  it('applies returning a FALSY non-boolean skips (impl uses !predicate); documented behavior', async () => {
    // The impl is `!scorer.applies(...)`, so ANY falsy return (0, '', null,
    // undefined, NaN) skips. This pins that intentional coercion — a predicate
    // returning `undefined` (e.g. a forgotten `return`) is treated as "skip",
    // NOT "run". Cast through unknown since the public type is `=> boolean`.
    for (const falsy of [0, '', null, undefined, NaN]) {
      const s = scorer({
        name: 'falsy',
        description: 'returns falsy',
        score: () => 1,
        applies: (() => falsy) as unknown as () => boolean,
      });
      const it0 = item({ q: 1 }, 'out');
      await scoreItem(it0, [s], 1, mockContext({ chat: async () => ({ content: '{}' }) }));
      expect(it0.scoreDetails!.falsy).toEqual({ score: null, skipped: true });
    }
  });

  it('applies returning a TRUTHY non-boolean runs the scorer', async () => {
    for (const truthy of [1, 'yes', {}, []]) {
      const scoreSpy = vi.fn(() => 1);
      const s = scorer({
        name: 'truthy',
        description: 'returns truthy',
        score: scoreSpy,
        applies: (() => truthy) as unknown as () => boolean,
      });
      const it0 = item({ q: 1 }, 'out');
      await scoreItem(it0, [s], 1, mockContext({ chat: async () => ({ content: '{}' }) }));
      expect(scoreSpy).toHaveBeenCalledTimes(1);
      expect(it0.scores.truthy).toBe(1);
    }
  });

  it('a scorer without applies runs on every item (back-compat default)', async () => {
    const s = scorer({ name: 'plain', description: 'no applies', score: () => 1 });
    const result = await runEval(
      { workflow: 'w', dataset: ds(3), scorers: [s] },
      echo,
      mockRuntime,
    );
    expect(result.summary.scorers.plain.scored).toBe(3);
    expect(result.summary.scorers.plain.skipped).toBe(0);
  });

  it('skips are stable under high scorerConcurrency (no race in pre-seed/marker writes)', async () => {
    // Many scorers, every other one conditional, run with wide fan-out. The
    // pre-seed + per-task marker writes must not clobber each other.
    const scorers = Array.from({ length: 10 }, (_, i) =>
      scorer({
        name: `s${i}`,
        description: `s${i}`,
        score: () => 1,
        // even-indexed scorers skip; odd-indexed run.
        applies: i % 2 === 0 ? () => false : undefined,
      }),
    );
    const it0 = item({ q: 1 }, 'out');
    await scoreItem(it0, scorers, 10, mockContext({ chat: async () => ({ content: '{}' }) }));

    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) {
        expect(it0.scoreDetails![`s${i}`]).toEqual({ score: null, skipped: true });
        expect(it0.scores[`s${i}`]).toBeNull();
      } else {
        expect(it0.scores[`s${i}`]).toBe(1);
      }
    }
    // Key order is the scorers-array order regardless of completion order.
    expect(Object.keys(it0.scores)).toEqual(scorers.map((s) => s.name));
  });
});
