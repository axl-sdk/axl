import type { AxlRuntime } from '@axlsdk/axl';
import { AdmissionController } from '@axlsdk/axl';
import type { EvalAccounting, EvalItem, EvalResult, EvalSummary } from './types.js';
import type { Scorer, ScorerContext } from './scorer.js';
import { computeStats, mapWithConcurrency, scorerCounts } from './utils.js';
import { scoreItem } from './score-item.js';
import { buildCoverage } from './runner.js';
import { emptyAccounting, parseBudget, trackScope } from './accounting.js';
import { randomUUID } from 'node:crypto';

export type RescoreOptions = {
  /** Item-level worker-pool size (how many saved items rescore in parallel). Default 5. */
  concurrency?: number;
  /** Per-item scorer fan-out (how many scorers run concurrently within one item).
   *  Default 5 — matches `EvalConfig.scorerConcurrency`. Worst-case concurrent
   *  judge calls is `concurrency × scorerConcurrency`. */
  scorerConcurrency?: number;
  /** Abort signal forwarded into ScorerContext so in-flight LLM scorer calls can
   *  be cancelled mid-flight. Also checked between items to short-circuit
   *  remaining work. Mirrors `RunEvalOptions.signal`. */
  signal?: AbortSignal;
  /**
   * Known-spend threshold for the NEW judging work only, e.g. `'$0.10'`.
   *
   * The source run's spend is history: it is recorded under
   * `accounting.source.generation` and is NOT counted toward this limit, so a
   * rescore budget means "spend at most this much re-judging", which is the
   * only question a rescore can answer. Same validation and `>=` semantics as
   * `EvalConfig.budget`.
   */
  budget?: string;
};

/**
 * Re-run scorers on the saved outputs of an existing eval result.
 * Preserves original input/output/annotations. Only re-runs scoring.
 *
 * ## Accounting
 *
 * A rescore opens its OWN scope (`accounting.scope === 'rescore'`) covering
 * only the judging it performs. The original run's generation spend is never
 * added to the new total — a rescore that reported the sum would make a $0.20
 * re-judge of a $0.75 run look like $0.95 of new spend. Instead the source is
 * recorded verbatim under `accounting.source`, so a reader can add them up
 * deliberately, and `source.generation` is `null` when the source artifact
 * predates accounting (never synthesized from `totalCost`).
 */
export async function rescore(
  result: EvalResult,
  scorers: Scorer[],
  runtime: AxlRuntime,
  options?: RescoreOptions,
): Promise<EvalResult> {
  const startTime = Date.now();
  const concurrency = options?.concurrency ?? 5;
  const scorerConcurrency = options?.scorerConcurrency ?? 5;
  // Validated before any scoring work, exactly like `EvalConfig.budget`.
  const admission =
    options?.budget != null
      ? new AdmissionController({ limit: parseBudget(options.budget) })
      : undefined;

  let closedBy: 'case' | 'scorer' | 'operation' | undefined;
  const noteClosure = (source: 'case' | 'scorer' | 'operation'): void => {
    if (closedBy === undefined && admission?.closed) closedBy = source;
  };

  const scorerContext: ScorerContext = {
    resolveProvider: (uri: string) => {
      if (typeof runtime.resolveProvider !== 'function') {
        throw new Error(
          `LLM scorers require a runtime with resolveProvider(). ` +
            `Ensure you are using a real AxlRuntime instance, not a mock.`,
        );
      }
      return runtime.resolveProvider(uri);
    },
    signal: options?.signal,
  };

  const rescored: EvalItem[] = new Array(result.items.length);

  async function rescoreItem(original: EvalItem, itemIndex: number): Promise<void> {
    // Short-circuit if the rescore has been cancelled — matches runEval's
    // between-items signal check so cancellation behaves the same in both
    // paths. In-flight LLM scorer calls additionally abort via
    // scorerContext.signal → provider.chat({ signal }).
    if (options?.signal?.aborted) {
      rescored[itemIndex] = {
        input: original.input,
        annotations: original.annotations,
        output: original.output,
        error: 'cancelled',
        outcome: 'cancelled',
        accounting: emptyAccounting(),
        scores: {},
      };
      return;
    }

    // Pass through error items without scoring. The ORIGINAL outcome is kept:
    // whether the source case failed, was cancelled or was stopped by that
    // run's budget is a fact about that run, and a rescore does not re-litigate
    // it. Its accounting stays with the original run too.
    if (original.error) {
      rescored[itemIndex] = {
        input: original.input,
        annotations: original.annotations,
        output: original.output,
        error: original.error,
        ...(original.outcome ? { outcome: original.outcome } : {}),
        accounting: emptyAccounting(),
        scores: {},
      };
      return;
    }

    // Preserve per-item traces from the original run: rescore re-runs scorers
    // but leaves the workflow untouched, so the original execution traces
    // remain accurate and useful for diagnosing score changes.
    const item: EvalItem = {
      input: original.input,
      annotations: original.annotations,
      output: original.output,
      metadata: original.metadata,
      traces: original.traces,
      outcome: 'completed',
      scores: {},
      scoreDetails: {},
    };

    // Same shared scoring path as runEval — determinism, cancellation, budget
    // admission and per-judge accounting all live in scoreItem.
    const itemOutcome = await trackScope(
      runtime,
      async () => {
        await scoreItem(item, scorers, {
          runtime,
          scorerContext,
          scorerConcurrency,
          signal: options?.signal,
          admission,
          onClosure: noteClosure,
        });
      },
      { purpose: 'judging' },
    );
    if (itemOutcome.status === 'rejected') throw itemOutcome.error;

    item.accounting = itemOutcome.accounting;
    item.scorerCost = itemOutcome.accounting.breakdown.judging;
    if (itemOutcome.accounting.completeness !== 'complete') item.unpriced = true;
    rescored[itemIndex] = item;
  }

  const runOutcome = await trackScope(
    runtime,
    async () => {
      // rescoreItem writes into the pre-allocated `rescored` closure array (the
      // source of truth) and returns void — the pool's returned array is ignored.
      await mapWithConcurrency(result.items, concurrency, (item, i) => rescoreItem(item, i));
    },
    { purpose: 'judging', admission },
  );
  if (runOutcome.status === 'rejected') throw runOutcome.error;

  // `source.generation` means the GENERATION spend this scoring rests on, so a
  // rescore of a rescore must reach past its immediate source to the original
  // run. The intermediate's own accounting is judging-only; storing it under a
  // field named `generation` would tell a reader adding it to the new total
  // that they had recovered total spend, when they would have judging twice and
  // generation never. `runId` still points at the immediate source, which is
  // the artifact this one was actually derived from.
  const sourceAccounting = result.accounting;
  const generation =
    sourceAccounting?.scope === 'rescore'
      ? (sourceAccounting.source?.generation ?? null)
      : (sourceAccounting ?? null);

  const accounting: EvalAccounting = {
    ...runOutcome.accounting,
    scope: 'rescore',
    // `?? null` is load-bearing: a legacy source has no accounting and must read
    // as "unknown generation", never as a synthesized complete record.
    source: { runId: result.id, generation },
    ...(admission
      ? { budget: { ...admission.snapshot(), ...(closedBy ? { closedBy } : {}) } }
      : {}),
  };

  const failures = rescored.filter((i) => i.error).length;
  const scorerNames = scorers.map((s) => s.name);
  const scorerStats: EvalSummary['scorers'] = {};
  for (const name of scorerNames) {
    const scores = rescored
      .filter((i) => !i.error && i.scores[name] != null)
      .map((i) => i.scores[name] as number);
    // Same scored/failed surfacing as runEval (table + Studio parity). NOTE:
    // rescore deliberately does NOT support `failOnScorerErrorRate` — it takes
    // RescoreOptions, not EvalConfig, so there's no degradation gate here. The
    // counts are informational; gating belongs to the run that produced output.
    const { scored, failed, skipped } = scorerCounts(rescored, name);
    scorerStats[name] = { ...computeStats(scores), scored, failed, skipped };
  }

  const scorerTypes: Record<string, string> = {};
  for (const s of scorers) {
    scorerTypes[s.name] = s.isLlm ? 'llm' : 'deterministic';
  }

  return {
    id: randomUUID(),
    dataset: result.dataset,
    metadata: (() => {
      // Strip run group membership — rescored results are independent evaluations.
      // metadata.workflows is preserved via ...rest so the rescored result keeps
      // the same workflow attribution as the original.
      //
      // Also strip the scorer-filtered stamp: whether THIS rescore ran a subset
      // is a property of the rescore invocation, not the source run. A full
      // rescore of a `--scorers`-filtered run would otherwise inherit a stale
      // `scorerFiltered: true` + a `scorersRun` listing scorers it didn't even
      // use — falsely tripping the compare gate and the Studio banner.
      const rest: Record<string, unknown> = { ...result.metadata };
      delete rest.runGroupId;
      delete rest.runIndex;
      delete rest.scorerFiltered;
      delete rest.scorersRun;
      const merged: Record<string, unknown> = {
        ...rest,
        rescored: true,
        originalId: result.id,
        scorerTypes,
      };
      // Backward compatibility: pre-0.14 EvalResult artifacts had `workflow`
      // as a top-level string field with no `metadata.workflows`. Migrate it
      // forward so rescored results from old artifacts retain their workflow
      // attribution under the modern shape.
      if (!Array.isArray(merged.workflows)) {
        const legacyWorkflow = (result as { workflow?: unknown }).workflow;
        if (typeof legacyWorkflow === 'string' && legacyWorkflow) {
          merged.workflows = [legacyWorkflow];
          merged.workflowCounts = { [legacyWorkflow]: result.items.length };
        }
      }
      return merged;
    })(),
    timestamp: new Date().toISOString(),
    totalCost: accounting.knownCost,
    ...(accounting.completeness !== 'complete' ? { unpriced: true as const } : {}),
    accounting,
    duration: Date.now() - startTime,
    items: rescored,
    summary: {
      count: result.items.length,
      failures,
      coverage: buildCoverage(rescored, scorerNames),
      scorers: scorerStats,
    },
  };
}
