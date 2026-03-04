import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { tool } from '../tool.js';

describe('tool()', () => {
  const inputSchema = z.object({
    query: z.string(),
    limit: z.number().optional(),
  });

  const basicTool = tool({
    name: 'search',
    description: 'Search for documents',
    input: inputSchema,
    handler: async (input) => {
      return { results: [`result for ${input.query}`] };
    },
  });

  // ── Creation ────────────────────────────────────────────────────────────

  it('creates a tool with correct name', () => {
    expect(basicTool.name).toBe('search');
  });

  it('creates a tool with correct description', () => {
    expect(basicTool.description).toBe('Search for documents');
  });

  it('creates a tool with correct inputSchema', () => {
    expect(basicTool.inputSchema).toBe(inputSchema);
  });

  it('defaults sensitive flag to false', () => {
    expect(basicTool.sensitive).toBe(false);
  });

  it('sets sensitive flag when provided', () => {
    const sensitiveTool = tool({
      name: 'secret',
      description: 'A sensitive tool',
      input: z.object({ token: z.string() }),
      handler: async () => 'secret-result',
      sensitive: true,
    });
    expect(sensitiveTool.sensitive).toBe(true);
  });

  it('exposes retry policy with defaults', () => {
    expect(basicTool.retry).toEqual({
      attempts: 1,
      backoff: 'exponential',
      on: undefined,
    });
  });

  // ── _execute() input validation ─────────────────────────────────────────

  it('_execute() validates input and passes valid data to handler', async () => {
    const result = await basicTool._execute({ query: 'hello' });
    expect(result).toEqual({ results: ['result for hello'] });
  });

  it('_execute() throws ZodError on invalid input', async () => {
    await expect(basicTool._execute({ query: 123 })).rejects.toThrow();
  });

  it('_execute() throws ZodError when required fields are missing', async () => {
    await expect(basicTool._execute({})).rejects.toThrow();
  });

  // ── _execute() handler return ────────────────────────────────────────────

  it('_execute() calls handler and returns its result', async () => {
    const handler = vi.fn().mockResolvedValue({ data: 42 });
    const t = tool({
      name: 'calc',
      description: 'Calculate',
      input: z.object({ x: z.number() }),
      handler,
    });

    const result = await t._execute({ x: 10 });
    expect(handler).toHaveBeenCalledWith({ x: 10 });
    expect(result).toEqual({ data: 42 });
  });

  // ── Retry logic ──────────────────────────────────────────────────────────

  it('retries on failure up to attempts times', async () => {
    let callCount = 0;
    const t = tool({
      name: 'flaky',
      description: 'Flaky tool',
      input: z.object({}),
      handler: async () => {
        callCount++;
        if (callCount < 3) throw new Error('transient failure');
        return 'success';
      },
      retry: { attempts: 3, backoff: 'none' },
    });

    const result = await t._execute({});
    expect(result).toBe('success');
    expect(callCount).toBe(3);
  });

  it('throws after exhausting all retry attempts', async () => {
    let callCount = 0;
    const t = tool({
      name: 'always-fails',
      description: 'Always fails',
      input: z.object({}),
      handler: async () => {
        callCount++;
        throw new Error('permanent failure');
      },
      retry: { attempts: 3, backoff: 'none' },
    });

    await expect(t._execute({})).rejects.toThrow('permanent failure');
    expect(callCount).toBe(3);
  });

  it('respects the on predicate -- only retries matching errors', async () => {
    let callCount = 0;
    const t = tool({
      name: 'selective-retry',
      description: 'Retries only 500 errors',
      input: z.object({}),
      handler: async () => {
        callCount++;
        const err = new Error('server error') as Error & { status?: number };
        err.status = callCount === 1 ? 500 : 400;
        throw err;
      },
      retry: {
        attempts: 5,
        backoff: 'none',
        on: (err) => err.status === 500,
      },
    });

    // First call: status 500 -> retried
    // Second call: status 400 -> on() returns false, stops retrying
    await expect(t._execute({})).rejects.toThrow('server error');
    expect(callCount).toBe(2);
  });

  it('does not retry when on predicate returns false on first failure', async () => {
    let callCount = 0;
    const t = tool({
      name: 'no-retry',
      description: 'No retry',
      input: z.object({}),
      handler: async () => {
        callCount++;
        throw new Error('not retryable');
      },
      retry: {
        attempts: 5,
        backoff: 'none',
        on: () => false,
      },
    });

    await expect(t._execute({})).rejects.toThrow('not retryable');
    expect(callCount).toBe(1);
  });

  it('exponential backoff increases delays between retries', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const delays: number[] = [];
    let lastCallTime = Date.now();

    const t = tool({
      name: 'backoff-test',
      description: 'Backoff test',
      input: z.object({}),
      handler: async () => {
        const now = Date.now();
        if (callCount > 0) {
          delays.push(now - lastCallTime);
        }
        lastCallTime = now;
        callCount++;
        if (callCount < 4) throw new Error('retry');
        return 'done';
      },
      retry: { attempts: 4, backoff: 'exponential' },
    });

    const resultPromise = t._execute({});

    // Advance timers through each retry backoff:
    // attempt 1 fails -> backoff 2^0 * 1000 = 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    // attempt 2 fails -> backoff 2^1 * 1000 = 2000ms
    await vi.advanceTimersByTimeAsync(2000);
    // attempt 3 fails -> backoff 2^2 * 1000 = 4000ms
    await vi.advanceTimersByTimeAsync(4000);

    const result = await resultPromise;
    expect(result).toBe('done');
    expect(callCount).toBe(4);
    // Verify delays increase: 1000, 2000, 4000
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
    expect(delays[2]).toBe(4000);

    vi.useRealTimers();
  });

  // ── maxStringLength ──────────────────────────────────────────────────────

  it('rejects string exceeding default 10,000 char limit', async () => {
    const longString = 'a'.repeat(10_001);
    await expect(basicTool._execute({ query: longString })).rejects.toThrow(
      /exceeds maximum length/,
    );
  });

  it('allows string within custom max', async () => {
    const t = tool({
      name: 'custom-max',
      description: 'Custom max',
      input: z.object({ text: z.string() }),
      handler: async (input) => input.text,
      maxStringLength: 50,
    });

    const result = await t._execute({ text: 'a'.repeat(50) });
    expect(result).toBe('a'.repeat(50));
  });

  it('rejects string exceeding custom max', async () => {
    const t = tool({
      name: 'custom-max',
      description: 'Custom max',
      input: z.object({ text: z.string() }),
      handler: async (input) => input.text,
      maxStringLength: 50,
    });

    await expect(t._execute({ text: 'a'.repeat(51) })).rejects.toThrow(/exceeds maximum length/);
  });

  it('rejects nested strings exceeding max', async () => {
    const t = tool({
      name: 'nested-max',
      description: 'Nested max',
      input: z.object({ data: z.object({ inner: z.string() }) }),
      handler: async (input) => input.data.inner,
      maxStringLength: 20,
    });

    await expect(t._execute({ data: { inner: 'a'.repeat(21) } })).rejects.toThrow(
      /exceeds maximum length/,
    );
  });

  it('disables string length check when maxStringLength: 0', async () => {
    const t = tool({
      name: 'no-limit',
      description: 'No limit',
      input: z.object({ text: z.string() }),
      handler: async (input) => input.text,
      maxStringLength: 0,
    });

    const longString = 'a'.repeat(100_000);
    const result = await t._execute({ text: longString });
    expect(result).toBe(longString);
  });

  // ── run() ────────────────────────────────────────────────────────────────

  it('run() calls _execute and logs success trace via ctx.log()', async () => {
    const logFn = vi.fn();
    const ctx = { log: logFn } as any;

    const result = await basicTool.run(ctx, { query: 'test' });
    expect(result).toEqual({ results: ['result for test'] });
    expect(logFn).toHaveBeenCalledWith(
      'tool_call_complete',
      expect.objectContaining({
        tool: 'search',
        duration: expect.any(Number),
      }),
    );
  });

  it('run() logs error trace and rethrows when handler fails', async () => {
    const logFn = vi.fn();
    const ctx = { log: logFn } as any;

    const failingTool = tool({
      name: 'fail',
      description: 'Fails',
      input: z.object({}),
      handler: async () => {
        throw new Error('boom');
      },
    });

    await expect(failingTool.run(ctx, {})).rejects.toThrow('boom');
    expect(logFn).toHaveBeenCalledWith(
      'tool_call_error',
      expect.objectContaining({
        tool: 'fail',
        error: 'boom',
        duration: expect.any(Number),
      }),
    );
  });
});
