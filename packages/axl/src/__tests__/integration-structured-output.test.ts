import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkflowContext } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';
import type { AxlEvent, AxlEventOf, AskOptions } from '../types.js';

// ---------------------------------------------------------------------------
// Spec 22 — LIVE-API integration for the structured-output / ctx.ask pipeline.
//
// Exercises the REAL wire behavior MockProvider can't:
//   - do real models follow the `$ref`/`$defs`-hoisted prompt rendering? (Phase 1)
//   - does each provider ACCEPT the derived native `json_schema`, or 400? does
//     the capability truth-table (schema/downgraded/lossy/unsupported) match the
//     wire, across BOTH native adapters (OpenAI/Anthropic/Gemini) and the
//     OpenAI-compatible engine? (Phase 3, F1/F3)
//   - does an `io:'input'` prompt for a `.transform()` schema parse on a real
//     model, and does the transform flow downstream? (Phase 1/4 fix)
//   - do `schemaPrompt:'none'` / custom render still yield parseable output?
//
// Each block is gated on its API key; the default `pnpm test` skips them all.
// Tiny payloads, cheapest models, temperature 0. Run: `pnpm test:integration`.
// ---------------------------------------------------------------------------

function ctxLive() {
  const events: AxlEvent[] = [];
  // A bare registry lazy-instantiates the native adapters + OpenAI-compatible
  // profiles from the env keys the integration config loaded.
  const registry = new ProviderRegistry();
  const ctx = new WorkflowContext({
    input: 'x',
    executionId: `int-${randomUUID()}`,
    config: {},
    providerRegistry: registry,
    onTrace: (e) => events.push(e),
  });
  return { ctx, events };
}

function diagnostics(events: AxlEvent[]): AxlEventOf<'schema_diagnostic'>[] {
  return events.filter((e): e is AxlEventOf<'schema_diagnostic'> => e.type === 'schema_diagnostic');
}

const tiny: AskOptions<unknown> = { maxTokens: 400, temperature: 0, retries: 2 };

const Sentiment = z.object({
  sentiment: z.enum(['positive', 'negative', 'neutral']),
  score: z.number(),
});

type Tier = 'schema' | 'downgraded' | 'lossy' | 'unsupported';

// Every provider reachable from the repo .env, its cheapest model, and the
// native-output tier we expect the resolved adapter to report. If the wire
// disagrees (e.g. a 400 on json_schema, or a diagnostic that shouldn't fire),
// the test fails — which is exactly how the Groq per-model bug was caught.
const MATRIX: Array<{ key: string; uri: string; tier: Tier }> = [
  { key: 'OPENAI_API_KEY', uri: 'openai:gpt-4.1-nano', tier: 'schema' },
  { key: 'ANTHROPIC_API_KEY', uri: 'anthropic:claude-haiku-4-5', tier: 'unsupported' },
  { key: 'GOOGLE_API_KEY', uri: 'google:gemini-3.5-flash-lite', tier: 'lossy' },
  { key: 'DEEPSEEK_API_KEY', uri: 'deepseek:deepseek-v4-flash', tier: 'downgraded' },
  { key: 'GROQ_API_KEY', uri: 'groq:llama-3.1-8b-instant', tier: 'downgraded' },
  { key: 'GROQ_API_KEY', uri: 'groq:openai/gpt-oss-20b', tier: 'schema' },
  { key: 'MISTRAL_API_KEY', uri: 'mistral:mistral-small-latest', tier: 'schema' },
  { key: 'OPENROUTER_API_KEY', uri: 'openrouter:openai/gpt-4o-mini', tier: 'schema' },
  { key: 'XAI_API_KEY', uri: 'xai:grok-4.20', tier: 'schema' },
];

for (const m of MATRIX) {
  describe.skipIf(!process.env[m.key])(`spec22 live: ${m.uri}`, () => {
    it('prompt-guided structured output parses a flat schema', async () => {
      const { ctx } = ctxLive();
      const a = agent({ name: 'sent', model: m.uri, system: 'You classify sentiment.' });
      const r = await ctx.ask(a, 'Classify: "I absolutely love this, best purchase ever!"', {
        ...tiny,
        schema: Sentiment,
      });
      expect(['positive', 'negative', 'neutral']).toContain(r.sentiment);
      expect(typeof r.score).toBe('number');
    });

    it(`nativeStructuredOutput: wire-accepted, proceeds, tier = ${m.tier}`, async () => {
      const { ctx, events } = ctxLive();
      const a = agent({ name: 'nat', model: m.uri, system: 'You classify sentiment.' });
      // The load-bearing assertion: sending the derived native json_schema does
      // NOT throw (a 400 would reject here) and still yields parseable output —
      // whether the provider honors, downgrades, sanitizes, or ignores it.
      const r = await ctx.ask(a, 'Classify: "This is terrible and broke immediately."', {
        ...tiny,
        schema: Sentiment,
        nativeStructuredOutput: true,
      });
      expect(['positive', 'negative', 'neutral']).toContain(r.sentiment);

      const nd = diagnostics(events).filter((e) => e.data.kind === 'native_output_unsupported');
      if (m.tier === 'schema') {
        expect(nd).toHaveLength(0); // honored natively → no warning
      } else {
        expect(nd).toHaveLength(1);
        expect(nd[0].data).toMatchObject({ support: m.tier });
      }
    });
  });
}

// ── $ref-hoisted union prompt parse-rate (Phase 1, AC-J1b real-world) ───────

describe.skipIf(!process.env.OPENAI_API_KEY)('spec22 live: $ref-hoisted union prompt', () => {
  const Money = z.object({
    amount: z.number().describe('numeric amount'),
    currency: z.string().describe('ISO 4217 code'),
  });
  // Shared `Money` across arms → `renderSchemaForPrompt` hoists it to $defs/$ref.
  const Union = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('order'), total: Money, tax: Money }),
    z.object({ kind: z.literal('refund'), refunded: Money, fee: Money }),
    z.object({ kind: z.literal('quote'), subtotal: Money, discount: Money }),
  ]);

  it('a real model follows the $ref/$defs indirection and emits the requested arm', async () => {
    const { ctx } = ctxLive();
    const a = agent({ name: 'u', model: 'openai:gpt-4.1-nano', system: 'Output structured data.' });
    const r = await ctx.ask(a, 'Produce a REFUND record: refunded 50 USD, fee 5 USD.', {
      ...tiny,
      schema: Union,
    });
    expect(r.kind).toBe('refund');
    if (r.kind === 'refund') {
      expect(r.refunded.currency).toBe('USD');
      expect(r.refunded.amount).toBe(50);
    }
  });
});

// ── .transform() input-side rendering (Phase 1/4 fix) ───────────────────────

describe.skipIf(!process.env.OPENAI_API_KEY)(
  'spec22 live: .transform() input-side rendering',
  () => {
    const uri = 'openai:gpt-4.1-nano';
    const Contact = z
      .object({ name: z.string(), email: z.string() })
      .transform((c) => ({ ...c, domain: c.email.split('@')[1] ?? '' }));

    it('prompt-guided: model produces the INPUT shape; transform derives downstream', async () => {
      const { ctx } = ctxLive();
      const a = agent({ name: 't', model: uri, system: 'Extract the contact.' });
      const r = await ctx.ask(a, 'Extract: Jane Doe, jane@acme.io', { ...tiny, schema: Contact });
      expect(r.name.toLowerCase()).toContain('jane');
      expect(r.domain).toBe('acme.io'); // only present if the transform ran on parsed input
    });

    it('native: the derived INPUT-side json_schema is accepted (not empty {}) and parses', async () => {
      const { ctx } = ctxLive();
      const a = agent({ name: 'tn', model: uri, system: 'Extract the contact.' });
      const r = await ctx.ask(a, 'Extract: Bob Roe, bob@example.com', {
        ...tiny,
        schema: Contact,
        nativeStructuredOutput: true,
      });
      expect(r.domain).toBe('example.com');
    });
  },
);

// ── schemaPrompt modes end-to-end ───────────────────────────────────────────

describe.skipIf(!process.env.OPENAI_API_KEY)('spec22 live: schemaPrompt modes', () => {
  const uri = 'openai:gpt-4.1-nano';

  it("'none' — parse gate enforced with zero appended schema text", async () => {
    const { ctx, events } = ctxLive();
    const a = agent({
      name: 'n',
      model: uri,
      system: 'Reply ONLY with JSON: {"sentiment":"positive"|"negative"|"neutral","score":<0-1>}.',
    });
    const r = await ctx.ask(a, 'Classify: "It was fine, nothing special."', {
      ...tiny,
      schema: Sentiment,
      schemaPrompt: 'none',
    });
    expect(['positive', 'negative', 'neutral']).toContain(r.sentiment);
    // R7 diagnostic fired (zero guidance).
    expect(diagnostics(events).some((e) => e.data.kind === 'schema_prompt_none_no_guidance')).toBe(
      true,
    );
  });

  it('custom { render } — model follows custom guidance and output parses', async () => {
    const { ctx } = ctxLive();
    const a = agent({ name: 'c', model: uri, system: 'You classify sentiment.' });
    const r = await ctx.ask(a, 'Classify: "Best day of my life!"', {
      ...tiny,
      schema: Sentiment,
      schemaPrompt: {
        render:
          'Respond as JSON with keys "sentiment" (positive/negative/neutral) and "score" (0..1).',
      },
    });
    expect(r.sentiment).toBe('positive');
  });
});
