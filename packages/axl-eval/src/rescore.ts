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
  /** Whether the source run's records were actually carried into this artifact. */
  copied: boolean;
  /** Set when the copied source records did not all fit. */
  copyTruncated?: string;
  /**
   * What the SOURCE manifest said about the bytes copied in, when there was a
   * copy. Never the current runtime's policy — see {@link finishCapture}.
   */
  carriedRedaction?: 'applied' | 'none';
};

/**
 * Share of the run byte bound the copied half may consume.
 *
 * The copy and the judging land in ONE artifact under ONE `maxRunBytes`, so an
 * unbounded copy starves the half a rescore actually produces: a source at the
 * bound would leave the first judge record to trip the limit, and the user who
 * turned capture on specifically to debug a flaky judge would get zero judge
 * records and a reason blaming the run limit. Three quarters is a margin, not a
 * measurement — large enough that the provenance is rarely cut, small enough
 * that judging always has room.
 */
const COPY_SHARE_OF_RUN_BOUND = 0.75;

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Is this the runtime saying it cannot host capture at all?
 *
 * Duck-typed on the code, not on `instanceof`: `@axlsdk/axl` legitimately loads
 * twice in one process, and an error thrown by copy A is not an instance of
 * copy B's `AxlError`.
 */
function isDiagnosticsUnavailable(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'DIAGNOSTICS_UNAVAILABLE';
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
 * A runtime that cannot host capture at all is the ONE failure that throws,
 * and it throws here — before a single judge call — exactly as `runEval` does.
 * Asking for evidence and silently receiving none is worse than being told, and
 * the caller can still rescore without `captureRequests`.
 *
 * Every other failure degrades — a rescore's numbers must stay readable when its
 * diagnostics are not — and every degraded manifest publishes `artifactId: ''`,
 * NEVER the source's. Naming the source would let this result's lifecycle
 * (commit, expiry, delete) reach into another run's artifact.
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
  ): Omit<RescoreCapture, 'copied'> => ({
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
  // Tracked outside the `try` so the degrade path can release an artifact this
  // function staged a line before it threw. Everything after a stage — building
  // the channel, reading the runtime's redact policy — is a throw site, and a
  // staged artifact nobody rolls back holds its lease for `maxHoldMs`.
  let stagedId: string | undefined;
  try {
    if (!sourceId) {
      // Nothing to carry forward, but the judging is still worth recording —
      // it is the only work a rescore actually performs.
      const staged = await runtime.stageDiagnosticArtifact({ kind: 'eval', id: ownerId });
      stagedId = staged.artifactId;
      return { capture: { ...open(staged.artifactId, staged.sink, 0), copied: false } };
    }
    // Headroom for the judging half — see COPY_SHARE_OF_RUN_BOUND.
    const runBound = limits.maxRunBytes ?? DEFAULT_COPY_MAX_BYTES;
    const maxBytes = Math.max(1, Math.floor(runBound * COPY_SHARE_OF_RUN_BOUND));
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
    stagedId = copied.artifactId;
    const capture: RescoreCapture = {
      ...open(copied.artifactId, copied.sink, copied.bytes),
      copied: true,
      carriedRedaction: copied.redaction,
    };
    if (copied.truncated) {
      capture.copyTruncated =
        `the copied source records stopped at ${maxBytes} bytes, ` +
        `the share of the ${runBound} byte run limit reserved for them`;
    }
    return { capture };
  } catch (error) {
    if (stagedId !== undefined) {
      await runtime.rollbackDiagnosticArtifact(stagedId).catch(() => undefined);
    }
    if (isDiagnosticsUnavailable(error)) throw error;
    return {
      degraded: unavailableManifest(
        '',
        `the captured requests could not be carried forward: ${describeFailure(error)}`,
      ),
    };
  }
}

/**
 * Discard a staged artifact whose rescore is about to throw.
 *
 * Rollback stops the runtime's lease-renewal timer as well as removing the
 * bytes. Without it a rescore that throws mid-scoring pins its artifact
 * permanently: the sweeper only reclaims a lease that expired.
 */
async function abandonCapture(
  runtime: AxlRuntime,
  capture: RescoreCapture | undefined,
): Promise<void> {
  if (!capture) return;
  await capture.channel.close().catch(() => undefined);
  await runtime.rollbackDiagnosticArtifact(capture.artifactId).catch(() => undefined);
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
  // A complete channel over a partial copy is still a partial artifact — and a
  // truncated one over a partial copy was cut TWICE. Both reasons are kept:
  // "the copy filled it" and "the judging filled it" are different findings and
  // a reader given only the second cannot tell which half is missing.
  const reason = [capture.copyTruncated, status.reason].filter(Boolean).join('; ') || undefined;
  const truncated = capture.copyTruncated !== undefined || status.status === 'truncated';
  // Precedence, stated once: `unavailable` beats `truncated` beats `complete`.
  // A channel that went unavailable lost records the CAPTURE RAIL could not
  // write; a truncated one stopped at a bound the caller configured. Letting a
  // truncated copy overwrite an unavailable channel tells a reader their own
  // limit dropped the judge records when in fact the sink died — and the joined
  // reason, which still names the sink failure, would contradict the status
  // every Studio and CLI badge keys off (§12.3).
  const finalStatus =
    status.status === 'unavailable' ? 'unavailable' : truncated ? 'truncated' : status.status;
  // Redaction describes the BYTES, and this artifact may hold two kinds: the
  // channel's own records, scrubbed or not by this runtime's policy, and the
  // copied ones, scrubbed or not by whatever policy was in force when the
  // source was written. `applied` may only be claimed when BOTH halves are
  // scrubbed; anything else and a compliance reader exporting this artifact
  // gets raw prompts labelled as clean.
  const redaction =
    status.redaction === 'applied' && (capture.carriedRedaction ?? 'applied') === 'applied'
      ? 'applied'
      : 'none';
  try {
    const manifest = await runtime.finalizeDiagnosticArtifact(
      capture.artifactId,
      finalStatus,
      reason,
      redaction,
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

  // Opened BEFORE any scoring: the judge calls a rescore makes are the work it
  // actually performs, and capturing them afterwards would capture nothing.
  // A runtime that cannot host capture at all throws from here, before a single
  // judge call — the same contract as `runEval`, because asking for evidence
  // and silently receiving none is worse than being told.
  const { capture, degraded } = await beginCapture(result, rescoredId, runtime, options);
  // Whether the source's evidence is actually IN this rescore's artifact — not
  // whether the caller asked for it. An item ref into an artifact that was
  // swept, or into one holding only this rescore's judge calls, is a pointer a
  // reader cannot follow: Studio renders operations that cannot be fetched.
  const carryDiagnostics = capture?.copied === true;

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
      const accounting = emptyAccounting();
      rescored[itemIndex] = {
        input: original.input,
        annotations: original.annotations,
        output: original.output,
        error: original.error,
        ...(original.outcome ? { outcome: original.outcome } : {}),
        // The failure cause is a fact about the source run too.
        ...(original.failure ? { failure: original.failure } : {}),
        accounting,
        // Same rule as a scored item: an item carrying `accounting` always
        // carries both compat views, so no reader falls through to the legacy
        // "no accounting → trust the caller's number" branch and reports the
        // SOURCE run's spend as this rescore's. A passthrough did no work, so
        // both are a measured $0; the source's spend lives in the run-level
        // `accounting.source` provenance and nowhere else.
        cost: accounting.breakdown.generation,
        scorerCost: accounting.breakdown.judging,
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
      // to the run that made them. Only carried when the source records were
      // actually copied into this rescore's artifact — a dangling reference is
      // worse than none.
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
    // Both compat views are written whenever `accounting` is (contracts §6, Q8):
    // once an item carries accounting, `cost` is its MEASURED generation spend,
    // which for a rescore is a real, measured $0. Leaving it absent would let a
    // reader take the "no accounting → read the legacy caller value" branch and
    // report the source run's generation as spend this rescore incurred.
    item.cost = itemOutcome.accounting.breakdown.generation;
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
  if (runOutcome.status === 'rejected') {
    // The lease renewal is a timer the runtime holds until finalize or
    // rollback. Throwing without rolling back leaves it renewing forever, and
    // an artifact whose lease never expires can never be reclaimed.
    await abandonCapture(runtime, capture);
    throw runOutcome.error;
  }

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
    try {
      attachOperationRefs(rescored, capture.channel);
    } catch (error) {
      await abandonCapture(runtime, capture);
      throw error;
    }
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
      // A rescore makes no generation calls, so the source run's wall-clock
      // and provider latency are still the only measurements of these items.
      // `modelTiming` cannot be rebuilt from `item.timing` (sums, not per-call
      // samples): carry both forward.
      ...(result.summary.timing ? { timing: { ...result.summary.timing } } : {}),
      ...(result.summary.modelTiming
        ? { modelTiming: structuredClone(result.summary.modelTiming) }
        : {}),
    },
  };
}
