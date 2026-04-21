// @vitest-environment jsdom
/**
 * RetryIndicator component tests — three status branches and stage labels.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RetryIndicator } from '../client/components/shared/RetryIndicator';

describe('<RetryIndicator />', () => {
  it('renders "Retrying" for status=start with non-initial stage', () => {
    render(<RetryIndicator stage="schema" attempt={2} maxAttempts={4} status="start" />);
    const badge = screen.getByTestId('retry-indicator');
    expect(badge).toHaveTextContent('Retrying — Schema 2/4');
    expect(badge).toHaveAttribute('data-status', 'start');
    expect(badge).toHaveAttribute('data-stage', 'schema');
  });

  it('renders plain label for status=start with initial stage (no "Retrying" prefix)', () => {
    render(<RetryIndicator stage="initial" attempt={1} maxAttempts={1} status="start" />);
    const badge = screen.getByTestId('retry-indicator');
    expect(badge).toHaveTextContent('Initial 1/1');
    expect(badge.textContent).not.toMatch(/Retrying/i);
  });

  it('renders "{stage} failed" for status=failed', () => {
    render(<RetryIndicator stage="validate" attempt={1} maxAttempts={3} status="failed" />);
    const badge = screen.getByTestId('retry-indicator');
    expect(badge).toHaveTextContent('Validate failed (1/3)');
    expect(badge).toHaveAttribute('data-status', 'failed');
  });

  it('renders "Committed n/m" for status=committed', () => {
    render(<RetryIndicator stage="schema" attempt={2} maxAttempts={4} status="committed" />);
    const badge = screen.getByTestId('retry-indicator');
    expect(badge).toHaveTextContent('Committed 2/4');
    expect(badge).toHaveAttribute('data-status', 'committed');
  });

  it.each([
    ['schema', 'Schema'],
    ['validate', 'Validate'],
    ['guardrail', 'Guardrail'],
    ['initial', 'Initial'],
  ] as const)('formats stage "%s" → "%s"', (stage, label) => {
    render(<RetryIndicator stage={stage} attempt={1} maxAttempts={1} status="failed" />);
    expect(screen.getByTestId('retry-indicator')).toHaveTextContent(label);
  });
});
