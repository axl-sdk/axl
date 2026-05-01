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

  it('clicking an agent badge highlights only matching assistant rows; clicking again clears', async () => {
    fetchSessionsMock.mockResolvedValue([{ id: 'sess-3' }]);
    fetchSessionMock.mockResolvedValue({
      id: 'sess-3',
      history: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1', agent: 'triage' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2', agent: 'billing' },
        { role: 'assistant', content: 'a3', agent: 'triage' },
      ],
    });

    renderWithQuery(<SessionManagerPanel />);
    fireEvent.click(await screen.findByText('sess-3'));
    await waitFor(() => expect(screen.getByText('a1')).toBeInTheDocument());

    // Each message renders content via <div className="whitespace-pre-wrap">{content}</div>;
    // that's a direct child of the bubble div. Walk up one level.
    const rowOf = (text: string): HTMLElement => screen.getByText(text).parentElement!;

    // Initially nothing is dimmed.
    expect(rowOf('a1').className).not.toMatch(/opacity-30/);
    expect(rowOf('a2').className).not.toMatch(/opacity-30/);
    expect(rowOf('a3').className).not.toMatch(/opacity-30/);

    // Click the first 'triage' badge (button).
    const triageBadge = screen.getAllByRole('button', { name: /triage/i })[0];
    fireEvent.click(triageBadge);

    // Only the 'billing' assistant row should be dimmed; user rows are
    // untouched (we only dim assistant rows).
    expect(rowOf('a1').className).not.toMatch(/opacity-30/);
    expect(rowOf('a2').className).toMatch(/opacity-30/);
    expect(rowOf('a3').className).not.toMatch(/opacity-30/);
    expect(rowOf('q1').className).not.toMatch(/opacity-30/);
    expect(rowOf('q2').className).not.toMatch(/opacity-30/);

    // Click again to clear.
    fireEvent.click(triageBadge);
    expect(rowOf('a1').className).not.toMatch(/opacity-30/);
    expect(rowOf('a2').className).not.toMatch(/opacity-30/);
    expect(rowOf('a3').className).not.toMatch(/opacity-30/);
  });

  it('badge has its own color (not inheriting opacity-70 from the role row)', async () => {
    // Regression: pre-fix the role+badge wrapper had `opacity-70`, which
    // applied to the badge too — bad contrast on light themes. The fix
    // moves opacity to just the role span and gives the badge muted-fg
    // colors. Tripwire so a future refactor doesn't bring the bug back.
    fetchSessionsMock.mockResolvedValue([{ id: 'sess-4' }]);
    fetchSessionMock.mockResolvedValue({
      id: 'sess-4',
      history: [{ role: 'assistant', content: 'reply', agent: 'triage' }],
    });

    renderWithQuery(<SessionManagerPanel />);
    fireEvent.click(await screen.findByText('sess-4'));
    await waitFor(() => expect(screen.getByText('reply')).toBeInTheDocument());

    const badge = screen.getByRole('button', { name: /triage/i });
    const wrapper = badge.parentElement!;
    // The wrapper must NOT carry `opacity-70` (which would propagate to the
    // badge child and crush contrast).
    expect(wrapper.className).not.toMatch(/(?:^|\s)opacity-70(?:\s|$)/);
    // The badge should carry its own muted-foreground color so it's
    // visible regardless of theme.
    expect(badge.className).toMatch(/text-\[hsl\(var\(--muted-foreground\)\)\]/);
  });
});
