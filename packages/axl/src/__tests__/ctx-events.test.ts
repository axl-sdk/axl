import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AxlRuntime } from '../runtime.js';
import { workflow } from '../workflow.js';
import { agent } from '../agent.js';
import { tool } from '../tool.js';
import { MockProvider } from '../../../axl-testing/src/mock-provider.js';
import type { AxlEvent } from '../types.js';

/** Build a runtime with a single mock provider already registered. */
function buildRuntime(provider: MockProvider): AxlRuntime {
  const runtime = new AxlRuntime({ defaultProvider: 'mock' });
  runtime.registerProvider('mock', provider);
  return runtime;
}

describe('ctx.events — workflow handler observation', () => {
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

describe('ctx.events — error isolation between onTrace and bus', () => {
  it('a throwing onTrace handler does not block the ctx.events bus from receiving events', async () => {
    // The runtime wires its own onTrace into WorkflowContext (for cost
    // accumulation, broadcast, etc.). If a third-party trace listener
    // throws, ctx.events must still receive the event — the try/catch
    // around `onTrace` runs BEFORE the bus push.
    const provider = MockProvider.sequence([{ content: 'hi' }]);
    const runtime = buildRuntime(provider);
    const a = agent({ name: 'a', model: 'mock:test', system: 's' });

    // Subscribe a throwing trace listener at the runtime level.
    runtime.on('trace', () => {
      throw new Error('synthetic onTrace failure');
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const types: string[] = [];
    const wf = workflow({
      name: 'onTrace-throws',
      input: z.object({}),
      handler: async (ctx) => {
        void (async () => {
          for await (const e of ctx.events) types.push(e.type);
        })();
        await ctx.ask(a, 'go');
        return null;
      },
    });
    runtime.register(wf);

    // Workflow must complete despite the throwing onTrace.
    await runtime.execute('onTrace-throws', {});
    await new Promise((r) => setImmediate(r));

    // ctx.events received the events — the bus push is independent of
    // the trace listener failure.
    expect(types.length).toBeGreaterThan(0);
    expect(types).toContain('agent_call_end');
    // Trace listener errors are logged via console.error (the documented
    // isolation behavior). Note: runtime.on('trace', ...) is NOT wrapped
    // by the same try/catch as `init.onTrace` — the Node EventEmitter
    // behavior may surface this differently. The point of this test is
    // the BUS still sees events; whether the throw is logged is a
    // separate listener-isolation concern.
    errSpy.mockRestore();
  });
});

describe('ctx.events — partialObjects from a streaming workflow', () => {
  it('streaming code path activates when ctx.events is observed (even on runtime.execute)', async () => {
    // Without this, the customer's runtime.execute() flow would never
    // emit token / partial_object events because streaming is gated on
    // `onToken`. The fix in context.ts also enables streaming when
    // `_busRef.current` is set.
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
