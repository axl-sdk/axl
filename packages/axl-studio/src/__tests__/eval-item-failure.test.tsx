// @vitest-environment jsdom
/**
 * Item failure cause in the Eval Runner's item detail (adaptive-rate-governance
 * AC9, matrix E-09a).
 *
 * `@axlsdk/eval` records `item.failure` on a failed item: the first
 * `ProviderError`'s provider, status, retryable flag and request id, or only
 * the thrown `name`. Item detail must show it so a rate-limited item reads
 * differently from a bug, and must still render items that carry no cause
 * (pre-0.24 artifacts, successes) exactly as before.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EvalItemDetail } from '../client/panels/eval-runner/EvalItemDetail';
import type { EvalItem } from '../client/panels/eval-runner/types';

const noop = () => {};

const failedItem = (failure?: EvalItem['failure']): EvalItem => ({
  input: { q: 'q' },
  output: null,
  error: 'Rate limit reached',
  outcome: 'failed',
  scores: {},
  ...(failure ? { failure } : {}),
});

function renderItem(item: EvalItem) {
  return render(<EvalItemDetail item={item} itemIndex={0} scorerNames={[]} onBack={noop} />);
}

describe('EvalItemDetail — failure cause', () => {
  it('shows provider, status, retryable and request id for a provider failure', () => {
    renderItem(
      failedItem({
        name: 'ProviderError',
        provider: 'anthropic',
        status: 429,
        retryable: true,
        requestId: 'req_9',
      }),
    );

    const cause = screen.getByTestId('item-failure-cause');
    expect(cause.textContent).toContain('ProviderError');
    expect(cause.textContent).toContain('anthropic');
    expect(cause.textContent).toContain('HTTP 429');
    expect(cause.textContent).toContain('retryable');
    expect(cause.textContent).not.toContain('not retryable');
    expect(cause.textContent).toContain('req_9');
    expect(cause.textContent).not.toContain('[object Object]');
    // The message still renders beside the cause.
    expect(screen.getByText('Rate limit reached')).toBeTruthy();
  });

  it('labels status 0 as a network failure and says when it is not retryable', () => {
    renderItem(
      failedItem({ name: 'ProviderError', provider: 'openai', status: 0, retryable: false }),
    );
    const cause = screen.getByTestId('item-failure-cause');
    expect(cause.textContent).toContain('network');
    expect(cause.textContent).not.toContain('HTTP 0');
    expect(cause.textContent).toContain('not retryable');
    expect(cause.textContent).not.toContain('request');
  });

  it('shows only the name for a non-provider failure', () => {
    renderItem(failedItem({ name: 'TypeError' }));
    const cause = screen.getByTestId('item-failure-cause');
    expect(cause.textContent).toBe('Cause: TypeError');
  });

  it('renders a pre-0.24 item with only an error string, and no cause block', () => {
    const legacy: EvalItem = { input: { q: 'q' }, output: null, error: 'boom', scores: {} };
    renderItem(legacy);
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.queryByTestId('item-failure-cause')).toBeNull();
  });

  it('renders no cause block for a completed item', () => {
    renderItem({ input: { q: 'q' }, output: 'ok', outcome: 'completed', scores: {} });
    expect(screen.queryByTestId('item-failure-cause')).toBeNull();
  });
});
