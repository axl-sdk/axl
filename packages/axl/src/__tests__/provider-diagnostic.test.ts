import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkflowContext } from '../context.js';
import type { AxlConfig } from '../config.js';
import type { AxlEvent, AxlEventOf, ChatMessage, ProviderResponse } from '../types.js';
import { AXL_EVENT_TYPES } from '../types.js';
import type { ChatOptions, EffortResolution, Provider } from '../providers/types.js';
import { ProviderRegistry } from '../providers/registry.js';
import { redactEvent } from '../redaction.js';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { z } from 'zod';
import { __resetDiagnosticWarnings } from '../schema-diagnostics.js';

// ── Harness ──────────────────────────────────────────────────────────────────

type EffortResolutionFn = (
  options: Pick<
    ChatOptions,
    'model' | 'effort' | 'thinkingBudget' | 'includeThoughts' | 'providerOptions'
  >,
) => EffortResolution | undefined;

/** Minimal provider that optionally implements the `effortResolution` capability
 *  and can be scripted to drive a multi-turn tool loop. */
class ScriptedProvider {
  readonly name = 'test';
  readonly seenOptions: ChatOptions[] = [];
  private turn = 0;

  constructor(private script: ProviderResponse[] = [{ content: 'ok' }]) {}

  async chat(_messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse> {
    this.seenOptions.push(options);
    const response = this.script[Math.min(this.turn, this.script.length - 1)];
    this.turn += 1;
    return { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, ...response };
  }

  async *stream(messages: ChatMessage[], options: ChatOptions) {
    const r = await this.chat(messages, options);
    yield { type: 'text_delta' as const, content: r.content };
    yield { type: 'done' as const, usage: r.usage };
  }
}

/** The clamp a Gemini-3.x-style adapter would report for `effort: 'none'`. */
const NONE_TO_LOW: EffortResolution = {
  requested: 'none',
  effective: 'low',
  clamped: true,
  cause: 'model cannot disable thinking',
};

function makeCtx(
  options: {
    config?: AxlConfig;
    script?: ProviderResponse[];
    effortResolution?: EffortResolutionFn;
  } = {},
) {
  const events: AxlEvent[] = [];
  const provider = new ScriptedProvider(options.script);
  if (options.effortResolution) {
    (provider as Provider).effortResolution = options.effortResolution;
  }
  const registry = new ProviderRegistry();
  registry.registerInstance('test', provider as unknown as Provider);
  const ctx = new WorkflowContext({
    input: 'x',
    executionId: 'exec-provider-diag',
    config: { defaultProvider: 'test', ...options.config },
    providerRegistry: registry,
    onTrace: (e) => events.push(e),
  });
  return { ctx, events, provider };
}

function diagnostics(events: AxlEvent[]): AxlEventOf<'provider_diagnostic'>[] {
  return events.filter(
    (e): e is AxlEventOf<'provider_diagnostic'> => e.type === 'provider_diagnostic',
  );
}

const echoAgent = agent({ name: 'diag-agent', model: 'test:model-x' });

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  __resetDiagnosticWarnings();
  delete process.env.AXL_DIAGNOSTICS_SILENT;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  vi.unstubAllEnvs();
});

// ═══════════════════════════════════════════════════════════════════════════
// B1 — the event itself
// ═══════════════════════════════════════════════════════════════════════════

describe('provider_diagnostic — effort_clamped (B1)', () => {
  it('emits one event with the adapter-reported data, inside ask scope, before the first call', async () => {
    const { ctx, events } = makeCtx({ effortResolution: () => NONE_TO_LOW });

    await ctx.ask(echoAgent, 'hi', { effort: 'none' });

    const diags = diagnostics(events);
    expect(diags).toHaveLength(1);
    expect(diags[0].data).toEqual({
      kind: 'effort_clamped',
      provider: 'test',
      model: 'model-x',
      requested: 'none',
      effective: 'low',
      cause: 'model cannot disable thinking',
    });

    const askStart = events.find((e) => e.type === 'ask_start');
    expect(askStart).toBeDefined();
    expect(diags[0].askId).toBe((askStart as AxlEventOf<'ask_start'>).askId);
    expect(diags[0].agent).toBe('diag-agent');

    const diagIndex = events.indexOf(diags[0]);
    expect(diagIndex).toBeGreaterThan(events.indexOf(askStart!));
    expect(diagIndex).toBeLessThan(events.findIndex((e) => e.type === 'agent_call_start'));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("clamped to 'low'"));
  });

  // B10
  it('leaves agent_call_start reporting the requested effort', async () => {
    const { ctx, events } = makeCtx({ effortResolution: () => NONE_TO_LOW });

    await ctx.ask(echoAgent, 'hi', { effort: 'none' });

    const call = events.find(
      (e) => e.type === 'agent_call_start',
    ) as AxlEventOf<'agent_call_start'>;
    expect(call.data.params?.effort).toBe('none');
  });

  // Frozen ambiguity 9: a clamped agent-level default effort is still reported.
  it('reports a clamp of an agent-level default effort the caller never passed', async () => {
    const defaulted = agent({ name: 'defaulted', model: 'test:model-x', effort: 'none' });
    const { ctx, events } = makeCtx({
      effortResolution: (options) => (options.effort === 'none' ? NONE_TO_LOW : undefined),
    });

    await ctx.ask(defaulted, 'hi');

    expect(diagnostics(events)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B2 — silence means "honored as requested"
// ═══════════════════════════════════════════════════════════════════════════

describe('provider_diagnostic — no clamp, no event (B2)', () => {
  const rows: Array<[string, EffortResolutionFn | undefined]> = [
    [
      'provider reports clamped: false',
      () => ({ requested: 'high', effective: 'high', clamped: false }),
    ],
    ['provider reports undefined', () => undefined],
    ['provider has no effortResolution at all', undefined],
  ];

  it.each(rows)('%s', async (_label, effortResolution) => {
    const { ctx, events } = makeCtx({ effortResolution });

    const result = await ctx.ask(echoAgent, 'hi', { effort: 'high' });

    expect(result).toBe('ok');
    expect(diagnostics(events)).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B3 — once per ask, not once per provider call
// ═══════════════════════════════════════════════════════════════════════════

describe('provider_diagnostic — once per ask (B3)', () => {
  it('emits one event across a three-turn tool loop', async () => {
    const ping = tool({
      name: 'ping',
      description: 'ping',
      input: z.object({ note: z.string().optional() }),
      handler: async () => 'pong',
    });
    const toolAgent = agent({ name: 'tool-agent', model: 'test:model-x', tools: [ping] });
    const call = (id: string) => ({
      content: '',
      tool_calls: [{ id, type: 'function' as const, function: { name: 'ping', arguments: '{}' } }],
    });
    const { ctx, events } = makeCtx({
      script: [call('c1'), call('c2'), { content: 'done' }],
      effortResolution: () => NONE_TO_LOW,
    });

    await ctx.ask(toolAgent, 'hi', { effort: 'none' });

    expect(events.filter((e) => e.type === 'agent_call_start')).toHaveLength(3);
    expect(diagnostics(events)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B4 — the event is per ask; the warning dedupes per distinct clamp
// ═══════════════════════════════════════════════════════════════════════════

describe('provider_diagnostic — event per ask, warn deduped (B4)', () => {
  it('re-emits per ask and warns again only for a genuinely different clamp', async () => {
    const { ctx, events } = makeCtx({
      effortResolution: (options) =>
        options.effort === 'none'
          ? NONE_TO_LOW
          : { requested: 'max', effective: 'high', clamped: true, cause: 'capped at high' },
    });

    await ctx.ask(echoAgent, 'one', { effort: 'none' });
    await ctx.ask(echoAgent, 'two', { effort: 'none' });
    expect(diagnostics(events)).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    await ctx.ask(echoAgent, 'three', { effort: 'max' });
    expect(diagnostics(events)).toHaveLength(3);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B5 — silencing gates the warning, never the event
// ═══════════════════════════════════════════════════════════════════════════

describe('provider_diagnostic — diagnostics.silent (B5)', () => {
  it('suppresses the warn but keeps the event under config.diagnostics.silent', async () => {
    const { ctx, events } = makeCtx({
      config: { diagnostics: { silent: true } },
      effortResolution: () => NONE_TO_LOW,
    });

    await ctx.ask(echoAgent, 'hi', { effort: 'none' });

    expect(diagnostics(events)).toHaveLength(1);
    expect(diagnostics(events)[0].data.cause).toBe('model cannot disable thinking');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('suppresses the warn but keeps the event under AXL_DIAGNOSTICS_SILENT', async () => {
    vi.stubEnv('AXL_DIAGNOSTICS_SILENT', 'true');
    const { ctx, events } = makeCtx({ effortResolution: () => NONE_TO_LOW });

    await ctx.ask(echoAgent, 'hi', { effort: 'none' });

    expect(diagnostics(events)).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B6 / B7 — redaction pass-through and lifecycle categorization
// ═══════════════════════════════════════════════════════════════════════════

describe('provider_diagnostic — event plumbing (B6, B7)', () => {
  it('is a known event type', () => {
    expect(AXL_EVENT_TYPES).toContain('provider_diagnostic');
  });

  it('passes through redaction unchanged', async () => {
    const { ctx, events } = makeCtx({
      config: { trace: { redact: true } },
      effortResolution: () => NONE_TO_LOW,
    });

    await ctx.ask(echoAgent, 'hi', { effort: 'none' });

    const diag = diagnostics(events)[0];
    expect(diag).toBeDefined();
    expect(redactEvent(diag)).toEqual(diag);
  });

  it('is yielded by the lifecycle view', async () => {
    const { ctx } = makeCtx({ effortResolution: () => NONE_TO_LOW });
    const seen: AxlEvent[] = [];
    const collecting = (async () => {
      for await (const e of ctx.events.lifecycle) {
        seen.push(e);
        if (e.type === 'agent_call_end') break;
      }
    })();

    await ctx.ask(echoAgent, 'hi', { effort: 'none' });
    await collecting;

    expect(seen.filter((e) => e.type === 'provider_diagnostic')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A throwing capability method is a provider bug — it must not be swallowed
// ═══════════════════════════════════════════════════════════════════════════

describe('provider_diagnostic — a broken effortResolution fails loudly', () => {
  it('propagates a throw rather than hiding a broken adapter', async () => {
    const { ctx, provider } = makeCtx({
      effortResolution: () => {
        throw new Error('adapter bug');
      },
    });

    await expect(ctx.ask(echoAgent, 'hi', { effort: 'none' })).rejects.toThrow('adapter bug');
    expect(provider.seenOptions).toHaveLength(0);
  });

  it.each([
    ['a missing effective', { requested: 'none', clamped: true }],
    ['an empty effective', { requested: 'none', effective: '', clamped: true }],
    ['a non-string effective', { requested: 'none', effective: 3, clamped: true }],
    ['a missing requested', { effective: 'low', clamped: true }],
  ])('rejects a clamp report with %s', async (_label, malformed) => {
    const { ctx, provider, events } = makeCtx({
      effortResolution: () => malformed as unknown as EffortResolution,
    });

    await expect(ctx.ask(echoAgent, 'hi', { effort: 'none' })).rejects.toThrow(
      /malformed EffortResolution/,
    );
    // The message names the provider and the shape it received, so the adapter
    // author can find the bug without a debugger.
    await expect(ctx.ask(echoAgent, 'hi', { effort: 'none' })).rejects.toThrow(
      new RegExp(`'test'.*'model-x'`),
    );
    expect(provider.seenOptions).toHaveLength(0);
    expect(diagnostics(events)).toHaveLength(0);
  });
});
