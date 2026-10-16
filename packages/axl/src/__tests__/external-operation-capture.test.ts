/** Public external-operation journal boundary (P3, T09/T10). */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AxlRuntime } from '../runtime.js';
import { AdmissionController, externalOperation } from '../accounting.js';
import { workflow } from '../workflow.js';
import { CollectingSink, channelWith, phase } from './request-capture-helpers.js';

describe('external-operation request journal', () => {
  it('captures ctx.withExternalOperation with merged payload snapshots and disjoint charge', async () => {
    const runtime = new AxlRuntime();
    const request = { query: { text: 'original' } };
    const response = { rows: [{ value: 'original' }] };
    runtime.register(
      workflow({
        name: 'external-workflow',
        input: z.any(),
        handler: (ctx) =>
          ctx.withExternalOperation({ name: 'vendor-search' }, async (report) => {
            report.capture({ request });
            report.capture({ response });
            report.setCost(0.2, { inputTokens: 7 });
            request.query.text = 'mutated';
            response.rows[0].value = 'mutated';
            return 'rows';
          }),
      }),
    );
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const outcome = await runtime.trackOutcome(() => runtime.execute('external-workflow', {}), {
      capture: channel,
    });
    await channel.close();

    expect(outcome.status).toBe('fulfilled');
    expect(outcome.accounting.knownCost).toBe(0.2);
    expect(outcome.accounting.breakdown.external).toBe(0.2);
    const [start] = phase(sink.records(), 'start');
    const [end] = phase(sink.records(), 'end');
    expect(start).toMatchObject({ kind: 'external', name: 'vendor-search' });
    expect(start).not.toHaveProperty('provider');
    expect(start).not.toHaveProperty('model');
    expect(end).toMatchObject({
      kind: 'external',
      name: 'vendor-search',
      outcomeStatus: 'ok',
      external: {
        request: { query: { text: 'original' } },
        response: { rows: [{ value: 'original' }] },
      },
      cost: 0.2,
      costProvenance: 'caller_reported',
      usage: { inputTokens: 7 },
    });
    expect(start.startedAt).toMatch(/^\d{4}-/);
    expect(end.endedAt).toMatch(/^\d{4}-/);
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
    expect(channel.operations()).toMatchObject([
      { operationId: start.operationId, kind: 'external', status: 'recorded' },
    ]);
  });

  it('keeps reported cost on the original throw and leaves unreported cost absent', async () => {
    const runtime = new AxlRuntime();
    const boom = new Error('vendor failed');
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const failed = await runtime.trackOutcome(
      () =>
        externalOperation({ name: 'paid-error' }, async (report) => {
          report.setCost(0.3);
          throw boom;
        }),
      { capture: channel },
    );
    const unknown = await runtime.trackOutcome(
      () => externalOperation({ name: 'unreported' }, async () => 'done'),
      { capture: channel },
    );
    await channel.close();

    expect(failed.status).toBe('rejected');
    if (failed.status === 'rejected') expect(failed.error).toBe(boom);
    expect(failed.accounting.knownCost).toBe(0.3);
    expect(unknown.accounting.completeness).toBe('incomplete');
    expect(unknown.accounting.reasons).toMatchObject({ external_unreported: 1 });
    const ends = phase(sink.records(), 'end');
    expect(ends[0]).toMatchObject({
      outcomeStatus: 'error',
      cost: 0.3,
      costProvenance: 'caller_reported',
      error: { name: 'Error', message: 'vendor failed' },
    });
    expect(ends[1]).toMatchObject({ outcomeStatus: 'ok', name: 'unreported' });
    expect(ends[1]).not.toHaveProperty('cost');
    expect(ends[1]).not.toHaveProperty('usage');
  });

  it('writes no record for admission denial, and capture outside a scope is a safe no-op', async () => {
    const runtime = new AxlRuntime();
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const denied = await runtime.trackOutcome(
      () =>
        externalOperation({ name: 'denied' }, async (report) => {
          report.capture({ request: { secret: 'never called' } });
          return 1;
        }),
      { capture: channel, admission: new AdmissionController({ limit: 0 }) },
    );
    await channel.close();
    expect(denied.status).toBe('rejected');
    expect(sink.records()).toEqual([]);
    expect(channel.operations()).toEqual([]);
    const outside = await externalOperation({ name: 'outside' }, async (report) => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      report.capture({ request: cyclic });
      return 42;
    });
    expect(outside).toBe(42);
  });

  it.each(['cycle', 'getter', 'non-json'] as const)(
    '%s payload cannot fail or corrupt a paid operation',
    async (kind) => {
      const runtime = new AxlRuntime();
      const sink = new CollectingSink();
      const channel = channelWith(sink);
      const outcome = await runtime.trackOutcome(
        () =>
          externalOperation({ name: kind }, async (report) => {
            let payload: unknown;
            if (kind === 'cycle') {
              const cyclic: Record<string, unknown> = {};
              cyclic.self = cyclic;
              payload = cyclic;
            } else if (kind === 'getter') {
              payload = Object.defineProperty({}, 'secret', {
                enumerable: true,
                get() {
                  const error = new Error('private getter value');
                  error.name = 'private getter class';
                  throw error;
                },
              });
            } else payload = { bad: Number.NaN };
            report.capture({ request: payload });
            report.setCost(0.05, { inputTokens: 2 });
            return 'same result';
          }),
        { capture: channel },
      );
      await channel.close();
      expect(outcome.status).toBe('fulfilled');
      if (outcome.status === 'fulfilled') expect(outcome.value).toBe('same result');
      expect(outcome.accounting.knownCost).toBe(0.05);
      const end = phase(sink.records(), 'end')[0];
      expect(end).toMatchObject({
        name: kind,
        outcomeStatus: 'ok',
        cost: 0.05,
        usage: { inputTokens: 2 },
        captured: { truncated: true, omitted: ['record'] },
      });
      expect(JSON.stringify(sink.records())).not.toContain('private getter value');
      expect(JSON.stringify(sink.records())).not.toContain('private getter class');
      expect(channel.operations()[0].status).toBe('omitted');
    },
  );

  it('retains settlement on oversized payload stubs and redacts caller payloads', async () => {
    const runtime = new AxlRuntime();
    const hugeSink = new CollectingSink();
    const hugeChannel = channelWith(hugeSink, { maxRecordBytes: 1024 });
    await runtime.trackOutcome(
      () =>
        externalOperation({ name: 'large' }, async (report) => {
          report.capture({ response: { text: 'é'.repeat(2000) } });
          report.setCost(0.08, { outputTokens: 3 });
          return true;
        }),
      { capture: hugeChannel },
    );
    await hugeChannel.close();
    const largeEnd = phase(hugeSink.records(), 'end')[0];
    expect(largeEnd).toMatchObject({
      kind: 'external',
      name: 'large',
      outcomeStatus: 'ok',
      cost: 0.08,
      usage: { outputTokens: 3 },
      captured: { truncated: true, omitted: ['record'] },
    });
    expect(largeEnd.external).toBeUndefined();
    expect(hugeChannel.operations()[0].status).toBe('truncated');

    const secret = 'private external payload';
    const redactedSink = new CollectingSink();
    const redactedChannel = channelWith(redactedSink, { redact: true });
    await runtime.trackOutcome(
      () =>
        externalOperation({ name: 'redacted' }, async (report) => {
          report.capture({ request: { prompt: secret }, response: [secret] });
          report.setCost(0);
          return true;
        }),
      { capture: redactedChannel },
    );
    await redactedChannel.close();
    expect(redactedSink.lines.join('\n')).not.toContain(secret);
    expect(phase(redactedSink.records(), 'end')[0]).toMatchObject({
      cost: 0,
      external: { request: '[redacted]', response: '[redacted]' },
      captured: { redacted: true },
    });
  });

  it('never writes a stub larger than the per-record bound when the operation name itself is huge', async () => {
    const runtime = new AxlRuntime();
    const sink = new CollectingSink();
    const channel = channelWith(sink, { maxRecordBytes: 1024 });
    const outcome = await runtime.trackOutcome(
      () =>
        externalOperation({ name: 'n'.repeat(2000) }, async (report) => {
          report.setCost(0.09);
          return 'paid';
        }),
      { capture: channel },
    );
    const status = await channel.close();
    expect(outcome.status).toBe('fulfilled');
    expect(outcome.accounting.knownCost).toBe(0.09);
    expect(status.status).toBe('truncated');
    expect(sink.lines.every((line) => Buffer.byteLength(line, 'utf-8') <= 1024)).toBe(true);
  });

  it('does not let a payload getter throwing a revoked proxy interrupt setCost or return', async () => {
    const runtime = new AxlRuntime();
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const payload = Object.defineProperty({}, 'bad', {
      enumerable: true,
      get() {
        throw revoked.proxy;
      },
    });
    const outcome = await runtime.trackOutcome(
      () =>
        externalOperation({ name: 'hostile-payload' }, async (report) => {
          report.capture({ request: payload });
          report.setCost(0.12);
          return 'original result';
        }),
      { capture: channel },
    );
    await channel.close();
    expect(outcome.status).toBe('fulfilled');
    if (outcome.status === 'fulfilled') expect(outcome.value).toBe('original result');
    expect(outcome.accounting.knownCost).toBe(0.12);
    expect(phase(sink.records(), 'end')[0]).toMatchObject({
      outcomeStatus: 'ok',
      cost: 0.12,
      captured: { truncated: true, omitted: ['record'] },
    });
  });

  it('does not replace the original throw when error projection throws a revoked proxy', async () => {
    const runtime = new AxlRuntime();
    const sink = new CollectingSink();
    const channel = channelWith(sink);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const original = new Error('original operation error');
    Object.defineProperty(original, 'message', {
      get() {
        throw revoked.proxy;
      },
    });
    const outcome = await runtime.trackOutcome(
      () =>
        externalOperation({ name: 'hostile-error' }, async (report) => {
          report.setCost(0.13);
          throw original;
        }),
      { capture: channel },
    );
    await channel.close();
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.error).toBe(original);
    expect(outcome.accounting.knownCost).toBe(0.13);
    expect(phase(sink.records(), 'end')[0]).toMatchObject({
      outcomeStatus: 'error',
      cost: 0.13,
      captured: { truncated: true, omitted: ['record'] },
    });
  });
});
