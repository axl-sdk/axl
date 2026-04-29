// @vitest-environment jsdom
/**
 * Regression coverage for the Sidebar's collapsed-state logic — the bit
 * users actually feel: it should remember their explicit toggle, default
 * to collapsed on phones when no preference is set, and never override an
 * intentional choice when the viewport happens to cross 768px later.
 *
 * The motivating bug: a `useEffect`-registered media-query listener kept
 * firing forever, so a user who explicitly collapsed on a wide viewport,
 * then resized through narrow → wide, would have their choice overwritten
 * the moment the breakpoint flipped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../client/components/layout/Sidebar';

const STORAGE_KEY = 'axl.studio.sidebar.collapsed';
const NARROW_QUERY = '(max-width: 767px)';

type FakeMediaQuery = {
  matches: boolean;
  media: string;
  addEventListener: (type: 'change', listener: (e: { matches: boolean }) => void) => void;
  removeEventListener: (type: 'change', listener: (e: { matches: boolean }) => void) => void;
  // Test helper — not part of the real MediaQueryList interface.
  __fire: (matches: boolean) => void;
};

function createFakeMatchMedia(initialMatches: boolean) {
  const queries = new Map<string, FakeMediaQuery>();
  const matchMedia = (query: string): FakeMediaQuery => {
    let entry = queries.get(query);
    if (!entry) {
      const listeners = new Set<(e: { matches: boolean }) => void>();
      entry = {
        matches: query === NARROW_QUERY ? initialMatches : false,
        media: query,
        addEventListener: (_type, l) => listeners.add(l),
        removeEventListener: (_type, l) => listeners.delete(l),
        __fire: (matches: boolean) => {
          entry!.matches = matches;
          for (const l of listeners) l({ matches });
        },
      };
      queries.set(query, entry);
    }
    return entry;
  };
  return { matchMedia, queries };
}

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe('Sidebar', () => {
  let mm: ReturnType<typeof createFakeMatchMedia>;

  beforeEach(() => {
    localStorage.clear();
    mm = createFakeMatchMedia(false);
    vi.stubGlobal('matchMedia', mm.matchMedia);
    // jsdom doesn't define matchMedia on window by default — stubGlobal
    // covers `window.matchMedia` since it sets globalThis.matchMedia.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: mm.matchMedia,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to expanded on a wide viewport with no stored preference', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: /collapse sidebar/i })).toBeInTheDocument();
    expect(screen.getByText('Axl Studio')).toBeInTheDocument();
  });

  it('auto-collapses on a narrow viewport when no preference is stored', () => {
    mm = createFakeMatchMedia(true);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: mm.matchMedia,
    });
    renderSidebar();
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
    expect(screen.queryByText('Axl Studio')).not.toBeInTheDocument();
  });

  it("respects a stored 'expanded' preference even on a narrow viewport", () => {
    localStorage.setItem(STORAGE_KEY, '0');
    mm = createFakeMatchMedia(true);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: mm.matchMedia,
    });
    renderSidebar();
    expect(screen.getByRole('button', { name: /collapse sidebar/i })).toBeInTheDocument();
  });

  it("respects a stored 'collapsed' preference even on a wide viewport", () => {
    localStorage.setItem(STORAGE_KEY, '1');
    renderSidebar();
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
  });

  it('auto-collapses when the viewport narrows and no user choice is stored', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: /collapse sidebar/i })).toBeInTheDocument();
    act(() => {
      mm.queries.get(NARROW_QUERY)!.__fire(true);
    });
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
  });

  it('locks out the media-query auto-toggle once the user clicks the toggle', async () => {
    const user = userEvent.setup();
    renderSidebar();
    // Start expanded on a wide viewport, then explicitly collapse.
    await user.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');
    // Resize narrow → wide. The user's explicit choice (collapsed) must stick.
    act(() => {
      mm.queries.get(NARROW_QUERY)!.__fire(true);
    });
    act(() => {
      mm.queries.get(NARROW_QUERY)!.__fire(false);
    });
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
  });

  it('exposes aria-expanded that reflects the collapsed state', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const button = screen.getByRole('button', { name: /collapse sidebar/i });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.click(button);
    const collapsed = screen.getByRole('button', { name: /expand sidebar/i });
    expect(collapsed).toHaveAttribute('aria-expanded', 'false');
  });
});
