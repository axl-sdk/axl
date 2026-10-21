// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_TOOL_LIFECYCLE_V1_FIXTURE } from './fixtures/tool-lifecycle-v1.js';

const wsSubscribeMock = vi.fn((_channel: string, _callback: (data: unknown) => void) => vi.fn());
const fetchExecutionsMock = vi.fn<(cursor?: string) => Promise<unknown>>();
const fetchExecutionMock = vi.fn<(id: string) => Promise<unknown>>();

/** Serve `records` the way the server does: summaries in the list, full records by id. */
function seedExecutions(records: Array<Record<string, any>>) {
  fetchExecutionsMock.mockResolvedValue({
    data: records.map(({ events, ...summary }) => ({ ...summary, eventCount: events.length })),
    nextCursor: null,
  });
  fetchExecutionMock.mockImplementation(async (id) => {
    const record = records.find((r) => r.executionId === id);
    if (!record) throw new Error(`Execution "${id}" not found`);
    return record;
  });
}

vi.mock('../client/lib/ws', () => ({
  wsClient: {
    subscribe: (channel: string, callback: (data: unknown) => void) =>
      wsSubscribeMock(channel, callback),
    subscribeConnection: () => vi.fn(),
  },
}));

vi.mock('../client/lib/api', () => ({
  fetchExecutions: (cursor?: string) => fetchExecutionsMock(cursor),
  fetchExecution: (id: string) => fetchExecutionMock(id),
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
    seedExecutions([STUDIO_TOOL_LIFECYCLE_V1_FIXTURE]);
  });

  afterEach(() => {
    fetchExecutionsMock.mockReset();
    fetchExecutionMock.mockReset();
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
      await screen.findByText(
        'Legacy v1 lifecycle: tool outcomes retain their historical semantics and may contain unmatched starts.',
      ),
    ).toBeInTheDocument();
    expect(fetchExecutionMock).toHaveBeenCalledWith(STUDIO_TOOL_LIFECYCLE_V1_FIXTURE.executionId);
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
    seedExecutions([
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
      await screen.findByText(
        'Trace incomplete: terminal finalization stopped after 10 ms with 2 branch continuations still running.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('incomplete trace')).toBeInTheDocument();
  });

  it.each([
    [
      'persistence_truncated',
      { complete: false, reason: 'persistence_truncated', maxEvents: 50 } as const,
      'Trace incomplete: persisted events were truncated at 50 entries.',
    ],
    [
      'process_interrupted',
      { complete: false, reason: 'process_interrupted' } as const,
      'Trace incomplete: the process terminated before the execution reached a terminal boundary.',
    ],
  ])('explains the %s observation boundary', async (reason, observation, message) => {
    seedExecutions([
      {
        executionId: `execution-${reason}`,
        workflow: `workflow-${reason}`,
        status: reason === 'process_interrupted' ? 'failed' : 'completed',
        eventSchemaVersion: 2,
        events: [
          {
            schemaVersion: 2,
            type: 'log',
            executionId: `execution-${reason}`,
            step: 0,
            timestamp: 1,
            data: { event: reason },
          },
        ],
        totalCost: 0,
        startedAt: 1,
        completedAt: 2,
        duration: 1,
        observation,
      },
    ]);

    renderPanel();
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(`workflow-${reason}`, 'i') }),
    );

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('shows a loading state, then an error when the detail fetch fails', async () => {
    seedExecutions([STUDIO_TOOL_LIFECYCLE_V1_FIXTURE]);
    fetchExecutionMock.mockRejectedValue(new Error('store unavailable'));

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /legacy-workflow/i }));

    expect(
      await screen.findByText(/Failed to load execution: store unavailable/),
    ).toBeInTheDocument();
  });

  it('appends the next page when "Load more" is clicked', async () => {
    const run = (id: string, startedAt: number) => ({
      executionId: id,
      workflow: `workflow-${id}`,
      status: 'completed',
      eventSchemaVersion: 2,
      totalCost: 0,
      startedAt,
      duration: 1,
    });
    fetchExecutionsMock.mockImplementation(async (cursor) =>
      cursor === undefined
        ? { data: [{ ...run('new', 2), eventCount: 0 }], nextCursor: 'page-2' }
        : { data: [{ ...run('old', 1), eventCount: 0 }], nextCursor: null },
    );

    renderPanel();
    expect(await screen.findByRole('button', { name: /workflow-new/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /workflow-old/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('button', { name: /workflow-old/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /workflow-new/ })).toBeInTheDocument();
    expect(fetchExecutionsMock).toHaveBeenCalledWith('page-2');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
  });
});
