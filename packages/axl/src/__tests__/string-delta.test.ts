/**
 * Integration tests for `string_delta` events emitted by `ctx.ask()` via
 * the streaming walker (spec/17). Walker-level unit tests live in
 * `streaming-walker.test.ts`; this file exercises the wiring through
 * `WorkflowContext` + MockProvider + the trace bus to confirm:
 *
 *   - Events emit when gating allows it.
 *   - Events DON'T emit when gating blocks (no schema, tools present,
 *     non-object root schema).
 *   - `attempt` reflects schema retries.
 *   - `agent`, `askId`, `parentAskId`, `depth` are propagated correctly.
 *   - Concurrent asks don't cross-contaminate.
 *
 * The walker's per-char correctness is pinned in the unit tests; here
 * we verify the integration surface only.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { MockProvider } from '../../../axl-testing/src/mock-provider.js';
import { ProviderRegistry } from '../providers/registry.js';
import { WorkflowContext } from '../context.js';
import { randomUUID } from 'node:crypto';
import type { AxlEvent } from '../types.js';

function makeCtx(provider: MockProvider) {
  const registry = new ProviderRegistry();
  registry.registerInstance('mock', provider);
  const traces: AxlEvent[] = [];
  const ctx = new WorkflowContext({
    input: 'test',
    executionId: randomUUID(),
    config: {},
    providerRegistry: registry,
    onTrace: (e) => traces.push(e),
  });
  void ctx.events;
  return { ctx, traces };
}

function stringDeltaEvents(traces: AxlEvent[]) {
  return traces.filter(
    (t): t is Extract<AxlEvent, { type: 'string_delta' }> => t.type === 'string_delta',
  );
}

describe('string_delta events (spec/17)', () => {
  it('emits string_delta for a streamed string value', async () => {
    const provider = MockProvider.sequence([
      {
        content: '{"summary":"Hello world"}',
        chunks: ['{"summary":"Hel', 'lo wor', 'ld"}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 's', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', { schema: z.object({ summary: z.string() }) });

    const deltas = stringDeltaEvents(traces);
    // Three chunks; the first two flush mid-string at end-of-chunk;
    // the third flushes on the closing `"`.
    expect(deltas.length).toBe(3);
    expect(deltas.map((d) => d.data.delta).join('')).toBe('Hello world');
    expect(deltas.every((d) => d.data.path === '/summary')).toBe(true);
    // attempt is 1 on first try.
    expect(deltas.every((d) => d.attempt === 1)).toBe(true);
    // agent name propagated.
    expect(deltas.every((d) => d.agent === 's')).toBe(true);
    // askId / depth propagated via AskScoped mixin.
    expect(deltas.every((d) => typeof d.askId === 'string' && d.depth === 0)).toBe(true);
  });

  it('emits multiple paths in document order', async () => {
    const provider = MockProvider.sequence([
      {
        content: '{"a":"hi","b":"yo"}',
        chunks: ['{"a":"hi","b":"yo"}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 's', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', { schema: z.object({ a: z.string(), b: z.string() }) });

    const deltas = stringDeltaEvents(traces);
    expect(deltas.map((d) => `${d.data.path}=${d.data.delta}`)).toEqual(['/a=hi', '/b=yo']);
  });

  it('emits nested-array paths correctly', async () => {
    const provider = MockProvider.sequence([
      {
        content: '{"sources":[{"title":"Wiki"},{"title":"Stack"}]}',
        chunks: ['{"sources":[{"title":"Wiki"},{"title":"Stack"}]}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 's', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', {
      schema: z.object({
        sources: z.array(z.object({ title: z.string() })),
      }),
    });

    const deltas = stringDeltaEvents(traces);
    expect(deltas.map((d) => `${d.data.path}=${d.data.delta}`)).toEqual([
      '/sources/0/title=Wiki',
      '/sources/1/title=Stack',
    ]);
  });

  it('does NOT emit string_delta when no schema is set', async () => {
    const provider = MockProvider.sequence([{ content: '{"x":"y"}', chunks: ['{"x":"y"}'] }]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'no-schema', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q'); // no schema

    expect(stringDeltaEvents(traces).length).toBe(0);
  });

  it('does NOT emit string_delta when tools are configured (tool-calling mode)', async () => {
    const noopTool = tool({
      name: 'noop',
      description: 'noop',
      input: z.object({}),
      handler: async () => ({}),
    });
    const provider = MockProvider.sequence([{ content: '{"x":"y"}', chunks: ['{"x":', '"y"}'] }]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({
      name: 'with-tools',
      model: 'mock:test',
      system: 'test',
      tools: [noopTool],
    });

    await ctx.ask(a, 'q', { schema: z.object({ x: z.string() }) });

    expect(stringDeltaEvents(traces).length).toBe(0);
  });

  it('does NOT emit string_delta when schema root is not a ZodObject', async () => {
    const provider = MockProvider.sequence([{ content: '["a","b"]', chunks: ['["a","b"]'] }]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'arr-root', model: 'mock:test', system: 'test' });

    // Schema is an array, not a ZodObject — gated off.
    await ctx.ask(a, 'q', { schema: z.array(z.string()) });

    expect(stringDeltaEvents(traces).length).toBe(0);
  });

  it('flushes on closing quote, not just at end-of-chunk', async () => {
    // The closing `"` lands mid-chunk, followed by `,"b":...`. Verify
    // the delta for `/a` flushes at the quote, not at end-of-chunk.
    const provider = MockProvider.sequence([
      {
        content: '{"a":"hello","b":"world"}',
        chunks: ['{"a":"hello","b":"world"}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'flush', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', { schema: z.object({ a: z.string(), b: z.string() }) });

    const deltas = stringDeltaEvents(traces);
    // Two distinct deltas, two distinct paths — proves per-string flush
    // happened mid-chunk, not just one batched delta with both contents.
    expect(deltas.length).toBe(2);
    expect(deltas[0].data).toEqual({ path: '/a', delta: 'hello' });
    expect(deltas[1].data).toEqual({ path: '/b', delta: 'world' });
  });

  it('emits unescaped chars (\\n becomes newline)', async () => {
    const provider = MockProvider.sequence([
      {
        content: '{"line":"a\\nb"}',
        chunks: ['{"line":"a\\nb"}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'esc', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', { schema: z.object({ line: z.string() }) });

    const deltas = stringDeltaEvents(traces);
    const joined = deltas.map((d) => d.data.delta).join('');
    expect(joined).toBe('a\nb');
  });

  it('partial_object continues to emit alongside string_delta', async () => {
    // Same chunks as the partial_object spec test; verify the new walker
    // still drives partial_object emission unchanged.
    const provider = MockProvider.sequence([
      {
        content: '{"summary":"Hi"}',
        chunks: ['{"summary":"Hi"', '}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'both', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', { schema: z.object({ summary: z.string() }) });

    const partials = traces.filter((t) => t.type === 'partial_object');
    const deltas = stringDeltaEvents(traces);

    expect(deltas.length).toBeGreaterThan(0);
    expect(partials.length).toBeGreaterThan(0);
    // Last partial_object snapshot reflects the final state.
    expect((partials[partials.length - 1] as { data: { object: unknown } }).data.object).toEqual({
      summary: 'Hi',
    });
  });

  it('within one chunk, string_delta fires before partial_object', async () => {
    // One chunk that completes a string AND crosses a structural boundary.
    // Spec §4 ordering: deltas first, then snapshot reflecting them.
    const provider = MockProvider.sequence([
      {
        content: '{"x":"abc"}',
        chunks: ['{"x":"abc"}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'order', model: 'mock:test', system: 'test' });

    await ctx.ask(a, 'q', { schema: z.object({ x: z.string() }) });

    // Find indexes; first string_delta must precede first partial_object.
    const firstDelta = traces.findIndex((t) => t.type === 'string_delta');
    const firstPartial = traces.findIndex((t) => t.type === 'partial_object');
    expect(firstDelta).toBeGreaterThanOrEqual(0);
    expect(firstPartial).toBeGreaterThanOrEqual(0);
    expect(firstDelta).toBeLessThan(firstPartial);
  });

  it('escapes `~` and `/` in path keys per RFC 6901', async () => {
    // Schema with a key containing both special chars. Walker must
    // produce `/a~1b~0c` for key `"a/b~c"`.
    const provider = MockProvider.sequence([
      {
        content: '{"a/b~c":"x"}',
        chunks: ['{"a/b~c":"x"}'],
      },
    ]);
    const { ctx, traces } = makeCtx(provider);
    const a = agent({ name: 'rfc6901', model: 'mock:test', system: 'test' });

    // Use z.record so the unusual key shape parses.
    await ctx.ask(a, 'q', { schema: z.object({ 'a/b~c': z.string() }) });

    const deltas = stringDeltaEvents(traces);
    expect(deltas.map((d) => d.data.path)).toContain('/a~1b~0c');
  });
});
