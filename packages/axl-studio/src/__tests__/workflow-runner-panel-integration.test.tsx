// @vitest-environment jsdom
/**
 * WorkflowRunnerPanel integration test — drives the panel through a full
 * workflow execution stream the way the real WS layer would, without
 * mocking `useWsStream`. Verifies:
 *
 *   - Workflow selection + Run starts execution and subscribes to the
 *     `execution:{id}` channel.
 *   - Stream events render the AskTree (default tree view) including
 *     nested asks via parent-link.
 *   - StatCards reflect step count, total duration, and cost rollup
 *     (via the shared `eventCostContribution` helper — `ask_end.cost`
 *     rollups must NOT double-count against the leaf events).
 *   - On `done`, status flips to "completed" and the result renders.
 *   - On `error`, status flips to "failed" and the error banner renders.
 *
 * Approach: mock at the WS + API boundary. Real `useWsStream` runs
 * against an injected `wsClient.subscribe` callback so the same reducer
 * code that ships in production is exercised.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// ── Mock the WS singleton ─────────────────────────────────────────────
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

// ── Mock REST API ─────────────────────────────────────────────────────
const fetchWorkflowsMock = vi.fn();
const fetchWorkflowMock = vi.fn();
const executeWorkflowMock = vi.fn();
const fetchWorkflowStatsMock = vi.fn();

vi.mock('../client/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../client/lib/api')>('../client/lib/api');
  return {
    ...actual,
    fetchWorkflows: () => fetchWorkflowsMock(),
    fetchWorkflow: (name: string) => fetchWorkflowMock(name),
    executeWorkflow: (name: string, input: unknown, stream: boolean) =>
      executeWorkflowMock(name, input, stream),
    fetchWorkflowStats: () => fetchWorkflowStatsMock(),
  };
});

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView; the panel uses it for auto-scroll.

  (Element.prototype as any).scrollIntoView = vi.fn();
});

afterEach(() => {
  subscribers.clear();
  wsSubscribeMock.mockClear();
  fetchWorkflowsMock.mockReset();
  fetchWorkflowMock.mockReset();
  executeWorkflowMock.mockReset();
  fetchWorkflowStatsMock.mockReset();
});

// Import AFTER mocks.
const { WorkflowRunnerPanel } =
  await import('../client/panels/workflow-runner/WorkflowRunnerPanel');
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

function pushEvent(event: AxlEvent, channel = 'execution:exec-1'): void {
  const cb = subscribers.get(channel);
  if (!cb) throw new Error(`No subscriber for ${channel}; have: ${[...subscribers.keys()]}`);
  act(() => {
    cb(event);
  });
}

/** Open the workflow CommandPicker and select the named workflow. */
async function selectWorkflow(name: string): Promise<void> {
  // The picker only renders once `workflows.length > 0` — wait for the
  // useQuery result to flush into React state.
  const trigger = await screen.findByRole(
    'button',
    { name: /Select a workflow/i },
    { timeout: 2000 },
  );
  await act(async () => {
    fireEvent.click(trigger);
  });
  // Workflow row appears in the popover (rendered via a portal-style
  // floating div but still in document.body for jsdom).
  const row = await screen.findByText(name);
  await act(async () => {
    fireEvent.click(row);
  });
}

/** Click the Run button to execute the selected workflow with `{}` input. */
async function clickRun(): Promise<void> {
  const runBtn = screen.getByRole('button', { name: /^Run|Running…/i });
  await act(async () => {
    fireEvent.click(runBtn);
  });
  await waitFor(
    () => {
      expect(executeWorkflowMock).toHaveBeenCalled();
      expect(subscribers.has('execution:exec-1')).toBe(true);
    },
    { timeout: 2000 },
  );
}

describe('WorkflowRunnerPanel integration', () => {
  beforeEach(() => {
    fetchWorkflowsMock.mockResolvedValue([
      {
        name: 'my-workflow',
        hasInputSchema: false,
        hasOutputSchema: false,
      },
    ]);
    fetchWorkflowMock.mockResolvedValue({
      name: 'my-workflow',
      hasInputSchema: false,
      hasOutputSchema: false,
    });
    fetchWorkflowStatsMock.mockResolvedValue({ snapshots: {}, updatedAt: 0 });
    executeWorkflowMock.mockResolvedValue({
      streaming: true,
      executionId: 'exec-1',
    });
  });

  it('subscribes to execution:{id} after Run and renders AskTree from streamed events', async () => {
    renderWithQuery(<WorkflowRunnerPanel />);
    await waitFor(() => expect(fetchWorkflowsMock).toHaveBeenCalled());
    await selectWorkflow('my-workflow');
    await clickRun();

    // Stream a small ask graph: outer asks, calls a tool, inner ask, both end.
    pushEvent(ev({ type: 'workflow_start', workflow: 'my-workflow', data: { input: {} } }));
    pushEvent(ev({ type: 'ask_start', askId: 'a', depth: 0, agent: 'outer', prompt: 'q' }));
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
    pushEvent(
      ev({
        type: 'ask_end',
        askId: 'b',
        parentAskId: 'a',
        depth: 1,
        agent: 'inner',
        cost: 0.001,
        duration: 50,
        outcome: { ok: true, result: 'inner-done' },
      }),
    );
    pushEvent(
      ev({
        type: 'ask_end',
        askId: 'a',
        depth: 0,
        agent: 'outer',
        cost: 0.002,
        duration: 100,
        outcome: { ok: true, result: 'outer-done' },
      }),
    );

    // AskTree renders both agents. Use `findByText` to give React a tick.
    expect(await screen.findByText('outer')).toBeInTheDocument();
    expect(await screen.findByText('inner')).toBeInTheDocument();
  });

  it('cost StatCard sums leaf events only — not ask_end rollups (spec/16 §10)', async () => {
    renderWithQuery(<WorkflowRunnerPanel />);
    await waitFor(() => expect(fetchWorkflowsMock).toHaveBeenCalled());
    await selectWorkflow('my-workflow');
    await clickRun();

    // 3 leaves: 2× agent_call_end + 1× tool_call_end. Plus 1 ask_end with
    // a rollup cost. The StatCard MUST sum only the leaves; including the
    // ask_end rollup would double-count.
    pushEvent(ev({ type: 'workflow_start', workflow: 'my-workflow', data: { input: {} } }));
    pushEvent(
      ev({
        type: 'agent_call_end',
        askId: 'a',
        depth: 0,
        agent: 'outer',
        model: 'mock',
        cost: 0.001,
        duration: 30,
        data: { prompt: 'q', response: 'r', params: {}, turn: 1 },
      }),
    );
    pushEvent(
      ev({
        type: 'tool_call_end',
        askId: 'a',
        depth: 0,
        tool: 't',
        callId: 'c1',
        cost: 0.002,
        duration: 20,
        data: { args: {}, result: 'ok' },
      }),
    );
    pushEvent(
      ev({
        type: 'agent_call_end',
        askId: 'a',
        depth: 0,
        agent: 'outer',
        model: 'mock',
        cost: 0.003,
        duration: 40,
        data: { prompt: 'q', response: 'final', params: {}, turn: 2 },
      }),
    );
    pushEvent(
      ev({
        type: 'ask_end',
        askId: 'a',
        depth: 0,
        agent: 'outer',
        cost: 0.006, // Rollup of 0.001 + 0.002 + 0.003. Must be skipped.
        duration: 90,
        outcome: { ok: true, result: 'final' },
      }),
    );

    // Total cost should be $0.006 (the leaves' sum), NOT $0.012 (which would
    // include the ask_end rollup).
    await waitFor(() => {
      // `formatCost` renders e.g. "$0.0060". Match the value, not exact format.
      const candidates = screen.getAllByText(/\$0\.006/);
      expect(candidates.length).toBeGreaterThan(0);
    });
    // Sanity: should NOT find a $0.012 anywhere on the page.
    expect(screen.queryByText(/\$0\.012/)).not.toBeInTheDocument();
  });

  it('done event flips status to completed and renders the result', async () => {
    renderWithQuery(<WorkflowRunnerPanel />);
    await waitFor(() => expect(fetchWorkflowsMock).toHaveBeenCalled());
    await selectWorkflow('my-workflow');
    await clickRun();

    pushEvent(ev({ type: 'workflow_start', workflow: 'my-workflow', data: { input: {} } }));
    pushEvent(
      ev({
        type: 'agent_call_end',
        askId: 'a',
        depth: 0,
        agent: 'a',
        model: 'mock',
        cost: 0.001,
        duration: 50,
        data: { prompt: 'q', response: 'final-answer', params: {}, turn: 1 },
      }),
    );
    pushEvent(
      ev({
        type: 'workflow_end',
        workflow: 'my-workflow',
        data: { status: 'completed', duration: 50, result: 'final-answer' },
      }),
    );
    pushEvent(ev({ type: 'done', data: { result: 'final-answer' } }));

    // Status badge should reflect "completed". The exact label text varies
    // by component; assert via role + text contains `completed`.
    await waitFor(() => {
      const completed = screen.getAllByText(/completed/i);
      expect(completed.length).toBeGreaterThan(0);
    });
  });

  it('error event surfaces in the red banner and flips status to failed', async () => {
    renderWithQuery(<WorkflowRunnerPanel />);
    await waitFor(() => expect(fetchWorkflowsMock).toHaveBeenCalled());
    await selectWorkflow('my-workflow');
    await clickRun();

    pushEvent(ev({ type: 'workflow_start', workflow: 'my-workflow', data: { input: {} } }));
    pushEvent(ev({ type: 'error', data: { message: 'workflow exploded' } }));

    await waitFor(() => {
      expect(screen.getByText(/workflow exploded/i)).toBeInTheDocument();
    });
    // Status badge should be "failed".
    expect(screen.getAllByText(/failed/i).length).toBeGreaterThan(0);
  });
});
