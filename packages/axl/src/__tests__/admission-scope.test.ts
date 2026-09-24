/**
 * Admission coverage for the threshold's arithmetic, its reach across the
 * scope chain, and the transports/records it must not distort.
 *
 * Matrix rows: A6.4 (float boundary), A8.6 (streaming denial), A8.15 (denial
 * invents no charge and no incompleteness), A9.4 (an ANCESTOR's closed
 * controller still denies).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import { AdmissionController, externalOperation } from '../accounting.js';
import { AdmissionDeniedError } from '../errors.js';
import type { StreamChunk } from '../providers/types.js';
import { scriptedRuntime, ScriptedProvider } from './accounting-helpers.js';

/** Walk an error's `cause` chain for the admission denial the runtime wrapped. */
function findDenial(error: unknown): AdmissionDeniedError | undefined {
  for (let c: unknown = error; c != null; c = (c as { cause?: unknown }).cause) {
    if (c instanceof AdmissionDeniedError) return c;
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// A6.4 — the documented rule is applied to the number that actually accrued
// ═══════════════════════════════════════════════════════════════════════════

describe('A6.4: the float boundary is decided by knownSpend >= limit, with no fudge', () => {
  it('keeps `closed` in lockstep with the accumulated value at 0.1 × 3 vs 0.3', async () => {
    const admission = new AdmissionController({ limit: 0.3 });
    const { runtime } = scriptedRuntime([{ cost: 0.1 }]);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    runtime.register(
      workflow({
        name: 'three-dimes',
        input: z.any(),
        handler: async (ctx) => {
          for (let i = 0; i < 3; i++) await ctx.ask(asker, `turn ${i}`);
          return 'done';
        },
      }),
    );

    await runtime.trackOutcome(() => runtime.execute('three-dimes', {}), { admission });

    // 0.1 + 0.1 + 0.1 is 0.30000000000000004 in IEEE-754, and contracts.md Q4
    // freezes raw-float comparison with no rounding to cents. What the test
    // pins is the INVARIANT, not a hand-computed 0.3: an epsilon fudge that
    // left `closed` disagreeing with `knownSpend >= limit` is the bug.
    expect(admission.closed).toBe(admission.knownSpend >= admission.limit);
    expect(admission.status).toBe(admission.closed ? 'closed' : 'open');
    expect(admission.knownOvershoot).toBeCloseTo(
      Math.max(0, admission.knownSpend - admission.limit),
      12,
    );
    expect(admission.admit().admitted).toBe(!admission.closed);
  });

  it('reports a sub-cent overshoot rather than clamping it to the limit', async () => {
    const admission = new AdmissionController({ limit: 0.3 });
    const { runtime } = scriptedRuntime([{ cost: 0.1 }]);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    runtime.register(
      workflow({
        name: 'three-dimes',
        input: z.any(),
        handler: async (ctx) => {
          for (let i = 0; i < 3; i++) await ctx.ask(asker, `turn ${i}`);
          return 'done';
        },
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('three-dimes', {}), {
      admission,
    });

    // All three were admitted (each check happened while spend was still below
    // the limit), so the run's own total is the honest 0.30000000000000004.
    expect(outcome.accounting.operations.settled).toBe(3);
    expect(admission.knownSpend).toBe(0.1 + 0.1 + 0.1);
    expect(admission.knownSpend).toBeGreaterThan(0.3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A8.6 — a stream is denied where it dispatches: the first next()
// ═══════════════════════════════════════════════════════════════════════════

describe('A8.6: a closed scope denies a stream before the adapter is entered', () => {
  it('throws on the first next(), invokes no raw stream and yields no done chunk', async () => {
    const provider = new ScriptedProvider([{ cost: 1 }]);
    const runtime = new AxlRuntime({ defaultProvider: 'scripted' });
    runtime.registerProvider('scripted', provider);
    const facade = runtime.resolveProvider('scripted:m').provider;

    const chunks: StreamChunk[] = [];
    let denial: unknown;
    const outcome = await runtime.trackOutcome(
      async () => {
        const iterator = facade.stream([], { model: 'm' });
        // Construction alone must not dispatch — nor must it throw.
        expect(provider.calls).toHaveLength(0);
        try {
          for await (const chunk of iterator) chunks.push(chunk);
        } catch (error) {
          denial = error;
        }
        return 'observed';
      },
      { admission: new AdmissionController({ limit: 0 }) },
    );

    expect(denial).toBeInstanceOf(AdmissionDeniedError);
    expect((denial as AdmissionDeniedError).operation.kind).toBe('stream');
    expect(provider.calls).toHaveLength(0);
    expect(chunks).toEqual([]);
    expect(outcome.accounting.operations.denied).toBe(1);
    expect(outcome.accounting.operations.total).toBe(0);
    expect(outcome.accounting.knownCost).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A8.15 — denial adds nothing: no charge, no reason, no incompleteness
// ═══════════════════════════════════════════════════════════════════════════

describe('A8.15: a run that settled some work and refused the rest stays complete', () => {
  it('reports only the settled sum across a 2-settled / 3-denied mix', async () => {
    const admission = new AdmissionController({ limit: 1 });
    const { runtime, provider } = scriptedRuntime([{ cost: 0.75 }]);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    let denials = 0;
    runtime.register(
      workflow({
        name: 'five-attempts',
        input: z.any(),
        handler: async (ctx) => {
          for (let i = 0; i < 5; i++) {
            try {
              await ctx.ask(asker, `turn ${i}`);
            } catch (error) {
              if (findDenial(error)) denials += 1;
              else throw error;
            }
          }
          return 'done';
        },
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('five-attempts', {}), {
      admission,
    });

    expect(outcome.status).toBe('fulfilled');
    expect(provider.calls).toHaveLength(2);
    expect(denials).toBe(3);

    const { accounting } = outcome;
    expect(accounting.knownCost).toBeCloseTo(1.5, 10);
    expect(accounting.operations.denied).toBe(3);
    expect(accounting.operations.settled).toBe(2);
    // `denied` is disjoint from `total` (contracts.md Q3) and contributes no
    // reason, so a budgeted run is not permanently "incomplete" merely for
    // having refused work.
    expect(accounting.operations.total).toBe(2);
    expect(accounting.completeness).toBe('complete');
    expect(accounting.reasons).toEqual({});
    expect(accounting.operations.byKind.chat).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A9.4 — the check walks ancestors, not just the nearest controller
// ═══════════════════════════════════════════════════════════════════════════

describe('A9.4: a closed OUTER controller denies work inside an open inner scope', () => {
  it('refuses with the outer controller’s own limit and known spend', async () => {
    const outer = new AdmissionController({ limit: 0.5 });
    const inner = new AdmissionController({ limit: 100 });
    const { runtime, provider } = scriptedRuntime([{ cost: 0.5 }]);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    runtime.register(
      workflow({ name: 'ask', input: z.any(), handler: async (ctx) => ctx.ask(asker, 'go') }),
    );

    let denial: AdmissionDeniedError | undefined;
    const result = await runtime.trackOutcome(
      async () => {
        // Spend the outer budget to exactly its limit; it closes.
        await runtime.execute('ask', {});
        expect(outer.closed).toBe(true);

        // A brand-new, generously funded inner scope must NOT reopen it.
        const nested = await runtime.trackOutcome(() => runtime.execute('ask', {}), {
          admission: inner,
        });
        expect(nested.status).toBe('rejected');
        denial = findDenial(nested.status === 'rejected' ? nested.error : undefined);
        expect(nested.accounting.operations.denied).toBe(1);
        return 'outer survived';
      },
      { admission: outer },
    );

    expect(result.status).toBe('fulfilled');
    // Only the first ask ever reached the adapter.
    expect(provider.calls).toHaveLength(1);
    expect(denial).toBeInstanceOf(AdmissionDeniedError);
    // The fields name the controller that actually refused — the outer one.
    expect(denial?.limit).toBe(0.5);
    expect(denial?.knownSpend).toBe(0.5);
    expect(inner.closed).toBe(false);
    expect(inner.knownSpend).toBe(0);
  });

  it('still denies an external operation opened under the open inner scope', async () => {
    const outer = new AdmissionController({ limit: 0 });
    const inner = new AdmissionController({ limit: 100 });
    const runtime = new AxlRuntime();

    let ran = false;
    let denial: AdmissionDeniedError | undefined;
    await runtime.trackOutcome(
      async () => {
        const nested = await runtime.trackOutcome(
          () =>
            externalOperation({ name: 'vendor' }, async (report) => {
              ran = true;
              report.setCost(1);
            }),
          { admission: inner },
        );
        denial = findDenial(nested.status === 'rejected' ? nested.error : undefined);
      },
      { admission: outer },
    );

    // The caller-declared charge never happens, so an ancestor budget cannot be
    // walked around by opening a fresh inner scope.
    expect(ran).toBe(false);
    expect(denial).toBeInstanceOf(AdmissionDeniedError);
    expect(denial?.limit).toBe(0);
    expect(inner.knownSpend).toBe(0);
  });
});
