import { describe, it, expect } from 'vitest';
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
