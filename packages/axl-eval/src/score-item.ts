import type { AdmissionController, AxlRuntime } from '@axlsdk/axl';

import type { Scorer, ScorerContext } from './scorer.js';
import { normalizeScorerResult, extractScorerErrorCost } from './scorer.js';
import type { EvalItem, ScorerDetail, ScorerOutcome } from './types.js';
import { round, mapWithConcurrency } from './utils.js';
import { isAdmissionDenied, trackScope } from './accounting.js';

/**
 * Render a dataset input for an error message without ever throwing.
 *
 * `JSON.stringify` throws on a circular reference and on a `BigInt`, and this
 * runs on the path that reports a DIFFERENT failure — so a serialization throw
 * here would replace a useful "scorer returned 7" message with an unrelated
 * TypeError. Long inputs are truncated because this string lands in
 * `item.scorerErrors`, which is persisted per item.
 */
function describeInput(input: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(input) ?? String(input);
  } catch {
    rendered = '[unserializable input]';
  }
  return rendered.length > 200 ? `${rendered.slice(0, 200)}…` : rendered;
}

/** The subset of an `EvalItem` that `scoreItem` reads and mutates. */
type ScorableItem = Pick<
  EvalItem,
  'input' | 'output' | 'annotations' | 'scores' | 'scoreDetails' | 'scorerErrors' | 'scorerCost'
>;

/** Everything the scoring loop needs from its caller (`runEval` or `rescore`). */
export type ScoreItemContext = {
  /** Used to open one accounting scope per scorer, so judging spend is
   *  attributable to the judge that incurred it. */
  runtime: AxlRuntime;
  scorerContext: ScorerContext;
  scorerConcurrency: number;
  signal?: AbortSignal;
  /** The run's spend threshold, when one is configured. A closed controller
   *  stops PAID judges from starting; deterministic ones still run. */
  admission?: AdmissionController;
  /** Called when this loop is the first place a budget closure was observed. */
  onClosure?: (source: 'scorer' | 'operation') => void;
};

/**
 * Score one item's `output` with every scorer, running up to
 * `scorerConcurrency` of them at once. Mutates `item.scores`,
 * `item.scoreDetails` and `item.scorerErrors` in place.
 *
 * This is the single source of truth for the scoring inner loop, shared by
 * `runEval` and `rescore`.
 *
 * ## Measurement
 *
 * Each scorer runs in its own accounting scope with `purpose: 'judging'`, so
 * `ScorerDetail.accounting` is that judge's own spend and the enclosing item /
 * run scopes see it exactly once under `breakdown.judging`. A cost the scorer
 * RETURNS is not a measurement: it is used for `ScorerDetail.cost` only when
 * the runtime measured nothing at all, and never enters any total.
 *
 * ## Determinism (independent of scorer completion order)
 *  - `scores`/`scoreDetails` keys are pre-seeded in `scorers` order, so JSON key
 *    order is stable and a scorer skipped by cancellation is deterministically
 *    `null` rather than absent.
 *  - `scorerErrors` are collected name-keyed and flattened in `scorers` order.
 *
 * ## Stopping
 *  - Cancellation: a scorer not yet started when `signal` aborts is
 *    `'cancelled'`; an in-flight call rejecting with an `AbortError` is too —
 *    narrowed to the error identity so a genuine bug in a sibling scorer that
 *    throws while another triggered the abort is still reported.
 *  - Budget: a closed controller makes an LLM judge `'budget_skipped'` (never
 *    started, no score, and excluded from the mean — a skipped judge must not
 *    be read as having scored 0). Deterministic scorers still run, because
 *    free quality signal on already-paid-for output is worth keeping; one that
 *    turns out to spend hits a denied operation and is `'budget_interrupted'`.
 */
export async function scoreItem(
  item: ScorableItem,
  scorers: readonly Scorer<unknown, unknown, unknown>[],
  context: ScoreItemContext,
): Promise<void> {
  const scoreDetails = (item.scoreDetails ??= {});
  for (const s of scorers) {
    item.scores[s.name] = null;
    scoreDetails[s.name] = { score: null, outcome: 'cancelled' };
  }

  const { runtime, scorerContext, signal, admission } = context;
  const scorerErrorsByName: Record<string, string> = {};

  await mapWithConcurrency(scorers, context.scorerConcurrency, async (scorer) => {
    const record = (detail: ScorerDetail, outcome: ScorerOutcome): void => {
      scoreDetails[scorer.name] = { ...detail, outcome };
    };

    if (signal?.aborted) {
      record({ score: null }, 'cancelled');
      return;
    }

    // Scheduling-level admission (contracts §8.2). A paid judge that has not
    // started yet is refused outright rather than dispatched and denied, so it
    // costs nothing and reports no duration.
    if (admission?.closed && scorer.isLlm) {
      record({ score: null }, 'budget_skipped');
      return;
    }

    // Applicability gate: a `false` verdict skips the scorer entirely — no
    // provider call for an llmScorer — and counts as NEITHER scored nor failed.
    // A predicate that THROWS is a bug, not a skip: it falls through to the
    // catch below and is recorded as a scorer failure.
    const scorerStart = Date.now();
    let applicable = true;
    try {
      applicable = !scorer.applies || scorer.applies(item.output, item.input, item.annotations);
    } catch (err) {
      scorerErrorsByName[scorer.name] =
        `Scorer "${scorer.name}" threw: ${err instanceof Error ? err.message : String(err)}`;
      record({ score: null, duration: Date.now() - scorerStart }, 'failed');
      return;
    }
    if (!applicable) {
      record({ score: null, skipped: true }, 'skipped');
      return;
    }

    const outcome = await trackScope(
      runtime,
      async () => scorer.score(item.output, item.input, item.annotations, scorerContext),
      // The scorer stamp is merged OVER the enclosing item's correlation, so a
      // judge's records keep the case index and add the judge's name -- which is
      // what lets `scoreDetails[name].diagnostics` point at this judge's own
      // calls rather than at the whole item's.
      { purpose: 'judging', captureCorrelation: { scorer: scorer.name } },
    );
    const duration = Date.now() - scorerStart;
    const { accounting } = outcome;
    // A caller-returned cost is a compatibility view of last resort: it is used
    // only when nothing was measured for this scorer AND the runtime has no
    // measurement rail at all. It is never summed anywhere.
    const measured = accounting.operations.total > 0 || accounting.operations.denied > 0;
    // `accounting` rides along only when this scorer's scope actually observed
    // an operation. A deterministic judge would otherwise stamp an all-zero
    // record onto every item of every run for no information — the item's own
    // accounting already covers "nothing was measured here".
    const withCost = (detail: ScorerDetail, callerCost: number | undefined): ScorerDetail => ({
      ...detail,
      ...(measured ? { accounting, cost: accounting.knownCost } : {}),
      ...(!measured && !outcome.instrumented && callerCost != null ? { cost: callerCost } : {}),
    });

    if (outcome.status === 'rejected') {
      const err = outcome.error;
      // A cancelled call is not a scoring failure — leave the pre-seeded null
      // and record nothing against the scorer's reliability.
      if ((err as { name?: string })?.name === 'AbortError') {
        record(withCost({ score: null, duration }, undefined), 'cancelled');
        return;
      }
      // A denial is the run budget stopping this judge, not a judge defect. Its
      // spend up to the denial is kept, and so is the time it spent before
      // being refused: this judge DID run, so reporting no duration would make
      // it indistinguishable from one that never started.
      if (isAdmissionDenied(err)) {
        context.onClosure?.('operation');
        record(withCost({ score: null, duration }, undefined), 'budget_interrupted');
        return;
      }
      scorerErrorsByName[scorer.name] =
        `Scorer "${scorer.name}" threw: ${err instanceof Error ? err.message : String(err)}`;
      record(withCost({ score: null, duration }, extractScorerErrorCost(err)), 'failed');
      if (admission?.closed) context.onClosure?.('scorer');
      return;
    }

    // `trackScope` cannot throw, but everything AFTER it can: a scorer may
    // return an exotic object that `normalizeScorerResult` chokes on, and the
    // out-of-range message serializes `item.input`, which throws on a circular
    // or BigInt-bearing input. Unguarded, such a throw escapes the concurrency
    // pool, the item scope and the run scope, and `runEval` loses the ENTIRE
    // run over one bad item. One scorer's failure is one scorer's failure.
    try {
      const scorerResult = normalizeScorerResult(outcome.value);
      const callerCost =
        typeof scorerResult.cost === 'number' &&
        Number.isFinite(scorerResult.cost) &&
        scorerResult.cost >= 0
          ? scorerResult.cost
          : undefined;

      if (
        !Number.isFinite(scorerResult.score) ||
        scorerResult.score < 0 ||
        scorerResult.score > 1
      ) {
        scorerErrorsByName[scorer.name] =
          `Scorer "${scorer.name}" returned out-of-range score ${scorerResult.score} for input ${describeInput(item.input)}`;
        record(
          withCost({ score: null, metadata: scorerResult.metadata, duration }, callerCost),
          'failed',
        );
      } else {
        item.scores[scorer.name] = round(scorerResult.score);
        record(
          withCost(
            {
              score: round(scorerResult.score),
              metadata: scorerResult.metadata,
              duration,
            },
            callerCost,
          ),
          'scored',
        );
      }
    } catch (err) {
      scorerErrorsByName[scorer.name] =
        `Scorer "${scorer.name}" threw: ${err instanceof Error ? err.message : String(err)}`;
      record(withCost({ score: null, duration }, undefined), 'failed');
    }
    if (admission?.closed) context.onClosure?.('scorer');
  });

  const orderedErrors = scorers
    .map((s) => scorerErrorsByName[s.name])
    .filter((e): e is string => e != null);
  if (orderedErrors.length > 0) item.scorerErrors = orderedErrors;
}
