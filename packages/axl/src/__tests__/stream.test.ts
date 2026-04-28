import { describe, it, expect } from 'vitest';
import { AxlStream } from '../stream.js';
import { AXL_EVENT_TYPES, type AxlEvent, type AxlEventType } from '../types.js';

/** Build a synthetic AxlEvent with the required base fields (executionId,
 *  step, timestamp). Test fixtures pass variant-specific fields via the
 *  loose `Record<string, unknown>` shape; the cast at the bottom is the
 *  runtime contract — `_push` is what we're actually testing. */
let _step = 0;
function ev(partial: Record<string, unknown>): AxlEvent {
  return {
    executionId: 'test-exec',
    step: _step++,
    timestamp: Date.now(),
    ...partial,
  } as unknown as AxlEvent;
}

const ASK = { askId: 'test-ask', depth: 0 } as const;

describe('AxlStream', () => {
  it('pushing events makes them available via async iterator', async () => {
    const stream = new AxlStream();

    stream._push(ev({ type: 'token', data: 'hello', ...ASK }));
    stream._push(ev({ type: 'token', data: ' world', ...ASK }));
    stream._done('hello world', 'test-exec');

    const events: AxlEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('token');
    expect((events[0] as { data: string }).data).toBe('hello');
    expect(events[1].type).toBe('token');
    expect((events[1] as { data: string }).data).toBe(' world');
    expect(events[2].type).toBe('done');
    expect((events[2] as { data: { result: unknown } }).data).toEqual({ result: 'hello world' });
  });

  it('text getter filters only token events', async () => {
    const stream = new AxlStream();

    stream._push(ev({ type: 'token', data: 'Hi', ...ASK }));
    stream._push(ev({ type: 'log', data: {} }));
    stream._push(ev({ type: 'token', data: ' there', ...ASK }));
    stream._done('result', 'test-exec');

    const tokens: string[] = [];
    for await (const text of stream.text) {
      tokens.push(text);
    }

    expect(tokens).toEqual(['Hi', ' there']);
  });

  it('fullText joins all root-only tokens', () => {
    const stream = new AxlStream();

    stream._push(ev({ type: 'token', data: 'Hello', ...ASK }));
    stream._push(ev({ type: 'token', data: ', ', ...ASK }));
    stream._push(ev({ type: 'token', data: 'World!', ...ASK }));
    stream._done('result', 'test-exec');

    expect(stream.fullText).toBe('Hello, World!');
  });

  it('fullText excludes nested-ask tokens (consumers filter via depth)', () => {
    const stream = new AxlStream();

    stream._push(ev({ type: 'token', data: 'root', askId: 'a', depth: 0 }));
    stream._push(ev({ type: 'token', data: '-NESTED-', askId: 'b', depth: 1 }));
    stream._push(ev({ type: 'token', data: 'final', askId: 'a', depth: 0 }));
    stream._done('r', 'test-exec');

    expect(stream.fullText).toBe('rootfinal');
  });

  it('fullText is empty when no tokens pushed', () => {
    const stream = new AxlStream();
    stream._done('result', 'test-exec');
    expect(stream.fullText).toBe('');
  });

  it('_done signals completion with discriminated `done` AxlEvent', async () => {
    const stream = new AxlStream();

    stream._push(ev({ type: 'token', data: 'data', ...ASK }));
    stream._done({ result: 'final' }, 'test-exec');

    const events: AxlEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect((doneEvent as { data: { result: unknown } }).data).toEqual({
      result: { result: 'final' },
    });
  });

  it('_error signals error through iterator', async () => {
    const stream = new AxlStream();
    const error = new Error('something broke');

    stream.promise.catch(() => {});
    stream._error(error, 'test-exec');

    const iter = stream[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value.type).toBe('error');
    expect((first.value as { data: { message: string } }).data.message).toBe('something broke');

    const second = await iter.next();
    expect(second.done).toBe(true);
  });

  it('promise resolves on done', async () => {
    const stream = new AxlStream();

    queueMicrotask(() => {
      stream._push(ev({ type: 'token', data: 'abc', ...ASK }));
      stream._done('final-value', 'test-exec');
    });

    const result = await stream.promise;
    expect(result).toBe('final-value');
  });

  it('promise rejects on error', async () => {
    const stream = new AxlStream();

    queueMicrotask(() => {
      stream._error(new Error('stream failed'), 'test-exec');
    });

    await expect(stream.promise).rejects.toThrow('stream failed');
  });

  it('ignores events after _done is called', () => {
    const stream = new AxlStream();

    stream._push(ev({ type: 'token', data: 'before', ...ASK }));
    stream._done('done', 'test-exec');
    stream._push(ev({ type: 'token', data: 'after', ...ASK }));

    expect(stream.fullText).toBe('before');
  });

  it('ignores events after _error is called', () => {
    const stream = new AxlStream();

    stream.promise.catch(() => {});
    stream._push(ev({ type: 'token', data: 'before', ...ASK }));
    stream._error(new Error('err'), 'test-exec');
    stream._push(ev({ type: 'token', data: 'after', ...ASK }));

    expect(stream.fullText).toBe('before');
  });

  it('[Symbol.asyncDispose]() properly cleans up a stream mid-iteration', async () => {
    const stream = new AxlStream();

    stream._push(ev({ type: 'token', data: 'first', ...ASK }));
    stream._push(ev({ type: 'token', data: 'second', ...ASK }));

    const iter = stream[Symbol.asyncIterator]();

    const first = await iter.next();
    expect(first.done).toBe(false);
    expect((first.value as { data: string }).data).toBe('first');

    await iter[Symbol.asyncDispose]();

    stream._push(ev({ type: 'token', data: 'third', ...ASK }));
    stream._done('done', 'test-exec');

    expect(stream.fullText).toBe('firstsecondthird');
  });

  it('[Symbol.asyncDispose] calls destroy() on underlying Readable', async () => {
    const stream = new AxlStream();
    stream._push(ev({ type: 'token', data: 'first', ...ASK }));

    const iter = stream[Symbol.asyncIterator]();
    await iter.next();

    let destroyCalled = false;
    const origDestroy = stream.destroy.bind(stream);
    stream.destroy = ((...args: unknown[]) => {
      destroyCalled = true;
      return (origDestroy as (...a: unknown[]) => unknown)(...args);
    }) as typeof stream.destroy;

    await iter[Symbol.asyncDispose]();
    expect(destroyCalled).toBe(true);
  });

  it('_error() propagates the exact error object through .promise', async () => {
    const stream = new AxlStream();
    const specificError = new Error('specific test error');

    queueMicrotask(() => {
      stream._error(specificError, 'test-exec');
    });

    try {
      await stream.promise;
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBe(specificError);
    }
  });

  it('carries the new AxlEvent shape (agent_call_start/end, tool_call_start/end, handoff_start)', async () => {
    const stream = new AxlStream();

    stream._push(
      ev({ type: 'agent_call_start', agent: 'a', model: 'openai:gpt-4o', turn: 1, ...ASK }),
    );
    stream._push(
      ev({
        type: 'tool_call_start',
        tool: 'calc',
        callId: 'c1',
        data: { args: { x: 1 } },
        ...ASK,
      }),
    );
    stream._push(
      ev({
        type: 'tool_call_end',
        tool: 'calc',
        callId: 'c1',
        duration: 5,
        data: { args: { x: 1 }, result: { answer: 42 } },
        ...ASK,
      }),
    );
    stream._push(
      ev({
        type: 'handoff_start',
        fromAskId: 'a1',
        toAskId: 'a2',
        sourceDepth: 0,
        targetDepth: 0,
        data: { source: 'triage', target: 'specialist', mode: 'oneway' },
      }),
    );
    stream._push(
      ev({
        type: 'agent_call_end',
        agent: 'a',
        model: 'openai:gpt-4o',
        cost: 0.01,
        duration: 500,
        data: { prompt: 'p', response: 'r' },
        ...ASK,
      }),
    );
    stream._done('final', 'test-exec');

    const events: AxlEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(6); // 5 events + done
    expect(events.map((e) => e.type)).toEqual([
      'agent_call_start',
      'tool_call_start',
      'tool_call_end',
      'handoff_start',
      'agent_call_end',
      'done',
    ]);
  });

  it('.lifecycle getter filters to structural events only', async () => {
    const stream = new AxlStream();

    stream._push(ev({ type: 'token', data: 'hi', ...ASK }));
    stream._push(ev({ type: 'agent_call_start', agent: 'a', model: 'm', turn: 1, ...ASK }));
    stream._push(ev({ type: 'token', data: ' there', ...ASK }));
    stream._push(
      ev({ type: 'tool_call_start', tool: 'calc', callId: 'c1', data: { args: {} }, ...ASK }),
    );
    stream._push(ev({ type: 'log', data: {} }));
    stream._push(
      ev({
        type: 'tool_call_end',
        tool: 'calc',
        callId: 'c1',
        duration: 1,
        data: { args: {}, result: 42 },
        ...ASK,
      }),
    );
    stream._push(
      ev({
        type: 'handoff_start',
        fromAskId: 'a1',
        toAskId: 'a2',
        sourceDepth: 0,
        targetDepth: 0,
        data: { source: 'a', target: 'b', mode: 'oneway' },
      }),
    );
    stream._push(
      ev({
        type: 'agent_call_end',
        agent: 'a',
        model: 'm',
        cost: 0,
        duration: 1,
        data: { prompt: 'p', response: 'r' },
        ...ASK,
      }),
    );
    stream._done('result', 'test-exec');

    const lifecycle: AxlEvent[] = [];
    for await (const event of stream.lifecycle) {
      lifecycle.push(event);
    }

    // Should include: agent_call_start, tool_call_start, tool_call_end, handoff_start, agent_call_end
    // Should exclude: token, log, done, error
    expect(lifecycle.map((s) => s.type)).toEqual([
      'agent_call_start',
      'tool_call_start',
      'tool_call_end',
      'handoff_start',
      'agent_call_end',
    ]);
  });

  it('.on() works for new event types', async () => {
    const stream = new AxlStream();
    const received: AxlEvent[] = [];

    stream.on('agent_call_start', (event: unknown) => received.push(event as AxlEvent));
    stream.on('handoff_start', (event: unknown) => received.push(event as AxlEvent));
    stream.on('handoff_return', (event: unknown) => received.push(event as AxlEvent));

    stream._push(ev({ type: 'agent_call_start', agent: 'a', model: 'm', turn: 1, ...ASK }));
    stream._push(
      ev({
        type: 'handoff_start',
        fromAskId: 'a1',
        toAskId: 'a2',
        sourceDepth: 0,
        targetDepth: 0,
        data: { source: 'a', target: 'b', mode: 'roundtrip' },
      }),
    );
    stream._push(
      ev({
        type: 'handoff_return',
        fromAskId: 'a1',
        toAskId: 'a2',
        sourceDepth: 0,
        targetDepth: 0,
        data: { source: 'a', target: 'b', duration: 1 },
      }),
    );
    stream._done('done', 'test-exec');

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(3);
    expect(received[0].type).toBe('agent_call_start');
    expect(received[1].type).toBe('handoff_start');
    expect(received[2].type).toBe('handoff_return');
  });

  it('tool_approval event appears in stream.lifecycle but not stream.text', async () => {
    const stream = new AxlStream();

    stream._push(ev({ type: 'token', data: 'hello', ...ASK }));
    stream._push(
      ev({
        type: 'tool_approval',
        tool: 'risky_tool',
        callId: 'c1',
        data: { approved: false, args: { x: 1 }, reason: 'Too dangerous' },
        ...ASK,
      }),
    );
    stream._push(ev({ type: 'token', data: ' world', ...ASK }));
    stream._done('result', 'test-exec');

    const lifecycle: AxlEvent[] = [];
    for await (const event of stream.lifecycle) {
      lifecycle.push(event);
    }
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0].type).toBe('tool_approval');
    const approval = lifecycle[0] as Extract<AxlEvent, { type: 'tool_approval' }>;
    expect(approval.tool).toBe('risky_tool');
    expect(approval.data.approved).toBe(false);
    expect(approval.data.reason).toBe('Too dangerous');
  });

  it('stream.on("tool_approval", handler) fires', async () => {
    const stream = new AxlStream();
    const received: AxlEvent[] = [];

    stream.on('tool_approval', (event: unknown) => received.push(event as AxlEvent));

    stream._push(
      ev({
        type: 'tool_approval',
        tool: 'deploy',
        callId: 'c1',
        data: { approved: true, args: { env: 'prod' } },
        ...ASK,
      }),
    );
    stream._done('done', 'test-exec');

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    const e = received[0] as Extract<AxlEvent, { type: 'tool_approval' }>;
    expect(e.type).toBe('tool_approval');
    expect(e.tool).toBe('deploy');
    expect(e.data.approved).toBe(true);
  });

  it('handoff_start event with mode field preserved through iterator', async () => {
    const stream = new AxlStream();

    stream._push(
      ev({
        type: 'handoff_start',
        fromAskId: 'a1',
        toAskId: 'a2',
        sourceDepth: 0,
        targetDepth: 0,
        data: { source: 'coordinator', target: 'specialist', mode: 'roundtrip' },
      }),
    );
    stream._done('result', 'test-exec');

    const events: AxlEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const handoff = events.find((e) => e.type === 'handoff_start') as
      | Extract<AxlEvent, { type: 'handoff_start' }>
      | undefined;
    expect(handoff).toBeDefined();
    expect(handoff!.data.source).toBe('coordinator');
    expect(handoff!.data.target).toBe('specialist');
    expect(handoff!.data.mode).toBe('roundtrip');
  });

  it('handles waiting iterators that consume events as they arrive', async () => {
    const stream = new AxlStream();

    const collectPromise = (async () => {
      const events: AxlEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }
      return events;
    })();

    await new Promise((r) => setTimeout(r, 10));
    stream._push(ev({ type: 'token', data: 'delayed', ...ASK }));
    stream._done('fin', 'test-exec');

    const events = await collectPromise;
    expect(events).toHaveLength(2);
    expect((events[0] as { data: string }).data).toBe('delayed');
    expect((events[1] as { data: { result: unknown } }).data).toEqual({ result: 'fin' });
  });

  // ── Block A: .textByAsk ─────────────────────────────────────────────────
  //
  // `.text` filters to root tokens only (the "chat bubble" view). `.textByAsk`
  // is the sibling iterator that covers every ask lane (root + nested) and
  // tags each chunk with the ask frame that produced it. Before this block
  // the getter had zero direct coverage — asserted only transitively via
  // `fullText` tests, which is not the same contract.

  describe('.textByAsk', () => {
    it('yields { askId, agent, text } for every token across root and nested asks', async () => {
      const stream = new AxlStream();

      stream._push(ev({ type: 'token', data: 'r1', askId: 'root', agent: 'outer', depth: 0 }));
      stream._push(ev({ type: 'token', data: 'n1', askId: 'child', agent: 'inner', depth: 1 }));
      stream._push(ev({ type: 'token', data: 'r2', askId: 'root', agent: 'outer', depth: 0 }));
      stream._done('result', 'test-exec');

      const chunks: Array<{ askId: string; agent?: string; text: string }> = [];
      for await (const chunk of stream.textByAsk) chunks.push(chunk);

      expect(chunks).toEqual([
        { askId: 'root', agent: 'outer', text: 'r1' },
        { askId: 'child', agent: 'inner', text: 'n1' },
        { askId: 'root', agent: 'outer', text: 'r2' },
      ]);
    });

    it('carries `agent` through when set on the emitting event', async () => {
      const stream = new AxlStream();

      stream._push(ev({ type: 'token', data: 'hi', askId: 'a', agent: 'claude-3', depth: 0 }));
      stream._done('r', 'test-exec');

      const chunks: Array<{ askId: string; agent?: string; text: string }> = [];
      for await (const chunk of stream.textByAsk) chunks.push(chunk);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].agent).toBe('claude-3');
    });

    it('omits `agent` when the event was emitted outside any ask (rare — synthesized fixtures)', async () => {
      // Per the getter's doc: the `agent` field is undefined when the token
      // was produced without an emitting-agent context. Pin that tri-state
      // so consumers don't assume a string.
      const stream = new AxlStream();

      stream._push(ev({ type: 'token', data: 'orphan', askId: 'a', depth: 0 }));
      stream._done('r', 'test-exec');

      const chunks: Array<{ askId: string; agent?: string; text: string }> = [];
      for await (const chunk of stream.textByAsk) chunks.push(chunk);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].askId).toBe('a');
      expect(chunks[0].text).toBe('orphan');
      expect(chunks[0].agent).toBeUndefined();
    });

    it('groups chunks by askId across an outer + nested ask (agent-as-tool pattern)', async () => {
      // Run a real workflow with an outer ctx.ask using an agent-as-tool
      // pattern (the tool handler invokes a sub-agent via ctx.ask). The
      // outer's tokens carry one askId and the nested's tokens carry a
      // DIFFERENT askId. Both agents are reflected in the per-chunk
      // `agent` field.
      const { AxlRuntime } = await import('../runtime.js');
      const { workflow } = await import('../workflow.js');
      const { agent } = await import('../agent.js');
      const { tool } = await import('../tool.js');
      const { z } = await import('zod');
      const { MockProvider } = await import('../../../axl-testing/src/mock-provider.js');

      const subAgent = agent({
        name: 'sub_specialist',
        model: 'mock:test',
        system: 'sub',
      });
      const askTool = tool({
        name: 'ask_sub',
        description: 'ask the sub specialist',
        input: z.object({ q: z.string() }),
        handler: async (input, ctx) => ctx.ask(subAgent, input.q),
      });
      const outerAgent = agent({
        name: 'outer_coordinator',
        model: 'mock:test',
        system: 'outer',
        tools: [askTool],
      });

      // Provider sequence:
      // Turn 1 (outer): tool_call to ask_sub
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
        { content: 'INNER', chunks: ['IN', 'NER'] },
        { content: 'OUTER', chunks: ['OU', 'TER'] },
      ]);
      const runtime = new AxlRuntime({ defaultProvider: 'mock' });
      runtime.registerProvider('mock', provider);

      const wf = workflow({
        name: 'nested-ask-stream',
        input: z.object({}),
        handler: async (ctx) => ctx.ask(outerAgent, 'start'),
      });
      runtime.register(wf);

      const stream = runtime.stream('nested-ask-stream', {});
      const chunks: Array<{ askId: string; agent?: string; text: string }> = [];
      // Drain via textByAsk only — it pulls from the same internal queue
      // as the main iterator, terminates on `done`, and yields one chunk
      // per token event. Iterating BOTH `stream` and `stream.textByAsk`
      // races: the first `for await` to enter pulls events out, leaving
      // the second iterator empty of early events.
      for await (const chunk of stream.textByAsk) {
        chunks.push(chunk);
      }
      // Ensure the underlying promise settled (textByAsk completes when
      // the stream's `done` event fires).
      await stream.promise.catch(() => {});

      // We must have chunks from BOTH the outer and the inner ask.
      const outerChunks = chunks.filter((c) => c.agent === 'outer_coordinator');
      const innerChunks = chunks.filter((c) => c.agent === 'sub_specialist');
      expect(outerChunks.length).toBeGreaterThan(0);
      expect(innerChunks.length).toBeGreaterThan(0);

      // The outer's askId differs from the nested's askId — the iterator
      // groups by askId, NOT by agent name, but we use agent as a proxy
      // to identify the lane.
      const outerAskIds = new Set(outerChunks.map((c) => c.askId));
      const innerAskIds = new Set(innerChunks.map((c) => c.askId));
      expect(outerAskIds.size).toBe(1);
      expect(innerAskIds.size).toBe(1);
      const [outerAskId] = outerAskIds;
      const [innerAskId] = innerAskIds;
      expect(outerAskId).not.toBe(innerAskId);

      // Joined text per lane reconstructs the model's response per agent.
      expect(outerChunks.map((c) => c.text).join('')).toBe('OUTER');
      expect(innerChunks.map((c) => c.text).join('')).toBe('INNER');
    });

    it('filters out non-token events', async () => {
      const stream = new AxlStream();

      stream._push(ev({ type: 'token', data: 'hi', askId: 'a', agent: 'o', depth: 0 }));
      stream._push(ev({ type: 'log', data: { event: 'noise' } }));
      stream._push(
        ev({ type: 'agent_call_start', agent: 'o', model: 'm', turn: 1, askId: 'a', depth: 0 }),
      );
      stream._push(ev({ type: 'token', data: ' there', askId: 'a', agent: 'o', depth: 0 }));
      stream._push(
        ev({
          type: 'agent_call_end',
          agent: 'o',
          model: 'm',
          cost: 0,
          duration: 1,
          data: { prompt: 'p', response: 'r' },
          askId: 'a',
          depth: 0,
        }),
      );
      stream._done('r', 'test-exec');

      const chunks: Array<{ askId: string; agent?: string; text: string }> = [];
      for await (const chunk of stream.textByAsk) chunks.push(chunk);

      expect(chunks.map((c) => c.text)).toEqual(['hi', ' there']);
    });
  });

  // ── Block B: Lifecycle exhaustiveness guard ─────────────────────────────
  //
  // `stream.ts` hard-codes the set of types that `.lifecycle` yields. If a
  // future PR adds a new variant to `AXL_EVENT_TYPES` (the canonical tuple),
  // the lifecycle set can silently drift out of sync — a consumer relying on
  // `.lifecycle` would never see the new event, with no compile error.
  //
  // This block pins the partition: every `AxlEventType` must be either
  // "lifecycle" (yielded by `.lifecycle`) or explicitly "excluded" (in the
  // allowlist below). Adding a new variant forces a conscious choice.

  describe('lifecycle iterator exhaustiveness (AXL_EVENT_TYPES partition)', () => {
    /**
     * Compile-time exhaustiveness: this record must list every `AxlEventType`.
     * If a new discriminator is added, TS will complain that the record is
     * missing a key, forcing the author to categorize it.
     *
     * 'lifecycle' → surfaces via `stream.lifecycle` (structural, "what
     *   happened" timeline event).
     * 'excluded'  → deliberately skipped by `.lifecycle`. Rationales:
     *     - token / partial_object: high-volume content chunks; consumers
     *       who want them iterate the raw stream.
     *     - log: caller-emitted observability events (ctx.log), not
     *       part of the structural timeline.
     *     - memory_*: observability/audit rows with a dedicated subscription
     *       pattern; not structural.
     *     - guardrail / schema_check / validate: legacy gate events
     *       collapsed into `pipeline` in PR 2; kept for back-compat but
     *       not part of the canonical lifecycle.
     *     - done / error: terminal markers synthesized by AxlStream itself,
     *       already surface via `.on('done' | 'error', ...)` and the stream's
     *       `.promise`; re-delivering them through `.lifecycle` would
     *       duplicate the terminal signal.
     */
    const categorization: Record<AxlEventType, 'lifecycle' | 'excluded'> = {
      workflow_start: 'lifecycle',
      workflow_end: 'lifecycle',
      ask_start: 'lifecycle',
      ask_end: 'lifecycle',
      agent_call_start: 'lifecycle',
      agent_call_end: 'lifecycle',
      tool_call_start: 'lifecycle',
      tool_call_end: 'lifecycle',
      tool_approval: 'lifecycle',
      tool_denied: 'lifecycle',
      delegate: 'lifecycle',
      handoff_start: 'lifecycle',
      handoff_return: 'lifecycle',
      pipeline: 'lifecycle',
      verify: 'lifecycle',
      // Durable-execution checkpoints — structural points in the timeline.
      checkpoint_save: 'lifecycle',
      checkpoint_replay: 'lifecycle',
      // Human-in-the-loop — pause/resume are major timeline landmarks.
      await_human: 'lifecycle',
      await_human_resolved: 'lifecycle',
      token: 'excluded',
      partial_object: 'excluded',
      log: 'excluded',
      memory_remember: 'excluded',
      memory_recall: 'excluded',
      memory_forget: 'excluded',
      guardrail: 'excluded',
      schema_check: 'excluded',
      validate: 'excluded',
      done: 'excluded',
      error: 'excluded',
    };

    it('every AXL_EVENT_TYPES entry is categorized as lifecycle or excluded (compile-time)', () => {
      // The type of `categorization` requires every key from `AxlEventType`.
      // This runtime assertion catches a mismatch between the tuple and the
      // keys — e.g., someone adds to the record but forgets the tuple.
      const keys = new Set(Object.keys(categorization));
      for (const t of AXL_EVENT_TYPES) {
        expect(keys.has(t)).toBe(true);
      }
      expect(keys.size).toBe(AXL_EVENT_TYPES.length);
    });

    it('.lifecycle yields exactly the types marked lifecycle and none marked excluded', async () => {
      const stream = new AxlStream();
      const ASK_ = { askId: 'a', depth: 0 } as const;

      // Push a minimal synthetic event for every type in AXL_EVENT_TYPES.
      // The per-variant shapes only need to satisfy `_push` (which doesn't
      // validate); the test's concern is purely which `type` values make
      // it through the `.lifecycle` filter.
      const minimalByType: Record<AxlEventType, Record<string, unknown>> = {
        workflow_start: { type: 'workflow_start', workflow: 'w', data: { input: {} } },
        workflow_end: {
          type: 'workflow_end',
          workflow: 'w',
          data: { status: 'completed', duration: 1 },
        },
        ask_start: { type: 'ask_start', prompt: 'p', ...ASK_ },
        ask_end: {
          type: 'ask_end',
          outcome: { ok: true, result: 'x' },
          cost: 0,
          duration: 1,
          ...ASK_,
        },
        agent_call_start: { type: 'agent_call_start', agent: 'a', model: 'm', turn: 1, ...ASK_ },
        agent_call_end: {
          type: 'agent_call_end',
          agent: 'a',
          model: 'm',
          cost: 0,
          duration: 1,
          data: { prompt: 'p', response: 'r' },
          ...ASK_,
        },
        token: { type: 'token', data: 'tok', ...ASK_ },
        tool_call_start: {
          type: 'tool_call_start',
          tool: 't',
          callId: 'c1',
          data: { args: {} },
          ...ASK_,
        },
        tool_call_end: {
          type: 'tool_call_end',
          tool: 't',
          callId: 'c1',
          duration: 1,
          data: { args: {}, result: 'r' },
          ...ASK_,
        },
        tool_approval: {
          type: 'tool_approval',
          tool: 't',
          data: { approved: true, args: {} },
          ...ASK_,
        },
        tool_denied: { type: 'tool_denied', tool: 't', ...ASK_ },
        delegate: {
          type: 'delegate',
          data: { candidates: ['a'], reason: 'single_candidate' },
          ...ASK_,
        },
        handoff_start: {
          type: 'handoff_start',
          fromAskId: 'a1',
          toAskId: 'a2',
          sourceDepth: 0,
          targetDepth: 0,
          data: { source: 'a', target: 'b', mode: 'oneway' },
        },
        handoff_return: {
          type: 'handoff_return',
          fromAskId: 'a1',
          toAskId: 'a2',
          sourceDepth: 0,
          targetDepth: 0,
          data: { source: 'a', target: 'b', duration: 1 },
        },
        pipeline: {
          type: 'pipeline',
          status: 'start',
          stage: 'initial',
          attempt: 1,
          maxAttempts: 1,
          ...ASK_,
        },
        partial_object: { type: 'partial_object', attempt: 1, data: { object: {} }, ...ASK_ },
        verify: { type: 'verify', data: { attempts: 1, passed: true }, ...ASK_ },
        log: { type: 'log', data: { event: 'x' } },
        memory_remember: { type: 'memory_remember', data: { scope: 'global' } },
        memory_recall: { type: 'memory_recall', data: { scope: 'global' } },
        memory_forget: { type: 'memory_forget', data: { scope: 'global' } },
        checkpoint_save: { type: 'checkpoint_save', data: { step: 0 } },
        checkpoint_replay: { type: 'checkpoint_replay', data: { step: 0 } },
        await_human: { type: 'await_human', data: { prompt: 'p' } },
        await_human_resolved: {
          type: 'await_human_resolved',
          data: { decision: { approved: true } },
        },
        guardrail: { type: 'guardrail', data: { guardrailType: 'input', blocked: false } },
        schema_check: {
          type: 'schema_check',
          data: { valid: true, attempt: 1, maxAttempts: 1 },
        },
        validate: { type: 'validate', data: { valid: true, attempt: 1, maxAttempts: 1 } },
        // `done` and `error` are synthesized by AxlStream's `_done` / `_error`
        // methods, so we don't push them directly — `_done` below emits the
        // canonical `done` event for us. Including placeholder entries here
        // keeps the record exhaustive over `AxlEventType`.
        done: { type: 'done', data: { result: null } },
        error: { type: 'error', data: { message: 'x' } },
      };

      for (const t of AXL_EVENT_TYPES) {
        if (t === 'done' || t === 'error') continue; // synthesized by the stream
        stream._push(ev(minimalByType[t]));
      }
      stream._done('fin', 'test-exec');

      const lifecycleTypes: AxlEventType[] = [];
      for await (const event of stream.lifecycle) {
        lifecycleTypes.push(event.type);
      }

      const expectedLifecycle = AXL_EVENT_TYPES.filter((t) => categorization[t] === 'lifecycle');
      // Sort both sides: AXL_EVENT_TYPES order is not the push order for
      // synthesized terminals (done), but the set equality is the contract.
      expect([...lifecycleTypes].sort()).toEqual([...expectedLifecycle].sort());

      // And no excluded type must have leaked through.
      for (const t of lifecycleTypes) {
        expect(categorization[t]).toBe('lifecycle');
      }
    });
  });
});
