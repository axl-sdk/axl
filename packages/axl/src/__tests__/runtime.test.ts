import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { Session } from '../session.js';
import { AxlStream } from '../stream.js';
import type { AxlEvent } from '../types.js';

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

function createTransportProbeProvider() {
  const chat = vi.fn(async () => ({
    content: 'chat response',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    cost: 0,
  }));
  const stream = vi.fn(() =>
    (async function* () {
      yield { type: 'text_delta' as const, content: 'stream response' };
      yield {
        type: 'done' as const,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: 0,
      };
    })(),
  );

  return {
    provider: { name: 'test', chat, stream },
    chat,
    stream,
  };
}

const LEGACY_OBSERVATION_WARNING_KEY = Symbol.for(
  '@axlsdk/axl/legacy-observation-callback-warning',
);

function resetLegacyObservationWarning(): void {
  delete (globalThis as typeof globalThis & Record<PropertyKey, unknown>)[
    LEGACY_OBSERVATION_WARNING_KEY
  ];
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

    // Zod coercion: z.coerce.number() converts string "42" to number 42.
    // Handler returns `{ value: '42' }` (typed loosely for the test) and the
    // output schema parse coerces value to number 42 + applies the default.
    const coerceWorkflow = workflow({
      name: 'coerce',
      input: z.object({}),
      output: z.object({
        value: z.coerce.number(),
        label: z.string().default('default-label'),
      }),
      handler: (async () => ({ value: '42' })) as never,
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

  it('uses provider.stream without installing a callback or allocating ctx.events', async () => {
    resetLegacyObservationWarning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const probe = createTransportProbeProvider();
    const runtime = new AxlRuntime({ defaultProvider: 'test' });
    runtime.registerProvider('test', probe.provider as any);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    runtime.register(
      workflow({
        name: 'stream-transport-selection',
        input: z.object({}),
        handler: (ctx) => ctx.ask(testAgent, 'hello'),
      }),
    );

    const result = await runtime.stream('stream-transport-selection', {}).promise;

    expect(result).toBe('stream response');
    expect(probe.stream).toHaveBeenCalledTimes(1);
    expect(probe.chat).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps runtime.execute on provider.chat when no events observer is allocated', async () => {
    const probe = createTransportProbeProvider();
    const runtime = new AxlRuntime({ defaultProvider: 'test' });
    runtime.registerProvider('test', probe.provider as any);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });
    runtime.register(
      workflow({
        name: 'execute-transport-selection',
        input: z.object({}),
        handler: (ctx) => ctx.ask(testAgent, 'hello'),
      }),
    );

    const result = await runtime.execute('execute-transport-selection', {});

    expect(result).toBe('chat response');
    expect(probe.chat).toHaveBeenCalledTimes(1);
    expect(probe.stream).not.toHaveBeenCalled();
  });

  it('inherits runtime.stream transport mode in child contexts', async () => {
    const probe = createTransportProbeProvider();
    const runtime = new AxlRuntime({ defaultProvider: 'test' });
    runtime.registerProvider('test', probe.provider as any);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });
    runtime.register(
      workflow({
        name: 'child-stream-transport-selection',
        input: z.object({}),
        handler: (ctx) => ctx.createChildContext().ask(testAgent, 'hello from child'),
      }),
    );

    const result = await runtime.stream('child-stream-transport-selection', {}).promise;

    expect(result).toBe('stream response');
    expect(probe.stream).toHaveBeenCalledTimes(1);
    expect(probe.chat).not.toHaveBeenCalled();
  });

  it('emits log events via the stream (unified event model — formerly wrapped as `step`)', async () => {
    // Spec/16 §2.2: the legacy `step` wrapper event is removed. Logs (and
    // every other AxlEvent) flow directly to the wire.
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

    const logEvents = events.filter((e) => e.type === 'log');
    expect(logEvents.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('routes trace tool_approval events to stream on approve and deny', async () => {
    // Regression: the stream handler used to read a `tool_denied`-with-
    // `denied: false` hack. After switching context.ts to emit a dedicated
    // `tool_approval` trace event, the stream handler must pick it up.
    // Exercises the full trace → stream pipeline end-to-end via runtime.stream().
    const makeProvider = () => {
      let call = 0;
      return {
        name: 'test',
        chat: async () => {
          call++;
          if (call === 1) {
            return {
              content: '',
              tool_calls: [
                {
                  id: 'tc1',
                  type: 'function' as const,
                  function: { name: 'risky', arguments: '{"x":1}' },
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              cost: 0,
            };
          }
          return {
            content: 'done',
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            cost: 0,
          };
        },
        stream: async function* () {
          const resp = await (this as any).chat();
          if (resp.tool_calls) {
            for (const tc of resp.tool_calls) {
              yield {
                type: 'tool_call_delta' as const,
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
              };
            }
          } else if (resp.content) {
            yield { type: 'text_delta' as const, content: resp.content };
          }
          yield {
            type: 'done' as const,
            usage: resp.usage,
            cost: resp.cost,
          };
        },
      };
    };

    const riskyTool = tool({
      name: 'risky',
      description: 'risky',
      input: z.object({ x: z.number() }),
      handler: (input) => `got ${input.x}`,
      requireApproval: true,
    });

    const runApproved = async () => {
      const runtime = new AxlRuntime({ defaultProvider: 'test' });
      runtime.registerProvider('test', makeProvider() as any);
      const a = agent({ name: 'a', model: 'test:m', system: 'sys', tools: [riskyTool] });
      runtime.register(
        workflow({
          name: 'appr',
          input: z.any(),
          handler: async (ctx) => ctx.ask(a, 'go'),
        }),
      );
      const stream = runtime.stream('appr', 'go', {
        awaitHumanHandler: async () => ({ approved: true }),
      });
      const events: any[] = [];
      for await (const event of stream) {
        events.push(event);
        if (event.type === 'done') break;
      }
      return events;
    };

    const runDenied = async () => {
      const runtime = new AxlRuntime({ defaultProvider: 'test' });
      runtime.registerProvider('test', makeProvider() as any);
      const a = agent({ name: 'a', model: 'test:m', system: 'sys', tools: [riskyTool] });
      runtime.register(
        workflow({
          name: 'den',
          input: z.any(),
          handler: async (ctx) => ctx.ask(a, 'go'),
        }),
      );
      const stream = runtime.stream('den', 'go', {
        awaitHumanHandler: async () => ({ approved: false, reason: 'nope' }),
      });
      const events: any[] = [];
      for await (const event of stream) {
        events.push(event);
        if (event.type === 'done') break;
      }
      return events;
    };

    // Wire format is now AxlEvent — `tool_approval` carries `tool` (not
    // `name`) at the top level and `data: { approved, args, reason? }`.
    const approvedEvents = await runApproved();
    const approvedStreamEvents = approvedEvents.filter((e) => e.type === 'tool_approval');
    expect(approvedStreamEvents).toHaveLength(1);
    expect(approvedStreamEvents[0].tool).toBe('risky');
    expect(approvedStreamEvents[0].data.approved).toBe(true);
    expect(approvedStreamEvents[0].data.args).toEqual({ x: 1 });

    const deniedEvents = await runDenied();
    const deniedStreamEvents = deniedEvents.filter((e) => e.type === 'tool_approval');
    expect(deniedStreamEvents).toHaveLength(1);
    expect(deniedStreamEvents[0].tool).toBe('risky');
    expect(deniedStreamEvents[0].data.approved).toBe(false);
    expect(deniedStreamEvents[0].data.reason).toBe('nope');
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
    runtime.on('trace', (event: AxlEvent) => {
      executionId = event.executionId;
    });

    await runtime.execute('exec-info', 'input');

    expect(executionId).toBeDefined();
    const info = await runtime.getExecution(executionId!);
    expect(info).toBeDefined();
    expect(info!.workflow).toBe('exec-info');
    expect(info!.status).toBe('completed');
    expect(info!.duration).toBeGreaterThanOrEqual(0);
    expect(info!.events.length).toBeGreaterThan(0);
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
    runtime.on('trace', (event: AxlEvent) => {
      executionId = event.executionId;
    });

    await expect(runtime.execute('fail-info', 'input')).rejects.toThrow('kaboom');

    expect(executionId).toBeDefined();
    const info = await runtime.getExecution(executionId!);
    expect(info).toBeDefined();
    expect(info!.status).toBe('failed');
    expect(info!.error).toBe('kaboom');
  });

  it('threads ExecuteOptions.metadata onto ExecutionInfo.metadata', async () => {
    const { runtime } = createRuntime();

    const wf = workflow({
      name: 'meta-on-info',
      input: z.any(),
      handler: async () => 'ok',
    });
    runtime.register(wf);

    let executionId: string | undefined;
    runtime.on('trace', (event: AxlEvent) => {
      executionId = event.executionId;
    });

    await runtime.execute('meta-on-info', 'input', {
      metadata: { userId: 'u1', tag: 'x' },
    });

    const info = await runtime.getExecution(executionId!);
    expect(info).toBeDefined();
    expect(info!.metadata).toEqual({ userId: 'u1', tag: 'x' });
  });

  it('threads ExecuteOptions.metadata onto ExecutionInfo.metadata for stream()', async () => {
    const { runtime } = createRuntime();

    const wf = workflow({
      name: 'meta-on-info-stream',
      input: z.any(),
      handler: async () => 'ok',
    });
    runtime.register(wf);

    const stream = runtime.stream('meta-on-info-stream', 'input', {
      metadata: { userId: 'u-stream', correlationId: 'corr-42' },
    });
    // Drain the stream to completion so the execution finishes and
    // `getExecution` resolves the historical (persisted) snapshot.
    let executionId: string | undefined;
    for await (const event of stream) {
      executionId = event.executionId;
    }

    expect(executionId).toBeDefined();
    const info = await runtime.getExecution(executionId!);
    expect(info).toBeDefined();
    expect(info!.metadata).toEqual({ userId: 'u-stream', correlationId: 'corr-42' });
  });

  it('omits metadata field when no ExecuteOptions.metadata is provided', async () => {
    const { runtime } = createRuntime();

    const wf = workflow({
      name: 'no-meta-on-info',
      input: z.any(),
      handler: async () => 'ok',
    });
    runtime.register(wf);

    let executionId: string | undefined;
    runtime.on('trace', (event: AxlEvent) => {
      executionId = event.executionId;
    });

    await runtime.execute('no-meta-on-info', 'input');

    const info = await runtime.getExecution(executionId!);
    expect(info).toBeDefined();
    expect(info!.metadata).toBeUndefined();
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
    runtime.on('trace', (event: AxlEvent) => {
      executionId = event.executionId;
    });

    await runtime.execute('cost-track', {});

    const info = await runtime.getExecution(executionId!);
    expect(info).toBeDefined();
    expect(info!.totalCost).toBeGreaterThan(0);
  });

  // Regression: a custom or legacy StateStore can return ExecutionInfo rows
  // where `events` is missing, null, or otherwise non-array. The runtime
  // normalizes these at the StateStore boundary so downstream consumers
  // (Studio's TraceAggregator, REST routes, redaction) never see a
  // contract-violating row and crash on iteration.
  it('coerces non-array events from StateStore to [] and warns once', async () => {
    const malformed = [
      { executionId: 'e1', events: undefined },
      { executionId: 'e2', events: null },
      { executionId: 'e3', events: 'not-an-array' },
      { executionId: 'e4', events: 42 },
    ];

    const fakeStore = {
      saveExecution: vi.fn(async () => {}),
      getExecution: vi.fn(async (id: string) => {
        const row = malformed.find((m) => m.executionId === id);
        if (!row) return null;
        return {
          executionId: row.executionId,
          workflow: 'wf',
          status: 'completed',
          totalCost: 0,
          startedAt: 1,
          duration: 0,
          events: row.events,
        } as any;
      }),
      listExecutions: vi.fn(async () =>
        malformed.map(
          (m) =>
            ({
              executionId: m.executionId,
              workflow: 'wf',
              status: 'completed',
              totalCost: 0,
              startedAt: 1,
              duration: 0,
              events: m.events,
            }) as any,
        ),
      ),
    };

    const runtime = new AxlRuntime({
      defaultProvider: 'test',
      state: { store: fakeStore as any },
    });
    runtime.registerProvider('test', new TestProvider([{ content: 'ok' }]) as any);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const all = await runtime.getExecutions();
    expect(all).toHaveLength(4);
    for (const exec of all) {
      expect(Array.isArray(exec.events)).toBe(true);
      expect(exec.events).toEqual([]);
    }

    // One warning per malformed execution id.
    expect(warn).toHaveBeenCalledTimes(4);
    const warnedIds = warn.mock.calls.map((args) => String(args[0]));
    expect(warnedIds.some((m) => m.includes('e1'))).toBe(true);
    expect(warnedIds.some((m) => m.includes('e2') && m.includes('null'))).toBe(true);
    expect(warnedIds.some((m) => m.includes('e3') && m.includes('string'))).toBe(true);
    expect(warnedIds.some((m) => m.includes('e4') && m.includes('number'))).toBe(true);

    // Re-fetching the same id does not re-warn.
    warn.mockClear();
    const refetched = await runtime.getExecutions();
    expect(refetched).toHaveLength(4);
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('coerces non-array events on getExecution() store fall-through', async () => {
    const fakeStore = {
      saveExecution: vi.fn(async () => {}),
      getExecution: vi.fn(async (id: string) => ({
        executionId: id,
        workflow: 'wf',
        status: 'completed',
        totalCost: 0,
        startedAt: 1,
        duration: 0,
        events: null,
      })),
      listExecutions: vi.fn(async () => []),
    };

    const runtime = new AxlRuntime({
      defaultProvider: 'test',
      state: { store: fakeStore as any },
    });
    runtime.registerProvider('test', new TestProvider([{ content: 'ok' }]) as any);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const info = await runtime.getExecution('only-in-store');
    expect(info).toBeDefined();
    expect(Array.isArray(info!.events)).toBe(true);
    expect(info!.events).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
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
// resolveProvider()
// ═════════════════════════════════════════════════════════════════════════

describe('resolveProvider()', () => {
  it('resolves a provider:model URI to provider instance and model name', () => {
    const runtime = new AxlRuntime();
    const mockProvider = new TestProvider([{ content: 'echo' }]);
    runtime.registerProvider('mock', mockProvider as any);

    const result = runtime.resolveProvider('mock:test-model');
    expect(result.provider).toBe(mockProvider);
    expect(result.model).toBe('test-model');
  });

  it('throws for unknown provider', () => {
    const runtime = new AxlRuntime();
    expect(() => runtime.resolveProvider('unknown:model')).toThrow('Unknown provider "unknown"');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Trace events
// ═════════════════════════════════════════════════════════════════════════

describe('trace events', () => {
  it('emits trace events during execution', async () => {
    const { runtime } = createRuntime();
    const traces: AxlEvent[] = [];

    runtime.on('trace', (event: AxlEvent) => {
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

    // workflow_start and workflow_end are now first-class trace types,
    // not log events with a nested event name.
    const startEvent = traces.find((t) => t.type === 'workflow_start');
    const endEvent = traces.find((t) => t.type === 'workflow_end');
    expect(startEvent).toBeDefined();
    expect(endEvent).toBeDefined();
    expect((endEvent!.data as any).status).toBe('completed');

    // ctx.log() still emits type: 'log' for user-emitted events.
    const logEvents = traces.filter((t) => t.type === 'log');
    const customEvent = logEvents.find((t) => (t.data as any)?.event === 'custom_event');
    expect(customEvent).toBeDefined();
    expect((customEvent!.data as any).key).toBe('value');
  });

  it('trace events include executionId and step numbers', async () => {
    const { runtime } = createRuntime();
    const traces: AxlEvent[] = [];

    runtime.on('trace', (event: AxlEvent) => {
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

  it('workflow_start and workflow_end carry the workflow name on the event itself', async () => {
    const { runtime } = createRuntime();
    const traces: AxlEvent[] = [];

    runtime.on('trace', (event: AxlEvent) => {
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

    const startEvent = traces.find(
      (t): t is Extract<AxlEvent, { type: 'workflow_start' }> => t.type === 'workflow_start',
    );
    const endEvent = traces.find(
      (t): t is Extract<AxlEvent, { type: 'workflow_end' }> => t.type === 'workflow_end',
    );

    expect(startEvent).toBeDefined();
    expect(startEvent!.workflow).toBe('named-workflow');

    expect(endEvent).toBeDefined();
    expect(endEvent!.workflow).toBe('named-workflow');
    expect(endEvent!.data.status).toBe('completed');
    // result is captured on completed end events
    expect(endEvent!.data.result).toBe('ok');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// outputAxlEvent()
// ═════════════════════════════════════════════════════════════════════════

describe('outputAxlEvent()', () => {
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

    const traces: AxlEvent[] = [];
    runtime.on('trace', (event: AxlEvent) => traces.push(event));

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
    runtime.on('trace', (event: AxlEvent) => {
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
    const traces: AxlEvent[] = [];

    runtime.on('trace', (event: AxlEvent) => traces.push(event));

    const failWorkflow = workflow({
      name: 'fail-trace',
      input: z.any(),
      handler: async () => {
        throw new Error('traced error');
      },
    });
    runtime.register(failWorkflow);

    await expect(runtime.execute('fail-trace', {})).rejects.toThrow('traced error');

    const endEvent = traces.find((t) => t.type === 'workflow_end');
    expect(endEvent).toBeDefined();
    expect((endEvent!.data as any).status).toBe('failed');
    expect((endEvent!.data as any).error).toBe('traced error');
    // Failed non-abort workflows should NOT carry an aborted flag
    expect((endEvent!.data as any).aborted).toBeUndefined();

    // Spec §9: a top-level workflow throw (NOT inside ctx.ask) should NOT
    // emit any ask_end events. The workflow-level `error` channel covers
    // failures with no ask available — the two surfaces never both fire
    // for the same failure.
    const askEnds = traces.filter((t) => t.type === 'ask_end');
    expect(askEnds).toHaveLength(0);
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
    runtime.on('trace', (event: AxlEvent) => {
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

    runtime.on('trace', (event: AxlEvent) => {
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

    runtime.on('trace', (event: AxlEvent) => {
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
        // Check if the signal gets aborted during shutdown. `signal` is
        // a private field — narrow cast at the boundary so this test
        // can poke it without growing the public API surface.
        const internalSignal = (ctx as unknown as { signal?: AbortSignal }).signal;
        const checkSignal = () => {
          if (internalSignal?.aborted) {
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
    runtime.on('trace', (event: AxlEvent) => {
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

  it('marks workflow_end as aborted when a workflow is cancelled mid-flight', async () => {
    const { runtime } = createRuntime();
    const traces: AxlEvent[] = [];
    runtime.on('trace', (event: AxlEvent) => traces.push(event));

    let resolveWait: () => void;
    const waitPromise = new Promise<void>((r) => {
      resolveWait = r;
    });
    let executionId: string | undefined;

    const wf = workflow({
      name: 'cancellable',
      input: z.any(),
      handler: async (ctx) => {
        executionId = ctx.executionId;
        // Wait until the test aborts us
        await waitPromise;
        // Throw an AbortError so the catch path fires
        throw new DOMException('aborted', 'AbortError');
      },
    });
    runtime.register(wf);

    const execPromise = runtime.execute('cancellable', {});
    await new Promise((r) => setTimeout(r, 20));
    runtime.abort(executionId!);
    resolveWait!();

    await expect(execPromise).rejects.toThrow();

    // workflow_end now carries the abort signal directly; consumers don't
    // need to listen for a second event to detect cancellation.
    const endEvent = traces.find((t) => t.type === 'workflow_end');
    expect(endEvent).toBeDefined();
    const data = endEvent!.data as Record<string, unknown>;
    expect(data.status).toBe('failed');
    expect(data.aborted).toBe(true);
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

    runtime.on('trace', (event: AxlEvent) => {
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

    runtime.on('trace', (event: AxlEvent) => {
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

  it('stream.promise rejects with AbortError when aborted mid-flight, paired with workflow_end.aborted=true', async () => {
    // Verifies two invariants at once:
    //   1. Aborting an in-flight stream rejects `.promise` (consumers
    //      awaiting the stream see the abort).
    //   2. `workflow_end.aborted === true` accompanies the failure, so
    //      subscribers can distinguish cancellation from a real crash
    //      without needing a second event channel.
    const { runtime } = createRuntime();
    const traces: AxlEvent[] = [];
    runtime.on('trace', (event: AxlEvent) => traces.push(event));

    let resolveWait: () => void;
    const waitPromise = new Promise<void>((r) => {
      resolveWait = r;
    });
    let executionId: string | undefined;

    const wf = workflow({
      name: 'stream-abort-rejects',
      input: z.any(),
      handler: async (ctx) => {
        executionId = ctx.executionId;
        await waitPromise;
        // Handler re-throws as AbortError when unblocked — mirrors the
        // real cancellation path (fetch aborts, ctx.signal.throwIfAborted).
        throw new DOMException('aborted', 'AbortError');
      },
    });
    runtime.register(wf);

    const stream = runtime.stream('stream-abort-rejects', {});
    // Attach the rejection handler before we abort so the test framework
    // doesn't surface the rejection as unhandled. Match on the abort
    // signal so an unrelated regression that throws a different error
    // doesn't silently satisfy this assertion.
    const promiseRejection = expect(stream.promise).rejects.toThrow(/aborted|AbortError/i);

    // Wait for the handler to start, capture executionId, then abort.
    await new Promise((r) => setTimeout(r, 20));
    expect(executionId).toBeDefined();
    runtime.abort(executionId!);
    resolveWait!();

    await promiseRejection;

    const endEvent = traces.find((t) => t.type === 'workflow_end');
    expect(endEvent).toBeDefined();
    const data = endEvent!.data as Record<string, unknown>;
    expect(data.status).toBe('failed');
    expect(data.aborted).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// AbortController map cleanup
// ═════════════════════════════════════════════════════════════════════════

describe('abortControllers map cleanup', () => {
  // All four lifecycle paths (execute-success, execute-failure,
  // stream-success, stream-early-throw) must leave the runtime's
  // `abortControllers` map empty — a slow leak here would accumulate
  // one AbortController per execution across the lifetime of a long-
  // running process. Access the private map via a narrow escape hatch
  // since this is an internal invariant check.
  type RuntimeInternals = { abortControllers: Map<string, AbortController> };
  const internals = (r: AxlRuntime) => r as unknown as RuntimeInternals;

  it('execute() success path leaves the map empty', async () => {
    const { runtime } = createRuntime();
    const wf = workflow({
      name: 'ok-wf',
      input: z.any(),
      handler: async () => 'ok',
    });
    runtime.register(wf);

    expect(internals(runtime).abortControllers.size).toBe(0);
    await runtime.execute('ok-wf', {});
    expect(internals(runtime).abortControllers.size).toBe(0);
  });

  it('execute() failure path leaves the map empty', async () => {
    const { runtime } = createRuntime();
    const failWf = workflow({
      name: 'fail-wf',
      input: z.any(),
      handler: async () => {
        throw new Error('boom');
      },
    });
    runtime.register(failWf);

    expect(internals(runtime).abortControllers.size).toBe(0);
    await expect(runtime.execute('fail-wf', {})).rejects.toThrow('boom');
    expect(internals(runtime).abortControllers.size).toBe(0);
  });

  it('stream() success path (consumed to completion) leaves the map empty', async () => {
    const { runtime } = createRuntime();
    const wf = workflow({
      name: 'stream-ok',
      input: z.any(),
      handler: async () => 'streamed',
    });
    runtime.register(wf);

    expect(internals(runtime).abortControllers.size).toBe(0);
    const stream = runtime.stream('stream-ok', {});
    const result = await stream.promise;
    expect(result).toBe('streamed');
    expect(internals(runtime).abortControllers.size).toBe(0);
  });

  it('stream() early-throw path (unregistered workflow) leaves the map empty', async () => {
    // The early throw happens inside the async `run()` closure before
    // `execInfo` is assigned. The catch handler at the end of the
    // `.catch(err => …)` block must still delete the controller — the
    // `finally` inside `run()` never fires on this path.
    const { runtime } = createRuntime();

    expect(internals(runtime).abortControllers.size).toBe(0);
    const stream = runtime.stream('nonexistent-wf', {});
    await expect(stream.promise).rejects.toThrow(/not registered/);
    expect(internals(runtime).abortControllers.size).toBe(0);
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

  it('emits trace events to the runtime EventEmitter', async () => {
    const { runtime } = createRuntime();
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const traces: AxlEvent[] = [];
    runtime.on('trace', (event: AxlEvent) => traces.push(event));

    const ctx = runtime.createContext();
    await ctx.ask(testAgent, 'hello');

    expect(traces.length).toBeGreaterThan(0);
    expect(traces.some((t) => t.type === 'agent_call_end')).toBe(true);
  });

  it('tracks cost via totalCost getter', async () => {
    const provider = new TestProvider([{ content: 'result', cost: 0.05 }]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const ctx = runtime.createContext();
    expect(ctx.totalCost).toBe(0);

    await ctx.ask(testAgent, 'hello');
    expect(ctx.totalCost).toBe(0.05);
  });

  it('accumulates cost across multiple asks', async () => {
    const provider = new TestProvider([
      { content: 'a', cost: 0.03 },
      { content: 'b', cost: 0.07 },
    ]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const ctx = runtime.createContext();
    await ctx.ask(testAgent, 'first');
    await ctx.ask(testAgent, 'second');
    expect(ctx.totalCost).toBeCloseTo(0.1);
  });

  it('enforces budget limit', async () => {
    const provider = new TestProvider([
      { content: 'a', cost: 0.3 },
      { content: 'b', cost: 0.3 },
    ]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const ctx = runtime.createContext({ budget: '$0.50' });
    await ctx.ask(testAgent, 'first');
    expect(ctx.totalCost).toBeCloseTo(0.3);

    const status = ctx.getBudgetStatus();
    expect(status).not.toBeNull();
    expect(status!.limit).toBe(0.5);
    expect(status!.spent).toBeCloseTo(0.3);
    expect(status!.remaining).toBeCloseTo(0.2);

    // Second call pushes past the $0.50 limit — finish_and_stop lets it complete
    // but marks budget as exceeded
    await ctx.ask(testAgent, 'second');
    expect(ctx.totalCost).toBeCloseTo(0.6);
    expect(ctx.getBudgetStatus()!.remaining).toBe(0);
  });

  it('accepts signal option without error', () => {
    const { runtime } = createRuntime();
    const controller = new AbortController();

    const ctx = runtime.createContext({ signal: controller.signal });
    expect(ctx).toBeDefined();
    expect(ctx.executionId).toBeDefined();
  });

  it('passes sessionHistory to the context', async () => {
    const provider = new TestProvider([{ content: 'follow-up answer' }]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const ctx = runtime.createContext({
      sessionHistory: [
        { role: 'user', content: 'prior question' },
        { role: 'assistant', content: 'prior answer' },
      ],
    });
    await ctx.ask(testAgent, 'follow-up');

    // The provider should receive the session history + new message
    expect(provider.calls[0].messages.length).toBeGreaterThan(1);
    expect(provider.calls[0].messages.some((m: any) => m.content === 'prior question')).toBe(true);
  });

  it('keeps legacy onToken as a compatible provider-stream activation path', async () => {
    resetLegacyObservationWarning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const probe = createTransportProbeProvider();
    const runtime = new AxlRuntime({ defaultProvider: 'test' });
    runtime.registerProvider('test', probe.provider as any);
    const onToken = vi.fn();
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });
    const ctx = runtime.createContext({ onToken });

    const result = await ctx.ask(testAgent, 'hello');

    expect(result).toBe('stream response');
    expect(probe.stream).toHaveBeenCalledTimes(1);
    expect(probe.chat).not.toHaveBeenCalled();
    expect(onToken).toHaveBeenCalledWith(
      'stream response',
      expect.objectContaining({ agent: 'test', depth: 0 }),
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('docs/migration/stream-first-observation.md');
    warn.mockRestore();
    resetLegacyObservationWarning();
  });

  it('keeps every legacy observation callback operational with correlated metadata', async () => {
    resetLegacyObservationWarning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let callIndex = 0;
    const runtime = new AxlRuntime({ defaultProvider: 'test' });
    runtime.registerProvider('test', {
      name: 'test',
      chat: vi.fn(async () => {
        throw new Error('legacy onToken compatibility must select provider.stream');
      }),
      stream: async function* () {
        callIndex++;
        if (callIndex === 1) {
          yield {
            type: 'tool_call_delta' as const,
            id: 'legacy-call-1',
            name: 'legacy_tool',
            arguments: '{"value":7}',
          };
        } else {
          yield { type: 'text_delta' as const, content: 'done' };
        }
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
    });
    const legacyTool = tool({
      name: 'legacy_tool',
      description: 'Compatibility fixture',
      input: z.object({ value: z.number() }),
      handler: ({ value }) => ({ value }),
    });
    const testAgent = agent({
      name: 'legacy-agent',
      model: 'test:default',
      system: 'test',
      tools: [legacyTool],
    });
    const onToken = vi.fn();
    const onToolCall = vi.fn();
    const onAgentStart = vi.fn();
    const ctx = runtime.createContext({ onToken, onToolCall, onAgentStart });

    await expect(ctx.ask(testAgent, 'hello')).resolves.toBe('done');

    expect(onToken).toHaveBeenCalledWith(
      'done',
      expect.objectContaining({ agent: 'legacy-agent', depth: 0 }),
    );
    expect(onToolCall).toHaveBeenCalledWith(
      { name: 'legacy_tool', args: { value: 7 }, callId: 'legacy-call-1' },
      expect.objectContaining({ agent: 'legacy-agent', depth: 0 }),
    );
    expect(onAgentStart).toHaveBeenCalledTimes(2);
    const firstMeta = onAgentStart.mock.calls[0][1];
    expect(firstMeta).toEqual(
      expect.objectContaining({ askId: expect.any(String), agent: 'legacy-agent', depth: 0 }),
    );
    expect(onAgentStart.mock.calls[1][1]).toEqual(firstMeta);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    resetLegacyObservationWarning();
  });

  it('warns once per process only when legacy observation callbacks are supplied', () => {
    resetLegacyObservationWarning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime } = createRuntime();

    runtime.createContext();
    expect(warn).not.toHaveBeenCalled();

    runtime.createContext({ onToken: () => {} });
    runtime.createContext({ onToolCall: () => {} });
    runtime.createContext({ onAgentStart: () => {} });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('onToken, onToolCall, and onAgentStart');
    warn.mockRestore();
    resetLegacyObservationWarning();
  });

  it('passes awaitHumanHandler to the context', async () => {
    const provider = new TestProvider([
      {
        content: '',
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'danger', arguments: '{}' } },
        ],
      },
      { content: 'done' },
    ]);
    const { runtime } = createRuntime(provider);

    const dangerTool = tool({
      name: 'danger',
      description: 'dangerous action',
      input: z.object({}),
      requireApproval: true,
      handler: async () => 'executed',
    });

    const testAgent = agent({
      name: 'test',
      model: 'test:default',
      system: 'test',
      tools: [dangerTool],
    });

    const approvalCalls: any[] = [];
    const ctx = runtime.createContext({
      awaitHumanHandler: async (options) => {
        approvalCalls.push(options);
        return { approved: true };
      },
    });

    await ctx.ask(testAgent, 'do the dangerous thing');
    expect(approvalCalls.length).toBe(1);
    expect(approvalCalls[0].channel).toBe('tool_approval');
  });

  it('throws when tool requires approval but no handler is configured', async () => {
    const provider = new TestProvider([
      {
        content: '',
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'danger', arguments: '{}' } },
        ],
      },
    ]);
    const { runtime } = createRuntime(provider);

    const dangerTool = tool({
      name: 'danger',
      description: 'dangerous action',
      input: z.object({}),
      requireApproval: true,
      handler: async () => 'executed',
    });

    const testAgent = agent({
      name: 'test',
      model: 'test:default',
      system: 'test',
      tools: [dangerTool],
    });

    const ctx = runtime.createContext();
    await expect(ctx.ask(testAgent, 'do the dangerous thing')).rejects.toThrow(
      /no approval handler/i,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════
// trackCost()
// ═════════════════════════════════════════════════════════════════════════

describe('trackCost()', () => {
  it('captures cost from createContext + ctx.ask()', async () => {
    const provider = new TestProvider([{ content: 'answer', cost: 0.05 }]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const { result, cost } = await runtime.trackCost(async () => {
      const ctx = runtime.createContext();
      return ctx.ask(testAgent, 'hello');
    });

    expect(result).toBe('answer');
    expect(cost).toBeCloseTo(0.05);
  });

  it('captures cost from runtime.execute()', async () => {
    const provider = new TestProvider([{ content: 'result', cost: 0.1 }]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const wf = workflow({
      name: 'test-wf',
      input: z.object({ q: z.string() }),
      handler: async (ctx) => ctx.ask(testAgent, ctx.input.q),
    });
    runtime.register(wf);

    const { result, cost } = await runtime.trackCost(async () => {
      return runtime.execute('test-wf', { q: 'hello' });
    });

    expect(result).toBe('result');
    expect(cost).toBeCloseTo(0.1);
  });

  it('isolates cost between concurrent trackCost calls', async () => {
    const provider = new TestProvider([
      { content: 'a', cost: 0.01 },
      { content: 'b', cost: 0.02 },
    ]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const [r1, r2] = await Promise.all([
      runtime.trackCost(async () => {
        const ctx = runtime.createContext();
        return ctx.ask(testAgent, 'first');
      }),
      runtime.trackCost(async () => {
        const ctx = runtime.createContext();
        return ctx.ask(testAgent, 'second');
      }),
    ]);

    // Total cost across both scopes equals the sum of individual costs (no double-counting)
    expect(r1.cost + r2.cost).toBeCloseTo(0.03);
    // Neither scope saw both costs — each saw exactly one agent call
    expect(r1.cost).not.toBeCloseTo(0.03);
    expect(r2.cost).not.toBeCloseTo(0.03);
  });

  it('supports nested trackCost with correct rollup', async () => {
    const provider = new TestProvider([
      { content: 'inner', cost: 0.05 },
      { content: 'outer', cost: 0.1 },
    ]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const { cost: outerCost } = await runtime.trackCost(async () => {
      const { cost: innerCost } = await runtime.trackCost(async () => {
        const ctx = runtime.createContext();
        return ctx.ask(testAgent, 'inner');
      });
      expect(innerCost).toBeCloseTo(0.05);

      const ctx = runtime.createContext();
      return ctx.ask(testAgent, 'outer');
    });

    // Outer scope should include both inner and outer costs
    expect(outerCost).toBeCloseTo(0.15);
  });

  it('propagates errors and cleans up listeners', async () => {
    const provider = new TestProvider([{ content: 'partial', cost: 0.05 }]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const listenersBefore = runtime.listenerCount('trace');

    await expect(
      runtime.trackCost(async () => {
        const ctx = runtime.createContext();
        await ctx.ask(testAgent, 'hello');
        throw new Error('mid-execution failure');
      }),
    ).rejects.toThrow('mid-execution failure');

    // Listener should be cleaned up even after error
    expect(runtime.listenerCount('trace')).toBe(listenersBefore);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// trackExecution()
// ═════════════════════════════════════════════════════════════════════════

describe('trackExecution()', () => {
  it('captures model, tokens, and agentCalls from agent_call trace events', async () => {
    const provider = new TestProvider([{ content: 'answer', cost: 0.05 }]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const { result, cost, metadata } = await runtime.trackExecution(async () => {
      const ctx = runtime.createContext();
      return ctx.ask(testAgent, 'hello');
    });

    expect(result).toBe('answer');
    expect(cost).toBeCloseTo(0.05);
    expect(metadata.models).toEqual(['test:default']);
    expect(metadata.agentCalls).toBe(1);
    expect(metadata.tokens.input).toBeGreaterThan(0);
    expect(metadata.tokens.output).toBeGreaterThan(0);
  });

  it('isolates metadata between concurrent trackExecution calls', async () => {
    const provider = new TestProvider([
      { content: 'a', cost: 0.01 },
      { content: 'b', cost: 0.02 },
    ]);
    const { runtime } = createRuntime(provider);
    const agentA = agent({ name: 'agent-a', model: 'test:model-a', system: 'A' });
    const agentB = agent({ name: 'agent-b', model: 'test:model-b', system: 'B' });

    // Register both providers under different model names
    runtime.registerProvider('test', provider as any);

    const [r1, r2] = await Promise.all([
      runtime.trackExecution(async () => {
        const ctx = runtime.createContext();
        return ctx.ask(agentA, 'first');
      }),
      runtime.trackExecution(async () => {
        const ctx = runtime.createContext();
        return ctx.ask(agentB, 'second');
      }),
    ]);

    // Each scope should see exactly one agent call
    expect(r1.metadata.agentCalls).toBe(1);
    expect(r2.metadata.agentCalls).toBe(1);

    // Models should be isolated (each scope sees its own model)
    expect(r1.metadata.models).toEqual(['test:model-a']);
    expect(r2.metadata.models).toEqual(['test:model-b']);

    // Cost should be isolated
    expect(r1.cost + r2.cost).toBeCloseTo(0.03);
  });

  it('captures multiple models in multi-agent workflows', async () => {
    const provider = new TestProvider([
      { content: 'step1', cost: 0.01 },
      { content: 'step2', cost: 0.02 },
    ]);
    const { runtime } = createRuntime(provider);
    const agent1 = agent({ name: 'router', model: 'test:gpt-4o', system: 'Router' });
    const agent2 = agent({ name: 'worker', model: 'test:claude', system: 'Worker' });

    const { metadata } = await runtime.trackExecution(async () => {
      const ctx = runtime.createContext();
      await ctx.ask(agent1, 'route');
      return ctx.ask(agent2, 'work');
    });

    expect(metadata.models).toContain('test:gpt-4o');
    expect(metadata.models).toContain('test:claude');
    expect(metadata.models).toHaveLength(2);
    expect(metadata.agentCalls).toBe(2);
    expect(metadata.modelCallCounts).toEqual({ 'test:gpt-4o': 1, 'test:claude': 1 });
    expect(metadata.tokens.input).toBeGreaterThan(0);
  });

  it('returns empty metadata when no agent calls occur', async () => {
    const { runtime } = createRuntime();

    const { metadata } = await runtime.trackExecution(async () => {
      return 'no-agent-work';
    });

    expect(metadata.models).toEqual([]);
    expect(metadata.agentCalls).toBe(0);
    expect(metadata.tokens).toEqual({ input: 0, output: 0, reasoning: 0 });
  });

  it('cleans up listener when fn throws', async () => {
    const provider = new TestProvider([{ content: 'partial', cost: 0.05 }]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const listenersBefore = runtime.listenerCount('trace');

    await expect(
      runtime.trackExecution(async () => {
        const ctx = runtime.createContext();
        await ctx.ask(testAgent, 'hello');
        throw new Error('mid-execution failure');
      }),
    ).rejects.toThrow('mid-execution failure');

    expect(runtime.listenerCount('trace')).toBe(listenersBefore);
  });

  it('trackCost delegates to trackExecution (returns same cost)', async () => {
    const provider = new TestProvider([{ content: 'answer', cost: 0.07 }]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const { cost } = await runtime.trackCost(async () => {
      const ctx = runtime.createContext();
      return ctx.ask(testAgent, 'hello');
    });

    expect(cost).toBeCloseTo(0.07);
  });

  it('captureTraces strips high-volume token, partial_object, and string_delta events', async () => {
    // Reviewer bug B3 + spec/17 follow-up: `execInfo.events`
    // (runtime.ts:570, :735) strips `token` and `partial_object` to bound
    // memory, but the `captureTraces` path did not — so
    // `runEval({captureTraces: true})` on a streaming eval item blew the
    // captured-traces array. `string_delta` joined the strip list in
    // spec/17: a 4 KB summary streamed at 80-char chunks is ~50 deltas
    // per item, ~7-300 KB total — same rationale, same fix as the Studio
    // replay-buffer exclusion (`UNBUFFERED_EVENT_TYPES`).
    const provider = new TestProvider([{ content: 'hello world', cost: 0.01 }]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const { traces } = await runtime.trackExecution(
      async () => {
        const ctx = runtime.createContext();
        void ctx.events;
        return ctx.ask(testAgent, 'hi');
      },
      { captureTraces: true },
    );

    expect(traces).toBeDefined();
    // High-volume stream-only events must NOT be captured.
    expect(traces!.some((t) => t.type === 'token')).toBe(false);
    expect(traces!.some((t) => t.type === 'partial_object')).toBe(false);
    expect(traces!.some((t) => t.type === 'string_delta')).toBe(false);
    // But structural events (agent_call_end) still are.
    expect(traces!.some((t) => t.type === 'agent_call_end')).toBe(true);
  });

  it('captures workflow names from workflow_start trace events', async () => {
    const provider = new TestProvider([{ content: 'done', cost: 0.01 }]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });
    const wf = workflow({
      name: 'my-workflow',
      input: z.object({ prompt: z.string() }),
      handler: async (ctx) => ctx.ask(testAgent, ctx.input.prompt),
    });
    runtime.register(wf);

    const { metadata } = await runtime.trackExecution(async () => {
      return runtime.execute('my-workflow', { prompt: 'hello' });
    });

    expect(metadata.workflows).toEqual(['my-workflow']);
    expect(metadata.workflowCallCounts).toEqual({ 'my-workflow': 1 });
  });

  it('captures multiple workflow names from repeated execute() calls', async () => {
    const provider = new TestProvider([
      { content: 'a', cost: 0.01 },
      { content: 'b', cost: 0.02 },
    ]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });
    runtime.register(
      workflow({
        name: 'wf-a',
        input: z.string(),
        handler: async (ctx) => ctx.ask(testAgent, ctx.input),
      }),
    );
    runtime.register(
      workflow({
        name: 'wf-b',
        input: z.string(),
        handler: async (ctx) => ctx.ask(testAgent, ctx.input),
      }),
    );

    const { metadata } = await runtime.trackExecution(async () => {
      await runtime.execute('wf-a', 'first');
      return runtime.execute('wf-b', 'second');
    });

    // Insertion order: wf-a first, wf-b second.
    expect(metadata.workflows).toEqual(['wf-a', 'wf-b']);
    expect(metadata.workflowCallCounts).toEqual({ 'wf-a': 1, 'wf-b': 1 });
  });

  it('returns empty workflows array when no workflow_start events occur', async () => {
    const { runtime } = createRuntime();

    const { metadata } = await runtime.trackExecution(async () => {
      return 'pure-computation';
    });

    expect(metadata.workflows).toEqual([]);
    expect(metadata.workflowCallCounts).toBeUndefined();
  });
});

describe('budget exhaustion mid-workflow (workflow_end pairing)', () => {
  it('BudgetExceededError thrown mid-workflow → exactly ONE workflow_end(failed)', async () => {
    // Mirrors the existing workflow_end idempotency tests. The runtime's
    // execute() catch path emits ONE workflow_end with status:'failed'
    // when the workflow body throws — including when the throw is a
    // BudgetExceededError that bubbled out of an untrapped budget check.
    // No second event from cleanup side effects.
    //
    // Use a workflow that throws BudgetExceededError directly. This is
    // equivalent to the path where a user calls ctx.ask() and the
    // budgetContext.exceeded check at the top of executeAgentCall throws
    // — both routes hit the same runtime.execute() catch.
    const { runtime } = createRuntime();

    runtime.register(
      workflow({
        name: 'budget-throw-direct',
        input: z.object({}),
        handler: async () => {
          const { BudgetExceededError } = await import('../errors.js');
          throw new BudgetExceededError(0.01, 1.0, 'finish_and_stop');
        },
      }),
    );

    const ends: Array<Extract<AxlEvent, { type: 'workflow_end' }>> = [];
    runtime.on('trace', (event: AxlEvent) => {
      if (event.type === 'workflow_end') ends.push(event);
    });

    await expect(runtime.execute('budget-throw-direct', {})).rejects.toThrow(/budget/i);

    // EXACTLY ONE workflow_end fired, with status: 'failed'.
    expect(ends).toHaveLength(1);
    expect(ends[0].data.status).toBe('failed');
    // BudgetExceededError is NOT an AbortError, so `aborted` must NOT be set.
    expect(ends[0].data.aborted).toBeUndefined();
  });

  it('concurrent ctx.spawn under budget exhaustion: branches emit ask_end({ok:false}), exactly one workflow_end({failed})', async () => {
    // Pin the COMBINED behavior of `ctx.spawn` (concurrent branches sharing a
    // budget) under hard_stop budget exhaustion:
    //   • Each branch's `ctx.ask` calls eventually hit
    //     `executeAgentCall`'s `budgetContext.exceeded` check and throw
    //     BudgetExceededError.
    //   • Because `ctx.ask` wraps in try/finally, the failing ask emits
    //     `ask_end({outcome.ok: false})` per spec §9.
    //   • The error propagates up: spawn (default no-quorum) catches
    //     per-branch errors into Result.ok:false, so the workflow
    //     unwraps and re-throws BudgetExceededError manually.
    //   • Runtime.execute() catches and emits exactly ONE
    //     `workflow_end({status:'failed'})` (matching idempotency
    //     invariants pinned elsewhere in this file).
    //
    // Cost shape: 3 branches × 2 sequential ctx.ask each. Each ask costs
    // $0.10. Budget limit: $0.15. After 2 of the first-round asks finish,
    // totalCost = $0.20 > $0.15 → exceeded=true. The remaining asks
    // (whether second-round or stragglers) trip the exceeded check.
    const provider = new TestProvider([
      { content: 'a', cost: 0.1 },
      { content: 'b', cost: 0.1 },
      { content: 'c', cost: 0.1 },
      { content: 'd', cost: 0.1 },
      { content: 'e', cost: 0.1 },
      { content: 'f', cost: 0.1 },
    ]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    runtime.register(
      workflow({
        name: 'spawn-budget-exhaust',
        input: z.object({}),
        handler: async (ctx) => {
          const result = await ctx.budget({ cost: '$0.15', onExceed: 'hard_stop' }, async () =>
            ctx.spawn(3, async () => {
              // Two sequential asks per branch — guarantees the budget
              // trips on a later call (the first round's accumulated
              // cost from sibling branches will set `exceeded`).
              await ctx.ask(testAgent, 'q1');
              await ctx.ask(testAgent, 'q2');
              return 'branch-ok';
            }),
          );
          // ctx.budget swallows BudgetExceededError into the result; the
          // workflow re-throws so runtime.execute() emits workflow_end(failed).
          if (result.budgetExceeded) {
            const { BudgetExceededError } = await import('../errors.js');
            throw new BudgetExceededError(0.15, result.totalCost, 'hard_stop');
          }
          return result.value;
        },
      }),
    );

    const askEnds: Array<Extract<AxlEvent, { type: 'ask_end' }>> = [];
    const wfEnds: Array<Extract<AxlEvent, { type: 'workflow_end' }>> = [];
    runtime.on('trace', (event: AxlEvent) => {
      if (event.type === 'ask_end') askEnds.push(event);
      else if (event.type === 'workflow_end') wfEnds.push(event);
    });

    await expect(runtime.execute('spawn-budget-exhaust', {})).rejects.toThrow(/budget/i);

    // At least one branch's ctx.ask threw BudgetExceededError mid-spawn,
    // surfacing as ask_end({outcome.ok: false}) per spec §9.
    const failedAsks = askEnds.filter((e) => e.outcome.ok === false);
    expect(failedAsks.length).toBeGreaterThan(0);

    // Exactly ONE workflow_end fired, with status: 'failed'. Matches the
    // idempotency invariants pinned for sequential budget exhaustion above.
    expect(wfEnds).toHaveLength(1);
    expect(wfEnds[0].data.status).toBe('failed');
    expect(wfEnds[0].data.error).toMatch(/budget/i);

    // abortControllers map is cleaned up after execute() resolves
    // (the finally block at runtime.ts:778-780).
    expect(
      (runtime as unknown as { abortControllers: Map<string, AbortController> }).abortControllers
        .size,
    ).toBe(0);
  });

  it('budget hard_stop sets workflow_end.aborted=false (NOT a user AbortError)', async () => {
    // The aborted flag on workflow_end is reserved for genuine
    // AbortSignal cancellation (user-driven). Budget hard_stop
    // internally fires an AbortController to cancel in-flight
    // operations — but the resulting BudgetExceededError must NOT
    // be classified as `aborted: true`. This test pins the
    // distinction: budget exhaustion → status:'failed' AND
    // `aborted` is undefined/false (the runtime catch only sets
    // `aborted: true` when err.name === 'AbortError').
    const provider = new TestProvider([
      { content: 'a', cost: 0.1 },
      { content: 'b', cost: 0.1 },
      { content: 'c', cost: 0.1 },
      { content: 'd', cost: 0.1 },
    ]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    runtime.register(
      workflow({
        name: 'budget-hard-stop-aborted-flag',
        input: z.object({}),
        handler: async (ctx) => {
          const result = await ctx.budget({ cost: '$0.15', onExceed: 'hard_stop' }, async () => {
            // Two sequential asks: first succeeds, second exhausts and
            // would in turn cause the third (here represented by the
            // catch path inside ctx.budget) to short-circuit.
            await ctx.ask(testAgent, 'q1');
            await ctx.ask(testAgent, 'q2');
            return await ctx.ask(testAgent, 'q3');
          });
          if (result.budgetExceeded) {
            const { BudgetExceededError } = await import('../errors.js');
            throw new BudgetExceededError(0.15, result.totalCost, 'hard_stop');
          }
          return result.value;
        },
      }),
    );

    const wfEnds: Array<Extract<AxlEvent, { type: 'workflow_end' }>> = [];
    runtime.on('trace', (event: AxlEvent) => {
      if (event.type === 'workflow_end') wfEnds.push(event);
    });

    await expect(runtime.execute('budget-hard-stop-aborted-flag', {})).rejects.toThrow(/budget/i);

    expect(wfEnds).toHaveLength(1);
    expect(wfEnds[0].data.status).toBe('failed');
    // The /budget/i error message is pinned to disambiguate from a generic throw.
    expect(wfEnds[0].data.error).toMatch(/budget/i);
    // KEY ASSERTION: aborted must NOT be true. BudgetExceededError is
    // NOT an AbortError, so the runtime catch path leaves `aborted`
    // unset (the runtime sets it ONLY when err.name === 'AbortError').
    expect(wfEnds[0].data.aborted).toBeFalsy();
  });
});

describe('config.state.maxEventsPerExecution (memory cap)', () => {
  it('caps ExecutionInfo.events at the configured limit and appends a truncation sentinel', async () => {
    // Pathological workloads (50 nested asks × 20-turn tool loops) can
    // accumulate hundreds of MB before terminal `done`. A configurable
    // cap bounds the in-memory array; trace channel still sees every
    // event. Default is 50_000 — use a tiny cap here to exercise it.
    const provider = new TestProvider([{ content: 'ok' }]);
    const runtime = new AxlRuntime({
      defaultProvider: 'test',
      state: { maxEventsPerExecution: 5 },
    });
    runtime.registerProvider('test', provider as never);
    runtime.register(
      workflow({
        name: 'noisy-wf',
        input: z.object({}),
        handler: async (ctx) => {
          // Emit lots of log events from inside the workflow.
          for (let i = 0; i < 50; i++) ctx.log('spam', { i });
          return 'done';
        },
      }),
    );

    // Trace listener sees every event; the in-memory array is bounded.
    let traceEventCount = 0;
    runtime.on('trace', () => {
      traceEventCount++;
    });

    const result = await runtime.execute('noisy-wf', {});
    expect(result).toBe('done');

    const all = await runtime.getExecutions();
    const ours = all.find((e) => e.workflow === 'noisy-wf')!;
    expect(ours).toBeDefined();

    // The cap holds: events.length === cap (the cap-th slot is the sentinel).
    expect(ours.events.length).toBe(5);
    // Last entry is the truncation sentinel.
    const last = ours.events[ours.events.length - 1] as Extract<AxlEvent, { type: 'log' }>;
    expect(last.type).toBe('log');
    const data = last.data as { event?: string; cap?: number };
    expect(data.event).toBe('events_truncated');
    expect(data.cap).toBe(5);
    // Trace channel saw way more than the cap.
    expect(traceEventCount).toBeGreaterThan(50);
  });

  it('defaults to 50_000 when state.maxEventsPerExecution is unset', () => {
    const runtime = new AxlRuntime();
    // Field is private but we can poke via the bracket index for the
    // assertion. Pinning the default ensures a future refactor doesn't
    // silently regress to an unbounded array.
    expect((runtime as unknown as { maxEventsPerExecution: number }).maxEventsPerExecution).toBe(
      50_000,
    );
  });

  it('rejects pathological state.maxEventsPerExecution at construction', () => {
    const cases = [0, -1, 1.5, NaN, -Infinity];
    for (const value of cases) {
      expect(
        () => new AxlRuntime({ state: { maxEventsPerExecution: value } }),
        `value=${value}`,
      ).toThrow(/maxEventsPerExecution/);
    }
  });

  it('accepts Infinity for explicit unbounded opt-out', () => {
    expect(() => new AxlRuntime({ state: { maxEventsPerExecution: Infinity } })).not.toThrow();
  });
});

describe('workflow_end idempotency', () => {
  it('does not fire workflow_end twice when post-emit side-effects throw', async () => {
    // Reviewer bug B1: `_emitWorkflowEnd(completed)` fires BEFORE
    // `deleteCheckpoints` / `persistExecution`. If either throws, the
    // outer catch would fire a second `_emitWorkflowEnd(failed)` with
    // conflicting status. The idempotency guard on WorkflowContext
    // makes the second call a no-op — first-wins semantics.
    const provider = new TestProvider([{ content: 'ok', cost: 0.01 }]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    // Patch `deleteCheckpoints` on the existing store to throw — simulates
    // a transient SQLite I/O error on post-completion cleanup. Using a
    // method patch rather than a full replacement so the rest of the
    // `StateStore` surface (sessions, checkpoints, eval history) stays
    // intact.
    const store = (runtime as unknown as { stateStore: Record<string, unknown> }).stateStore;
    store.deleteCheckpoints = async () => {
      throw new Error('checkpoint delete failed');
    };

    runtime.register(
      workflow({
        name: 'wfend-idempotency',
        input: z.object({}),
        handler: async (ctx) => ctx.ask(testAgent, 'q'),
      }),
    );

    const ends: Array<{ data: { status: string } }> = [];
    runtime.on('trace', (e: unknown) => {
      const ev = e as { type: string; data: { status: string } };
      if (ev.type === 'workflow_end') ends.push(ev);
    });

    await expect(runtime.execute('wfend-idempotency', {})).rejects.toThrow(
      'checkpoint delete failed',
    );
    expect(ends).toHaveLength(1);
    // First (completed) event stands — the cleanup failure didn't
    // transform a succeeded workflow into a failed one.
    expect(ends[0].data.status).toBe('completed');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// runWorkflowBody parity (audit SHOULD ADD #1)
// ═════════════════════════════════════════════════════════════════════════

/**
 * Both `execute()` and `stream()` route through `runWorkflowBody()` and must
 * emit `workflow_start` exactly once and `workflow_end` exactly once across
 * success / throw / abort. Each path × outcome combination is tested below
 * so a future refactor can't silently regress the start↔end pairing
 * invariant on one path while leaving the other intact.
 */
describe('runWorkflowBody parity (execute vs stream × success/throw/abort)', () => {
  type Path = 'execute' | 'stream';
  type Outcome = 'success' | 'throw' | 'abort';

  // Helper: drive a workflow via either execute() or stream() and capture
  // every emitted AxlEvent off the runtime trace channel. For abort, we
  // wait for the workflow_start event (signalling the body has started)
  // before calling runtime.abort(), guaranteeing the abort happens
  // mid-execution rather than racing the registration phase.
  async function runAndCollect(
    runtime: AxlRuntime,
    path: Path,
    outcome: Outcome,
    workflowName: string,
  ): Promise<AxlEvent[]> {
    const traces: AxlEvent[] = [];
    runtime.on('trace', (event: AxlEvent) => traces.push(event));

    if (path === 'execute') {
      if (outcome === 'abort') {
        const promise = runtime.execute(workflowName, {});
        // Wait for workflow_start so we know the controller is registered
        // and the body has begun.
        for (let i = 0; i < 50 && !traces.some((t) => t.type === 'workflow_start'); i++) {
          await new Promise((r) => setImmediate(r));
        }
        const startEvent = traces.find((t) => t.type === 'workflow_start');
        expect(startEvent).toBeDefined();
        runtime.abort(startEvent!.executionId);
        await expect(promise).rejects.toThrow();
      } else if (outcome === 'throw') {
        await expect(runtime.execute(workflowName, {})).rejects.toThrow();
      } else {
        await runtime.execute(workflowName, {});
      }
    } else {
      const stream = runtime.stream(workflowName, {});
      if (outcome === 'abort') {
        // Drive the stream to completion in the background; abort once
        // workflow_start has arrived. The stream consumer detaches via
        // stream.promise, which surfaces the error.
        const consumed = (async () => {
          try {
            await stream.promise;
          } catch {
            /* expected on abort */
          }
        })();
        for (let i = 0; i < 50 && !traces.some((t) => t.type === 'workflow_start'); i++) {
          await new Promise((r) => setImmediate(r));
        }
        const startEvent = traces.find((t) => t.type === 'workflow_start');
        expect(startEvent).toBeDefined();
        runtime.abort(startEvent!.executionId);
        await consumed;
      } else if (outcome === 'throw') {
        await expect(stream.promise).rejects.toThrow();
      } else {
        await stream.promise;
      }
    }
    return traces;
  }

  // Each combination registers a workflow whose handler triggers the
  // requested outcome. For `success`, return immediately. For `throw`,
  // throw a real error inside the body. For `abort`, await the runtime's
  // internal signal (reached via the WorkflowContext private field) so
  // we can stay outside ctx.ask — the audit's invariant is workflow-level
  // and we want zero ask_end events to keep the regression scope clear.
  function buildWorkflow(name: string, outcome: Outcome) {
    return workflow({
      name,
      input: z.any(),
      handler: async (ctx) => {
        if (outcome === 'success') return 'ok';
        if (outcome === 'throw') throw new Error(`${name} body throw`);
        // abort: subscribe to the internal abort signal and reject when it
        // fires. The internal signal (private field) is the same one
        // `runtime.abort()` triggers via the runtime's controller map.
        // Cast through `unknown` to avoid the ts(2341) private-field error.
        const signal = (ctx as unknown as { signal: AbortSignal | undefined }).signal;
        await new Promise<never>((_, reject) => {
          if (signal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
        return 'should-not-reach';
      },
    });
  }

  for (const path of ['execute', 'stream'] as Path[]) {
    for (const outcome of ['success', 'throw', 'abort'] as Outcome[]) {
      it(`${path} × ${outcome}: exactly one workflow_start and one workflow_end`, async () => {
        const { runtime } = createRuntime();
        const wfName = `parity-${path}-${outcome}`;
        runtime.register(buildWorkflow(wfName, outcome));

        const traces = await runAndCollect(runtime, path, outcome, wfName);

        const starts = traces.filter((t) => t.type === 'workflow_start');
        const ends = traces.filter(
          (t): t is Extract<AxlEvent, { type: 'workflow_end' }> => t.type === 'workflow_end',
        );

        // Pairing invariant: exactly one start and exactly one end.
        expect(starts).toHaveLength(1);
        expect(ends).toHaveLength(1);

        // Status / aborted flag agrees with the outcome we drove.
        if (outcome === 'success') {
          expect(ends[0].data.status).toBe('completed');
          expect(ends[0].data.aborted).toBeUndefined();
        } else if (outcome === 'throw') {
          expect(ends[0].data.status).toBe('failed');
          // A user-thrown error is NOT an abort.
          expect(ends[0].data.aborted).toBeUndefined();
        } else {
          // abort
          expect(ends[0].data.status).toBe('failed');
          expect(ends[0].data.aborted).toBe(true);
        }
      });
    }
  }
});

describe('deleteExecution()', () => {
  it('removes a historical execution from memory and the store, returning true', async () => {
    const runtime = new AxlRuntime();
    runtime.registerProvider('test', new TestProvider([{ content: 'ok' }]) as any);
    const wf = workflow({
      name: 'wf',
      input: z.object({ msg: z.string() }),
      handler: async (ctx) => ctx.input.msg,
    });
    runtime.register(wf);

    await runtime.execute('wf', { msg: 'hello' });
    const all = await runtime.getExecutions();
    expect(all).toHaveLength(1);
    const executionId = all[0].executionId;

    const deleted = await runtime.deleteExecution(executionId);
    expect(deleted).toBe(true);

    expect(await runtime.getExecution(executionId)).toBeUndefined();
    expect(await runtime.getExecutions()).toEqual([]);
  });

  it('returns false for an unknown id', async () => {
    const runtime = new AxlRuntime();
    expect(await runtime.deleteExecution('does-not-exist')).toBe(false);
  });

  it('deletes from the StateStore (lazy-loaded history)', async () => {
    // Simulate an execution that's only in the store (not in memory) — e.g.
    // a previous process saved it, then this process started fresh.
    let storeDeleteCalledWith: string | null = null;
    const fakeStore = {
      saveCheckpoint: async () => {},
      getCheckpoint: async () => null,
      saveSession: async () => {},
      getSession: async () => [],
      deleteSession: async () => {},
      saveSessionMeta: async () => {},
      getSessionMeta: async () => null,
      savePendingDecision: async () => {},
      getPendingDecisions: async () => [],
      resolveDecision: async () => {},
      saveExecutionState: async () => {},
      getExecutionState: async () => null,
      listPendingExecutions: async () => [],
      saveExecution: async () => {},
      getExecution: async () => null,
      listExecutions: async () => [
        {
          executionId: 'in-store',
          workflow: 'wf',
          status: 'completed' as const,
          events: [],
          totalCost: 0,
          startedAt: 0,
          completedAt: 0,
          duration: 0,
        },
      ],
      deleteExecution: async (id: string): Promise<boolean> => {
        storeDeleteCalledWith = id;
        return true;
      },
    };

    const runtime = new AxlRuntime({
      state: { store: fakeStore as any },
    });

    const deleted = await runtime.deleteExecution('in-store');
    expect(deleted).toBe(true);
    expect(storeDeleteCalledWith).toBe('in-store');

    // Subsequent reads no longer see the deleted entry
    expect(await runtime.getExecution('in-store')).toBeUndefined();
  });

  it('does not crash when the store lacks deleteExecution (older custom stores)', async () => {
    const fakeStore = {
      saveCheckpoint: async () => {},
      getCheckpoint: async () => null,
      saveSession: async () => {},
      getSession: async () => [],
      deleteSession: async () => {},
      saveSessionMeta: async () => {},
      getSessionMeta: async () => null,
      savePendingDecision: async () => {},
      getPendingDecisions: async () => [],
      resolveDecision: async () => {},
      saveExecutionState: async () => {},
      getExecutionState: async () => null,
      listPendingExecutions: async () => [],
      // No saveExecution / getExecution / deleteExecution — store can't persist
      // history. deleteExecution should still report the in-memory deletion.
    };

    const runtime = new AxlRuntime({
      defaultProvider: 'test',
      state: { store: fakeStore as any },
    });
    runtime.registerProvider('test', new TestProvider([{ content: 'ok' }]) as any);
    const wf = workflow({
      name: 'wf',
      input: z.object({}).strict(),
      handler: async (_ctx) => 'ok',
    });
    runtime.register(wf);

    await runtime.execute('wf', {});
    const all = await runtime.getExecutions();
    const id = all[0].executionId;

    // Store doesn't implement deleteExecution but the in-memory cache does
    const deleted = await runtime.deleteExecution(id);
    expect(deleted).toBe(true);
  });

  it('emits execution_deleted with structured metadata on every call', async () => {
    const runtime = new AxlRuntime();
    runtime.registerProvider('test', new TestProvider([{ content: 'ok' }]) as any);
    const wf = workflow({
      name: 'audit-wf',
      input: z.object({}).strict(),
      handler: async () => 'ok',
    });
    runtime.register(wf);
    await runtime.execute('audit-wf', {});

    const events: Array<{
      executionId: string;
      workflow?: string;
      wasActive: boolean;
      hadPendingDecision: boolean;
      removed: boolean;
    }> = [];
    runtime.on('execution_deleted', (e) => events.push(e));

    const [exec] = await runtime.getExecutions();
    await runtime.deleteExecution(exec.executionId);
    // Also fire a delete on an unknown id — emit should still fire
    // (compliance consumers want to log attempted deletes too).
    await runtime.deleteExecution('does-not-exist');

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      executionId: exec.executionId,
      workflow: 'audit-wf', // workflow name carried for compliance categorization
      wasActive: false,
      hadPendingDecision: false,
      removed: true,
    });
    expect(events[1]).toMatchObject({
      executionId: 'does-not-exist',
      workflow: undefined, // unknown id → no workflow lookup possible
      wasActive: false,
      hadPendingDecision: false,
      removed: false,
    });
  });

  it('emits eval_deleted symmetric to execution_deleted', async () => {
    const runtime = new AxlRuntime();
    // Seed an eval result directly via saveEvalResult
    await runtime.saveEvalResult({
      id: 'ev-1',
      eval: 'qa-eval',
      timestamp: 1000,
      data: { score: 1 },
    });

    const events: Array<{ id: string; eval?: string; removed: boolean }> = [];
    runtime.on('eval_deleted', (e) => events.push(e));

    await runtime.deleteEvalResult('ev-1');
    // Attempt against unknown id — emit still fires with removed: false
    await runtime.deleteEvalResult('does-not-exist');

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: 'ev-1',
      eval: 'qa-eval',
      removed: true,
    });
    expect(events[1]).toMatchObject({
      id: 'does-not-exist',
      eval: undefined,
      removed: false,
    });
  });

  it('deleteExecution clears pendingDecisionResolvers entry for awaitHuman runs', async () => {
    const runtime = new AxlRuntime();
    // Directly seed the resolver map (the integration path is exercised
    // via Studio's playground / awaitHuman flows; this unit test isolates
    // the cleanup contract).
    const resolvers = (runtime as unknown as { pendingDecisionResolvers: Map<string, unknown> })
      .pendingDecisionResolvers;
    resolvers.set('exec-awaiting', () => {});
    expect(resolvers.has('exec-awaiting')).toBe(true);

    const audit: Array<{ executionId: string; hadPendingDecision: boolean }> = [];
    runtime.on('execution_deleted', (e) => audit.push(e));

    await runtime.deleteExecution('exec-awaiting');
    expect(resolvers.has('exec-awaiting')).toBe(false);
    expect(audit[0].hadPendingDecision).toBe(true);
  });

  it('in-flight deleteExecution does not resurrect the row when the workflow eventually completes', async () => {
    // Before the resurrection fix, deleting a still-running execution
    // succeeded but `persistExecution` (called on terminal exit) would
    // re-create the row in the historical cache + store. GDPR delete
    // effectively undone seconds later.
    const runtime = new AxlRuntime();
    runtime.registerProvider('test', new TestProvider([{ content: 'ok' }]) as any);
    let resolveBlock: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      resolveBlock = resolve;
    });
    const wf = workflow({
      name: 'long-wf',
      input: z.object({}).strict(),
      handler: async () => {
        await blocker;
        return 'done';
      },
    });
    runtime.register(wf);
    const inflight = runtime.execute('long-wf', {});
    await new Promise((r) => setTimeout(r, 10));
    const [activeId] = (await runtime.getExecutions()).map((e) => e.executionId);
    expect(activeId).toBeDefined();

    // Delete while still running.
    const deletedNow = await runtime.deleteExecution(activeId);
    expect(deletedNow).toBe(true);

    // The workflow's blocking promise resolves; persistExecution would
    // normally re-create the row. The resurrection guard prevents this.
    resolveBlock!();
    await inflight.catch(() => {});
    // Give the persist chain a tick to settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(await runtime.getExecution(activeId)).toBeUndefined();
    expect(await runtime.getExecutions()).toHaveLength(0);
  });

  it('ExecutionInfo.metadata strips control-plane keys (sessionHistory, sessionId, resumeMode)', async () => {
    const runtime = new AxlRuntime();
    runtime.registerProvider('test', new TestProvider([{ content: 'ok' }]) as any);
    const wf = workflow({
      name: 'meta-strip',
      input: z.object({}).strict(),
      handler: async () => 'ok',
    });
    runtime.register(wf);

    await runtime.execute(
      'meta-strip',
      {},
      {
        metadata: {
          userId: 'u-42',
          tenantId: 't-7',
          sessionHistory: [
            { role: 'user', content: 'a much longer message that we don’t want persisted' },
          ],
          sessionId: 'sess-internal',
          resumeMode: true,
        },
      },
    );
    const [exec] = await runtime.getExecutions();
    expect(exec.metadata).toEqual({ userId: 'u-42', tenantId: 't-7' });
    // Internal keys not present
    expect(exec.metadata?.sessionHistory).toBeUndefined();
    expect(exec.metadata?.sessionId).toBeUndefined();
    expect(exec.metadata?.resumeMode).toBeUndefined();
  });

  it('ExecutionInfo.metadata is isolated from caller mutation post-execute', async () => {
    const runtime = new AxlRuntime();
    runtime.registerProvider('test', new TestProvider([{ content: 'ok' }]) as any);
    const wf = workflow({
      name: 'meta-isolate',
      input: z.object({}).strict(),
      handler: async () => 'ok',
    });
    runtime.register(wf);

    const metadata: Record<string, unknown> = { userId: 'u-42' };
    await runtime.execute('meta-isolate', {}, { metadata });
    metadata.userId = 'mutated-after-the-fact';

    const [exec] = await runtime.getExecutions();
    expect(exec.metadata).toEqual({ userId: 'u-42' });
  });

  it('ExecutionInfo.metadata gracefully drops non-cloneable values (no workflow crash)', async () => {
    // structuredClone throws on functions / non-transferable types.
    // Pipeline:
    //   1. liftPersistedMetadata structuredClone fails → shallow-copy
    //      fallback at the lift boundary (includes the function).
    //   2. persistExecution structuredClone(execInfo) ALSO fails because
    //      the shallow copy still carries the function. Falls back to a
    //      hand-rolled snapshot that sanitizes metadata via
    //      sanitizeMetadataForPersist — drops non-cloneable keys.
    //   3. Workflow completes; cloneable keys survive; non-cloneable
    //      keys are silently dropped from the persisted snapshot.
    // The contract: non-cloneable metadata must NOT crash the workflow.
    const runtime = new AxlRuntime();
    runtime.registerProvider('test', new TestProvider([{ content: 'ok' }]) as any);
    const wf = workflow({
      name: 'meta-nonclone',
      input: z.object({}).strict(),
      handler: async () => 'ok',
    });
    runtime.register(wf);

    const result = await runtime.execute(
      'meta-nonclone',
      {},
      { metadata: { userId: 'u-1', cb: () => 'opaque' } },
    );
    expect(result).toBe('ok');

    const [exec] = await runtime.getExecutions();
    // Cloneable keys survive
    expect(exec.metadata?.userId).toBe('u-1');
    // Non-cloneable key dropped from the persisted snapshot (no crash)
    expect(exec.metadata?.cb).toBeUndefined();
  });

  it('execInfo.metadata is undefined when caller only supplied control-plane keys', async () => {
    const runtime = new AxlRuntime();
    runtime.registerProvider('test', new TestProvider([{ content: 'ok' }]) as any);
    const wf = workflow({
      name: 'meta-only-internal',
      input: z.object({}).strict(),
      handler: async () => 'ok',
    });
    runtime.register(wf);

    await runtime.execute(
      'meta-only-internal',
      {},
      { metadata: { sessionId: 's', resumeMode: false } },
    );
    const [exec] = await runtime.getExecutions();
    expect(exec.metadata).toBeUndefined();
  });
});

describe("state.persist: 'streaming' (#1)", () => {
  // Use MemoryStore for these tests — its streaming methods are functional
  // stubs that work in-process. Production users get crash-survival via
  // RedisStore, but the runtime-side flusher logic is store-agnostic.

  function makeRuntime(
    persist: 'terminal' | 'streaming',
    extras?: { batchSize?: number; batchInterval?: number },
  ) {
    const runtime = new AxlRuntime({
      state: {
        store: 'memory',
        persist,
        streamingBatchSize: extras?.batchSize,
        streamingBatchInterval: extras?.batchInterval,
      },
    });
    runtime.registerProvider('test', new TestProvider([{ content: 'ok' }]) as any);
    const wf = workflow({
      name: 'wf',
      input: z.object({ msg: z.string() }),
      handler: async (ctx) => `echo: ${ctx.input.msg}`,
    });
    runtime.register(wf);
    return runtime;
  }

  it('terminal mode (default) does not buffer events to the streaming store', async () => {
    const runtime = makeRuntime('terminal');
    const store = runtime.getStateStore();

    await runtime.execute('wf', { msg: 'hi' });

    // No streaming buffer was created — there's nothing to recover.
    const ids = (await store.listStreamingExecutions?.()) ?? [];
    expect(ids).toEqual([]);
  });

  it('streaming mode flushes events to the store and finalizes on graceful exit', async () => {
    const runtime = makeRuntime('streaming', { batchSize: 1, batchInterval: 10 });
    const store = runtime.getStateStore();

    await runtime.execute('wf', { msg: 'hi' });
    // persistExecution chains save→finalize fire-and-forget after execute()
    // returns. Wait a tick for the chain to settle before asserting.
    await new Promise((r) => setTimeout(r, 50));

    // After the workflow completes successfully, the streaming buffer is
    // finalized — listStreamingExecutions should be empty.
    const ids = (await store.listStreamingExecutions?.()) ?? [];
    expect(ids).toEqual([]);
  });

  it('streaming mode leaves the buffer in place when saveExecution fails', async () => {
    // Custom store that has streaming methods but fails saveExecution.
    const buffers = new Map<string, import('../types.js').AxlEvent[]>();
    const fakeStore = {
      saveCheckpoint: async () => {},
      getCheckpoint: async () => null,
      saveSession: async () => {},
      getSession: async () => [],
      deleteSession: async () => {},
      saveSessionMeta: async () => {},
      getSessionMeta: async () => null,
      savePendingDecision: async () => {},
      getPendingDecisions: async () => [],
      resolveDecision: async () => {},
      saveExecutionState: async () => {},
      getExecutionState: async () => null,
      listPendingExecutions: async () => [],
      // Streaming methods
      appendStreamingEvents: async (id: string, events: import('../types.js').AxlEvent[]) => {
        const existing = buffers.get(id) ?? [];
        existing.push(...events);
        buffers.set(id, existing);
      },
      finalizeStreamingEvents: async (id: string) => {
        buffers.delete(id);
      },
      listStreamingExecutions: async () => [...buffers.keys()],
      getStreamingEvents: async (id: string) => buffers.get(id) ?? [],
      // Failing saveExecution
      saveExecution: async () => {
        throw new Error('store unavailable');
      },
    };

    const runtime = new AxlRuntime({
      state: {
        store: fakeStore as any,
        persist: 'streaming',
        streamingBatchSize: 1,
        streamingBatchInterval: 10,
      },
    });
    runtime.registerProvider('test', new TestProvider([{ content: 'ok' }]) as any);
    const wf = workflow({
      name: 'wf',
      input: z.object({}).strict(),
      handler: async () => 'ok',
    });
    runtime.register(wf);

    await runtime.execute('wf', {});

    // Give the chained promise (.then(finalize).catch) a tick to settle
    await new Promise((r) => setTimeout(r, 50));

    // The streaming buffer is preserved because saveExecution failed.
    // Buffer-finalize is gated on saveExecution success — this preserves
    // the buffer for next-process recovery.
    const ids = await fakeStore.listStreamingExecutions();
    expect(ids.length).toBe(1);
  });

  it('streaming mode excludes token/partial_object/string_delta events', async () => {
    const buffers = new Map<string, import('../types.js').AxlEvent[]>();
    const fakeStore = {
      saveCheckpoint: async () => {},
      getCheckpoint: async () => null,
      saveSession: async () => {},
      getSession: async () => [],
      deleteSession: async () => {},
      saveSessionMeta: async () => {},
      getSessionMeta: async () => null,
      savePendingDecision: async () => {},
      getPendingDecisions: async () => [],
      resolveDecision: async () => {},
      saveExecutionState: async () => {},
      getExecutionState: async () => null,
      listPendingExecutions: async () => [],
      saveExecution: async () => {},
      getExecution: async () => null,
      listExecutions: async () => [],
      appendStreamingEvents: async (id: string, events: import('../types.js').AxlEvent[]) => {
        const existing = buffers.get(id) ?? [];
        existing.push(...events);
        buffers.set(id, existing);
      },
      finalizeStreamingEvents: async () => {},
      listStreamingExecutions: async () => [],
      getStreamingEvents: async () => [],
    };

    const runtime = new AxlRuntime({
      state: {
        store: fakeStore as any,
        persist: 'streaming',
        streamingBatchSize: 1,
        streamingBatchInterval: 10,
      },
    });

    // Use a real workflow execution so the streamableExecutionIds gate is
    // satisfied — createContext() flows deliberately bypass the flusher
    // (no terminal finalize path), and that's exercised separately below.
    const wf = workflow({
      name: 'wf-excludes',
      input: z.object({}).strict(),
      handler: async (ctx) => {
        (ctx as any).emitEvent({ type: 'token', data: 'x' });
        (ctx as any).emitEvent({ type: 'partial_object', data: { object: {} } });
        (ctx as any).emitEvent({ type: 'string_delta', data: { path: '/x', delta: 'a' } });
        (ctx as any).emitEvent({ type: 'agent_call_start', agent: 'A' });
        return 'ok';
      },
    });
    runtime.register(wf);
    await runtime.execute('wf-excludes', {});

    // Give the chained finalize a tick to settle
    await new Promise((r) => setTimeout(r, 50));

    // Only the agent_call_start (and workflow_start/_end emitted by the
    // runtime itself) were kept — the three excluded types were dropped.
    const allBufferedEvents = [...buffers.values()].flat();
    const types = new Set(allBufferedEvents.map((e) => e.type));
    expect(types.has('token')).toBe(false);
    expect(types.has('partial_object')).toBe(false);
    expect(types.has('string_delta')).toBe(false);
    expect(types.has('agent_call_start')).toBe(true);
  });

  it('createContext() flows do NOT append to the streaming flusher (no terminal finalize path → would leave phantom orphans)', async () => {
    const buffers = new Map<string, import('../types.js').AxlEvent[]>();
    const idsTouched = new Set<string>();
    const fakeStore = {
      saveCheckpoint: async () => {},
      getCheckpoint: async () => null,
      saveSession: async () => {},
      getSession: async () => [],
      deleteSession: async () => {},
      saveSessionMeta: async () => {},
      getSessionMeta: async () => null,
      savePendingDecision: async () => {},
      getPendingDecisions: async () => [],
      resolveDecision: async () => {},
      saveExecutionState: async () => {},
      getExecutionState: async () => null,
      listPendingExecutions: async () => [],
      saveExecution: async () => {},
      getExecution: async () => null,
      listExecutions: async () => [],
      appendStreamingEvents: async (id: string, events: import('../types.js').AxlEvent[]) => {
        idsTouched.add(id);
        const existing = buffers.get(id) ?? [];
        existing.push(...events);
        buffers.set(id, existing);
      },
      finalizeStreamingEvents: async () => {},
      listStreamingExecutions: async () => [],
      getStreamingEvents: async () => [],
    };

    const runtime = new AxlRuntime({
      state: {
        store: fakeStore as any,
        persist: 'streaming',
        streamingBatchSize: 1,
        streamingBatchInterval: 10,
      },
    });

    const ctx = runtime.createContext();
    (ctx as any).emitEvent({
      type: 'log',
      executionId: 'ad-hoc',
      step: 0,
      timestamp: 1000,
      data: { event: 'pli' },
    });
    (ctx as any).emitEvent({ type: 'agent_call_start', agent: 'A' });

    await new Promise((r) => setTimeout(r, 50));

    // Nothing made it to the flusher because the createContext id was never
    // registered as a streamable execution. This is the fix for the
    // phantom-orphan-on-restart bug.
    expect(idsTouched.size).toBe(0);
    expect([...buffers.values()].flat()).toHaveLength(0);
  });

  it('recoverIncompleteStreams synthesizes ExecutionInfo for orphaned buffers', async () => {
    const buffers = new Map<string, import('../types.js').AxlEvent[]>();
    const saved: import('../types.js').ExecutionInfo[] = [];
    const fakeStore = {
      saveCheckpoint: async () => {},
      getCheckpoint: async () => null,
      saveSession: async () => {},
      getSession: async () => [],
      deleteSession: async () => {},
      saveSessionMeta: async () => {},
      getSessionMeta: async () => null,
      savePendingDecision: async () => {},
      getPendingDecisions: async () => [],
      resolveDecision: async () => {},
      saveExecutionState: async () => {},
      getExecutionState: async () => null,
      listPendingExecutions: async () => [],
      saveExecution: async (exec: import('../types.js').ExecutionInfo) => {
        saved.push(exec);
      },
      getExecution: async () => null,
      listExecutions: async () => [],
      appendStreamingEvents: async () => {},
      finalizeStreamingEvents: async (id: string) => {
        buffers.delete(id);
      },
      listStreamingExecutions: async () => [...buffers.keys()],
      getStreamingEvents: async (id: string) => buffers.get(id) ?? [],
    };

    // Plant an orphaned streaming buffer simulating a crashed execution.
    buffers.set('orphan-1', [
      {
        executionId: 'orphan-1',
        step: 0,
        type: 'workflow_start',
        workflow: 'my-workflow',
        timestamp: 1000,
        data: { input: { foo: 'bar' } },
      } as any,
      {
        executionId: 'orphan-1',
        step: 1,
        type: 'agent_call_end',
        agent: 'A',
        model: 'm',
        cost: 0.05,
        duration: 50,
        timestamp: 1100,
        askId: 'a',
        depth: 0,
        data: {},
      } as any,
      {
        executionId: 'orphan-1',
        step: 2,
        type: 'agent_call_end',
        agent: 'B',
        model: 'unpriced-model',
        tokens: { input: 10, output: 5 },
        duration: 25,
        timestamp: 1150,
        askId: 'b',
        depth: 0,
        data: {},
      } as any,
    ]);

    const runtime = new AxlRuntime({
      state: { store: fakeStore as any, persist: 'streaming' },
    });

    const recovered = await runtime.recoverIncompleteStreams();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].executionId).toBe('orphan-1');
    expect(recovered[0].status).toBe('failed');
    expect(recovered[0].error).toContain('process terminated');
    expect(recovered[0].workflow).toBe('my-workflow');
    // totalCost summed from cost-bearing events
    expect(recovered[0].totalCost).toBeCloseTo(0.05);
    expect(recovered[0].unpriced).toBe(true);
    // Events preserved
    expect(recovered[0].events).toHaveLength(3);

    // Saved to store + buffer finalized
    expect(saved).toHaveLength(1);
    expect(buffers.has('orphan-1')).toBe(false);
  });

  it('recoverIncompleteStreams is a no-op when no orphans exist', async () => {
    const runtime = makeRuntime('streaming');
    const recovered = await runtime.recoverIncompleteStreams();
    expect(recovered).toEqual([]);
  });

  it('recoverIncompleteStreams returns [] when the store does not support streaming', async () => {
    const runtime = new AxlRuntime(); // MemoryStore default; persist not set
    const recovered = await runtime.recoverIncompleteStreams();
    expect(recovered).toEqual([]);
  });

  it('recoverIncompleteStreams skips ids of executions actively running in this process', async () => {
    // Recovery races with a live workflow: the buffer is owned by an
    // in-process execution. Recovery must not synthesize a "failed" record
    // + delete the live buffer.
    const runtime = makeRuntime('streaming');
    let resolveBlock: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      resolveBlock = resolve;
    });
    const wf = workflow({
      name: 'long-stream',
      input: z.object({}).strict(),
      handler: async () => {
        await blocker;
        return 'done';
      },
    });
    runtime.register(wf);
    const inflight = runtime.execute('long-stream', {});
    await new Promise((r) => setTimeout(r, 30));

    // Recovery should NOT touch the live execution.
    const recovered = await runtime.recoverIncompleteStreams();
    expect(recovered).toHaveLength(0);

    resolveBlock!();
    await inflight;
  });

  it('recoverIncompleteStreams preserves the buffer when saveExecution fails (no data loss)', async () => {
    const buffers = new Map<string, import('../types.js').AxlEvent[]>();
    buffers.set('crashed-1', [
      {
        type: 'workflow_start',
        executionId: 'crashed-1',
        workflow: 'wf-x',
        step: 0,
        timestamp: 1000,
        data: { input: {} },
      } as unknown as import('../types.js').AxlEvent,
    ]);
    const fakeStore = {
      saveCheckpoint: async () => {},
      getCheckpoint: async () => null,
      saveSession: async () => {},
      getSession: async () => [],
      deleteSession: async () => {},
      saveSessionMeta: async () => {},
      getSessionMeta: async () => null,
      savePendingDecision: async () => {},
      getPendingDecisions: async () => [],
      resolveDecision: async () => {},
      saveExecutionState: async () => {},
      getExecutionState: async () => null,
      listPendingExecutions: async () => [],
      saveExecution: async () => {
        throw new Error('save failed (simulated)');
      },
      getExecution: async () => null,
      listExecutions: async () => [],
      listStreamingExecutions: async () => [...buffers.keys()],
      getStreamingEvents: async (id: string) => buffers.get(id) ?? [],
      finalizeStreamingEvents: async (id: string) => {
        buffers.delete(id);
      },
      appendStreamingEvents: async () => {},
    };
    const runtime = new AxlRuntime({
      state: { store: fakeStore as never, persist: 'streaming' },
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recovered = await runtime.recoverIncompleteStreams();
    expect(recovered).toHaveLength(0);
    // Buffer left in place for next attempt — NOT finalized.
    expect(buffers.has('crashed-1')).toBe(true);
    errorSpy.mockRestore();
  });

  it('recoverIncompleteStreams applies maxEventsPerExecution bound to synthesized events', async () => {
    const cap = 5;
    const events = Array.from({ length: 50 }, (_, i) => ({
      type: i === 0 ? 'workflow_start' : 'log',
      executionId: 'big',
      workflow: 'huge-wf',
      step: i,
      timestamp: 1000 + i,
      data: i === 0 ? { input: {} } : { n: i },
    })) as unknown as import('../types.js').AxlEvent[];
    const buffers = new Map([['big', events]]);
    const saved: import('../types.js').ExecutionInfo[] = [];
    const fakeStore = {
      saveCheckpoint: async () => {},
      getCheckpoint: async () => null,
      saveSession: async () => {},
      getSession: async () => [],
      deleteSession: async () => {},
      saveSessionMeta: async () => {},
      getSessionMeta: async () => null,
      savePendingDecision: async () => {},
      getPendingDecisions: async () => [],
      resolveDecision: async () => {},
      saveExecutionState: async () => {},
      getExecutionState: async () => null,
      listPendingExecutions: async () => [],
      saveExecution: async (e: import('../types.js').ExecutionInfo) => {
        saved.push(e);
      },
      getExecution: async () => null,
      listExecutions: async () => [],
      listStreamingExecutions: async () => [...buffers.keys()],
      getStreamingEvents: async (id: string) => buffers.get(id) ?? [],
      finalizeStreamingEvents: async (id: string) => {
        buffers.delete(id);
      },
      appendStreamingEvents: async () => {},
    };
    const runtime = new AxlRuntime({
      state: {
        store: fakeStore as never,
        persist: 'streaming',
        maxEventsPerExecution: cap,
      },
    });

    const recovered = await runtime.recoverIncompleteStreams();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].events).toHaveLength(cap);
    // Last entry is the truncation sentinel.
    const last = recovered[0].events[cap - 1];
    expect(last.type).toBe('log');
    expect((last as unknown as { data: { event?: string } }).data.event).toBe('events_truncated');
  });

  it('finalize awaits in-flight flush — no orphan buffer when size-flush races with finalize', async () => {
    // Reproduces the race: (1) append triggers size-cap flush → in-flight
    // RPUSH starts. (2) finalize called concurrently. Without the inflight
    // tracking, finalize's DEL/SREM lands BEFORE the late RPUSH, which then
    // resurrects the buffer + re-registers the executionId — creating a
    // phantom orphan that recoverIncompleteStreams would later mis-recover.
    let resolveAppend!: () => void;
    const appendPromise = new Promise<void>((res) => {
      resolveAppend = res;
    });
    let appendDone = false;
    let finalizeCalledAt: number | null = null;
    let appendCompletedAt: number | null = null;

    const fakeStore = {
      saveCheckpoint: async () => {},
      getCheckpoint: async () => null,
      saveSession: async () => {},
      getSession: async () => [],
      deleteSession: async () => {},
      saveSessionMeta: async () => {},
      getSessionMeta: async () => null,
      savePendingDecision: async () => {},
      getPendingDecisions: async () => [],
      resolveDecision: async () => {},
      saveExecutionState: async () => {},
      getExecutionState: async () => null,
      listPendingExecutions: async () => [],
      saveExecution: async () => {},
      appendStreamingEvents: async () => {
        // Slow append — blocks on appendPromise. Lets the test interleave
        // a finalize call while this is in-flight.
        await appendPromise;
        appendDone = true;
        appendCompletedAt = Date.now();
      },
      finalizeStreamingEvents: async () => {
        finalizeCalledAt = Date.now();
      },
      listStreamingExecutions: async () => [],
      getStreamingEvents: async () => [],
    };

    const runtime = new AxlRuntime({
      state: {
        store: fakeStore as any,
        persist: 'streaming',
        streamingBatchSize: 1, // every append triggers size-flush
        streamingBatchInterval: 10_000,
      },
    });
    // Reach into the flusher directly so we control the executionId
    // (createContext generates a UUID we'd have to discover).
    const flusher = (runtime as any).streamingFlusher;

    // First append — fires the size-cap flush, which blocks awaiting appendPromise
    flusher.append('race-1', {
      type: 'log',
      executionId: 'race-1',
      step: 0,
      timestamp: 1000,
      data: {},
    });

    // Start finalize. The fix's correctness: finalize must AWAIT the
    // in-flight appendPromise before calling finalizeStreamingEvents.
    const finalizePromise = flusher.finalize('race-1');

    // Give finalize a tick to reach the await
    await new Promise((r) => setTimeout(r, 20));
    // appendPromise hasn't resolved yet, so finalize hasn't progressed
    // to the finalizeStreamingEvents call.
    expect(finalizeCalledAt).toBeNull();
    expect(appendDone).toBe(false);

    // Now resolve the in-flight append. Finalize should:
    //   (a) wait for it to land
    //   (b) THEN call finalizeStreamingEvents
    resolveAppend();
    await finalizePromise;

    expect(appendDone).toBe(true);
    expect(appendCompletedAt).not.toBeNull();
    expect(finalizeCalledAt).not.toBeNull();
    // Ordering: the late RPUSH landed BEFORE finalizeStreamingEvents.
    // Without the inflight-await fix, finalizeCalledAt would be < appendCompletedAt.
    expect(appendCompletedAt!).toBeLessThanOrEqual(finalizeCalledAt!);
  });

  it('shutdown() drains the streaming flusher before closing the store', async () => {
    let saveAttempts = 0;
    const fakeStore = {
      saveCheckpoint: async () => {},
      getCheckpoint: async () => null,
      saveSession: async () => {},
      getSession: async () => [],
      deleteSession: async () => {},
      saveSessionMeta: async () => {},
      getSessionMeta: async () => null,
      savePendingDecision: async () => {},
      getPendingDecisions: async () => [],
      resolveDecision: async () => {},
      saveExecutionState: async () => {},
      getExecutionState: async () => null,
      listPendingExecutions: async () => [],
      saveExecution: async () => {},
      appendStreamingEvents: async () => {
        saveAttempts++;
      },
      finalizeStreamingEvents: async () => {},
      listStreamingExecutions: async () => [],
      getStreamingEvents: async () => [],
      close: async () => {},
    };

    const runtime = new AxlRuntime({
      state: {
        store: fakeStore as any,
        persist: 'streaming',
        streamingBatchSize: 1000, // big — events won't trigger size-flush
        streamingBatchInterval: 60_000, // long — won't trigger time-flush
      },
    });

    // Stand up a long-running workflow so we have a real streaming-eligible
    // execution that emits events into the flusher buffer before shutdown.
    // (createContext flows don't qualify — see the dedicated test above.)
    let resolveHandler: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });
    const wf = workflow({
      name: 'wf-shutdown',
      input: z.object({}).strict(),
      handler: async (ctx) => {
        (ctx as any).emitEvent({
          type: 'log',
          executionId: 'manual',
          step: 0,
          timestamp: 1000,
          data: { msg: 'pre-shutdown event' },
        });
        await blocker;
        return 'ok';
      },
    });
    runtime.register(wf);
    const inflight = runtime.execute('wf-shutdown', {});

    // Yield so the handler runs and the log event lands in the flusher buffer.
    await new Promise((r) => setTimeout(r, 10));

    // Before shutdown — flush hasn't fired (cap not reached, timer not expired)
    expect(saveAttempts).toBe(0);

    // Shutdown aborts the in-flight workflow AND drains the flusher.
    const shutdownPromise = runtime.shutdown();
    resolveHandler!();
    await shutdownPromise;
    // Allow the abort-triggered persistExecution chain to settle so
    // saveAttempts is observed deterministically.
    await inflight.catch(() => {});

    // Drain happened — the log event we emitted made it through.
    expect(saveAttempts).toBeGreaterThan(0);
  });
});
