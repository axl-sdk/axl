// @vitest-environment jsdom
/**
 * Regression coverage for TraceEventList — the shared component rendered by
 * both the Workflow Runner and Trace Explorer panels. A prior refactor
 * replaced this component with inline rendering and silently dropped:
 *
 *   - the Expand/Collapse toolbar
 *   - retry pill + amber tint on retry agent_calls and failed gates
 *   - attempt counters ("2/3") on guardrail events
 *   - CostBadge + DurationBadge on rows
 *   - the `#{step ?? index}` guard (showed "#undefined" otherwise)
 *
 * The structural tripwire in panel-trace-list-tripwire.test.ts catches
 * *removal* of the component. These tests catch *semantic* regressions
 * inside the component itself.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TraceEventList } from '../client/components/shared/TraceEventList';
import type { AxlEvent } from '../client/lib/types';

/**
 * Test-fixture builder. The strict `AxlEvent` discriminated union requires
 * per-variant fields (e.g., `askId`/`depth` on AskScoped variants,
 * `outcome`/`cost`/`duration` on `ask_end`); building these from an
 * unbound `Partial<AxlEvent>` would force every test to spell out the
 * full shape. Instead, we construct a generic envelope and cast at the
 * boundary — the tests don't exercise field-presence invariants on the
 * fixture itself, only render output.
 */
function makeEvent(overrides: Record<string, unknown>): AxlEvent {
  return {
    executionId: 'exec-1',
    step: 0,
    type: 'agent_call_end',
    timestamp: Date.now(),
    askId: 'ask-1',
    depth: 0,
    agent: 'tester',
    model: 'mock:test',
    cost: 0,
    duration: 0,
    data: { response: '', turn: 1 },
    ...overrides,
  } as unknown as AxlEvent;
}

describe('TraceEventList', () => {
  it('renders the event count and Expand/Collapse toolbar by default', () => {
    render(<TraceEventList events={[makeEvent({ step: 0 }), makeEvent({ step: 1 })]} />);
    expect(screen.getByText('2 events')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /collapse/i })).toBeInTheDocument();
  });

  it('hides the toolbar when showToolbar is false', () => {
    render(<TraceEventList events={[makeEvent({ step: 0 })]} showToolbar={false} />);
    expect(screen.queryByText('1 event')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /expand/i })).not.toBeInTheDocument();
  });

  it('renders #0 (not #undefined) when event.step is 0', () => {
    // Guards against a regression where the step-number check turns into a
    // truthy/falsy test (`event.step || index`) that treats `0` as missing,
    // or where the prefix is dropped entirely so we display `#undefined`.
    render(<TraceEventList events={[makeEvent({ step: 0, type: 'agent_call_end' })]} />);
    expect(screen.getByText('#0')).toBeInTheDocument();
    expect(screen.queryByText('#undefined')).not.toBeInTheDocument();
  });

  it('shows the retry pill on agent_call events with a retryReason', () => {
    const event = makeEvent({
      type: 'agent_call_end',
      data: { retryReason: 'schema', prompt: 'hi' },
    });
    render(<TraceEventList events={[event]} />);
    expect(screen.getByText('retry')).toBeInTheDocument();
  });

  it('shows attempt counter "N/M" on guardrail events', () => {
    const event = makeEvent({
      type: 'guardrail',
      // GuardrailData's failure signal is `blocked: true` (not `valid: false`,
      // which lives on SchemaCheckData/ValidateData). The attempt counter is
      // rendered regardless of pass/fail.
      data: { attempt: 2, maxAttempts: 3, blocked: true, guardrailType: 'output' },
    });
    render(<TraceEventList events={[event]} />);
    expect(screen.getByText('2/3')).toBeInTheDocument();
  });

  it('renders CostBadge and DurationBadge on rows that have them', () => {
    const event = makeEvent({
      type: 'agent_call_end',
      duration: 1500,
      cost: 0.00042,
    });
    render(<TraceEventList events={[event]} />);
    // DurationBadge formats 1500ms as "1.5s"; CostBadge formats sub-cent
    // costs to 6 decimals — both appear on the row.
    expect(screen.getByText('1.5s')).toBeInTheDocument();
    expect(screen.getByText('$0.000420')).toBeInTheDocument();
  });

  it('expand-all opens every row simultaneously', async () => {
    // Prompt now lives on agent_call_start (request side), not _end.
    const events = [
      makeEvent({ step: 0, type: 'agent_call_start', data: { prompt: 'first prompt', turn: 1 } }),
      makeEvent({ step: 1, type: 'agent_call_start', data: { prompt: 'second prompt', turn: 1 } }),
    ];
    render(<TraceEventList events={events} />);
    const user = userEvent.setup();

    // Collapsed by default — the body content isn't in the DOM.
    expect(screen.queryByText(/first prompt/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /expand/i }));

    // Both bodies now rendered. Prompt TextBlocks open by default, so the
    // prompt text itself should be visible once the row is expanded.
    expect(screen.getByText('first prompt')).toBeInTheDocument();
    expect(screen.getByText('second prompt')).toBeInTheDocument();
  });

  it('toggles a single row independently via click', async () => {
    const event = makeEvent({
      step: 0,
      type: 'agent_call_start',
      data: { prompt: 'solo prompt', turn: 1 },
    });
    render(<TraceEventList events={[event]} />);
    const user = userEvent.setup();

    const row = screen.getByText('#0').closest('button');
    expect(row).not.toBeNull();

    expect(screen.queryByText('solo prompt')).not.toBeInTheDocument();
    await user.click(row!);
    expect(screen.getByText('solo prompt')).toBeInTheDocument();
    await user.click(row!);
    expect(screen.queryByText('solo prompt')).not.toBeInTheDocument();
  });

  it('renders nothing but an empty list when events is empty', () => {
    const { container } = render(<TraceEventList events={[]} />);
    expect(screen.getByText('0 events')).toBeInTheDocument();
    // No toolbar (guarded by events.length > 0).
    expect(screen.queryByRole('button', { name: /expand/i })).not.toBeInTheDocument();
    // No rows.
    expect(within(container).queryByText(/^#\d/)).not.toBeInTheDocument();
  });
});
