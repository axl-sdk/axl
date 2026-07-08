import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { WorkflowContext } from '../context.js';
import { zodToJsonSchema } from '../context.js';
import { ProviderRegistry } from '../providers/registry.js';
import { agent } from '../agent.js';

// ── Minimal recording provider (mirrors context.test.ts's TestProvider) ──────

class RecordingProvider {
  readonly name = 'test';
  calls: Array<{ messages: Array<{ role: string; content: string }>; options: unknown }> = [];
  constructor(private content: string) {}
  async chat(messages: Array<{ role: string; content: string }>, options: unknown) {
    this.calls.push({ messages, options });
    return {
      content: this.content,
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      cost: 0.001,
    };
  }

  async *stream(messages: any[], options: any) {
    const resp = await this.chat(messages, options);
    yield { type: 'text_delta' as const, content: resp.content };
    yield { type: 'done' as const, usage: resp.usage };
  }
}

function createCtx(provider: RecordingProvider) {
  const registry = new ProviderRegistry();

  registry.registerInstance('test', provider as any);
  return new WorkflowContext({
    input: 'x',
    executionId: 'exec-1',
    config: { defaultProvider: 'test' },
    providerRegistry: registry,
  });
}

const testAgent = agent({ model: 'test:m', system: 's', tools: [] });

// ── Fixtures ────────────────────────────────────────────────────────────────

// Realistic shared sub-objects: most fields carry per-field guidance
// (`.describe()`). Descriptions are duplicated verbatim at EVERY inline
// occurrence — the dominant driver of the reporter's real-world bloat — but
// appear once under `$defs` when hoisted. This is what makes the archetype
// faithful rather than a toy.
const GeoPoint = z.object({
  latitude: z.number().describe('Decimal degrees, WGS84, north-positive'),
  longitude: z.number().describe('Decimal degrees, WGS84, east-positive'),
  accuracyMeters: z.number().describe('Horizontal accuracy radius in meters'),
});
const Address = z.object({
  street: z.string().describe('Primary street address line including house/building number'),
  street2: z.string().describe('Secondary line: apartment, suite, unit, or PO box'),
  city: z.string().describe('City, town, or locality name'),
  region: z.string().describe('State, province, or administrative region code'),
  postalCode: z.string().describe('Postal or ZIP code in the local format'),
  country: z.string().describe('ISO 3166-1 alpha-2 country code'),
  phone: z.string().describe('Contact phone number in E.164 international format'),
  email: z.string().describe('Contact email address for delivery notifications'),
  verified: z.boolean().describe('Whether the address passed postal validation'),
  geo: GeoPoint.describe('Geocoded coordinates for the address'),
});
const Money = z.object({
  amount: z.number().describe('Numeric amount in minor units (e.g. cents)'),
  currency: z.string().describe('ISO 4217 three-letter currency code'),
  displayLabel: z.string().describe('Human-readable formatted amount for display'),
  exchangeRate: z.number().describe('Rate used to convert to the account base currency'),
  taxIncluded: z.boolean().describe('Whether the amount is inclusive of applicable tax'),
});

/** 8-arm discriminated union whose arms all reuse Address/Money — the reporter's
 *  archetype where inline rendering duplicates the sub-objects 8×. */
const BigUnion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('order'), ship: Address, bill: Address, total: Money }),
  z.object({ kind: z.literal('refund'), origin: Address, total: Money, fee: Money }),
  z.object({ kind: z.literal('shipment'), from: Address, to: Address, insured: Money }),
  z.object({ kind: z.literal('invoice'), payer: Address, payee: Address, due: Money, paid: Money }),
  z.object({ kind: z.literal('quote'), site: Address, subtotal: Money, tax: Money }),
  z.object({ kind: z.literal('return'), warehouse: Address, credit: Money }),
  z.object({ kind: z.literal('transfer'), source: Address, dest: Address, moved: Money }),
  z.object({ kind: z.literal('adjustment'), location: Address, delta: Money }),
]);

const sampleAddress = {
  street: '1 Main',
  street2: 'Apt 2',
  city: 'Town',
  region: 'ST',
  postalCode: '00000',
  country: 'US',
  phone: '+15550000000',
  email: 'a@b.co',
  verified: true,
  geo: { latitude: 1, longitude: 2, accuracyMeters: 3 },
};
const sampleMoney = {
  amount: 1,
  currency: 'USD',
  displayLabel: '$1.00',
  exchangeRate: 1,
  taxIncluded: false,
};
const validRefund = { kind: 'refund', origin: sampleAddress, total: sampleMoney, fee: sampleMoney };

function appendedSchemaText(userContent: string): string {
  const marker = 'Respond with valid JSON matching this schema:\n';
  const idx = userContent.indexOf(marker);
  expect(idx).toBeGreaterThanOrEqual(0);
  return userContent.slice(idx + marker.length);
}

async function captureAppendedSchema(schema: z.ZodType, content = JSON.stringify(validRefund)) {
  const provider = new RecordingProvider(content);
  const ctx = createCtx(provider);
  await ctx.ask(testAgent, 'do it', { schema });
  const userMsg = [...provider.calls[0].messages].reverse().find((m) => m.role === 'user');
  return appendedSchemaText(userMsg!.content);
}

// ── AC-J1a: ≥10× token drop from R1+R2 combined ──────────────────────────────

describe('Phase 1 — prompt schema rendering (Problem A)', () => {
  it('AC-J1a: appended schema for the 8-arm union shrinks ≥10× vs the inline pretty baseline', async () => {
    // Baseline = pre-change rendering: inline (no $ref) + pretty-printed.
    const baseline = JSON.stringify(zodToJsonSchema(BigUnion), null, 2);
    const rendered = await captureAppendedSchema(BigUnion);
    // estimateTokens is len/4 (monotonic), so the char-length ratio IS the token ratio.
    expect(baseline.length / rendered.length).toBeGreaterThanOrEqual(10);
  });

  it('AC-J1a (R2 alone): compact stringify measurably reduces size vs pretty', () => {
    const inline = zodToJsonSchema(BigUnion);
    expect(JSON.stringify(inline).length).toBeLessThan(JSON.stringify(inline, null, 2).length);
  });

  it('R1: shared subschemas are hoisted into $defs/$ref on the prompt path', async () => {
    const rendered = await captureAppendedSchema(BigUnion);
    const parsed = JSON.parse(rendered) as Record<string, unknown>;
    expect(parsed.$defs).toBeDefined();
    expect(rendered).toContain('$ref');
  });

  it('R2: compact — no pretty-print indentation runs in the appended text', async () => {
    const rendered = await captureAppendedSchema(BigUnion);
    expect(rendered).not.toMatch(/\n {2,}/);
  });

  it('strips the $schema key from the prompt rendering', async () => {
    const rendered = await captureAppendedSchema(BigUnion);
    expect(rendered).not.toContain('$schema');
  });
});

// ── AC-J1b: parity — the ref rendering loses no schema information ────────────

describe('Phase 1 — parity (AC-J1b)', () => {
  it('every $ref resolves to a $def — no dangling references', async () => {
    const rendered = await captureAppendedSchema(BigUnion);
    const parsed = JSON.parse(rendered) as { $defs?: Record<string, unknown> };
    const defs = parsed.$defs ?? {};
    const refs = [...rendered.matchAll(/"\$ref":\s*"#\/\$defs\/([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const name of refs) expect(defs).toHaveProperty(name);
  });

  it('a valid object still parses through the schema gate with the new prompt', async () => {
    const provider = new RecordingProvider(JSON.stringify(validRefund));
    const ctx = createCtx(provider);
    const result = (await ctx.ask(testAgent, 'go', { schema: BigUnion })) as { kind: string };
    expect(result.kind).toBe('refund');
  });

  it('memoization: repeated conversion of the same schema identity returns the same object', () => {
    const s = z.object({ a: z.string() });
    expect(zodToJsonSchema(s)).toBe(zodToJsonSchema(s));
  });

  it('memoization: distinct schema identities do not collide', () => {
    const s1 = z.object({ a: z.string() });
    const s2 = z.object({ a: z.string() });
    expect(zodToJsonSchema(s1)).not.toBe(zodToJsonSchema(s2));
    expect(zodToJsonSchema(s1)).toEqual(zodToJsonSchema(s2));
  });
});

// ── AC-Gemini-noregress: the tool-def path stays inline (no $ref/$defs) ───────

describe('Phase 1 — Gemini no-regress (AC-Gemini-noregress)', () => {
  it('exported zodToJsonSchema (feeds tool defs) stays INLINE for shared-subschema schemas', () => {
    // Tool defs go through zodToJsonSchema, NOT renderSchemaForPrompt. Gemini's
    // sanitizeSchemaForGemini strips $ref/$defs; an inline schema has neither, so
    // the sanitized output stays byte-identical to today (no dangling refs).
    const toolSchema = z.object({ ship: Address, bill: Address, price: Money });
    const text = JSON.stringify(zodToJsonSchema(toolSchema));
    expect(text).not.toContain('$ref');
    expect(text).not.toContain('$defs');
  });
});
