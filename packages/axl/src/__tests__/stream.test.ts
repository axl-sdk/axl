import { describe, it, expect } from 'vitest';
import { AxlStream } from '../stream.js';
import type { AxlEvent } from '../types.js';

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

  it('carries the new AxlEvent shape (agent_call_start/end, tool_call_start/end, handoff)', async () => {
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
        type: 'handoff',
        fromAskId: 'a1',
        toAskId: 'a2',
        sourceDepth: 0,
        targetDepth: 0,
        data: { source: 'triage', target: 'specialist', mode: 'oneway', duration: 1 },
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
      'handoff',
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
        type: 'handoff',
        fromAskId: 'a1',
        toAskId: 'a2',
        sourceDepth: 0,
        targetDepth: 0,
        data: { source: 'a', target: 'b', mode: 'oneway', duration: 1 },
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

    // Should include: agent_call_start, tool_call_start, tool_call_end, handoff, agent_call_end
    // Should exclude: token, log, done, error
    expect(lifecycle.map((s) => s.type)).toEqual([
      'agent_call_start',
      'tool_call_start',
      'tool_call_end',
      'handoff',
      'agent_call_end',
    ]);
  });

  it('.on() works for new event types', async () => {
    const stream = new AxlStream();
    const received: AxlEvent[] = [];

    stream.on('agent_call_start', (event: unknown) => received.push(event as AxlEvent));
    stream.on('handoff', (event: unknown) => received.push(event as AxlEvent));

    stream._push(ev({ type: 'agent_call_start', agent: 'a', model: 'm', turn: 1, ...ASK }));
    stream._push(
      ev({
        type: 'handoff',
        fromAskId: 'a1',
        toAskId: 'a2',
        sourceDepth: 0,
        targetDepth: 0,
        data: { source: 'a', target: 'b', mode: 'oneway', duration: 1 },
      }),
    );
    stream._done('done', 'test-exec');

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe('agent_call_start');
    expect(received[1].type).toBe('handoff');
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

  it('handoff event with mode field preserved through iterator', async () => {
    const stream = new AxlStream();

    stream._push(
      ev({
        type: 'handoff',
        fromAskId: 'a1',
        toAskId: 'a2',
        sourceDepth: 0,
        targetDepth: 0,
        data: { source: 'coordinator', target: 'specialist', mode: 'roundtrip', duration: 1 },
      }),
    );
    stream._done('result', 'test-exec');

    const events: AxlEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const handoff = events.find((e) => e.type === 'handoff') as
      | Extract<AxlEvent, { type: 'handoff' }>
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
});
