import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { WorkflowContext } from '../context.js';
import type { AxlConfig } from '../config.js';
import type { AxlEvent, AxlEventOf } from '../types.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';
import type { Agent } from '../agent.js';
import type { AskOptions } from '../types.js';
import { tool } from '../tool.js';
import {
  detectDroppedRefinements,
  __resetSchemaDiagnosticWarnings,
  DEFAULT_SCHEMA_OVERSIZED_TOKENS,
} from '../schema-diagnostics.js';

// ── Harness ──────────────────────────────────────────────────────────────────

class OkProvider {
  readonly name = 'test';
  constructor(private content = '{}') {}

  async chat(_messages: any[], _options: any) {
    return { content: this.content, usage: { prompt_tokens: 1, completion_tokens: 1 }, cost: 0 };
  }

  async *stream(messages: any[], options: any) {
    const r = await this.chat(messages, options);
    yield { type: 'text_delta' as const, content: r.content };
    yield { type: 'done' as const, usage: r.usage };
  }
}

function diagnostics(events: AxlEvent[]): AxlEventOf<'schema_diagnostic'>[] {
  return events.filter((e): e is AxlEventOf<'schema_diagnostic'> => e.type === 'schema_diagnostic');
}

function makeCtx(config: AxlConfig = {}) {
  const events: AxlEvent[] = [];
  const registry = new ProviderRegistry();
  registry.registerInstance('test', new OkProvider('{}') as never);
  const ctx = new WorkflowContext({
    input: 'x',
    executionId: 'exec-diag',
    config: { defaultProvider: 'test', ...config },
    providerRegistry: registry,
    onTrace: (e) => events.push(e),
  });
  return { ctx, events };
}

/** Run an ask, swallowing schema-parse failures. `emitSchemaDiagnostics` fires
 *  at prompt-build time — before the model call — so the diagnostics under test
 *  are already emitted even when the mock's `{}` reply fails to parse. */
async function runAsk(
  ctx: WorkflowContext,
  a: Agent,
  prompt: string,
  options?: AskOptions<unknown>,
): Promise<void> {
  try {
    await ctx.ask(a, prompt, options);
  } catch {
    /* diagnostics already emitted pre-call */
  }
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  __resetSchemaDiagnosticWarnings();
  delete process.env.AXL_DIAGNOSTICS_SILENT;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

// ═══════════════════════════════════════════════════════════════════════════
// detectDroppedRefinements (unit)
// ═══════════════════════════════════════════════════════════════════════════

describe('detectDroppedRefinements', () => {
  it('flags a top-level .refine() as <root>', () => {
    const r = detectDroppedRefinements(z.object({ n: z.number() }).refine((v) => v.n > 0));
    expect(r.count).toBe(1);
    expect(r.paths).toEqual(['<root>']);
  });

  it('flags .superRefine() too', () => {
    const r = detectDroppedRefinements(z.number().superRefine(() => {}));
    expect(r.count).toBe(1);
  });

  it('reports the field path for a nested refinement', () => {
    const schema = z.object({
      user: z.object({ age: z.number().refine((a) => a >= 18, 'adult') }),
    });
    const r = detectDroppedRefinements(schema);
    expect(r.count).toBe(1);
    expect(r.paths).toEqual(['user.age']);
  });

  it('recurses into array elements and union arms', () => {
    const schema = z.object({
      items: z.array(z.string().refine((s) => s.length > 0)),
      choice: z.union([z.number().refine((n) => n > 0), z.string()]),
    });
    const r = detectDroppedRefinements(schema);
    expect(r.count).toBe(2);
    expect(r.paths).toEqual(expect.arrayContaining(['items[]', 'choice']));
  });

  it('does NOT flag plain constraints (.min/.max/.email/.regex)', () => {
    const schema = z.object({
      name: z.string().min(1).max(10),
      email: z.email(),
      code: z.string().regex(/^[A-Z]+$/),
      count: z.number().min(0),
    });
    expect(detectDroppedRefinements(schema).count).toBe(0);
  });

  it('finds a refinement on the input side of a .transform() pipe', () => {
    const schema = z
      .object({ n: z.number() })
      .refine((o) => o.n > 0)
      .transform((o) => o);
    expect(detectDroppedRefinements(schema).count).toBe(1);
  });

  it('does not blow the stack on a recursive schema', () => {
    type Node = { value: number; children: Node[] };
    const Node: z.ZodType<Node> = z.lazy(() =>
      z.object({ value: z.number().refine((v) => v >= 0), children: z.array(Node) }),
    );
    const r = detectDroppedRefinements(Node);
    expect(r.count).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Emit sites (AC-J7/J9)
// ═══════════════════════════════════════════════════════════════════════════

describe('schema_diagnostic emit sites', () => {
  it('prompt oversized: fires site:prompt when appended schema exceeds the threshold', async () => {
    const { ctx, events } = makeCtx({ diagnostics: { schemaOversizedTokens: 1 } });
    const a = agent({ name: 'big', model: 'test:m', system: 's' });
    await runAsk(ctx, a, 'go', { schema: z.object({ a: z.string(), b: z.number() }) });
    const oversized = diagnostics(events).filter((e) => e.data.kind === 'prompt_schema_oversized');
    expect(oversized).toHaveLength(1);
    expect(oversized[0].data).toMatchObject({ site: 'prompt', threshold: 1 });
    // event-only (O3) — no console.warn for oversized
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('prompt oversized: does NOT fire under the threshold', async () => {
    const { ctx, events } = makeCtx({ diagnostics: { schemaOversizedTokens: 100_000 } });
    const a = agent({ name: 'small', model: 'test:m', system: 's' });
    await runAsk(ctx, a, 'go', { schema: z.object({ a: z.string() }) });
    expect(
      diagnostics(events).filter((e) => e.data.kind === 'prompt_schema_oversized'),
    ).toHaveLength(0);
  });

  it('prompt dropped_refinements: fires with count/paths and a one-time warn', async () => {
    const { ctx, events } = makeCtx();
    const a = agent({ name: 'ref', model: 'test:m', system: 's' });
    const schema = z.object({ n: z.number() }).refine((v) => v.n > 0, 'positive');
    await runAsk(ctx, a, 'go', { schema });
    const dropped = diagnostics(events).filter((e) => e.data.kind === 'dropped_refinements');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].data).toMatchObject({ site: 'prompt', count: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('streaming_disabled: union root fires cause:non-object + warns', async () => {
    const { ctx, events } = makeCtx();
    const a = agent({ name: 'union', model: 'test:m', system: 's' });
    const schema = z.discriminatedUnion('k', [
      z.object({ k: z.literal('a'), a: z.string() }),
      z.object({ k: z.literal('b'), b: z.number() }),
    ]);
    await runAsk(ctx, a, 'go', { schema });
    const sd = diagnostics(events).filter((e) => e.data.kind === 'streaming_disabled');
    expect(sd).toHaveLength(1);
    expect(sd[0].data).toMatchObject({ cause: 'non-object' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('streaming_disabled: object root + a tool fires cause:tools, event-only (no warn)', async () => {
    const { ctx, events } = makeCtx();
    const t = tool({
      name: 'noop',
      description: 'noop',
      input: z.object({ x: z.string() }),
      handler: async () => 'ok',
    });
    const a = agent({ name: 'tooled', model: 'test:m', system: 's', tools: [t] });
    await runAsk(ctx, a, 'go', { schema: z.object({ r: z.string() }) });
    const sd = diagnostics(events).filter((e) => e.data.kind === 'streaming_disabled');
    expect(sd).toHaveLength(1);
    expect(sd[0].data).toMatchObject({ cause: 'tools' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('object root, no tools → no streaming_disabled', async () => {
    const { ctx, events } = makeCtx();
    const a = agent({ name: 'clean', model: 'test:m', system: 's' });
    await runAsk(ctx, a, 'go', { schema: z.object({ r: z.string() }) });
    expect(diagnostics(events).filter((e) => e.data.kind === 'streaming_disabled')).toHaveLength(0);
  });

  it('tool-def oversized + dropped_refinements fire from the tool site', async () => {
    const { ctx, events } = makeCtx({ diagnostics: { schemaOversizedTokens: 1 } });
    const t = tool({
      name: 'search',
      description: 'search',
      input: z.object({ q: z.string().refine((s) => s.length > 0, 'nonempty') }),
      handler: async () => 'ok',
    });
    const a = agent({ name: 'tsite', model: 'test:m', system: 's', tools: [t] });
    await runAsk(ctx, a, 'go');
    const ds = diagnostics(events);
    const oversized = ds.filter((e) => e.data.kind === 'prompt_schema_oversized');
    const dropped = ds.filter((e) => e.data.kind === 'dropped_refinements');
    expect(oversized[0]?.data).toMatchObject({ site: 'tool', tool: 'search' });
    expect(dropped[0]?.data).toMatchObject({ site: 'tool', tool: 'search', count: 1 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Warn dedup + silencing (R8)
// ═══════════════════════════════════════════════════════════════════════════

describe('schema_diagnostic console.warn (R8)', () => {
  it('warns once across multiple asks for the same agent+kind+schema', async () => {
    const { ctx } = makeCtx();
    const a = agent({ name: 'dup', model: 'test:m', system: 's' });
    const schema = z.object({ n: z.number() }).refine((v) => v.n > 0);
    await runAsk(ctx, a, 'go1', { schema });
    await runAsk(ctx, a, 'go2', { schema });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('diagnostics.silent suppresses the warn but not the event', async () => {
    const { ctx, events } = makeCtx({ diagnostics: { silent: true } });
    const a = agent({ name: 'silent', model: 'test:m', system: 's' });
    await runAsk(ctx, a, 'go', { schema: z.object({ n: z.number() }).refine((v) => v.n > 0) });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(diagnostics(events).filter((e) => e.data.kind === 'dropped_refinements')).toHaveLength(
      1,
    );
  });

  it('AXL_DIAGNOSTICS_SILENT=true suppresses the warn', async () => {
    process.env.AXL_DIAGNOSTICS_SILENT = 'true';
    const { ctx } = makeCtx();
    const a = agent({ name: 'envsilent', model: 'test:m', system: 's' });
    await runAsk(ctx, a, 'go', { schema: z.object({ n: z.number() }).refine((v) => v.n > 0) });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Config default
// ═══════════════════════════════════════════════════════════════════════════

describe('threshold config', () => {
  it('defaults to ~4k tokens', () => {
    expect(DEFAULT_SCHEMA_OVERSIZED_TOKENS).toBe(4000);
  });
});
