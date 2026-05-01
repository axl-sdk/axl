// @vitest-environment jsdom
/**
 * SessionManagerPanel renders an agent badge next to each assistant
 * message that carries `ChatMessage.agent` (added in 0.18). Tripwire so
 * a future refactor of the message-row JSX or type doesn't silently
 * drop the visible attribution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const fetchSessionsMock = vi.fn();
const fetchSessionMock = vi.fn();
const deleteSessionMock = vi.fn();

vi.mock('../client/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../client/lib/api')>('../client/lib/api');
  return {
    ...actual,
    fetchSessions: () => fetchSessionsMock(),
    fetchSession: (id: string) => fetchSessionMock(id),
    deleteSession: (id: string) => deleteSessionMock(id),
  };
});

beforeEach(() => {
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
});
afterEach(() => {
  fetchSessionsMock.mockReset();
  fetchSessionMock.mockReset();
  deleteSessionMock.mockReset();
});

const { SessionManagerPanel } =
  await import('../client/panels/session-manager/SessionManagerPanel');

function renderWithQuery(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('SessionManagerPanel — agent attribution badge', () => {
  it('renders a badge with the agent name on assistant messages that have ChatMessage.agent', async () => {
    fetchSessionsMock.mockResolvedValue([{ id: 'sess-1' }]);
    fetchSessionMock.mockResolvedValue({
      id: 'sess-1',
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi from triage', agent: 'triage' },
        { role: 'assistant', content: 'hi from billing', agent: 'billing' },
      ],
    });

    renderWithQuery(<SessionManagerPanel />);

    // Click into the session row to load detail.
    const sessionRow = await screen.findByText('sess-1');
    fireEvent.click(sessionRow);

    await waitFor(() => {
      expect(screen.getByText('hi from triage')).toBeInTheDocument();
      expect(screen.getByText('hi from billing')).toBeInTheDocument();
    });

    // Agent badges must be present and distinct.
    expect(screen.getByText('triage')).toBeInTheDocument();
    expect(screen.getByText('billing')).toBeInTheDocument();
  });

  it('omits the badge on user messages and on assistant messages without agent', async () => {
    fetchSessionsMock.mockResolvedValue([{ id: 'sess-2' }]);
    fetchSessionMock.mockResolvedValue({
      id: 'sess-2',
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'untagged reply' },
      ],
    });

    renderWithQuery(<SessionManagerPanel />);
    const sessionRow = await screen.findByText('sess-2');
    fireEvent.click(sessionRow);

    await waitFor(() => {
      expect(screen.getByText('untagged reply')).toBeInTheDocument();
    });

    // Neither user nor untagged assistant should produce an extra
    // badge — only the role label should appear.
    const assistantHits = screen.queryAllByText('assistant');
    expect(assistantHits.length).toBe(1);
    const userHits = screen.queryAllByText('user');
    expect(userHits.length).toBe(1);
  });
});
