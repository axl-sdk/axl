import type { ArtifactManifest, AxlRuntime, CallTiming, ModelTimingRollup } from '@axlsdk/axl';
import { AdmissionController, AxlError, RequestCaptureChannel } from '@axlsdk/axl';
import type {
  EvalAccounting,
  EvalConfig,
  EvalCoverage,
  EvalItem,
  EvalItemOutcome,
  EvalResult,
  EvalSummary,
  ItemModelTiming,
  RunEvalOptions,
  ScorerOutcome,
} from './types.js';
import type { ScorerContext } from './scorer.js';
import type { DegradedScorer } from './types.js';
import {
  computeStats,
  mapWithConcurrency,
  scorerCounts,
  evaluateScorerTolerance,
  evaluateItemErrorRate,
  isErrorRateLimit,
  DEFAULT_ITEM_ERROR_RATE_LIMIT,
} from './utils.js';
import { scoreItem } from './score-item.js';
import { emptyAccounting, isAdmissionDenied, parseBudget, trackScope } from './accounting.js';
import {
  resolveCaptureLimits,
  toDiagnosticManifest,
  unavailableManifest,
  type OperationRef,
} from './diagnostics.js';
import { randomUUID } from 'node:crypto';

/**
 * Metadata keys the runtime MEASURES. A callback that returns one of these is
 * making a claim about work Axl already observed, so the claim is recorded
 * under `EvalItem.callerReport.metadata` instead of overwriting the
 * measurement. Every other caller key still merges into `item.metadata`.
 */
const RESERVED_METADATA_KEYS = [
  'models',
  'modelCallCounts',
  'workflows',
  'workflowCallCounts',
  'tokens',
  'agentCalls',
] as const;

const ITEM_OUTCOMES: EvalItemOutcome[] = [
  'completed',
  'failed',
  'cancelled',
  'budget_skipped',
  'budget_interrupted',
];

const SCORER_OUTCOMES: ScorerOutcome[] = [
  'scored',
  'failed',
  'skipped',
  'cancelled',
  'budget_skipped',
  'budget_interrupted',
];

/**
 * Extract a user-returned cost only if it's a non-negative finite number.
 * Guards against workflows that return `{ cost: 'free' }`, `{ cost: NaN }`,
 * `{ cost: -1 }`, `{ cost: Infinity }`, etc. — the TS type says `cost?: number`
 * but at runtime we can't trust that.
 *
 * This value is recorded on `EvalItem.callerReport.cost` for inspection and is
 * NEVER summed into a total: `item.cost` and `result.totalCost` come from the
 * accounting rail. An invalid value is dropped with one `console.warn` per item
 * so the type violation stays visible.
 */
function extractUserCost(result: unknown, label = 'executeWorkflow'): number | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const raw = (result as { cost?: unknown }).cost;
  if (raw === undefined) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;

  console.warn(
    `[axl-eval] Ignoring invalid \`cost\` from ${label} return: expected non-negative finite number, got ${typeof raw === 'number' ? String(raw) : typeof raw}. Measured spend is unaffected.`,
  );
  return undefined;
}

/**
 * Extract a user-returned metadata record only if it's a plain object.
 * Rejects arrays, null, scalars, and exotic object types (Date, Map, Set,
 * Error, class instances) that would satisfy a loose `typeof === 'object'`
 * check but break `Record<string, unknown>` assumptions in downstream
 * consumers (spread, Object.entries, property access).
 */
function extractUserMetadata(
  result: unknown,
  label = 'executeWorkflow',
): Record<string, unknown> | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const meta = (result as { metadata?: unknown }).metadata;
  if (meta === undefined) return undefined;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    console.warn(
      `[axl-eval] Ignoring invalid \`metadata\` from ${label} return: expected plain object, got ${meta === null ? 'null' : Array.isArray(meta) ? 'array' : typeof meta}.`,
    );
    return undefined;
  }
  // Reject exotic objects (Date, Map, Set, Error, class instances) whose
  // prototype chain differs from Object.prototype. Those pass `typeof ===
  // 'object'` but don't behave like `Record<string, unknown>`.
  const proto = Object.getPrototypeOf(meta);
  if (proto !== Object.prototype && proto !== null) {
    console.warn(
      `[axl-eval] Ignoring invalid \`metadata\` from ${label} return: expected plain object, got ${(proto?.constructor?.name as string | undefined) ?? 'exotic object'}.`,
    );
    return undefined;
  }
  return meta as Record<string, unknown>;
}

/** Split caller metadata into the measured keys it may not overwrite and the rest. */
function splitCallerMetadata(user: Record<string, unknown> | undefined): {
  reserved?: Record<string, unknown>;
  safe?: Record<string, unknown>;
} {
  if (!user) return {};
  let reserved: Record<string, unknown> | undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(user)) {
    if ((RESERVED_METADATA_KEYS as readonly string[]).includes(key)) {
      (reserved ??= {})[key] = value;
    } else {
      safe[key] = value;
    }
  }
  return { reserved, ...(Object.keys(safe).length > 0 ? { safe } : {}) };
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | undefined)?.name === 'AbortError';
}

/** A staged capture: the channel records go into, and the artifact holding them. */
type StagedCapture = { channel: RequestCaptureChannel; artifactId: string };

/**
 * Reserve the run's diagnostic artifact and open a bounded channel into it.
 *
 * Returns `undefined` when capture is off — the overwhelmingly common case,
 * which must add no artifact, no config requirement, and no field to the
 * result. When capture IS on and the runtime cannot host it, this throws
 * before any work, which is the whole reason it is called this early.
 */
async function stageCapture(
  runtime: AxlRuntime,
  ownerId: string,
  option: RunEvalOptions['captureRequests'],
): Promise<StagedCapture | undefined> {
  const limits = resolveCaptureLimits(option);
  if (!limits) return undefined;
  const staged = await runtime.stageDiagnosticArtifact({ kind: 'eval', id: ownerId });
  return {
    artifactId: staged.artifactId,
    channel: new RequestCaptureChannel({
      sink: staged.sink,
      ...limits,
      // Redaction is the RUNTIME's policy, not the caller's: a run cannot opt
      // out of compliance mode by asking for diagnostics.
      redact: runtime.isRedactEnabled(),
    }),
  };
}

/**
 * Close the channel, seal the manifest, and hand back what the result should
 * say about its own capture.
 *
 * Every failure path here degrades to an `unavailable` manifest rather than
 * throwing: a diagnostics problem must not destroy a run's measured results.
 */
async function finishCapture(
  runtime: AxlRuntime,
  capture: StagedCapture,
): Promise<ArtifactManifest | undefined> {
  const status = await capture.channel.close();
  try {
    return await runtime.finalizeDiagnosticArtifact(
      capture.artifactId,
      status.status,
      status.reason,
      // What the channel ACTUALLY applied. The store sees only scrubbed bytes
      // and cannot tell, so a manifest without this reports every compliance-
      // mode artifact as unredacted.
      status.redaction,
    );
  } catch {
    return undefined;
  }
}

/**
 * Discard a staged artifact whose run is about to throw.
 *
 * The lease renewal is a timer the RUNTIME holds, cleared only by finalize,
 * rollback, delete or shutdown. A run that throws between staging and
 * finalizing therefore leaves that timer renewing the lease forever, and an
 * artifact whose lease never expires can never be reclaimed by the sweeper —
 * a permanent directory per failed run, with no self-healing path. Rolling back
 * is what closes it: the bytes go, and so does the timer.
 *
 * Rollback rather than `finalize('interrupted')` because nothing will ever be
 * able to read these bytes: the run threw, so no history row will name them,
 * and only a committed artifact is readable.
 */
async function abandonCapture(
  runtime: AxlRuntime,
  capture: StagedCapture | undefined,
): Promise<void> {
  if (!capture) return;
  // Close first so nothing is still writing into an artifact being removed.
  await capture.channel.close().catch(() => undefined);
  await runtime.rollbackDiagnosticArtifact(capture.artifactId).catch(() => undefined);
}

/**
 * Attach operation references to the items and judges that produced them.
 *
 * References only. Putting the records themselves on the result is exactly the
 * "compact artifacts silently grow" regression this feature exists to avoid --
 * the content lives in the artifact and is fetched deliberately.
 *
 * Grouping nests by case index THEN scorer name rather than using a joined
 * string key: a scorer name may contain any separator, and a mis-split would
 * silently attribute one judge's requests to another.
 */
export function attachOperationRefs(
  items: readonly EvalItem[],
  channel: RequestCaptureChannel,
): void {
  const byItem = new Map<number, OperationRef[]>();
  const byScorer = new Map<number, Map<string, OperationRef[]>>();
  for (const entry of channel.operations()) {
    // An operation with no case index belongs to no item: a provider call made
    // outside the runner's per-item scopes. It stays in the artifact; the
    // result simply does not point at it.
    if (entry.caseIndex === undefined) continue;
    const ref: OperationRef = {
      operationId: entry.operationId,
      kind: entry.kind,
      ...(entry.turn !== undefined ? { turn: entry.turn } : {}),
      ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
      status: entry.status,
    };
    if (entry.scorer !== undefined) {
      const forItem = byScorer.get(entry.caseIndex) ?? new Map<string, OperationRef[]>();
      const list = forItem.get(entry.scorer) ?? [];
      list.push(ref);
      forItem.set(entry.scorer, list);
      byScorer.set(entry.caseIndex, forItem);
    } else {
      const list = byItem.get(entry.caseIndex) ?? [];
      list.push(ref);
      byItem.set(entry.caseIndex, list);
    }
  }
  for (const [caseIndex, operations] of byItem) {
    const item = items[caseIndex];
    if (!item) continue;
    // Merge, never replace: a rescored item already carries the ORIGINAL run's
    // generation refs, and overwriting them would silently erase the evidence
    // this rescore deliberately copied forward the moment any provider call is
    // made inside an item scope but outside a per-scorer one.
    item.diagnostics = { operations: [...(item.diagnostics?.operations ?? []), ...operations] };
  }
  for (const [caseIndex, forItem] of byScorer) {
    for (const [scorer, operations] of forItem) {
      const detail = items[caseIndex]?.scoreDetails?.[scorer];
      if (detail) detail.diagnostics = { operations };
    }
  }
}

export async function runEval(
  config: EvalConfig,
  executeWorkflow: (
    input: unknown,
    runtime: AxlRuntime,
  ) => Promise<{ output: unknown; cost?: number; metadata?: Record<string, unknown> }>,
  runtime: AxlRuntime,
  options?: RunEvalOptions,
): Promise<EvalResult> {
  const startTime = Date.now();
  const id = randomUUID();

  // The item gate is default-on, so an unusable limit must fail loudly and
  // before any work: warn-and-skip (the scorer gate's policy) would silently
  // switch the gate off for the whole run.
  const itemErrorRateLimit = config.failOnItemErrorRate ?? DEFAULT_ITEM_ERROR_RATE_LIMIT;
  if (!isErrorRateLimit(itemErrorRateLimit)) {
    throw new AxlError(
      'INVALID_ITEM_ERROR_RATE',
      `Invalid failOnItemErrorRate (${String(itemErrorRateLimit)}): expected a number in [0, 1]; 1 disables the gate.`,
    );
  }

  // Budget FIRST (contracts §11 Q5): a malformed limit must not cost a dataset
  // load, let alone a provider call. `AdmissionController` re-validates the
  // parsed number, so `INVALID_BUDGET` is raised from exactly one place.
  const admission =
    config.budget != null
      ? new AdmissionController({ limit: parseBudget(config.budget) })
      : undefined;

  // Capture SECOND, for the same reason: staging throws
  // `DIAGNOSTICS_UNAVAILABLE` when the runtime has no artifact store, and the
  // only useful time to learn that is before any money is spent. The artifact
  // is owned by THIS run's id, which is also the eval history id the caller
  // will save it under.
  const capture = await stageCapture(runtime, id, options?.captureRequests);

  let items: Awaited<ReturnType<EvalConfig['dataset']['getItems']>>;
  try {
    items = await config.dataset.getItems();
  } catch (error) {
    // A dataset that reads a missing file, fails a schema parse, or fetches over
    // the network throws here routinely — and the artifact was staged one line
    // ago.
    await abandonCapture(runtime, capture);
    throw error;
  }
  // Snapshot dataset-load diagnostics (e.g. annotation keys the schema dropped)
  // so we can surface them on EvalResult.metadata for any consumer — mirrors the
  // console.warn the dataset already emits. Read synchronously after getItems()
  // (no await between); defensive against hand-rolled Dataset objects that don't
  // expose the field.
  const droppedAnnotationKeys = [...(config.dataset.droppedAnnotationKeys ?? [])];
  const concurrency = config.concurrency ?? 5;
  // Per-item scorer fan-out. Defaults to the same value as item `concurrency`
  // (parallel-by-default), so the worst-case concurrent judge calls is
  // `concurrency × scorerConcurrency`. The provider layer backs off on
  // 429/503/529; users who need a tighter ceiling lower item `concurrency`.
  const scorerConcurrency = config.scorerConcurrency ?? 5;

  // Which scheduling decision FIRST observed the budget closing. Set once and
  // never overwritten, so the artifact says what actually stopped the run
  // rather than the last thing to notice.
  let closedBy: 'case' | 'scorer' | 'operation' | undefined;
  const noteClosure = (source: 'case' | 'scorer' | 'operation'): void => {
    if (closedBy === undefined && admission?.closed) closedBy = source;
  };

  // Create a scorer context that LLM scorers use to resolve providers.
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

  const evalItems: EvalItem[] = new Array(items.length);
  /** Caller claims seen this run — inspection only, never summed. */
  const callerReported = { costItems: 0, costTotal: 0, metadataItems: 0 };

  // Run-level per-call latency samples, keyed by effective model URI. Filled
  // synchronously from each item's tracked result and never persisted:
  // `summary.modelTiming` needs real per-call values to produce a real
  // distribution, while `item.timing` keeps only the compact sums. Items run
  // concurrently, but each append is a synchronous push, so no interleaving is
  // possible; sample ORDER across items is arbitrary and irrelevant to stats.
  const runCallSamples = new Map<string, CallTiming[]>();
  /**
   * Split a timing rollup into the compact per-item sums that get persisted and
   * the raw per-call blocks that feed `summary.modelTiming`.
   */
  function absorbTiming(rollup: ModelTimingRollup | undefined, evalItem: EvalItem): void {
    if (!rollup) return;
    const perItem: Record<string, ItemModelTiming> = {};
    for (const [model, bucket] of Object.entries(rollup)) {
      // Explicit field copy, not a rest spread: a rest spread would carry any
      // future core-side field straight into every persisted eval artifact.
      const sums: ItemModelTiming = {
        calls: bucket.calls,
        queuedMs: bucket.queuedMs,
        retryMs: bucket.retryMs,
        wireMs: bucket.wireMs,
        ...(bucket.firstTokenMs !== undefined && bucket.firstTokenCalls !== undefined
          ? { firstTokenMs: bucket.firstTokenMs, firstTokenCalls: bucket.firstTokenCalls }
          : {}),
      };
      perItem[model] = sums;
      // `samples` is opt-in on the core side and the call site below requests
      // it, so it is never actually absent here — but it is typed optional and
      // is treated that way rather than asserted, so a future caller that omits
      // the flag degrades to "no distribution" instead of throwing.
      const samples = bucket.samples;
      if (!samples) continue;
      // Appended one at a time rather than by spread: a long-running item can
      // hold thousands of calls, and `push(...arr)` passes them as arguments.
      const pooled = runCallSamples.get(model) ?? [];
      for (const sample of samples) pooled.push(sample);
      runCallSamples.set(model, pooled);
    }
    evalItem.timing = perItem;
  }

  /** A case that never started: readable identity, no operations, no spend. */
  function stub(item: (typeof items)[0], outcome: EvalItemOutcome, error: string): EvalItem {
    return {
      input: item.input,
      annotations: item.annotations,
      output: null,
      error,
      outcome,
      accounting: emptyAccounting(),
      cost: 0,
      scorerCost: 0,
      scores: {},
    };
  }

  async function processItem(item: (typeof items)[0], itemIndex: number): Promise<void> {
    if (options?.signal?.aborted) {
      evalItems[itemIndex] = stub(item, 'cancelled', 'Cancelled');
      options?.onProgress?.({ type: 'item_done', itemIndex, totalItems: items.length });
      return;
    }

    // Case-level admission (contracts §8.1). A case that has not started is not
    // admitted at all — it costs nothing and keeps its dataset input so index
    // alignment for compare/rescore survives.
    if (admission?.closed) {
      noteClosure('case');
      evalItems[itemIndex] = stub(item, 'budget_skipped', 'Budget exceeded');
      options?.onProgress?.({ type: 'item_done', itemIndex, totalItems: items.length });
      return;
    }

    const evalItem: EvalItem = {
      input: item.input,
      annotations: item.annotations,
      output: null,
      scores: {},
    };
    const itemStart = Date.now();

    // One scope per item wrapping BOTH generation and judging, so
    // `item.accounting` is the item's whole cost and its `breakdown` splits the
    // two. The nested scopes below give each half (and each judge) its own
    // purpose; an operation settled in a child is counted exactly once here.
    const itemOutcome = await trackScope(
      runtime,
      async () => {
        const generation = await trackScope(
          runtime,
          async () => executeWorkflow(item.input, runtime),
          {
            purpose: 'generation',
            captureTraces: options?.captureTraces === true,
            captureTimingSamples: true,
          },
        );

        evalItem.duration = Date.now() - itemStart;
        absorbTiming(generation.modelTiming, evalItem);
        // Traces are most valuable on the failure path, and `trackOutcome`
        // returns them for a rejected scope too — no side channel needed.
        if (generation.traces && generation.traces.length > 0) {
          evalItem.traces = generation.traces;
        }

        if (generation.status === 'rejected') {
          const err = generation.error;
          if (isAdmissionDenied(err)) {
            // The run budget stopped this case mid-flight. Its spend so far is
            // kept — discarding it is exactly how a budget stops being honest.
            noteClosure('operation');
            evalItem.outcome = 'budget_interrupted';
            evalItem.error = 'Budget interrupted';
          } else if (isAbortError(err)) {
            evalItem.outcome = 'cancelled';
            evalItem.error = 'Cancelled';
          } else {
            // Everything else is the workflow's own failure, INCLUDING a nested
            // `ctx.budget` block: that is user logic, not a run-budget stop.
            evalItem.outcome = 'failed';
            evalItem.error = err instanceof Error ? err.message : String(err);
            if (admission?.closed) noteClosure('case');
          }
          return;
        }

        const result = generation.value;
        evalItem.outcome = 'completed';
        evalItem.output = result.output;

        // Caller claims are recorded, never substituted for measurement.
        const callerCost = extractUserCost(result);
        if (callerCost !== undefined) {
          (evalItem.callerReport ??= {}).cost = callerCost;
          callerReported.costItems += 1;
          callerReported.costTotal += callerCost;
        }
        const { reserved, safe } = splitCallerMetadata(extractUserMetadata(result));
        if (reserved) {
          (evalItem.callerReport ??= {}).metadata = reserved;
          callerReported.metadataItems += 1;
        }
        if (generation.metadata || safe) {
          evalItem.metadata = { ...generation.metadata, ...safe };
        }

        // Attribute a crossing caused by this case's own spend before its
        // judges run, so `closedBy` names the case rather than the first judge
        // that happened to notice.
        if (admission?.closed) noteClosure('case');

        await scoreItem(evalItem, config.scorers, {
          runtime,
          scorerContext,
          scorerConcurrency,
          signal: options?.signal,
          admission,
          onClosure: noteClosure,
        });
      },
      {
        purpose: 'generation',
        // Every record produced anywhere under this item — workflow turns,
        // nested asks, tool continuations, judges — is stamped with the case
        // index, which is how the result can point an item at its own requests.
        ...(capture ? { captureCorrelation: { caseIndex: itemIndex } } : {}),
      },
    );

    if (itemOutcome.status === 'rejected') throw itemOutcome.error;

    evalItem.accounting = itemOutcome.accounting;
    evalItem.cost = itemOutcome.accounting.breakdown.generation;
    evalItem.scorerCost = itemOutcome.accounting.breakdown.judging;
    if (itemOutcome.accounting.completeness !== 'complete') evalItem.unpriced = true;

    evalItems[itemIndex] = evalItem;
    options?.onProgress?.({ type: 'item_done', itemIndex, totalItems: items.length });
  }

  // One run scope owns the budget controller, so every operation anywhere
  // inside — generation, judges, tools, memory — checks the same threshold and
  // settles into the same total.
  const runOutcome = await trackScope(
    runtime,
    async () => {
      // processItem writes into the pre-allocated `evalItems` closure array (the
      // source of truth) and returns void — the pool's returned array is ignored.
      await mapWithConcurrency(items, concurrency, (item, i) => processItem(item, i));
    },
    // The capture channel is declared ONCE, at the run scope: its byte budget
    // and pending queue are per RUN, and every nested item/scorer scope
    // inherits it rather than opening a competing budget of its own.
    { admission, ...(capture ? { capture: capture.channel } : {}) },
  );
  if (runOutcome.status === 'rejected') {
    await abandonCapture(runtime, capture);
    throw runOutcome.error;
  }

  // Capture is closed AFTER the tracked function has already settled, so a slow
  // or hung sink can never have delayed a provider call — and the channel's own
  // bounds mean `close()` cannot wait indefinitely either.
  let diagnostics: EvalResult['diagnostics'];
  if (capture) {
    try {
      attachOperationRefs(evalItems, capture.channel);
    } catch (error) {
      await abandonCapture(runtime, capture);
      throw error;
    }
    const manifest = await finishCapture(runtime, capture);
    diagnostics = manifest
      ? toDiagnosticManifest(manifest)
      : // An artifact that was never sealed is never committed, so publishing
        // its id would point a reader at bytes the sweeper is about to reclaim.
        unavailableManifest('', 'the diagnostic artifact could not be finalized');
  }

  const accounting: EvalAccounting = {
    ...runOutcome.accounting,
    scope: 'run',
    ...(admission
      ? {
          budget: {
            ...admission.snapshot(),
            ...(closedBy ? { closedBy } : {}),
          },
        }
      : {}),
    ...(callerReported.costItems > 0 || callerReported.metadataItems > 0 ? { callerReported } : {}),
  };

  // Legacy meaning, deliberately unchanged: items carrying an `error`. That
  // includes budget stops and cancellations, which is why `summary.coverage`
  // exists — read it to separate a model failure from a truncated run.
  const failures = evalItems.filter((i) => i.error).length;
  const scorerNames = config.scorers.map((s) => s.name);
  const scorerStats: EvalSummary['scorers'] = {};
  for (const name of scorerNames) {
    const scores = evalItems
      .filter((i) => !i.error && i.scores[name] != null)
      .map((i) => i.scores[name] as number);
    const { scored, failed, skipped } = scorerCounts(evalItems, name);
    scorerStats[name] = { ...computeStats(scores), scored, failed, skipped };
  }

  const coverage = buildCoverage(evalItems, scorerNames);

  const scorerTypes: Record<string, string> = {};
  for (const s of config.scorers) {
    scorerTypes[s.name] = s.isLlm ? 'llm' : 'deterministic';
  }

  // Failure-rate trust signal (opt-in). When `failOnScorerErrorRate` is set, a
  // scorer is degraded when it's deterministic and failed at all (a failure is
  // a bug, not noise), OR it's an LLM judge whose failure rate over its
  // ATTEMPTED items exceeds tolerance. Budget-skipped judges never attempted
  // anything, so they are in neither side of the ratio. We never throw — the
  // result is still useful; we flag it and let the CLI/consumer decide the exit
  // code. Invalid limits are ignored loudly so a typo can't silently disable
  // the gate.
  let degraded: DegradedScorer[] | undefined;
  const rawLimit = config.failOnScorerErrorRate;
  if (rawLimit != null) {
    if (!Number.isFinite(rawLimit) || rawLimit < 0 || rawLimit > 1) {
      console.warn(
        `[axl-eval] Ignoring invalid failOnScorerErrorRate (${rawLimit}); expected a number in [0, 1].`,
      );
    } else {
      for (const name of scorerNames) {
        const stats = scorerStats[name];
        const scored = stats.scored ?? 0;
        const failed = stats.failed ?? 0;
        const type = scorerTypes[name] === 'llm' ? 'llm' : 'deterministic';
        const limit = type === 'deterministic' ? 0 : rawLimit;
        const verdict = evaluateScorerTolerance(scored, failed, type, limit);
        // A scorer that never ran (zeroSample) isn't degraded at the source — the
        // run produced no basis to judge it. (The compare gate treats zero-sample
        // differently: it refuses to certify it.)
        if (verdict.exceeds) {
          (degraded ??= []).push({ scorer: name, rate: verdict.rate, limit, type, scored, failed });
        }
      }
    }
  }

  // Item coverage gate (default-on). Recorded only when something failed, so a
  // clean run's summary and artifact are byte-identical to before the gate.
  const itemErrorRate = evaluateItemErrorRate(coverage.items, items.length, itemErrorRateLimit);

  const durations = evalItems.filter((i) => !i.error && i.duration != null).map((i) => i.duration!);
  const timing = durations.length > 0 ? computeStats(durations) : undefined;

  // Per-model provider latency: one distribution per field, every sample a real
  // provider call. A ten-call item contributes ten samples, so `wireMs.mean` is
  // the exact call-weighted mean and `wireMs.p95` is a genuine call percentile.
  //
  // This is why the raw `CallTiming` blocks are pooled during the run instead of
  // being re-derived from `item.timing`: per-item sums can yield a mean, but no
  // percentile that describes calls rather than items.
  //
  // `firstTokenMs` runs over the streaming calls only — a non-streaming call is
  // excluded from the sample rather than entered as `0`, which would report a
  // first-token latency no call achieved.
  const modelTiming = buildModelTiming(runCallSamples);

  // Aggregate per-model LLM call counts across all items
  const totalModelCalls = new Map<string, number>();
  for (const item of evalItems) {
    const itemCounts = item.metadata?.modelCallCounts;
    if (itemCounts && typeof itemCounts === 'object') {
      for (const [m, count] of Object.entries(itemCounts as Record<string, unknown>)) {
        if (typeof count === 'number')
          totalModelCalls.set(m, (totalModelCalls.get(m) ?? 0) + count);
      }
    } else {
      // Fallback: count unique models per item (for executeWorkflow that doesn't provide call counts)
      const itemModels = item.metadata?.models;
      if (Array.isArray(itemModels)) {
        for (const m of itemModels) {
          if (typeof m === 'string') totalModelCalls.set(m, (totalModelCalls.get(m) ?? 0) + 1);
        }
      }
    }
  }

  // models: unique list sorted by total calls (most-called first)
  // modelCounts: total LLM calls per model (e.g., { "openai:gpt-4o": 12, "openai:gpt-4o-mini": 12 })
  const modelsMeta: Record<string, unknown> = {};
  if (totalModelCalls.size > 0) {
    const sorted = [...totalModelCalls.entries()].sort((a, b) => b[1] - a[1]);
    modelsMeta.models = sorted.map(([m]) => m);
    modelsMeta.modelCounts = Object.fromEntries(sorted);
  }

  // Aggregate per-workflow call counts across all items (parallel to models).
  // Workflows come from the runtime's trace-event collection — callers
  // don't specify workflow names anywhere, they just appear because the
  // runtime emits workflow_start events for every execute() call.
  const totalWorkflowCalls = new Map<string, number>();
  for (const item of evalItems) {
    const itemCounts = item.metadata?.workflowCallCounts;
    if (itemCounts && typeof itemCounts === 'object') {
      for (const [w, count] of Object.entries(itemCounts as Record<string, unknown>)) {
        if (typeof count === 'number')
          totalWorkflowCalls.set(w, (totalWorkflowCalls.get(w) ?? 0) + count);
      }
    } else {
      // Fallback: count unique workflows per item
      const itemWorkflows = item.metadata?.workflows;
      if (Array.isArray(itemWorkflows)) {
        for (const w of itemWorkflows) {
          if (typeof w === 'string')
            totalWorkflowCalls.set(w, (totalWorkflowCalls.get(w) ?? 0) + 1);
        }
      }
    }
  }

  // Fall back to config.workflow when the callback bypassed the runtime's
  // execute() path entirely (e.g. AxlTestRuntime-based tests). This keeps the
  // metadata.workflows array non-empty for the common test-harness case.
  const workflowsMeta: Record<string, unknown> = {};
  if (totalWorkflowCalls.size > 0) {
    const sorted = [...totalWorkflowCalls.entries()].sort((a, b) => b[1] - a[1]);
    workflowsMeta.workflows = sorted.map(([w]) => w);
    workflowsMeta.workflowCounts = Object.fromEntries(sorted);
  } else if (config.workflow) {
    workflowsMeta.workflows = [config.workflow];
    workflowsMeta.workflowCounts = { [config.workflow]: items.length };
  }

  options?.onProgress?.({ type: 'run_done', totalItems: items.length, failures });

  return {
    id,
    dataset: config.dataset.name,
    metadata: {
      ...config.metadata,
      scorerTypes,
      ...modelsMeta,
      ...workflowsMeta,
      ...(droppedAnnotationKeys.length > 0 ? { droppedAnnotationKeys } : {}),
    },
    timestamp: new Date().toISOString(),
    totalCost: accounting.knownCost,
    ...(accounting.completeness !== 'complete' ? { unpriced: true as const } : {}),
    accounting,
    ...(diagnostics ? { diagnostics } : {}),
    duration: Date.now() - startTime,
    items: evalItems,
    summary: {
      count: items.length,
      failures,
      coverage,
      scorers: scorerStats,
      timing,
      ...(modelTiming ? { modelTiming } : {}),
      ...(degraded ? { degraded } : {}),
      ...(itemErrorRate.failed > 0 ? { itemErrorRate } : {}),
    },
  };
}

/**
 * Count every item and every scorer into its outcome bucket, with all keys
 * present (including zeros) so a consumer can render "0 budget-skipped" without
 * inferring it from an absent key.
 *
 * Shared with `rescore`, which produces the same discriminants.
 */
export function buildCoverage(
  items: readonly EvalItem[],
  scorerNames: readonly string[],
): EvalCoverage {
  const coverage: EvalCoverage = {
    items: Object.fromEntries(ITEM_OUTCOMES.map((o) => [o, 0])) as EvalCoverage['items'],
    scorers: {},
  };
  for (const name of scorerNames) {
    coverage.scorers[name] = Object.fromEntries(SCORER_OUTCOMES.map((o) => [o, 0])) as Record<
      ScorerOutcome,
      number
    >;
  }
  for (const item of items) {
    // A legacy-shaped item (no `outcome`) is classified by its error, so a
    // reconstructed result still counts consistently.
    const outcome = item.outcome ?? (item.error ? 'failed' : 'completed');
    if (coverage.items[outcome] !== undefined) coverage.items[outcome] += 1;
    for (const name of scorerNames) {
      const detail = item.scoreDetails?.[name];
      if (!detail?.outcome) continue;
      const bucket = coverage.scorers[name];
      if (bucket[detail.outcome] !== undefined) bucket[detail.outcome] += 1;
    }
  }
  return coverage;
}

/** Per-model per-call distributions from the pooled raw timing blocks. */
function buildModelTiming(
  runCallSamples: Map<string, CallTiming[]>,
): EvalSummary['modelTiming'] | undefined {
  if (runCallSamples.size === 0) return undefined;
  return Object.fromEntries(
    [...runCallSamples.entries()].map(([model, samples]) => {
      const firstToken = samples.map((s) => s.firstTokenMs).filter((v): v is number => v != null);
      return [
        model,
        {
          calls: samples.length,
          wireMs: computeStats(samples.map((s) => s.wireMs)),
          queuedMs: computeStats(samples.map((s) => s.queuedMs)),
          retryMs: computeStats(samples.map((s) => s.retryMs)),
          ...(firstToken.length > 0
            ? { firstTokenMs: computeStats(firstToken), firstTokenCalls: firstToken.length }
            : {}),
        },
      ];
    }),
  );
}
