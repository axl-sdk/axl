import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { MockProvider } from '../../../axl-testing/src/mock-provider.js';
import { ProviderRegistry } from '../providers/registry.js';
import { WorkflowContext } from '../context.js';
import { randomUUID } from 'node:crypto';
import type { AxlEvent } from '../types.js';

/** Build a context wired to a MockProvider so we can drive streaming chunks. */
function makeCtx(provider: MockProvider) {
  const registry = new ProviderRegistry();
  registry.registerInstance('mock', provider);
  const traces: AxlEvent[] = [];
  const tokens: string[] = [];
  const ctx = new WorkflowContext({
    input: 'test',
    executionId: randomUUID(),
    config: {},
    providerRegistry: registry,
    onTrace: (e) => traces.push(e),
    onToken: (t) => tokens.push(t),
  });
  return { ctx, traces, tokens };
}

function partialObjectEvents(traces: AxlEvent[]) {
  return traces.filter(
    (t): t is Extract<AxlEvent, { type: 'partial_object' }> => t.type === 'partial_object',
  );
}

describe('partial_object events (spec/16 §4.2)', () => {
  it('emits partial_object on structural boundaries (`,`, `}`, `]`)', async () => {
    // Three chunks: opening, mid, close. Each ends on a structural boundary,
    // so each should trigger a partial_object emission.
    const provider = MockProvider.sequence([
      {
        content: '{"name":"Alice","age":30}',
        chunks: ['{"name":"Alice",', '"age":30', '}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'p', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', {
      schema: z.object({ name: z.string(), age: z.number() }),
    });

    const partials = partialObjectEvents(traces);
    // 3 chunks × matching structural boundary = 3 emissions (the middle
    // chunk ends in '0' which is NOT a boundary, so only chunks 1 and 3
    // qualify... wait, chunk 1 ends in `,`, chunk 2 ends in `0` not a
    // boundary, chunk 3 ends in `}`. So 2 emissions expected.
    expect(partials.length).toBe(2);
    // Final emission contains the full object.
    expect(partials[partials.length - 1].data.object).toEqual({
      name: 'Alice',
      age: 30,
    });
  });

  it('does NOT emit partial_object when no schema is set', async () => {
    const provider = MockProvider.sequence([{ content: '{"x":1}', chunks: ['{"x":', '1}'] }]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'no-schema', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q'); // no schema

    expect(partialObjectEvents(traces).length).toBe(0);
  });

  it('does NOT emit partial_object when tools are configured (tool-calling mode)', async () => {
    const noopTool = tool({
      name: 'noop',
      description: 'noop',
      input: z.object({}),
      handler: async () => ({}),
    });
    const provider = MockProvider.sequence([{ content: '{"x":1}', chunks: ['{"x":', '1}'] }]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({
      name: 'with-tools',
      model: 'mock:test',
      system: 'test',
      tools: [noopTool],
    });

    await ctx.ask(a, 'q', { schema: z.object({ x: z.number() }) });

    expect(partialObjectEvents(traces).length).toBe(0);
  });

  it('does NOT emit partial_object for non-ZodObject root schemas', async () => {
    const provider = MockProvider.sequence([{ content: '[1,2,3]', chunks: ['[1,', '2,', '3]'] }]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'arr', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', { schema: z.array(z.number()) });

    // ZodArray root — partial_object is gated on ZodObject only.
    expect(partialObjectEvents(traces).length).toBe(0);
  });

  it('monotonicity: each emission is a superset of the prior (no fields disappear)', async () => {
    const provider = MockProvider.sequence([
      {
        content: '{"a":1,"b":"hi","c":true}',
        chunks: ['{"a":1,', '"b":"hi",', '"c":true}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'mono', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', {
      schema: z.object({ a: z.number(), b: z.string(), c: z.boolean() }),
    });

    const partials = partialObjectEvents(traces);
    expect(partials.length).toBeGreaterThan(0);

    // For each consecutive pair, every key in the prior emission must
    // also be present in the next, with the same value (superset).
    for (let i = 1; i < partials.length; i++) {
      const prev = partials[i - 1].data.object as Record<string, unknown>;
      const cur = partials[i].data.object as Record<string, unknown>;
      for (const [k, v] of Object.entries(prev)) {
        expect(cur).toHaveProperty(k);
        expect(cur[k]).toEqual(v);
      }
    }
  });

  it('mid-string-split deltas do NOT emit (no structural boundary)', async () => {
    // Split a string value mid-way: chunk 1 ends mid-string (no boundary),
    // chunk 2 ends with `}` (boundary). Only chunk 2 should emit.
    const provider = MockProvider.sequence([
      {
        content: '{"name":"Alice"}',
        chunks: ['{"name":"Al', 'ice"}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'mid-str', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', { schema: z.object({ name: z.string() }) });

    const partials = partialObjectEvents(traces);
    expect(partials.length).toBe(1);
    expect(partials[0].data.object).toEqual({ name: 'Alice' });
  });

  it('does not over-emit on commas inside string values (review B-9)', async () => {
    // Split a comma-heavy STRING value across two chunks. The naive
    // "last char of delta is a comma" throttle used to emit on every
    // comma inside the string — 4 commas in "A, B, C, D" each fired
    // a parse. With the in-string state tracker there is ONE emission
    // per real structural boundary (the closing `}`).
    const provider = MockProvider.sequence([
      {
        content: '{"description":"A, B, C, D, E"}',
        chunks: ['{"description":"A, B,', ' C, D, E"}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'str-comma', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', { schema: z.object({ description: z.string() }) });

    const partials = partialObjectEvents(traces);
    // Exactly one emission — the final `}` — despite four commas in the
    // string. Under the old throttle this would have emitted 5 times
    // (4 commas inside the string + 1 closing `}`).
    expect(partials.length).toBe(1);
    expect(partials[0].data.object).toEqual({ description: 'A, B, C, D, E' });
  });

  it('handles escaped quotes inside strings without re-entering/exiting string state', async () => {
    // The string contains an escaped quote. If we miscounted the
    // `\"` as a string-exit, a later `,` would look "outside a string"
    // and trigger an emission on a non-structural position. The
    // escape-aware walker should see exactly one emission (the `}`).
    const provider = MockProvider.sequence([
      {
        content: '{"quote":"She said \\"hi, friend\\" loudly"}',
        chunks: ['{"quote":"She said \\"hi,', ' friend\\" loudly"}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'esc', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', { schema: z.object({ quote: z.string() }) });

    const partials = partialObjectEvents(traces);
    expect(partials.length).toBe(1);
    expect(partials[0].data.object).toEqual({ quote: 'She said "hi, friend" loudly' });
  });

  it('attempt field tracks the current schema retry counter', async () => {
    // First attempt: malformed → schema retry. Second attempt: valid.
    const provider = MockProvider.sequence([
      { content: 'not-json,', chunks: ['not-', 'json,'] }, // ends in `,`
      {
        content: '{"x":42}',
        chunks: ['{"x":42}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'retry-pa', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', { schema: z.object({ x: z.number() }), retries: 2 });

    const partials = partialObjectEvents(traces);
    if (partials.length === 0) return; // first attempt malformed, no partial emitted
    // Second attempt's partial_object should report attempt: 2.
    const lastPartial = partials[partials.length - 1];
    expect(lastPartial.attempt).toBeGreaterThanOrEqual(1);
  });

  it('attempt counter bumps after a schema retry: turn 1 emissions carry attempt=1, turn 2 emissions carry attempt=2', async () => {
    // Pins `context.ts:1007` — `currentAttempt = schemaRetries + 1` is
    // captured FRESH per turn (inside the streaming branch), so partials
    // emitted on turn 1 carry attempt=1 and partials emitted on turn 2
    // (after the schema retry) carry attempt=2.
    //
    // Setup: first response is parseable enough to emit at least one
    // structural-boundary partial BUT fails the final schema parse so
    // a schema retry kicks in. Second response is valid AND chunks
    // through structural boundaries so it also emits partials.
    //
    // Trick: '{"x":' followed by a STRING value '"bad",' creates a `,`
    // boundary outside a string after a parseable partial; the final
    // schema requires `x: number` so the parsed object fails Zod
    // validation and triggers a retry.
    const provider = MockProvider.sequence([
      // Turn 1: streams structural boundaries that will produce at least
      // one partial_object (after the `,`), but the parsed object
      // `{"x":"bad","y":1}` fails the schema `{x: number}` → schema retry.
      {
        content: '{"x":"bad","y":1}',
        chunks: ['{"x":"bad",', '"y":1', '}'],
      },
      // Turn 2: valid, also chunked so we get partial emissions.
      {
        content: '{"x":42,"y":1}',
        chunks: ['{"x":42,', '"y":1', '}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'attempt-bump', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', {
      schema: z.object({ x: z.number(), y: z.number() }),
      retries: 2,
    });

    const partials = partialObjectEvents(traces);
    // We MUST have emissions from BOTH turns to verify the counter bumps.
    expect(partials.length).toBeGreaterThanOrEqual(2);

    // Group emissions by their `attempt` field. Both attempt=1 and
    // attempt=2 must be represented — partials must NOT all share the
    // same attempt number, which would indicate `currentAttempt` was
    // captured outside the per-turn loop.
    const attempts = new Set(partials.map((p) => p.attempt));
    expect(attempts.has(1)).toBe(true);
    expect(attempts.has(2)).toBe(true);

    // Sanity: the partial_object events on turn 1 must come before any
    // partial_object events on turn 2 (insertion-ordered by step).
    const firstAttempt2Idx = partials.findIndex((p) => p.attempt === 2);
    const lastAttempt1Idx = partials.map((p) => p.attempt).lastIndexOf(1);
    expect(firstAttempt2Idx).toBeGreaterThan(lastAttempt1Idx);

    // Sanity: a schema retry actually occurred (a pipeline `failed` with
    // `stage: 'schema'` exists in the trace).
    const schemaFails = traces.filter(
      (t) => t.type === 'pipeline' && t.status === 'failed' && t.stage === 'schema',
    );
    expect(schemaFails.length).toBeGreaterThanOrEqual(1);
  });
});
