import { describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { z } from 'zod';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { EventStreamOverflowError } from '../event-stream.js';
import { MockProvider } from '../../../axl-testing/src/mock-provider.js';
import type { AxlEvent } from '../types.js';

/** Build a runtime with a single mock provider already registered. */
function buildRuntime(provider: MockProvider): AxlRuntime {
  const runtime = new AxlRuntime({ defaultProvider: 'mock' });
  runtime.registerProvider('mock', provider);
  return runtime;
}

describe('ctx.events — workflow handler observation', () => {
  it('replaces onToolCall with a fully correlated tool_call_start listener', async () => {
    const provider = MockProvider.sequence([
      {
        content: '',
        tool_calls: [
          {
            id: 'call-lookup',
            type: 'function',
            function: { name: 'lookup', arguments: '{"id":"case-1"}' },
          },
        ],
      },
      { content: 'done' },
    ]);
    const runtime = buildRuntime(provider);
    const lookup = tool({
      name: 'lookup',
      description: 'Look up a case',
      input: z.object({ id: z.string() }),
      handler: ({ id }) => ({ id }),
    });
    const a = agent({ name: 'a', model: 'mock:test', system: 'a', tools: [lookup] });
    let observed: Extract<AxlEvent, { type: 'tool_call_start' }> | undefined;
    const wf = workflow({
      name: 'observe-tool-start',
      input: z.object({}),
      handler: async (ctx) => {
        ctx.events.on('tool_call_start', (event) => {
          observed = event;
        });
        return ctx.ask(a, 'look it up');
      },
    });
    runtime.register(wf);

    await runtime.execute('observe-tool-start', {});

    expect(observed).toMatchObject({
      tool: 'lookup',
      callId: 'call-lookup',
      askId: expect.any(String),
      depth: 0,
      agent: 'a',
      data: { args: { id: 'case-1' } },
    });
  });

  it('iterates events emitted between two ctx.ask() calls', async () => {
    const provider = MockProvider.sequence([{ content: 'first' }, { content: 'second' }]);
    const runtime = buildRuntime(provider);

    const a = agent({ name: 'a', model: 'mock:test', system: 'a' });
    const b = agent({ name: 'b', model: 'mock:test', system: 'b' });

    const events: AxlEvent[] = [];
    const wf = workflow({
      name: 'between-asks',
      input: z.object({}),
      handler: async (ctx) => {
        // Subscribe BEFORE the first ask so we don't miss anything.
        void (async () => {
          for await (const e of ctx.events.lifecycle) {
            events.push(e);
          }
        })();
        await ctx.ask(a, 'first');
        await ctx.ask(b, 'second');
        return { ok: true };
      },
    });
    runtime.register(wf);

    await runtime.execute('between-asks', {});

    // We must see lifecycle events from BOTH asks.
    const askStarts = events.filter((e) => e.type === 'ask_start');
    const askEnds = events.filter((e) => e.type === 'ask_end');
    const agentStarts = events.filter((e) => e.type === 'agent_call_start');
    expect(askStarts).toHaveLength(2);
    expect(askEnds).toHaveLength(2);
    expect(agentStarts.map((e) => (e as { agent: string }).agent)).toEqual(['a', 'b']);
  });

  it('iterator terminates when workflow_end is emitted', async () => {
    const provider = MockProvider.sequence([{ content: 'done' }]);
    const runtime = buildRuntime(provider);
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });

    let terminatedNaturally = false;
    const wf = workflow({
      name: 'auto-terminate',
      input: z.object({}),
      handler: async (ctx) => {
        void (async () => {
          let count = 0;
          for await (const _e of ctx.events) {
            void _e;
            count++;
          }
          // If we got here, the iterator terminated cleanly with done:true.
          terminatedNaturally = count > 0;
        })();
        await ctx.ask(a, 'hi');
        // Yield so the runtime emits workflow_end and the iterator drains.
        await new Promise((r) => setImmediate(r));
        return { result: 'final' };
      },
    });
    runtime.register(wf);

    await runtime.execute('auto-terminate', {});
    // Allow microtasks for the in-handler collector to complete.
    await new Promise((r) => setImmediate(r));
    expect(terminatedNaturally).toBe(true);
  });

  it('events bus is lazy — never allocated when no consumer subscribes', async () => {
    const provider = MockProvider.sequence([{ content: 'x' }]);
    const runtime = buildRuntime(provider);
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });

    let busAllocated = false;
    const wf = workflow({
      name: 'lazy-check',
      input: z.object({}),
      handler: async (ctx) => {
        // Don't access ctx.events at all.
        await ctx.ask(a, 'hi');
        // Reflect on the internal slot.
        busAllocated =
          (ctx as unknown as { _busRef: { current: unknown } })._busRef.current !== undefined;
        return { ok: true };
      },
    });
    runtime.register(wf);

    await runtime.execute('lazy-check', {});
    expect(busAllocated).toBe(false);
  });
});

describe('ctx.events — child context inheritance (agent-as-tool)', () => {
  it('nested-ask events bubble up to parent ctx.events even when consumer subscribes after the child exists', async () => {
    // Agent-as-tool: outer agent has a tool whose handler invokes ctx.ask
    // on a sub-agent via a child context.
    const subAgent = agent({ name: 'sub_specialist', model: 'mock:test', system: 'sub' });
    const askTool = tool({
      name: 'ask_sub',
      description: 'ask the sub specialist',
      input: z.object({ q: z.string() }),
      handler: async (input, ctx) => ctx.ask(subAgent, input.q),
    });
    const outerAgent = agent({
      name: 'outer',
      model: 'mock:test',
      system: 'outer',
      tools: [askTool],
    });

    // Turn 1 (outer): tool_call → ask_sub
    // Turn 2 (sub):   text "INNER"
    // Turn 3 (outer): text "OUTER"
    const provider = MockProvider.sequence([
      {
        content: '',
        chunks: [],
        tool_calls: [
          {
            id: 'tc1',
            type: 'function' as const,
            function: { name: 'ask_sub', arguments: '{"q":"go"}' },
          },
        ],
      },
      { content: 'INNER' },
      { content: 'OUTER' },
    ]);
    const runtime = buildRuntime(provider);

    const events: AxlEvent[] = [];
    const wf = workflow({
      name: 'nested-bubble',
      input: z.object({}),
      handler: async (ctx) => {
        // Subscribe BEFORE ctx.ask. The tool handler creates a child context
        // internally (via ctx.createChildContext()), and the sub-agent's
        // events should reach this iterator too.
        void (async () => {
          for await (const e of ctx.events.lifecycle) events.push(e);
        })();
        return ctx.ask(outerAgent, 'start');
      },
    });
    runtime.register(wf);

    await runtime.execute('nested-bubble', {});
    await new Promise((r) => setImmediate(r));

    // We must see agent_call_start for BOTH the outer and the sub agent.
    const agentNames = events
      .filter((e) => e.type === 'agent_call_start')
      .map((e) => (e as { agent: string }).agent);
    expect(agentNames).toContain('outer');
    expect(agentNames).toContain('sub_specialist');
  });

  it('child context shares the parent bus slot — late parent allocation is visible to child', async () => {
    // Allocate a child context BEFORE the parent's ctx.events is accessed,
    // then access it. The child's emitEvent must subsequently fan out to
    // the parent's bus (the shared `_busRef.current` is now defined).
    const provider = MockProvider.sequence([{ content: 'x' }]);
    const runtime = buildRuntime(provider);
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });

    const childEvents: AxlEvent[] = [];
    const wf = workflow({
      name: 'late-allocation',
      input: z.object({}),
      handler: async (ctx) => {
        // Pre-create child context (no observer yet).
        const child = ctx.createChildContext();
        // Now subscribe on the parent — allocates the bus.
        void (async () => {
          for await (const e of ctx.events) childEvents.push(e);
        })();
        await new Promise((r) => setImmediate(r));
        // Child runs an ask. Events should flow to the parent's iterator.
        await child.ask(a, 'go');
        // Allow microtasks for the iterator to drain.
        await new Promise((r) => setImmediate(r));
        return {};
      },
    });
    runtime.register(wf);

    await runtime.execute('late-allocation', {});
    await new Promise((r) => setImmediate(r));
    // The child's agent_call_start must appear in the parent's iterator.
    const childAgentCalls = childEvents.filter((e) => e.type === 'agent_call_start');
    expect(childAgentCalls.length).toBeGreaterThan(0);
  });
});

describe('ctx.events — createContext (ad-hoc) usage', () => {
  it('disposeEvents() terminates iterators on contexts that never run a workflow', async () => {
    const runtime = buildRuntime(MockProvider.sequence([{ content: 'x' }]));
    const ctx = runtime.createContext();
    let count = 0;
    let terminatedDoneTrue = false;
    const consumer = (async () => {
      for await (const _e of ctx.events) {
        void _e;
        count++;
      }
      terminatedDoneTrue = true;
    })();
    // Park the consumer.
    await new Promise((r) => setImmediate(r));
    ctx.disposeEvents();
    await consumer;
    expect(count).toBe(0);
    expect(terminatedDoneTrue).toBe(true);
  });

  it('disposeEvents() is idempotent', () => {
    const runtime = buildRuntime(MockProvider.sequence([{ content: 'x' }]));
    const ctx = runtime.createContext();
    expect(() => {
      ctx.disposeEvents();
      ctx.disposeEvents();
    }).not.toThrow();
  });

  it('disposeEvents() before any ctx.events access does not allocate a bus', () => {
    const runtime = buildRuntime(MockProvider.sequence([{ content: 'x' }]));
    const ctx = runtime.createContext();
    ctx.disposeEvents();
    const allocated = (ctx as unknown as { _busRef: { current: unknown } })._busRef.current;
    expect(allocated).toBeUndefined();
  });

  it('signal abort auto-disposes ctx.events on createContext flows (no workflow terminal needed)', async () => {
    const runtime = buildRuntime(MockProvider.sequence([{ content: 'x' }]));
    const ac = new AbortController();
    const ctx = runtime.createContext({ signal: ac.signal });

    let count = 0;
    let terminated = false;
    const consumer = (async () => {
      for await (const _e of ctx.events) {
        void _e;
        count++;
      }
      terminated = true;
    })();
    // Park the consumer.
    await new Promise((r) => setImmediate(r));
    // Abort. The constructor-attached listener should call disposeEvents.
    ac.abort();
    await consumer;
    expect(count).toBe(0);
    expect(terminated).toBe(true);
  });

  it('pre-aborted signal at createContext time disposes the bus on first ctx.events access', async () => {
    const runtime = buildRuntime(MockProvider.sequence([{ content: 'x' }]));
    const ac = new AbortController();
    ac.abort(); // pre-abort BEFORE createContext
    const ctx = runtime.createContext({ signal: ac.signal });

    // ctx.events is created lazily here. The getter must finish it
    // immediately so the iterator terminates cleanly instead of hanging.
    let terminated = false;
    for await (const _e of ctx.events) {
      void _e;
    }
    terminated = true;
    expect(terminated).toBe(true);
  });

  it('child contexts do NOT register their own abort listener (only the root does)', async () => {
    // Pin the `init._busRef === undefined` gate in WorkflowContext's
    // constructor: if a child context (which inherits the parent's
    // `_busRef`) ALSO attached an abort listener, the bus would try to
    // _finish multiple times on abort. _finish is idempotent so the
    // bug isn't user-observable, but the listener pool would grow with
    // each child context — a leak under fan-out workloads.
    //
    // AbortSignal (EventTarget) does not expose listener count, so spy
    // on addEventListener instead. Each *root* WorkflowContext is
    // expected to call this exactly once with 'abort'; child contexts
    // (sharing the parent's `_busRef`) must call it zero times.
    const runtime = buildRuntime(MockProvider.sequence([{ content: 'x' }]));
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, 'addEventListener');
    const ctx = runtime.createContext({ signal: ac.signal });
    const abortAfterRoot = addSpy.mock.calls.filter((c) => c[0] === 'abort').length;
    // Spawn 5 child contexts.
    for (let i = 0; i < 5; i++) ctx.createChildContext();
    const abortAfterChildren = addSpy.mock.calls.filter((c) => c[0] === 'abort').length;
    // Root context registered exactly one 'abort' listener.
    expect(abortAfterRoot).toBe(1);
    // Child contexts must not have added any. Total still 1.
    expect(abortAfterChildren).toBe(1);
    addSpy.mockRestore();
  });

  it('disposeEvents() after workflow_end auto-finished the bus is a safe no-op', async () => {
    // After `runtime.execute()` completes, the bus has been auto-finished
    // by the `workflow_end` emit path. Calling `disposeEvents` is then
    // idempotent — it must not throw and not re-fire the iterator
    // termination.
    const provider = MockProvider.sequence([{ content: 'x' }]);
    const runtime = buildRuntime(provider);
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });

    let captured: unknown;
    const wf = workflow({
      name: 'post-finish-dispose',
      input: z.object({}),
      handler: async (ctx) => {
        void (async () => {
          for await (const _e of ctx.events) void _e;
        })();
        await ctx.ask(a, 'go');
        // Capture the ctx so we can dispose AFTER workflow_end fires.
        captured = ctx;
        return null;
      },
    });
    runtime.register(wf);
    await runtime.execute('post-finish-dispose', {});
    expect(() => (captured as { disposeEvents: () => void }).disposeEvents()).not.toThrow();
  });
});

describe('ctx.events — Session and AxlTestRuntime events plumbing', () => {
  it('Session.send forwards `events` option to runtime.execute', async () => {
    // Simplest verification: build an actual runtime, register a workflow
    // that sets onOverflow:'throw' and overflows the cap. The throw must
    // propagate through session.send → runtime.execute.
    const provider = MockProvider.sequence([{ content: 'x' }]);
    const runtime = buildRuntime(provider);
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });
    runtime.register(
      workflow({
        name: 'overflow-via-session',
        input: z.object({}),
        handler: async (ctx) => {
          void ctx.events; // allocate the bus
          await ctx.ask(a, 'hi');
          return null;
        },
      }),
    );
    const session = runtime.session('sess-events');
    await expect(
      session.send('overflow-via-session', {}, { events: { maxQueued: 1, onOverflow: 'throw' } }),
    ).rejects.toThrow(/maxQueued=1/);
  });

  it('Session.stream forwards `events` option to runtime.stream', async () => {
    const provider = MockProvider.sequence([{ content: 'x' }]);
    const runtime = buildRuntime(provider);
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });
    runtime.register(
      workflow({
        name: 'overflow-via-session-stream',
        input: z.object({}),
        handler: async (ctx) => {
          void ctx.events;
          await ctx.ask(a, 'hi');
          return null;
        },
      }),
    );
    const session = runtime.session('sess-events-stream');
    const stream = await session.stream(
      'overflow-via-session-stream',
      {},
      { events: { maxQueued: 1, onOverflow: 'throw' } },
    );
    // The throw propagates through the stream's promise rejection as a
    // typed EventStreamOverflowError (the runtime's onTrace try/catch
    // re-throws this specific class to preserve the "fail loudly on
    // saturation" contract).
    await expect(stream.promise).rejects.toBeInstanceOf(EventStreamOverflowError);
  });

  it('AxlStream onOverflow:"throw" propagates as EventStreamOverflowError (not silently swallowed by onTrace try/catch)', async () => {
    // Regression test for a pre-existing bug exposed during the gap-fix
    // pass: emitEvent's try/catch around `this.onTrace(finalEvent)` was
    // swallowing the throw from `axlStream._push` (which the runtime's
    // onTrace handler in runtime.stream() invokes). Strict-mode users
    // who set onOverflow:'throw' want the workflow to fail; the typed
    // error class lets emitEvent re-throw selectively.
    const provider = MockProvider.sequence([{ content: 'x' }]);
    const runtime = buildRuntime(provider);
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });
    runtime.register(
      workflow({
        name: 'overflow-on-stream',
        input: z.object({}),
        handler: async (ctx) => {
          // Don't allocate ctx.events — only the AxlStream's bus has the
          // cap and would throw. This isolates the regression.
          await ctx.ask(a, 'hi');
          return null;
        },
      }),
    );
    const stream = runtime.stream(
      'overflow-on-stream',
      {},
      { events: { maxQueued: 1, onOverflow: 'throw' } },
    );
    await expect(stream.promise).rejects.toBeInstanceOf(EventStreamOverflowError);
  });
});

describe('ctx.events — error isolation between onTrace and bus', () => {
  it('a throwing ctx.events tool listener cannot alter a successful tool outcome', async () => {
    const provider = MockProvider.sequence([
      {
        content: '',
        tool_calls: [
          {
            id: 'ctx-listener-call',
            type: 'function',
            function: { name: 'stable_ctx_tool', arguments: '{}' },
          },
        ],
      },
      { content: 'done' },
    ]);
    const runtime = buildRuntime(provider);
    const handler = vi.fn(() => ({ ok: true }));
    const stableTool = tool({
      name: 'stable_ctx_tool',
      description: 'remain successful when an observer throws',
      input: z.object({}),
      handler,
    });
    const a = agent({ name: 'a', model: 'mock:test', system: 's', tools: [stableTool] });
    runtime.register(
      workflow({
        name: 'ctx-listener-isolation',
        input: z.object({}),
        handler: async (ctx) => {
          ctx.events.on('tool_call_end', () => {
            throw new Error('ctx.events observer failed');
          });
          return ctx.ask(a, 'go');
        },
      }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runtime.execute('ctx-listener-isolation', {})).resolves.toBe('done');

    expect(handler).toHaveBeenCalledOnce();
    expect(provider.calls).toHaveLength(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('listener for "tool_call_end" threw'),
      'ctx.events observer failed',
    );
    error.mockRestore();
  });

  it('a throwing AxlStream tool listener cannot alter a successful tool outcome', async () => {
    const provider = MockProvider.sequence([
      {
        content: '',
        tool_calls: [
          {
            id: 'stream-listener-call',
            type: 'function',
            function: { name: 'stable_stream_tool', arguments: '{}' },
          },
        ],
      },
      { content: 'done' },
    ]);
    const runtime = buildRuntime(provider);
    const handler = vi.fn(() => ({ ok: true }));
    const stableTool = tool({
      name: 'stable_stream_tool',
      description: 'remain successful when a stream observer throws',
      input: z.object({}),
      handler,
    });
    const a = agent({ name: 'a', model: 'mock:test', system: 's', tools: [stableTool] });
    runtime.register(
      workflow({
        name: 'stream-listener-isolation',
        input: z.object({}),
        handler: (ctx) => ctx.ask(a, 'go'),
      }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stream = runtime.stream('stream-listener-isolation', {});
    stream.on('tool_call_end', () => {
      throw new Error('AxlStream observer failed');
    });

    await expect(stream.promise).resolves.toBe('done');

    expect(handler).toHaveBeenCalledOnce();
    expect(provider.calls).toHaveLength(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('listener for "tool_call_end" threw'),
      'AxlStream observer failed',
    );
    error.mockRestore();
  });

  it('a throwing runtime trace listener cannot alter a successful tool lifecycle', async () => {
    const provider = MockProvider.sequence([
      {
        content: '',
        tool_calls: [
          {
            id: 'runtime-listener-call',
            type: 'function',
            function: { name: 'stable_runtime_tool', arguments: '{}' },
          },
        ],
      },
      { content: 'done' },
    ]);
    const runtime = buildRuntime(provider);
    const handler = vi.fn(() => ({ ok: true }));
    const stableTool = tool({
      name: 'stable_runtime_tool',
      description: 'remain successful when a runtime observer throws',
      input: z.object({}),
      handler,
    });
    const a = agent({ name: 'a', model: 'mock:test', system: 's', tools: [stableTool] });
    const observed: AxlEvent[] = [];
    runtime.on('trace', (event) => observed.push(event));
    runtime.on('trace', (event) => {
      if (event.type === 'tool_call_start' || event.type === 'tool_call_end') {
        throw new Error(`synthetic ${event.type} listener failure`);
      }
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wf = workflow({
      name: 'runtime-trace-listener-isolation',
      input: z.object({}),
      handler: (ctx) => ctx.ask(a, 'go'),
    });
    runtime.register(wf);

    await expect(runtime.execute('runtime-trace-listener-isolation', {})).resolves.toBe('done');

    expect(handler).toHaveBeenCalledOnce();
    expect(provider.calls).toHaveLength(2);
    expect(observed.filter((event) => event.type === 'tool_call_start')).toHaveLength(1);
    expect(observed.filter((event) => event.type === 'tool_call_end')).toEqual([
      expect.objectContaining({
        callId: 'runtime-listener-call',
        data: { args: {}, outcome: { status: 'succeeded', result: { ok: true } } },
      }),
    ]);
    expect(errSpy).toHaveBeenCalledWith(
      '[axl] onTrace handler threw; trace event dropped:',
      'synthetic tool_call_start listener failure',
    );
    expect(errSpy).toHaveBeenCalledWith(
      '[axl] onTrace handler threw; trace event dropped:',
      'synthetic tool_call_end listener failure',
    );
    errSpy.mockRestore();
  });
});

describe('ctx.events — partialObjects from a streaming workflow', () => {
  it('streaming code path activates when ctx.events is observed (even on runtime.execute)', async () => {
    // Without this, the customer's runtime.execute() flow would never
    // emit token / partial_object events unless the event bus itself activates
    // streaming before the ask starts.
    const provider = MockProvider.sequence([{ content: '{"v":1}', chunks: ['{"v":', '1', '}'] }]);
    const runtime = buildRuntime(provider);
    const a = agent({ name: 'a', model: 'mock:test', system: 'a' });
    const types: string[] = [];
    const wf = workflow({
      name: 'streaming-via-events',
      input: z.object({}),
      handler: async (ctx) => {
        void (async () => {
          for await (const e of ctx.events) types.push(e.type);
        })();
        await ctx.ask(a, 'go', { schema: z.object({ v: z.number() }) });
        await new Promise((r) => setImmediate(r));
        return null;
      },
    });
    runtime.register(wf);
    await runtime.execute('streaming-via-events', {});
    await new Promise((r) => setImmediate(r));
    expect(types).toContain('token');
    expect(types).toContain('partial_object');
  });

  it('coalesces partial_object events emitted across two ctx.ask() calls (the customer use case)', async () => {
    // Two structured-output asks. Each emits multiple partial_object
    // events. partialObjects should yield latest-per-askId.
    const schemaJson = JSON.stringify({ chunks: ['{"v":', '1', '}'] });

    // MockProvider doesn't natively emit partial_object — that's done by
    // the agent's structured-output pipeline when `schema` is set on
    // ctx.ask. To exercise the coalescing path through the workflow,
    // use a minimal schema and rely on ctx.ask emitting partial_object
    // events as it processes the streamed content.
    const provider = MockProvider.sequence([
      { content: '{"v":1}', chunks: ['{"v":', '1', '}'] },
      { content: '{"v":2}', chunks: ['{"v":', '2', '}'] },
    ]);
    void schemaJson;

    const runtime = buildRuntime(provider);
    const a = agent({ name: 'a', model: 'mock:test', system: 'a' });

    const yielded: Array<{ askId: string; v: number }> = [];

    const wf = workflow({
      name: 'partials-across-asks',
      input: z.object({}),
      handler: async (ctx) => {
        void (async () => {
          for await (const p of ctx.events.partialObjects) {
            const obj = p.object as { v: number };
            yielded.push({ askId: p.askId, v: obj.v });
          }
        })();
        await ctx.ask(a, 'first', { schema: z.object({ v: z.number() }) });
        await ctx.ask(a, 'second', { schema: z.object({ v: z.number() }) });
        return null;
      },
    });
    runtime.register(wf);

    await runtime.execute('partials-across-asks', {});
    await new Promise((r) => setImmediate(r));

    // We should have at least one yield per ask. Each ask streams its own
    // partial_object sequence; coalescing collapses them to (at most) the
    // latest per askId. Two distinct askIds → exactly two distinct final
    // values (one per ask).
    const askIds = new Set(yielded.map((y) => y.askId));
    expect(askIds.size).toBe(2);
    // The latest value per askId must be the canonical final v=1 and v=2,
    // one per lane — both must appear (strengthened from the original
    // weak `||` assertion).
    const lastByAsk = new Map<string, number>();
    for (const y of yielded) lastByAsk.set(y.askId, y.v);
    const finalValues = new Set([...lastByAsk.values()]);
    expect(finalValues.has(1)).toBe(true);
    expect(finalValues.has(2)).toBe(true);
  });
});

describe('ctx.events — overflow propagation through emitEvent', () => {
  it('"throw" overflow policy fails the workflow with a propagating error', async () => {
    // Customer use case for the deferred Commit 2 review concern: pin
    // the documented behavior that `onOverflow: 'throw'` exits emitEvent,
    // unwinds the active ctx.* primitive, and rejects runtime.execute().
    //
    // To trigger the throw path we need the queue to fill up WITHOUT
    // anyone draining it. Subscribe to ctx.events but never iterate, so
    // events accumulate in the bus's queue. With maxQueued=1 the second
    // emit overflows.
    const provider = MockProvider.sequence([{ content: 'x' }]);
    const runtime = buildRuntime(provider);
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });

    const wf = workflow({
      name: 'overflow-throw',
      input: z.object({}),
      handler: async (ctx) => {
        // Allocate the bus by referencing it (no consumer).
        void ctx.events;
        // Emit a few events. Each ctx.ask emits multiple events; with
        // maxQueued=1 and onOverflow='throw' the first overflow throws.
        await ctx.ask(a, 'hi');
        return { ok: true };
      },
    });
    runtime.register(wf);

    await expect(
      runtime.execute('overflow-throw', {}, { events: { maxQueued: 1, onOverflow: 'throw' } }),
    ).rejects.toThrow(/maxQueued=1/);
  });

  it('"drop-oldest-non-terminal" (default) does NOT fail the workflow under saturation', async () => {
    const provider = MockProvider.sequence([{ content: 'x' }]);
    const runtime = buildRuntime(provider);
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });

    // Suppress the one-shot warn so it doesn't pollute the test output.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const wf = workflow({
      name: 'overflow-drop',
      input: z.object({}),
      handler: async (ctx) => {
        void ctx.events;
        await ctx.ask(a, 'hi');
        return { ok: true };
      },
    });
    runtime.register(wf);

    // Default policy + tiny cap → should drop, not throw.
    const result = await runtime.execute('overflow-drop', {}, { events: { maxQueued: 1 } });
    expect(result).toEqual({ ok: true });
    warnSpy.mockRestore();
  });
});

// ─── Test BLOCKING #3: instanceof EventStreamOverflowError ───
// Pre-fix the ctx-events overflow test only checked the error message
// matched a regex. The whole point of the typed class is so consumers
// can `instanceof`-discriminate; pin that.

describe('ctx.events — EventStreamOverflowError type preservation', () => {
  it('runtime.execute rejects with an instanceof EventStreamOverflowError (not just matching message)', async () => {
    const provider = MockProvider.sequence([{ content: 'hello' }]);
    const runtime = buildRuntime(provider);
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });

    const wf = workflow({
      name: 'overflow-instanceof',
      input: z.object({}),
      handler: async (ctx) => {
        void ctx.events;
        await ctx.ask(a, 'hi');
        return { ok: true };
      },
    });
    runtime.register(wf);

    const result = runtime
      .execute('overflow-instanceof', {}, { events: { maxQueued: 1, onOverflow: 'throw' } })
      .then(
        () => ({ ok: true as const }),
        (err: unknown) => ({ ok: false as const, err }),
      );
    const settled = await result;
    expect(settled.ok).toBe(false);
    if (!settled.ok) {
      expect(settled.err).toBeInstanceOf(EventStreamOverflowError);
      expect((settled.err as EventStreamOverflowError).maxQueued).toBe(1);
      expect((settled.err as EventStreamOverflowError).eventType).toMatch(/\w+/);
    }
  });
});

// ─── Test BLOCKING #2: late ctx.events subscription ───
// Documented behavior: "subscribe before the first ctx.ask()" — late
// allocation means the in-flight ask doesn't stream tokens, but
// subsequent asks DO. This pin catches a regression in the streaming
// gate (`_streamingEnabled`).

describe('ctx.events — streaming-gate behavior on late subscription', () => {
  it('subscribing AFTER first ask started: no tokens for ask #1, but tokens for ask #2', async () => {
    const provider = MockProvider.sequence([
      { content: 'hello', chunks: ['h', 'e', 'l', 'lo'] },
      { content: 'world', chunks: ['w', 'o', 'r', 'ld'] },
    ]);
    const runtime = buildRuntime(provider);
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });

    const tokenAskIds: string[] = [];
    const wf = workflow({
      name: 'late-subscribe',
      input: z.object({}),
      handler: async (ctx) => {
        // First ask STARTS without ctx.events allocated. The
        // streaming gate is closed for this one — provider.chat path
        // is taken, no token events fire.
        await ctx.ask(a, 'first');

        // Allocate ctx.events AFTER ask #1 has fully completed.
        // From now on, the streaming gate is open and ask #2 streams.
        void (async () => {
          for await (const e of ctx.events) {
            if (e.type === 'token') {
              tokenAskIds.push((e as { askId: string }).askId);
            }
          }
        })().catch(() => {});

        await ctx.ask(a, 'second');
        return { ok: true };
      },
    });
    runtime.register(wf);
    await runtime.execute('late-subscribe', {});

    // We expect tokens from ask #2 only — they all share one askId.
    // Ask #1 had no observer at start, so the streaming code path was
    // skipped entirely. Without `_streamingEnabled` (or via the
    // pre-fix gate `onToken || _busRef.current` reading the slot
    // correctly), this would either fire 0 tokens (everything skipped
    // streaming) or 8 tokens (both asks streamed). The pin here is
    // exactly: "between 1 and 4 tokens, all from a single askId".
    expect(tokenAskIds.length).toBeGreaterThan(0);
    expect(tokenAskIds.length).toBeLessThanOrEqual(4);
    const uniqueAskIds = new Set(tokenAskIds);
    expect(uniqueAskIds.size).toBe(1);
  });
});

// ─── AbortSignal listener cleanup (regression for commit bf17409) ───
// The pre-fix `forwardAbortSignal` and constructor abort listener used
// `{ once: true }`, which only auto-removes on abort. The success path
// left listeners attached. With a long-lived signal reused across
// many `runtime.execute()` calls, this caused MaxListenersExceededWarning
// after ~10 calls and a real memory leak under sustained load.

describe('runtime — AbortSignal listener cleanup on long-lived signals', () => {
  it('forwardAbortSignal removes its listener after successful runtime.execute completion', async () => {
    const runtime = buildRuntime(MockProvider.echo());
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });
    const wf = workflow({
      name: 'forwarder-cleanup',
      input: z.object({}),
      handler: async (ctx) => {
        await ctx.ask(a, 'hi');
        return { ok: true };
      },
    });
    runtime.register(wf);

    const userController = new AbortController();
    // Run 30 executions on the SAME signal. Pre-fix this would
    // accumulate 30 listeners; post-fix each cleanup runs in the
    // workflow's `finally`, so after each completes we're back to 0.
    for (let i = 0; i < 30; i++) {
      await runtime.execute('forwarder-cleanup', {}, { signal: userController.signal });
    }
    expect(getEventListeners(userController.signal, 'abort').length).toBe(0);
  });

  it('forwardAbortSignal removes its listener after early-throw in runtime.stream', async () => {
    const runtime = buildRuntime(MockProvider.echo());
    // Don't register the workflow → "not registered" pre-execInfo throw.
    const userController = new AbortController();

    for (let i = 0; i < 10; i++) {
      const stream = runtime.stream('does-not-exist', {}, { signal: userController.signal });
      await stream.promise.catch(() => {});
    }
    expect(getEventListeners(userController.signal, 'abort').length).toBe(0);
  });

  it('forwardAbortSignal removes its listener after streaming workflow completion', async () => {
    const runtime = buildRuntime(MockProvider.echo());
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });
    const wf = workflow({
      name: 'stream-forwarder-cleanup',
      input: z.object({}),
      handler: async (ctx) => {
        await ctx.ask(a, 'hi');
        return { ok: true };
      },
    });
    runtime.register(wf);

    const userController = new AbortController();
    for (let i = 0; i < 10; i++) {
      const stream = runtime.stream(
        'stream-forwarder-cleanup',
        {},
        { signal: userController.signal },
      );
      await stream.promise;
    }
    expect(getEventListeners(userController.signal, 'abort').length).toBe(0);
  });

  it('WorkflowContext constructor abort listener is removed after workflow_end', async () => {
    // The constructor registers an abort listener on `this.signal` so
    // an aborted signal disposes the bus. On the success path
    // (workflow_end), `emitEvent`'s terminal block calls
    // `abortListenerCleanup()`. Pin: 30 executions, 0 leftover
    // listeners.
    const runtime = buildRuntime(MockProvider.echo());
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });
    const wf = workflow({
      name: 'ctx-listener-cleanup',
      input: z.object({}),
      handler: async (ctx) => {
        // Allocate ctx.events so the constructor listener is wired.
        void ctx.events;
        await ctx.ask(a, 'hi');
        return { ok: true };
      },
    });
    runtime.register(wf);

    const userController = new AbortController();
    for (let i = 0; i < 30; i++) {
      await runtime.execute('ctx-listener-cleanup', {}, { signal: userController.signal });
    }
    // Pre-fix: at least 30 listeners (one from forwarder + one from
    // ctx constructor per execution). Post-fix: 0.
    expect(getEventListeners(userController.signal, 'abort').length).toBe(0);
  });
});
