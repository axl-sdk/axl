// @vitest-environment jsdom
/**
 * PartialObjectRenderer component tests:
 *   - renders latest partial_object for the given askId
 *   - resets on pipeline(status: 'failed') by default
 *   - `reset: 'never'` keeps the latest snapshot regardless
 *   - empty state when no partial_object events seen yet
 *   - monotonicity: later events override earlier ones
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PartialObjectRenderer } from '../client/components/shared/PartialObjectRenderer';
import type { AxlEvent } from '../client/lib/types';

let _step = 0;
function ev(partial: Record<string, unknown>): AxlEvent {
  return {
    executionId: 'e1',
    step: _step++,
    timestamp: _step,
    ...partial,
  } as AxlEvent;
}

describe('<PartialObjectRenderer />', () => {
  it('shows empty state when no partial_object events match', () => {
    render(<PartialObjectRenderer events={[]} askId="a1" />);
    expect(screen.getByText(/Waiting for partial object/i)).toBeInTheDocument();
  });

  it('renders the latest partial_object for the given askId', () => {
    const events: AxlEvent[] = [
      ev({
        type: 'partial_object',
        askId: 'a1',
        depth: 0,
        attempt: 1,
        data: { object: { name: 'Al' } },
      }),
      ev({
        type: 'partial_object',
        askId: 'a1',
        depth: 0,
        attempt: 1,
        data: { object: { name: 'Alice', age: 30 } },
      }),
    ];
    render(<PartialObjectRenderer events={events} askId="a1" />);
    expect(screen.getByTestId('partial-object-renderer')).toBeInTheDocument();
    // JsonViewer renders the object — text assertions on specific keys.
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
  });

  it('filters out partials from other asks when askId is set', () => {
    const events: AxlEvent[] = [
      ev({
        type: 'partial_object',
        askId: 'other',
        depth: 0,
        attempt: 1,
        data: { object: { other: 'xyz' } },
      }),
    ];
    render(<PartialObjectRenderer events={events} askId="a1" />);
    expect(screen.getByText(/Waiting for partial object/i)).toBeInTheDocument();
  });

  it('resets on pipeline(failed) when reset="on_pipeline_failed" (default)', () => {
    const events: AxlEvent[] = [
      ev({
        type: 'partial_object',
        askId: 'a1',
        depth: 0,
        attempt: 1,
        data: { object: { name: 'losing-attempt' } },
      }),
      ev({
        type: 'pipeline',
        askId: 'a1',
        depth: 0,
        status: 'failed',
        stage: 'schema',
        attempt: 1,
        maxAttempts: 4,
        reason: 'bad',
      }),
    ];
    render(<PartialObjectRenderer events={events} askId="a1" />);
    expect(screen.getByText(/Waiting for partial object/i)).toBeInTheDocument();
  });

  it('reset="never" keeps the snapshot even on pipeline(failed)', () => {
    const events: AxlEvent[] = [
      ev({
        type: 'partial_object',
        askId: 'a1',
        depth: 0,
        attempt: 1,
        data: { object: { name: 'persist' } },
      }),
      ev({
        type: 'pipeline',
        askId: 'a1',
        depth: 0,
        status: 'failed',
        stage: 'schema',
        attempt: 1,
        maxAttempts: 4,
        reason: 'bad',
      }),
    ];
    render(<PartialObjectRenderer events={events} askId="a1" reset="never" />);
    expect(screen.getByTestId('partial-object-renderer')).toBeInTheDocument();
  });

  it('picks up post-fail partial after a retry', () => {
    const events: AxlEvent[] = [
      ev({
        type: 'partial_object',
        askId: 'a1',
        depth: 0,
        attempt: 1,
        data: { object: { losing: true } },
      }),
      ev({
        type: 'pipeline',
        askId: 'a1',
        depth: 0,
        status: 'failed',
        stage: 'schema',
        attempt: 1,
        maxAttempts: 4,
        reason: 'bad',
      }),
      ev({
        type: 'partial_object',
        askId: 'a1',
        depth: 0,
        attempt: 2,
        data: { object: { winning: true } },
      }),
    ];
    render(<PartialObjectRenderer events={events} askId="a1" />);
    // JsonViewer splits keys and values into separate spans, so `winning`
    // may appear on multiple elements (preview + expanded). Just confirm
    // at least one match and none mention the losing attempt.
    expect(screen.getAllByText(/winning/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/losing/)).toBeNull();
  });

  it('without askId, tracks the most recent ask that produced a partial_object', () => {
    const events: AxlEvent[] = [
      ev({ type: 'partial_object', askId: 'a1', depth: 0, attempt: 1, data: { object: { x: 1 } } }),
      ev({ type: 'partial_object', askId: 'a2', depth: 0, attempt: 1, data: { object: { y: 2 } } }),
    ];
    render(<PartialObjectRenderer events={events} />);
    expect(screen.getByText(/"y"/)).toBeInTheDocument();
  });
});
