// @vitest-environment jsdom
/**
 * CostBadge + formatCost regression coverage.
 *
 * formatCost has five tiered branches (exact zero, sub-micro-cent rounding
 * sentinel, scientific, six-decimal, two-decimal). The tiers exist so the
 * Studio cost display doesn't bottom out at "$0.0000" on cached / embedder
 * calls — a prior bug that made the cost tracker quietly diverge from the
 * provider bill. Each tier is load-bearing for a real user scenario, so
 * every tier gets a test.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostBadge } from '../client/components/shared/CostBadge';
import { formatCost } from '../client/lib/utils';

describe('formatCost tiers', () => {
  it('renders exactly zero as $0.00 (distinct from unknown)', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('renders rounding-noise values as a sub-micro-cent sentinel', () => {
    expect(formatCost(0.0000005)).toBe('< $0.000001');
  });

  it('renders sub-$0.0001 values in scientific notation', () => {
    expect(formatCost(0.0000123)).toBe('$1.23e-5');
  });

  it('renders sub-cent values >= $0.0001 to 6 decimals', () => {
    // Tier boundary: >= $0.0001 and < $0.01 → 6 decimal places.
    expect(formatCost(0.00025)).toBe('$0.000250');
    expect(formatCost(0.005)).toBe('$0.005000');
  });

  it('renders normal values to 2 decimals', () => {
    expect(formatCost(1.234)).toBe('$1.23');
  });

  it('treats non-finite costs as $0.00 rather than NaN', () => {
    expect(formatCost(Number.NaN)).toBe('$0.00');
    expect(formatCost(Number.POSITIVE_INFINITY)).toBe('$0.00');
  });
});

describe('CostBadge', () => {
  it('renders the formatted cost', () => {
    render(<CostBadge cost={0.05} />);
    expect(screen.getByText('$0.05')).toBeInTheDocument();
  });

  it('renders the sub-cent scientific notation without bottoming out', () => {
    // Regression: a prior implementation used toFixed(4) and rendered $0.0000.
    render(<CostBadge cost={0.0000123} />);
    expect(screen.getByText('$1.23e-5')).toBeInTheDocument();
  });
});
