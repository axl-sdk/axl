import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { dataset } from '../dataset.js';

describe('dataset()', () => {
  it('creates a dataset with name and schema', () => {
    const ds = dataset({
      name: 'my-dataset',
      schema: z.object({ question: z.string() }),
      items: [],
    });

    expect(ds.name).toBe('my-dataset');
    expect(ds.schema).toBeDefined();
  });

  it('getItems() returns validated inline items', async () => {
    const ds = dataset({
      name: 'inline-ds',
      schema: z.object({ question: z.string() }),
      items: [{ input: { question: 'What is 1+1?' } }, { input: { question: 'What is 2+2?' } }],
    });

    const items = await ds.getItems();
    expect(items).toHaveLength(2);
    expect(items[0].input).toEqual({ question: 'What is 1+1?' });
    expect(items[1].input).toEqual({ question: 'What is 2+2?' });
  });

  it('getItems() throws on invalid items (Zod validation)', async () => {
    const ds = dataset({
      name: 'bad-ds',
      schema: z.object({ question: z.string() }),
      items: [
        // @ts-expect-error - deliberately passing invalid input to test runtime validation
        { input: { question: 42 } },
      ],
    });

    await expect(ds.getItems()).rejects.toThrow();
  });

  it('getItems() returns empty array when no items or file provided', async () => {
    const ds = dataset({
      name: 'empty-ds',
      schema: z.object({ question: z.string() }),
    });

    await expect(ds.getItems()).rejects.toThrow('either "items" or "file" must be provided');
  });

  it('passes through annotations when provided', async () => {
    const ds = dataset({
      name: 'annotated-ds',
      schema: z.object({ question: z.string() }),
      annotations: z.object({ answer: z.string() }),
      items: [
        { input: { question: 'What is 1+1?' }, annotations: { answer: '2' } },
        { input: { question: 'What is 2+2?' }, annotations: { answer: '4' } },
      ],
    });

    const items = await ds.getItems();
    expect(items).toHaveLength(2);
    expect(items[0].annotations).toEqual({ answer: '2' });
    expect(items[1].annotations).toEqual({ answer: '4' });
  });

  it('validates annotations against annotations schema', async () => {
    const ds = dataset({
      name: 'bad-annotations-ds',
      schema: z.object({ question: z.string() }),
      annotations: z.object({ answer: z.string() }),
      items: [
        // @ts-expect-error - deliberately passing invalid annotations
        { input: { question: 'What is 1+1?' }, annotations: { answer: 123 } },
      ],
    });

    await expect(ds.getItems()).rejects.toThrow();
  });

  it('exposes annotationsSchema when annotations config is provided', () => {
    const annotationsSchema = z.object({ answer: z.string() });
    const ds = dataset({
      name: 'schema-ds',
      schema: z.object({ question: z.string() }),
      annotations: annotationsSchema,
      items: [],
    });

    expect(ds.annotationsSchema).toBe(annotationsSchema);
  });

  it('annotationsSchema is undefined when no annotations config is provided', () => {
    const ds = dataset({
      name: 'no-annotations-ds',
      schema: z.object({ question: z.string() }),
      items: [],
    });

    expect(ds.annotationsSchema).toBeUndefined();
  });

  it('items without annotations have undefined annotations field', async () => {
    const ds = dataset({
      name: 'no-ann-items',
      schema: z.object({ question: z.string() }),
      items: [{ input: { question: 'What is 1+1?' } }],
    });

    const items = await ds.getItems();
    expect(items[0].annotations).toBeUndefined();
  });

  it('loads items from a JSON file', async () => {
    const { writeFile, mkdir, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmpDir = join(tmpdir(), `axl-test-dataset-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const filePath = join(tmpDir, 'test-data.json');

    const items = [
      { input: { question: 'What is 1+1?' }, annotations: { answer: '2' } },
      { input: { question: 'What is 2+2?' }, annotations: { answer: '4' } },
    ];
    await writeFile(filePath, JSON.stringify(items), 'utf-8');

    try {
      const ds = dataset({
        name: 'file-ds',
        schema: z.object({ question: z.string() }),
        annotations: z.object({ answer: z.string() }),
        file: filePath,
      });

      const loaded = await ds.getItems();
      expect(loaded).toHaveLength(2);
      expect(loaded[0].input).toEqual({ question: 'What is 1+1?' });
      expect(loaded[0].annotations).toEqual({ answer: '2' });
      expect(loaded[1].input).toEqual({ question: 'What is 2+2?' });
      expect(loaded[1].annotations).toEqual({ answer: '4' });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('validates schema strictly (extra fields stripped or accepted depending on schema)', async () => {
    const strictSchema = z.object({ question: z.string() }).strict();
    const ds = dataset({
      name: 'strict-ds',
      schema: strictSchema,
      items: [
        // @ts-expect-error - testing strict validation with extra fields
        { input: { question: 'Hello', extra: 'field' } },
      ],
    });

    await expect(ds.getItems()).rejects.toThrow();
  });
});

describe('dataset() — extra annotation key detection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns by default when an annotation key is dropped by the schema, and strips it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ds = dataset({
      name: 'drop-ds',
      schema: z.object({ question: z.string() }),
      annotations: z.object({ answer: z.string() }),
      items: [
        // expectedTone is not in the annotations schema → silently stripped.
        // TS's excess-property check catches this for inline literals, but NOT
        // for variable-sourced or file-based datasets — which is exactly what
        // the runtime warning exists to cover.
        // @ts-expect-error - deliberately undeclared annotation key
        { input: { question: 'Q' }, annotations: { answer: '2', expectedTone: 'formal' } },
      ],
    });

    const items = await ds.getItems();
    // The undeclared key is stripped from what reaches scorers.
    expect(items[0].annotations).toEqual({ answer: '2' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('expectedTone');
    expect(warn.mock.calls[0][0]).toContain('drop-ds');
  });

  it('emits a single consolidated warning across many items', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ds = dataset({
      name: 'multi-ds',
      schema: z.object({ q: z.string() }),
      annotations: z.object({ a: z.string() }),
      items: Array.from({ length: 50 }, (_, i) => ({
        input: { q: `Q${i}` },
        annotations: { a: 'x', extra: 'y' },
      })),
    });

    await ds.getItems();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports nested dropped key paths', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ds = dataset({
      name: 'nested-ds',
      schema: z.object({ q: z.string() }),
      annotations: z.object({ persona: z.object({ name: z.string() }) }),
      items: [
        // @ts-expect-error - deliberately undeclared nested annotation key
        { input: { q: 'Q' }, annotations: { persona: { name: 'Ada', role: 'analyst' } } },
      ],
    });

    await ds.getItems();
    expect(warn.mock.calls[0][0]).toContain('persona.role');
  });

  it("throws under onExtraAnnotationKeys: 'error', listing the dropped keys", async () => {
    const ds = dataset({
      name: 'strict-ann-ds',
      schema: z.object({ q: z.string() }),
      annotations: z.object({ a: z.string() }),
      onExtraAnnotationKeys: 'error',
      // @ts-expect-error - deliberately undeclared annotation key
      items: [{ input: { q: 'Q' }, annotations: { a: 'x', typo: 'z' } }],
    });

    await expect(ds.getItems()).rejects.toThrow(/typo/);
  });

  it("stays silent under onExtraAnnotationKeys: 'ignore'", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ds = dataset({
      name: 'ignore-ds',
      schema: z.object({ q: z.string() }),
      annotations: z.object({ a: z.string() }),
      onExtraAnnotationKeys: 'ignore',
      // @ts-expect-error - deliberately undeclared annotation key
      items: [{ input: { q: 'Q' }, annotations: { a: 'x', extra: 'y' } }],
    });

    const items = await ds.getItems();
    expect(items[0].annotations).toEqual({ a: 'x' }); // still stripped
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn when annotations exactly match the schema', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ds = dataset({
      name: 'exact-ds',
      schema: z.object({ q: z.string() }),
      annotations: z.object({ a: z.string() }),
      items: [{ input: { q: 'Q' }, annotations: { a: 'x' } }],
    });

    await ds.getItems();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn for a loose annotations schema (nothing is dropped)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ds = dataset({
      name: 'loose-ds',
      schema: z.object({ q: z.string() }),
      annotations: z.looseObject({ a: z.string() }),
      items: [{ input: { q: 'Q' }, annotations: { a: 'x', extra: 'y' } }],
    });

    const items = await ds.getItems();
    expect(items[0].annotations).toEqual({ a: 'x', extra: 'y' }); // preserved
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn about extra INPUT keys (detection is scoped to annotations)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ds = dataset({
      name: 'input-extra-ds',
      schema: z.object({ q: z.string() }),
      annotations: z.object({ a: z.string() }),
      items: [
        // input has an undeclared field; annotations are clean
        // @ts-expect-error - deliberately extra input field
        { input: { q: 'Q', extra: 'ignored' }, annotations: { a: 'x' } },
      ],
    });

    await ds.getItems();
    expect(warn).not.toHaveBeenCalled();
  });

  it('detects dropped annotation keys loaded from a JSON file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { writeFile, mkdir, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmpDir = join(tmpdir(), `axl-test-dataset-drop-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    const filePath = join(tmpDir, 'data.json');
    await writeFile(
      filePath,
      JSON.stringify([{ input: { q: 'Q' }, annotations: { a: 'x', unschematized: true } }]),
      'utf-8',
    );

    try {
      const ds = dataset({
        name: 'file-drop-ds',
        schema: z.object({ q: z.string() }),
        annotations: z.object({ a: z.string() }),
        file: filePath,
      });
      await ds.getItems();
      expect(warn.mock.calls[0][0]).toContain('unschematized');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
