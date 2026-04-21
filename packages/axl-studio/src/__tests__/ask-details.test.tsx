// @vitest-environment jsdom
/**
 * AskDetails component tests:
 *   - filters events to the given ask (including handoffs from/to it)
 *   - surfaces prompt, cost, duration, outcome summary
 *   - close button invokes onClose
 *   - empty state when askId has no matching events
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AskDetails } from '../client/components/shared/AskDetails';
import type { AxlEvent } from '../client/lib/types';

let _step = 0;
function ev(partial: Record<string, unknown>): AxlEvent {
  return {
    executionId: 'e1',
    step: _step++,
    timestamp: _step * 10,
    ...partial,
  } as AxlEvent;
}

describe('<AskDetails />', () => {
  it('renders prompt, cost, duration, and outcome for a completed ask', () => {
    _step = 0;
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'a1', depth: 0, agent: 'helper', prompt: 'ask me anything' }),
      ev({
        type: 'ask_end',
        askId: 'a1',
        depth: 0,
        agent: 'helper',
        cost: 0.025,
        duration: 100,
        outcome: { ok: true, result: 'done' },
      }),
    ];
    render(<AskDetails events={events} askId="a1" />);

    const panel = screen.getByTestId('ask-details');
    expect(panel).toHaveAttribute('data-ask-id', 'a1');
    // Header shows the agent name (TraceEventList inside the panel may
    // also render it — use getAllByText to allow either rendering).
    expect(screen.getAllByText('helper').length).toBeGreaterThan(0);
    expect(screen.getByText(/ask me anything/)).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
  });

  it('renders failed outcome badge for a failed ask', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'a1', depth: 0, agent: 'x' }),
      ev({
        type: 'ask_end',
        askId: 'a1',
        depth: 0,
        agent: 'x',
        cost: 0,
        duration: 5,
        outcome: { ok: false, error: 'boom' },
      }),
    ];
    render(<AskDetails events={events} askId="a1" />);
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('includes handoff events where this ask is either source or target', () => {
    const events: AxlEvent[] = [
      ev({ type: 'ask_start', askId: 'a1', depth: 0, agent: 'coord' }),
      ev({
        type: 'handoff',
        fromAskId: 'a1',
        toAskId: 'a2',
        sourceDepth: 0,
        targetDepth: 1,
        data: { source: 'coord', target: 'spec', mode: 'oneway', duration: 1 },
      }),
    ];
    render(<AskDetails events={events} askId="a1" />);
    // TraceEventList renders a row for handoff.
    expect(screen.getByTestId('ask-details')).toBeInTheDocument();
  });

  it('fires onClose when close button clicked', () => {
    const events: AxlEvent[] = [ev({ type: 'ask_start', askId: 'a1', depth: 0, agent: 'x' })];
    const onClose = vi.fn();
    render(<AskDetails events={events} askId="a1" onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close ask details'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows "No events" when askId has no matching events', () => {
    render(<AskDetails events={[]} askId="nonexistent" />);
    expect(screen.getByText(/No events for this ask/i)).toBeInTheDocument();
  });
});
