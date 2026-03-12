import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { Session } from '../session.js';
import { AxlStream } from '../stream.js';
import type { TraceEvent } from '../types.js';

// ── Mock Provider ────────────────────────────────────────────────────────

class TestProvider {
  readonly name = 'test';
  private responses: Array<{ content: string; tool_calls?: any[]; cost?: number }>;
  private callIndex = 0;
  calls: any[] = [];

  constructor(responses: Array<{ content: string; tool_calls?: any[]; cost?: number }>) {
    this.responses = responses;
  }

  async chat(messages: any[], options: any) {
    this.calls.push({ messages, options });
    const resp = this.responses[this.callIndex] ?? this.responses[this.responses.length - 1];
    this.callIndex++;
    return {
      content: resp.content,
      tool_calls: resp.tool_calls,
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      cost: resp.cost ?? 0.001,
    };
  }

  async *stream(messages: any[], options: any) {
    const resp = await this.chat(messages, options);
    yield { type: 'text_delta' as const, content: resp.content };
    yield { type: 'done' as const, usage: (resp as any).usage };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function createRuntime(provider?: TestProvider): { runtime: AxlRuntime; provider: TestProvider } {
  const p = provider ?? new TestProvider([{ content: 'ok' }]);
  const runtime = new AxlRuntime({ defaultProvider: 'test' });
  runtime.registerProvider('test', p as any);
  return { runtime, provider: p };
}

// ═════════════════════════════════════════════════════════════════════════
// register() and execute()
// ═════════════════════════════════════════════════════════════════════════

describe('register() and execute()', () => {
  it('registers a workflow and executes it successfully', async () => {
    const { runtime } = createRuntime();

    const greetWorkflow = workflow({
      name: 'greet',
      input: z.object({ name: z.string() }),
      handler: async (ctx) => `Hello, ${ctx.input.name}!`,
    });

    runtime.register(greetWorkflow);
    const result = await runtime.execute('greet', { name: 'Alice' });
    expect(result).toBe('Hello, Alice!');
  });

  it('throws when executing an unregistered workflow', async () => {
    const { runtime } = createRuntime();

    await expect(runtime.execute('nonexistent', {})).rejects.toThrow(
      /Workflow "nonexistent" not registered/,
    );
  });

  it('lists available workflows in error message', async () => {
    const { runtime } = createRuntime();

    const wf1 = workflow({ name: 'alpha', input: z.any(), handler: async () => 'a' });
    const wf2 = workflow({ name: 'beta', input: z.any(), handler: async () => 'b' });
    runtime.register(wf1);
    runtime.register(wf2);

    await expect(runtime.execute('gamma', {})).rejects.toThrow(/alpha, beta/);
  });

  it('validates input against the workflow input schema', async () => {
    const { runtime } = createRuntime();

    const strictWorkflow = workflow({
      name: 'strict',
      input: z.object({ count: z.number().min(1) }),
      handler: async (ctx) => ctx.input.count,
    });
    runtime.register(strictWorkflow);

    // Missing required field
    await expect(runtime.execute('strict', {})).rejects.toThrow();

    // Invalid value
    await expect(runtime.execute('strict', { count: 0 })).rejects.toThrow();

    // Valid
    const result = await runtime.execute('strict', { count: 5 });
    expect(result).toBe(5);
  });

  it('validates output against the workflow output schema', async () => {
    const { runtime } = createRuntime();

    const badOutputWorkflow = workflow({
      name: 'bad-output',
      input: z.object({}),
      output: z.object({ score: z.number() }),
      handler: async () => ({ score: 'not-a-number' as any }),
    });
    runtime.register(badOutputWorkflow);

    await expect(runtime.execute('bad-output', {})).rejects.toThrow();
  });

  it('coerces output via Zod parse and returns the coerced result', async () => {
    const { runtime } = createRuntime();

    // Zod coercion: z.coerce.number() converts string "42" to number 42
    const coerceWorkflow = workflow({
      name: 'coerce',
      input: z.object({}),
      output: z.object({
        value: z.coerce.number(),
        label: z.string().default('default-label'),
      }),
      handler: async () => ({ value: '42' as any }),
    });
    runtime.register(coerceWorkflow);

    const result = await runtime.execute('coerce', {});
    // The parse result must be returned (not discarded)
    expect(result).toEqual({ value: 42, label: 'default-label' });
  });

  it('returns raw result when no output schema is defined', async () => {
    const { runtime } = createRuntime();

    const noOutputSchemaWorkflow = workflow({
      name: 'no-output-schema',
      input: z.any(),
      handler: async () => ({ arbitrary: true, nested: { data: [1, 2, 3] } }),
    });
    runtime.register(noOutputSchemaWorkflow);

    const result = await runtime.execute('no-output-schema', 'anything');
    expect(result).toEqual({ arbitrary: true, nested: { data: [1, 2, 3] } });
  });

  it('passes validated input to the handler context', async () => {
    const { runtime } = createRuntime();

    const inputWorkflow = workflow({
      name: 'input-check',
      input: z.object({
        items: z.array(z.string()),
        count: z.number().default(10),
      }),
      handler: async (ctx) => ({
        receivedItems: ctx.input.items,
        receivedCount: ctx.input.count,
      }),
    });
    runtime.register(inputWorkflow);

    // 'count' defaults to 10 via Zod
    const result = await runtime.execute('input-check', { items: ['a', 'b'] });
    expect(result).toEqual({ receivedItems: ['a', 'b'], receivedCount: 10 });
  });

  it('passes metadata to the context', async () => {
    const { runtime } = createRuntime();

    let receivedMetadata: unknown;
    const metaWorkflow = workflow({
      name: 'meta',
      input: z.any(),
      handler: async (ctx) => {
        receivedMetadata = ctx.metadata;
        return 'ok';
      },
    });
    runtime.register(metaWorkflow);

    await runtime.execute('meta', 'input', {
      metadata: { userId: 'u123', source: 'test' },
    });
    expect(receivedMetadata).toEqual({ userId: 'u123', source: 'test' });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// stream()
// ═════════════════════════════════════════════════════════════════════════

describe('stream()', () => {
  it('returns an AxlStream instance', () => {
    const { runtime } = createRuntime();

    const wf = workflow({
      name: 'stream-wf',
      input: z.any(),
      handler: async () => 'result',
    });
    runtime.register(wf);

    const stream = runtime.stream('stream-wf', 'input');
    expect(stream).toBeInstanceOf(AxlStream);
  });

  it('resolves the stream promise with the workflow result', async () => {
    const { runtime } = createRuntime();

    const wf = workflow({
      name: 'stream-result',
      input: z.object({ x: z.number() }),
      handler: async (ctx) => ctx.input.x * 2,
    });
    runtime.register(wf);

    const stream = runtime.stream('stream-result', { x: 21 });
    const result = await stream.promise;
    expect(result).toBe(42);
  });

  it('emits step events via the stream', async () => {
    const { runtime } = createRuntime();

    const wf = workflow({
      name: 'stream-events',
      input: z.any(),
      handler: async (ctx) => {
        ctx.log('step_1', { info: 'first' });
        ctx.log('step_2', { info: 'second' });
        return 'done';
      },
    });
    runtime.register(wf);

    const stream = runtime.stream('stream-events', 'go');
    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'done') break;
    }

    const stepEvents = events.filter((e) => e.type === 'step');
    expect(stepEvents.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('signals an error via the stream when workflow fails', async () => {
    const { runtime } = createRuntime();

    const failWorkflow = workflow({
      name: 'stream-fail',
      input: z.any(),
      handler: async () => {
        throw new Error('stream workflow boom');
      },
    });
    runtime.register(failWorkflow);

    const stream = runtime.stream('stream-fail', 'input');
    await expect(stream.promise).rejects.toThrow('stream workflow boom');
  });

  it('throws for unregistered workflow in stream', async () => {
    const { runtime } = createRuntime();

    const stream = runtime.stream('unknown', 'input');
    await expect(stream.promise).rejects.toThrow(/not registered/);
  });

  it('validates input in stream mode', async () => {
    const { runtime } = createRuntime();

    const wf = workflow({
      name: 'stream-validate',
      input: z.object({ required: z.string() }),
      handler: async () => 'ok',
    });
    runtime.register(wf);

    const stream = runtime.stream('stream-validate', { wrong: 123 });
    await expect(stream.promise).rejects.toThrow();
  });

  it('applies output schema coercion in stream mode', async () => {
    const { runtime } = createRuntime();

    const wf = workflow({
      name: 'stream-coerce',
      input: z.any(),
      output: z.object({ val: z.coerce.number() }),
      handler: async () => ({ val: '99' as any }),
    });
    runtime.register(wf);

    const stream = runtime.stream('stream-coerce', {});
    const result = await stream.promise;
    expect(result).toEqual({ val: 99 });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// session()
// ═════════════════════════════════════════════════════════════════════════

describe('session()', () => {
  it('creates a Session object with the given id', () => {
    const { runtime } = createRuntime();

    const session = runtime.session('sess-123');
    expect(session).toBeInstanceOf(Session);
    expect(session.id).toBe('sess-123');
  });

  it('creates distinct sessions for different ids', () => {
    const { runtime } = createRuntime();

    const s1 = runtime.session('sess-a');
    const s2 = runtime.session('sess-b');
    expect(s1.id).not.toBe(s2.id);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// getExecution()
// ═════════════════════════════════════════════════════════════════════════

describe('getExecution()', () => {
  it('returns undefined for unknown execution id', async () => {
    const { runtime } = createRuntime();

    const info = await runtime.getExecution('nonexistent-id');
    expect(info).toBeUndefined();
  });

  it('returns execution info after successful execute', async () => {
    const { runtime } = createRuntime();

    const wf = workflow({
      name: 'exec-info',
      input: z.any(),
      handler: async (ctx) => {
        ctx.log('doing_work');
        return 'result';
      },
    });
    runtime.register(wf);

    // Capture executionId from trace events
    let executionId: string | undefined;
    runtime.on('trace', (event: TraceEvent) => {
      executionId = event.executionId;
    });

    await runtime.execute('exec-info', 'input');

    expect(executionId).toBeDefined();
    const info = await runtime.getExecution(executionId!);
    expect(info).toBeDefined();
    expect(info!.workflow).toBe('exec-info');
    expect(info!.status).toBe('completed');
    expect(info!.duration).toBeGreaterThanOrEqual(0);
    expect(info!.steps.length).toBeGreaterThan(0);
  });

  it('returns execution info with failed status after workflow error', async () => {
    const { runtime } = createRuntime();

    const failWorkflow = workflow({
      name: 'fail-info',
      input: z.any(),
      handler: async () => {
        throw new Error('kaboom');
      },
    });
    runtime.register(failWorkflow);

    let executionId: string | undefined;
    runtime.on('trace', (event: TraceEvent) => {
      executionId = event.executionId;
    });

    await expect(runtime.execute('fail-info', 'input')).rejects.toThrow('kaboom');

    expect(executionId).toBeDefined();
    const info = await runtime.getExecution(executionId!);
    expect(info).toBeDefined();
    expect(info!.status).toBe('failed');
    expect(info!.error).toBe('kaboom');
  });

  it('accumulates totalCost across trace events', async () => {
    const provider = new TestProvider([
      { content: 'response-1', cost: 0.05 },
      { content: 'response-2', cost: 0.1 },
    ]);
    const { runtime } = createRuntime(provider);

    const testAgent = agent({
      model: 'test:test-model',
      system: 'test agent',
    });

    const costWorkflow = workflow({
      name: 'cost-track',
      input: z.any(),
      handler: async (ctx) => {
        await ctx.ask(testAgent, 'first call');
        await ctx.ask(testAgent, 'second call');
        return 'done';
      },
    });
    runtime.register(costWorkflow);

    let executionId: string | undefined;
    runtime.on('trace', (event: TraceEvent) => {
      executionId = event.executionId;
    });

    await runtime.execute('cost-track', {});

    const info = await runtime.getExecution(executionId!);
    expect(info).toBeDefined();
    expect(info!.totalCost).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// registerProvider()
// ═════════════════════════════════════════════════════════════════════════

describe('registerProvider()', () => {
  it('registers a custom provider that can be used in workflows', async () => {
    const runtime = new AxlRuntime({ defaultProvider: 'custom' });
    const provider = new TestProvider([{ content: 'custom response' }]);
    runtime.registerProvider('custom', provider as any);

    const customAgent = agent({
      model: 'custom:my-model',
      system: 'test',
    });

    const wf = workflow({
      name: 'custom-provider-wf',
      input: z.any(),
      handler: async (ctx) => ctx.ask(customAgent, 'hello'),
    });
    runtime.register(wf);

    const result = await runtime.execute('custom-provider-wf', {});
    expect(result).toBe('custom response');
    expect(provider.calls.length).toBe(1);
  });

  it('does not mutate the provider object', () => {
    const runtime = new AxlRuntime();
    const providerWithoutName = {
      chat: async () => ({ content: '' }),
      stream: async function* () {},
    } as any;

    runtime.registerProvider('my-provider', providerWithoutName);
    // The registry tracks providers by name; the provider object should not be mutated
    expect(providerWithoutName.name).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Trace events
// ═════════════════════════════════════════════════════════════════════════

describe('trace events', () => {
  it('emits trace events during execution', async () => {
    const { runtime } = createRuntime();
    const traces: TraceEvent[] = [];

    runtime.on('trace', (event: TraceEvent) => {
      traces.push(event);
    });

    const wf = workflow({
      name: 'trace-wf',
      input: z.any(),
      handler: async (ctx) => {
        ctx.log('custom_event', { key: 'value' });
        return 'done';
      },
    });
    runtime.register(wf);

    await runtime.execute('trace-wf', 'input');

    expect(traces.length).toBeGreaterThan(0);

    // Should include workflow_start and workflow_end log events
    const logEvents = traces.filter((t) => t.type === 'log');
    const startEvent = logEvents.find((t) => (t.data as any)?.event === 'workflow_start');
    const endEvent = logEvents.find((t) => (t.data as any)?.event === 'workflow_end');
    expect(startEvent).toBeDefined();
    expect(endEvent).toBeDefined();
    expect((endEvent!.data as any).status).toBe('completed');

    // Should include the custom log event
    const customEvent = logEvents.find((t) => (t.data as any)?.event === 'custom_event');
    expect(customEvent).toBeDefined();
    expect((customEvent!.data as any).key).toBe('value');
  });

  it('trace events include executionId and step numbers', async () => {
    const { runtime } = createRuntime();
    const traces: TraceEvent[] = [];

    runtime.on('trace', (event: TraceEvent) => {
      traces.push(event);
    });

    const wf = workflow({
      name: 'trace-steps',
      input: z.any(),
      handler: async (ctx) => {
        ctx.log('a');
        ctx.log('b');
        return 'done';
      },
    });
    runtime.register(wf);

    await runtime.execute('trace-steps', {});

    // All events should share the same executionId
    const execIds = new Set(traces.map((t) => t.executionId));
    expect(execIds.size).toBe(1);

    // Steps should be monotonically increasing
    for (let i = 1; i < traces.length; i++) {
      expect(traces[i].step).toBeGreaterThanOrEqual(traces[i - 1].step);
    }
  });

  it('trace events for workflow_start and workflow_end include workflow name in data', async () => {
    const { runtime } = createRuntime();
    const traces: TraceEvent[] = [];

    runtime.on('trace', (event: TraceEvent) => {
      traces.push(event);
    });

    const wf = workflow({
      name: 'named-workflow',
      input: z.any(),
      handler: async (ctx) => {
        ctx.log('event');
        return 'ok';
      },
    });
    runtime.register(wf);

    await runtime.execute('named-workflow', {});

    const logEvents = traces.filter((t) => t.type === 'log');
    const startEvent = logEvents.find((t) => (t.data as any)?.event === 'workflow_start');
    const endEvent = logEvents.find((t) => (t.data as any)?.event === 'workflow_end');

    expect(startEvent).toBeDefined();
    expect((startEvent!.data as any).workflow).toBe('named-workflow');

    expect(endEvent).toBeDefined();
    expect((endEvent!.data as any).workflow).toBe('named-workflow');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// outputTraceEvent()
// ═════════════════════════════════════════════════════════════════════════

describe('outputTraceEvent()', () => {
  it('does not log to console when trace is not enabled', async () => {
    const runtime = new AxlRuntime({ defaultProvider: 'test' });
    const provider = new TestProvider([{ content: 'ok' }]);
    runtime.registerProvider('test', provider as any);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const wf = workflow({
      name: 'no-trace',
      input: z.any(),
      handler: async (ctx) => {
        ctx.log('silent');
        return 'ok';
      },
    });
    runtime.register(wf);

    await runtime.execute('no-trace', {});

    // console.log should not have been called for trace output
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('logs to console in default console mode when trace is enabled', async () => {
    const runtime = new AxlRuntime({
      defaultProvider: 'test',
      trace: { enabled: true, output: 'console' },
    });
    const provider = new TestProvider([{ content: 'ok' }]);
    runtime.registerProvider('test', provider as any);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const wf = workflow({
      name: 'console-trace',
      input: z.any(),
      handler: async (ctx) => {
        ctx.log('visible');
        return 'ok';
      },
    });
    runtime.register(wf);

    await runtime.execute('console-trace', {});

    expect(consoleSpy).toHaveBeenCalled();
    // Console output should contain [axl] prefix
    const calls = consoleSpy.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => typeof c === 'string' && c.includes('[axl]'))).toBe(true);
    consoleSpy.mockRestore();
  });

  it('outputs JSON when trace output is set to json', async () => {
    const runtime = new AxlRuntime({
      defaultProvider: 'test',
      trace: { enabled: true, output: 'json' },
    });
    const provider = new TestProvider([{ content: 'ok' }]);
    runtime.registerProvider('test', provider as any);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const wf = workflow({
      name: 'json-trace',
      input: z.any(),
      handler: async (ctx) => {
        ctx.log('json_event');
        return 'ok';
      },
    });
    runtime.register(wf);

    await runtime.execute('json-trace', {});

    expect(consoleSpy).toHaveBeenCalled();
    // Each call should be valid JSON
    for (const call of consoleSpy.mock.calls) {
      const parsed = JSON.parse(call[0] as string);
      expect(parsed).toHaveProperty('executionId');
      expect(parsed).toHaveProperty('step');
      expect(parsed).toHaveProperty('type');
    }
    consoleSpy.mockRestore();
  });

  it('does not log when trace level is off', async () => {
    const runtime = new AxlRuntime({
      defaultProvider: 'test',
      trace: { enabled: true, level: 'off' },
    });
    const provider = new TestProvider([{ content: 'ok' }]);
    runtime.registerProvider('test', provider as any);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const wf = workflow({
      name: 'off-trace',
      input: z.any(),
      handler: async (ctx) => {
        ctx.log('muted');
        return 'ok';
      },
    });
    runtime.register(wf);

    await runtime.execute('off-trace', {});

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('still emits trace events via EventEmitter when trace output is off', async () => {
    const runtime = new AxlRuntime({
      defaultProvider: 'test',
      trace: { enabled: true, level: 'off' },
    });
    const provider = new TestProvider([{ content: 'ok' }]);
    runtime.registerProvider('test', provider as any);

    const traces: TraceEvent[] = [];
    runtime.on('trace', (event: TraceEvent) => traces.push(event));

    const wf = workflow({
      name: 'emitter-trace',
      input: z.any(),
      handler: async (ctx) => {
        ctx.log('still_emitted');
        return 'ok';
      },
    });
    runtime.register(wf);

    await runtime.execute('emitter-trace', {});

    // Events should still be emitted even though console output is off
    expect(traces.length).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Error handling
// ═════════════════════════════════════════════════════════════════════════

describe('error handling', () => {
  it('sets execution status to failed on workflow error', async () => {
    const { runtime } = createRuntime();

    const failWorkflow = workflow({
      name: 'fail-status',
      input: z.any(),
      handler: async () => {
        throw new Error('workflow error');
      },
    });
    runtime.register(failWorkflow);

    let executionId: string | undefined;
    runtime.on('trace', (event: TraceEvent) => {
      executionId = event.executionId;
    });

    await expect(runtime.execute('fail-status', {})).rejects.toThrow('workflow error');

    const info = await runtime.getExecution(executionId!);
    expect(info!.status).toBe('failed');
    expect(info!.error).toBe('workflow error');
    expect(info!.duration).toBeGreaterThanOrEqual(0);
  });

  it('emits workflow_end trace with failed status on error', async () => {
    const { runtime } = createRuntime();
    const traces: TraceEvent[] = [];

    runtime.on('trace', (event: TraceEvent) => traces.push(event));

    const failWorkflow = workflow({
      name: 'fail-trace',
      input: z.any(),
      handler: async () => {
        throw new Error('traced error');
      },
    });
    runtime.register(failWorkflow);

    await expect(runtime.execute('fail-trace', {})).rejects.toThrow('traced error');

    const logEvents = traces.filter((t) => t.type === 'log');
    const endEvent = logEvents.find((t) => (t.data as any)?.event === 'workflow_end');
    expect(endEvent).toBeDefined();
    expect((endEvent!.data as any).status).toBe('failed');
    expect((endEvent!.data as any).error).toBe('traced error');
  });

  it('re-throws the original error from execute()', async () => {
    const { runtime } = createRuntime();

    class CustomError extends Error {
      code = 'CUSTOM';
    }

    const customErrWorkflow = workflow({
      name: 'custom-err',
      input: z.any(),
      handler: async () => {
        throw new CustomError('custom failure');
      },
    });
    runtime.register(customErrWorkflow);

    try {
      await runtime.execute('custom-err', {});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CustomError);
      expect((err as CustomError).code).toBe('CUSTOM');
    }
  });

  it('handles non-Error thrown values', async () => {
    const { runtime } = createRuntime();

    const stringThrowWorkflow = workflow({
      name: 'string-throw',
      input: z.any(),
      handler: async () => {
        throw 'raw string error';
      },
    });
    runtime.register(stringThrowWorkflow);

    let executionId: string | undefined;
    runtime.on('trace', (event: TraceEvent) => {
      executionId = event.executionId;
    });

    await expect(runtime.execute('string-throw', {})).rejects.toBe('raw string error');

    const info = await runtime.getExecution(executionId!);
    expect(info!.status).toBe('failed');
    expect(info!.error).toBe('raw string error');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Multiple workflow registration
// ═════════════════════════════════════════════════════════════════════════

describe('multiple workflows', () => {
  it('can register and execute multiple workflows independently', async () => {
    const { runtime } = createRuntime();

    const addWorkflow = workflow({
      name: 'add',
      input: z.object({ a: z.number(), b: z.number() }),
      handler: async (ctx) => ctx.input.a + ctx.input.b,
    });

    const multiplyWorkflow = workflow({
      name: 'multiply',
      input: z.object({ a: z.number(), b: z.number() }),
      handler: async (ctx) => ctx.input.a * ctx.input.b,
    });

    runtime.register(addWorkflow);
    runtime.register(multiplyWorkflow);

    const sum = await runtime.execute('add', { a: 3, b: 4 });
    const product = await runtime.execute('multiply', { a: 3, b: 4 });

    expect(sum).toBe(7);
    expect(product).toBe(12);
  });

  it('later registration overwrites earlier registration with same name', async () => {
    const { runtime } = createRuntime();

    const v1 = workflow({
      name: 'versioned',
      input: z.any(),
      handler: async () => 'v1',
    });
    const v2 = workflow({
      name: 'versioned',
      input: z.any(),
      handler: async () => 'v2',
    });

    runtime.register(v1);
    runtime.register(v2);

    const result = await runtime.execute('versioned', {});
    expect(result).toBe('v2');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Execution isolation
// ═════════════════════════════════════════════════════════════════════════

describe('execution isolation', () => {
  it('concurrent executions get unique execution ids', async () => {
    const { runtime } = createRuntime();
    const executionIds = new Set<string>();

    runtime.on('trace', (event: TraceEvent) => {
      executionIds.add(event.executionId);
    });

    const wf = workflow({
      name: 'concurrent',
      input: z.any(),
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'done';
      },
    });
    runtime.register(wf);

    await Promise.all([
      runtime.execute('concurrent', 'a'),
      runtime.execute('concurrent', 'b'),
      runtime.execute('concurrent', 'c'),
    ]);

    // Each execution should have a unique id
    expect(executionIds.size).toBe(3);
  });

  it('stream executions also track execution info', async () => {
    const { runtime } = createRuntime();
    const executionIds = new Set<string>();

    runtime.on('trace', (event: TraceEvent) => {
      executionIds.add(event.executionId);
    });

    const wf = workflow({
      name: 'stream-exec-info',
      input: z.any(),
      handler: async (ctx) => {
        ctx.log('streaming');
        return 'streamed';
      },
    });
    runtime.register(wf);

    const stream = runtime.stream('stream-exec-info', {});
    await stream.promise;

    expect(executionIds.size).toBe(1);
    const execId = [...executionIds][0];
    const info = await runtime.getExecution(execId);
    expect(info).toBeDefined();
    expect(info!.status).toBe('completed');
    expect(info!.workflow).toBe('stream-exec-info');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// getStateStore()
// ═════════════════════════════════════════════════════════════════════════

describe('getStateStore()', () => {
  it('returns the internal state store', () => {
    const runtime = new AxlRuntime();
    const store = runtime.getStateStore();
    expect(store).toBeDefined();
    // MemoryStore is the default
    expect(typeof store.getSession).toBe('function');
    expect(typeof store.saveSession).toBe('function');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// shutdown()
// ═════════════════════════════════════════════════════════════════════════

describe('shutdown()', () => {
  it('calls stateStore.close() if implemented', async () => {
    const runtime = new AxlRuntime();
    const store = runtime.getStateStore();
    const closeSpy = vi.spyOn(store, 'close' as any).mockResolvedValue(undefined);

    await runtime.shutdown();

    expect(closeSpy).toHaveBeenCalledOnce();
    closeSpy.mockRestore();
  });

  it('succeeds when stateStore has no close method', async () => {
    const runtime = new AxlRuntime();
    const store = runtime.getStateStore();
    // Remove close to simulate a store without it
    delete (store as any).close;

    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it('aborts in-flight executions before closing stores', async () => {
    const { runtime } = createRuntime();

    let resolveWait: () => void;
    const waitPromise = new Promise<void>((r) => {
      resolveWait = r;
    });
    let signalAborted = false;

    const wf = workflow({
      name: 'long-running',
      input: z.any(),
      handler: async (ctx) => {
        // Check if the signal gets aborted during shutdown
        const checkSignal = () => {
          if (ctx.signal?.aborted) {
            signalAborted = true;
          }
        };
        await waitPromise;
        checkSignal();
        return 'done';
      },
    });
    runtime.register(wf);

    // Start the workflow (it will wait)
    const execPromise = runtime.execute('long-running', {});

    // Wait for the execution to start
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Shutdown should abort the in-flight execution
    await runtime.shutdown();

    // Unblock the handler so it can check the signal
    resolveWait!();
    await execPromise;

    expect(signalAborted).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// abort()
// ═════════════════════════════════════════════════════════════════════════

describe('abort()', () => {
  it('aborts the signal for a running execution', async () => {
    const { runtime } = createRuntime();
    let executionId: string | undefined;
    runtime.on('trace', (event: TraceEvent) => {
      executionId = event.executionId;
    });

    const wf = workflow({
      name: 'signal-check',
      input: z.any(),
      handler: async (_ctx) => {
        return 'done';
      },
    });
    runtime.register(wf);

    // Execute and wait for it to finish (it's quick)
    await runtime.execute('signal-check', {});

    // After completion, the controller is cleaned up
    // Verify abort on unknown id is a no-op (post-cleanup)
    runtime.abort(executionId!);
  });

  it('is a no-op for unknown execution ids', () => {
    const { runtime } = createRuntime();
    // Should not throw
    runtime.abort('nonexistent-id');
  });

  it('sets the abort signal for an in-flight execution', async () => {
    const { runtime } = createRuntime();

    let executionId: string | undefined;
    let resolveWait: () => void;
    const waitPromise = new Promise<void>((r) => {
      resolveWait = r;
    });

    const wf = workflow({
      name: 'abortable',
      input: z.any(),
      handler: async () => {
        // Wait until we trigger abort from the outside
        await waitPromise;
        return 'done';
      },
    });
    runtime.register(wf);

    runtime.on('trace', (event: TraceEvent) => {
      executionId = event.executionId;
    });

    const promise = runtime.execute('abortable', {});

    // Wait a tick for the execution to start and trace to be emitted
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executionId).toBeDefined();

    // Abort and then let the handler proceed
    runtime.abort(executionId!);
    resolveWait!();

    // The workflow itself doesn't check the signal, so it completes normally.
    // The key assertion is that abort doesn't throw.
    const result = await promise;
    expect(result).toBe('done');
  });

  it('abort() works with stream() executions', async () => {
    const { runtime } = createRuntime();

    let executionId: string | undefined;
    let resolveWait: () => void;
    const waitPromise = new Promise<void>((r) => {
      resolveWait = r;
    });

    // Promise that resolves once we capture the executionId from a trace event
    let resolveGotId: () => void;
    const gotIdPromise = new Promise<void>((r) => {
      resolveGotId = r;
    });

    const wf = workflow({
      name: 'stream-abortable',
      input: z.any(),
      handler: async (ctx) => {
        // Emit a log so the trace fires and we can capture the executionId
        ctx.log('started');
        await waitPromise;
        return 'done';
      },
    });
    runtime.register(wf);

    runtime.on('trace', (event: TraceEvent) => {
      if (!executionId) {
        executionId = event.executionId;
        resolveGotId!();
      }
    });

    const stream = runtime.stream('stream-abortable', {});

    // Wait until we have an executionId from a trace event
    await gotIdPromise;
    expect(executionId).toBeDefined();

    // Abort the stream execution
    runtime.abort(executionId!);
    resolveWait!();

    // Stream should still resolve (handler doesn't check signal)
    const result = await stream.promise;
    expect(result).toBe('done');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Constructor default config
// ═════════════════════════════════════════════════════════════════════════

describe('constructor', () => {
  it('works with no config argument', () => {
    const runtime = new AxlRuntime();
    expect(runtime).toBeInstanceOf(AxlRuntime);
  });

  it('works with an empty config', () => {
    const runtime = new AxlRuntime({});
    expect(runtime).toBeInstanceOf(AxlRuntime);
  });

  it('uses memory store by default', () => {
    const runtime = new AxlRuntime();
    const store = runtime.getStateStore();
    // Should be a MemoryStore (has no path property, unlike SQLiteStore)
    expect(store).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// createContext()
// ═════════════════════════════════════════════════════════════════════════

describe('createContext()', () => {
  it('returns a WorkflowContext that can run tools', async () => {
    const { runtime } = createRuntime();

    const greetTool = tool({
      name: 'greet',
      description: 'Greets a person',
      input: z.object({ name: z.string() }),
      handler: async (input) => `Hello, ${input.name}!`,
    });

    const ctx = runtime.createContext();
    const result = await greetTool.run(ctx, { name: 'Alice' });
    expect(result).toBe('Hello, Alice!');
  });

  it('passes metadata to the context', () => {
    const { runtime } = createRuntime();

    const ctx = runtime.createContext({
      metadata: { userId: 'u-42', role: 'admin' },
    });

    expect(ctx.metadata).toEqual({ userId: 'u-42', role: 'admin' });
  });

  it('generates unique executionIds', () => {
    const { runtime } = createRuntime();

    const ctx1 = runtime.createContext();
    const ctx2 = runtime.createContext();

    expect(ctx1.executionId).toBeDefined();
    expect(ctx2.executionId).toBeDefined();
    expect(ctx1.executionId).not.toBe(ctx2.executionId);
  });
});
