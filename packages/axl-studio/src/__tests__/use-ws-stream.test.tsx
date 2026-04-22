// @vitest-environment jsdom
/**
 * `useWsStream` hook tests — exercises the spec/16 reducer that turns the
 * raw WS event stream into the panel-facing `{ tokens, events, done, result,
 * error }` state. Critical surface — the bug class that bites here:
 *
 *   - depth filter on `token`: a regression that drops the `depth === 0`
 *     check would let nested-ask tokens leak into the chat bubble of every
 *     panel that calls this hook (Playground, Workflow Runner).
 *   - `done` and `error` need to read from `data.result` / `data.message`
 *     under the new wrapped AxlEvent shape — the legacy `event.data` /
 *     `event.message` paths return undefined and silently break the panel.
 *   - Transition handling on executionId changes: documented in the hook
 *     itself (null→id wipes; id→null gate-only clear). Pinning these stops
 *     subtle UX bugs (stale done flag flashing on back-to-back runs;
 *     events disappearing the moment the run completes).
 *
 * The hook calls `useWs` internally, which subscribes to a singleton
 * `wsClient`. We mock `wsClient.subscribe` to capture the callback so the
 * test can push events directly — same pattern the real WS layer uses, no
 * actual sockets involved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Capture the callback registered by useWs so tests can push events.
let wsCallback: ((data: unknown) => void) | null = null;
const subscribeMock = vi.fn((_channel: string, cb: (data: unknown) => void) => {
  wsCallback = cb;
  return () => {
    wsCallback = null;
  };
});

vi.mock('../client/lib/ws', () => ({
  wsClient: {
    subscribe: (channel: string, cb: (data: unknown) => void) => subscribeMock(channel, cb),
  },
}));

// Import AFTER the mock is registered so useWs picks up the mocked client.
const { useWsStream } = await import('../client/hooks/use-ws-stream');
import type { AxlEvent } from '../client/lib/types';

let _step = 0;
function ev(partial: Record<string, unknown>): AxlEvent {
  return {
    executionId: 'e1',
    step: _step++,
    timestamp: _step,
    ...partial,
  } as AxlEvent;
}

function pushEvent(event: AxlEvent): void {
  if (!wsCallback) throw new Error('No WS callback registered (subscribe not called)');
  act(() => {
    wsCallback!(event);
  });
}

beforeEach(() => {
  wsCallback = null;
  subscribeMock.mockClear();
  _step = 0;
});

describe('useWsStream — initial state', () => {
  it('starts with empty state when executionId is null (no subscribe call)', () => {
    const { result } = renderHook(() => useWsStream(null));
    expect(result.current).toEqual({
      tokens: '',
      events: [],
      done: false,
      error: null,
      result: null,
    });
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('subscribes to execution:{id} when executionId is provided', () => {
    renderHook(() => useWsStream('exec-123'));
    expect(subscribeMock).toHaveBeenCalledWith('execution:exec-123', expect.any(Function));
  });
});

describe('useWsStream — token accumulation', () => {
  it('accumulates root-only tokens (depth === 0) into the tokens string', () => {
    const { result } = renderHook(() => useWsStream('e'));
    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'root', data: 'Hello' }));
    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'root', data: ' world' }));
    expect(result.current.tokens).toBe('Hello world');
  });

  it('drops nested-ask tokens (depth >= 1) from `tokens` but keeps them in `events`', () => {
    // The bug class this catches: a regression that removes the `depth === 0`
    // filter would surface every sub-agent's tokens in the outer chat bubble,
    // garbling the user's view in any panel using this hook.
    const { result } = renderHook(() => useWsStream('e'));
    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'root', data: 'root-tok' }));
    pushEvent(ev({ type: 'token', askId: 'b', depth: 1, agent: 'inner', data: 'inner-tok' }));
    pushEvent(ev({ type: 'token', askId: 'c', depth: 2, agent: 'innermost', data: 'deep' }));
    expect(result.current.tokens).toBe('root-tok'); // ONLY the depth-0 token
    expect(result.current.events).toHaveLength(3); // all three preserved for panels that want them
  });

  it('treats undefined depth as root (back-compat for events that pre-date AskScoped)', () => {
    const { result } = renderHook(() => useWsStream('e'));
    pushEvent(ev({ type: 'token', data: 'no-depth' }));
    expect(result.current.tokens).toBe('no-depth');
  });
});

describe('useWsStream — done event (new wrapped shape)', () => {
  it('reads result from event.data.result (NOT event.data — that path is wrong post-spec/16)', () => {
    const { result } = renderHook(() => useWsStream('e'));
    pushEvent(ev({ type: 'done', data: { result: 'final answer' } }));
    expect(result.current.done).toBe(true);
    expect(result.current.result).toBe('final answer');
    // Critical: the panel must NOT receive `{ result: 'final answer' }` as
    // the result — it must unwrap to the inner string.
    expect(result.current.result).not.toEqual({ result: 'final answer' });
  });

  it('handles done with object result (workflow returned an object)', () => {
    const { result } = renderHook(() => useWsStream('e'));
    pushEvent(ev({ type: 'done', data: { result: { answer: 42, breakdown: [1, 2] } } }));
    expect(result.current.result).toEqual({ answer: 42, breakdown: [1, 2] });
  });

  it('handles done with no result (null fallback, not undefined)', () => {
    const { result } = renderHook(() => useWsStream('e'));
    pushEvent(ev({ type: 'done', data: {} }));
    expect(result.current.done).toBe(true);
    expect(result.current.result).toBeNull(); // null sentinel — panels render this as "no result"
  });
});

describe('useWsStream — error event (new wrapped shape)', () => {
  it('reads message from event.data.message (NOT event.message)', () => {
    const { result } = renderHook(() => useWsStream('e'));
    pushEvent(ev({ type: 'error', data: { message: 'budget exceeded' } }));
    expect(result.current.done).toBe(true);
    expect(result.current.error).toBe('budget exceeded');
  });

  it('falls back to "Unknown error" when message is missing', () => {
    const { result } = renderHook(() => useWsStream('e'));
    pushEvent(ev({ type: 'error', data: {} }));
    expect(result.current.error).toBe('Unknown error');
  });
});

describe('useWsStream — non-token events accumulate into events[]', () => {
  it('records ask_start / agent_call_end / tool_call_end / pipeline / handoff / partial_object', () => {
    const { result } = renderHook(() => useWsStream('e'));
    pushEvent(ev({ type: 'ask_start', askId: 'a', depth: 0, agent: 'root', prompt: 'q' }));
    pushEvent(ev({ type: 'agent_call_start', askId: 'a', depth: 0, agent: 'root', model: 'mock' }));
    pushEvent(
      ev({
        type: 'tool_call_start',
        askId: 'a',
        depth: 0,
        tool: 't',
        callId: 'c1',
        data: { args: {} },
      }),
    );
    pushEvent(
      ev({
        type: 'tool_call_end',
        askId: 'a',
        depth: 0,
        tool: 't',
        callId: 'c1',
        data: { args: {}, result: 'ok' },
      }),
    );
    pushEvent(
      ev({
        type: 'pipeline',
        askId: 'a',
        depth: 0,
        status: 'committed',
        stage: 'initial',
        attempt: 1,
        maxAttempts: 1,
      }),
    );
    pushEvent(
      ev({ type: 'partial_object', askId: 'a', depth: 0, attempt: 1, data: { object: {} } }),
    );
    expect(result.current.events.map((e) => e.type)).toEqual([
      'ask_start',
      'agent_call_start',
      'tool_call_start',
      'tool_call_end',
      'pipeline',
      'partial_object',
    ]);
  });
});

describe('useWsStream — executionId transitions', () => {
  it('null → id: starts fresh', () => {
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useWsStream(id), {
      initialProps: { id: null as string | null },
    });
    expect(subscribeMock).not.toHaveBeenCalled();
    rerender({ id: 'first-run' });
    expect(subscribeMock).toHaveBeenCalledWith('execution:first-run', expect.any(Function));
    expect(result.current.tokens).toBe('');
  });

  it('id → newId: wipes prior run state (the "stale events from old run" bug)', () => {
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useWsStream(id), {
      initialProps: { id: 'first-run' as string | null },
    });
    pushEvent(ev({ type: 'token', depth: 0, data: 'first-text' }));
    pushEvent(ev({ type: 'done', data: { result: 'first-result' } }));
    expect(result.current.tokens).toBe('first-text');
    expect(result.current.result).toBe('first-result');

    rerender({ id: 'second-run' });
    expect(result.current).toEqual({
      tokens: '',
      events: [],
      done: false,
      error: null,
      result: null,
    });
  });

  it('id → null: keeps tokens/events visible but clears the done/result/error gate', () => {
    // Documented invariant in the hook source: when a stream finishes and the
    // panel sets executionId back to null, the just-completed run's timeline
    // must STAY visible until the user starts a new run. But `done` /
    // `result` / `error` get cleared so the panel's adoption effect doesn't
    // re-fire on the next render with stale "the run is done" data.
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useWsStream(id), {
      initialProps: { id: 'run' as string | null },
    });
    pushEvent(ev({ type: 'token', depth: 0, data: 'visible' }));
    pushEvent(ev({ type: 'done', data: { result: 'done-result' } }));
    expect(result.current.done).toBe(true);

    rerender({ id: null });
    expect(result.current.tokens).toBe('visible'); // KEPT
    expect(result.current.events.length).toBe(2); // KEPT
    expect(result.current.done).toBe(false); // CLEARED
    expect(result.current.result).toBeNull(); // CLEARED
    expect(result.current.error).toBeNull(); // CLEARED
  });
});

describe('useWsStream — pipeline retry token semantics (spec/16 §4.3)', () => {
  // useWsStream is a thin reducer; it does NOT itself implement
  // commit-on-success buffering for tokens — that's the AxlStream.fullText
  // contract on the SDK side. The hook simply concatenates everything it
  // receives at depth=0. Pinning the current behavior so a future "fix" to
  // make the hook also discard retried tokens doesn't surprise callers.
  it('concatenates tokens from across attempts (commit-on-success is the SDK fullText contract, not the hook)', () => {
    const { result } = renderHook(() => useWsStream('e'));
    pushEvent(ev({ type: 'token', depth: 0, data: 'attempt1' }));
    pushEvent(
      ev({
        type: 'pipeline',
        askId: 'a',
        depth: 0,
        status: 'failed',
        stage: 'schema',
        attempt: 1,
        maxAttempts: 2,
        reason: 'parse error',
      }),
    );
    pushEvent(
      ev({
        type: 'pipeline',
        askId: 'a',
        depth: 0,
        status: 'start',
        stage: 'schema',
        attempt: 2,
        maxAttempts: 2,
      }),
    );
    pushEvent(ev({ type: 'token', depth: 0, data: 'attempt2' }));
    pushEvent(
      ev({
        type: 'pipeline',
        askId: 'a',
        depth: 0,
        status: 'committed',
        stage: 'schema',
        attempt: 2,
      }),
    );
    expect(result.current.tokens).toBe('attempt1attempt2');
  });
});
