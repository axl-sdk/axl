/**
 * Accounting invariants (plan A1–A4, A9).
 *
 * These assert the PUBLIC accounting record — never internal helpers — because
 * the whole point of the rail is that consumers can trust these numbers under
 * every trace configuration and every terminal outcome.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { AxlError } from '../errors.js';
import type { Accounting } from '../accounting.js';
import {
  deferred,
  registerAskWorkflow,
  scriptedRuntime,
  ScriptedProvider,
} from './accounting-helpers.js';

/**
 * The structural identity every finalized scope must satisfy: denied work is
 * disjoint from opened work, and every opened operation reached exactly one
 * terminal bucket.
 */
function expectOperationIdentity(accounting: Accounting): void {
  expect(accounting.operations.total).toBe(
    accounting.operations.settled + accounting.operations.unknown,
  );
  const byKind = Object.values(accounting.operations.byKind).reduce((a, b) => a + b, 0);
  expect(byKind).toBe(accounting.operations.total);
  const provenanceTotal = Object.values(accounting.provenance).reduce((a, b) => a + b, 0);
  expect(provenanceTotal).toBeCloseTo(accounting.knownCost, 10);
  const breakdownTotal =
    accounting.breakdown.generation + accounting.breakdown.judging + accounting.breakdown.external;
  expect(breakdownTotal).toBeCloseTo(accounting.knownCost, 10);
}

// ═══════════════════════════════════════════════════════════════════════════
// I1 — one authoritative path, independent of tracing and terminal outcome
// ═══════════════════════════════════════════════════════════════════════════

describe('I1: accounting is independent of tracing and of how the workflow ended', () => {
  /** Two $0.75 calls; the second is followed by a throw. */
  async function runTwoCallsThenThrow(config: Record<string, unknown>) {
    const provider = new ScriptedProvider([{ cost: 0.75 }, { cost: 0.75 }]);
    const runtime = new AxlRuntime({ defaultProvider: 'scripted', ...config });
    runtime.registerProvider('scripted', provider);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    runtime.register(
      workflow({
        name: 'two-then-throw',
        input: z.any(),
        handler: async (ctx) => {
          await ctx.ask(asker, 'one');
          await ctx.ask(asker, 'two');
          throw new Error('after the money was spent');
        },
      }),
    );
    return runtime.trackOutcome(() => runtime.execute('two-then-throw', {}), {
      captureTraces: config.captureTraces === true,
    });
  }

  it('reports $1.50 identically under trace off / steps / full, capture on and off', async () => {
    const variants = [
      { trace: false },
      { trace: { level: 'steps' as const } },
      { trace: { level: 'full' as const } },
      { trace: { level: 'full' as const, redact: true }, captureTraces: true },
    ];

    const results: Accounting[] = [];
    for (const variant of variants) {
      const outcome = await runTwoCallsThenThrow(variant);
      expect(outcome.status).toBe('rejected');
      results.push(outcome.accounting);
    }

    for (const accounting of results) {
      expect(accounting.knownCost).toBeCloseTo(1.5, 10);
      expect(accounting.completeness).toBe('complete');
      expect(accounting.operations.total).toBe(2);
      expect(accounting.operations.settled).toBe(2);
      expectOperationIdentity(accounting);
    }
    // Byte-identical across every trace configuration, not merely equal totals.
    expect(results.map((a) => JSON.stringify(a))).toEqual(
      results.map(() => JSON.stringify(results[0])),
    );
  });

  it('keeps the charge from a call that preceded the throw', async () => {
    const outcome = await runTwoCallsThenThrow({ trace: false });
    expect(outcome.status).toBe('rejected');
    // The trace-only rail used to lose this entirely.
    expect(outcome.accounting.knownCost).toBeCloseTo(1.5, 10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I2 — no double charge
// ═══════════════════════════════════════════════════════════════════════════

describe('I2: an operation is counted once per scope', () => {
  it('counts a nested trackOutcome once in the parent, not twice', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.25 }]);
    registerAskWorkflow(runtime);

    const outer = await runtime.trackOutcome(async () => {
      const inner = await runtime.trackOutcome(() => runtime.execute('ask', {}));
      expect(inner.accounting.knownCost).toBeCloseTo(0.25, 10);
      expect(inner.accounting.operations.total).toBe(1);
      return inner.accounting.knownCost;
    });

    expect(outer.accounting.knownCost).toBeCloseTo(0.25, 10);
    expect(outer.accounting.operations.total).toBe(1);
    expectOperationIdentity(outer.accounting);
  });

  it('counts nested trackExecution once, through the compatibility wrapper', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.25 }]);
    registerAskWorkflow(runtime);

    const { accounting, cost } = await runtime.trackExecution(async () => {
      await runtime.trackExecution(() => runtime.execute('ask', {}));
    });
    expect(cost).toBeCloseTo(0.25, 10);
    expect(accounting.operations.total).toBe(1);
  });

  it('sums disjoint operations: two asks, a tool attempt and an embedding', async () => {
    const { runtime } = scriptedRuntime([
      {
        cost: 0.4,
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
      },
      { cost: 0.6 },
    ]);
    const noop = tool({
      name: 'noop',
      description: 'does nothing',
      input: z.object({}),
      handler: async () => 'done',
    });
    const asker = agent({ name: 'a', model: 'scripted:m', tools: [noop] });
    runtime.register(
      workflow({
        name: 'tooled',
        input: z.any(),
        handler: async (ctx) => ctx.ask(asker, 'go'),
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('tooled', {}));
    expect(outcome.status).toBe('fulfilled');
    // Two chat turns at $0.40 + $0.60; the tool attempt is a known $0.
    expect(outcome.accounting.knownCost).toBeCloseTo(1.0, 10);
    expect(outcome.accounting.operations.byKind.chat).toBe(2);
    expect(outcome.accounting.operations.byKind.tool).toBe(1);
    expect(outcome.accounting.completeness).toBe('complete');
    expectOperationIdentity(outcome.accounting);
  });

  it('counts a schema-repair retry turn as its own operation, once', async () => {
    const { runtime } = scriptedRuntime([
      { content: 'not json', cost: 0.1 },
      { content: '{"answer":"ok"}', cost: 0.1 },
    ]);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    runtime.register(
      workflow({
        name: 'repaired',
        input: z.any(),
        handler: async (ctx) =>
          ctx.ask(asker, 'go', { schema: z.object({ answer: z.string() }), retries: 1 }),
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('repaired', {}));
    expect(outcome.status).toBe('fulfilled');
    expect(outcome.accounting.operations.byKind.chat).toBe(2);
    expect(outcome.accounting.knownCost).toBeCloseTo(0.2, 10);
  });

  it('accounts a stream exactly once, on its done chunk', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.33 }]);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    runtime.register(
      workflow({ name: 'streamed', input: z.any(), handler: async (ctx) => ctx.ask(asker, 'go') }),
    );

    const outcome = await runtime.trackOutcome(async () => {
      const stream = runtime.stream('streamed', {});
      // Drain: the terminal is what settles the operation.
      for await (const _event of stream) void _event;
      return null;
    });
    expect(outcome.accounting.knownCost).toBeCloseTo(0.33, 10);
    expect(outcome.accounting.operations.total).toBe(1);
    expectOperationIdentity(outcome.accounting);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I3 — isolation between concurrent scopes
// ═══════════════════════════════════════════════════════════════════════════

describe('I3: concurrent scopes on one runtime never see each other', () => {
  it('keeps two concurrent trackOutcome scopes disjoint', async () => {
    const gateA = deferred();
    const gateB = deferred();
    const provider = new ScriptedProvider([{ cost: 1 }]);
    const runtime = new AxlRuntime({ defaultProvider: 'scripted' });
    runtime.registerProvider('scripted', provider);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    runtime.register(
      workflow({
        name: 'gated',
        input: z.any(),
        handler: async (ctx) => {
          const gate = ctx.input as { gate: Promise<void> };
          await gate.gate;
          return ctx.ask(asker, 'go');
        },
      }),
    );

    // Both scopes are open at once; each resolves its own gate.
    const first = runtime.trackOutcome(() => runtime.execute('gated', { gate: gateA.promise }));
    const second = runtime.trackOutcome(() => runtime.execute('gated', { gate: gateB.promise }));
    gateA.resolve();
    gateB.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(a.accounting.knownCost).toBeCloseTo(1, 10);
    expect(b.accounting.knownCost).toBeCloseTo(1, 10);
    expect(a.accounting.operations.total).toBe(1);
    expect(b.accounting.operations.total).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I4 — zero is not unknown
// ═══════════════════════════════════════════════════════════════════════════

describe('I4: known zero, unknown price and unusable cost are distinct', () => {
  it('settles a known $0 as complete', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    registerAskWorkflow(runtime);
    const { accounting } = await runtime.trackOutcome(() => runtime.execute('ask', {}));
    expect(accounting.knownCost).toBe(0);
    expect(accounting.completeness).toBe('complete');
    expect(accounting.operations.settled).toBe(1);
    expect(accounting.reasons).toEqual({});
  });

  it('marks a missing cost with reported usage `unpriced_model`', async () => {
    const { runtime } = scriptedRuntime([{ cost: undefined }]);
    registerAskWorkflow(runtime);
    const { accounting } = await runtime.trackOutcome(() => runtime.execute('ask', {}));
    expect(accounting.knownCost).toBe(0);
    expect(accounting.completeness).toBe('incomplete');
    expect(accounting.reasons).toEqual({ unpriced_model: 1 });
    expect(accounting.operations.unknown).toBe(1);
  });

  it.each([
    ['NaN', Number.NaN],
    ['negative', -1],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('never sums a %s cost — it is unpriced, not a charge', async (_label, cost) => {
    const { runtime } = scriptedRuntime([{ cost }]);
    registerAskWorkflow(runtime);
    const { accounting } = await runtime.trackOutcome(() => runtime.execute('ask', {}));
    expect(accounting.knownCost).toBe(0);
    expect(Number.isFinite(accounting.knownCost)).toBe(true);
    expect(accounting.completeness).toBe('incomplete');
    expect(accounting.reasons).toEqual({ unpriced_model: 1 });
  });

  it('marks a dispatched failure with no usage `usage_missing`', async () => {
    // A custom adapter that does not declare `reportsRequestLifecycle` cannot
    // prove it never dispatched, so its usage-less throw stays unknown.
    const { runtime } = scriptedRuntime([{ throws: new Error('upstream exploded') }]);
    registerAskWorkflow(runtime);
    const outcome = await runtime.trackOutcome(() => runtime.execute('ask', {}));
    expect(outcome.status).toBe('rejected');
    expect(outcome.accounting.completeness).toBe('incomplete');
    expect(outcome.accounting.reasons).toEqual({ usage_missing: 1 });
    expect(outcome.accounting.knownCost).toBe(0);
  });

  it('records a cost with no declared provenance as adapter_reported', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.5 }]);
    registerAskWorkflow(runtime);
    const { accounting } = await runtime.trackOutcome(() => runtime.execute('ask', {}));
    expect(accounting.provenance).toEqual({ adapter_reported: 0.5 });
  });

  it('keeps a vendor-reported figure separable from a table estimate', async () => {
    const provider = new ScriptedProvider([
      { cost: 0.2, costProvenance: 'provider_reported' },
      { cost: 0.3, costProvenance: 'price_table_estimate' },
    ]);
    const runtime = new AxlRuntime({ defaultProvider: 'scripted' });
    runtime.registerProvider('scripted', provider);
    const asker = agent({ name: 'a', model: 'scripted:m' });
    runtime.register(
      workflow({
        name: 'twice',
        input: z.any(),
        handler: async (ctx) => {
          await ctx.ask(asker, 'one');
          return ctx.ask(asker, 'two');
        },
      }),
    );
    const { accounting } = await runtime.trackOutcome(() => runtime.execute('twice', {}));
    expect(accounting.provenance).toEqual({
      provider_reported: 0.2,
      price_table_estimate: 0.3,
    });
    expect(accounting.knownCost).toBeCloseTo(0.5, 10);
  });

  it('folds usage into its own buckets without double-counting cached tokens', async () => {
    const { runtime } = scriptedRuntime([
      {
        cost: 0.1,
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          reasoning_tokens: 7,
          cached_tokens: 40,
          cache_write_tokens: 3,
        },
      },
    ]);
    registerAskWorkflow(runtime);
    const { accounting } = await runtime.trackOutcome(() => runtime.execute('ask', {}));
    // `inputTokens` is the provider's already-folded prompt count: cached
    // tokens live in their own bucket and are NOT re-added to it.
    expect(accounting.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 7,
      cachedTokens: 40,
      cacheWriteTokens: 3,
      audioSeconds: 0,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I5 — original error identity
// ═══════════════════════════════════════════════════════════════════════════

describe('I5: the thrown value comes back exactly as thrown', () => {
  const frozen = Object.freeze({ kind: 'frozen-failure' });
  const cases: Array<[string, unknown]> = [
    ['a string primitive', 'plain string failure'],
    ['a number primitive', 42],
    ['null', null],
    ['undefined', undefined],
    ['a frozen object', frozen],
    ['an AxlError', new AxlError('CUSTOM', 'custom failure')],
  ];

  it.each(cases)('trackOutcome returns %s identically', async (_label, thrown) => {
    const runtime = new AxlRuntime();
    const outcome = await runtime.trackOutcome(async () => {
      throw thrown;
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.error).toBe(thrown);
  });

  it.each(cases)(
    'trackExecution rethrows %s identically, even with captureTraces',
    async (_label, thrown) => {
      const runtime = new AxlRuntime();
      // `captureTraces` attaches a side channel to the thrown value; a frozen or
      // primitive throw must survive that attempt untouched rather than being
      // replaced by a TypeError about property definition.
      let caught: unknown;
      let didThrow = false;
      try {
        await runtime.trackExecution(
          async () => {
            throw thrown;
          },
          { captureTraces: true },
        );
      } catch (error) {
        didThrow = true;
        caught = error;
      }
      expect(didThrow).toBe(true);
      expect(caught).toBe(thrown);
    },
  );

  it('preserves a provider error thrown through the facade', async () => {
    const marker = Object.freeze(new AxlError('PROVIDER_MARKER', 'vendor said no'));
    const { runtime } = scriptedRuntime([{ throws: marker }]);
    registerAskWorkflow(runtime);
    const outcome = await runtime.trackOutcome(() => runtime.execute('ask', {}));
    expect(outcome.status).toBe('rejected');
    // The runtime wraps ask failures, but the original must remain reachable.
    const error = outcome.status === 'rejected' ? outcome.error : undefined;
    const chain: unknown[] = [];
    for (let cursor = error; cursor != null; cursor = (cursor as { cause?: unknown }).cause) {
      chain.push(cursor);
    }
    expect(chain).toContain(marker);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I9 — finalization never hangs on a late call
// ═══════════════════════════════════════════════════════════════════════════

describe('I9: an un-awaited operation is abandoned, not waited on', () => {
  it('finalizes without waiting and ignores the late settlement', async () => {
    const release = deferred();
    const provider: import('../providers/types.js').Provider = {
      name: 'slow',
      async chat() {
        await release.promise;
        return {
          content: 'late',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          cost: 5,
        };
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('unused');
      },
    };
    const runtime = new AxlRuntime({ defaultProvider: 'slow' });
    runtime.registerProvider('slow', provider);
    const asker = agent({ name: 'a', model: 'slow:m' });
    runtime.register(
      workflow({
        name: 'fire-and-forget',
        input: z.any(),
        handler: async (ctx) => {
          // Deliberately NOT awaited: the scope must finalize anyway.
          void ctx.ask(asker, 'go').catch(() => {});
          return 'returned early';
        },
      }),
    );

    const outcome = await runtime.trackOutcome(() => runtime.execute('fire-and-forget', {}));
    expect(outcome.status).toBe('fulfilled');
    expect(outcome.accounting.completeness).toBe('incomplete');
    expect(outcome.accounting.reasons).toEqual({ abandoned: 1 });
    const finalized = JSON.stringify(outcome.accounting);

    // The late $5 settlement must not rewrite a finalized total.
    release.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(JSON.stringify(outcome.accounting)).toBe(finalized);
    expect(outcome.accounting.knownCost).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I11 / I12 — compatibility and package boundary
// ═══════════════════════════════════════════════════════════════════════════

describe('I11: trackExecution keeps its contract', () => {
  it('reports unpriced whenever any operation lacked a usable cost', async () => {
    const { runtime } = scriptedRuntime([{ cost: undefined }]);
    registerAskWorkflow(runtime);
    const { cost, unpriced, accounting } = await runtime.trackExecution(() =>
      runtime.execute('ask', {}),
    );
    expect(unpriced).toBe(true);
    // `cost` is an honest lower bound, not a fabricated zero-cost success.
    expect(cost).toBe(0);
    expect(accounting.completeness).toBe('incomplete');
  });

  it('is not unpriced for a genuinely free call', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    registerAskWorkflow(runtime);
    const { cost, unpriced } = await runtime.trackExecution(() => runtime.execute('ask', {}));
    expect(unpriced).toBe(false);
    expect(cost).toBe(0);
  });

  it('still returns event-derived metadata alongside the accounting', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.4 }]);
    registerAskWorkflow(runtime);
    const { metadata, cost } = await runtime.trackExecution(() => runtime.execute('ask', {}), {
      captureTraces: true,
    });
    expect(cost).toBeCloseTo(0.4, 10);
    expect(metadata.agentCalls).toBe(1);
    expect(metadata.workflows).toEqual(['ask']);
  });

  it('trackCost still returns its historical shape', async () => {
    const { runtime } = scriptedRuntime([{ cost: 0.4 }]);
    registerAskWorkflow(runtime);
    const result = await runtime.trackCost(() => runtime.execute('ask', {}));
    expect(Object.keys(result).sort()).toEqual(['cost', 'result', 'unpriced']);
    expect(result.cost).toBeCloseTo(0.4, 10);
  });
});

describe('I12: the core package never depends on @axlsdk/eval', () => {
  it('has no static import of the eval package in any source file', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = dirname(dirname(fileURLToPath(import.meta.url)));

    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          await walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = await readFile(full, 'utf8');
        // `runtime.eval()` reaches the optional peer through a DYNAMIC import,
        // which is the only permitted form; a static import would make the
        // optional peer mandatory and invert the package dependency.
        if (/^\s*import[\s\S]*?from\s+'@axlsdk\/eval'/m.test(source)) offenders.push(full);
      }
    };
    await walk(root);
    expect(offenders).toEqual([]);
  });
});
