import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from '../context.js';

describe('zodToJsonSchema', () => {
  // ── Basics ──────────────────────────────────────────────────────────────

  it('converts string schema', () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: 'string' });
  });

  it('converts number schema', () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: 'number' });
  });

  it('converts boolean schema', () => {
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean' });
  });

  // ── Objects ─────────────────────────────────────────────────────────────

  it('converts object with required fields', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = zodToJsonSchema(schema) as Record<string, unknown>;

    expect(result.type).toBe('object');
    expect(result.properties).toEqual({
      name: { type: 'string' },
      age: { type: 'number' },
    });
    expect(result.required).toEqual(['name', 'age']);
  });

  it('marks optional fields as not required', () => {
    const schema = z.object({ name: z.string(), bio: z.string().optional() });
    const result = zodToJsonSchema(schema) as Record<string, unknown>;

    expect(result.required).toEqual(['name']);
  });

  it('emits additionalProperties: false on objects', () => {
    const schema = z.object({ x: z.string() });
    const result = zodToJsonSchema(schema) as Record<string, unknown>;

    expect(result.additionalProperties).toBe(false);
  });

  // ── Arrays ──────────────────────────────────────────────────────────────

  it('converts array schema', () => {
    const result = zodToJsonSchema(z.array(z.string())) as Record<string, unknown>;

    expect(result.type).toBe('array');
    expect(result.items).toEqual({ type: 'string' });
  });

  // ── Enums ───────────────────────────────────────────────────────────────

  it('converts enum schema', () => {
    const result = zodToJsonSchema(z.enum(['a', 'b', 'c'])) as Record<string, unknown>;

    expect(result.type).toBe('string');
    expect(result.enum).toEqual(['a', 'b', 'c']);
  });

  // ── Nullable ────────────────────────────────────────────────────────────

  it('converts nullable using anyOf with null type', () => {
    const result = zodToJsonSchema(z.string().nullable()) as Record<string, unknown>;

    expect(result.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
    // Should NOT use the old nullable: true convention
    expect(result).not.toHaveProperty('nullable');
  });

  // ── Unions ──────────────────────────────────────────────────────────────

  it('converts union schema', () => {
    const result = zodToJsonSchema(z.union([z.string(), z.number()])) as Record<string, unknown>;

    expect(result.anyOf).toEqual([{ type: 'string' }, { type: 'number' }]);
  });

  // ── Defaults ────────────────────────────────────────────────────────────

  it('includes default annotation for default values', () => {
    const schema = z.object({ limit: z.number().default(10) });
    const result = zodToJsonSchema(schema) as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(result.properties.limit.default).toBe(10);
  });

  // ── Described ───────────────────────────────────────────────────────────

  it('includes description from .describe()', () => {
    const schema = z.object({ query: z.string().describe('The search query') });
    const result = zodToJsonSchema(schema) as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(result.properties.query.description).toBe('The search query');
  });

  // ── Nested ──────────────────────────────────────────────────────────────

  it('handles nested objects', () => {
    const schema = z.object({
      user: z.object({ name: z.string() }),
    });
    const result = zodToJsonSchema(schema) as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(result.properties.user).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    });
  });

  // ── Provider compatibility ──────────────────────────────────────────────

  it('does NOT include $schema key (would break provider tool definitions)', () => {
    const schema = z.object({ name: z.string() });
    const result = zodToJsonSchema(schema) as Record<string, unknown>;

    expect(result).not.toHaveProperty('$schema');
  });

  it('produces valid tool parameter schema shape', () => {
    // This schema represents a realistic tool input
    const schema = z.object({
      query: z.string().describe('Search query'),
      limit: z.number().optional(),
      filters: z.array(z.string()).optional(),
      format: z.enum(['json', 'text']),
    });
    const result = zodToJsonSchema(schema) as Record<string, unknown>;

    // Must be a plain object schema — no $schema, no $ref
    expect(result).not.toHaveProperty('$schema');
    expect(result).not.toHaveProperty('$ref');
    expect(result.type).toBe('object');
    expect(result.additionalProperties).toBe(false);

    // Required should only include non-optional fields
    expect(result.required).toEqual(expect.arrayContaining(['query', 'format']));
    expect(result.required).not.toContain('limit');
    expect(result.required).not.toContain('filters');
  });
});
