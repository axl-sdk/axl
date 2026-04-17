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
});
