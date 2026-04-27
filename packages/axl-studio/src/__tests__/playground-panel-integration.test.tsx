// @vitest-environment jsdom
/**
 * PlaygroundPanel integration test — drives the panel through a complete
 * AxlEvent stream the way the real WebSocket layer would, without mocking
 * the hook itself. Verifies:
 *
 *   - Submitting a message starts an execution and streams tokens into the
 *     assistant message bubble.
 *   - `tool_call_start` + `tool_call_end` events render a Tool: row with
 *     the tool name and (after end) the result.
 *   - `handoff` events render the source → target row.
 *   - The Subagents drawer auto-promotes the FIRST time a nested-ask event
 *     (`depth >= 1`) is seen on the stream — explicit user-off still wins
 *     but we don't test that here.
 *   - On `done`, the streaming UI quiesces and the final result is reachable
 *     via the standard reducer path (event.data.result).
 *   - On `error`, an "Error: ..." assistant bubble appears.
 *
 * Approach: mock at the WS + API boundary, NOT the hook. Real `useWsStream`
 * runs against an injected `wsClient.subscribe` callback so the same
 * reducer code that ships in production is exercised.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// ── Mock the WS singleton: capture subscribe callback per channel ─────
const subscribers = new Map<string, (data: unknown) => void>();
const wsSubscribeMock = vi.fn((channel: string, cb: (data: unknown) => void) => {
  subscribers.set(channel, cb);
  return () => {
    subscribers.delete(channel);
  };
});

vi.mock('../client/lib/ws', () => ({
  wsClient: {
    subscribe: (channel: string, cb: (data: unknown) => void) => wsSubscribeMock(channel, cb),
  },
}));

// ── Mock the REST API surface the panel uses ──────────────────────────
const playgroundChatMock = vi.fn();
const fetchAgentsMock = vi.fn();

vi.mock('../client/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../client/lib/api')>('../client/lib/api');
  return {
    ...actual,
    fetchAgents: () => fetchAgentsMock(),
    playgroundChat: (msg: string, sid?: string, agent?: string) =>
      playgroundChatMock(msg, sid, agent),
  };
});

// Stub scrollIntoView (jsdom doesn't implement it; the panel calls it for
// auto-scroll on every message append).
beforeEach(() => {
  (Element.prototype as any).scrollIntoView = vi.fn();
});

afterEach(() => {
  subscribers.clear();
  wsSubscribeMock.mockClear();
  playgroundChatMock.mockReset();
  fetchAgentsMock.mockReset();
});

// Import AFTER mocks so the panel + hook resolve to the mocked modules.
const { PlaygroundPanel } = await import('../client/panels/playground/PlaygroundPanel');
import type { AxlEvent } from '../client/lib/types';

function renderWithQuery(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

let _step = 0;
function ev(partial: Record<string, unknown>): AxlEvent {
  return {
    executionId: 'exec-1',
    step: _step++,
    timestamp: _step,
    ...partial,
  } as AxlEvent;
}

beforeEach(() => {
  _step = 0;
});

/** Push an event to the most recently subscribed channel — the hook
 *  subscribes once per executionId via `useWs`. */
function pushEvent(event: AxlEvent, channel = 'execution:exec-1'): void {
  const cb = subscribers.get(channel);
  if (!cb) throw new Error(`No subscriber for ${channel}; have: ${[...subscribers.keys()]}`);
  act(() => {
    cb(event);
  });
}

async function submitMessage(text: string): Promise<void> {
  const textarea = screen.getByPlaceholderText('Type a message...');
  // Press Enter to trigger handleSend — avoids button selector fragility.
  await act(async () => {
    fireEvent.change(textarea, { target: { value: text } });
  });
  await act(async () => {
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
  });
  // Wait for playgroundChat() to resolve and setExecutionId to commit, then
  // the hook's useEffect to subscribe.
  await waitFor(
    () => {
      expect(playgroundChatMock).toHaveBeenCalled();
      expect(subscribers.has('execution:exec-1')).toBe(true);
    },
    { timeout: 2000 },
  );
}

describe('PlaygroundPanel integration', () => {
  beforeEach(() => {
    fetchAgentsMock.mockResolvedValue([]);
    playgroundChatMock.mockResolvedValue({ executionId: 'exec-1', sessionId: 'sess-1' });
  });

  it('streams tokens into the assistant bubble; final result on done', async () => {
    renderWithQuery(<PlaygroundPanel />);

    await submitMessage('hello');
    expect(playgroundChatMock).toHaveBeenCalledWith('hello', undefined, undefined);

    // Hook subscribes after executionId is set.
    expect(subscribers.has('execution:exec-1')).toBe(true);

    // Stream tokens at depth 0 — these accumulate into the chat bubble.
    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'chat', data: 'Hi ' }));
    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'chat', data: 'there' }));
    expect(screen.getByText('Hi there')).toBeInTheDocument();

    // Push done — panel should stop streaming, drop executionId, render the
    // user + assistant messages without errors.
    pushEvent(ev({ type: 'done', data: { result: 'Hi there' } }));
    expect(screen.getByText('Hi there')).toBeInTheDocument();
    // The user message bubble is also visible.
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('renders tool_call_start args and tool_call_end result rows', async () => {
    renderWithQuery(<PlaygroundPanel />);
    await submitMessage('use a tool');

    // The assistant message must exist before we attach tool calls — push a
    // token first so the placeholder bubble is appended.
    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'chat', data: 'Calling tool...' }));

    pushEvent(
      ev({
        type: 'tool_call_start',
        askId: 'a',
        depth: 0,
        tool: 'getWeather',
        callId: 'c1',
        data: { args: { city: 'SF' } },
      }),
    );
    expect(screen.getByText('Tool: getWeather')).toBeInTheDocument();

    pushEvent(
      ev({
        type: 'tool_call_end',
        askId: 'a',
        depth: 0,
        tool: 'getWeather',
        callId: 'c1',
        data: { args: { city: 'SF' }, result: { tempF: 65 } },
      }),
    );
    // Result section appears after tool_call_end.
    expect(screen.getByText('Output:')).toBeInTheDocument();

    pushEvent(ev({ type: 'done', data: { result: 'It is 65°F in SF' } }));
  });

  it('renders handoff source → target after a handoff event', async () => {
    renderWithQuery(<PlaygroundPanel />);
    await submitMessage('hand off please');

    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'router', data: 'Routing...' }));
    pushEvent(
      ev({
        type: 'handoff_start',
        fromAskId: 'a',
        toAskId: 'b',
        sourceDepth: 0,
        targetDepth: 0,
        data: { source: 'router', target: 'specialist', mode: 'oneway' },
      }),
    );
    // The handoff renders in the chat bubble AND in the Activity drawer
    // (which auto-opens on handoff_start), so use getAllByText.
    expect(screen.getAllByText('router').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('specialist').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('(oneway)')).toBeInTheDocument();
  });

  it('auto-opens Activity drawer on first nested-ask event (depth >= 1)', async () => {
    renderWithQuery(<PlaygroundPanel />);
    await submitMessage('do nested work');

    // The "Activity" button always renders in the header; the drawer's
    // <h3> heading only appears when the drawer is open.
    const drawerOpen = () => screen.queryByRole('heading', { name: /activity/i });

    // No activity yet — drawer is hidden.
    expect(drawerOpen()).not.toBeInTheDocument();

    // Outer activity (depth 0, non-trigger type) does NOT open the drawer.
    pushEvent(
      ev({ type: 'agent_call_start', askId: 'a', depth: 0, agent: 'outer', model: 'mock' }),
    );
    expect(drawerOpen()).not.toBeInTheDocument();

    // First nested event flips the latch — the drawer appears.
    pushEvent(
      ev({
        type: 'ask_start',
        askId: 'b',
        parentAskId: 'a',
        depth: 1,
        agent: 'inner',
        prompt: 'sub-q',
      }),
    );
    expect(drawerOpen()).toBeInTheDocument();
  });

  it('auto-opens Activity drawer on tool_call_start (even at depth 0)', async () => {
    renderWithQuery(<PlaygroundPanel />);
    await submitMessage('use a tool please');

    const drawerOpen = () => screen.queryByRole('heading', { name: /activity/i });
    expect(drawerOpen()).not.toBeInTheDocument();

    pushEvent(
      ev({
        type: 'tool_call_start',
        askId: 'a',
        depth: 0,
        tool: 'getWeather',
        callId: 'c1',
        data: { args: { city: 'SF' } },
      }),
    );
    expect(drawerOpen()).toBeInTheDocument();
  });

  it('renders exactly ONE "Error:" message bubble on stream error (regression)', async () => {
    // Regression: this used to render TWO error bubbles to the user. The
    // effect handling stream.done would re-fire on the intermediate render
    // between `setIsStreaming(false)` and useWsStream's `id → null`
    // gate-clear effect — during that window stream.done and stream.error
    // were still set, so the error bubble was appended a second time.
    // Fix: gate the done/error branch on `isStreaming` so it's a one-shot.
    renderWithQuery(<PlaygroundPanel />);
    await submitMessage('break');

    pushEvent(ev({ type: 'error', data: { message: 'budget exceeded' } }));
    const matches = screen.getAllByText(/Error: budget exceeded/i);
    expect(matches.length).toBe(1);
  });

  it('renders stream.result as assistant bubble when done arrives without tokens (late-subscribe race)', async () => {
    // Regression: when an execution completes faster than the panel can
    // subscribe to the WS channel (mock providers, fast workflows), the
    // replay buffer does NOT include `token` events
    // (connection-manager.ts treats them as reconstructable from
    // `done`/`agent_call_end`). The panel sees `done` with a populated
    // result but no accumulated tokens. Without the result fallback, the
    // assistant bubble is never added — visible as "user message sent,
    // nothing came back" in the UI. This was finding #1 from manual
    // testing (orchestrator-agent ran fast enough to hit this race).
    renderWithQuery(<PlaygroundPanel />);
    await submitMessage('investigate x');

    // Skip token events entirely — simulates the late-subscribe race
    // where tokens were already discarded by the replay buffer.
    pushEvent(ev({ type: 'done', data: { result: 'Orchestrator synthesis: final answer' } }));

    expect(await screen.findByText(/Orchestrator synthesis: final answer/)).toBeInTheDocument();
  });

  it('drops nested-ask tokens (depth >= 1) from the chat bubble', async () => {
    // The bug class this catches: a regression that loses the depth-0
    // filter in useWsStream would surface every sub-agent's tokens in
    // the outer chat bubble, garbling the user's view.
    renderWithQuery(<PlaygroundPanel />);
    await submitMessage('show me the bug');

    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'outer', data: 'Outer says: ' }));
    pushEvent(
      ev({
        type: 'token',
        askId: 'b',
        parentAskId: 'a',
        depth: 1,
        agent: 'inner',
        data: 'INNER-LEAK',
      }),
    );
    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'outer', data: 'done' }));
    pushEvent(ev({ type: 'done', data: { result: 'Outer says: done' } }));

    expect(screen.getByText('Outer says: done')).toBeInTheDocument();
    // INNER-LEAK must NOT appear in any rendered bubble.
    expect(screen.queryByText(/INNER-LEAK/)).not.toBeInTheDocument();
  });
});
