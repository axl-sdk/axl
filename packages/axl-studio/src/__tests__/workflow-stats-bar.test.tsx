// @vitest-environment jsdom
/**
 * Regression coverage for WorkflowStatsBar.
 *
 * Two bugs we've shipped and want to prevent from coming back:
 *
 *   1. Empty-state dead end — when the current window has zero executions,
 *      the panel originally returned `null`, which also hid the WindowSelector.
 *      If the user's default window (e.g. 24h) was empty but 7d had data,
 *      they had no way to discover that. The fix keeps the header and
 *      selector visible and shows a hint instead.
 *
 *   2. Clickable row must fire onWorkflowClick so the Workflow Runner panel
 *      can use the stats table as a picker. A prior version rendered rows
 *      without the click handler; the feature silently regressed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { WorkflowStatsResponse } from '../client/lib/types';

// Mock the WS singleton — jsdom has no WebSocket, and these tests don't
// exercise the live-update path.
vi.mock('../client/lib/ws', () => ({
  wsClient: {
    subscribe: () => () => {},
    connect: () => {},
  },
}));

// Mock the API module — each test overrides the return value.
const fetchWorkflowStatsMock = vi.fn<() => Promise<WorkflowStatsResponse>>();
vi.mock('../client/lib/api', () => ({
  fetchWorkflowStats: (...args: unknown[]) => fetchWorkflowStatsMock(...(args as [])),
}));

// Import AFTER mocks are registered (vi.mock hoists, but importing the SUT
// after setup keeps the data flow obvious).
import { WorkflowStatsBar } from '../client/panels/workflow-runner/WorkflowStatsBar';

function renderWithProviders(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const emptyResponse: WorkflowStatsResponse = {
  byWorkflow: {},
  totalExecutions: 0,
  failureRate: 0,
};

const populatedResponse: WorkflowStatsResponse = {
  byWorkflow: {
    'workflow-a': {
      total: 10,
      completed: 9,
      failed: 1,
      durationP50: 500,
      durationP95: 2000,
      avgDuration: 750,
    },
    'workflow-b': {
      total: 5,
      completed: 5,
      failed: 0,
      durationP50: 100,
      durationP95: 300,
      avgDuration: 150,
    },
  },
  totalExecutions: 15,
  failureRate: 1 / 15,
};

beforeEach(() => {
  fetchWorkflowStatsMock.mockReset();
  localStorage.clear();
});

describe('WorkflowStatsBar', () => {
  it('keeps the WindowSelector visible when the current window is empty', async () => {
    // Regression: the initial empty-state branch returned `null`, which hid
    // the WindowSelector entirely and left users with no way to widen the
    // window. The fix renders the header + selector even when empty.
    fetchWorkflowStatsMock.mockResolvedValue(emptyResponse);
    renderWithProviders(<WorkflowStatsBar />);

    // Header survives.
    expect(await screen.findByText('Workflow Stats')).toBeInTheDocument();
    // Window radios survive — all four.
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    // Empty hint tells the user how to escape.
    expect(screen.getByText(/try a wider window/i)).toBeInTheDocument();
  });

  it('renders a workflow row per entry, sorted by total descending', async () => {
    fetchWorkflowStatsMock.mockResolvedValue(populatedResponse);
    renderWithProviders(<WorkflowStatsBar />);

    const a = await screen.findByText('workflow-a');
    const b = screen.getByText('workflow-b');
    expect(a).toBeInTheDocument();
    expect(b).toBeInTheDocument();

    // DOM order should match "by total desc": workflow-a (10) appears before
    // workflow-b (5). compareDocumentPosition returns DOCUMENT_POSITION_FOLLOWING
    // when the argument follows the reference node.
    const mask = a.compareDocumentPosition(b);
    expect(mask & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('fires onWorkflowClick when a workflow row is clicked', async () => {
    fetchWorkflowStatsMock.mockResolvedValue(populatedResponse);
    const onWorkflowClick = vi.fn();
    renderWithProviders(<WorkflowStatsBar onWorkflowClick={onWorkflowClick} />);

    const row = (await screen.findByText('workflow-a')).closest('tr');
    expect(row).not.toBeNull();
    const user = userEvent.setup();
    await user.click(row!);

    expect(onWorkflowClick).toHaveBeenCalledWith('workflow-a');
  });

  it('does not attach a click handler when onWorkflowClick is omitted', async () => {
    fetchWorkflowStatsMock.mockResolvedValue(populatedResponse);
    renderWithProviders(<WorkflowStatsBar />);

    const row = (await screen.findByText('workflow-a')).closest('tr');
    expect(row).not.toBeNull();
    // Without a handler the row should not carry the "Click to select" hint.
    expect(row?.getAttribute('title')).toBeNull();
  });
});
