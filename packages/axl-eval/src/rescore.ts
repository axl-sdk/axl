import type { AxlRuntime, RequestCaptureSink } from '@axlsdk/axl';
import { AdmissionController, RequestCaptureChannel } from '@axlsdk/axl';
import type { EvalAccounting, EvalItem, EvalResult, EvalSummary } from './types.js';
import type { Scorer, ScorerContext } from './scorer.js';
import { computeStats, mapWithConcurrency, scorerCounts } from './utils.js';
import { scoreItem } from './score-item.js';
import { attachOperationRefs, buildCoverage } from './runner.js';
import { emptyAccounting, parseBudget, trackScope } from './accounting.js';
import {
  DEFAULT_COPY_MAX_BYTES,
  resolveCaptureLimits,
  toDiagnosticManifest,
  unavailableManifest,
  type CaptureRequestsOption,
} from './diagnostics.js';
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
  /**
   * Carry the source run's captured requests forward into this rescore, and
   * capture the judge calls this rescore makes.
   *
   * The source artifact is COPIED rather than referenced. Reference counting
   * would make deleting the original run either impossible or silently
   * destructive to every rescore of it; copying costs bytes once and makes each
   * result independently deletable. The copy preserves the ORIGINAL operation
   * ids as provenance, so a reader can still line a record up against the run
   * that produced it — even after that run is gone.
   *
   * Both halves land in ONE artifact and share ONE `maxRunBytes` budget: the
   * copied bytes count against it, so the artifact never grows to twice the
   * bound the caller asked for. A copy that would exceed it is partial and the
   * manifest says `truncated`; a source artifact that no longer exists, or a
   * copy that fails, yields `unavailable` with `artifactId: ''` — never the
   * source's id, which this result does not own. None of it prevents the
   * numeric rescore results from being read.
   */
  captureRequests?: CaptureRequestsOption;
};

/** A rescore's live capture: the artifact, and the channel judge calls flow into. */
type RescoreCapture = {
  artifactId: string;
  channel: RequestCaptureChannel;
  /** Set when the copied source records did not all fit. */
  copyTruncated?: string;
};

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open the rescore's capture: the source run's records copied in, and a channel
 * for the judge calls this rescore is about to make.
 *
 * Both halves live in ONE artifact deliberately. A rescore's evidence is the
 * pair — the requests that produced the outputs, and the requests that scored
 * them — and a result has exactly one `diagnostics.artifactId` to point at.
 *
 * "Provenance must survive deletion of the source" is the other requirement, so
 * the source is COPIED rather than referenced: deleting the original run leaves
 * this evidence intact, and the copied records keep the ORIGINAL operation ids
 * so a reader can still tell which run made each call. The manifest's
 * `copiedFrom` carries the other half of the link.
 *
 * Every failure degrades instead of throwing — a rescore's numbers must stay
 * readable when its diagnostics are not — and every degraded manifest publishes
 * `artifactId: ''`, NEVER the source's. Naming the source would let this
 * result's lifecycle (commit, expiry, delete) reach into another run's artifact.
 */
async function beginCapture(
  source: EvalResult,
  ownerId: string,
  runtime: AxlRuntime,
  options: RescoreOptions | undefined,
): Promise<{ capture?: RescoreCapture; degraded?: EvalResult['diagnostics'] }> {
  const limits = resolveCaptureLimits(options?.captureRequests);
  if (!limits) return {};

  const open = (
    artifactId: string,
    sink: RequestCaptureSink,
    carriedBytes: number,
  ): RescoreCapture => ({
    artifactId,
    channel: new RequestCaptureChannel({
      sink,
      ...limits,
      carriedBytes,
      // Redaction is the RUNTIME's policy, not the caller's: a rescore cannot
      // opt out of compliance mode by asking for diagnostics.
      redact: runtime.isRedactEnabled(),
    }),
  });

  const sourceId = source.diagnostics?.artifactId;
  try {
    if (!sourceId) {
      // Nothing to carry forward, but the judging is still worth recording —
      // it is the only work a rescore actually performs.
      const staged = await runtime.stageDiagnosticArtifact({ kind: 'eval', id: ownerId });
      return { capture: open(staged.artifactId, staged.sink, 0) };
    }
    const maxBytes = limits.maxRunBytes ?? DEFAULT_COPY_MAX_BYTES;
    const copied = await runtime.copyDiagnosticArtifact(
      sourceId,
      { kind: 'eval', id: ownerId },
      { maxBytes },
    );
    if (!copied) {
      return {
        degraded: unavailableManifest(
          '',
          "the source run's captured requests are no longer available",
        ),
      };
    }
    const capture = open(copied.artifactId, copied.sink, copied.bytes);
    if (copied.truncated) {
      capture.copyTruncated = `copy stopped at the ${maxBytes} byte limit`;
    }
    return { capture };
  } catch (error) {
    return {
      degraded: unavailableManifest(
        '',
        `the captured requests could not be carried forward: ${describeFailure(error)}`,
      ),
    };
  }
}

/**
 * Close the channel and seal the manifest.
 *
 * A finalize that fails degrades to `artifactId: ''` for the same reason the
 * copy paths do: an artifact that was never sealed is never committed, so
 * publishing its id points a reader at bytes the sweeper is about to reclaim.
 */
async function finishCapture(
  runtime: AxlRuntime,
  capture: RescoreCapture,
): Promise<EvalResult['diagnostics']> {
  const status = await capture.channel.close();
  // A complete channel over a partial copy is still a partial artifact.
  const truncatedByCopy = capture.copyTruncated !== undefined && status.status === 'complete';
  try {
    const manifest = await runtime.finalizeDiagnosticArtifact(
      capture.artifactId,
      truncatedByCopy ? 'truncated' : status.status,
      truncatedByCopy ? capture.copyTruncated : status.reason,
    );
    return toDiagnosticManifest(manifest);
  } catch {
    return unavailableManifest('', 'the diagnostic artifact could not be finalized');
  }
}

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
  const rescoredId = randomUUID();
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
  const carryDiagnostics = resolveCaptureLimits(options?.captureRequests) !== undefined;

  // Opened BEFORE any scoring: the judge calls a rescore makes are the work it
  // actually performs, and capturing them afterwards would capture nothing.
  // Staging can throw (capture asked for on a runtime that cannot host it), and
  // that surfaces before a single provider call, exactly as in `runEval`.
  const { capture, degraded } = await beginCapture(result, rescoredId, runtime, options);

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
      // Carried forward VERBATIM, original operation ids included. The rescore
      // did not re-run the workflow, so these still describe the calls that
      // produced this output; reminting the ids would break the only link back
      // to the run that made them. Only carried when the artifact behind them is
      // being copied — a dangling reference is worse than none.
      ...(carryDiagnostics && original.diagnostics ? { diagnostics: original.diagnostics } : {}),
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
      {
        purpose: 'judging',
        // Every record produced under this item is stamped with the case index,
        // which is how a `ScorerDetail` can point at its own judge calls.
        ...(capture ? { captureCorrelation: { caseIndex: itemIndex } } : {}),
      },
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
    // The channel is declared ONCE, at the run scope: its byte budget and
    // pending queue are per rescore, and every nested item/scorer scope inherits
    // it rather than opening a competing budget of its own.
    { purpose: 'judging', admission, ...(capture ? { capture: capture.channel } : {}) },
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

  // Closed AFTER the tracked function settled, so a slow sink can never have
  // delayed a provider call.
  let diagnostics = degraded;
  if (capture) {
    attachOperationRefs(rescored, capture.channel);
    diagnostics = await finishCapture(runtime, capture);
  }

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
    id: rescoredId,
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
    ...(diagnostics ? { diagnostics } : {}),
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
