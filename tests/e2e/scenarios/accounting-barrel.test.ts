/**
 * Public-surface presence for the accounting + diagnostics rail (plan A16.14),
 * plus the two realm-safety guards from adversarial finding H2.
 *
 * These import from the PACKAGE ROOTS rather than by relative path. A
 * source-relative test passes happily while the barrel forgets to re-export a
 * value, which is invisible until a consumer installs the package — and a type
 * exported without its runtime value (or the reverse) is exactly that failure.
 */

import { describe, it, expect } from 'vitest';
import * as axl from '@axlsdk/axl';
import * as evalPkg from '@axlsdk/eval';

describe('A16.14 — the accounting and diagnostics surface is exported', () => {
  it.each([
    'AdmissionController',
    'AdmissionDeniedError',
    'isAdmissionDeniedError',
    'externalOperation',
    'FileDiagnosticArtifactStore',
    'RequestCaptureChannel',
    'redactCapturedRequest',
  ])('@axlsdk/axl exports %s as a value', (name) => {
    expect(axl).toHaveProperty(name);
    expect((axl as Record<string, unknown>)[name]).toBeDefined();
  });

  it.each(['DEFAULT_MAX_RECORD_BYTES', 'DEFAULT_MAX_RUN_BYTES', 'DEFAULT_MAX_QUEUE_BYTES'])(
    '@axlsdk/axl exports the %s bound so a caller can reason about limits',
    (name) => {
      expect(typeof (axl as Record<string, unknown>)[name]).toBe('number');
    },
  );

  it.each([
    'readAccounting',
    'aggregateAccounting',
    'validateRequestSidecar',
    'parseRequestRecords',
    'serializeRequestRecords',
  ])('@axlsdk/eval exports %s as a value', (name) => {
    expect(typeof (evalPkg as Record<string, unknown>)[name]).toBe('function');
  });

  it('the artifact store types are usable through the public constructor', async () => {
    // `DiagnosticArtifactStore` is type-only, so its presence can only be
    // proven by satisfying it. This assignment is the check.
    const store: axl.DiagnosticArtifactStore = new axl.FileDiagnosticArtifactStore({
      root: `${process.env.TMPDIR ?? '/tmp'}/axl-barrel-${Date.now()}`,
    });
    expect(typeof store.stage).toBe('function');
    expect(typeof store.commit).toBe('function');
    expect(typeof store.markDeletePending).toBe('function');
  });
});

/**
 * H2 — the dual-copy hazard.
 *
 * A dependent package can end up holding a SECOND copy of core (ESM alongside
 * CJS, most often via a dynamic `import('@axlsdk/eval')` from a CJS host).
 * Anything keyed on a module-private `Symbol()` or on `instanceof` silently
 * stops matching across those copies, and the failure mode is a run that spends
 * money without recording it.
 */
describe('H2 — cross-realm identity', () => {
  it('rejects an admission controller that is not one, by a named error', async () => {
    // Deliberately NOT `new AdmissionController(...)`: a foreign copy's
    // controller looks exactly like this — right shape, wrong provenance.
    const foreign = {
      limit: 1,
      spent: 0,
      beforeDispatch: () => {},
      isClosed: () => false,
    } as unknown as axl.AdmissionController;

    const runtime = new axl.AxlRuntime();
    // The settlement channel is a registry symbol, so a genuine controller from
    // any copy of core is accepted; only an object that carries no channel at
    // all — this one — is refused, and refused LOUDLY. Settling silently
    // against it would let a budgeted run spend without ever being charged.
    const outcome = await runtime.trackOutcome(
      async () =>
        axl.externalOperation({ name: 'paid' }, async (report) => {
          report.setCost(0.25);
          return 'done';
        }),
      { admission: foreign },
    );

    expect(outcome.status).toBe('rejected');
    expect(String(outcome.error)).toMatch(/INCOMPATIBLE_ADMISSION_CONTROLLER|settlement channel/i);
  });

  it('recognizes a denial error from another copy of core without instanceof', () => {
    // A plain object shaped like the error a foreign copy would throw.
    const foreign = Object.assign(new Error('Budget exhausted'), {
      name: 'AdmissionDeniedError',
      code: 'ADMISSION_DENIED',
    });

    // `instanceof` is false across copies; a budget-denied case must still be
    // classified as budget-denied rather than as a model failure.
    expect(foreign instanceof axl.AdmissionDeniedError).toBe(false);
    expect(axl.isAdmissionDeniedError(foreign)).toBe(true);
  });

  it('does not mistake an unrelated error for a denial', () => {
    expect(axl.isAdmissionDeniedError(new Error('nope'))).toBe(false);
    expect(axl.isAdmissionDeniedError({ code: 'ADMISSION_DENIED' })).toBe(false);
    expect(axl.isAdmissionDeniedError(undefined)).toBe(false);
  });

  it('accepts a genuine controller through the registry symbol', async () => {
    const runtime = new axl.AxlRuntime();
    const controller = new axl.AdmissionController({ limit: 1 });

    const outcome = await runtime.trackOutcome(
      async () =>
        axl.externalOperation({ name: 'paid' }, async (report) => {
          report.setCost(0.25);
          return 'done';
        }),
      { admission: controller },
    );

    // The positive half: the guard must not reject the real thing, and the
    // spend must actually reach the controller.
    expect(outcome.status).toBe('fulfilled');
    expect(controller.knownSpend).toBeCloseTo(0.25, 10);
  });
});
