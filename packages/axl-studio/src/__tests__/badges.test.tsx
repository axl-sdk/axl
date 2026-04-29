// @vitest-environment jsdom
/**
 * Regression coverage for the four shared badges (Cost, Duration, Token,
 * Status). Each must lock to a single line — `whitespace-nowrap` — so they
 * don't break mid-value when packed into a tight table cell. A future
 * Tailwind merge or className refactor that drops `whitespace-nowrap`
 * silently re-introduces the original wrap-and-overflow bug.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CostBadge } from '../client/components/shared/CostBadge';
import { DurationBadge } from '../client/components/shared/DurationBadge';
import { TokenBadge } from '../client/components/shared/TokenBadge';
import { StatusBadge } from '../client/components/shared/StatusBadge';

describe('shared badges — single-line lock', () => {
  it('CostBadge has whitespace-nowrap', () => {
    const { container } = render(<CostBadge cost={0.05} />);
    expect(container.firstChild).toHaveClass('whitespace-nowrap');
  });

  it('DurationBadge has whitespace-nowrap', () => {
    const { container } = render(<DurationBadge ms={1234} />);
    expect(container.firstChild).toHaveClass('whitespace-nowrap');
  });

  it('TokenBadge has whitespace-nowrap', () => {
    const { container } = render(<TokenBadge tokens={9999} label="in" />);
    expect(container.firstChild).toHaveClass('whitespace-nowrap');
  });

  it('StatusBadge has whitespace-nowrap', () => {
    const { container } = render(<StatusBadge status="running" />);
    expect(container.firstChild).toHaveClass('whitespace-nowrap');
  });
});
