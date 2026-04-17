// @vitest-environment jsdom
/**
 * Regression coverage for the WindowSelector component and its localStorage
 * persistence helpers. The persistence is shared by every aggregate panel
 * (Workflow Stats, Cost Dashboard, Eval Trends, Trace Stats), so breaking
 * `getStoredWindow`/`setStoredWindow` silently desynchronizes the UI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  WindowSelector,
  getStoredWindow,
  setStoredWindow,
} from '../client/components/shared/WindowSelector';

describe('WindowSelector', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders all four window options as radios', () => {
    render(<WindowSelector value="7d" onChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(4);
  });

  it('marks the active window with aria-checked', () => {
    render(<WindowSelector value="24h" onChange={() => {}} />);
    const active = screen.getByRole('radio', { name: 'Window: 24h' });
    expect(active).toHaveAttribute('aria-checked', 'true');

    const other = screen.getByRole('radio', { name: 'Window: 7d' });
    expect(other).toHaveAttribute('aria-checked', 'false');
  });

  it('fires onChange with the new window on click', async () => {
    const onChange = vi.fn();
    render(<WindowSelector value="24h" onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Window: 30d' }));
    expect(onChange).toHaveBeenCalledWith('30d');
  });

  describe('storage helpers', () => {
    it('defaults to 7d when nothing is stored', () => {
      expect(getStoredWindow()).toBe('7d');
    });

    it('round-trips valid window ids', () => {
      setStoredWindow('30d');
      expect(getStoredWindow()).toBe('30d');
      setStoredWindow('all');
      expect(getStoredWindow()).toBe('all');
    });

    it('falls back to 7d when the stored value is unrecognized', () => {
      // Simulate a future version that added a new id and was rolled back, or
      // a corrupted value. The UI should quietly default, not crash.
      localStorage.setItem('axl.studio.window', 'bogus');
      expect(getStoredWindow()).toBe('7d');
    });
  });
});
