// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_TOOL_LIFECYCLE_V1_FIXTURE } from './fixtures/tool-lifecycle-v1.js';

const wsSubscribeMock = vi.fn((_channel: string, _callback: (data: unknown) => void) => vi.fn());

vi.mock('../client/lib/ws', () => ({
  wsClient: {
    subscribe: (channel: string, callback: (data: unknown) => void) =>
      wsSubscribeMock(channel, callback),
    subscribeConnection: () => vi.fn(),
  },
}));

// Import after the WebSocket boundary is replaced. The REST module remains
// real so this exercises fetchExecutions(), TanStack Query, and the panel's
// loading-to-persisted-execution transition together.
const { TraceExplorerPanel } =
  await import('../client/panels/trace-explorer/TraceExplorerPanel.js');

const fetchMock = vi.fn<typeof fetch>();

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
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: [STUDIO_TOOL_LIFECYCLE_V1_FIXTURE],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    wsSubscribeMock.mockClear();
  });

  it('renders the persisted unversioned fixture with historical lifecycle semantics', async () => {
    renderPanel();

    const execution = await screen.findByRole('button', { name: /legacy-workflow/i });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/executions',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
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
});
