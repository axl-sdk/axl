/**
 * Terminal rendering helpers for the `axl-eval` CLI, factored out of `cli.ts` so
 * they can be unit-tested without importing `cli.ts` (whose module body runs
 * `main()` on import) — same reason as `cli-args.ts`.
 */

import type { Accounting } from '@axlsdk/axl';

import type { EvalAccounting, EvalResult, ModelTimingStats } from './types.js';
import { isBudgetStopped, readAccounting } from './accounting.js';
import { formatPercent } from './utils.js';

/**
 * Render known spend and say so when it is only a lower bound.
 *
 * Printing a bare `$0.00` for a run whose prices were unknown is the
 * presentation defect this replaces: it reads as "this was free" when the
 * honest statement is "we could not price N operations".
 */
export function formatKnownSpend(accounting: Accounting): string {
  const cost = `$${accounting.knownCost.toFixed(2)}`;
  if (accounting.completeness === 'complete') return cost;
  if (accounting.completeness === 'unverified') return `${cost} (unverified)`;
  const reasons = Object.entries(accounting.reasons)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ');
  return `${cost} (incomplete: ${reasons || 'unknown spend'})`;
}

/** The budget's outcome, when one was configured. */
export function formatBudgetLine(accounting: EvalAccounting): string | undefined {
  const budget = accounting.budget;
  if (!budget) return undefined;
  const limit = `$${budget.limit.toFixed(2)}`;
  const spent = `$${budget.knownSpend.toFixed(2)}`;
  if (budget.status === 'open') {
    return `  Budget: ${spent} of ${limit} (open)`;
  }
  const by = budget.closedBy ? `, first observed by ${budget.closedBy}` : '';
  return `  Budget: STOPPED — ${spent} known spend against a ${limit} limit, $${budget.knownOvershoot.toFixed(2)} over${by}`;
}

/** Item outcomes other than plain completion, so a truncated run cannot read as a clean one. */
export function formatCoverageLine(result: EvalResult): string | undefined {
  const items = result.summary.coverage?.items;
  if (!items) return undefined;
  const parts = (
    [
      ['failed', items.failed],
      ['cancelled', items.cancelled],
      ['budget-skipped', items.budget_skipped],
      ['budget-interrupted', items.budget_interrupted],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label}`);
  if (parts.length === 0) return undefined;
  const rate = result.summary.itemErrorRate;
  // The rate is informational even when the gate is off (limit 1) or not
  // tripped, so a reader sees how thin the run was without re-deriving it.
  const rateSuffix = rate
    ? ` — item error rate ${formatPercent(rate.rate)} (limit ${formatPercent(rate.limit)})`
    : '';
  const line = `  Items: ${items.completed} completed, ${parts.join(', ')}${rateSuffix}`;
  const causes = formatFailureCauses(result);
  return causes ? `${line}\n${causes}` : line;
}

/**
 * Group a run's `failed` items by structured cause, most frequent first:
 * `  Failure causes: 5 × 429 (openai), 3 × 503 (openai), 2 × network (openai), 2 × other`.
 *
 * A rate-limit storm and a genuine model or tool failure call for different
 * fixes, and without this they print as one undifferentiated count. A status of
 * `0` is a network-level failure; an item with no provider status (a plain
 * throw, a pre-0.24 artifact) is `other`, so the counts always sum to
 * `coverage.items.failed`.
 */
export function formatFailureCauses(result: EvalResult): string | undefined {
  const counts = new Map<string, number>();
  for (const item of result.items) {
    if (item.outcome !== 'failed') continue;
    const f = item.failure;
    let label = 'other';
    if (f?.status !== undefined) {
      const status = f.status === 0 ? 'network' : String(f.status);
      label = f.provider ? `${status} (${f.provider})` : status;
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  const groups = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, n]) => `${n} × ${label}`);
  return `  Failure causes: ${groups.join(', ')}`;
}

/**
 * The item-coverage gate's failure line, or `null` when it did not trip.
 *
 * Distinct from a budget stop and from a total wipeout: this run DID produce
 * scores, but over too few of its items to be trusted as a baseline.
 */
export function itemErrorRateMessage(result: EvalResult, label: string): string | null {
  const rate = result.summary.itemErrorRate;
  if (!rate?.exceeded) return null;
  return (
    `[axl-eval] ITEM ERROR RATE EXCEEDED: ${label} — ${rate.failed} of ${rate.attempted} attempted ` +
    `item(s) failed in the workflow (item error rate ${formatPercent(rate.rate)}), over the ` +
    `${formatPercent(rate.limit)} limit; the scores cover only the surviving items. ` +
    `Raise failOnItemErrorRate or pass --max-item-error-rate <0..1> to accept it (1 disables the gate).`
  );
}

/**
 * The distinct, first-printed reason for a budget-stopped run, or `null`.
 *
 * "We stopped spending" is a different fact from "the model regressed" or "a
 * judge is flaky", and it is the one that explains why the numbers cover less
 * than the whole dataset. A caller exits non-zero on it WITHOUT counting it as
 * a model failure.
 *
 * A closed budget is NOT sufficient — see {@link isBudgetStopped}, which owns
 * that rule for the CLI, the Studio server and the Studio browser mirror
 * alike. The informational `Budget:` row still shows the closure; it just does
 * not gate the exit code.
 */
export function budgetStopMessage(result: EvalResult, label: string): string | null {
  const budget = readAccounting(result).budget;
  if (!budget || !isBudgetStopped({ budget, coverage: result.summary.coverage })) return null;
  const items = result.summary.coverage?.items;
  const stopped = items
    ? ` ${items.budget_skipped} case(s) never started, ${items.budget_interrupted} stopped mid-flight, ${items.completed} completed.`
    : '';
  return (
    `[axl-eval] BUDGET STOPPED: ${label} — known spend $${budget.knownSpend.toFixed(2)} reached the ` +
    `$${budget.limit.toFixed(2)} limit (over by $${budget.knownOvershoot.toFixed(2)}).${stopped} ` +
    `The run is incomplete by design; this is NOT a model or scorer failure.`
  );
}

/**
 * `true` when the WORKFLOW failed on every item — a broken eval, not a
 * truncated one.
 *
 * A budget stop is deliberately excluded: those items never ran, so calling
 * them a total wipeout would report a working model as broken and hide the real
 * reason the run is short.
 */
export function isTotalWipeout(result: EvalResult): boolean {
  const { count, failures } = result.summary;
  if (count === 0) return false;
  const coverage = result.summary.coverage?.items;
  if (coverage) {
    const budgetStopped = coverage.budget_skipped + coverage.budget_interrupted;
    if (coverage.completed > 0 || budgetStopped > 0) return false;
    return coverage.failed === count;
  }
  return failures >= count;
}

/**
 * Render the per-model provider-latency rows that sit under the wall-clock
 * `Timing` row.
 *
 * Every figure is per PROVIDER CALL — the whole `modelTiming` surface is now
 * one kind of average, so there is nothing here a reader can accidentally
 * divide by the call count and get wrong.
 *
 * `wire` and `first token` carry a `mean/p95` pair because those are the two
 * model-comparison figures and a tail matters for both. `queued` and `retries`
 * print a mean only: they describe Axl's own limiter and the provider's
 * throttling on the day of the run, so a p95 would lengthen every row without
 * changing a model choice. The full distributions stay on the JSON artifact.
 *
 * Units are milliseconds and every number is suffixed, because these are
 * routinely sub-second and the `Timing` row above renders seconds — an
 * unlabelled column would silently mix the two.
 *
 * `first token` appears only when at least one call actually streamed one, so a
 * non-streaming run shows no misleading `0ms`.
 *
 * @param modelTiming `EvalSummary.modelTiming`, or undefined for no rows.
 * @param nameWidth   The scorer-name column width, so model names line up under it.
 */
export function formatModelTimingLines(
  modelTiming: Record<string, ModelTimingStats> | undefined,
  nameWidth: number,
): string[] {
  if (!modelTiming) return [];
  return Object.entries(modelTiming).map(([model, t]) => {
    const parts = [`wire ${formatMs(t.wireMs.mean)}/${formatMs(t.wireMs.p95)}`];
    if (t.firstTokenMs) {
      parts.push(`first token ${formatMs(t.firstTokenMs.mean)}/${formatMs(t.firstTokenMs.p95)}`);
    }
    parts.push(`queued ${formatMs(t.queuedMs.mean)}`);
    parts.push(`retries ${formatMs(t.retryMs.mean)}`);
    const calls = `${t.calls} call${t.calls === 1 ? '' : 's'}`;
    return `    ${model.padEnd(Math.max(nameWidth - 2, 0))}  ${parts.join(' · ')}  (${calls}, mean/p95 per call)`;
  });
}

/** Whole milliseconds with an explicit unit. Latencies here are per call, so a
 *  seconds-with-one-decimal rendering would collapse most of them to `0.0s`. */
function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}
