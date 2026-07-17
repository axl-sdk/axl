import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import type { Tool, ToolModelOutput } from '../tool.js';

describe('ToolModelOutput types', () => {
  it('infers sync and async handler outputs as shallow readonly mapper inputs', () => {
    interface Result {
      humanMessage: string;
      internalId: string;
      nested: { mutableAtRuntime: boolean };
    }

    const syncTool = tool({
      name: 'sync',
      description: 'sync',
      input: z.object({ id: z.string() }),
      handler: ({ id }): Result => ({
        humanMessage: `Found ${id}`,
        internalId: id,
        nested: { mutableAtRuntime: true },
      }),
      toModelOutput(output) {
        expectTypeOf(output).toEqualTypeOf<Readonly<Result>>();
        return { message: output.humanMessage };
      },
    });

    const asyncTool = tool({
      name: 'async',
      description: 'async',
      input: z.object({}),
      handler: async () => ({ value: 42, secret: 'hidden' }),
      toModelOutput(output) {
        expectTypeOf(output).toEqualTypeOf<Readonly<{ value: number; secret: string }>>();
        return [output.value, null, true];
      },
    });

    expectTypeOf(syncTool.run).returns.toEqualTypeOf<Promise<Result>>();
    expectTypeOf(asyncTool._execute).returns.toEqualTypeOf<
      Promise<{ value: number; secret: string }>
    >();

    const concreteTools: Tool[] = [syncTool, asyncTool];
    agent({ model: 'mock:model', system: 'test', tools: concreteTools });

    const unprojectedTool = tool({
      name: 'unprojected',
      description: 'unprojected',
      input: z.object({}),
      handler: () => ({ complete: true as const, count: 1 }),
    });
    expectTypeOf(unprojectedTool.run).returns.toEqualTypeOf<
      Promise<{ complete: true; count: number }>
    >();
    expectTypeOf(unprojectedTool._execute).returns.toEqualTypeOf<
      Promise<{ complete: true; count: number }>
    >();
  });

  it('accepts the supported recursive output surface', () => {
    const values = [
      'verbatim',
      1,
      true,
      null,
      [1, 'two', false, null],
      { text: 'visible', omitted: undefined, nested: { ok: true } },
    ] satisfies ToolModelOutput[];

    expectTypeOf(values).toMatchTypeOf<ToolModelOutput[]>();
  });

  it('rejects unsupported mapper return types', () => {
    const base = {
      name: 'invalid',
      description: 'invalid',
      input: z.object({}),
      handler: () => ({ value: 1 }),
    };

    tool({
      ...base,
      // @ts-expect-error top-level undefined is not model output
      toModelOutput: () => undefined,
    });
    tool({
      ...base,
      // @ts-expect-error bigint is not JSON-compatible
      toModelOutput: () => 1n,
    });
    tool({
      ...base,
      // @ts-expect-error symbols are not JSON-compatible
      toModelOutput: () => Symbol('invalid'),
    });
    tool({
      ...base,
      // @ts-expect-error functions are not JSON-compatible
      toModelOutput: () => () => 'invalid',
    });
    tool({
      ...base,
      // @ts-expect-error Date instances are not model output records
      toModelOutput: () => new Date(),
    });
    tool({
      ...base,
      // @ts-expect-error asynchronous projectors are intentionally unsupported in v1
      toModelOutput: async () => 'invalid',
    });
  });
});
