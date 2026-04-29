// @vitest-environment jsdom
/**
 * ResizableSplit integration coverage focused on the responsive
 * stacking branch added for narrow viewports. The desktop drag/keyboard
 * paths are exercised indirectly by the workflow-runner and trace-explorer
 * integration tests; this file just verifies the layout flips when the
 * container can't fit two minPx panes side by side.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ResizableSplit } from '../client/components/shared/ResizableSplit';

type ROCallback = (entries: ResizeObserverEntry[]) => void;
const observers: { cb: ROCallback; el: Element }[] = [];

class FakeResizeObserver {
  callback: ROCallback;
  elements = new Set<Element>();
  constructor(cb: ROCallback) {
    this.callback = cb;
  }
  observe(el: Element) {
    this.elements.add(el);
    observers.push({ cb: this.callback, el });
  }
  unobserve(el: Element) {
    this.elements.delete(el);
  }
  disconnect() {
    this.elements.clear();
  }
}

function fireResize(width: number) {
  for (const { cb, el } of observers) {
    const entry = {
      contentRect: { width, height: 800, top: 0, left: 0, right: width, bottom: 800, x: 0, y: 0 },
      target: el,
    } as unknown as ResizeObserverEntry;
    cb([entry]);
  }
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

describe('ResizableSplit — responsive stacking', () => {
  it('renders side-by-side when container fits two minPx panes + gutter', () => {
    render(
      <ResizableSplit
        minPx={200}
        left={<div data-testid="left">L</div>}
        right={<div data-testid="right">R</div>}
      />,
    );
    act(() => fireResize(900));
    // Vertical separator stays for the desktop layout.
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('stacks vertically when container is narrower than 2*minPx + gutter', () => {
    render(
      <ResizableSplit
        minPx={200}
        left={<div data-testid="left">L</div>}
        right={<div data-testid="right">R</div>}
      />,
    );
    act(() => fireResize(360));
    // Separator flips to horizontal in stacked mode.
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
    // Both children still rendered — the layout flipped, not the content.
    expect(screen.getByTestId('left')).toBeInTheDocument();
    expect(screen.getByTestId('right')).toBeInTheDocument();
  });

  it('flips back to side-by-side when the viewport widens', () => {
    render(
      <ResizableSplit
        minPx={200}
        left={<div data-testid="left">L</div>}
        right={<div data-testid="right">R</div>}
      />,
    );
    act(() => fireResize(360));
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
    act(() => fireResize(900));
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
  });
});
