/**
 * Structured item failure cause (adaptive-rate-governance AC7, AC8; matrix
 * E-07a…e, E-08).
 *
 * A `ProviderError`'s provider, status and request id used to be discarded when
 * a failed item was flattened to `error: string`, so a run thinned by a
 * rate-limit storm read the same as one broken by a bug. These cases pin that
 * the cause survives — through the real runtime path and through `cause`
 * chains — and that the provider's raw `body` never reaches the artifact.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ProviderError } from '@axlsdk/axl';

import { dataset } from '../dataset.js';
import { scorer } from '../scorer.js';
import { runEval, describeItemFailure } from '../runner.js';
import { rescore } from '../rescore.js';
import { formatCoverageLine, formatFailureCauses } from '../cli-format.js';
import type { EvalConfig, EvalItem, EvalResult } from '../types.js';
import { askExecute, scriptedRuntime } from './accounting-helpers.js';

/** Stands in for a provider body that echoes prompt text. */
const SENTINEL = 'SENSITIVE-PROMPT-ECHO-7f3a';

const pass = scorer({ name: 'pass', description: 'always 1', score: () => 1 });

function config(n: number, extra?: Partial<EvalConfig>): EvalConfig {
  return {
    workflow: 'w',
    dataset: dataset({
      name: `ds-${n}`,
      schema: z.object({ i: z.number() }),
      items: Array.from({ length: n }, (_, i) => ({ input: { i } })),
    }) as EvalConfig['dataset'],
    scorers: [pass] as EvalConfig['scorers'],
    concurrency: 1,
    failOnItemErrorRate: 1,
    ...extra,
  };
}

function rateLimited(overrides?: Partial<ConstructorParameters<typeof ProviderError>[0]>) {
  return new ProviderError({
    provider: 'openai',
    status: 429,
    retryable: true,
    requestId: 'req_1',
    message: 'Rate limit reached',
    body: JSON.stringify({ error: { message: SENTINEL } }),
    ...overrides,
  });
}

/** Run one item whose workflow throws `thrown`. */
async function failWith(thrown: unknown): Promise<EvalItem> {
  const { runtime } = scriptedRuntime([{ cost: 0 }]);
  const result = await runEval(
    config(1),
    async () => {
      throw thrown;
    },
    runtime,
  );
  return result.items[0];
}

const sortedKeys = (o: object) => Object.keys(o).sort();

describe('item.failure capture', () => {
  // E-07a + E-07e: through the real runtime path (ctx.ask → provider throws),
  // with trace capture on, the artifact carries the cause and never the body.
  it('records a provider 429 raised through ctx.ask, and the body appears nowhere', async () => {
    const { runtime } = scriptedRuntime([{ throws: rateLimited() }]);
    const result = await runEval(config(1), askExecute(), runtime, { captureTraces: true });
    const item = result.items[0];

    expect(item.outcome).toBe('failed');
    expect(item.failure).toEqual({
      name: 'ProviderError',
      provider: 'openai',
      status: 429,
      retryable: true,
      requestId: 'req_1',
    });
    // Exact key set: nothing copied wholesale from the error.
    expect(sortedKeys(item.failure!)).toEqual([
      'name',
      'provider',
      'requestId',
      'retryable',
      'status',
    ]);
    // The trace path still reports the status (so the traces were captured)…
    const callEnd = item.traces?.find((e) => e.type === 'agent_call_end');
    expect(JSON.stringify(callEnd)).toContain('429');
    // …and neither the traces, the failure, the error string nor any other
    // field of the persisted artifact carries the provider body.
    expect(item.error).not.toContain(SENTINEL);
    expect(JSON.stringify(result, null, 2)).not.toContain(SENTINEL);
  });

  it('records a ProviderError thrown directly by the workflow', async () => {
    const item = await failWith(rateLimited({ requestId: 'req_direct' }));
    expect(item.failure).toEqual({
      name: 'ProviderError',
      provider: 'openai',
      status: 429,
      retryable: true,
      requestId: 'req_direct',
    });
    expect(JSON.stringify(item)).not.toContain(SENTINEL);
  });

  it('omits optional fields the ProviderError did not carry', async () => {
    const item = await failWith(
      new ProviderError({ provider: 'google', status: 0, retryable: true, message: 'ECONNRESET' }),
    );
    expect(item.failure).toEqual({
      name: 'ProviderError',
      provider: 'google',
      status: 0,
      retryable: true,
    });
    expect('requestId' in item.failure!).toBe(false);
  });

  // E-07b / Q4: found down a cause chain → every field from the ProviderError.
  it('finds a ProviderError down a cause chain and takes every field from it', async () => {
    const thrown = new Error('wrapped', {
      cause: new TypeError('mid', { cause: rateLimited({ requestId: 'inner' }) }),
    });
    const item = await failWith(thrown);
    expect(item.failure).toEqual({
      name: 'ProviderError',
      provider: 'openai',
      status: 429,
      retryable: true,
      requestId: 'inner',
    });
    expect(item.error).toBe('wrapped');
  });

  // E-07c: the FIRST ProviderError from the thrown value down, not the deepest.
  it('takes the first ProviderError in the chain, not the deepest or the first 429', async () => {
    const outer = new ProviderError({
      provider: 'anthropic',
      status: 500,
      retryable: true,
      requestId: 'outer',
      message: 'upstream',
    });
    Object.defineProperty(outer, 'cause', { value: rateLimited({ requestId: 'inner' }) });
    const item = await failWith(outer);
    expect(item.failure).toMatchObject({ provider: 'anthropic', status: 500, requestId: 'outer' });
  });

  // E-07d: no ProviderError → only the top-level name, no stray keys.
  it('records only the thrown name for a plain error', async () => {
    const item = await failWith(new RangeError('boom'));
    expect(item.failure).toEqual({ name: 'RangeError' });
    expect(sortedKeys(item.failure!)).toEqual(['name']);
  });

  it('records no failure for a thrown value without a name', async () => {
    const item = await failWith('a bare string');
    expect(item.outcome).toBe('failed');
    expect('failure' in item).toBe(false);
  });

  // A second copy of @axlsdk/axl (dual ESM+CJS) throws a ProviderError that is
  // not `instanceof` this copy's class; the code/name pair still identifies it.
  it('recognizes a ProviderError from another copy of the package, and drops its body', async () => {
    const foreign = Object.assign(new Error('Rate limit reached'), {
      name: 'ProviderError',
      code: 'PROVIDER_ERROR',
      provider: 'openai',
      status: 429,
      retryable: true,
      requestId: 'req_foreign',
      body: SENTINEL,
      retryAfterMs: 2000,
    });
    const item = await failWith(foreign);
    expect(item.failure).toEqual({
      name: 'ProviderError',
      provider: 'openai',
      status: 429,
      retryable: true,
      requestId: 'req_foreign',
    });
    expect(JSON.stringify(item)).not.toContain(SENTINEL);
  });

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.defineProperty(a, 'cause', { value: b });
    expect(describeItemFailure(a)).toEqual({ name: 'Error' });
  });

  it('stops walking an unbounded cause chain instead of scanning it all', () => {
    // A ProviderError buried under a thousand wrappers is not a cause anyone
    // can act on; the walk must give up rather than run the whole chain.
    let chain: unknown = rateLimited();
    for (let i = 0; i < 1000; i++) chain = new Error(`wrap ${i}`, { cause: chain });
    expect(describeItemFailure(chain)).toEqual({ name: 'Error' });
  });

  it('attaches no failure to cancelled or budget-stopped items', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runtime } = scriptedRuntime([{ cost: 0 }]);
    const cancelled = await runEval(config(2), askExecute(), runtime, {
      signal: controller.signal,
    });
    expect(cancelled.items.map((i) => i.outcome)).toEqual(['cancelled', 'cancelled']);
    expect(cancelled.items.some((i) => 'failure' in i)).toBe(false);

    const { runtime: paid } = scriptedRuntime([{ cost: 0.5 }]);
    const stopped = await runEval(config(4, { budget: '$1' }), askExecute(), paid);
    expect(stopped.items.some((i) => i.outcome === 'budget_skipped')).toBe(true);
    expect(stopped.items.some((i) => 'failure' in i)).toBe(false);
  });

  it('carries the failure through a rescore with the rest of the source outcome', async () => {
    const { runtime } = scriptedRuntime([{ throws: rateLimited() }, { cost: 0 }]);
    const source = await runEval(config(2), askExecute(), runtime);
    expect(source.items[0].failure?.status).toBe(429);

    const rescored = await rescore(source, [pass], runtime);
    expect(rescored.items[0]).toMatchObject({
      outcome: 'failed',
      failure: { name: 'ProviderError', status: 429, requestId: 'req_1' },
    });
    expect('failure' in rescored.items[1]).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC8 — the CLI groups failures by cause
// ═══════════════════════════════════════════════════════════════════════════

function resultWithFailures(failures: (EvalItem['failure'] | undefined)[]): EvalResult {
  const items: EvalItem[] = [
    ...failures.map(
      (failure): EvalItem => ({
        input: null,
        output: null,
        error: 'x',
        outcome: 'failed',
        scores: {},
        ...(failure ? { failure } : {}),
      }),
    ),
    { input: null, output: 'ok', outcome: 'completed', scores: {} },
  ];
  return {
    id: 'r',
    dataset: 'ds',
    metadata: {},
    timestamp: '2026-09-22T00:00:00.000Z',
    totalCost: 0,
    duration: 0,
    items,
    summary: {
      count: items.length,
      failures: failures.length,
      coverage: {
        items: {
          completed: 1,
          failed: failures.length,
          cancelled: 0,
          budget_skipped: 0,
          budget_interrupted: 0,
        },
        scorers: {},
      },
      scorers: {},
    },
  };
}

describe('formatFailureCauses (AC8)', () => {
  const pe = (status: number, provider = 'openai') => ({
    name: 'ProviderError',
    provider,
    status,
    retryable: true,
  });

  // E-08: 5 × 429, 3 × 503, 2 × network, 2 × plain Error.
  it('groups by status and provider, most frequent first, summing to the failed count', () => {
    const result = resultWithFailures([
      ...Array.from({ length: 5 }, () => pe(429)),
      ...Array.from({ length: 3 }, () => pe(503, 'anthropic')),
      pe(0),
      pe(0),
      { name: 'Error' },
      undefined,
    ]);

    expect(formatFailureCauses(result)).toBe(
      '  Failure causes: 5 × 429 (openai), 3 × 503 (anthropic), 2 × network (openai), 2 × other',
    );
  });

  it('keeps the same status from different providers apart', () => {
    const result = resultWithFailures([pe(429), pe(429, 'anthropic'), pe(429, 'anthropic')]);
    expect(formatFailureCauses(result)).toBe(
      '  Failure causes: 2 × 429 (anthropic), 1 × 429 (openai)',
    );
  });

  it('prints the breakdown on the line under the coverage counts', () => {
    const lines = formatCoverageLine(resultWithFailures([pe(429), { name: 'Error' }]))!.split('\n');
    expect(lines).toEqual([
      '  Items: 1 completed, 2 failed',
      '  Failure causes: 1 × 429 (openai), 1 × other',
    ]);
  });

  it('prints nothing when no item failed', () => {
    expect(formatFailureCauses(resultWithFailures([]))).toBeUndefined();
  });
});
