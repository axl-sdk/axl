// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatCard } from '../client/components/shared/StatCard';

describe('StatCard', () => {
  it('renders label and value', () => {
    render(<StatCard label="Total" value="42" />);
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('renders subtitle when provided', () => {
    render(<StatCard label="Rate" value="99%" subtitle="high" />);
    expect(screen.getByText('high')).toBeInTheDocument();
  });

  it('renders a badge instead of the value when badge is provided', () => {
    render(<StatCard label="Cost" badge={<span data-testid="cb">$0.01</span>} />);
    // Badge wins over value.
    expect(screen.getByTestId('cb')).toBeInTheDocument();
    // No numeric value node.
    expect(screen.queryByText('$0.01', { selector: 'p' })).not.toBeInTheDocument();
  });

  // Regression coverage for the narrow-viewport overflow fix:
  // unbreakable mono values like "1,234,567" or "openai:gpt-4o" used to
  // spill past the rounded card. The fix relies on three classes — drop
  // any of them and the bug returns silently. Class-presence assertions
  // are an explicit reminder to the next refactor.
  describe('overflow handling', () => {
    it('truncates long unbreakable values with ellipsis + hover title', () => {
      const longValue = '1,234,567,890.12';
      render(<StatCard label="Tokens" value={longValue} />);
      const valueNode = screen.getByText(longValue);
      expect(valueNode).toHaveClass('truncate');
      expect(valueNode).toHaveAttribute('title', longValue);
    });

    it('truncates long subtitles too', () => {
      render(<StatCard label="Model" value="-" subtitle="anthropic:claude-opus-4-7" />);
      const subtitleNode = screen.getByText('anthropic:claude-opus-4-7');
      expect(subtitleNode).toHaveClass('truncate');
      expect(subtitleNode).toHaveAttribute('title', 'anthropic:claude-opus-4-7');
    });

    it('does not set a title attribute when value is omitted (badge variant)', () => {
      render(<StatCard label="Cost" badge={<span data-testid="cb">$0.01</span>} />);
      // No <p title="..."> for the value slot, since there is no value.
      // Asserting the badge container has no inappropriate title attribute.
      const badge = screen.getByTestId('cb');
      expect(badge.closest('[title]')).toBeNull();
    });
  });
});
