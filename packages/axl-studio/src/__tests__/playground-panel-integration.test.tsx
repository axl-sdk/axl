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
const connectionSubscribers = new Set<(connected: boolean) => void>();
const wsSubscribeMock = vi.fn((channel: string, cb: (data: unknown) => void) => {
  subscribers.set(channel, cb);
  return () => {
    subscribers.delete(channel);
  };
});

vi.mock('../client/lib/ws', () => ({
  wsClient: {
    subscribe: (channel: string, cb: (data: unknown) => void) => wsSubscribeMock(channel, cb),
    subscribeConnection: (cb: (connected: boolean) => void) => {
      connectionSubscribers.add(cb);
      return () => connectionSubscribers.delete(cb);
    },
  },
}));

// ── Mock the REST API surface the panel uses ──────────────────────────
const playgroundChatMock = vi.fn();
const fetchAgentsMock = vi.fn();

vi.mock('../client/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../client/lib/api')>('../client/lib/api');
  return {
    schemaVersion: 2,
    ...actual,
    fetchAgents: () => fetchAgentsMock(),
    playgroundChat: (msg: string, sid?: string, agent?: string, image?: unknown) =>
      image === undefined
        ? playgroundChatMock(msg, sid, agent)
        : playgroundChatMock(msg, sid, agent, image),
  };
});

// Stub scrollIntoView (jsdom doesn't implement it; the panel calls it for
// auto-scroll on every message append).
beforeEach(() => {
  (Element.prototype as any).scrollIntoView = vi.fn();
  URL.createObjectURL = vi.fn(() => 'blob:image-preview');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  subscribers.clear();
  connectionSubscribers.clear();
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

function disconnect(): void {
  act(() => {
    for (const callback of connectionSubscribers) callback(false);
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

  it('previews, sends once, and discards a local image attachment', async () => {
    renderWithQuery(<PlaygroundPanel />);
    const file = new File([new Uint8Array([1, 2, 3])], 'receipt.png', { type: 'image/png' });
    const picker = screen.getByLabelText('Choose image');
    await act(async () => {
      fireEvent.change(picker, { target: { files: [file] } });
    });
    await waitFor(() => expect(screen.getByAltText('Selected image preview')).toBeInTheDocument());
    const invalid = new File(['not an image'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(picker, { target: { files: [invalid] } });
    expect(screen.queryByAltText('Selected image preview')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a PNG, JPEG, WebP, or GIF image.');
    await act(async () => {
      fireEvent.change(picker, { target: { files: [file] } });
    });
    await waitFor(() => expect(screen.getByAltText('Selected image preview')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Remove selected image'));
    expect(screen.queryByAltText('Selected image preview')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.change(picker, { target: { files: [file] } });
    });
    await waitFor(() => expect(screen.getByAltText('Selected image preview')).toBeInTheDocument());

    const textarea = screen.getByPlaceholderText('Type a message...');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'look at this' } });
    });
    await waitFor(() => expect(textarea).toHaveValue('look at this'));
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });
    await waitFor(() =>
      expect(playgroundChatMock).toHaveBeenCalledWith('look at this', undefined, undefined, {
        mediaType: 'image/png',
        data: 'AQID',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByAltText('Selected image preview')).not.toBeInTheDocument(),
    );
  });

  it('clears a selected image and image error when starting a new chat', async () => {
    renderWithQuery(<PlaygroundPanel />);
    const picker = screen.getByLabelText('Choose image');
    const file = new File([new Uint8Array([1, 2, 3])], 'receipt.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.change(picker, { target: { files: [file] } });
    });
    await waitFor(() => expect(screen.getByAltText('Selected image preview')).toBeInTheDocument());
    fireEvent.click(screen.getByText('New chat'));
    expect(screen.queryByAltText('Selected image preview')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores an out-of-order FileReader completion after replacement', async () => {
    const OriginalFileReader = globalThis.FileReader;
    class DeferredReader {
      static instances: DeferredReader[] = [];
      result: string | ArrayBuffer | null = null;
      onload: ((event: ProgressEvent<FileReader>) => unknown) | null = null;
      onerror: ((event: ProgressEvent<FileReader>) => unknown) | null = null;
      abort = vi.fn();
      readAsDataURL() {
        DeferredReader.instances.push(this);
      }
    }
    globalThis.FileReader = DeferredReader as unknown as typeof FileReader;
    try {
      renderWithQuery(<PlaygroundPanel />);
      const picker = screen.getByLabelText('Choose image');
      const first = new File(['one'], 'one.png', { type: 'image/png' });
      const second = new File(['two'], 'two.png', { type: 'image/png' });
      await act(async () => {
        fireEvent.change(picker, { target: { files: [first] } });
        fireEvent.change(picker, { target: { files: [second] } });
      });
      expect(DeferredReader.instances).toHaveLength(2);
      DeferredReader.instances[0]!.result = 'data:image/png;base64,iVBORw0KGgo=';
      await act(async () => {
        DeferredReader.instances[0]!.onload?.(
          new ProgressEvent('load') as ProgressEvent<FileReader>,
        );
      });
      expect(screen.queryByAltText('Selected image preview')).not.toBeInTheDocument();
      DeferredReader.instances[1]!.result = 'data:image/png;base64,iVBORw0KGgo=';
      await act(async () => {
        DeferredReader.instances[1]!.onload?.(
          new ProgressEvent('load') as ProgressEvent<FileReader>,
        );
      });
      await waitFor(() =>
        expect(screen.getByAltText('Selected image preview')).toBeInTheDocument(),
      );
    } finally {
      globalThis.FileReader = OriginalFileReader;
    }
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
        data: {
          args: { city: 'SF' },
          outcome: { status: 'succeeded', result: { tempF: 65 } },
        },
      }),
    );
    // Result section appears after tool_call_end.
    expect(screen.getByText('Output:')).toBeInTheDocument();

    pushEvent(ev({ type: 'done', data: { result: 'It is 65°F in SF' } }));
  });

  it('renders failed and rejected tool invocations as terminal rows', async () => {
    renderWithQuery(<PlaygroundPanel />);
    await submitMessage('exercise terminal tools');
    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'chat', data: 'Working...' }));

    pushEvent(
      ev({
        type: 'tool_call_start',
        askId: 'a',
        depth: 0,
        agent: 'chat',
        tool: 'lookup',
        callId: 'failed-call',
        data: { args: { id: 1 } },
      }),
    );
    pushEvent(
      ev({
        type: 'tool_call_end',
        askId: 'a',
        depth: 0,
        agent: 'chat',
        tool: 'lookup',
        callId: 'failed-call',
        duration: 1,
        data: {
          args: { id: 1 },
          outcome: {
            status: 'failed',
            failure: {
              phase: 'handler',
              kind: 'unexpected',
              disposition: 'abort',
              attempts: 1,
              error: { name: 'Error', message: 'host failure' },
            },
          },
        },
      }),
    );
    pushEvent(
      ev({
        type: 'tool_call_rejected',
        askId: 'a',
        depth: 0,
        agent: 'chat',
        tool: 'missing',
        callId: 'rejected-call',
        data: { reason: 'unavailable', requestedTool: 'missing', availableTools: ['lookup'] },
      }),
    );

    expect(screen.getAllByText('failed').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('rejected').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Failed in handler: Error/)).toBeInTheDocument();
    expect(screen.getByText(/Rejected before execution: unavailable/)).toBeInTheDocument();
  });

  it('renders denied and cancelled tool invocations as terminal rows', async () => {
    renderWithQuery(<PlaygroundPanel />);
    await submitMessage('exercise policy terminals');
    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'chat', data: 'Working...' }));

    for (const callId of ['denied-call', 'cancelled-call']) {
      pushEvent(
        ev({
          type: 'tool_call_start',
          askId: 'a',
          depth: 0,
          agent: 'chat',
          tool: 'lookup',
          callId,
          data: { args: { callId } },
        }),
      );
    }
    pushEvent(
      ev({
        type: 'tool_call_end',
        askId: 'a',
        depth: 0,
        agent: 'chat',
        tool: 'lookup',
        callId: 'denied-call',
        duration: 1,
        data: {
          args: { callId: 'denied-call' },
          outcome: { status: 'denied', reason: 'operator denied' },
        },
      }),
    );
    pushEvent(
      ev({
        type: 'tool_call_end',
        askId: 'a',
        depth: 0,
        agent: 'chat',
        tool: 'lookup',
        callId: 'cancelled-call',
        duration: 1,
        data: {
          args: { callId: 'cancelled-call' },
          outcome: {
            status: 'cancelled',
            cancellation: {
              phase: 'after_handler',
              reason: 'execution stopped',
              result: { retained: true },
            },
          },
        },
      }),
    );

    expect(screen.getAllByText('denied').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('cancelled').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Reason: operator denied')).toBeInTheDocument();
    expect(screen.getByText(/Cancelled in after_handler: execution stopped/)).toBeInTheDocument();
    expect(screen.getByText('Output before cancellation:')).toBeInTheDocument();
  });

  it('marks an unmatched running tool incomplete when the socket disconnects', async () => {
    renderWithQuery(<PlaygroundPanel />);
    await submitMessage('interrupt the tool');
    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'chat', data: 'Working...' }));
    pushEvent(
      ev({
        type: 'tool_call_start',
        askId: 'a',
        depth: 0,
        agent: 'chat',
        tool: 'lookup',
        callId: 'interrupted-call',
        data: { args: {} },
      }),
    );

    disconnect();

    expect(screen.getAllByText('incomplete').length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText('Trace ended before a matching tool terminal was observed.'),
    ).toBeInTheDocument();
  });

  it('renders retained results and orphan terminals honestly', async () => {
    renderWithQuery(<PlaygroundPanel />);
    await submitMessage('exercise replay gaps');
    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'chat', data: 'Working...' }));

    pushEvent(
      ev({
        type: 'tool_call_end',
        askId: 'a',
        depth: 0,
        agent: 'chat',
        tool: 'lookup',
        callId: 'orphan-end',
        duration: 1,
        data: {
          args: { id: 1 },
          outcome: {
            status: 'failed',
            failure: {
              phase: 'projection',
              kind: 'output',
              disposition: 'abort',
              error: { name: 'Error', message: 'projection failed' },
              result: { retained: true },
            },
          },
        },
      }),
    );

    expect(screen.getByText(/Terminal observed without its matching start/)).toBeInTheDocument();
    expect(screen.getByText('Output before failure:')).toBeInTheDocument();
    expect(screen.getByText('"retained"')).toBeInTheDocument();
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

  it('renders schema response as JSON tree + typewriter line (not raw JSON syntax)', async () => {
    // Spec/17 follow-up: prior to this fix, a schema-mode ask streamed
    // raw tokens like `{"summary":"H` into `StreamingText`, showing
    // gibberish to the operator. Now the panel detects partial_object
    // events and switches to a JSON tree view + a typewriter line for
    // the actively-streaming string field.
    renderWithQuery(<PlaygroundPanel />);
    await submitMessage('summarize this');

    // Tokens arrive — but for a schema response these are raw JSON
    // syntax. The bubble shouldn't show them as the primary content
    // once partial_object snapshots start firing.
    pushEvent(
      ev({ type: 'token', askId: 'a', depth: 0, agent: 'summarizer', data: '{"summary":"H' }),
    );

    // First string_delta — the actively-writing field.
    pushEvent(
      ev({
        type: 'string_delta',
        askId: 'a',
        depth: 0,
        agent: 'summarizer',
        attempt: 1,
        data: { path: '/summary', delta: 'Hello world' },
      }),
    );

    // First partial_object snapshot lands on the structural seam after the
    // closing `"`. Now the bubble should render the JSON tree.
    pushEvent(
      ev({
        type: 'partial_object',
        askId: 'a',
        depth: 0,
        agent: 'summarizer',
        attempt: 1,
        data: { object: { summary: 'Hello world' } },
      }),
    );

    // The structured-output bubble must render after the partial_object
    // event lands. Wait for the header — proves we switched away from
    // raw-token render.
    await waitFor(
      () => {
        const body = document.body.textContent ?? '';
        if (!body.includes('Streaming structured output')) {
          throw new Error(
            `Expected "Streaming structured output" in body. Got first 800 chars: ${body.slice(0, 800)}`,
          );
        }
      },
      { timeout: 2000 },
    );
    // The accumulated text appears somewhere — typewriter line OR
    // JsonViewer's quoted string. Either is fine.
    const body = document.body.textContent ?? '';
    expect(body).toContain('Hello world');
    // Crucially: the raw `{"summary":"H` token blob must NOT be the
    // primary content — we replaced that with the structured view.
    // (It may still appear inside the JSON tree's preview as "H" but
    // not as the standalone token text the bubble used to show.)

    // Crucially: the raw JSON token literal `{"summary":"H` MUST NOT
    // appear as bubble content (this was the bug — operators saw the
    // truncated JSON syntax mid-stream).
    expect(screen.queryByText('{"summary":"H')).not.toBeInTheDocument();

    pushEvent(
      ev({
        type: 'ask_end',
        askId: 'a',
        depth: 0,
        agent: 'summarizer',
        outcome: { ok: true, result: { summary: 'Hello world' } },
        cost: 0,
        duration: 1,
      }),
    );
    pushEvent(ev({ type: 'done', data: { result: { summary: 'Hello world' } } }));

    // Post-completion: the bubble renders the parsed object as a JSON
    // tree. The "Hello world" text remains visible.
    await waitFor(() => {
      expect(document.body.textContent ?? '').toContain('Hello world');
    });
  });

  it('post-completion: JSON-string result with token gibberish renders as JSON tree (not raw text)', async () => {
    // Real-world regression: the playground server stringifies a parsed
    // object into `done.data.result: string` (canonical compact form),
    // while tokens stream the raw LLM JSON (often pretty-printed,
    // potentially with chunk-boundary artifacts). Pre-fix the
    // done-handler's overwrite-content gate didn't recognize a
    // string-typed structured result, so msg.content stayed as the
    // token accumulation — and if the tokens had any chunk-boundary
    // weirdness (e.g. dev fixture's regex strips newlines, leaving a
    // valid-but-unusual whitespace pattern), `tryParseJsonObject` could
    // fail and the bubble fell back to plain-text rendering. User-visible
    // symptom: structured render during stream → reverts to plain JSON
    // text after done.
    //
    // Fix: detect JSON-string result and canonicalize via parse →
    // re-stringify, overwriting msg.content so the post-completion
    // render gets a reliable input.
    renderWithQuery(<PlaygroundPanel />);
    await submitMessage('summarize via tokens then JSON-string result');

    // Tokens stream messy raw JSON (with leading whitespace artifacts,
    // simulating the dev-fixture's newline-stripping regex).
    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'sx', data: '{' }));
    pushEvent(
      ev({ type: 'token', askId: 'a', depth: 0, agent: 'sx', data: '  "summary": "Hi"  ' }),
    );
    pushEvent(ev({ type: 'token', askId: 'a', depth: 0, agent: 'sx', data: '}' }));

    // Server sends `done` with the canonical JSON-string form.
    pushEvent(ev({ type: 'done', data: { result: '{"summary":"Hi"}' } }));

    // The bubble must render the parsed JSON, NOT the stringified literal.
    // We verify by checking the JsonViewer's Expand button is present.
    await waitFor(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const hasExpand = buttons.some((b) => /Expand|Collapse/i.test(b.textContent ?? ''));
      if (!hasExpand) throw new Error('JsonViewer not rendered');
    });
    // The literal `{"summary":"Hi"}` text node should NOT exist as the
    // primary bubble content (would mean we didn't switch to JsonViewer).
    expect(screen.queryByText('{"summary":"Hi"}')).not.toBeInTheDocument();
  });

  it('post-completion: JSON-shaped result content renders as JSON tree, not stringified', async () => {
    // When a workflow returns a structured object, useWsStream's done
    // fallback path (no tokens replayed) stringifies it into msg.content.
    // The bubble should detect the JSON shape and render via JsonViewer
    // instead of showing literal `{"summary":"..."}` text.
    renderWithQuery(<PlaygroundPanel />);
    await submitMessage('return JSON');

    pushEvent(ev({ type: 'done', data: { result: { summary: 'JSON result text' } } }));

    // The string value renders inside the tree as a quoted span.
    // textContent walk handles mixed-content nodes without matcher
    // brittleness.
    await waitFor(() => {
      expect(document.body.textContent ?? '').toContain('JSON result text');
    });
    // The bubble must NOT show the literal stringified-JSON form as a
    // single text node — that was the pre-fix behavior. The JsonViewer
    // renders structured, so a literal exact-match of the JSON-with-
    // braces should not exist as a single text node.
    expect(screen.queryByText('{"summary":"JSON result text"}')).not.toBeInTheDocument();
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
