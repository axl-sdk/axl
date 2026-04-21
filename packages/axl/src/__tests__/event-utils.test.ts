import { describe, it, expect } from 'vitest';
import {
  COST_BEARING_LEAF_TYPES,
  eventCostContribution,
  isCostBearingLeaf,
  isRootLevel,
} from '../event-utils.js';
import type { AxlEvent } from '../types.js';

/**
 * Build a synthetic AxlEvent with the base fields plus a variant-specific
 * overlay. The helper casts at the boundary; the invariants being tested
 * live entirely in `event-utils.ts` and are structural — they only inspect
 * `type`, `cost`, and `depth`. Keeping the builder loose avoids pulling in
 * schema boilerplate that isn't part of the surface under test.
 */
function ev(partial: Record<string, unknown>): AxlEvent {
  return {
    executionId: 'exec-1',
    step: 0,
    timestamp: 0,
    ...partial,
  } as unknown as AxlEvent;
}

describe('eventCostContribution', () => {
  it('returns 0 when event.cost is undefined (leaf type with no cost)', () => {
    // `agent_call_end` is a cost-bearing leaf but the cost field is optional;
    // an unset cost must contribute zero, never `NaN` or the string "undefined".
    const e = ev({ type: 'agent_call_end' });
    expect(eventCostContribution(e)).toBe(0);
  });

  it('returns 0 when event.type === "ask_end" even if cost is set (rollup exclusion)', () => {
    // Spec/16 §10: ask_end carries a rollup of leaves already charged; summing
    // both would double-count. This is THE rule the helper exists to encode.
    const e = ev({ type: 'ask_end', cost: 0.42, outcome: { ok: true, result: 'x' } });
    expect(eventCostContribution(e)).toBe(0);
  });

  it('returns 0 when event.cost is NaN (finite guard against poisoned totals)', () => {
    const e = ev({ type: 'agent_call_end', cost: Number.NaN });
    expect(eventCostContribution(e)).toBe(0);
  });

  it('returns 0 when event.cost is +Infinity', () => {
    const e = ev({ type: 'agent_call_end', cost: Number.POSITIVE_INFINITY });
    expect(eventCostContribution(e)).toBe(0);
  });

  it('returns 0 when event.cost is -Infinity', () => {
    const e = ev({ type: 'agent_call_end', cost: Number.NEGATIVE_INFINITY });
    expect(eventCostContribution(e)).toBe(0);
  });

  it('returns 0 when event.cost is negative (likely pricing-table typo)', () => {
    // Providers always charge, never refund per-call. A negative `cost`
    // is almost certainly a buggy provider or pricing-table typo —
    // silently ignore to avoid corrupting downstream budgets / cost
    // dashboards, matching the NaN/Infinity guard philosophy.
    const e = ev({ type: 'agent_call_end', cost: -0.01 });
    expect(eventCostContribution(e)).toBe(0);
  });

  it('returns 0 for ask_end with NaN cost (ask_end check short-circuits before finite guard)', () => {
    // Ordering invariant: ask_end type check fires first, so a malformed
    // ask_end.cost (NaN/negative/Infinity) never reaches the finite+sign
    // guard. A refactor that reversed the order would still return 0
    // because the guard catches NaN, but this test pins the explicit
    // "type === ask_end ⇒ 0" rule regardless of cost value.
    const e = ev({ type: 'ask_end', cost: Number.NaN, outcome: { ok: true, result: null } });
    expect(eventCostContribution(e)).toBe(0);
  });

  it('returns event.cost for agent_call_end', () => {
    const e = ev({ type: 'agent_call_end', cost: 0.05 });
    expect(eventCostContribution(e)).toBe(0.05);
  });

  it('returns event.cost for tool_call_end', () => {
    const e = ev({ type: 'tool_call_end', cost: 0.002 });
    expect(eventCostContribution(e)).toBe(0.002);
  });

  it('returns event.cost for memory_remember', () => {
    const e = ev({ type: 'memory_remember', cost: 0.0001 });
    expect(eventCostContribution(e)).toBe(0.0001);
  });

  it('returns event.cost for memory_recall', () => {
    const e = ev({ type: 'memory_recall', cost: 0.0003 });
    expect(eventCostContribution(e)).toBe(0.0003);
  });

  it('treats zero cost as zero (not as falsy skip)', () => {
    // An `agent_call_end` with cost=0 is a real event (e.g., cached turn);
    // the helper must return 0 (finite, valid), not swap it for some sentinel.
    const e = ev({ type: 'agent_call_end', cost: 0 });
    expect(eventCostContribution(e)).toBe(0);
  });

  it('returns event.cost for unknown cost-carrying types (liberal "anything but ask_end")', () => {
    // Per the function's doc comment, the design liberally counts any
    // non-ask_end event with a finite cost field. Pin that contract so a
    // future refactor tightening this rule must update the test AND the doc.
    const e = ev({ type: 'log', cost: 0.01, data: {} });
    expect(eventCostContribution(e)).toBe(0.01);
  });
});

describe('isCostBearingLeaf', () => {
  it.each(['agent_call_end', 'tool_call_end', 'memory_remember', 'memory_recall'])(
    'returns true for %s',
    (type) => {
      expect(isCostBearingLeaf(ev({ type }))).toBe(true);
    },
  );

  it.each(['ask_end', 'tool_approval', 'pipeline', 'log', 'workflow_end', 'handoff', 'token'])(
    'returns false for %s',
    (type) => {
      expect(isCostBearingLeaf(ev({ type }))).toBe(false);
    },
  );
});

describe('isRootLevel', () => {
  it('returns true when depth is undefined (out-of-ask lifecycle events)', () => {
    const e = ev({ type: 'workflow_start', data: { input: {} } });
    expect(isRootLevel(e)).toBe(true);
  });

  it('returns true when depth is 0', () => {
    const e = ev({ type: 'token', data: 'hi', askId: 'a', depth: 0 });
    expect(isRootLevel(e)).toBe(true);
  });

  it('returns false when depth is 1', () => {
    const e = ev({ type: 'token', data: 'hi', askId: 'a', depth: 1 });
    expect(isRootLevel(e)).toBe(false);
  });

  it('returns false when depth is >= 2 (deeply nested asks)', () => {
    const e = ev({ type: 'token', data: 'hi', askId: 'a', depth: 5 });
    expect(isRootLevel(e)).toBe(false);
  });
});

describe('COST_BEARING_LEAF_TYPES', () => {
  it('contains exactly the four authoritative leaf types', () => {
    // Pinning the contents catches accidental additions/removals — a new leaf
    // type requires a conscious update here PLUS the cost accumulator sites.
    expect([...COST_BEARING_LEAF_TYPES]).toEqual([
      'agent_call_end',
      'tool_call_end',
      'memory_remember',
      'memory_recall',
    ]);
  });

  it('is immutable at the type level via `as const`', () => {
    // `as const` tuples are readonly in TS but not frozen at runtime. The
    // guarantee we want to pin is the `as const` tuple type, which this
    // assignment enforces at compile time: `readonly` means indexed access
    // returns the specific literal type, not `string`.
    const first: 'agent_call_end' = COST_BEARING_LEAF_TYPES[0];
    expect(first).toBe('agent_call_end');
  });
});
