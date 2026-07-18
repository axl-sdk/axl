// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_TOOL_LIFECYCLE_V1_FIXTURE } from './fixtures/tool-lifecycle-v1.js';

const wsSubscribeMock = vi.fn((_channel: string, _callback: (data: unknown) => void) => vi.fn());
const fetchExecutionsMock = vi.fn<() => Promise<unknown[]>>();

vi.mock('../client/lib/ws', () => ({
  wsClient: {
    subscribe: (channel: string, callback: (data: unknown) => void) =>
      wsSubscribeMock(channel, callback),
    subscribeConnection: () => vi.fn(),
  },
}));

vi.mock('../client/lib/api', () => ({
  fetchExecutions: () => fetchExecutionsMock(),
}));

// Import after the external boundaries are replaced. REST request construction
// has dedicated API tests; this suite owns the panel's persisted-history
// rendering transition.
const { TraceExplorerPanel } =
  await import('../client/panels/trace-explorer/TraceExplorerPanel.js');

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TraceExplorerPanel />
    </QueryClientProvider>,
  );
}

describe('TraceExplorerPanel persisted v1 compatibility', () => {
  beforeEach(() => {
    fetchExecutionsMock.mockResolvedValue([STUDIO_TOOL_LIFECYCLE_V1_FIXTURE]);
  });

  afterEach(() => {
    fetchExecutionsMock.mockReset();
    wsSubscribeMock.mockClear();
  });

  it('renders the persisted unversioned fixture with historical lifecycle semantics', async () => {
    renderPanel();

    const execution = await screen.findByRole(
      'button',
      { name: /legacy-workflow/i },
      { timeout: 10_000 },
    );
    expect(fetchExecutionsMock).toHaveBeenCalledOnce();
    expect(screen.getByText('legacy v1')).toBeInTheDocument();

    fireEvent.click(execution);

    expect(
      screen.getByText(
        'Legacy v1 lifecycle: tool outcomes retain their historical semantics and may contain unmatched starts.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('legacy result')).toBeInTheDocument();
    const incompleteRow = screen.getByText('legacy incomplete').closest('button');
    expect(incompleteRow).not.toBeNull();

    // The unmatched accepted call remains visible as an incomplete historical
    // row. Trace Explorer must not invent a terminal event during loading.
    expect(within(incompleteRow!).getByText('dangerous')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('tool_call_end')).toHaveLength(1));
  });

  it('explains bounded-finalization incompleteness without inventing a tool terminal', async () => {
    const observation = {
      complete: false,
      reason: 'branch_drain_timeout',
      pendingContinuations: 2,
      timeoutMs: 10,
    } as const;
    fetchExecutionsMock.mockResolvedValue([
      {
        executionId: 'incomplete-execution',
        workflow: 'bounded-workflow',
        status: 'completed',
        eventSchemaVersion: 2,
        events: [
          {
            schemaVersion: 2,
            type: 'tool_call_start',
            executionId: 'incomplete-execution',
            askId: 'ask-1',
            parentAskId: undefined,
            depth: 0,
            agent: 'agent',
            tool: 'slow-tool',
            callId: 'call-1',
            step: 0,
            timestamp: 1,
            data: { args: {} },
          },
          {
            schemaVersion: 2,
            type: 'workflow_end',
            executionId: 'incomplete-execution',
            workflow: 'bounded-workflow',
            step: 1,
            timestamp: 2,
            data: { status: 'completed', duration: 10, observation },
          },
        ],
        totalCost: 0,
        startedAt: 1,
        completedAt: 11,
        duration: 10,
        result: 'winner',
        observation,
      },
    ]);

    renderPanel();
    fireEvent.click(
      await screen.findByRole('button', { name: /bounded-workflow/i }, { timeout: 10_000 }),
    );

    expect(
      screen.getByText(
        'Trace incomplete: terminal finalization stopped after 10 ms with 2 branch continuations still running.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('incomplete trace')).not.toBeInTheDocument();
  });
});
