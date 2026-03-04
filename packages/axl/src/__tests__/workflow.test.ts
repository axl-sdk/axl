import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { workflow } from '../workflow.js';

describe('workflow()', () => {
  it('creates a workflow with correct name', () => {
    const wf = workflow({
      name: 'test-workflow',
      input: z.object({ text: z.string() }),
      handler: async () => 'result',
    });
    expect(wf.name).toBe('test-workflow');
  });

  it('creates a workflow with correct inputSchema', () => {
    const inputSchema = z.object({ text: z.string() });
    const wf = workflow({
      name: 'test',
      input: inputSchema,
      handler: async () => 'result',
    });
    expect(wf.inputSchema).toBe(inputSchema);
  });

  it('creates a workflow with correct outputSchema', () => {
    const outputSchema = z.object({ answer: z.string() });
    const wf = workflow({
      name: 'test',
      input: z.object({ text: z.string() }),
      output: outputSchema,
      handler: async () => ({ answer: 'hello' }),
    });
    expect(wf.outputSchema).toBe(outputSchema);
  });

  it('outputSchema is undefined when not provided', () => {
    const wf = workflow({
      name: 'test',
      input: z.object({ text: z.string() }),
      handler: async () => 'result',
    });
    expect(wf.outputSchema).toBeUndefined();
  });

  it('creates a workflow with correct handler', () => {
    const handler = async () => 'result';
    const wf = workflow({
      name: 'test',
      input: z.object({}),
      handler,
    });
    expect(wf.handler).toBe(handler);
  });

  it('handler receives context and can produce output', async () => {
    const wf = workflow({
      name: 'test',
      input: z.object({ x: z.number() }),
      output: z.object({ doubled: z.number() }),
      handler: async (ctx) => {
        return { doubled: (ctx.input as { x: number }).x * 2 };
      },
    });

    // Verify handler is callable
    const mockCtx = { input: { x: 5 } } as any;
    const result = await wf.handler(mockCtx);
    expect(result).toEqual({ doubled: 10 });
  });
});
