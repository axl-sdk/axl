/**
 * Shared helpers for working with `AxlEvent` streams.
 *
 * Consumers writing their own accumulators / reducers reach for these so
 * they don't have to re-derive spec invariants at every call site. The
 * core runtime, AxlTestRuntime, and Studio's cost reducer ALL use these —
 * keeping one source of truth for each invariant.
 */
import type { AxlEvent } from './types.js';

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
export function eventCostContribution(event: AxlEvent): number {
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
export function isCostBearingLeaf(event: AxlEvent): boolean {
  return COST_LEAF_SET.has(event.type);
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
export function isRootLevel(event: AxlEvent): boolean {
  // `AskScoped` variants carry `depth`; out-of-ask lifecycle events
  // (workflow_*, done, error, handoff without askId) don't. Treat
  // missing `depth` as root-level — those events are never at
  // depth ≥ 1.
  const d = (event as { depth?: number }).depth;
  return (d ?? 0) === 0;
}
