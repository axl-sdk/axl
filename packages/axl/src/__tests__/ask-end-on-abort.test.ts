import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { workflow } from '../workflow.js';
import { AxlRuntime } from '../runtime.js';
import type { AxlEvent } from '../types.js';

/**
 * Spec/16 decision 9 invariant: every `ask_start` has a matching
 * `ask_end`. Tests the abort path specifically — the bug-hunt review
 * raised concern that AbortError propagating out of executeAgentCall
 * would bypass the ask_end emit.
 *
 * The catch block in `ctx.ask()` (`context.ts:524`) catches EVERY
 * throw including AbortError, emits `ask_end(ok:false)`, then
 * re-throws. This test pins the invariant.
 */
describe('ask_end emitted on abort path (spec §9 invariant)', () => {
  it('aborting an in-flight ctx.ask() still emits ask_end(ok:false)', async () => {
    // Provider that blocks until the abort signal fires; the runtime's
    // internal AbortController propagates the abort once we call
    // `runtime.abort(executionId)`.
    const provider = {
      name: 'slow',
      chat: (_messages: unknown, options: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          options.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
      stream: async function* () {
        // never yields — aborted externally
      },
    } as unknown as Parameters<AxlRuntime['registerProvider']>[1];

    const a = agent({ name: 'slow-agent', model: 'mock:test', system: 'sys' });
    const wf = workflow({
      name: 'abort-wf',
      input: z.object({}),
      handler: async (ctx) => ctx.ask(a, 'q'),
    });

    const runtime = new AxlRuntime({ defaultProvider: 'mock' });
    runtime.registerProvider('mock', provider);
    runtime.register(wf);

    const traces: AxlEvent[] = [];
    runtime.on('trace', (ev: AxlEvent) => traces.push(ev));

    // Kick off the workflow, wait for the ask_start to fire, then abort
    // via the runtime's per-execution controller.
    const promise = runtime.execute('abort-wf', {});
    for (let i = 0; i < 20 && !traces.some((t) => t.type === 'ask_start'); i++) {
      await new Promise((r) => setImmediate(r));
    }
    const askStart = traces.find((t) => t.type === 'ask_start');
    expect(askStart).toBeDefined();
    runtime.abort(askStart!.executionId);

    await expect(promise).rejects.toThrow();

    // Invariant: every ask_start has a matching ask_end.
    const starts = traces.filter((t) => t.type === 'ask_start');
    const ends = traces.filter((t) => t.type === 'ask_end');
    expect(starts.length).toBeGreaterThan(0);
    expect(ends.length).toBe(starts.length);

    // The terminal ask_end must carry outcome.ok=false since the ask
    // was interrupted mid-flight.
    const askEnd = ends[0] as AxlEvent & {
      outcome: { ok: true; result: unknown } | { ok: false; error: string };
    };
    expect(askEnd.outcome.ok).toBe(false);
  });
});
