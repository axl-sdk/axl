/**
 * External operations (plan A4).
 *
 * A caller can declare spend Axl cannot observe. What it must NOT be able to do
 * is overwrite measured spend, double-count a nested Axl call, or make a run
 * look complete when nothing was reported.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import { AdmissionController, externalOperation } from '../accounting.js';
import { AdmissionDeniedError, AxlError } from '../errors.js';
import { scriptedRuntime } from './accounting-helpers.js';

describe('external operations add disjoint spend without touching measured spend', () => {
  it('adds a declared $0.20 to a measured $0.75', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.75 }]);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    runtime.register(
      workflow({
        name: 'mixed',
        input: z.any(),
        handler: async (ctx) => {
          await ctx.ask(asker, 'go');
          return ctx.withExternalOperation({ name: 'vendor-search' }, async (report) => {
            report.setCost(0.2);
            return 'rows';
          });
        },
      }),
    );

    const { accounting } = await runtime.trackOutcome(() => runtime.execute('mixed', {}));

    expect(accounting.knownCost).toBeCloseTo(0.95, 10);
    expect(accounting.breakdown.generation).toBeCloseTo(0.75, 10);
    expect(accounting.breakdown.external).toBeCloseTo(0.2, 10);
    // Declared spend is labeled, never confused with what Axl measured.
    expect(accounting.provenance).toEqual({ adapter_reported: 0.75, caller_reported: 0.2 });
    expect(accounting.completeness).toBe('complete');
  });

  it('does NOT let a caller aggregate replace measured spend', async () => {
    // Reporting the whole run total ($0.95) as an external charge on top of a
    // measured $0.75 must not silently become $1.70 with no signal — the
    // external figure stays a separate, explicitly labeled line.
    const { runtime } = scriptedRuntime([{ cost: 0.75 }]);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    runtime.register(
      workflow({
        name: 'aggregate',
        input: z.any(),
        handler: async (ctx) => {
          await ctx.ask(asker, 'go');
          return ctx.withExternalOperation({ name: 'whole-run' }, async (report) => {
            report.setCost(0.95);
            return null;
          });
        },
      }),
    );

    const { accounting } = await runtime.trackOutcome(() => runtime.execute('aggregate', {}));
    expect(accounting.knownCost).toBeCloseTo(1.7, 10);
    // The split is what makes the overlap visible and correctable.
    expect(accounting.breakdown.generation).toBeCloseTo(0.75, 10);
    expect(accounting.breakdown.external).toBeCloseTo(0.95, 10);
  });

  it('records a known-free external operation as settled, not unknown', async () => {
    const runtime = new AxlRuntime();
    const { accounting } = await runtime.trackOutcome(() =>
      externalOperation({ name: 'free-tier' }, async (report) => {
        report.setCost(0);
        return null;
      }),
    );
    expect(accounting.knownCost).toBe(0);
    expect(accounting.completeness).toBe('complete');
    expect(accounting.operations.settled).toBe(1);
  });

  it('treats silence as unknown, never as free', async () => {
    const runtime = new AxlRuntime();
    const { accounting } = await runtime.trackOutcome(() =>
      externalOperation({ name: 'unreported' }, async () => 'done'),
    );
    expect(accounting.knownCost).toBe(0);
    expect(accounting.completeness).toBe('incomplete');
    expect(accounting.reasons).toEqual({ external_unreported: 1 });
  });

  it('keeps a cost reported before a later throw', async () => {
    const runtime = new AxlRuntime();
    const boom = new Error('failed after paying');
    const outcome = await runtime.trackOutcome(() =>
      externalOperation({ name: 'paid-then-failed' }, async (report) => {
        report.setCost(0.3);
        throw boom;
      }),
    );
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.error).toBe(boom);
    expect(outcome.accounting.knownCost).toBeCloseTo(0.3, 10);
    expect(outcome.accounting.completeness).toBe('complete');
  });

  it('records usage the caller declares alongside the charge', async () => {
    const runtime = new AxlRuntime();
    const { accounting } = await runtime.trackOutcome(() =>
      externalOperation({ name: 'with-usage' }, async (report) => {
        report.setCost(0.1, { inputTokens: 12, audioSeconds: 3 });
        return null;
      }),
    );
    expect(accounting.usage.inputTokens).toBe(12);
    expect(accounting.usage.audioSeconds).toBe(3);
    expect(accounting.usage.outputTokens).toBe(0);
  });
});

describe('an invalid report cannot shrink or poison a total', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -5],
  ])('rejects a %s amount and leaves the operation unreported', async (_label, amount) => {
    const runtime = new AxlRuntime();
    let thrown: unknown;
    const { accounting } = await runtime.trackOutcome(() =>
      externalOperation({ name: 'bad-report' }, async (report) => {
        try {
          report.setCost(amount);
        } catch (error) {
          thrown = error;
        }
        return null;
      }),
    );

    expect(thrown).toBeInstanceOf(AxlError);
    expect((thrown as AxlError).code).toBe('INVALID_COST_REPORT');
    expect(accounting.knownCost).toBe(0);
    expect(Number.isFinite(accounting.knownCost)).toBe(true);
    // Rejected outright, so the operation is still unreported — not free.
    expect(accounting.reasons).toEqual({ external_unreported: 1 });
  });

  it('rejects a second setCost rather than double-charging', async () => {
    const runtime = new AxlRuntime();
    let thrown: unknown;
    const { accounting } = await runtime.trackOutcome(() =>
      externalOperation({ name: 'twice' }, async (report) => {
        report.setCost(0.25);
        try {
          report.setCost(0.25);
        } catch (error) {
          thrown = error;
        }
        return null;
      }),
    );
    expect((thrown as AxlError).code).toBe('INVALID_COST_REPORT');
    expect(accounting.knownCost).toBeCloseTo(0.25, 10);
  });

  it('does not double-count a nested Axl call the caller also reported', async () => {
    // The nested ask accounts for itself; the caller's disjoint declaration is
    // its own operation. Both are visible and separately attributed.
    const { runtime } = scriptedRuntime([{ cost: 0.5 }]);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    runtime.register(
      workflow({
        name: 'nested',
        input: z.any(),
        handler: async (ctx) =>
          ctx.withExternalOperation({ name: 'wrapper' }, async (report) => {
            await ctx.ask(asker, 'go');
            report.setCost(0.1);
            return null;
          }),
      }),
    );

    const { accounting } = await runtime.trackOutcome(() => runtime.execute('nested', {}));
    expect(accounting.knownCost).toBeCloseTo(0.6, 10);
    expect(accounting.operations.byKind).toEqual({ external: 1, chat: 1 });
    expect(accounting.breakdown.generation).toBeCloseTo(0.5, 10);
    expect(accounting.breakdown.external).toBeCloseTo(0.1, 10);
  });
});

describe('external operations respect admission', () => {
  it('refuses to run the callback once the budget has closed', async () => {
    const admission = new AdmissionController({ limit: 0 });
    const runtime = new AxlRuntime();
    let ran = false;

    const outcome = await runtime.trackOutcome(
      () =>
        externalOperation({ name: 'vendor' }, async () => {
          ran = true;
          return null;
        }),
      { admission },
    );

    expect(ran).toBe(false);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.error).toBeInstanceOf(AdmissionDeniedError);
      expect((outcome.error as AdmissionDeniedError).operation.kind).toBe('external');
    }
    expect(outcome.accounting.operations.denied).toBe(1);
    expect(outcome.accounting.knownCost).toBe(0);
  });

  it('runs with a validating no-op report outside any accounting scope', async () => {
    let ran = false;
    let thrown: unknown;
    const value = await externalOperation({ name: 'unscoped' }, async (report) => {
      ran = true;
      // Still validates, so a caller finds its bugs with or without a scope.
      try {
        report.setCost(Number.NaN);
      } catch (error) {
        thrown = error;
      }
      report.setCost(1);
      return 'returned';
    });

    expect(ran).toBe(true);
    expect(value).toBe('returned');
    expect((thrown as AxlError).code).toBe('INVALID_COST_REPORT');
  });
});
