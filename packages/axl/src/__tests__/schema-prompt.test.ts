import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { WorkflowContext } from '../context.js';
import type { AxlConfig } from '../config.js';
import type { AxlEvent, AxlEventOf } from '../types.js';
import type { ChatOptions, ChatMessage } from '../providers/types.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';
import type { Agent } from '../agent.js';
import type { AskOptions } from '../types.js';
import { __resetSchemaDiagnosticWarnings } from '../schema-diagnostics.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GeminiProvider } from '../providers/gemini.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { OpenAIProvider } from '../providers/openai.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { DEEPSEEK_PROFILE } from '../providers/profiles/deepseek.js';
import { GROQ_PROFILE } from '../providers/profiles/groq.js';

// ── Harness ──────────────────────────────────────────────────────────────────

type NativeSupport = 'schema' | 'downgraded' | 'lossy' | 'unsupported';

class RecordingProvider {
  readonly name = 'test';
  calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  constructor(
    private content = '{"ok":true}',
    private support?: NativeSupport,
  ) {}
  nativeStructuredOutputSupport(): NativeSupport | undefined {
    return this.support;
  }
  async chat(messages: ChatMessage[], options: ChatOptions) {
    this.calls.push({ messages, options });
    return { content: this.content, usage: { prompt_tokens: 1, completion_tokens: 1 }, cost: 0 };
  }
  async *stream(messages: ChatMessage[], options: ChatOptions) {
    const r = await this.chat(messages, options);
    yield { type: 'text_delta' as const, content: r.content };
    yield { type: 'done' as const, usage: r.usage };
  }
}

function makeCtx(provider: RecordingProvider, config: AxlConfig = {}) {
  const events: AxlEvent[] = [];
  const registry = new ProviderRegistry();
  registry.registerInstance('test', provider as never);
  const ctx = new WorkflowContext({
    input: 'x',
    executionId: 'exec-sp',
    config: { defaultProvider: 'test', ...config },
    providerRegistry: registry,
    onTrace: (e) => events.push(e),
  });
  return { ctx, events };
}

function lastUser(provider: RecordingProvider): string {
  const msg = [...provider.calls[0].messages].reverse().find((m) => m.role === 'user');
  return (msg?.content as string) ?? '';
}

function diagnostics(events: AxlEvent[]): AxlEventOf<'schema_diagnostic'>[] {
  return events.filter((e): e is AxlEventOf<'schema_diagnostic'> => e.type === 'schema_diagnostic');
}

async function runAsk(
  ctx: WorkflowContext,
  a: Agent,
  prompt: string,
  options?: AskOptions<unknown>,
) {
  try {
    return await ctx.ask(a, prompt, options);
  } catch {
    /* parse may fail on a fixed mock reply; the prompt/params are already recorded */
  }
}

beforeEach(() => {
  __resetSchemaDiagnosticWarnings();
  delete process.env.AXL_DIAGNOSTICS_SILENT;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const S = z.object({ ok: z.boolean() });

// ═══════════════════════════════════════════════════════════════════════════
// schemaPrompt (AC-J2)
// ═══════════════════════════════════════════════════════════════════════════

describe('schemaPrompt', () => {
  it("default 'json-schema' appends the JSON-schema guidance", async () => {
    const p = new RecordingProvider();
    const { ctx } = makeCtx(p);
    const a = agent({ name: 'a', model: 'test:m', system: 's' });
    await runAsk(ctx, a, 'go', { schema: S });
    expect(lastUser(p)).toContain('Respond with valid JSON matching this schema:');
  });

  it("'none' appends NO schema text but still parses (schema is the gate)", async () => {
    const p = new RecordingProvider('{"ok":true}');
    const { ctx, events } = makeCtx(p);
    const a = agent({ name: 'none', model: 'test:m', system: 's' });
    const result = await ctx.ask(a, 'go', { schema: S, schemaPrompt: 'none' });
    expect(result).toEqual({ ok: true });
    expect(lastUser(p)).not.toContain('Respond with valid JSON');
    expect(lastUser(p)).toBe('go');
    // R7 diagnostic fires
    expect(diagnostics(events).some((e) => e.data.kind === 'schema_prompt_none_no_guidance')).toBe(
      true,
    );
  });

  it("'none' rejects a reply that violates the schema (parse gate still enforced)", async () => {
    const p = new RecordingProvider('{"ok":"not-a-boolean"}');
    const { ctx } = makeCtx(p);
    const a = agent({ name: 'none2', model: 'test:m', system: 's' });
    await expect(
      ctx.ask(a, 'go', { schema: S, schemaPrompt: 'none', retries: 0 }),
    ).rejects.toThrow();
  });

  it('custom { render: string } appends exactly that string', async () => {
    const p = new RecordingProvider();
    const { ctx } = makeCtx(p);
    const a = agent({ name: 'c', model: 'test:m', system: 's' });
    await runAsk(ctx, a, 'go', { schema: S, schemaPrompt: { render: 'Return {ok:true}.' } });
    const text = lastUser(p);
    expect(text).toContain('Return {ok:true}.');
    expect(text).not.toContain('Respond with valid JSON matching this schema:');
  });

  it('custom { render: fn } receives the schema and appends its output', async () => {
    const p = new RecordingProvider();
    const { ctx } = makeCtx(p);
    const a = agent({ name: 'f', model: 'test:m', system: 's' });
    const render = vi.fn((schema: z.ZodType<unknown>) => `custom:${schema instanceof z.ZodObject}`);
    await runAsk(ctx, a, 'go', { schema: S, schemaPrompt: { render } });
    expect(render).toHaveBeenCalledOnce();
    expect(lastUser(p)).toContain('custom:true');
  });

  it('precedence: AskOptions overrides AgentConfig', async () => {
    const p = new RecordingProvider();
    const { ctx } = makeCtx(p);
    const a = agent({ name: 'p', model: 'test:m', system: 's', schemaPrompt: 'none' });
    // AgentConfig says 'none'; AskOptions says custom → custom wins.
    await runAsk(ctx, a, 'go', { schema: S, schemaPrompt: { render: 'FROM_ASK' } });
    expect(lastUser(p)).toContain('FROM_ASK');
  });

  it('AgentConfig applies when AskOptions omits it', async () => {
    const p = new RecordingProvider();
    const { ctx } = makeCtx(p);
    const a = agent({
      name: 'ac',
      model: 'test:m',
      system: 's',
      schemaPrompt: { render: 'FROM_CFG' },
    });
    await runAsk(ctx, a, 'go', { schema: S });
    expect(lastUser(p)).toContain('FROM_CFG');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Forwarding through delegate (R11)
// ═══════════════════════════════════════════════════════════════════════════

describe('delegate forwards schemaPrompt / nativeStructuredOutput (R11)', () => {
  it('schemaPrompt set on delegate reaches the terminal ask', async () => {
    const p = new RecordingProvider();
    const { ctx } = makeCtx(p);
    const a = agent({ name: 'only', model: 'test:m', system: 's' });
    // Single candidate → delegate calls the terminal ask directly.
    await ctx
      .delegate([a], 'go', { schema: S, schemaPrompt: { render: 'DELEGATED' } })
      .catch(() => {});
    expect(lastUser(p)).toContain('DELEGATED');
    expect(lastUser(p)).not.toContain('Respond with valid JSON matching this schema:');
  });

  it('nativeStructuredOutput set on delegate reaches the terminal ask', async () => {
    const p = new RecordingProvider('{"ok":true}', 'schema');
    const { ctx } = makeCtx(p);
    const a = agent({ name: 'only2', model: 'test:m', system: 's' });
    await ctx.delegate([a], 'go', { schema: S, nativeStructuredOutput: true }).catch(() => {});
    expect(p.calls[0].options.responseFormat?.type).toBe('json_schema');
  });

  it('MULTI-candidate delegate forwards both fields to the handoff TARGET (not just the router)', async () => {
    // Sequence provider: call 0 = router picks handoff_to_beta; call 1 = target beta.
    class SeqProvider {
      readonly name = 'test';
      calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
      nativeStructuredOutputSupport() {
        return 'schema' as const;
      }
      async chat(messages: ChatMessage[], options: ChatOptions) {
        this.calls.push({ messages, options });
        if (this.calls.length === 1) {
          return {
            content: '',

            tool_calls: [
              {
                id: 't1',
                type: 'function',
                function: { name: 'handoff_to_beta', arguments: '{}' },
              },
            ] as any,
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            cost: 0,
          };
        }
        return {
          content: '{"ok":true}',
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          cost: 0,
        };
      }
      async *stream(messages: ChatMessage[], options: ChatOptions) {
        const r = await this.chat(messages, options);
        yield { type: 'text_delta' as const, content: r.content };
        yield { type: 'done' as const, usage: r.usage };
      }
    }
    const p = new SeqProvider();
    const registry = new ProviderRegistry();
    registry.registerInstance('test', p as never);
    const ctx = new WorkflowContext({
      input: 'x',
      executionId: 'exec-deleg',
      config: { defaultProvider: 'test' },
      providerRegistry: registry,
    });
    const alpha = agent({ name: 'alpha', model: 'test:m', system: 'alpha' });
    const beta = agent({ name: 'beta', model: 'test:m', system: 'beta' });
    await ctx
      .delegate([alpha, beta], 'go', {
        schema: S,
        schemaPrompt: { render: 'DELEGATED_TARGET' },
        nativeStructuredOutput: true,
      })
      .catch(() => {});
    // The TARGET call (index 1) must carry the custom prompt AND the native format.
    const targetCall = p.calls[1];
    expect(targetCall).toBeDefined();
    const userMsg = [...targetCall.messages].reverse().find((m) => m.role === 'user');
    expect(userMsg?.content as string).toContain('DELEGATED_TARGET');
    expect(targetCall.options.responseFormat?.type).toBe('json_schema');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// nativeStructuredOutput (AC-J8)
// ═══════════════════════════════════════════════════════════════════════════

describe('nativeStructuredOutput', () => {
  it('derives a json_schema responseFormat from the Zod schema (no second schema)', async () => {
    const p = new RecordingProvider('{"ok":true}', 'schema');
    const { ctx } = makeCtx(p);
    const a = agent({ name: 'n', model: 'test:m', system: 's' });
    await runAsk(ctx, a, 'go', { schema: S, nativeStructuredOutput: true });
    const rf = p.calls[0].options.responseFormat;
    expect(rf?.type).toBe('json_schema');
    if (rf?.type === 'json_schema') {
      expect(rf.json_schema.schema).toEqual(
        expect.objectContaining({ type: 'object', properties: { ok: { type: 'boolean' } } }),
      );
    }
  });

  it('derives the native schema from the INPUT side — a .transform() stays non-empty', async () => {
    const p = new RecordingProvider('{"raw":"x"}', 'schema');
    const { ctx } = makeCtx(p);
    const a = agent({ name: 'tnat', model: 'test:m', system: 's' });
    const T = z.object({ raw: z.string() }).transform((o) => ({ parsed: o.raw }));
    await runAsk(ctx, a, 'go', { schema: T, nativeStructuredOutput: true });
    const rf = p.calls[0].options.responseFormat;
    expect(rf?.type).toBe('json_schema');
    if (rf?.type === 'json_schema') {
      const s = rf.json_schema.schema as { type?: string; properties?: Record<string, unknown> };
      // Output mode would have collapsed the transform to `{}`; input mode keeps `raw`.
      expect(s.type).toBe('object');
      expect(s.properties).toHaveProperty('raw');
      expect(s.properties).not.toHaveProperty('parsed'); // post-transform field, model doesn't emit it
    }
  });

  it('native schema does not spuriously mark a .default() field required (input side)', async () => {
    const p = new RecordingProvider('{"name":"x"}', 'schema');
    const { ctx } = makeCtx(p);
    const a = agent({ name: 'tdef', model: 'test:m', system: 's' });
    const D = z.object({ name: z.string(), age: z.number().default(5) });
    await runAsk(ctx, a, 'go', { schema: D, nativeStructuredOutput: true });
    const rf = p.calls[0].options.responseFormat;
    if (rf?.type === 'json_schema') {
      const s = rf.json_schema.schema as { required?: string[] };
      expect(s.required).toEqual(['name']); // age is defaulted → not required, matches the prompt
    }
  });

  it('falls back to json_object when not opted in', async () => {
    const p = new RecordingProvider();
    const { ctx } = makeCtx(p);
    const a = agent({ name: 'jo', model: 'test:m', system: 's' });
    await runAsk(ctx, a, 'go', { schema: S });
    expect(p.calls[0].options.responseFormat?.type).toBe('json_object');
  });

  it('warns via native_output_unsupported when the provider cannot honor it, and proceeds', async () => {
    const p = new RecordingProvider('{"ok":true}', 'unsupported');
    const { ctx, events } = makeCtx(p);
    const a = agent({ name: 'u', model: 'test:m', system: 's' });
    const result = await ctx.ask(a, 'go', { schema: S, nativeStructuredOutput: true });
    expect(result).toEqual({ ok: true }); // proceeds (O5)
    const d = diagnostics(events).find((e) => e.data.kind === 'native_output_unsupported');
    expect(d?.data).toMatchObject({ support: 'unsupported', provider: 'test' });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn when the provider honors the schema', async () => {
    const p = new RecordingProvider('{"ok":true}', 'schema');
    const { ctx, events } = makeCtx(p);
    const a = agent({ name: 'ok', model: 'test:m', system: 's' });
    await runAsk(ctx, a, 'go', { schema: S, nativeStructuredOutput: true });
    expect(diagnostics(events).some((e) => e.data.kind === 'native_output_unsupported')).toBe(
      false,
    );
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("AgentConfig default + adapter with no capability method assumes 'schema' (no warn)", async () => {
    const p = new RecordingProvider('{"ok":true}'); // support undefined
    const { ctx, events } = makeCtx(p);
    const a = agent({ name: 'cfg', model: 'test:m', system: 's', nativeStructuredOutput: true });
    await runAsk(ctx, a, 'go', { schema: S });
    // undefined support → treated as 'schema' → no diagnostic
    expect(diagnostics(events).some((e) => e.data.kind === 'native_output_unsupported')).toBe(
      false,
    );
    expect(p.calls[0].options.responseFormat?.type).toBe('json_schema');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Provider capability mapping (R10 truth table — no live API)
// ═══════════════════════════════════════════════════════════════════════════

describe('nativeStructuredOutputSupport() adapter mapping', () => {
  it('Anthropic → unsupported', () => {
    expect(new AnthropicProvider({ apiKey: 'k' }).nativeStructuredOutputSupport()).toBe(
      'unsupported',
    );
  });
  it('Gemini → lossy', () => {
    expect(new GeminiProvider({ apiKey: 'k' }).nativeStructuredOutputSupport()).toBe('lossy');
  });
  it('OpenAI Responses → schema', () => {
    expect(new OpenAIResponsesProvider({ apiKey: 'k' }).nativeStructuredOutputSupport()).toBe(
      'schema',
    );
  });
  it('OpenAI (Chat) → schema by default', () => {
    expect(new OpenAIProvider({ apiKey: 'k' }).nativeStructuredOutputSupport('gpt-4o')).toBe(
      'schema',
    );
  });
  it('DeepSeek profile (supportsJsonSchema:false) → downgraded', () => {
    const p = new OpenAICompatibleProvider({ apiKey: 'k', profile: DEEPSEEK_PROFILE });
    expect(p.nativeStructuredOutputSupport('deepseek-chat')).toBe('downgraded');
  });
  it('Groq is per-model: openai/gpt-oss-* → schema, llama/etc → downgraded (live-verified)', () => {
    const p = new OpenAICompatibleProvider({ apiKey: 'k', profile: GROQ_PROFILE });
    expect(p.nativeStructuredOutputSupport('openai/gpt-oss-20b')).toBe('schema');
    expect(p.nativeStructuredOutputSupport('llama-3.1-8b-instant')).toBe('downgraded');
  });
});
