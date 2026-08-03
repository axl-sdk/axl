/**
 * Shared helpers for working with `AxlEvent` streams.
 *
 * Consumers writing their own accumulators / reducers reach for these so
 * they don't have to re-derive spec invariants at every call site. The
 * core runtime, AxlTestRuntime, and Studio's cost reducer ALL use these —
 * keeping one source of truth for each invariant.
 */
import type { HistoricalAxlEvent } from './types.js';

/**
 * Variants that directly carry an authoritative cost charge from the
 * provider (or embedder). `ask_end` is a per-ask ROLLUP of these leaves
 * — counting it alongside them would double-charge. Any future
 * cost-emitting variant MUST be added here AND NOT be a rollup.
 *
 * Treated as a `Set` for O(1) membership checks; exported `as const`
 * tuple so exhaustiveness fixtures can cross-check against
 * `AXL_EVENT_TYPES`.
 */
export const COST_BEARING_LEAF_TYPES = [
  'agent_call_end',
  'tool_call_end',
  'memory_remember',
  'memory_recall',
] as const;

const COST_LEAF_SET: ReadonlySet<string> = new Set(COST_BEARING_LEAF_TYPES);

/**
 * True when an event reports a POSITIVE token count — i.e. it did measurable,
 * billable work. This is the discriminator the unpriced-cost signal (T2.5) uses:
 * a cost-bearing leaf with positive tokens but no usable cost is an unpriced
 * model / pricing-table miss, whereas a failed call (no usage) or a no-usage
 * streamed `done` (zero tokens) is NOT "unpriced". Used by the core ask-cost
 * rollup AND the Studio aggregators, so the per-ask flag and the dashboard count
 * stay in lockstep.
 */
export function hasPositiveTokens(event: {
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cached?: number;
    cacheWrite?: number;
  } | null;
}): boolean {
  const t = event.tokens;
  if (!t) return false;
  return (
    (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cached ?? 0) + (t.cacheWrite ?? 0) >
    0
  );
}

/**
 * True when a cost value is usable for accounting: a finite, non-negative
 * number. A NON-usable cost (`undefined`, `NaN`, `Infinity`, negative) on a
 * work-bearing leaf is what marks it "unpriced / unknown". Shared by the core
 * ask-cost rollup and the Studio aggregators so their unpriced detection stays
 * exactly in lockstep (incl. the non-finite edge).
 */
export function isUsableCost(cost: unknown): cost is number {
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0;
}

/**
 * Cost contribution of `event` to a running total.
 *
 * Returns the event's `cost` if it's a cost-bearing leaf; 0 otherwise.
 * The key invariant (spec/16 decision 10): `ask_end` events carry a
 * per-ask ROLLUP of leaf costs that already passed through consumer
 * accumulators, so they contribute 0 here to avoid double-counting.
 *
 * Use this at every place you'd write `total += event.cost`:
 *
 *     for (const ev of info.events) total += eventCostContribution(ev);
 *
 * Consumers who want the authoritative per-ask rollup read
 * `ask_end.cost` directly — that field is populated whether or not
 * the leaf events were summed separately. Spec decision 10.
 */
export function eventCostContribution(event: HistoricalAxlEvent): number {
  // `ask_end` explicitly excluded (rollup). Other variants that carry
  // a top-level `cost` (e.g., `agent_call_end`, `tool_call_end`,
  // `memory_*`) contribute their charge directly. Unknown future
  // variants with `cost` set but NOT in the leaf set also contribute
  // — covering providers that invent new cost-bearing events. The
  // conservative choice would be "only count whitelisted"; we've
  // chosen the liberal choice ("count anything with cost except
  // ask_end") because missing a cost charge is a harder-to-detect
  // regression than a small over-count on a hypothetical new variant.
  //
  // `Number.isFinite` guards against NaN / +-Infinity from malformed
  // pricing tables (spec/16 bug-review §B-2). `c >= 0` guards against
  // negative values — providers always charge, never refund per-call,
  // so a negative `cost` is almost certainly a pricing-table typo or a
  // buggy third-party provider. Silently ignore either anomaly:
  // polluting the running total is permanent — it flows into every
  // downstream consumer (budget checks, cost dashboard, eval metadata)
  // and can't be recovered.
  if (event.type === 'ask_end') return 0;
  const c = event.cost;
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : 0;
}

/**
 * True when the event is a cost-bearing leaf (contributes directly to
 * totals) — used by internal emitters that need to know whether to
 * bump per-frame askCost rollups.
 *
 * Distinct from `eventCostContribution(e) > 0`: an `agent_call_end`
 * with `cost: 0` is still a leaf (produced by a free / cached turn),
 * just one that happens to contribute zero.
 */
export function isCostBearingLeaf(event: HistoricalAxlEvent): boolean {
  return COST_LEAF_SET.has(event.type);
}

/**
 * True when the event is the "unpriced lower-bound" signal: a cost-bearing leaf
 * that did measurable, billable work (POSITIVE tokens) but produced no usable
 * cost (an unpriced model / pricing-table miss). This is the SINGLE source of
 * truth for that discriminator — the core ask-cost rollup, the runtime's
 * `ExecutionInfo.unpriced` / `trackExecution().unpriced` aggregation, and
 * Studio's `unpricedCalls` count + cost reducer ALL route through it, so they
 * cannot drift.
 *
 * It is the conjunction of the three primitives:
 *   `isCostBearingLeaf` ∧ `!isUsableCost(cost)` ∧ `hasPositiveTokens`.
 * The positive-token term is what distinguishes an unpriced model from a FAILED
 * call (no usage) or a no-usage streamed `done` (zero tokens) — neither is
 * "unpriced". An `ask_end` rollup carries a numeric cost, and `tool_call_end`
 * carries no tokens, so both are naturally excluded.
 *
 * Structural param (like {@link hasPositiveTokens} / {@link isUsableCost}) so
 * Studio's pre-typed trace-event shapes can pass through without casting.
 */
export function isUnpricedLeaf(event: {
  type?: string;
  cost?: unknown;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cached?: number;
    cacheWrite?: number;
  } | null;
}): boolean {
  return (
    event.type !== undefined &&
    COST_LEAF_SET.has(event.type) &&
    !isUsableCost(event.cost) &&
    hasPositiveTokens(event)
  );
}

/**
 * True when the event originates from the root ask (`depth === 0`)
 * or has no ask correlation at all (workflow / done / error / log).
 *
 * Used by consumers that want "just the chat bubble" tokens or
 * "just the root ask" visuals. Nested-ask UIs drop this filter.
 *
 * `depth` is coerced through `?? 0` so events without the field
 * (out-of-ask lifecycle events, synthesized terminals) are treated
 * as root-level — they're never at depth ≥ 1.
 */
export function isRootLevel(event: HistoricalAxlEvent): boolean {
  // `AskScoped` variants carry `depth`; out-of-ask lifecycle events
  // (workflow_*, done, error, handoff without askId) don't. Treat
  // missing `depth` as root-level — those events are never at
  // depth ≥ 1.
  const d = (event as { depth?: number }).depth;
  return (d ?? 0) === 0;
}
