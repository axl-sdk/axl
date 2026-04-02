import { describe, it, expect } from 'vitest';
import { AxlStream } from '../stream.js';

describe('AxlStream', () => {
  it('pushing events makes them available via async iterator', async () => {
    const stream = new AxlStream();

    stream._push({ type: 'token', data: 'hello' });
    stream._push({ type: 'token', data: ' world' });
    stream._done('hello world');

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: 'token', data: 'hello' });
    expect(events[1]).toEqual({ type: 'token', data: ' world' });
    expect(events[2]).toEqual({ type: 'done', data: 'hello world' });
  });

  it('text getter filters only token events', async () => {
    const stream = new AxlStream();

    // Push mixed events
    stream._push({ type: 'token', data: 'Hi' });
    stream._push({ type: 'step', step: 1, data: {} });
    stream._push({ type: 'token', data: ' there' });
    stream._done('result');

    const tokens: string[] = [];
    for await (const text of stream.text) {
      tokens.push(text);
    }

    expect(tokens).toEqual(['Hi', ' there']);
  });

  it('fullText joins all tokens', () => {
    const stream = new AxlStream();

    stream._push({ type: 'token', data: 'Hello' });
    stream._push({ type: 'token', data: ', ' });
    stream._push({ type: 'token', data: 'World!' });
    stream._done('result');

    expect(stream.fullText).toBe('Hello, World!');
  });

  it('fullText is empty when no tokens pushed', () => {
    const stream = new AxlStream();
    stream._done('result');
    expect(stream.fullText).toBe('');
  });

  it('_done signals completion', async () => {
    const stream = new AxlStream();

    stream._push({ type: 'token', data: 'data' });
    stream._done({ result: 'final' });

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent.data).toEqual({ result: 'final' });
  });

  it('_error signals error through iterator', async () => {
    const stream = new AxlStream();
    const error = new Error('something broke');

    // Catch the promise rejection to prevent unhandled rejection
    stream.promise.catch(() => {});
    stream._error(error);

    // The iterator should yield the error event, then complete
    const iter = stream[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: 'error', message: 'something broke' });

    const second = await iter.next();
    expect(second.done).toBe(true);
  });

  it('promise resolves on done', async () => {
    const stream = new AxlStream();

    // Resolve after a microtask to allow promise to be set up
    queueMicrotask(() => {
      stream._push({ type: 'token', data: 'abc' });
      stream._done('final-value');
    });

    const result = await stream.promise;
    expect(result).toBe('final-value');
  });

  it('promise rejects on error', async () => {
    const stream = new AxlStream();

    queueMicrotask(() => {
      stream._error(new Error('stream failed'));
    });

    await expect(stream.promise).rejects.toThrow('stream failed');
  });

  it('ignores events after _done is called', () => {
    const stream = new AxlStream();

    stream._push({ type: 'token', data: 'before' });
    stream._done('done');
    stream._push({ type: 'token', data: 'after' });

    // fullText should not include 'after'
    expect(stream.fullText).toBe('before');
  });

  it('ignores events after _error is called', () => {
    const stream = new AxlStream();

    // Catch the promise rejection to prevent unhandled rejection
    stream.promise.catch(() => {});
    stream._push({ type: 'token', data: 'before' });
    stream._error(new Error('err'));
    stream._push({ type: 'token', data: 'after' });

    expect(stream.fullText).toBe('before');
  });

  it('[Symbol.asyncDispose]() properly cleans up a stream mid-iteration', async () => {
    const stream = new AxlStream();

    // Start pushing events
    stream._push({ type: 'token', data: 'first' });
    stream._push({ type: 'token', data: 'second' });

    const iter = stream[Symbol.asyncIterator]();

    // Read one event
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: 'token', data: 'first' });

    // Dispose the iterator mid-iteration
    await iter[Symbol.asyncDispose]();

    // Stream should still be usable for other consumers after one iterator is disposed
    // Push more events and complete
    stream._push({ type: 'token', data: 'third' });
    stream._done('done');

    // The disposed iterator should report done
    // (It won't receive more events because it was disposed)
    expect(stream.fullText).toBe('firstsecondthird');
  });

  it('[Symbol.asyncDispose] calls destroy() on underlying Readable', async () => {
    const stream = new AxlStream();
    stream._push({ type: 'token', data: 'first' });

    const iter = stream[Symbol.asyncIterator]();
    await iter.next();

    // Dispose should call destroy()
    let destroyCalled = false;
    const origDestroy = stream.destroy.bind(stream);
    stream.destroy = ((...args: any[]) => {
      destroyCalled = true;
      return origDestroy(...args);
    }) as any;

    await iter[Symbol.asyncDispose]();
    expect(destroyCalled).toBe(true);
  });

  it('_error() propagates the exact error object through .promise', async () => {
    const stream = new AxlStream();
    const specificError = new Error('specific test error');

    queueMicrotask(() => {
      stream._error(specificError);
    });

    try {
      await stream.promise;
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBe(specificError);
    }
  });

  it('supports new typed stream events (agent_start, agent_end, tool_result, handoff)', async () => {
    const stream = new AxlStream();

    stream._push({ type: 'agent_start', agent: 'test-agent', model: 'openai:gpt-4o' });
    stream._push({ type: 'tool_call', name: 'calc', args: { x: 1 } });
    stream._push({ type: 'tool_result', name: 'calc', result: { answer: 42 } });
    stream._push({ type: 'handoff', source: 'triage', target: 'specialist' });
    stream._push({ type: 'agent_end', agent: 'test-agent', cost: 0.01, duration: 500 });
    stream._done('final');

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(6); // 5 events + done
    expect(events[0]).toEqual({ type: 'agent_start', agent: 'test-agent', model: 'openai:gpt-4o' });
    expect(events[1]).toEqual({ type: 'tool_call', name: 'calc', args: { x: 1 } });
    expect(events[2]).toEqual({ type: 'tool_result', name: 'calc', result: { answer: 42 } });
    expect(events[3]).toEqual({ type: 'handoff', source: 'triage', target: 'specialist' });
    expect(events[4]).toEqual({
      type: 'agent_end',
      agent: 'test-agent',
      cost: 0.01,
      duration: 500,
    });
  });

  it('.steps getter filters to structural events only', async () => {
    const stream = new AxlStream();

    stream._push({ type: 'token', data: 'hi' });
    stream._push({ type: 'agent_start', agent: 'a', model: 'm' });
    stream._push({ type: 'token', data: ' there' });
    stream._push({ type: 'tool_call', name: 'calc', args: {} });
    stream._push({ type: 'step', step: 1, data: {} });
    stream._push({ type: 'tool_result', name: 'calc', result: 42 });
    stream._push({ type: 'handoff', source: 'a', target: 'b' });
    stream._push({ type: 'agent_end', agent: 'a' });
    stream._done('result');

    const steps: any[] = [];
    for await (const event of stream.steps) {
      steps.push(event);
    }

    // Should include: agent_start, tool_call, tool_result, handoff, agent_end
    // Should exclude: token, step, done, error
    expect(steps).toHaveLength(5);
    expect(steps.map((s) => s.type)).toEqual([
      'agent_start',
      'tool_call',
      'tool_result',
      'handoff',
      'agent_end',
    ]);
  });

  it('.on() works for new event types', async () => {
    const stream = new AxlStream();
    const received: any[] = [];

    stream.on('agent_start', (event: any) => received.push(event));
    stream.on('handoff', (event: any) => received.push(event));

    stream._push({ type: 'agent_start', agent: 'a', model: 'm' });
    stream._push({ type: 'handoff', source: 'a', target: 'b' });
    stream._done('done');

    // Give the bus time to emit
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe('agent_start');
    expect(received[1].type).toBe('handoff');
  });

  it('tool_approval event appears in stream.steps but not stream.text', async () => {
    const stream = new AxlStream();

    stream._push({ type: 'token', data: 'hello' });
    stream._push({
      type: 'tool_approval',
      name: 'risky_tool',
      args: { x: 1 },
      approved: false,
      reason: 'Too dangerous',
    });
    stream._push({ type: 'token', data: ' world' });
    stream._done('result');

    // Collect steps
    const steps: any[] = [];
    for await (const event of stream.steps) {
      steps.push(event);
    }
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('tool_approval');
    expect(steps[0].name).toBe('risky_tool');
    expect(steps[0].approved).toBe(false);
    expect(steps[0].reason).toBe('Too dangerous');
  });

  it('stream.on("tool_approval", handler) fires', async () => {
    const stream = new AxlStream();
    const received: any[] = [];

    stream.on('tool_approval', (event: any) => received.push(event));

    stream._push({
      type: 'tool_approval',
      name: 'deploy',
      args: { env: 'prod' },
      approved: true,
    });
    stream._done('done');

    await new Promise((r) => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('tool_approval');
    expect(received[0].name).toBe('deploy');
    expect(received[0].approved).toBe(true);
  });

  it('tool_approval with approved: true appears in stream.steps', async () => {
    const stream = new AxlStream();

    stream._push({
      type: 'tool_approval',
      name: 'deploy',
      args: { env: 'prod' },
      approved: true,
    });
    stream._done('result');

    const steps: any[] = [];
    for await (const event of stream.steps) {
      steps.push(event);
    }
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('tool_approval');
    expect(steps[0].approved).toBe(true);
  });

  it('handoff event with mode field preserved through iterator', async () => {
    const stream = new AxlStream();

    stream._push({
      type: 'handoff',
      source: 'coordinator',
      target: 'specialist',
      mode: 'roundtrip',
    });
    stream._done('result');

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const handoff = events.find((e) => e.type === 'handoff');
    expect(handoff).toBeDefined();
    expect(handoff.source).toBe('coordinator');
    expect(handoff.target).toBe('specialist');
    expect(handoff.mode).toBe('roundtrip');
  });

  it('handles waiting iterators that consume events as they arrive', async () => {
    const stream = new AxlStream();

    const collectPromise = (async () => {
      const events: any[] = [];
      for await (const event of stream) {
        events.push(event);
      }
      return events;
    })();

    // Push events after the iterator is already waiting
    await new Promise((r) => setTimeout(r, 10));
    stream._push({ type: 'token', data: 'delayed' });
    stream._done('fin');

    const events = await collectPromise;
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'token', data: 'delayed' });
    expect(events[1]).toEqual({ type: 'done', data: 'fin' });
  });
});
