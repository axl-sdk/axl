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

  it('accepts onToken option without error', async () => {
    const { runtime } = createRuntime();

    const ctx = runtime.createContext({
      onToken: () => {},
    });
    expect(ctx).toBeDefined();
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

  it('captureTraces strips high-volume token and partial_object events', async () => {
    // Reviewer bug B3: `execInfo.events` (runtime.ts:570, :735) strips
    // `token` and `partial_object` to bound memory, but the
    // `captureTraces` path did not — so `runEval({captureTraces: true})`
    // on a streaming eval item blew the captured-traces array.
    const provider = new TestProvider([{ content: 'hello world', cost: 0.01 }]);
    const { runtime } = createRuntime(provider);
    const testAgent = agent({ name: 'test', model: 'test:default', system: 'test' });

    const { traces } = await runtime.trackExecution(
      async () => {
        const ctx = runtime.createContext({ onToken: () => {} });
        return ctx.ask(testAgent, 'hi');
      },
      { captureTraces: true },
    );

    expect(traces).toBeDefined();
    // High-volume stream-only events must NOT be captured.
    expect(traces!.some((t) => t.type === 'token')).toBe(false);
    expect(traces!.some((t) => t.type === 'partial_object')).toBe(false);
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
