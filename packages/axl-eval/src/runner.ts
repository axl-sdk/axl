import type { AxlRuntime } from '@axlsdk/axl';
import type { EvalConfig, EvalResult, EvalItem, EvalSummary, RunEvalOptions } from './types.js';
import type { ScorerContext } from './scorer.js';
import type { DegradedScorer } from './types.js';
import {
  computeStats,
  mapWithConcurrency,
  scorerCounts,
  evaluateScorerTolerance,
} from './utils.js';
import { scoreItem } from './score-item.js';
import { randomUUID } from 'node:crypto';

function parseCost(cost: string): number {
  const match = cost.match(/^\$?([\d.]+)$/);
  if (!match) throw new Error(`Invalid cost format: "${cost}"`);
  return parseFloat(match[1]);
}

/**
 * Extract a user-returned cost only if it's a non-negative finite number.
 * Guards against workflows that return `{ cost: 'free' }`, `{ cost: NaN }`,
 * `{ cost: -1 }`, `{ cost: Infinity }`, etc. — the TS type says `cost?: number`
 * but at runtime we can't trust that.
 *
 * Negative costs are rejected because (a) cost is a USD amount and negative
 * values are nonsensical, and (b) a negative cost would silently shrink
 * `totalCost` below the budget limit check at the processItem level,
 * letting a buggy/malicious workflow run unbounded. `0` is preserved
 * because free operations on paid models are valid.
 *
 * When a user-supplied value is rejected (present but invalid), we log
 * once per item via `console.warn` so the type violation is visible
 * rather than silently swallowed.
 */
function extractUserCost(result: unknown, label = 'executeWorkflow'): number | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const raw = (result as { cost?: unknown }).cost;
  if (raw === undefined) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;

  console.warn(
    `[axl-eval] Ignoring invalid \`cost\` from ${label} return: expected non-negative finite number, got ${typeof raw === 'number' ? String(raw) : typeof raw}. Falling back to tracked cost (or undefined).`,
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
  const items = await config.dataset.getItems();
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
  const budgetLimit = config.budget ? parseCost(config.budget) : undefined;

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
  let totalCost = 0;
  let budgetExceeded = false;

  async function processItem(item: (typeof items)[0], itemIndex: number): Promise<void> {
    if (options?.signal?.aborted) {
      evalItems[itemIndex] = {
        input: item.input,
        annotations: item.annotations,
        output: null,
        error: 'Cancelled',
        scores: {},
      };
      options?.onProgress?.({ type: 'item_done', itemIndex, totalItems: items.length });
      return;
    }

    if (budgetExceeded) {
      evalItems[itemIndex] = {
        input: item.input,
        annotations: item.annotations,
        output: null,
        error: 'Budget exceeded',
        scores: {},
      };
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
    try {
      // When captureTraces is on, wrap the user's executeWorkflow in
      // trackExecution so we get a per-item TraceEvent[] scoped via
      // AsyncLocalStorage. trackExecution's scope walks the parent chain, so
      // any nested trackExecution (e.g. from the CLI) continues to work.
      if (options?.captureTraces) {
        const tracked = await runtime.trackExecution(
          async () => executeWorkflow(item.input, runtime),
          { captureTraces: true },
        );
        evalItem.duration = Date.now() - itemStart;
        evalItem.output = tracked.result.output;
        // Prefer user-returned cost/metadata; fall back to tracked values.
        // Type-guarded so a non-number cost (e.g. `{ cost: 'free' }`) or a
        // non-object metadata (e.g. an array or scalar) doesn't silently
        // corrupt downstream math or shape expectations.
        evalItem.cost = extractUserCost(tracked.result) ?? tracked.cost;
        evalItem.metadata = extractUserMetadata(tracked.result) ?? tracked.metadata;
        if (tracked.traces && tracked.traces.length > 0) {
          evalItem.traces = tracked.traces;
        }
        if (evalItem.cost != null) {
          totalCost += evalItem.cost;
        }
      } else {
        const result = await executeWorkflow(item.input, runtime);
        evalItem.duration = Date.now() - itemStart;
        evalItem.output = result.output;
        evalItem.cost = extractUserCost(result);
        const meta = extractUserMetadata(result);
        if (meta) evalItem.metadata = meta;
        if (evalItem.cost != null) {
          totalCost += evalItem.cost;
        }
      }
    } catch (err) {
      evalItem.duration = Date.now() - itemStart;
      evalItem.error = err instanceof Error ? err.message : String(err);
      // Failed items are exactly when per-item traces are most valuable —
      // recover them from the captured-traces side-channel `trackExecution`
      // attaches to the error on the failure path.
      if (options?.captureTraces) {
        const captured = (err as { axlCapturedTraces?: unknown }).axlCapturedTraces;
        if (Array.isArray(captured) && captured.length > 0) {
          evalItem.traces = captured as EvalItem['traces'];
        }
      }
      evalItems[itemIndex] = evalItem;
      options?.onProgress?.({ type: 'item_done', itemIndex, totalItems: items.length });
      return;
    }

    if (budgetLimit != null && totalCost > budgetLimit) {
      budgetExceeded = true;
    }

    // Score the item's output with all scorers (bounded fan-out). scoreItem
    // owns the determinism + cancellation + cost logic shared with rescore();
    // it returns the per-item scorer cost to fold into the running total.
    // NB: keep the await on its own line — `totalCost += await …` would read
    // totalCost BEFORE suspending, losing updates across concurrent items.
    const itemScorerCost = await scoreItem(
      evalItem,
      config.scorers,
      scorerConcurrency,
      scorerContext,
      options?.signal,
    );
    totalCost += itemScorerCost;
    evalItems[itemIndex] = evalItem;
    options?.onProgress?.({ type: 'item_done', itemIndex, totalItems: items.length });
  }

  // processItem writes into the pre-allocated `evalItems` closure array (the
  // source of truth) and returns void — the pool's returned array is ignored.
  await mapWithConcurrency(items, concurrency, (item, i) => processItem(item, i));

  const failures = evalItems.filter((i) => i.error).length;
  const scorerNames = config.scorers.map((s) => s.name);
  const scorerStats: EvalSummary['scorers'] = {};
  for (const name of scorerNames) {
    const scores = evalItems
      .filter((i) => !i.error && i.scores[name] != null)
      .map((i) => i.scores[name] as number);
    const { scored, failed } = scorerCounts(evalItems, name);
    scorerStats[name] = { ...computeStats(scores), scored, failed };
  }

  const scorerTypes: Record<string, string> = {};
  for (const s of config.scorers) {
    scorerTypes[s.name] = s.isLlm ? 'llm' : 'deterministic';
  }

  // Failure-rate trust signal (opt-in). When `failOnScorerErrorRate` is set, a
  // scorer is degraded when it's deterministic and failed at all (a failure is
  // a bug, not noise), OR it's an LLM judge whose failure rate over its
  // ATTEMPTED items exceeds tolerance. We never throw — the result is still
  // useful; we flag it and let the CLI/consumer decide the exit code. Invalid
  // limits are ignored loudly so a typo can't silently disable the gate.
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

  const durations = evalItems.filter((i) => !i.error && i.duration != null).map((i) => i.duration!);
  const timing = durations.length > 0 ? computeStats(durations) : undefined;

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
  // Workflows come from trackExecution's trace-event collection — callers
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
    totalCost,
    duration: Date.now() - startTime,
    items: evalItems,
    summary: {
      count: items.length,
      failures,
      scorers: scorerStats,
      timing,
      ...(degraded ? { degraded } : {}),
    },
  };
}
